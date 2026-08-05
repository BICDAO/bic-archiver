/**
 * The one-click mirror.
 *
 * A member clicks one button and another copy of BIC's archive exists in the
 * world. That sentence is the whole design brief, and the two hard parts of it
 * are hidden inside "another copy" and "in the world".
 *
 * **Another copy.** The archive is ~1.8 GB across ~19,000 blocks. Downloading
 * that as a single request would hold the whole thing in memory and blow through
 * every sensible timeout, so the archive is split into *units* — the top-level
 * folders, or smaller pieces if a folder is unusually large — and each unit is
 * fetched, verified and stored on its own. That is also what makes progress
 * reporting possible: 1.8 GB of silence is indistinguishable from a hung app.
 *
 * **In the world.** Saving bytes to a disk is not the same thing as serving them
 * to other people, and conflating the two is exactly how the DAO lost 428 CIDs
 * in the first place — they were "backed up" on a laptop that announced them to
 * nobody. So {@link MirrorResult.nowServing} is set only when the content is
 * genuinely retrievable by someone else: a local IPFS node that has it pinned,
 * or a Pinata account we have *verified* is holding it. A queued Pinata job is
 * not a mirror. A `.car` on a desktop is not a mirror. Both are still worth
 * having, and both are reported honestly for what they are.
 *
 * The order of preference is not arbitrary:
 *
 *   1. **A local IPFS node.** The only outcome that turns the member into a real
 *      provider — the thing that actually fixes the measured problem. Preferred
 *      route is to let the node fetch the content itself, because a node that
 *      fetched it is a node that has it; only if the node cannot reach the
 *      content do we download the blocks here and hand them over as a `.car`.
 *   2. **Pinata.** A hosted copy that survives the laptop closing. Works without
 *      a node *only* if somebody else is already providing the content, because
 *      pin-by-CID asks Pinata to go and find it. When nobody is providing it and
 *      there is no node to fetch from, we say so instead of queueing a job that
 *      will sit in "searching" until it expires.
 *   3. **A cold copy.** A verifiable `.car` on the member's disk. Nothing is
 *      served, and the summary says so in one plain sentence rather than letting
 *      a green tick imply something untrue.
 *
 * Every network call here has a deadline, every failure has a sentence a
 * non-technical member can act on, and cancellation is honoured throughout: an
 * aborted run throws an `Error` with `name === 'AbortError'` and leaves the
 * partly-downloaded work behind so the next attempt resumes instead of starting
 * the 1.8 GB again.
 */

import { resolveTxt } from 'node:dns/promises'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { clearInterval as clearTicker, setInterval as setTicker } from 'node:timers'

import * as dagPb from '@ipld/dag-pb'
import { MemoryBlockstore } from 'blockstore-core'
import { CID } from 'multiformats/cid'

import {
  BIC_ARCHIVE,
  type MirrorCapability,
  type MirrorProgress,
  type MirrorResult
} from '../../shared/community.js'
import { TRUSTLESS_GATEWAYS } from '../../shared/constants.js'
import type { PinningSettings, PinTargetStatus } from '../../shared/pinning.js'

import { checkProviders } from '../health/check.js'
import {
  closeBlockstore,
  getBlockBytes,
  hasBlock,
  openBlockstore,
  putBlock,
  type Blockstore
} from '../ipfs/blockstore.js'
import { exportCar } from '../ipfs/car.js'
import { listDirectory } from '../ipfs/dag.js'
import { fetchCar, fetchDag } from '../ipfs/trustlessFetch.js'
import { detectKubo, importCarToKubo, isPinned, pinCid } from '../pinning/kubo.js'
import { redact } from '../pinning/manager.js'
import {
  listPinnedCids,
  pinByCid,
  pinJobResult,
  pinJobStatus,
  testPinataAuth
} from '../pinning/pinata.js'

/* -------------------------------------------------------------------------- */
/* public types                                                                */
/* -------------------------------------------------------------------------- */

/** Where the archive is right now, and how we worked that out. */
export interface ArchiveRoot {
  /** The root CID of the archive, as a string. */
  cid: string
  /**
   * `pointer` — resolved from {@link BIC_ARCHIVE.pointer}, so it is current.
   * `constant` — the CID baked into this build, either because no pointer is
   * published yet or because the pointer could not be looked up.
   */
  via: 'pointer' | 'constant'
}

/** Everything {@link mirrorArchive} needs. */
export interface MirrorOptions {
  /** Which targets are configured, and where the member's node lives. */
  settings: PinningSettings
  /**
   * The Pinata token, read from the OS keychain by the main process. `null` when
   * none is stored, which simply means the Pinata route is unavailable. The
   * token is never logged and never appears in any string this module returns.
   */
  token: string | null
  /**
   * Folder for the `.car` backup, and for the scratch space a download needs.
   * Must be somewhere with room for the archive twice over if there is no node.
   */
  destDir: string
  /** Streamed to the GUI. A throwing listener can never abort the run. */
  onProgress: (p: MirrorProgress) => void
  signal?: AbortSignal
}

/** What {@link checkMirrorStatus} found. */
export interface MirrorStatus {
  /**
   * The archive address this verdict is about.
   *
   * Carried out so the GUI can act on the same root the check used rather than
   * the constant compiled into the app, which goes stale the moment BIC
   * publishes an update. Empty only when no usable address was given.
   */
  rootCid: string
  /** The member's own IPFS node is keeping the archive. */
  pinnedLocally: boolean
  /** Pinata's own pin list contains the archive — verified, not assumed. */
  pinnedOnPinata: boolean
  /** How many peers are announcing the archive to the network right now. */
  providers: number
}

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

const USER_AGENT = 'bic-archiver/0.1 (+community mirror)'

/** Scratch folder inside `destDir`. Hidden, and removed on a clean finish. */
const WORK_DIR_NAME = '.bic-mirror-work'

/**
 * Biggest sub-DAG we will pull in one request.
 *
 * A trustless fetch buffers the response before verifying it, so this is
 * effectively the memory ceiling of a download. 96 MiB comfortably holds a
 * whole NFT folder while keeping the app's footprint ordinary.
 */
const MAX_UNIT_BYTES = 96 * 1024 * 1024

/** Depth and count limits on splitting, so a hostile DAG cannot spin us. */
const MAX_PLAN_DEPTH = 6
const MAX_UNITS = 4096

/** A directory node, even a HAMT-sharded one, is small. */
const MAX_ENTITY_BYTES = 64 * 1024 * 1024
const ENTITY_TIMEOUT_MS = 60_000

/** Budget for one unit: a floor, plus an allowance for a slow home line. */
const UNIT_BASE_TIMEOUT_MS = 120_000
const UNIT_BYTES_PER_SECOND = 150 * 1024
const UNIT_MAX_TIMEOUT_MS = 20 * 60_000

/** How often to say something while a single long step is running. */
const HEARTBEAT_MS = 10_000

/** Only report CAR export progress this often, so the GUI is not flooded. */
const EXPORT_PROGRESS_INTERVAL_MS = 750

/**
 * Consecutive node failures, with no successes at all, before we stop asking the
 * node to fetch things and download them here instead.
 *
 * Each failure costs a couple of minutes of the node searching the network. With
 * a few hundred units, grinding through every one of them would take hours to
 * reach a conclusion we can draw from the first three.
 */
const NODE_FAILURE_STREAK = 3

/** How long to keep checking a queued Pinata job before reporting it unfinished. */
const PINATA_WAIT_MS = 10 * 60_000
const PINATA_POLL_MS = 15_000

/** Budget for one pointer lookup at one place — a DNS provider or a gateway. */
const POINTER_TIMEOUT_MS = 15_000

/** Budget for the operating system's own resolver, which offers none itself. */
const DNS_TIMEOUT_MS = 8_000

/**
 * Public DNS-over-HTTPS, asked only when the machine's own resolver comes back
 * with nothing. Two providers, because a member whose network mangles one still
 * deserves the current archive rather than a stale snapshot.
 */
const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve'
] as const

/** How many `dnslink=/ipns/…` redirections to follow before giving up. */
const MAX_DNSLINK_HOPS = 1

/** Longest pin label a node will accept without complaint. */
const MAX_PIN_NAME_CHARS = 200

/** Ceiling on the local completeness walk; the whole archive is ~19,000 blocks. */
const MAX_WALK_BLOCKS = 200_000

/* -------------------------------------------------------------------------- */
/* resolving the archive root                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where the BIC archive lives right now.
 *
 * A UnixFS directory CID changes the moment its contents change, so the CID
 * compiled into this build is correct only until the next NFT is added. The
 * durable answer is the pointer the DAO republishes — today a DNSLink record on
 * `bureauofinternetculture.art` — and resolving it here is what stops the mirror
 * button going stale between releases.
 *
 * Two things had to be measured rather than assumed:
 *
 *   - **Asking a gateway is not an option.** `/ipns/<name>` on a trustless
 *     gateway is refused outright (that spec covers retrieval by CID, not name
 *     resolution), and the ordinary path gateways redirect there for a raw or
 *     CAR request. A plain request for the name renders a directory listing of
 *     20,808 entries and times out. So the name is resolved as what it actually
 *     is: a DNS TXT record.
 *   - **The system resolver cannot be trusted alone.** On the machine this was
 *     written on, `_dnslink.bureauofinternetculture.art` comes back NXDOMAIN
 *     from the local resolver while public DNS serves it perfectly — home
 *     routers and corporate resolvers mangle underscore-prefixed records often
 *     enough that a single source would strand those members on a stale CID.
 *     So the OS is asked first, and public DNS-over-HTTPS is the second opinion.
 *
 * A pointer that is already an address (`/ipfs/<cid>`) needs no lookup, and a
 * pointer that is a libp2p key rather than a domain falls back to asking a
 * gateway, which is the only thing that can resolve those.
 *
 * Whatever comes back is only a *name* for content that is still hash-verified
 * block by block when it is fetched, so a bad answer here cannot smuggle in
 * different bytes — it can only send us looking for something that does not
 * exist, which fails loudly.
 *
 * Never throws for a lookup failure: when there is no pointer, or nothing can
 * resolve it, the built-in CID comes back with `via: 'constant'`. Throws an
 * `Error` with `name === 'AbortError'` only if `signal` is aborted.
 */
export async function resolveArchiveRoot(signal?: AbortSignal): Promise<ArchiveRoot> {
  throwIfCancelled(signal)

  const constant: ArchiveRoot = { cid: BIC_ARCHIVE.rootCid, via: 'constant' }
  const pointer = (BIC_ARCHIVE.pointer ?? '').trim()
  if (pointer === '') return constant

  // A pointer that is already an address needs no lookup at all.
  const direct = parseCid(stripPrefix(pointer, ['/ipfs/', 'ipfs://']))
  if (direct !== undefined) {
    return { cid: direct.toString(), via: 'pointer' }
  }

  const name = stripPrefix(pointer, ['/ipns/', 'ipns://']).replace(/\/+$/, '')
  if (name === '') return constant

  const resolved = isDomainName(name)
    ? await resolveDnsLink(name, signal, 0)
    : await resolveIpnsKeyViaGateway(name, signal)

  return resolved === undefined ? constant : { cid: resolved, via: 'pointer' }
}

/**
 * Resolve a DNSLink domain to the CID it publishes.
 *
 * Looks for `dnslink=/ipfs/<cid>` on `_dnslink.<domain>` and then on the domain
 * itself, asking the operating system first and public DNS-over-HTTPS second.
 * A record that points at another name is followed once, which is legal DNSLink
 * and cheap to support; beyond that we stop rather than chase a loop.
 */
async function resolveDnsLink(
  name: string,
  signal: AbortSignal | undefined,
  depth: number
): Promise<string | undefined> {
  if (depth > MAX_DNSLINK_HOPS) return undefined

  for (const host of [`_dnslink.${name}`, name]) {
    throwIfCancelled(signal)

    for (const record of await txtRecords(host, signal)) {
      const target = dnsLinkTarget(record)
      if (target === undefined) continue

      const cid = parseCid(stripPrefix(target, ['/ipfs/']))
      if (cid !== undefined) return cid.toString()

      const next = stripPrefix(target, ['/ipns/']).replace(/\/+$/, '')
      if (next !== '' && next !== name && isDomainName(next)) {
        const chased = await resolveDnsLink(next, signal, depth + 1)
        if (chased !== undefined) return chased
      }
    }
  }

  return undefined
}

/** Every TXT record for `host`, from the OS first and public DNS after. */
async function txtRecords(host: string, signal: AbortSignal | undefined): Promise<string[]> {
  const fromSystem = await systemTxt(host, signal)
  if (fromSystem.length > 0) return fromSystem
  return await dohTxt(host, signal)
}

/** The operating system's own resolver, with a deadline it does not offer. */
async function systemTxt(host: string, signal: AbortSignal | undefined): Promise<string[]> {
  try {
    const answer = await Promise.race([
      resolveTxt(host),
      sleep(DNS_TIMEOUT_MS, signal).then((): string[][] => [])
    ])
    // Long TXT values arrive split into chunks that have to be rejoined.
    return answer.map((chunks) => chunks.join(''))
  } catch (err) {
    if (isCancellation(err)) throw err
    // NXDOMAIN, SERVFAIL, no resolver: all just mean "ask somebody else".
    return []
  }
}

/**
 * Public DNS-over-HTTPS, used only when the OS resolver came back empty.
 *
 * Two independent providers, because this is the difference between a member
 * mirroring the current archive and a member mirroring last month's. Only a
 * public domain name is ever sent, and never anything about the member.
 */
async function dohTxt(host: string, signal: AbortSignal | undefined): Promise<string[]> {
  for (const endpoint of DOH_ENDPOINTS) {
    throwIfCancelled(signal)

    const url = `${endpoint}?name=${encodeURIComponent(host)}&type=TXT`
    const deadline = createDeadline(POINTER_TIMEOUT_MS, signal)

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: 'application/dns-json', 'user-agent': USER_AGENT },
        signal: deadline.signal
      })

      if (!response.ok) {
        await discardBody(response)
        continue
      }

      const body: unknown = await response.json()
      const answers = (body as { Answer?: unknown })?.Answer
      if (!Array.isArray(answers)) continue

      const records: string[] = []
      for (const answer of answers) {
        const data = (answer as { data?: unknown })?.data
        if (typeof data !== 'string') continue
        // Providers differ over whether the value keeps its quotes.
        records.push(data.replace(/^"|"$/g, '').replace(/"\s*"/g, ''))
      }
      if (records.length > 0) return records
    } catch {
      if (signal?.aborted === true) throw abortError()
      // A DNS provider that will not answer is a normal event; try the other.
    } finally {
      deadline.release()
    }
  }

  return []
}

/** `dnslink=/ipfs/…` out of one TXT record, or `undefined` if it is something else. */
function dnsLinkTarget(record: string): string | undefined {
  const match = /^\s*dnslink\s*=\s*(\/\S+)\s*$/i.exec(record)
  return match?.[1]
}

/**
 * A libp2p key (`k51…`, `12D3…`) can only be resolved by something that speaks
 * IPNS, so the gateways get one attempt each. The resolved root comes back in
 * the headers rather than the body.
 */
async function resolveIpnsKeyViaGateway(
  name: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  for (const gateway of TRUSTLESS_GATEWAYS) {
    throwIfCancelled(signal)

    const url = `${trimSlash(gateway)}/ipns/${encodeURIComponent(name)}?format=raw`
    const deadline = createDeadline(POINTER_TIMEOUT_MS, signal)

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          accept: 'application/vnd.ipld.raw',
          // One byte is enough: the answer we want is in the headers.
          range: 'bytes=0-0',
          'user-agent': USER_AGENT
        },
        signal: deadline.signal
      })

      const cid = response.ok || response.status === 206 ? cidFromHeaders(response) : undefined
      await discardBody(response)
      if (cid !== undefined) return cid
    } catch {
      // A gateway that will not answer is a normal event; try the next one.
      // Only the member's own cancellation stops the search.
      if (signal?.aborted === true) throw abortError()
    } finally {
      deadline.release()
    }
  }

  return undefined
}

/**
 * Is this a domain to look up in DNS, rather than a libp2p key?
 *
 * Keys are a single label of base32/base58 with no dots, so a dot is the
 * distinguishing feature. Anything that could be a hostname is treated as one.
 */
function isDomainName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(name)
}

/**
 * Pull the resolved root out of a gateway reply.
 *
 * `X-Ipfs-Roots` lists the CIDs walked to satisfy the request, so its last entry
 * is what the name resolved to. `Etag` carries the same answer on gateways that
 * do not send the roots header.
 */
function cidFromHeaders(response: Response): string | undefined {
  const roots = response.headers.get('x-ipfs-roots')
  if (roots !== null) {
    const parts = roots.split(',')
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const parsed = parseCid((parts[index] ?? '').trim())
      if (parsed !== undefined) return parsed.toString()
    }
  }

  const etag = response.headers.get('etag')
  if (etag !== null) {
    const cleaned = etag
      .replace(/^W\//i, '')
      .replace(/"/g, '')
      .replace(/\.(raw|car)$/i, '')
      .trim()
    const parsed = parseCid(cleaned)
    if (parsed !== undefined) return parsed.toString()
  }

  return undefined
}

/* -------------------------------------------------------------------------- */
/* capabilities                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What this machine can actually do for the archive, right now.
 *
 * Deliberately a question about the *machine*, not about the member's routine
 * pinning preferences: the mirror button is an explicit, one-off request, so a
 * reachable node counts as a node even if automatic pinning is switched off in
 * Settings. `cold-copy` is always present — there is always a disk.
 *
 * Never throws for an unreachable node or a rejected token; both simply do not
 * appear in the list. Throws an `Error` with `name === 'AbortError'` only if
 * `signal` is aborted.
 */
export async function detectCapabilities(
  settings: PinningSettings,
  token: string | null,
  signal?: AbortSignal
): Promise<MirrorCapability[]> {
  throwIfCancelled(signal)

  const [node, pinata] = await Promise.all([
    probeNode(settings, signal),
    probePinata(token, signal)
  ])

  const capabilities: MirrorCapability[] = []
  if (node.available) capabilities.push('node')
  if (pinata.available) capabilities.push('pinata')
  capabilities.push('cold-copy')
  return capabilities
}

/** Is there a usable IPFS node? Never throws except on cancellation. */
async function probeNode(
  settings: PinningSettings,
  signal: AbortSignal | undefined
): Promise<PinTargetStatus> {
  return await probeNodeAt(settings.kubo.apiUrl, signal)
}

async function probeNodeAt(
  apiUrl: string,
  signal: AbortSignal | undefined
): Promise<PinTargetStatus> {
  try {
    return await detectKubo(apiUrl, signal)
  } catch (err) {
    if (isCancellation(err)) throw err
    return { target: 'kubo', available: false, detail: plainText(err) }
  }
}

/** Does this token authenticate? Never throws except on cancellation. */
async function probePinata(
  token: string | null,
  signal: AbortSignal | undefined
): Promise<PinTargetStatus> {
  const auth = (token ?? '').trim()
  if (auth === '') {
    return {
      target: 'pinata',
      available: false,
      detail:
        'No Pinata key is saved on this computer, so a cloud copy is not available. ' +
        'You can add one in Settings later.'
    }
  }

  try {
    return await testPinataAuth(auth, signal)
  } catch (err) {
    if (isCancellation(err)) throw err
    return { target: 'pinata', available: false, detail: plainText(err, token) }
  }
}

/* -------------------------------------------------------------------------- */
/* status                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Is this machine already mirroring the archive?
 *
 * Lets the GUI say "you are already mirroring this" instead of offering a button
 * that would repeat 1.8 GB of work. Each of the three questions is asked
 * independently and a failure to ask answers `false` / `0` rather than throwing,
 * because a status panel must always be able to draw itself.
 *
 * `providers` is the count of peers announcing the archive to the network. It is
 * the number that matters most to the DAO: while it stays at zero, the archive
 * exists only in backups.
 *
 * Throws an `Error` with `name === 'AbortError'` only if `signal` is aborted.
 */
export async function checkMirrorStatus(
  rootCid: string,
  settings: PinningSettings,
  token: string | null,
  signal?: AbortSignal
): Promise<MirrorStatus> {
  throwIfCancelled(signal)

  const wanted = rootCid.trim()
  if (wanted === '') {
    return { rootCid: '', pinnedLocally: false, pinnedOnPinata: false, providers: 0 }
  }

  const locally = async (): Promise<boolean> => {
    try {
      return (await isPinned(settings.kubo.apiUrl, wanted, signal)) === 'pinned'
    } catch (err) {
      if (isCancellation(err)) throw err
      return false
    }
  }

  const onPinata = async (): Promise<boolean> => {
    const confirmed = await pinataHasCid(token, wanted, signal)
    return confirmed === true
  }

  const [pinnedLocally, pinnedOnPinata, providers] = await Promise.all([
    locally(),
    onPinata(),
    checkProviders(wanted, signal)
  ])

  return { rootCid: wanted, pinnedLocally, pinnedOnPinata, providers }
}

/**
 * Does Pinata's own pin list contain this CID?
 *
 * `true` / `false` are answers; `null` means we could not ask (no token, network
 * down, list refused). The distinction matters — reporting "not pinned" when we
 * simply could not check would send a member off to redo work that is already
 * done, and reporting "pinned" would be a lie.
 */
async function pinataHasCid(
  token: string | null,
  cid: string,
  signal: AbortSignal | undefined
): Promise<boolean | null> {
  const auth = (token ?? '').trim()
  if (auth === '') return null

  try {
    const pinned = await listPinnedCids(auth, signal === undefined ? {} : { signal })
    return cidSpellings(cid).some((form) => pinned.has(form))
  } catch (err) {
    if (isCancellation(err)) throw err
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* the mirror run                                                              */
/* -------------------------------------------------------------------------- */

/** One unit of work: a sub-DAG small enough to fetch or pin in one go. */
interface MirrorUnit {
  cid: CID
  /** Path inside the archive, for messages. Empty for the archive as a whole. */
  label: string
  /** Cumulative size from the parent link, or 0 when the DAG does not say. */
  bytes: number
}

/** The archive broken into units, plus what they add up to. */
interface MirrorPlan {
  units: MirrorUnit[]
  totalBytes: number
  /** True when the archive could not be split and is one all-or-nothing unit. */
  single: boolean
}

/** Mutable state shared by the steps of one run. */
interface Run {
  readonly rootCid: CID
  readonly root: string
  readonly destDir: string
  readonly workDir: string
  readonly emit: Emit
  readonly signal: AbortSignal | undefined
  readonly errors: string[]
  /** Bytes accounted for so far, for progress. */
  done: number
  /** Bytes we expect to move in total, or 0 when unknown. */
  total: number
  /** Scratch blockstore, opened only when something has to be downloaded. */
  store?: Blockstore
  /** False when `destDir` cannot be written to, so no download is possible. */
  diskUsable: boolean
  plan?: MirrorPlan
  /** The one download this run performs, however many routes ask for it. */
  download?: DownloadOutcome
  /** Keep the scratch folder, so an interrupted download can resume. */
  keepWork: boolean
}

/**
 * Put another copy of the archive into the world, doing as much as this machine
 * allows.
 *
 * Runs every route that is available, best first, and reports exactly what was
 * achieved. A node that ends up pinning the archive, or a Pinata account we have
 * confirmed is holding it, sets `nowServing`. Anything less does not, however
 * much work was done — a 1.8 GB file on a disk nobody can reach is a backup, not
 * a mirror, and the summary says so in plain words.
 *
 * Progress is emitted throughout with byte counts. Cancellation is honoured at
 * every step and leaves partly-downloaded content in place so a retry resumes.
 *
 * Never throws for a failure of any single route; the outcome is the returned
 * {@link MirrorResult}. Throws an `Error` with `name === 'AbortError'` if
 * `opts.signal` is aborted.
 */
export async function mirrorArchive(opts: MirrorOptions): Promise<MirrorResult> {
  const emit = makeEmitter(opts.onProgress)
  const signal = opts.signal
  const errors: string[] = []
  const used: MirrorCapability[] = []

  throwIfCancelled(signal)
  emit('checking', 'Checking what this computer can do for the archive…')

  const [node, pinata] = await Promise.all([
    probeNode(opts.settings, signal),
    probePinata(opts.token, signal)
  ])

  emit('resolving', 'Finding the current BIC archive…')
  const archive = await resolveArchiveRoot(signal)

  const rootCid = parseCid(archive.cid)
  if (rootCid === undefined) {
    // Only reachable if the constant itself is malformed, i.e. a broken build.
    const message =
      'This copy of the app does not have a valid address for the BIC archive, so there is ' +
      'nothing to mirror. Please update the app.'
    emit('error', message)
    return {
      ok: false,
      used: [],
      rootCid: archive.cid,
      blocks: 0,
      bytes: 0,
      nowServing: false,
      summary: message,
      errors: [message]
    }
  }

  if (archive.via === 'constant' && (BIC_ARCHIVE.pointer ?? '').trim() !== '') {
    errors.push(
      'The published address of the archive could not be looked up just now, so the copy built ' +
        'into this app was used instead. Anything added to the archive since this version was ' +
        'released will not be included.'
    )
  }

  const run: Run = {
    rootCid,
    root: rootCid.toString(),
    destDir: opts.destDir,
    workDir: join(opts.destDir, WORK_DIR_NAME),
    emit,
    signal,
    errors,
    done: 0,
    total: knownArchiveBytes(rootCid.toString()),
    diskUsable: true,
    keepWork: false
  }

  let nowServing = false
  let blocks = 0
  let bytes = 0
  let carPath: string | undefined
  let nodeAlreadyHadIt = false

  /**
   * A route that breaks in a way nobody anticipated must not take the other
   * routes down with it. Cancellation is the one exception: that is the member
   * asking us to stop, and everything stops.
   */
  const attempt = async <T>(route: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await route()
    } catch (err) {
      if (isCancellation(err)) throw err
      errors.push(plainText(err, opts.token))
      return undefined
    }
  }

  try {
    /* ---------------------------------------------------------------- node */
    if (node.available) {
      const outcome = await attempt(() => mirrorToNode(run, opts.settings.kubo.apiUrl))

      if (outcome !== undefined) {
        nodeAlreadyHadIt = outcome.alreadyHadIt

        // Best outcome first, so a GUI reading `used[0]` shows the one that
        // matters rather than the consolation prize.
        if (outcome.served) {
          nowServing = true
          used.push('node')
        }
        if (outcome.carPath !== undefined) {
          carPath = outcome.carPath
          used.push('cold-copy')
        }
        blocks = Math.max(blocks, outcome.blocks)
        bytes = Math.max(bytes, outcome.bytes)
        for (const problem of outcome.errors) errors.push(problem)
      }
    } else if (node.detail !== undefined) {
      errors.push(node.detail)
    }

    /* -------------------------------------------------------------- pinata */
    if (pinata.available) {
      const outcome = await attempt(() => mirrorToPinata(run, opts.token, node))

      if (outcome !== undefined) {
        if (outcome.served) {
          nowServing = true
          used.push('pinata')
          if (bytes === 0) bytes = knownArchiveBytes(run.root)
        }
        for (const problem of outcome.errors) errors.push(problem)
      }
    } else if (pinata.detail !== undefined && !node.available) {
      // Only worth mentioning when Pinata was a route we actually needed.
      errors.push(pinata.detail)
    }

    /* ----------------------------------------------------------- cold copy */
    if (!nowServing && carPath === undefined) {
      const outcome = await attempt(() => coldCopy(run))

      if (outcome !== undefined) {
        if (outcome.carPath !== undefined) {
          carPath = outcome.carPath
          used.push('cold-copy')
          blocks = Math.max(blocks, outcome.blocks)
          bytes = Math.max(bytes, outcome.bytes)
        }
        for (const problem of outcome.errors) errors.push(problem)
      }
    }
  } finally {
    await releaseWork(run)
  }

  const ok = nowServing || carPath !== undefined
  const summary = summarise({
    nowServing,
    carPath,
    bytes,
    used,
    nodeAlreadyHadIt,
    failed: !ok
  })

  emit(ok ? 'done' : 'error', summary, { bytesDone: run.done, bytesTotal: run.total })

  return {
    ok,
    used: dedupe(used),
    rootCid: run.root,
    blocks,
    bytes,
    nowServing,
    // Carried out so the GUI can offer to open what was just copied. Until this
    // was returned the renderer had no way to know a 1.8 GB backup was sitting
    // next to it, which is why a member who mirrored could not reach the gallery.
    ...(carPath === undefined ? {} : { carPath }),
    summary,
    errors: dedupe(errors)
  }
}

/* -------------------------------------------------------------------------- */
/* route 1 — the member's own IPFS node                                        */
/* -------------------------------------------------------------------------- */

interface NodeOutcome {
  /** The node has the archive pinned, verified after the fact. */
  served: boolean
  /** Nothing had to be done because the node already held it. */
  alreadyHadIt: boolean
  blocks: number
  bytes: number
  /** Set when a `.car` was written on the way, which the member keeps. */
  carPath?: string
  errors: string[]
}

/**
 * Get the archive onto the member's IPFS node.
 *
 * Preferred route by a distance: ask the node to fetch the content itself, one
 * unit at a time. A node that fetched the blocks is a node that has them, with
 * no intermediate copy on disk and no 1.8 GB round trip through this process.
 *
 * Unit-at-a-time matters for two reasons. `pin/add` on content the node does not
 * hold has a stall deadline, so one enormous pin either finishes or tells us
 * nothing for a very long time; and a member watching a progress bar deserves to
 * see it move. If the node turns out not to be able to reach the content at all,
 * we stop asking after a few failures and download the blocks here instead,
 * handing them over as a `.car` — which is the only route that can revive
 * content nobody else is providing.
 */
async function mirrorToNode(run: Run, apiUrl: string): Promise<NodeOutcome> {
  /**
   * Kept apart from the run's own problems on purpose. If the node cannot fetch
   * something itself we download it here and the member ends up with exactly
   * what they asked for, so parading the intermediate failures at them would be
   * alarming and pointless. They are reported only if the fallback fails too.
   */
  const attemptErrors: string[] = []

  run.emit('verifying', 'Checking whether your IPFS node already has the archive…')
  const existing = await isPinnedSafely(apiUrl, run.root, run.signal)
  if (existing === 'pinned') {
    const total = knownArchiveBytes(run.root)
    run.done = total
    run.total = Math.max(run.total, total)
    run.emit('verifying', 'Your IPFS node is already keeping the whole archive.', {
      bytesDone: run.done,
      bytesTotal: run.total
    })
    return { served: true, alreadyHadIt: true, blocks: 0, bytes: total, errors: [] }
  }

  const plan = await ensurePlan(run)

  let pinnedUnits = 0
  let failures = 0
  let streak = 0
  let abandoned = false

  for (const [index, unit] of plan.units.entries()) {
    throwIfCancelled(run.signal)

    const position = plan.single
      ? 'the archive'
      : `${index + 1} of ${plan.units.length}: ${unit.label}`
    run.emit('pinning', `Asking your IPFS node to fetch ${position}…`, {
      bytesDone: run.done,
      bytesTotal: run.total
    })

    const result = await withHeartbeat(
      (elapsed) => {
        run.emit(
          'pinning',
          `Your IPFS node is still fetching ${plan.single ? 'the archive' : unit.label} ` +
            `(${formatDuration(elapsed)} so far). Large folders can take a while.`,
          { bytesDone: run.done, bytesTotal: run.total }
        )
      },
      () =>
        pinCid(apiUrl, unit.cid.toString(), {
          recursive: true,
          name: pinName(unit),
          ...(run.signal === undefined ? {} : { signal: run.signal })
        })
    )

    if (result.state === 'pinned') {
      pinnedUnits += 1
      streak = 0
      run.done += unit.bytes
      run.emit('pinning', `Your IPFS node now has ${plan.single ? 'the archive' : unit.label}.`, {
        bytesDone: run.done,
        bytesTotal: run.total
      })
      continue
    }

    failures += 1
    streak += 1
    if (result.error !== undefined && failures <= 3) {
      attemptErrors.push(result.error)
    }

    // Nothing has worked yet and the node keeps coming back empty-handed. It
    // cannot reach this content; grinding through the remaining units would cost
    // hours to learn what these attempts already told us.
    if (pinnedUnits === 0 && streak >= NODE_FAILURE_STREAK) {
      abandoned = true
      break
    }
  }

  if (!abandoned && failures === 0) {
    // Every piece is on the node. Pinning the root now is a local walk, and it
    // is what makes the archive's own address resolvable from this machine.
    if (!plan.single) {
      run.emit('pinning', 'Telling your IPFS node to keep the archive as a whole…')
      const rootPin = await withHeartbeat(
        (elapsed) => {
          run.emit('pinning', `Still finishing up (${formatDuration(elapsed)} so far)…`, {
            bytesDone: run.done,
            bytesTotal: run.total
          })
        },
        () =>
          pinCid(apiUrl, run.root, {
            recursive: true,
            name: BIC_ARCHIVE.label,
            ...(run.signal === undefined ? {} : { signal: run.signal })
          })
      )
      if (rootPin.state !== 'pinned' && rootPin.error !== undefined) {
        attemptErrors.push(rootPin.error)
      }
    }

    if (await confirmNodePin(run, apiUrl)) {
      return {
        served: true,
        alreadyHadIt: false,
        blocks: 0,
        bytes: run.done > 0 ? run.done : knownArchiveBytes(run.root),
        errors: []
      }
    }
  }

  if (failures > 0 && pinnedUnits > 0) {
    attemptErrors.push(
      `Your IPFS node fetched ${pinnedUnits} of ${plan.units.length} parts of the archive by ` +
        'itself but could not find the rest on the network, so the missing pieces were ' +
        'downloaded here instead.'
    )
  }

  /* The node could not do it alone: download the blocks and hand them over. */
  return await handToNodeAsCar(run, apiUrl, attemptErrors)
}

/**
 * Download the archive here, write it as a `.car`, and import that into the node.
 *
 * This is the route that can bring back content nobody else is providing: a CAR
 * import preserves every CID exactly, so the node becomes a genuine provider for
 * addresses that no amount of asking the network would have produced.
 *
 * The `.car` is left in the member's chosen folder afterwards. It is the only
 * artefact that can rebuild the archive if the node is ever lost, so deleting it
 * to save space would be throwing away the most valuable thing this run made.
 */
async function handToNodeAsCar(
  run: Run,
  apiUrl: string,
  attemptErrors: readonly string[]
): Promise<NodeOutcome> {
  const download = await downloadArchive(run)
  const carPath = download.carPath

  /** The node's own failures only matter if this rescue did not work either. */
  const failedWith = (extra: readonly string[] = []): string[] => [
    ...attemptErrors,
    ...download.errors,
    ...extra
  ]

  if (carPath === undefined) {
    return {
      served: false,
      alreadyHadIt: false,
      blocks: download.blocks,
      bytes: download.bytes,
      errors: failedWith()
    }
  }

  // The download took a while, and the node was last seen before it started.
  // Checking it is still there costs one quick question and saves pushing a
  // multi-gigabyte upload at a socket that closed twenty minutes ago — which
  // stalls until the import's own deadline gives up, long after we could have
  // told the member what actually happened.
  const stillThere = await probeNodeAt(apiUrl, run.signal)
  if (!stillThere.available) {
    return {
      served: false,
      alreadyHadIt: false,
      blocks: download.blocks,
      bytes: download.bytes,
      carPath,
      errors: failedWith([
        stillThere.detail ??
          'Your IPFS node stopped answering while the archive was downloading, so it could not be ' +
            'handed over. The backup file is safe on your disk — start the node and try again.'
      ])
    }
  }

  run.emit('pinning', 'Handing the downloaded archive to your IPFS node…', {
    bytesDone: run.done,
    bytesTotal: run.total
  })

  try {
    await withHeartbeat(
      (elapsed) => {
        run.emit(
          'pinning',
          `Your IPFS node is taking in the archive (${formatDuration(elapsed)} so far)…`,
          { bytesDone: run.done, bytesTotal: run.total }
        )
      },
      () =>
        importCarToKubo(apiUrl, carPath, {
          pinRoots: true,
          ...(run.signal === undefined ? {} : { signal: run.signal })
        })
    )
  } catch (err) {
    if (isCancellation(err)) throw err
    return {
      served: false,
      alreadyHadIt: false,
      blocks: download.blocks,
      bytes: download.bytes,
      carPath,
      errors: failedWith([plainText(err)])
    }
  }

  const served = await confirmNodePin(run, apiUrl)

  return {
    served,
    alreadyHadIt: false,
    blocks: download.blocks,
    bytes: download.bytes,
    carPath,
    errors: served
      ? []
      : failedWith([
          'Your IPFS node took in the archive but did not confirm that it is keeping it. ' +
            'The backup file is safe on your disk — try the mirror again, and if it keeps ' +
            'happening, restart your IPFS node.'
        ])
  }
}

/** Ask the node to confirm the pin landed, rather than assuming it did. */
async function confirmNodePin(run: Run, apiUrl: string): Promise<boolean> {
  run.emit('verifying', 'Confirming your IPFS node is keeping the archive…', {
    bytesDone: run.done,
    bytesTotal: run.total
  })
  return (await isPinnedSafely(apiUrl, run.root, run.signal)) === 'pinned'
}

/** {@link isPinned}, with an unreachable node reported as `unknown`. */
async function isPinnedSafely(
  apiUrl: string,
  cid: string,
  signal: AbortSignal | undefined
): Promise<'pinned' | 'not-pinned' | 'unknown'> {
  try {
    const state = await isPinned(apiUrl, cid, signal)
    if (state === 'pinned' || state === 'not-pinned') return state
    return 'unknown'
  } catch (err) {
    if (isCancellation(err)) throw err
    return 'unknown'
  }
}

/* -------------------------------------------------------------------------- */
/* route 2 — Pinata                                                            */
/* -------------------------------------------------------------------------- */

interface PinataOutcome {
  served: boolean
  errors: string[]
}

/**
 * Ask Pinata to keep a copy.
 *
 * Pin-by-CID asks Pinata to go and *find* the content, so this route works on
 * its own only when somebody is already providing it. When the member has a node
 * we hand Pinata that node's addresses to fetch from; when they do not, we check
 * first whether anyone is announcing the archive at all, and refuse to queue a
 * job that would sit in "searching" for days and then expire. Telling a member
 * "queued!" for work that cannot succeed is worse than telling them the truth.
 *
 * The result is verified against Pinata's own pin list. A queued job is not a
 * mirror, and neither is an API response that says "pinned" without the pin list
 * agreeing.
 */
async function mirrorToPinata(
  run: Run,
  token: string | null,
  node: PinTargetStatus
): Promise<PinataOutcome> {
  const errors: string[] = []
  const auth = (token ?? '').trim()
  if (auth === '') return { served: false, errors }

  run.emit('verifying', 'Checking whether Pinata already has the archive…')
  const already = await pinataHasCid(auth, run.root, run.signal)
  if (already === true) {
    run.emit('done', 'Pinata is already keeping a copy of the archive.')
    return { served: true, errors }
  }

  const hostNodes = node.available ? (node.multiaddrs ?? []) : []

  if (hostNodes.length === 0) {
    run.emit('checking', 'Checking whether anyone on the network is sharing the archive…')
    const providers = await checkProviders(run.root, run.signal)
    if (providers === 0) {
      errors.push(
        'Nobody on the IPFS network is currently sharing this archive, and there is no IPFS node ' +
          'on this computer for Pinata to fetch it from — so asking Pinata to pin it would fail ' +
          'after several days of searching. Install IPFS (or use the backup file this app can ' +
          'save) and try again; that is the only way to bring this content back.'
      )
      return { served: false, errors }
    }
  }

  run.emit('pinning', 'Asking Pinata to fetch and keep the archive…', {
    bytesDone: run.done,
    bytesTotal: run.total
  })

  let queued
  try {
    queued = await pinByCid(auth, run.root, {
      name: BIC_ARCHIVE.label,
      hostNodes,
      ...(run.signal === undefined ? {} : { signal: run.signal })
    })
  } catch (err) {
    if (isCancellation(err)) throw err
    errors.push(plainText(err, token))
    return { served: false, errors }
  }

  if (queued.state === 'failed') {
    errors.push(queued.error ?? 'Pinata would not accept the archive.')
    addRelayWarning(errors, node, hostNodes)
    return { served: false, errors }
  }

  if (queued.state === 'pinning' && queued.requestId !== undefined) {
    const waited = await waitForPinataJob(run, auth, queued.requestId)
    if (waited !== undefined) errors.push(waited)
  }

  // Verify rather than trust: only Pinata's own pin list proves anything.
  run.emit('verifying', "Checking Pinata's list to confirm the archive really landed…")
  const confirmed = await pinataHasCid(auth, run.root, run.signal)

  if (confirmed === true) {
    return { served: true, errors }
  }

  if (confirmed === null) {
    errors.push(
      'Pinata accepted the archive but its list of pinned content could not be read, so this app ' +
        'cannot promise the copy is really there. Check the Files list in your Pinata dashboard.'
    )
  } else if (queued.state === 'pinned') {
    errors.push(
      'Pinata reported the archive as pinned, but it is not in the account’s pinned list. ' +
        'Check your Pinata dashboard before relying on that copy.'
    )
  }

  addRelayWarning(errors, node, hostNodes)

  // Never leave "it did not work" without a reason attached to it.
  if (errors.length === 0) {
    errors.push(
      'Pinata has taken the request but has not confirmed a copy of the archive yet. Nothing has ' +
        'been lost — check your Pinata dashboard in a while, or run this again later.'
    )
  }

  return { served: false, errors }
}

/**
 * Follow a queued Pinata job until it finishes, fails, or outlasts our patience.
 *
 * @returns A plain-English problem, or `undefined` when the job finished.
 */
async function waitForPinataJob(
  run: Run,
  token: string,
  requestId: string
): Promise<string | undefined> {
  const deadline = Date.now() + PINATA_WAIT_MS

  for (;;) {
    throwIfCancelled(run.signal)

    let state
    try {
      state = await pinJobStatus(token, requestId, run.signal)
    } catch (err) {
      if (isCancellation(err)) throw err
      return plainText(err, token)
    }

    if (state === 'pinned') return undefined

    if (state === 'failed') {
      // The failure text is where the guidance lives — "expired" in particular
      // is the one a member needs explained rather than repeated.
      try {
        const detail = await pinJobResult(token, requestId, {
          cid: run.root,
          ...(run.signal === undefined ? {} : { signal: run.signal })
        })
        return detail.error ?? 'Pinata could not fetch the archive.'
      } catch (err) {
        if (isCancellation(err)) throw err
        return 'Pinata could not fetch the archive.'
      }
    }

    if (state === 'unknown') {
      // The job left the queue. That usually means it finished; the pin-list
      // check the caller does next is what settles it.
      return undefined
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return (
        'Pinata is still fetching the archive. It has not failed — an archive this size takes a ' +
        'while — but it had not finished by the time this run stopped waiting. Check your Pinata ' +
        'dashboard in an hour or so.'
      )
    }

    run.emit(
      'verifying',
      `Waiting for Pinata to finish fetching the archive (up to ${formatDuration(remaining)} more)…`,
      { bytesDone: run.done, bytesTotal: run.total }
    )
    await sleep(Math.min(PINATA_POLL_MS, remaining), run.signal)
  }
}

/**
 * A node behind a home router usually announces only relayed addresses, which a
 * pinning service generally cannot dial. Saying that plainly turns a baffling
 * failure into an actionable one.
 */
function addRelayWarning(
  errors: string[],
  node: PinTargetStatus,
  hostNodes: readonly string[]
): void {
  if (!node.available) return

  if (hostNodes.length === 0) {
    if (node.detail !== undefined) errors.push(node.detail)
    return
  }

  if (hostNodes.every((addr) => addr.includes('/p2p-circuit'))) {
    errors.push(
      'Your IPFS node is not directly reachable from the internet — it reaches the network ' +
        'through relays — so Pinata may not be able to fetch from it. Your own copy is unaffected. ' +
        'To fix it, allow incoming connections on port 4001 to this computer.'
    )
  }
}

/* -------------------------------------------------------------------------- */
/* route 3 — a cold copy on the member's disk                                  */
/* -------------------------------------------------------------------------- */

interface ColdOutcome {
  carPath?: string
  blocks: number
  bytes: number
  errors: string[]
}

/**
 * Download the archive and write it as a verifiable `.car`.
 *
 * This is what a member with nothing installed gets, and it is genuinely worth
 * having — a `.car` preserves every original CID, so it can restore content that
 * has disappeared from the network entirely, which is precisely what happened to
 * 428 addresses in the May-2026 sweep.
 *
 * What it does *not* do is serve anything, and the summary says so.
 */
async function coldCopy(run: Run): Promise<ColdOutcome> {
  const download = await downloadArchive(run)
  const outcome: ColdOutcome = {
    blocks: download.blocks,
    bytes: download.bytes,
    errors: download.errors
  }
  if (download.carPath !== undefined) outcome.carPath = download.carPath
  return outcome
}

/* -------------------------------------------------------------------------- */
/* downloading                                                                 */
/* -------------------------------------------------------------------------- */

interface DownloadOutcome {
  carPath?: string
  blocks: number
  bytes: number
  errors: string[]
}

/**
 * Fetch every unit of the archive into the scratch blockstore, then write the
 * whole thing out as one `.car`.
 *
 * Units already on disk from an earlier attempt are verified locally and skipped,
 * so a run interrupted at 1.2 GB does not start again from zero. A unit the
 * network will not serve is recorded and the rest carry on: a partial download
 * still tells the DAO exactly what is missing, which is more useful than an
 * all-or-nothing failure. No `.car` is written unless every unit arrived,
 * because a backup file that silently omits content is the exact failure this
 * app exists to prevent.
 */
async function downloadArchive(run: Run): Promise<DownloadOutcome> {
  // Both the node route and the cold-copy route want the same bytes. Whichever
  // asks second gets the first one's answer rather than a second hour of work —
  // and, just as importantly, does not repeat its complaints.
  const previous = run.download
  if (previous !== undefined) {
    return { ...previous, errors: [] }
  }

  const outcome = await runDownload(run)
  run.download = outcome
  return outcome
}

async function runDownload(run: Run): Promise<DownloadOutcome> {
  const errors: string[] = []

  const store = await ensureStore(run)
  if (store === undefined) {
    errors.push(
      `There is nowhere to save the download: the folder "${run.destDir}" could not be written to. ` +
        'Choose a different folder and try again.'
    )
    return { blocks: 0, bytes: 0, errors }
  }

  const plan = await ensurePlan(run)
  let fetchedBytes = 0
  let fetchedBlocks = 0
  const missing: string[] = []

  for (const [index, unit] of plan.units.entries()) {
    throwIfCancelled(run.signal)

    const what = plan.single ? 'the archive' : unit.label
    const position = plan.single ? '' : ` (${index + 1} of ${plan.units.length})`

    if (await dagIsComplete(unit.cid, store, run.signal)) {
      run.done += unit.bytes
      run.emit('fetching', `Already downloaded: ${what}${position}.`, {
        bytesDone: run.done,
        bytesTotal: run.total
      })
      continue
    }

    run.emit('fetching', `Downloading ${what}${position}…`, {
      bytesDone: run.done,
      bytesTotal: run.total
    })

    try {
      const result = await withHeartbeat(
        (elapsed) => {
          run.emit('fetching', `Still downloading ${what} (${formatDuration(elapsed)} so far)…`, {
            bytesDone: run.done,
            bytesTotal: run.total
          })
        },
        () =>
          fetchDag(unit.cid, store, {
            timeoutMs: unitTimeoutMs(unit.bytes),
            maxBytes: unitMaxBytes(unit.bytes),
            ...(run.signal === undefined ? {} : { signal: run.signal })
          })
      )

      fetchedBlocks += result.blocks
      fetchedBytes += result.bytes
      run.done += unit.bytes > 0 ? unit.bytes : result.bytes
      run.keepWork = true
      run.emit('fetching', `Downloaded ${what}${position}.`, {
        bytesDone: run.done,
        bytesTotal: run.total
      })
    } catch (err) {
      if (isCancellation(err)) {
        // Keep what has landed so far; the next attempt picks up from here.
        run.keepWork = true
        throw err
      }
      missing.push(unit.label === '' ? run.root : unit.label)
      if (missing.length <= 3) errors.push(plainText(err))
    }
  }

  if (missing.length > 0) {
    run.keepWork = true
    errors.push(
      missing.length === 1
        ? `One part of the archive (${missing[0] ?? 'unknown'}) could not be downloaded from any ` +
          'IPFS gateway, so no backup file was written. It may have fallen off the network ' +
          'entirely — tell the DAO, because a copy from someone who still has it is the only fix.'
        : `${missing.length} parts of the archive could not be downloaded from any IPFS gateway, ` +
          'so no backup file was written. They may have fallen off the network entirely — tell ' +
          'the DAO, because a copy from someone who still has it is the only fix.'
    )
    return { blocks: fetchedBlocks, bytes: fetchedBytes, errors }
  }

  /* Everything is here: write the one file that can rebuild it all. */
  const carPath = join(run.destDir, carFileName(run.root))
  run.emit('fetching', 'Writing the backup file…', {
    bytesDone: run.done,
    bytesTotal: run.total
  })

  try {
    let lastReport = 0
    const written = await exportCar(run.rootCid, store, carPath, (count) => {
      const now = Date.now()
      if (now - lastReport < EXPORT_PROGRESS_INTERVAL_MS) return
      lastReport = now
      run.emit(
        'fetching',
        `Writing the backup file — ${formatCount(count)} piece${count === 1 ? '' : 's'} saved…`,
        { bytesDone: run.done, bytesTotal: run.total }
      )
    })

    // The `.car` now holds everything the scratch folder did, so the scratch
    // folder is 1.8 GB of duplicate that has earned its deletion.
    run.keepWork = false

    return {
      carPath,
      blocks: written.blocks,
      bytes: written.bytes,
      errors
    }
  } catch (err) {
    if (isCancellation(err)) {
      run.keepWork = true
      throw err
    }
    run.keepWork = true
    errors.push(plainText(err))
    return { blocks: fetchedBlocks, bytes: fetchedBytes, errors }
  }
}

/** A per-unit budget: a floor, plus an allowance for a slow connection. */
function unitTimeoutMs(bytes: number): number {
  const allowance = (Math.max(0, bytes) / UNIT_BYTES_PER_SECOND) * 1000
  return Math.min(UNIT_MAX_TIMEOUT_MS, UNIT_BASE_TIMEOUT_MS + allowance)
}

/**
 * Ceiling on one response body. Generous — a link's declared size can understate
 * the encoded DAG, and a unit that could not be split (a single huge file) has
 * to be allowed through whole — but finite, so a gateway that answers a 4 MB
 * request with 4 GB is cut off rather than believed.
 */
function unitMaxBytes(bytes: number): number {
  const declared = Math.max(0, bytes) * 2
  return Math.max(16 * 1024 * 1024, Math.min(2 * 1024 * 1024 * 1024, declared))
}

/* -------------------------------------------------------------------------- */
/* planning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Break the archive into units small enough to fetch or pin one at a time.
 *
 * Only *directory* nodes are read to do this — a few kilobytes each — so the
 * plan for a 1.8 GB archive normally costs a single request: the top-level
 * folder listing, whose entries carry their own cumulative sizes. A folder that
 * is itself too big to fetch in one piece is opened and split further, up to a
 * bounded depth.
 *
 * If the archive cannot be listed at all (it is a single file, or no gateway will
 * serve the root node) the plan is one all-or-nothing unit. That is worse for
 * progress reporting but still correct, so a failure here never stops the run.
 */
async function ensurePlan(run: Run): Promise<MirrorPlan> {
  const existing = run.plan
  if (existing !== undefined) return existing

  run.emit('resolving', 'Looking inside the archive to plan the copy…')

  const store = (await ensureStore(run)) ?? new MemoryBlockstore()
  const plan = await planUnits(run, store)
  run.plan = plan
  if (plan.totalBytes > 0) run.total = plan.totalBytes

  if (!plan.single) {
    run.emit(
      'resolving',
      `The archive has ${formatCount(plan.units.length)} parts, ${formatBytes(run.total)} in total.`,
      { bytesDone: run.done, bytesTotal: run.total }
    )
  }

  return plan
}

async function planUnits(run: Run, store: Blockstore): Promise<MirrorPlan> {
  const units: MirrorUnit[] = []

  const descend = async (
    cid: CID,
    label: string,
    size: number,
    depth: number
  ): Promise<void> => {
    throwIfCancelled(run.signal)

    const tooDeep = depth >= MAX_PLAN_DEPTH
    const full = units.length >= MAX_UNITS
    const smallEnough = size > 0 && size <= MAX_UNIT_BYTES
    const opaque = cid.code !== dagPb.code

    if (tooDeep || full || smallEnough || opaque) {
      units.push({ cid, label, bytes: Math.max(0, size) })
      return
    }

    let entries: Array<{ name: string; cid: CID; size: number }>
    try {
      await ensureEntity(cid, store, run.signal)
      entries = await listDirectory(cid, store)
    } catch (err) {
      if (isCancellation(err)) throw err
      // Not a directory, or the listing could not be had. Treat it as one unit.
      units.push({ cid, label, bytes: Math.max(0, size) })
      return
    }

    if (entries.length === 0) {
      units.push({ cid, label, bytes: Math.max(0, size) })
      return
    }

    for (const entry of entries) {
      const childLabel = entry.name === '' ? label : label === '' ? entry.name : `${label}/${entry.name}`
      await descend(entry.cid, childLabel, entry.size, depth + 1)
    }
  }

  await descend(run.rootCid, '', 0, 0)

  let totalBytes = 0
  for (const unit of units) totalBytes += unit.bytes

  const single = units.length <= 1
  return {
    units: units.length === 0 ? [{ cid: run.rootCid, label: '', bytes: 0 }] : units,
    totalBytes,
    single
  }
}

/**
 * Make sure one node's own blocks are on hand, without pulling what is under it.
 *
 * `dag-scope=entity` returns the addressed node itself — for a sharded directory,
 * the shard nodes needed to read it — and nothing more, which is what keeps
 * planning cheap.
 */
async function ensureEntity(
  cid: CID,
  store: Blockstore,
  signal: AbortSignal | undefined
): Promise<void> {
  if (await hasBlock(store, cid)) return

  const { blocks } = await fetchCar(cid, {
    scope: 'entity',
    timeoutMs: ENTITY_TIMEOUT_MS,
    maxBytes: MAX_ENTITY_BYTES,
    ...(signal === undefined ? {} : { signal })
  })

  for (const [key, bytes] of blocks) {
    const parsed = parseCid(key)
    if (parsed === undefined) continue
    await putBlock(store, parsed, bytes)
  }
}

/**
 * Is every block under `cid` already on this disk?
 *
 * Walked locally, so it costs no network at all, and it is what makes an
 * interrupted download resumable. Any doubt — a missing block, a node that will
 * not decode, a DAG larger than the walk budget — answers `false`, because
 * re-downloading is merely slow whereas a half-empty `.car` is a lie.
 */
async function dagIsComplete(
  cid: CID,
  store: Blockstore,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const seen = new Set<string>()
  const stack: CID[] = [cid]
  let visited = 0

  while (stack.length > 0) {
    throwIfCancelled(signal)

    const next = stack.pop()
    if (next === undefined) break

    const key = next.toString()
    if (seen.has(key)) continue
    seen.add(key)

    visited += 1
    if (visited > MAX_WALK_BLOCKS) return false
    if (!(await hasBlock(store, next))) return false
    if (next.code !== dagPb.code) continue

    let node
    try {
      node = dagPb.decode(await getBlockBytes(store, next))
    } catch {
      return false
    }

    for (const link of node.Links) stack.push(link.Hash)
  }

  return true
}

/* -------------------------------------------------------------------------- */
/* scratch space                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Open the scratch blockstore, or `undefined` when the chosen folder cannot be
 * written to. Opened lazily: a member whose node fetches everything by itself
 * never has a folder created at all.
 */
async function ensureStore(run: Run): Promise<Blockstore | undefined> {
  const existing = run.store
  if (existing !== undefined) return existing
  if (!run.diskUsable) return undefined

  try {
    await mkdir(run.destDir, { recursive: true })
    const store = await openBlockstore(run.workDir)
    run.store = store
    return store
  } catch (err) {
    if (isCancellation(err)) throw err
    run.diskUsable = false
    run.errors.push(plainText(err))
    return undefined
  }
}

/**
 * Close the scratch store, and delete it unless keeping it would save the member
 * from downloading a gigabyte twice.
 */
async function releaseWork(run: Run): Promise<void> {
  const store = run.store
  run.store = undefined

  if (store !== undefined) {
    try {
      await closeBlockstore(store)
    } catch {
      /* nothing useful to do at this point */
    }
  }

  if (run.keepWork) return

  try {
    await rm(run.workDir, { recursive: true, force: true })
  } catch {
    /* a leftover scratch folder is untidy, never harmful */
  }
}

/* -------------------------------------------------------------------------- */
/* wording                                                                     */
/* -------------------------------------------------------------------------- */

interface SummaryInput {
  nowServing: boolean
  carPath: string | undefined
  bytes: number
  used: MirrorCapability[]
  nodeAlreadyHadIt: boolean
  failed: boolean
}

/** The one paragraph a member reads at the end. Never overstates the outcome. */
function summarise(input: SummaryInput): string {
  const size = input.bytes > 0 ? ` (${formatBytes(input.bytes)})` : ''
  const parts: string[] = []

  if (input.used.includes('node')) {
    parts.push(
      input.nodeAlreadyHadIt
        ? `Your IPFS node was already keeping the BIC archive${size}, so there was nothing new to ` +
            'download. Other people can fetch it from you.'
        : `The BIC archive${size} is now stored and shared by the IPFS node on this computer. ` +
            'Other people can fetch it from you — you are a real backup for the DAO now.'
    )
  }

  if (input.used.includes('pinata')) {
    parts.push(
      input.used.includes('node')
        ? 'Pinata is keeping a second copy in the cloud, so it stays available when this computer is off.'
        : `Pinata is now keeping a copy of the BIC archive${size} in the cloud, so it stays ` +
            'available even when this computer is off.'
    )
  }

  if (input.carPath !== undefined) {
    parts.push(
      input.nowServing
        ? `A verifiable backup file was also saved to "${input.carPath}". Keep it: it is the only ` +
            'thing that can restore content which has disappeared from the network.'
        : `A verifiable backup file was saved to "${input.carPath}". The files are safe on your ` +
            'disk, but nobody can fetch them from this machine until you install IPFS.'
    )
  }

  if (parts.length === 0) {
    return input.failed
      ? 'Nothing could be copied this time. Nothing was lost or changed — see the notes below for ' +
          'what got in the way, and try again.'
      : 'Nothing needed to be done.'
  }

  return parts.join(' ')
}

/**
 * A filename that is unmistakable a year from now, and safe on every platform.
 *
 * The address is part of the name deliberately: two files called "BIC Backup"
 * from different months are precisely the confusion this app exists to end,
 * whereas a CID says exactly which snapshot is in the file.
 *
 * Only path separators, the characters Windows refuses and control codes are
 * replaced — the label's own punctuation is how a member recognises it.
 */
function carFileName(rootCid: string): string {
  const label = BIC_ARCHIVE.label
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const safe = label === '' ? 'BIC archive' : label
  return `${safe} ${rootCid}.car`
}

/**
 * The label stored with a pin, so the node's pin list is readable by a human.
 * Clamped, because a node will reject an over-long name and losing the pin over
 * a caption would be an absurd trade.
 */
function pinName(unit: MirrorUnit): string {
  const full = unit.label === '' ? BIC_ARCHIVE.label : `${BIC_ARCHIVE.label}/${unit.label}`
  return full.length <= MAX_PIN_NAME_CHARS ? full : full.slice(0, MAX_PIN_NAME_CHARS)
}

/** Bytes as a member would say them: "1.8 GB", "740 MB", "12 KB". */
function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes)
  if (value < 1000) return `${Math.round(value)} bytes`
  if (value < 1000 * 1000) return `${(value / 1000).toFixed(0)} KB`
  if (value < 1000 * 1000 * 1000) return `${(value / (1000 * 1000)).toFixed(0)} MB`
  return `${(value / (1000 * 1000 * 1000)).toFixed(1)} GB`
}

function formatCount(count: number): string {
  return Math.max(0, Math.round(count)).toLocaleString('en-US')
}

/** Durations as a member would say them: "45 seconds", "6 minutes". */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

/**
 * The archive's size, when we know it for certain.
 *
 * `approxBytes` describes one exact snapshot, so it is only usable when that is
 * the snapshot being mirrored. For any other root we would rather report nothing
 * than a number that came from somewhere else.
 */
function knownArchiveBytes(rootCid: string): number {
  return rootCid === BIC_ARCHIVE.rootCid ? BIC_ARCHIVE.approxBytes : 0
}

/** Reduce any thrown value to one sentence with nothing credential-shaped in it. */
function plainText(err: unknown, token?: string | null): string {
  const raw = err instanceof Error ? err.message : String(err)
  const cleaned = redact(raw, token ?? null).trim()
  return cleaned === '' ? 'Something went wrong.' : cleaned
}

/* -------------------------------------------------------------------------- */
/* progress                                                                    */
/* -------------------------------------------------------------------------- */

type Emit = (
  phase: MirrorProgress['phase'],
  message: string,
  extra?: { bytesDone?: number; bytesTotal?: number }
) => void

/**
 * Wrap the caller's listener so that a fraction is filled in whenever the totals
 * allow one, and so a listener that throws can never take the run down with it.
 */
function makeEmitter(onProgress: (p: MirrorProgress) => void): Emit {
  return (phase, message, extra) => {
    const done = extra?.bytesDone
    const total = extra?.bytesTotal

    const progress =
      done !== undefined && total !== undefined && total > 0
        ? Math.min(1, Math.max(0, done / total))
        : undefined

    const event: MirrorProgress = { phase, message }
    if (progress !== undefined) event.progress = progress
    if (done !== undefined) event.bytesDone = Math.max(0, Math.round(done))
    if (total !== undefined && total > 0) event.bytesTotal = Math.round(total)

    try {
      onProgress(event)
    } catch {
      /* a failing listener must never abort a mirror */
    }
  }
}

/**
 * Run one long step, saying something every so often while it works.
 *
 * A single unit can legitimately take minutes — the node searching the network,
 * a gateway feeding us 90 MB — and an app that says nothing for minutes is
 * indistinguishable from an app that has hung.
 */
async function withHeartbeat<T>(
  tick: (elapsedMs: number) => void,
  work: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  const timer = setTicker(() => {
    try {
      tick(Date.now() - startedAt)
    } catch {
      /* a failing listener must never abort a mirror */
    }
  }, HEARTBEAT_MS)
  timer.unref()

  try {
    return await work()
  } finally {
    clearTicker(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

function abortError(): Error {
  const err = new Error('Mirroring was stopped.')
  err.name = 'AbortError'
  return err
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** Wait, but wake immediately if the member cancels. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    function onAbort(): void {
      cleanup()
      reject(abortError())
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    timer.unref?.()

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface SimpleDeadline {
  readonly signal: AbortSignal
  release(): void
}

/** A budget on one request, that also honours the caller's own cancellation. */
function createDeadline(ms: number, outer: AbortSignal | undefined): SimpleDeadline {
  const controller = new AbortController()

  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.round(ms)))
  timer.unref?.()

  const onOuterAbort = (): void => controller.abort()
  if (outer !== undefined) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }

  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}

/** Free the socket without reading a body we do not want. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* the connection is going away regardless */
  }
}

function parseCid(value: string): CID | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    return CID.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * Every spelling of a CID a service might answer with. Nodes and pinning
 * services report whichever base they prefer — often CIDv0 `Qm…` where we hold
 * the CIDv1 `bafy…` form of the very same block — so a membership test has to
 * try both or it will report safe content as missing.
 */
function cidSpellings(cid: string): string[] {
  const forms = new Set<string>([cid.trim()])
  const parsed = parseCid(cid)

  if (parsed !== undefined) {
    forms.add(parsed.toString())
    try {
      forms.add(parsed.toV1().toString())
    } catch {
      /* not convertible; the spellings we have are still valid */
    }
    if (parsed.code === dagPb.code && parsed.multihash.code === 0x12) {
      try {
        forms.add(parsed.toV0().toString())
      } catch {
        /* not convertible */
      }
    }
  }

  return [...forms].filter((form) => form !== '')
}

function stripPrefix(value: string, prefixes: readonly string[]): string {
  const trimmed = value.trim()
  for (const prefix of prefixes) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length)
    }
  }
  return trimmed
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
