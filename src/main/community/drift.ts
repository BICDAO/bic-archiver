/**
 * Drift — is the copy this member is serving still the copy BIC publishes?
 *
 * The archive is a UnixFS directory, so its root CID changes the moment anything
 * inside it changes. A member who mirrored in May is serving May's archive for
 * ever, and — exactly like the failure this whole app exists to fix — nothing
 * tells them. Nobody gets an email when a directory CID moves on. This module is
 * the check that says so.
 *
 * Three decisions are worth spelling out, because each of them came from
 * something measured rather than assumed:
 *
 * **The name is resolved as DNS, not by asking a gateway.** BIC publishes through
 * DNSLink: a TXT record on `_dnslink.bureauofinternetculture.art` holding
 * `dnslink=/ipfs/<cid>`. Reading that record directly is one small request that
 * gives the exact answer. Asking a gateway for `/ipns/bureauofinternetculture.art`
 * instead makes it try to render a directory listing of 20,808 entries, which
 * times out with a 504 — and a 504 there is *not* a resolution failure, however
 * much it looks like one. Any code that treated it as one would report healthy
 * members as broken. Trustless gateways refuse IPNS names outright (measured:
 * HTTP 406, "only trustless requests are accepted on this gateway"), so they
 * cannot stand in either.
 *
 * **A failed lookup is never drift.** Being offline, behind a captive portal, or
 * on a network that mangles DNS is not the same as being out of date, and this
 * check must never say "your copy is stale" because it could not reach the
 * internet. When the published address cannot be established the verdict is
 * `unknown` and the sentence says plainly that the check could not run. The
 * built-in {@link BIC_ARCHIVE.rootCid} is used as a last-resort *answer* for
 * {@link resolvePublishedCid}, but it is never treated as proof of what BIC
 * publishes today: comparing a member's copy against a CID baked into an app
 * release would manufacture drift out of nothing every time BIC updated the
 * archive between releases.
 *
 * **What the member holds is a fact about their machine, not a memory.** The
 * mirror writes down what it copied (see {@link recordMirrored}), and that note
 * is the primary evidence. But a note can be missing — a fresh install, a member
 * who mirrored before this app kept notes, a copy made another way — so when the
 * note disagrees with what BIC publishes, or is absent, the member's own IPFS
 * node is asked whether it is already keeping the current archive. The node is
 * the thing that actually serves content, so the node gets the last word.
 *
 * Nothing here writes to the network, nothing here handles a credential, and
 * every function below answers rather than throws: a status panel that cannot
 * draw itself is worse than one that says "not known just now".
 */

import { resolveTxt } from 'node:dns/promises'
import { mkdir, open as openFile, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { CID } from 'multiformats/cid'

import { BIC_ARCHIVE } from '../../shared/community.js'
import { FALLBACK_GATEWAYS } from '../../shared/constants.js'
import type { DriftStatus } from '../../shared/node.js'
import type { PinningSettings } from '../../shared/pinning.js'

import { isPinned } from '../pinning/kubo.js'

/* -------------------------------------------------------------------------- */
/* public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where the "what did I last mirror?" note is kept.
 *
 * The app's {@link SettingsStore} satisfies this structurally — the note lives
 * beside `settings.json` in Electron's `userData` folder — and a plain folder
 * path is accepted too, which is what makes this module usable outside Electron
 * (tests, scripts) without pulling the app's process model in with it.
 *
 * The note is deliberately NOT part of `settings.json`: that file is normalised
 * field by field on every load and write, so anything unrecognised in it is
 * discarded by design. This is separate state, so it gets a separate file.
 */
export type DriftStateStore = { readonly settingsPath: string } | string

/** Extra context for {@link getLocalMirrorCid}. Both parts are optional. */
export interface LocalMirrorOptions {
  /**
   * The CID BIC publishes right now, when the caller already knows it. Saves
   * this module guessing which of several plausible addresses to ask the node
   * about, and lets a member who re-mirrored outside this app be recognised as
   * up to date rather than reported stale.
   */
  publishedCid?: string
  signal?: AbortSignal
}

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

const USER_AGENT = 'bic-archiver/0.1 (+drift check)'

/** The note, kept beside `settings.json`. */
const RECORD_FILE = 'mirror-state.json'
/** Bumped only if the shape below ever changes incompatibly. */
const RECORD_VERSION = 1
/** Owner read/write. Not a secret, but nothing here needs to be world-readable. */
const RECORD_FILE_MODE = 0o600

/**
 * DNS-over-HTTPS, asked first.
 *
 * Cloudflare leads because it is the endpoint named in this module's brief and
 * answers in tens of milliseconds; Google is the second opinion, because a
 * member whose network blocks or hijacks one provider still deserves the current
 * archive rather than a shrug. Only a public domain name is ever sent, never
 * anything about the member.
 */
const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve'
] as const

/** A DoH answer is a few hundred bytes; anything vast is a broken endpoint. */
const MAX_DOH_BYTES = 256 * 1024

const DOH_TIMEOUT_MS = 8_000
/** The OS resolver offers no deadline of its own, so it is given one. */
const SYSTEM_DNS_TIMEOUT_MS = 5_000
const GATEWAY_TIMEOUT_MS = 12_000
/** Whole-stage ceiling on gateway resolution, however many gateways are listed. */
const GATEWAY_BUDGET_MS = 30_000

/** `dnslink=/ipns/<other name>` redirections to follow. One is plenty. */
const MAX_DNSLINK_HOPS = 1

/* -------------------------------------------------------------------------- */
/* the published address                                                       */
/* -------------------------------------------------------------------------- */

/** How the published address was established, for the log and for honesty. */
type PublishedVia = 'dnslink-doh' | 'dnslink-system' | 'gateway' | 'address' | 'built-in'

interface Published {
  /** Null only when even the built-in address is unparseable, i.e. a bad build. */
  cid: string | null
  /**
   * True when this really is what BIC publishes right now. False means every
   * lookup failed and `cid` is only the address compiled into this app — usable
   * as an answer, useless as a thing to measure drift against.
   */
  known: boolean
  via: PublishedVia
}

/**
 * The root CID BIC publishes right now, or null if even the fallback is unusable.
 *
 * Resolution order, best first:
 *
 *   1. **The DNSLink TXT record over DNS-over-HTTPS.** This is the record itself,
 *      straight from a public resolver — one request, no gateway involved, and no
 *      chance of the 504 that asking a gateway to list 20,808 entries produces.
 *   2. **The operating system's own resolver.** Second rather than first on
 *      purpose: underscore-prefixed records are mangled or refused often enough
 *      by home routers and corporate resolvers to be unreliable, and this app has
 *      already been observed getting NXDOMAIN locally for a record public DNS
 *      serves perfectly. It is still asked, because a network that blocks the DoH
 *      endpoints may resolve DNS normally.
 *   3. **A gateway's answer.** Gateways do the DNSLink lookup themselves and
 *      report the result in `X-Ipfs-Roots`, so this works even when this
 *      machine's DNS is hopeless. Note that delegated routing (`/routing/v1/ipns`)
 *      is *not* used: that serves signed IPNS records for libp2p keys, DNSLink
 *      names are not in the routing system at all, and the endpoint answers a
 *      miss with HTTP 200 and a plain-text error body — the exact shape of thing
 *      that gets mistaken for a valid answer.
 *   4. **The address built into this app.** Correct at release, and stale the
 *      moment BIC adds an NFT, which is why {@link checkDrift} treats reaching
 *      this step as "could not check" rather than as an answer.
 *
 * Whatever comes back is only a *name* for content that is hash-verified block by
 * block whenever it is actually fetched, so a wrong answer here cannot smuggle in
 * different bytes.
 *
 * Never throws for a lookup failure. Throws an `Error` with
 * `name === 'AbortError'` only if `signal` is aborted.
 */
export async function resolvePublishedCid(signal?: AbortSignal): Promise<string | null> {
  const published = await resolvePublished(signal)
  return published.cid
}

async function resolvePublished(signal?: AbortSignal): Promise<Published> {
  throwIfCancelled(signal)

  const builtIn = validCid(BIC_ARCHIVE.rootCid)
  const pointer = (BIC_ARCHIVE.pointer ?? '').trim()

  // No pointer published at all: the address in this build is the only address
  // there is, so it is the published one and nothing can have drifted from it.
  if (pointer === '') return { cid: builtIn, known: true, via: 'built-in' }

  // A pointer that is already an address needs no lookup.
  const direct = validCid(stripPrefix(pointer, ['/ipfs/', 'ipfs://']))
  if (direct !== null) return { cid: direct, known: true, via: 'address' }

  const name = stripPrefix(pointer, ['/ipns/', 'ipns://']).replace(/\/+$/, '')
  if (name === '') {
    // A malformed pointer is a broken build rather than a network problem. The
    // built-in address is all this app has, so it is the reference.
    return { cid: builtIn, known: true, via: 'built-in' }
  }

  if (isDomainName(name)) {
    const viaDoh = await resolveDnsLink(name, dohTxt, signal, 0)
    if (viaDoh !== null) return { cid: viaDoh, known: true, via: 'dnslink-doh' }

    const viaSystem = await resolveDnsLink(name, systemTxt, signal, 0)
    if (viaSystem !== null) return { cid: viaSystem, known: true, via: 'dnslink-system' }
  }

  // Works for a DNSLink domain and for a libp2p key alike, because the gateway
  // does whichever kind of resolution the name needs.
  const viaGateway = await resolveViaGateways(name, signal)
  if (viaGateway !== null) return { cid: viaGateway, known: true, via: 'gateway' }

  // The individual attempts stay quiet, because on an offline machine every one
  // of them failing is the expected outcome rather than news. This one line is
  // the news: nothing could say what BIC publishes, so drift cannot be judged.
  note(
    `nothing could resolve "${pointer}" — DNS-over-HTTPS, this computer's own resolver and ` +
      'public gateways were all tried, so this check cannot say whether the copy here is current'
  )
  return { cid: builtIn, known: false, via: 'built-in' }
}

/** Every TXT record for one host, from one source. */
type TxtLookup = (host: string, signal: AbortSignal | undefined) => Promise<string[]>

/**
 * Read `dnslink=/ipfs/<cid>` for a domain.
 *
 * `_dnslink.<domain>` is where the record belongs; the bare domain is checked
 * too because the older convention put it there and costs one extra lookup to
 * rule out. A record pointing at another name is followed once, which is legal
 * DNSLink; beyond that we stop rather than chase a loop somebody else made.
 */
async function resolveDnsLink(
  name: string,
  lookup: TxtLookup,
  signal: AbortSignal | undefined,
  depth: number
): Promise<string | null> {
  if (depth > MAX_DNSLINK_HOPS) return null

  for (const host of [`_dnslink.${name}`, name]) {
    throwIfCancelled(signal)

    for (const record of await lookup(host, signal)) {
      const target = dnsLinkTarget(record)
      if (target === null) continue

      // A bare `/ipfs/<cid>`, which is what BIC publishes. A value carrying a
      // path (`/ipfs/<cid>/some/folder`) is deliberately left alone rather than
      // truncated to its CID: the address the pointer names is the folder at the
      // end of that path, not the directory at the start of it, and resolving
      // that is a job for the gateway step, which walks the whole path.
      const cid = validCid(stripPrefix(target, ['/ipfs/']))
      if (cid !== null) return cid

      const next = stripPrefix(target, ['/ipns/']).replace(/\/+$/, '')
      if (next !== '' && next !== name && isDomainName(next)) {
        const chased = await resolveDnsLink(next, lookup, signal, depth + 1)
        if (chased !== null) return chased
      }
    }
  }

  return null
}

/** `dnslink=/ipfs/…` out of one TXT record, or null if it is something else. */
function dnsLinkTarget(record: string): string | null {
  const match = /^\s*dnslink\s*=\s*(\/\S+)\s*$/i.exec(record)
  return match?.[1] ?? null
}

/**
 * TXT records over DNS-over-HTTPS.
 *
 * Providers disagree about quoting — Cloudflare returns `"dnslink=/ipfs/…"` with
 * the quotes and Google returns it without, both measured — and long values
 * arrive split into several quoted chunks, so both are normalised here.
 */
async function dohTxt(host: string, signal: AbortSignal | undefined): Promise<string[]> {
  for (const endpoint of DOH_ENDPOINTS) {
    throwIfCancelled(signal)

    const url = `${endpoint}?name=${encodeURIComponent(host)}&type=TXT`
    const deadline = createDeadline(DOH_TIMEOUT_MS, signal)

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: 'application/dns-json', 'user-agent': USER_AGENT },
        signal: deadline.signal
      })

      if (!response.ok || oversized(response, MAX_DOH_BYTES)) {
        await discardBody(response)
        continue
      }

      const records = txtFromDnsJson((await response.json()) as unknown)
      if (records.length > 0) return records
    } catch {
      // A resolver that will not answer is an ordinary event, and on an offline
      // machine it is the *expected* one, so it is not worth a log line — the
      // single summary in `resolvePublished` covers it. Only the member's own
      // cancellation stops the search.
      if (signal?.aborted === true) throw abortError()
    } finally {
      deadline.release()
    }
  }

  return []
}

/** Pull TXT values out of a `application/dns-json` reply. */
function txtFromDnsJson(body: unknown): string[] {
  const answers = (body as { Answer?: unknown } | null)?.Answer
  if (!Array.isArray(answers)) return []

  const records: string[] = []
  for (const answer of answers) {
    const entry = answer as { type?: unknown; data?: unknown } | null
    // TXT is type 16. A provider that omits the type is given the benefit of the
    // doubt, since a `dnslink=` value could not have come from anywhere else.
    if (entry?.type !== undefined && entry.type !== 16) continue
    if (typeof entry?.data !== 'string') continue
    records.push(entry.data.replace(/"\s*"/g, '').replace(/^"|"$/g, ''))
  }
  return records
}

/**
 * TXT records from the operating system's own resolver, with a deadline it does
 * not offer. A failure of any kind — NXDOMAIN, SERVFAIL, no resolver configured
 * — just means "ask somebody else".
 */
async function systemTxt(host: string, signal: AbortSignal | undefined): Promise<string[]> {
  throwIfCancelled(signal)

  const deadline = createDeadline(SYSTEM_DNS_TIMEOUT_MS, signal)
  try {
    // The lookup's own rejection is absorbed here rather than left to lose the
    // race and surface later as an unhandled rejection. NXDOMAIN, SERVFAIL and
    // "no resolver configured" all mean the same thing to us — ask somebody else.
    const lookup = resolveTxt(host).catch((): string[][] => [])

    // Resolves rather than rejects, so losing the race is never an error, and it
    // is wired to the deadline so `release()` below disposes of the timer even
    // when the resolver answered first.
    const expiry = new Promise<string[][]>((resolve) => {
      deadline.signal.addEventListener('abort', () => resolve([]), { once: true })
    })

    const answer = await Promise.race([lookup, expiry])
    // The deadline also fires when the member cancels; that is not a timeout.
    throwIfCancelled(signal)

    // Long TXT values arrive split into chunks that have to be rejoined.
    return answer.map((chunks) => chunks.join(''))
  } finally {
    deadline.release()
  }
}

/**
 * Ask gateways what the name resolves to, without asking them to render it.
 *
 * Two request shapes, because gateways differ and this is the fallback that has
 * to work when this machine's DNS does not:
 *
 *   - A `HEAD` of `/ipns/<name>` with redirects NOT followed. Measured against
 *     `ipfs.io`: it answers 301 to the trailing-slash form and the redirect
 *     itself already carries `X-Ipfs-Roots: bafybei…`. Not following that
 *     redirect is the whole trick — following it is what asks for a listing of
 *     20,808 entries and earns the 504.
 *   - The subdomain form, `<name>.ipns.<gateway>/?format=raw` with a one-byte
 *     range. Measured against `dweb.link`: 206 with both `X-Ipfs-Roots` and an
 *     `Etag`, and `?format=raw` returns the single root block rather than a
 *     listing, so there is nothing large to time out on.
 *
 * The whole stage is bounded, so an offline machine spends seconds here, not
 * minutes.
 */
async function resolveViaGateways(
  name: string,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const stageEnd = Date.now() + GATEWAY_BUDGET_MS

  for (const gateway of FALLBACK_GATEWAYS) {
    throwIfCancelled(signal)
    if (Date.now() >= stageEnd) break

    const path = `${trimSlash(gateway)}/ipns/${encodeURIComponent(name)}`
    const viaPath = await gatewayRoot(path, 'HEAD', false, signal)
    if (viaPath !== null) return viaPath

    if (Date.now() >= stageEnd) break

    const subdomain = subdomainUrl(gateway, name)
    if (subdomain !== null) {
      const viaSubdomain = await gatewayRoot(`${subdomain}?format=raw`, 'GET', true, signal)
      if (viaSubdomain !== null) return viaSubdomain
    }
  }

  return null
}

/** One gateway attempt. Never throws except for the member's own cancellation. */
async function gatewayRoot(
  url: string,
  method: 'GET' | 'HEAD',
  raw: boolean,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const deadline = createDeadline(GATEWAY_TIMEOUT_MS, signal)

  try {
    const response = await fetch(url, {
      method,
      // A redirect is not a failure here — it is where the answer lives.
      redirect: 'manual',
      headers: {
        'user-agent': USER_AGENT,
        ...(raw
          ? // One byte is enough: what we want is in the headers.
            { accept: 'application/vnd.ipld.raw', range: 'bytes=0-0' }
          : {})
      },
      signal: deadline.signal
    })

    const cid = cidFromHeaders(response)
    await discardBody(response)
    return cid
  } catch {
    // A gateway that will not answer is an ordinary event; try the next one.
    if (signal?.aborted === true) throw abortError()
    return null
  } finally {
    deadline.release()
  }
}

/**
 * The subdomain form of a gateway URL.
 *
 * Inlined DNSLink names replace `-` with `--` and `.` with `-`, so
 * `bureauofinternetculture.art` becomes `bureauofinternetculture-art`. A libp2p
 * key contains neither character and passes through unchanged. Null when the
 * label would be an illegal DNS label, which is the point at which this form
 * stops being worth trying.
 */
function subdomainUrl(gateway: string, name: string): string | null {
  const label = name.replace(/-/g, '--').replace(/\./g, '-').toLowerCase()
  if (label.length === 0 || label.length > 63) return null

  let host: string
  try {
    host = new URL(gateway).host
  } catch {
    return null
  }
  if (host === '') return null

  return `https://${label}.ipns.${host}/`
}

/**
 * Pull the resolved root out of a gateway reply.
 *
 * `X-Ipfs-Roots` lists the CIDs walked to satisfy the request, so its last entry
 * is what the name resolved to. `Etag` carries the same answer on gateways that
 * do not send the roots header.
 */
function cidFromHeaders(response: Response): string | null {
  const roots = response.headers.get('x-ipfs-roots')
  if (roots !== null) {
    const parts = roots.split(',')
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const parsed = validCid((parts[index] ?? '').trim())
      if (parsed !== null) return parsed
    }
  }

  const etag = response.headers.get('etag')
  if (etag !== null) {
    const cleaned = etag
      .replace(/^W\//i, '')
      .replace(/"/g, '')
      .replace(/\.(raw|car)$/i, '')
      .trim()
    const parsed = validCid(cleaned)
    if (parsed !== null) return parsed
  }

  return null
}

/* -------------------------------------------------------------------------- */
/* what this member actually holds                                             */
/* -------------------------------------------------------------------------- */

/** What the member holds, and how we know. */
interface LocalMirror {
  cid: string | null
  /** Only when the answer came from the note, which is the only dated evidence. */
  mirroredAt?: string
  via: 'record' | 'node' | 'none'
}

/**
 * The root CID of the archive this member actually has.
 *
 * The note written by the last successful mirror comes first: it is the only
 * evidence that records *when*, and it is true even while the member's node is
 * switched off. When there is no note, or the note disagrees with what BIC
 * publishes, the member's IPFS node is asked directly — a member who re-mirrored
 * by other means is not behind, and telling them they were would send them off
 * to redo 1.8 GB of work for nothing.
 *
 * Returns null when there is no sign of a copy on this computer. That is not the
 * same as "the check failed": an unreachable node simply cannot contribute an
 * answer, and the note is read from disk regardless.
 *
 * Never throws for an unreachable node or an unreadable note. Throws an `Error`
 * with `name === 'AbortError'` only if `options.signal` is aborted.
 */
export async function getLocalMirrorCid(
  settings: PinningSettings,
  store: DriftStateStore,
  options: LocalMirrorOptions = {}
): Promise<string | null> {
  const found = await findLocalMirror(settings, store, options)
  return found.cid
}

async function findLocalMirror(
  settings: PinningSettings,
  store: DriftStateStore,
  options: LocalMirrorOptions
): Promise<LocalMirror> {
  const signal = options.signal
  throwIfCancelled(signal)

  const published = validCid(options.publishedCid ?? '')
  const record = await readRecord(store)

  if (record !== null) {
    const fromRecord: LocalMirror = {
      cid: record.rootCid,
      mirroredAt: record.mirroredAt,
      via: 'record'
    }
    if (published === null || sameCid(record.rootCid, published)) return fromRecord

    // The note and the published address disagree. Before anyone is told they are
    // out of date, ask the node whether it is already keeping the current archive.
    if (await nodeIsKeeping(settings, published, signal)) {
      return { cid: published, via: 'node' }
    }
    return fromRecord
  }

  // No note: this member may have mirrored on an earlier install, or with the
  // `ipfs` command, or before this app started keeping notes. The node knows.
  for (const candidate of dedupe([published, validCid(BIC_ARCHIVE.rootCid)])) {
    if (await nodeIsKeeping(settings, candidate, signal)) return { cid: candidate, via: 'node' }
  }

  return { cid: null, via: 'none' }
}

/**
 * Is the member's IPFS node keeping this exact archive?
 *
 * Asked regardless of whether automatic pinning is switched on in Settings: this
 * is a question about what the machine is serving right now, not about the
 * member's preferences. A node that is not running, not installed, or too busy to
 * answer contributes a plain `false` — `isPinned` reports an unanswerable
 * question as `unknown`, which is emphatically not `not-pinned`.
 */
async function nodeIsKeeping(
  settings: PinningSettings,
  cid: string | null,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (cid === null) return false

  const apiUrl = settings.kubo.apiUrl.trim()
  if (apiUrl === '') return false

  try {
    return (await isPinned(apiUrl, cid, signal)) === 'pinned'
  } catch (err) {
    if (isCancellation(err)) throw err
    note('the IPFS node could not be asked what it is keeping', err)
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* the verdict                                                                 */
/* -------------------------------------------------------------------------- */

const DETAIL = {
  notMirrored:
    "There is no sign of a copy of BIC's archive on this computer yet, so there is nothing to " +
    'compare — making one is the single most useful thing you can do for the archive.',
  inSync: 'Your copy matches the archive BIC publishes right now, so there is nothing to do.',
  behind:
    'BIC has updated the archive since you last copied it — your copy is from an older version, ' +
    'and copying again will bring it up to date.',
  unknown:
    "BIC's published address could not be looked up just now, usually because this computer is " +
    'offline — that only means this check could not run, not that anything is wrong with your copy.',
  badBuild:
    "This copy of the app does not have a usable address for BIC's archive, so the check could " +
    'not run — updating the app will fix it.'
} as const

/**
 * Compare what this member holds against what BIC publishes.
 *
 * The four verdicts are deliberately distinct, and the distinction that matters
 * most is between `behind` and `unknown`. `behind` is an instruction — copy the
 * archive again. `unknown` is an admission — the published address could not be
 * established, so nothing is being claimed either way. A member who is merely
 * offline must never be told their copy is stale, and a check that quietly
 * guessed `in-sync` when it could not reach BIC would recreate the exact silent
 * failure this app exists to end.
 *
 * Never throws for a failure of any kind: an unreachable resolver, an
 * unreachable node and an unreadable note each narrow what can be said, and the
 * sentence in `detail` says which. Throws an `Error` with
 * `name === 'AbortError'` only if `signal` is aborted.
 */
export async function checkDrift(
  settings: PinningSettings,
  store: DriftStateStore,
  signal?: AbortSignal
): Promise<DriftStatus> {
  throwIfCancelled(signal)

  const published = await guard(
    () => resolvePublished(signal),
    { cid: null, known: false, via: 'built-in' } as Published,
    "BIC's published address could not be resolved"
  )

  const local = await guard(
    () =>
      findLocalMirror(settings, store, {
        ...(published.cid === null ? {} : { publishedCid: published.cid }),
        ...(signal === undefined ? {} : { signal })
      }),
    { cid: null, via: 'none' } as LocalMirror,
    'what this computer holds could not be established'
  )

  let verdict: DriftStatus['verdict']
  let detail: string

  if (local.cid === null) {
    // A local fact, and one we can state whether or not BIC could be reached.
    verdict = 'not-mirrored'
    detail = DETAIL.notMirrored
  } else if (published.cid === null) {
    verdict = 'unknown'
    detail = DETAIL.badBuild
  } else if (!published.known) {
    verdict = 'unknown'
    detail = DETAIL.unknown
  } else if (sameCid(local.cid, published.cid)) {
    verdict = 'in-sync'
    detail = DETAIL.inSync
  } else {
    verdict = 'behind'
    detail = DETAIL.behind
  }

  const status: DriftStatus = { verdict, detail, checkedAt: new Date().toISOString() }

  // Only ever reported when it is genuinely what BIC publishes. Showing the
  // built-in address here would invite the reader to compare two CIDs and draw
  // the conclusion this module just refused to draw.
  if (published.known && published.cid !== null) status.publishedCid = published.cid

  // The same content spelled two ways (a `Qm…` note against a `bafy…` record)
  // would look like a mismatch to anyone reading the panel, so when they match,
  // both are shown in the published spelling.
  if (local.cid !== null) {
    status.localCid = verdict === 'in-sync' && published.cid !== null ? published.cid : local.cid
  }
  if (local.mirroredAt !== undefined) status.lastMirroredAt = local.mirroredAt

  return status
}

/* -------------------------------------------------------------------------- */
/* the note                                                                    */
/* -------------------------------------------------------------------------- */

/** What the last successful mirror copied, and when. */
interface MirrorRecord {
  rootCid: string
  /** ISO-8601. */
  mirroredAt: string
  /** The pointer it came from, for diagnosing a check that looks wrong later. */
  pointer?: string
}

/**
 * Write down what was just mirrored, so drift can be detected next time.
 *
 * Call this after a mirror run has genuinely finished. It is the only dated
 * evidence in the system — a node can tell us *what* it holds but never *when* a
 * member copied it — and it is what lets the check work while the member's node
 * is switched off.
 *
 * Deliberately never throws. This is bookkeeping that runs immediately after the
 * longest, most valuable operation in the app, and turning "1.8 GB copied
 * successfully" into an error message because a small JSON file could not be
 * written would be an absurd trade. A failure is logged, and the check falls back
 * to asking the member's node, which is why that fallback exists.
 */
export async function recordMirrored(store: DriftStateStore, rootCid: string): Promise<void> {
  const cid = validCid(rootCid)
  if (cid === null) {
    note(`refusing to record "${String(rootCid)}" as a mirrored archive: it is not a valid address`)
    return
  }

  const record: MirrorRecord = { rootCid: cid, mirroredAt: new Date().toISOString() }
  const pointer = (BIC_ARCHIVE.pointer ?? '').trim()
  if (pointer !== '') record.pointer = pointer

  await writeRecord(store, record)
}

/** Read the note. A missing, corrupt or nonsensical note is simply no note. */
async function readRecord(store: DriftStateStore): Promise<MirrorRecord | null> {
  const path = recordPath(store)
  if (path === null) return null

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') {
      note(`the record of your last copy could not be read from ${path}`, err)
    }
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    note(`the record of your last copy at ${path} is not readable JSON; ignoring it`)
    return null
  }

  const value = parsed as { rootCid?: unknown; mirroredAt?: unknown; pointer?: unknown } | null
  const cid = typeof value?.rootCid === 'string' ? validCid(value.rootCid) : null
  if (cid === null) return null

  const at =
    typeof value?.mirroredAt === 'string' && !Number.isNaN(Date.parse(value.mirroredAt))
      ? value.mirroredAt
      : new Date(0).toISOString()

  const record: MirrorRecord = { rootCid: cid, mirroredAt: at }
  if (typeof value?.pointer === 'string' && value.pointer.trim() !== '') {
    record.pointer = value.pointer.trim()
  }
  return record
}

/**
 * Replace the note atomically: fill a temporary file, flush it to the physical
 * disk, then swap it into place with a single rename. A crash therefore leaves
 * either the old note or the new one, never half of each — a half-written note
 * would read as no note at all and quietly cost the member their mirror date.
 */
async function writeRecord(store: DriftStateStore, record: MirrorRecord): Promise<void> {
  const path = recordPath(store)
  if (path === null) {
    note('there is nowhere to record what was mirrored, so drift cannot be detected next time')
    return
  }

  const text = JSON.stringify({ version: RECORD_VERSION, ...record }, null, 2) + '\n'
  const tmpPath = `${path}.${process.pid}.${(writeCounter += 1)}.tmp`

  await serialize(async () => {
    try {
      await mkdir(dirname(path), { recursive: true })
      await rm(tmpPath, { force: true })

      const handle = await openFile(tmpPath, 'w', RECORD_FILE_MODE)
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }

      await rename(tmpPath, path)
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined)
      note(`what was mirrored could not be recorded in ${path}`, err)
    }
  })
}

/** Where the note lives: beside the app's own settings. */
function recordPath(store: DriftStateStore): string | null {
  try {
    if (typeof store === 'string') {
      const folder = store.trim()
      return folder === '' ? null : join(folder, RECORD_FILE)
    }
    // A getter, and one that throws outside the Electron app process.
    const settingsPath = store?.settingsPath
    if (typeof settingsPath !== 'string' || settingsPath.trim() === '') return null
    return join(dirname(settingsPath), RECORD_FILE)
  } catch (err) {
    note('the folder holding the app’s settings could not be located', err)
    return null
  }
}

/** Distinguishes concurrent temporary files within one process. */
let writeCounter = 0

/** Writes run one at a time; a failure must never poison the queue. */
let writes: Promise<void> = Promise.resolve()

async function serialize(task: () => Promise<void>): Promise<void> {
  const run = writes.then(task, task)
  writes = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The text as given if it is a real content address, otherwise null.
 *
 * The original spelling is kept rather than normalised, because that is the
 * string BIC published and the string a member will see quoted elsewhere.
 * Comparison is handled separately by {@link sameCid}, which is spelling-blind.
 */
function validCid(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    CID.parse(trimmed)
    return trimmed
  } catch {
    return null
  }
}

/**
 * Are these two strings the same content address?
 *
 * CIDv0 (`Qm…`) and CIDv1 (`bafy…`) are different spellings of the same
 * directory, and a node, a DNS record and this app's own note may each have
 * chosen differently. Comparing the strings would invent drift where there is
 * none, so both are put into their v1 form first.
 */
function sameCid(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false
  const left = canonicalCid(a)
  const right = canonicalCid(b)
  return left !== null && right !== null && left === right
}

/** The one spelling used for comparison only, never for display. */
function canonicalCid(text: string): string | null {
  try {
    return CID.parse(text.trim()).toV1().toString()
  } catch {
    return null
  }
}

/** The given spellings, minus nulls and minus anything already listed. */
function dedupe(values: Array<string | null>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (value === null) continue
    const key = canonicalCid(value) ?? value
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function stripPrefix(value: string, prefixes: readonly string[]): string {
  const text = value.trim()
  for (const prefix of prefixes) {
    if (text.toLowerCase().startsWith(prefix)) return text.slice(prefix.length).trim()
  }
  return text
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Is this a domain to look up in DNS, rather than a libp2p key? Keys are a
 * single label of base32/base58 with no dots, so a dot is the distinguishing
 * feature.
 */
function isDomainName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(name)
}

/** True when a reply announces more bytes than we are willing to read. */
function oversized(response: Response, limit: number): boolean {
  const declared = Number(response.headers.get('content-length') ?? '')
  return Number.isFinite(declared) && declared > limit
}

/** Release a connection without reading its body. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The socket is being thrown away regardless.
  }
}

/**
 * Run something that must not be able to break the caller. Cancellation is the
 * one exception: that is the member asking us to stop.
 */
async function guard<T>(work: () => Promise<T>, fallback: T, what: string): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (isCancellation(err)) throw err
    note(what, err)
    return fallback
  }
}

interface Deadline {
  signal: AbortSignal
  release(): void
}

/**
 * A budget for one network call, which also honours the member's own signal.
 * `release()` clears the timer and the listener, so a long-lived caller does not
 * accumulate either.
 */
function createDeadline(ms: number, outer: AbortSignal | undefined): Deadline {
  const controller = new AbortController()
  const stop = (): void => {
    controller.abort(abortError())
  }

  const timer = setTimeout(stop, ms)
  outer?.addEventListener('abort', stop, { once: true })
  if (outer?.aborted === true) stop()

  return {
    signal: controller.signal,
    release(): void {
      clearTimeout(timer)
      outer?.removeEventListener('abort', stop)
    }
  }
}

function abortError(): Error {
  const err = new Error('The check was stopped.')
  err.name = 'AbortError'
  return err
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

/** JWTs and bearer headers, in case something upstream ever echoes one back. */
const SECRET_PATTERN = /(eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,})|(\bbearer\s+\S+)/gi

/**
 * One line in the main-process log. Never shown to a member — everything they
 * see is composed from {@link DETAIL} — and scrubbed of anything token-shaped as
 * a matter of habit, even though nothing in this module handles a credential.
 */
function note(what: string, err?: unknown): void {
  const because = err === undefined ? '' : `: ${err instanceof Error ? err.message : String(err)}`
  console.warn(`[bic-archiver] ${what}${because}`.replace(SECRET_PATTERN, '[hidden]'))
}
