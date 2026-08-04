/**
 * Client for a local (or self-hosted) Kubo node's RPC API.
 *
 * Why this module is load-bearing rather than optional.
 *
 * Pinata's pin-by-CID asks Pinata to *find* content on the IPFS network. For the
 * 428 CIDs the May-2026 sweep found dead there is nothing to find, so that call
 * alone can never rescue them. The only sequence that works is:
 *
 *   1. import the archive's `.car` into a Kubo node (`dag/import`), which
 *      preserves the original CIDs exactly and makes that node a real provider;
 *   2. read the node's dialable addresses (`id`);
 *   3. ask Pinata to pin those CIDs, handing it those addresses as `hostNodes`;
 *   4. verify the pin actually landed.
 *
 * Steps 1 and 2 live here. Everything in this file therefore assumes the node
 * might not exist yet — a fresh Mac has no Kubo — and says so in words a
 * non-technical DAO member can act on, rather than surfacing a socket error.
 *
 * House rules honoured throughout:
 *   - Every request has a deadline. The long-running ones (`.car` upload,
 *     `pin/add`) use a *stall* deadline — give up when nothing has moved for a
 *     while — because a 1.8 GB import legitimately takes minutes and a flat
 *     timeout would either cut off honest work or wait forever on a wedged node.
 *   - The 1.8 GB case never lands in memory. That one request uses `node:http`
 *     rather than `fetch`, for a measured reason recorded at {@link postCar}.
 *   - Kubo's RPC is POST-only and takes its arguments as query parameters; a GET
 *     answers 405.
 *   - Nothing credential-shaped ever reaches a returned message. If the member
 *     put a user name and password in the node address, it becomes an
 *     `Authorization` header and is stripped from every string we build.
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers'

import { CID } from 'multiformats/cid'

import { KUBO_RPC } from '../../shared/pinning.js'
import type { PinResult, PinState, PinTargetStatus } from '../../shared/pinning.js'

/* -------------------------------------------------------------------------- */
/* public types                                                                */
/* -------------------------------------------------------------------------- */

/** Options for {@link importCarToKubo}. */
export interface ImportCarOptions {
  /**
   * Pin the CAR's root CIDs so the node keeps them. Defaults to **true** —
   * an unpinned import is deleted the next time the node garbage-collects,
   * which is exactly how content goes missing in the first place.
   */
  pinRoots?: boolean
  /** Cancels the import; the upload is torn down and the file handle closed. */
  signal?: AbortSignal
}

/** What one `.car` import put into the node. */
export interface ImportCarResult {
  /**
   * Root CIDs named by the CAR, as strings. May be empty for a rootless CAR:
   * the blocks still land, but there is nothing for the node to pin, so callers
   * that need the content kept should check this before relying on it.
   */
  roots: string[]
  /** Blocks the node reports having taken in. */
  blocks: number
}

/** Options for {@link pinCid}. */
export interface PinCidOptions {
  /** Pin the whole DAG under the CID. Defaults to true, as Kubo's own does. */
  recursive?: boolean
  /** Human-readable label stored with the pin, e.g. the NFT's name. */
  name?: string
  signal?: AbortSignal
}

/** Disk usage reported by the node. */
export interface RepoStats {
  /** Bytes the node's repository occupies on disk. */
  repoSize: number
  /** Number of blocks the node is storing. */
  numObjects: number
}

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

const USER_AGENT = 'bic-archiver/0.1 (kubo rpc)'

/** A local node answers `id` instantly; anything slower is a sick node. */
const ID_TIMEOUT_MS = 10_000

/**
 * `pin/add` has two very different shapes. When the node already holds the
 * content — the normal case, straight after an import — it walks local blocks
 * and finishes in seconds. When it does *not*, Kubo goes looking on the network
 * and, for the dead CIDs this app exists to rescue, looks essentially forever.
 *
 * So the request asks for progress reports and is governed by a stall deadline:
 * as long as the node is getting somewhere we wait, and when it stops getting
 * anywhere we stop, instead of holding the app hostage to a hopeless search.
 */
const PIN_ADD_TIMEOUT_MS = 10 * 60_000
const PIN_ADD_IDLE_MS = 2 * 60_000

/** `pin/ls <cid>` may search every recursive pin for an indirect match. */
const PIN_LS_ONE_TIMEOUT_MS = 60_000

/** Listing every pin (including indirect) walks each pinned DAG. */
const PIN_LS_ALL_TIMEOUT_MS = 30 * 60_000
const PIN_LS_ALL_IDLE_MS = 2 * 60_000

/** `repo/stat` counts blocks, so it is not instant on a big repository. */
const REPO_STAT_TIMEOUT_MS = 60_000

/** Dialling a peer either works quickly or is not going to work. */
const SWARM_CONNECT_TIMEOUT_MS = 30_000

/**
 * The `.car` upload is governed by a stall deadline, not a flat one: 1.8 GB over
 * a loopback socket is fast, but the node still has to index every block, and a
 * flat timeout would either cut off honest work or wait forever on a wedged
 * node. The total budget is a last-resort backstop.
 */
const IMPORT_IDLE_TIMEOUT_MS = 5 * 60_000
const IMPORT_TOTAL_TIMEOUT_MS = 6 * 60 * 60_000

/** Bytes read off disk per upload chunk. Bounds the memory the upload uses. */
const UPLOAD_CHUNK_BYTES = 1024 * 1024

/** Ceilings on how much of a reply we will buffer. */
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const MAX_NDJSON_BYTES = 8 * 1024 * 1024
/** A pin list is one line per pin; 256 MiB is millions of pins. */
const MAX_PIN_LIST_BYTES = 256 * 1024 * 1024

/** Most addresses Pinata is ever handed as `hostNodes`. */
const MAX_HOST_ADDRS = 20

/** dag-pb codec and sha2-256 multihash codes, for CIDv0 conversion. */
const CODEC_DAG_PB = 0x70
const MH_SHA2_256 = 0x12

/* -------------------------------------------------------------------------- */
/* public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ask whether an IPFS node is running at `apiUrl`, and if so where the outside
 * world can reach it.
 *
 * On success the returned `multiaddrs` are filtered down to addresses a remote
 * pinning service could actually dial: loopback is always dropped, and private
 * / LAN ranges are dropped too **unless nothing else is left**. When only
 * private or loopback addresses exist the node is still reported as available —
 * importing and pinning locally work fine — but `detail` carries a plain
 * explanation that Pinata will not be able to fetch from it, because that is the
 * case where a member would otherwise be left wondering why a pin never lands.
 *
 * Never throws for an unreachable or unhealthy node; the failure is described in
 * `detail`. Throws an `Error` with `name === 'AbortError'` only if `signal` is
 * aborted.
 */
export async function detectKubo(apiUrl: string, signal?: AbortSignal): Promise<PinTargetStatus> {
  let endpoint: Endpoint
  try {
    endpoint = parseEndpoint(apiUrl)
  } catch (err) {
    return { target: 'kubo', available: false, detail: plainMessage(err) }
  }

  const deadline = createDeadline(ID_TIMEOUT_MS, undefined, signal)
  try {
    const response = await post(endpoint, KUBO_RPC.id, {}, deadline)
    await assertOk(response, endpoint, deadline)
    const body = await readJsonObject(response, endpoint, deadline, MAX_JSON_BYTES)

    const peerId = typeof body['ID'] === 'string' ? body['ID'].trim() : ''
    if (peerId === '') {
      throw new KuboError(notRpcMessage(endpoint), 'not-rpc')
    }

    const announced = Array.isArray(body['Addresses'])
      ? body['Addresses'].filter((entry): entry is string => typeof entry === 'string')
      : []
    const selection = selectDialableAddrs(announced, peerId)

    const status: PinTargetStatus = {
      target: 'kubo',
      available: true,
      peerId,
      multiaddrs: selection.addrs
    }
    if (selection.note !== undefined) {
      status.detail = selection.note
    }
    return status
  } catch (err) {
    if (isCancellation(err)) throw err
    return { target: 'kubo', available: false, detail: plainMessage(err) }
  } finally {
    deadline.release()
  }
}

/**
 * Stream a `.car` file into the node with `dag/import`, preserving every CID in
 * it exactly, and pin its roots so the node keeps them.
 *
 * This is the step that turns a backup file into a live provider: after it, the
 * node genuinely serves those CIDs to the network, which is what makes a Pinata
 * `hostNodes` fetch possible for content nobody else has.
 *
 * The file is never read into memory — it is streamed off disk a megabyte at a
 * time — so a multi-gigabyte archive is the expected case rather than a risk.
 *
 * @throws A plain-English `Error` when the file cannot be read, the node refuses
 * the import, or the blocks land but cannot be pinned (which matters: unpinned
 * blocks are deleted at the next garbage collection).
 * @throws An `Error` with `name === 'AbortError'` if `opts.signal` is aborted.
 */
export async function importCarToKubo(
  apiUrl: string,
  carPath: string,
  opts: ImportCarOptions = {}
): Promise<ImportCarResult> {
  const endpoint = parseEndpoint(apiUrl)
  const pinRoots = opts.pinRoots ?? true
  const label = basename(carPath)

  let size: number
  try {
    const info = await stat(carPath)
    if (!info.isFile()) {
      throw new KuboError(`"${label}" is a folder, not a .car backup file.`, 'config')
    }
    size = info.size
  } catch (err) {
    if (err instanceof KuboError) throw err
    throw new KuboError(describeFileError(err, label), 'config')
  }

  if (size === 0) {
    throw new KuboError(`"${label}" is empty, so there is nothing to import.`, 'config')
  }

  const deadline = createDeadline(IMPORT_TOTAL_TIMEOUT_MS, IMPORT_IDLE_TIMEOUT_MS, opts.signal)

  let upload: CarUpload
  try {
    upload = await postCar(
      endpoint,
      KUBO_RPC.dagImport,
      { 'pin-roots': String(pinRoots), stats: 'true', silent: 'false' },
      carPath,
      size,
      deadline
    )
  } catch (err) {
    // The upload never got as far as the `finally` below, so retire its timers
    // here rather than leaving a six-hour one armed behind us.
    deadline.release()
    throw err
  }

  try {
    await assertOk(upload.reply, endpoint, deadline)

    const roots: string[] = []
    const pinFailures: string[] = []
    let blocks = 0

    for await (const entry of ndjson(upload.reply, endpoint, deadline, MAX_NDJSON_BYTES)) {
      const failure = streamErrorMessage(entry)
      if (failure !== undefined) {
        throw new KuboError(importRejectedMessage(label, failure), 'rejected', failure)
      }

      const root = entry['Root']
      if (isRecord(root)) {
        const cid = cidFromJson(root['Cid'])
        if (cid !== undefined && !roots.includes(cid)) {
          roots.push(cid)
        }
        const pinError = root['PinErrorMsg']
        if (typeof pinError === 'string' && pinError.trim() !== '') {
          pinFailures.push(`${cid ?? 'one root'} — ${redact(pinError.trim())}`)
        }
      }

      const stats = entry['Stats']
      if (isRecord(stats)) {
        const count = numberFrom(stats['BlockCount'])
        if (count > 0) blocks = count
      }
    }

    const readFailure = upload.fileError()
    if (readFailure !== undefined) {
      throw new KuboError(describeFileError(readFailure, label), 'config')
    }
    if (pinFailures.length > 0) {
      throw new KuboError(pinAfterImportMessage(label, pinFailures), 'rejected')
    }

    return { roots, blocks }
  } catch (err) {
    // A disk read failure surfaces as an opaque dropped-socket error; the real
    // cause is the one worth putting in front of a member.
    const readFailure = upload.fileError()
    if (readFailure !== undefined && !isCancellation(err) && !(err instanceof KuboError)) {
      throw new KuboError(describeFileError(readFailure, label), 'config')
    }
    throw err
  } finally {
    upload.dispose()
    deadline.release()
  }
}

/**
 * Pin one CID on the node, so it is kept and served rather than garbage
 * collected.
 *
 * The content must already be in the node's repository (normally because
 * {@link importCarToKubo} put it there). Asking a node to pin a CID it does not
 * hold makes it search the network, which is slow and — for the dead CIDs this
 * app exists to rescue — futile; that shows up here as a timeout with a plain
 * explanation rather than an exception.
 *
 * Never throws for a pinning failure: the outcome is the returned
 * {@link PinResult}. Throws an `Error` with `name === 'AbortError'` only if
 * `opts.signal` is aborted.
 */
export async function pinCid(
  apiUrl: string,
  cid: string,
  opts: PinCidOptions = {}
): Promise<PinResult> {
  const wanted = cid.trim()
  if (wanted === '') {
    return {
      cid,
      target: 'kubo',
      state: 'failed',
      error: 'No content address was given, so there is nothing to pin.'
    }
  }

  let endpoint: Endpoint
  try {
    endpoint = parseEndpoint(apiUrl)
  } catch (err) {
    return { cid: wanted, target: 'kubo', state: 'failed', error: plainMessage(err) }
  }

  const recursive = opts.recursive ?? true
  const name = opts.name?.trim() ?? ''
  const deadline = createDeadline(PIN_ADD_TIMEOUT_MS, PIN_ADD_IDLE_MS, opts.signal)

  try {
    const params: Record<string, string> = {
      arg: wanted,
      recursive: String(recursive),
      progress: 'true'
    }
    if (name !== '') params['name'] = name

    try {
      await pinAddOnce(endpoint, params, deadline)
    } catch (err) {
      // Pin names arrived in a later Kubo release. An older node rejects the
      // option outright, and losing the label is much better than losing the pin.
      if (name !== '' && isUnknownOption(err, 'name')) {
        delete params['name']
        await pinAddOnce(endpoint, params, deadline)
      } else {
        throw err
      }
    }

    return { cid: wanted, target: 'kubo', state: 'pinned' }
  } catch (err) {
    if (isCancellation(err)) throw err

    // A stall here almost always means one thing: the node does not hold this
    // content and went looking for it on the network. Saying so is far more
    // useful than "timed out", because the fix is a different action entirely.
    if (err instanceof KuboError && err.kind === 'timeout') {
      return {
        cid: wanted,
        target: 'kubo',
        state: 'failed',
        error:
          'Your IPFS node does not have this content, and searching the network for it got nowhere. ' +
          'Import the archive into the node first — that is what makes the node able to keep and share it. ' +
          'Content that no longer exists anywhere on the network can only be restored from a backup file.'
      }
    }

    return { cid: wanted, target: 'kubo', state: 'failed', error: plainMessage(err) }
  } finally {
    deadline.release()
  }
}

/**
 * Is this one CID pinned on the node?
 *
 * Kubo reports "not pinned" as an *error*, which is a fact rather than a
 * failure, so it is translated into `'not-pinned'`. Anything that leaves the
 * question genuinely unanswered — node down, timeout, unexpected reply —
 * returns `'unknown'`, never `'not-pinned'`: telling a member their rescued
 * files are unpinned when we simply could not ask would push them into
 * re-pinning work they do not need.
 *
 * For more than a handful of CIDs use {@link listPins} instead; this makes one
 * request per CID and may search every pinned DAG for an indirect match.
 *
 * Throws an `Error` with `name === 'AbortError'` only if `signal` is aborted.
 */
export async function isPinned(
  apiUrl: string,
  cid: string,
  signal?: AbortSignal
): Promise<PinState> {
  const wanted = cid.trim()
  if (wanted === '') return 'unknown'

  let endpoint: Endpoint
  try {
    endpoint = parseEndpoint(apiUrl)
  } catch {
    return 'unknown'
  }

  const deadline = createDeadline(PIN_LS_ONE_TIMEOUT_MS, undefined, signal)
  try {
    const response = await post(endpoint, KUBO_RPC.pinLs, { arg: wanted }, deadline)
    await assertOk(response, endpoint, deadline)
    const body = await readJsonObject(response, endpoint, deadline, MAX_JSON_BYTES)

    const keys = body['Keys']
    if (isRecord(keys)) {
      return Object.keys(keys).length > 0 ? 'pinned' : 'not-pinned'
    }
    // Streaming shape, or a node that answered differently: a 200 from `pin/ls`
    // with an argument means the node found the pin.
    if (typeof body['Type'] === 'string' || typeof body['Cid'] === 'string') {
      return 'pinned'
    }
    return 'unknown'
  } catch (err) {
    if (isCancellation(err)) throw err
    if (err instanceof KuboError && NOT_PINNED.test(err.detail ?? '')) {
      return 'not-pinned'
    }
    return 'unknown'
  } finally {
    deadline.release()
  }
}

/**
 * Every CID the node is keeping, in one request.
 *
 * This exists so the Assets view can colour thousands of rows without thousands
 * of round-trips. It includes *indirect* pins — the files inside a recursively
 * pinned folder — which is the answer that matters here: after importing an
 * archive only the root is pinned explicitly, yet all ten thousand assets under
 * it are genuinely being kept, and reporting them as unpinned would send a
 * member off to re-pin content that is already safe.
 *
 * CIDs are added in every spelling the node might have used *and* their v0/v1
 * equivalents, so a plain `set.has(cid)` works whether the archive recorded
 * `Qm…` or `bafy…`.
 *
 * @throws A plain-English `Error` if the list cannot be obtained. It never
 * returns a partial or empty set on failure, because a caller cannot tell that
 * apart from "nothing is pinned" — and that mistake is the expensive one.
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function listPins(apiUrl: string, signal?: AbortSignal): Promise<Set<string>> {
  const endpoint = parseEndpoint(apiUrl)
  const deadline = createDeadline(PIN_LS_ALL_TIMEOUT_MS, PIN_LS_ALL_IDLE_MS, signal)

  try {
    const response = await post(
      endpoint,
      KUBO_RPC.pinLs,
      { type: 'all', stream: 'true' },
      deadline
    )
    await assertOk(response, endpoint, deadline)

    const pins = new Set<string>()
    for await (const entry of ndjson(response, endpoint, deadline, MAX_PIN_LIST_BYTES)) {
      const failure = streamErrorMessage(entry)
      if (failure !== undefined) {
        throw new KuboError(
          `Your IPFS node could not finish listing what it is keeping: ${failure}`,
          'rejected',
          failure
        )
      }
      collectPins(entry, pins)
    }
    return pins
  } finally {
    deadline.release()
  }
}

/**
 * How much disk the node's repository is using, and how many blocks it holds.
 *
 * Worth showing before an import: a member about to add 1.8 GB to a node with
 * 200 MB free deserves to know beforehand rather than half way through.
 *
 * @throws A plain-English `Error` when the node cannot be asked.
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function repoStat(apiUrl: string, signal?: AbortSignal): Promise<RepoStats> {
  const endpoint = parseEndpoint(apiUrl)
  const deadline = createDeadline(REPO_STAT_TIMEOUT_MS, undefined, signal)

  try {
    const response = await post(endpoint, KUBO_RPC.repoStat, {}, deadline)
    await assertOk(response, endpoint, deadline)
    const body = await readJsonObject(response, endpoint, deadline, MAX_JSON_BYTES)
    return {
      repoSize: numberFrom(body['RepoSize']),
      numObjects: numberFrom(body['NumObjects'])
    }
  } finally {
    deadline.release()
  }
}

/**
 * Ask the node to open a connection to another peer.
 *
 * Used to give a pinning service a head start: dialling Pinata's peer from our
 * side first means the fetch does not depend on Pinata being able to reach us
 * through a home router, which is the usual reason a `hostNodes` pin never
 * completes.
 *
 * Returns `false` — rather than throwing — for every failure, since "we could
 * not reach that peer" is a normal outcome and the caller's next move is the
 * same either way. Throws an `Error` with `name === 'AbortError'` if `signal` is
 * aborted.
 */
export async function connectTo(
  apiUrl: string,
  multiaddr: string,
  signal?: AbortSignal
): Promise<boolean> {
  const addr = multiaddr.trim()
  if (addr === '') return false

  let endpoint: Endpoint
  try {
    endpoint = parseEndpoint(apiUrl)
  } catch {
    return false
  }

  const deadline = createDeadline(SWARM_CONNECT_TIMEOUT_MS, undefined, signal)
  try {
    const response = await post(endpoint, KUBO_RPC.swarmConnect, { arg: addr }, deadline)
    await assertOk(response, endpoint, deadline)
    const body = await readJsonObject(response, endpoint, deadline, MAX_JSON_BYTES)

    const strings = body['Strings']
    if (Array.isArray(strings)) {
      return strings.some((line) => typeof line === 'string' && /success/i.test(line))
    }
    // A 200 with nothing to say still means the node did not object.
    return true
  } catch (err) {
    if (isCancellation(err)) throw err
    return false
  } finally {
    deadline.release()
  }
}

/* -------------------------------------------------------------------------- */
/* endpoint parsing                                                            */
/* -------------------------------------------------------------------------- */

interface Endpoint {
  /** Absolute base URL, credentials removed, no trailing slash. */
  readonly base: string
  /** Host (and port) only — the one form safe to put in a message. */
  readonly label: string
  /** True when the node is on this machine, which changes the advice we give. */
  readonly local: boolean
  /** `Authorization` header value derived from any user:password in the URL. */
  readonly auth?: string
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/**
 * Normalise whatever is in Settings into something we can build requests from.
 *
 * A missing scheme is filled in (members type `127.0.0.1:5001`), a trailing
 * slash is dropped, a sub-path is preserved so a node behind a reverse proxy
 * works, and any `user:password@` is lifted out into an `Authorization` header
 * so it can never reappear in a URL we print.
 */
function parseEndpoint(apiUrl: string): Endpoint {
  const raw = typeof apiUrl === 'string' ? apiUrl.trim() : ''
  if (raw === '') {
    throw new KuboError(
      'No address is set for your IPFS node. The usual one is http://127.0.0.1:5001.',
      'config'
    )
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new KuboError(
      `"${redact(raw)}" is not a valid address for an IPFS node. The usual one is http://127.0.0.1:5001.`,
      'config'
    )
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KuboError(
      `An IPFS node address must start with http:// or https://. The usual one is http://127.0.0.1:5001.`,
      'config'
    )
  }

  let auth: string | undefined
  if (url.username !== '' || url.password !== '') {
    const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    auth = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`
    url.username = ''
    url.password = ''
  }

  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  const base = `${url.protocol}//${url.host}${path}`
  const endpoint: Endpoint = {
    base,
    label: url.host,
    local: LOCAL_HOSTS.has(url.hostname.toLowerCase())
  }
  return auth === undefined ? endpoint : { ...endpoint, auth }
}

function buildUrl(endpoint: Endpoint, path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString()
  return query === '' ? `${endpoint.base}${path}` : `${endpoint.base}${path}?${query}`
}

/* -------------------------------------------------------------------------- */
/* transport                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The parts of a reply the helpers below need.
 *
 * A `fetch` `Response` satisfies this as-is; so does the `node:http` reply the
 * `.car` upload produces. Sharing one shape means status handling, size limits
 * and newline-delimited parsing are written once and behave identically on both
 * transports.
 */
interface Reply {
  readonly status: number
  readonly ok: boolean
  readonly body: ReadableStream<Uint8Array> | null
  /** Present on a `fetch` `Response`; absent on the upload reply. */
  text?: () => Promise<string>
}

interface Deadline {
  /** Pass to `fetch`. Fires on our timers or on the caller's signal. */
  readonly signal: AbortSignal
  /** Which of our own deadlines fired, if any. */
  expired(): 'total' | 'idle' | undefined
  /** Budget, in ms, of whichever deadline fired. */
  budgetMs(): number
  /** True when the *caller* cancelled, as opposed to us timing out. */
  cancelled(): boolean
  /** Report progress; restarts the stall clock. */
  touch(): void
  /** Always call in a `finally`. */
  release(): void
}

/**
 * A total budget plus an optional stall budget, on one signal.
 *
 * The stall budget is what makes a multi-gigabyte upload safe to time: it asks
 * "has anything moved recently?" rather than "has this finished yet?", so honest
 * slow work is never cut off while a wedged node still gets abandoned.
 */
function createDeadline(
  totalMs: number,
  idleMs: number | undefined,
  outer?: AbortSignal
): Deadline {
  const controller = new AbortController()
  let expiry: 'total' | 'idle' | undefined
  let budget = totalMs
  let cancelled = outer?.aborted === true
  let released = false

  const totalTimer = setTimer(() => {
    if (expiry === undefined && !cancelled) {
      expiry = 'total'
      budget = totalMs
    }
    controller.abort()
  }, totalMs)
  totalTimer.unref()

  let idleTimer: ReturnType<typeof setTimer> | undefined

  const armIdle = (): void => {
    if (idleMs === undefined || released) return
    if (idleTimer !== undefined) clearTimer(idleTimer)
    idleTimer = setTimer(() => {
      if (expiry === undefined && !cancelled) {
        expiry = 'idle'
        budget = idleMs
      }
      controller.abort()
    }, idleMs)
    idleTimer.unref()
  }

  const onOuterAbort = (): void => {
    cancelled = true
    controller.abort()
  }

  if (outer !== undefined) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }

  armIdle()

  return {
    signal: controller.signal,
    expired: () => expiry,
    budgetMs: () => budget,
    cancelled: () => cancelled,
    touch: armIdle,
    release: () => {
      released = true
      clearTimer(totalTimer)
      if (idleTimer !== undefined) clearTimer(idleTimer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}

/**
 * One bodiless POST to the Kubo RPC — which is every command except the `.car`
 * upload, since Kubo takes its arguments as query parameters. Never checks the
 * status; see {@link assertOk}.
 */
async function post(
  endpoint: Endpoint,
  path: string,
  params: Record<string, string>,
  deadline: Deadline
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT
  }
  if (endpoint.auth !== undefined) headers.authorization = endpoint.auth

  try {
    return await fetch(buildUrl(endpoint, path, params), {
      method: 'POST',
      headers,
      signal: deadline.signal
    })
  } catch (err) {
    throw transportError(err, endpoint, deadline)
  }
}

/** Turn a non-2xx reply into the clearest sentence we can manage. */
async function assertOk(
  response: Reply,
  endpoint: Endpoint,
  deadline: Deadline
): Promise<void> {
  if (response.ok) return

  const raw = await readBoundedText(response, endpoint, deadline, MAX_ERROR_BYTES).catch(() => '')
  const detail = extractKuboMessage(raw)
  const status = response.status

  if (status === 401 || status === 403 || status === 407) {
    throw new KuboError(authMessage(endpoint), 'auth', detail)
  }
  if (status === 404 || status === 405 || status === 501) {
    throw new KuboError(notRpcMessage(endpoint), 'not-rpc', detail)
  }
  if (status === 413) {
    throw new KuboError(
      `Your IPFS node at ${endpoint.label} rejected the upload as too large. If it is behind a proxy, raise that proxy's upload size limit.`,
      'rejected',
      detail
    )
  }
  if (status >= 500) {
    throw new KuboError(
      detail === undefined
        ? `Your IPFS node at ${endpoint.label} hit a problem and could not complete the request (error ${status}). Check the terminal window running 'ipfs daemon' for details.`
        : `Your IPFS node could not complete the request: ${detail}`,
      'rejected',
      detail
    )
  }
  throw new KuboError(
    detail === undefined
      ? `Your IPFS node at ${endpoint.label} refused the request (error ${status}).`
      : `Your IPFS node refused the request: ${detail}`,
    'rejected',
    detail
  )
}

/** Read a whole reply as one JSON object. */
async function readJsonObject(
  response: Reply,
  endpoint: Endpoint,
  deadline: Deadline,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const text = await readBoundedText(response, endpoint, deadline, maxBytes)
  const trimmed = text.trim()
  if (trimmed === '') {
    throw new KuboError(notRpcMessage(endpoint), 'not-rpc')
  }

  // Some commands answer with newline-delimited JSON even for a single result.
  const firstLine = trimmed.split('\n', 1)[0] ?? trimmed
  const parsed = tryParseObject(trimmed) ?? tryParseObject(firstLine)
  if (parsed === undefined) {
    throw new KuboError(notRpcMessage(endpoint), 'not-rpc')
  }
  return parsed
}

/**
 * Iterate a newline-delimited JSON reply, yielding one object per line.
 *
 * Kubo streams `dag/import` and `pin/ls` this way, and it also reports mid-flight
 * failures as a line rather than an HTTP status — so a caller must inspect every
 * line for an error object, not just trust the 200.
 */
async function* ndjson(
  response: Reply,
  endpoint: Endpoint,
  deadline: Deadline,
  maxBytes: number,
  /**
   * Whether arriving bytes count as progress for the stall deadline. True for
   * every command except `pin/add`, which emits a heartbeat on a timer whether
   * or not it is achieving anything — see {@link pinAddOnce}.
   */
  touchOnData = true
): AsyncGenerator<Record<string, unknown>> {
  const body = response.body
  if (body === null) {
    const text = await readBoundedText(response, endpoint, deadline, maxBytes)
    for (const line of text.split('\n')) {
      const parsed = tryParseObject(line)
      if (parsed !== undefined) yield parsed
    }
    return
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let total = 0

  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (err) {
        throw transportError(err, endpoint, deadline)
      }
      if (chunk.done) break

      const value = chunk.value
      if (value === undefined || value.byteLength === 0) continue

      if (touchOnData) deadline.touch()
      total += value.byteLength
      if (total > maxBytes) {
        throw new KuboError(oversizedReplyMessage(endpoint, maxBytes), 'rejected')
      }

      buffered += decoder.decode(value, { stream: true })

      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const parsed = tryParseObject(line)
        if (parsed !== undefined) yield parsed
        newline = buffered.indexOf('\n')
      }
    }

    buffered += decoder.decode()
    const parsed = tryParseObject(buffered)
    if (parsed !== undefined) yield parsed
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* the socket is going away regardless */
    }
  }
}

/** Read a reply as text, refusing to buffer more than `maxBytes`. */
async function readBoundedText(
  response: Reply,
  endpoint: Endpoint,
  deadline: Deadline,
  maxBytes: number
): Promise<string> {
  const body = response.body
  if (body === null) {
    try {
      return response.text === undefined ? '' : await response.text()
    } catch (err) {
      throw transportError(err, endpoint, deadline)
    }
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0

  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (err) {
        throw transportError(err, endpoint, deadline)
      }
      if (chunk.done) break

      const value = chunk.value
      if (value === undefined || value.byteLength === 0) continue

      deadline.touch()
      total += value.byteLength
      if (total > maxBytes) {
        throw new KuboError(oversizedReplyMessage(endpoint, maxBytes), 'rejected')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* nothing useful to do */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* streaming the .car upload                                                   */
/* -------------------------------------------------------------------------- */

const CRLF = '\r\n'

/** A `.car` upload in flight. */
interface CarUpload {
  /** The node's answer, ready to be read by the shared reply helpers. */
  reply: Reply
  /** Set when reading the file failed, so the real cause can be reported. */
  fileError(): unknown
  /** Closes the file handle and the socket. Safe to call more than once. */
  dispose(): void
}

/**
 * POST a `.car` file as `multipart/form-data`, streamed straight off disk.
 *
 * This one request deliberately uses `node:http` instead of `fetch`, and the
 * reason is measured rather than stylistic. Uploading the DAO's 1.8 GB archive
 * to a deliberately slow reader:
 *
 *   fetch, body as ReadableStream ....... 1800 MB of live buffers
 *   fetch, body as async generator ...... 1802 MB
 *   fetch, body as FormData + file Blob . 1800 MB
 *   node:http, same framing ................. 2 MB
 *
 * `fetch` does not propagate socket backpressure to the request body, so it
 * reads the entire file into memory no matter which body form it is handed.
 * Node's own client streams properly. For an archive this size that is the
 * difference between an import that works on an ordinary laptop and one that
 * exhausts its memory, so the plain HTTP client wins for this call alone —
 * every other request here has no body and stays on `fetch`.
 *
 * Each chunk actually written to the socket reports progress, which is what
 * keeps the stall deadline honest while the node has yet to say a word.
 */
async function postCar(
  endpoint: Endpoint,
  path: string,
  params: Record<string, string>,
  carPath: string,
  fileSize: number,
  deadline: Deadline
): Promise<CarUpload> {
  const boundary = `--------------------------bic${randomBytes(16).toString('hex')}`
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${escapeFilename(basename(carPath))}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`,
    'utf8'
  )
  const foot = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8')

  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    'content-type': `multipart/form-data; boundary=${boundary}`,
    // Exact length, so the node is never handed a chunked upload it has to
    // guess the end of.
    'content-length': String(head.length + fileSize + foot.length)
  }
  if (endpoint.auth !== undefined) headers.authorization = endpoint.auth

  const url = new URL(buildUrl(endpoint, path, params))
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const request = send(url, { method: 'POST', headers, signal: deadline.signal })

  const file = createReadStream(carPath, { highWaterMark: UPLOAD_CHUNK_BYTES })
  let fileError: unknown
  let answered = false

  const answer = new Promise<IncomingMessage>((resolve, reject) => {
    request.once('response', (message) => {
      answered = true
      resolve(message)
    })
    request.once('error', reject)
  })

  const upload = async (): Promise<void> => {
    await writeChunk(request, head)
    try {
      for await (const chunk of file as AsyncIterable<Buffer>) {
        // A proxy can reject an oversized upload before we finish sending it;
        // there is no point pushing another gigabyte at a closed door.
        if (answered) return
        deadline.touch()
        await writeChunk(request, chunk)
      }
    } catch (err) {
      fileError = err
      throw err
    }
    await new Promise<void>((resolve) => request.end(foot, () => resolve()))
  }

  const uploading = upload().catch((err: unknown) => {
    // Nothing further will be sent, so the node will never answer. Tear the
    // request down rather than let the wait below hang forever.
    if (!answered) {
      request.destroy(err instanceof Error ? err : new Error('upload stopped'))
    }
  })

  const dispose = (): void => {
    file.destroy()
    if (!request.destroyed) request.destroy()
  }

  let message: IncomingMessage
  try {
    message = await answer
  } catch (err) {
    await uploading
    dispose()
    if (fileError !== undefined) {
      throw new KuboError(describeFileError(fileError, basename(carPath)), 'config')
    }
    throw transportError(err, endpoint, deadline)
  }

  const status = message.statusCode ?? 0
  return {
    reply: {
      status,
      ok: status >= 200 && status < 300,
      body: Readable.toWeb(message) as ReadableStream<Uint8Array>
    },
    fileError: () => fileError,
    dispose
  }
}

/** Write one chunk, waiting for the socket to drain when it asks us to. */
function writeChunk(request: ClientRequest, chunk: Buffer): Promise<void> {
  if (request.write(chunk)) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const done = (err?: Error): void => {
      request.off('drain', onDrain)
      request.off('error', onError)
      request.off('close', onClose)
      if (err === undefined) resolve()
      else reject(err)
    }
    const onDrain = (): void => done()
    const onError = (err: Error): void => done(err)
    const onClose = (): void => done(new Error('The connection closed before the upload finished.'))

    request.once('drain', onDrain)
    request.once('error', onError)
    request.once('close', onClose)
  })
}

/**
 * Percent-encode a filename for a `Content-Disposition` header, matching what
 * the `ipfs` command-line client sends (Kubo unescapes it at the other end).
 */
function escapeFilename(name: string): string {
  const cleaned = name.replace(/[\r\n"\\]/g, '_')
  return encodeURIComponent(cleaned)
}

/* -------------------------------------------------------------------------- */
/* pin/add                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One `pin/add` attempt, draining the streamed reply.
 *
 * Kubo emits `{"Progress": n}` on a half-second timer for as long as the command
 * runs — even while it is fruitlessly searching the network for content nobody
 * has. Treating those heartbeats as progress would defeat the stall deadline
 * entirely, so the clock is restarted only when the counter actually moves.
 * That is the difference between "waited two minutes and explained the problem"
 * and "sat there for ten minutes saying nothing".
 */
async function pinAddOnce(
  endpoint: Endpoint,
  params: Record<string, string>,
  deadline: Deadline
): Promise<void> {
  const response = await post(endpoint, KUBO_RPC.pinAdd, params, deadline)
  await assertOk(response, endpoint, deadline)

  let furthest = -1

  for await (const entry of ndjson(response, endpoint, deadline, MAX_NDJSON_BYTES, false)) {
    const failure = streamErrorMessage(entry)
    if (failure !== undefined) {
      throw new KuboError(`Your IPFS node could not pin this: ${failure}`, 'rejected', failure)
    }

    const progress = entry['Progress']
    if (typeof progress === 'number' && progress > furthest) {
      furthest = progress
      deadline.touch()
    }
    if (Array.isArray(entry['Pins'])) {
      deadline.touch()
    }
  }
}

/** Did the node reject an option it has never heard of? */
function isUnknownOption(err: unknown, option: string): boolean {
  if (!(err instanceof KuboError)) return false
  const detail = err.detail ?? ''
  return /unknown option|unrecognized option|unrecognised option/i.test(detail) &&
    detail.includes(option)
}

/* -------------------------------------------------------------------------- */
/* reply shapes                                                                */
/* -------------------------------------------------------------------------- */

/** Kubo reports "this CID is not pinned" as an error; it is really an answer. */
const NOT_PINNED = /not pinned/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryParseObject(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (trimmed === '' || !trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** An error line inside an otherwise-200 streaming reply. */
function streamErrorMessage(entry: Record<string, unknown>): string | undefined {
  const message = entry['Message']
  if (typeof message !== 'string' || message.trim() === '') return undefined
  if (entry['Type'] === 'error' || 'Code' in entry) return redact(message.trim())
  return undefined
}

/** Kubo encodes a CID as `{"/": "bafy…"}`; older shapes used a bare string. */
function cidFromJson(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (isRecord(value)) {
    const slash = value['/']
    if (typeof slash === 'string' && slash.trim() !== '') return slash.trim()
  }
  return undefined
}

/** Add one `pin/ls` entry — either streaming or listing shape — to the set. */
function collectPins(entry: Record<string, unknown>, into: Set<string>): void {
  const streamed = entry['Cid']
  if (typeof streamed === 'string' && streamed.trim() !== '') {
    addCidForms(streamed.trim(), into)
  }

  const keys = entry['Keys']
  if (isRecord(keys)) {
    for (const key of Object.keys(keys)) {
      if (key.trim() !== '') addCidForms(key.trim(), into)
    }
  }
}

/**
 * Store a CID under every spelling a caller might look it up by.
 *
 * Nodes answer in whatever base they please — often CIDv0 `Qm…` — while an
 * archive may have recorded the CIDv1 `bafy…` form of the very same block. Both
 * go in, so `set.has(cid)` is right either way.
 */
function addCidForms(value: string, into: Set<string>): void {
  into.add(value)
  let parsed: CID
  try {
    parsed = CID.parse(value)
  } catch {
    return
  }

  try {
    into.add(parsed.toV1().toString())
  } catch {
    /* not convertible; the original spelling is already stored */
  }

  if (
    parsed.code === CODEC_DAG_PB &&
    parsed.multihash.code === MH_SHA2_256 &&
    parsed.multihash.digest.length === 32
  ) {
    try {
      into.add(parsed.toV0().toString())
    } catch {
      /* not convertible */
    }
  }
}

function numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.max(0, parsed)
  }
  return 0
}

/** Pull Kubo's own `Message` out of an error body, whole or line-delimited. */
function extractKuboMessage(raw: string): string | undefined {
  const text = raw.trim()
  if (text === '') return undefined

  const whole = tryParseObject(text)
  if (whole !== undefined) {
    const message = whole['Message']
    if (typeof message === 'string' && message.trim() !== '') return redact(message.trim())
  }

  for (const line of text.split('\n')) {
    const parsed = tryParseObject(line)
    if (parsed === undefined) continue
    const message = parsed['Message']
    if (typeof message === 'string' && message.trim() !== '') return redact(message.trim())
  }

  // A plain-text complaint from a proxy is still worth repeating; an HTML error
  // page is not, and would look like gibberish in the app.
  if (/^\s*</.test(text) || /<html/i.test(text)) return undefined
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine === '' ? undefined : redact(oneLine.slice(0, 300))
}

/* -------------------------------------------------------------------------- */
/* multiaddr selection                                                         */
/* -------------------------------------------------------------------------- */

type AddrClass = 'public' | 'private' | 'loopback' | 'unusable'

interface AddrSelection {
  addrs: string[]
  note?: string
}

/**
 * Reduce the node's announced addresses to ones a remote service could dial.
 *
 * Loopback is always dropped — handing Pinata `127.0.0.1` would point it at its
 * own machine. Private and link-local ranges are dropped too, unless they are
 * all that is left, in which case they are kept (they are still useful to a peer
 * on the same network) and the caller is told plainly that a public pinning
 * service will not be able to fetch from this node.
 */
function selectDialableAddrs(announced: readonly string[], peerId: string): AddrSelection {
  const seen = new Set<string>()
  const publicAddrs: string[] = []
  const privateAddrs: string[] = []
  let sawLoopback = false

  for (const entry of announced) {
    const addr = entry.trim()
    if (addr === '' || !addr.startsWith('/')) continue

    const kind = classifyMultiaddr(addr)
    if (kind === 'unusable') continue
    if (kind === 'loopback') {
      sawLoopback = true
      continue
    }

    const full = ensurePeerSuffix(addr, peerId)
    if (seen.has(full)) continue
    seen.add(full)
    ;(kind === 'public' ? publicAddrs : privateAddrs).push(full)
  }

  if (publicAddrs.length > 0) {
    return { addrs: sortAddrs(publicAddrs).slice(0, MAX_HOST_ADDRS) }
  }

  if (privateAddrs.length > 0) {
    const sorted = sortAddrs(privateAddrs)
    const example = hostOfMultiaddr(sorted[0] ?? '')
    return {
      addrs: sorted.slice(0, MAX_HOST_ADDRS),
      note:
        `Your IPFS node is only reachable on your local network${example === '' ? '' : ` (${example})`}. ` +
        'A pinning service on the internet cannot connect to it, so asking one to fetch your rescued files ' +
        'will not work until incoming connections on port 4001 reach this computer. ' +
        'Uploading those files to the pinning service directly works regardless.'
    }
  }

  return {
    addrs: [],
    note: sawLoopback
      ? 'Your IPFS node is only listening on this computer, so nothing on the internet can fetch from it. ' +
        'Keeping your own copy still works; asking a pinning service to fetch from this node will not, ' +
        'so those files need uploading to the service directly.'
      : 'Your IPFS node is running but has not announced any network addresses yet. ' +
        'Give it a minute after starting it, then check again.'
  }
}

function sortAddrs(addrs: string[]): string[] {
  return [...addrs].sort((a, b) => rankAddr(a) - rankAddr(b) || a.localeCompare(b))
}

/**
 * Lower is better. Direct beats relayed, ordinary transports beat exotic ones,
 * and IPv4 goes first because a pinning service is more certain to have it.
 */
function rankAddr(addr: string): number {
  let rank = addr.includes('/p2p-circuit') ? 20 : 0
  if (/\/quic-v1(\/|$)/.test(addr)) rank += 0
  else if (/\/tcp\//.test(addr)) rank += 1
  else if (/\/quic(\/|$)/.test(addr)) rank += 2
  else rank += 5
  if (!addr.startsWith('/ip4/') && !addr.startsWith('/dns4/')) rank += 5
  return rank
}

function classifyMultiaddr(addr: string): AddrClass {
  const parts = addr.split('/').filter((part) => part !== '')
  const proto = parts[0]
  const value = parts[1]
  if (proto === undefined || value === undefined) return 'unusable'

  switch (proto) {
    case 'ip4':
      return classifyIp4(value)
    case 'ip6':
      return classifyIp6(value)
    case 'dns':
    case 'dns4':
    case 'dns6':
    case 'dnsaddr': {
      const host = value.toLowerCase()
      return host === 'localhost' || host.endsWith('.localhost') ? 'loopback' : 'public'
    }
    default:
      return 'unusable'
  }
}

function classifyIp4(value: string): AddrClass {
  const octets = value.split('.')
  if (octets.length !== 4) return 'unusable'

  const numbers: number[] = []
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return 'unusable'
    const parsed = Number(octet)
    if (parsed > 255) return 'unusable'
    numbers.push(parsed)
  }

  const first = numbers[0] ?? 0
  const second = numbers[1] ?? 0

  if (first === 127) return 'loopback'
  if (first === 0) return 'unusable'
  if (first >= 224) return 'unusable' // multicast and reserved
  if (first === 10) return 'private'
  if (first === 172 && second >= 16 && second <= 31) return 'private'
  if (first === 192 && second === 168) return 'private'
  if (first === 169 && second === 254) return 'private' // link-local
  if (first === 100 && second >= 64 && second <= 127) return 'private' // carrier NAT
  return 'public'
}

function classifyIp6(value: string): AddrClass {
  const address = value.toLowerCase()
  if (address === '::1') return 'loopback'
  if (address === '::' || address === '') return 'unusable'

  if (address.startsWith('::ffff:')) {
    const mapped = address.slice('::ffff:'.length)
    return mapped.includes('.') ? classifyIp4(mapped) : 'unusable'
  }

  const head = address.split(':')[0] ?? ''
  if (head.length >= 2) {
    // fe80::/10 link-local, and the fc00::/7 unique-local range.
    if (/^fe[89ab]/.test(head)) return 'private'
    if (/^f[cd]/.test(head)) return 'private'
    if (/^ff/.test(head)) return 'unusable' // multicast
  }
  return 'public'
}

/** Pinata needs the peer id on the end of the address to know who to dial. */
function ensurePeerSuffix(addr: string, peerId: string): string {
  if (peerId === '') return addr
  const suffix = `/p2p/${peerId}`
  return addr.endsWith(suffix) ? addr : `${addr}${suffix}`
}

function hostOfMultiaddr(addr: string): string {
  const parts = addr.split('/').filter((part) => part !== '')
  return parts[1] ?? ''
}

/* -------------------------------------------------------------------------- */
/* errors — everything a DAO member reads comes from here                      */
/* -------------------------------------------------------------------------- */

type KuboFailure =
  | 'config'
  | 'refused'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'reset'
  | 'auth'
  | 'not-rpc'
  | 'rejected'
  | 'network'

/** An error whose `message` is already written for a non-technical reader. */
class KuboError extends Error {
  override readonly name = 'KuboError'

  constructor(
    message: string,
    readonly kind: KuboFailure,
    /** The node's own wording, kept for matching (e.g. "is not pinned"). */
    readonly detail?: string
  ) {
    super(message)
  }
}

function transportError(err: unknown, endpoint: Endpoint, deadline: Deadline): Error {
  if (deadline.cancelled()) return cancelledError()

  const expiry = deadline.expired()
  if (expiry !== undefined) {
    const seconds = Math.max(1, Math.round(deadline.budgetMs() / 1000))
    return new KuboError(
      expiry === 'idle'
        ? `Your IPFS node at ${endpoint.label} stopped responding part-way through — nothing moved for ${describeDuration(seconds)}, so the transfer was stopped. Check the terminal window running 'ipfs daemon', then try again.`
        : `Your IPFS node at ${endpoint.label} did not answer within ${describeDuration(seconds)}. It may still be starting up — wait a moment and try again.`,
      'timeout'
    )
  }

  switch (errorCode(err)) {
    case 'ECONNREFUSED':
      return new KuboError(refusedMessage(endpoint), 'refused')
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new KuboError(
        `The address ${endpoint.label} could not be found. Check the IPFS node address in Settings — the usual one is http://127.0.0.1:5001.`,
        'dns'
      )
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return new KuboError(
        `The connection to your IPFS node at ${endpoint.label} was dropped part-way through. If the node was busy or restarting, try again.`,
        'reset'
      )
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return new KuboError(
        `Your IPFS node at ${endpoint.label} did not answer in time. Check that it is running and not overloaded.`,
        'timeout'
      )
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return new KuboError(
        `The secure connection to ${endpoint.label} could not be trusted (its certificate did not check out). For a node on this computer use http://127.0.0.1:5001 rather than https.`,
        'tls'
      )
    default:
      break
  }

  if (isCancellation(err)) return cancelledError()

  const text = causeText(err)

  // `fetch` refuses a handful of port numbers outright (port 1, 25, 6000 and so
  // on) before it ever opens a socket, so this is what a typo in the address
  // looks like rather than a node problem.
  if (/bad port/i.test(text)) {
    return new KuboError(
      `${endpoint.label} is not a usable address — that port number is not one this app is allowed to connect to. An IPFS node normally lives at http://127.0.0.1:5001.`,
      'config'
    )
  }
  if (/ECONNREFUSED|connection refused/i.test(text)) {
    return new KuboError(refusedMessage(endpoint), 'refused')
  }

  return new KuboError(
    `Your IPFS node at ${endpoint.label} could not be reached. Check that it is running, then try again.`,
    'network'
  )
}

function refusedMessage(endpoint: Endpoint): string {
  if (endpoint.local) {
    return `No IPFS node is running on this computer. Install one with ${installHint()}, then run 'ipfs daemon'.`
  }
  return (
    `Nothing is accepting connections at ${endpoint.label}. ` +
    'If the IPFS node is on another machine, check that it is switched on, that it is running ' +
    "'ipfs daemon', and that its control port is reachable from here."
  )
}

function installHint(): string {
  switch (process.platform) {
    case 'darwin':
      return "'brew install kubo'"
    case 'win32':
      return 'the IPFS Desktop or Kubo installer from https://dist.ipfs.tech/#kubo'
    default:
      return "your package manager, or download Kubo from https://dist.ipfs.tech/#kubo"
  }
}

function authMessage(endpoint: Endpoint): string {
  return (
    `Your IPFS node at ${endpoint.label} refused this app access. ` +
    'If you set a user name and password on the node, put them in the address like ' +
    'http://name:password@127.0.0.1:5001. ' +
    'If you did not, the node is probably only willing to answer requests from its own machine — ' +
    'the simplest fix is to run this app on the same computer as the node.'
  )
}

function notRpcMessage(endpoint: Endpoint): string {
  return (
    `Something is running at ${endpoint.label}, but it is not an IPFS node's control port. ` +
    "Kubo's control port is normally http://127.0.0.1:5001 — port 8080 is the gateway and will not work here. " +
    'Check the address in Settings.'
  )
}

function importRejectedMessage(label: string, detail: string): string {
  if (/block.*too (large|big)|exceeds.*limit/i.test(detail)) {
    return (
      `Your IPFS node refused "${label}" because it contains a block larger than the node will accept. ` +
      'That usually means the backup was made with an unusual chunk size. ' +
      `The node said: ${detail}`
    )
  }
  if (/no space|disk full|ENOSPC/i.test(detail)) {
    return (
      `Your IPFS node ran out of disk space part-way through importing "${label}". ` +
      'Free some space (or point the node at a larger drive) and try again.'
    )
  }
  return `Your IPFS node could not import "${label}": ${detail}`
}

function pinAfterImportMessage(label: string, failures: readonly string[]): string {
  const list = failures.join('; ')
  return (
    `"${label}" was copied into your IPFS node, but the node could not mark it as kept (pinned), ` +
    'which means it will be deleted the next time the node tidies up. ' +
    `The node said: ${list}. ` +
    'Free up disk space and try again, or pin it by hand with "ipfs pin add".'
  )
}

function oversizedReplyMessage(endpoint: Endpoint, maxBytes: number): string {
  const mb = Math.round(maxBytes / (1024 * 1024))
  return (
    `Your IPFS node at ${endpoint.label} sent back more than ${mb} MB in reply, which is far more than expected. ` +
    'The reply was stopped rather than allowed to fill this computer\u2019s memory.'
  )
}

function describeFileError(err: unknown, label: string): string {
  switch (errorCode(err)) {
    case 'ENOENT':
      return `"${label}" could not be found. It may have been moved, renamed, or deleted.`
    case 'EACCES':
    case 'EPERM':
      return `This app is not allowed to read "${label}". Check the file's permissions, or move it somewhere like your Documents folder.`
    case 'EISDIR':
      return `"${label}" is a folder, not a .car backup file.`
    case 'EIO':
      return `"${label}" could not be read — the drive reported a read error. If it is on an external disk or a network share, copy it to this computer first.`
    case 'EBUSY':
      return `"${label}" is in use by another program. Close it and try again.`
    default:
      return `"${label}" could not be read from disk. If it is on an external drive or a cloud folder, make sure it is connected and fully downloaded.`
  }
}

function describeDuration(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

function cancelledError(): Error {
  const err = new Error('This was cancelled.')
  err.name = 'AbortError'
  return err
}

function isCancellation(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError')
  )
}

/**
 * Find the Node/undici error code buried inside a `fetch` failure.
 *
 * `fetch` reports everything as a bare `TypeError: fetch failed`; the useful
 * code sits one or more `cause` links down. When a host resolves to both an IPv6
 * and an IPv4 address — `localhost` always does — the cause is instead an
 * `AggregateError` holding one failure per address, so the `errors` array has to
 * be searched as well. Missing that turns the single most important message this
 * module produces ("no IPFS node is running — install one") into a shrug.
 */
function errorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>()

  const walk = (value: unknown, depth: number): string | undefined => {
    if (depth > 5 || !(value instanceof Error) || seen.has(value)) return undefined
    seen.add(value)

    const code = (value as { code?: unknown }).code
    if (typeof code === 'string') return code

    const nested = (value as { errors?: unknown }).errors
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        const found = walk(entry, depth + 1)
        if (found !== undefined) return found
      }
    }

    return walk((value as { cause?: unknown }).cause, depth + 1)
  }

  return walk(err, 0)
}

/** Collect the messages from an error and everything it wraps. */
function causeText(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()

  const walk = (value: unknown, depth: number): void => {
    if (depth > 5 || !(value instanceof Error) || seen.has(value)) return
    seen.add(value)
    parts.push(value.message)
    const nested = (value as { errors?: unknown }).errors
    if (Array.isArray(nested)) {
      for (const entry of nested) walk(entry, depth + 1)
    }
    walk((value as { cause?: unknown }).cause, depth + 1)
  }

  walk(err, 0)
  return parts.join(' | ')
}

/** A message safe to hand to the GUI, whatever was thrown. */
function plainMessage(err: unknown): string {
  if (err instanceof KuboError) return err.message
  if (err instanceof Error) return redact(err.message)
  return redact(String(err))
}

/**
 * Strip anything credential-shaped out of text before it can reach a screen or
 * a log.
 *
 * Deliberately narrow: it targets bearer tokens, basic-auth values and URL
 * credentials by *shape*, and leaves long base32/base58 runs alone, because
 * those are CIDs and mangling them would destroy the one identifier a member
 * needs in order to ask for help.
 */
function redact(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token hidden]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]')
    .replace(/\b(authorization|api[_-]?key|token|jwt|password)\s*[:=]\s*\S+/gi, '$1: [hidden]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+:[^/\s@]*@/gi, '$1[credentials hidden]@')
}
