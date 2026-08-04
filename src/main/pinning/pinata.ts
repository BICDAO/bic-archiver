/**
 * Pinata client.
 *
 * This module talks to one company's API, but the shape of it is dictated by a
 * measured fact about our own archive. Of the 10,762 CIDs in the DAO's May-2026
 * backup, 428 are gone from the public network — and they are not a random 428.
 * Content BIC rescued from Arweave or web2 died at 96% and 89%; native IPFS
 * content that other people also pin died at 0.7%. Content nobody pins dies, and
 * the content BIC rescues is precisely the content nobody else pins.
 *
 * That leads to the single most important thing to understand here:
 *
 *   **`pinByHash` asks Pinata to FIND content on the network.** For a dead CID
 *   there is nothing to find, so pin-by-CID on its own cannot rescue it. Pinata
 *   will search, fail, and eventually mark the job `expired`.
 *
 * The route that does work is to run a local Kubo node, import the backup into
 * it (which preserves the original CIDs exactly and makes that node a real
 * provider), and then pass that node's dialable multiaddrs to
 * {@link pinByCid} as `hostNodes`. Pinata then has somewhere to fetch from.
 * `hostNodes` is not a tuning knob; it is the mechanism.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. **The token never escapes.** It is only ever sent as an `Authorization`
 *      header, never in a URL, never logged, and every string this module
 *      returns has been through {@link redact} first. Pinata's own error bodies
 *      are redacted too, because we do not control what they echo back.
 *   2. **Verify, do not trust.** A queued pin is reported as `pinning`, never as
 *      `pinned`. Only Pinata's own pin list proves a pin landed.
 */

import {
  PINATA,
  type PinResult,
  type PinState,
  type PinTargetId,
  type PinTargetStatus
} from '../../shared/pinning.js'

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/** Options for {@link pinByCid}. */
export interface PinByCidOptions {
  /** Human label shown in the Pinata dashboard, e.g. the path in the archive. */
  name?: string
  /**
   * Multiaddrs of IPFS nodes that are serving this CID right now — normally the
   * member's own Kubo node, from `POST /api/v0/id`. Each should be a full
   * dialable address ending in `/p2p/<peer id>`. Without these, Pinata can only
   * pin content that somebody else is already providing.
   */
  hostNodes?: string[]
  signal?: AbortSignal
}

/** Options for {@link pinJobResult}. */
export interface PinJobLookupOptions {
  /**
   * The CID the job was for. Optional, but supplying it turns a walk through the
   * whole pin queue into a single filtered request.
   */
  cid?: string
  signal?: AbortSignal
}

/** Options for {@link listPinnedCids}. */
export interface ListPinnedOptions {
  /** Stop after collecting this many CIDs. Defaults to 20,000. */
  limit?: number
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const TARGET: PinTargetId = 'pinata'

/** Budget for one ordinary API call (auth check, pin request, list page). */
const API_TIMEOUT_MS = 30_000

/** Floor for an upload, before the size allowance is added. */
const UPLOAD_BASE_TIMEOUT_MS = 120_000

/** Bytes per second assumed when sizing an upload deadline — a slow home line. */
const ASSUMED_UPLOAD_BPS = 200 * 1024

/** Ceiling on one upload, so a stalled transfer cannot hang the app forever. */
const UPLOAD_MAX_TIMEOUT_MS = 30 * 60_000

/**
 * Attempts per request, including the first. Only 429 (rate limited) and 5xx
 * (Pinata's own trouble) are retried; a 401 will never become a 200.
 */
const MAX_ATTEMPTS = 4
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 30_000

/** Rows per page. Pinata caps both list endpoints at 1000. */
const PAGE_SIZE = 1000

/** Default ceiling on {@link listPinnedCids} — roughly twice our whole archive. */
const DEFAULT_PIN_LIST_LIMIT = 20_000

/** Pages of the pin queue to walk when no CID is available to filter by. */
const MAX_JOB_PAGES = 20

/** Hard cap on any response body we will buffer. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/** How much of Pinata's own error text we are willing to pass along. */
const MAX_REASON_CHARS = 300

/** Pinata rejects very long pin names; ours are archive paths, so clamp them. */
const MAX_PIN_NAME_CHARS = 240

/** Never hand Pinata more host addresses than it could sensibly try. */
const MAX_HOST_NODES = 20

const USER_AGENT = 'bic-archiver/0.1 (+pinata)'

// ---------------------------------------------------------------------------
// Redaction — applied to every string this module hands back
// ---------------------------------------------------------------------------

/**
 * Deliberately contains no whitespace. `BEARER_RE` below replaces everything up
 * to the next space, so a marker with a space in it would get half-eaten on a
 * second pass and produce nonsense like "Bearer [token hidden] hidden]".
 */
const REDACTED = '[token-hidden]'

/** `Bearer <anything>`, however it got into the text. */
const BEARER_RE = /\b(bearer\s+)\S+/gi

/** A JWT proper: base64url header starting `eyJ`, then payload and signature. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g

/**
 * A generic three-part dotted secret. Segments must be long enough that this
 * cannot swallow a hostname (`api.pinata.cloud`) or a filename (`a.tar.gz`),
 * and CIDs contain no dots at all, so they are never touched.
 */
const DOTTED_SECRET_RE = /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g

/** Credential-shaped query parameters, in case a URL is ever echoed at us. */
const TOKEN_PARAM_RE = /\b(access_token|api_key|apikey|jwt|token|secret)=([^&\s"']+)/gi

/**
 * Strip anything token-shaped out of `text`.
 *
 * Called on *every* error path before a string leaves this module. Passing the
 * live `token` is the strongest protection — an exact substring match catches a
 * credential no pattern would recognise — but the patterns still run on their
 * own so that text originating from Pinata is safe even when the token is not
 * to hand.
 */
function redact(text: string, token?: string): string {
  let out = text

  if (token !== undefined) {
    const raw = token.trim()
    // Below ~12 characters a "token" is more likely to be a stray word, and
    // blanking it would mangle a legitimate message.
    if (raw.length >= 12) {
      out = out.split(raw).join(REDACTED)
      for (const segment of raw.split('.')) {
        if (segment.length >= 16) {
          out = out.split(segment).join(REDACTED)
        }
      }
    }
  }

  out = out.replace(BEARER_RE, `$1${REDACTED}`)
  out = out.replace(JWT_RE, REDACTED)
  out = out.replace(DOTTED_SECRET_RE, REDACTED)
  out = out.replace(TOKEN_PARAM_RE, `$1=${REDACTED}`)

  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check that a Pinata token works, without changing anything.
 *
 * Never throws for a bad token or an unreachable API: a target that cannot be
 * used is a normal, reportable state, not an exception. The returned `detail` is
 * written for a non-technical member and never contains the token.
 *
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function testPinataAuth(
  token: string,
  signal?: AbortSignal
): Promise<PinTargetStatus> {
  const auth = normalizeToken(token)
  const problem = tokenProblem(auth)
  if (problem !== undefined) {
    return { target: TARGET, available: false, detail: problem }
  }

  const what = 'check your Pinata token'

  try {
    const reply = await pinataRequest(PINATA.testAuth, {
      method: 'GET',
      token: auth,
      what,
      ...(signal !== undefined ? { signal } : {})
    })

    if (reply.ok) {
      return { target: TARGET, available: true }
    }

    return {
      target: TARGET,
      available: false,
      detail: describeFailure(reply.status, reply.reason, what)
    }
  } catch (err) {
    if (isCancellation(err)) {
      throw err
    }
    return { target: TARGET, available: false, detail: plainMessage(err, auth) }
  }
}

/**
 * Ask Pinata to pin an existing CID.
 *
 * `opts.hostNodes` is the part that matters. Pinata's pin-by-CID *searches* the
 * network; for the 428 CIDs in our archive that nothing is providing any more,
 * the search cannot succeed and the job will end up `expired`. Passing the
 * multiaddrs of a local Kubo node that has imported the backup gives Pinata a
 * concrete place to fetch from, which is what makes reviving dead content
 * possible at all.
 *
 * Returns `pinning` (with a `requestId`) when Pinata queues the job — that is
 * the normal successful outcome, and it is deliberately not reported as
 * `pinned`. Poll {@link pinJobStatus} and confirm with {@link listPinnedCids}.
 *
 * Rate limiting (HTTP 429) is retried a few times with backoff. If it still will
 * not clear, this returns a `failed` result explaining that in one sentence,
 * rather than throwing — one throttled CID must not abort a run over thousands.
 *
 * @throws An `Error` with `name === 'AbortError'` if `opts.signal` is aborted.
 */
export async function pinByCid(
  token: string,
  cid: string,
  opts: PinByCidOptions = {}
): Promise<PinResult> {
  const auth = normalizeToken(token)
  const wanted = cid.trim()

  const problem = tokenProblem(auth)
  if (problem !== undefined) {
    return failed(wanted, problem)
  }
  if (wanted === '') {
    return failed(wanted, 'No content address was given, so there was nothing to pin.')
  }

  const body: Record<string, unknown> = { hashToPin: wanted }

  const name = (opts.name ?? '').trim()
  if (name !== '') {
    body.pinataMetadata = { name: name.slice(0, MAX_PIN_NAME_CHARS) }
  }

  // Anything Pinata could not possibly dial (loopback, unspecified) is dropped
  // here rather than risking a `bad_host_node` verdict on the whole request. If
  // that leaves nothing, we still send the request — Pinata may find the content
  // by itself, and if it cannot, the `expired` message tells the member exactly
  // what to do about it.
  const hostNodes = usableHostNodes(opts.hostNodes)
  if (hostNodes.length > 0) {
    body.pinataOptions = { hostNodes }
  }

  const what = 'ask Pinata to pin this content'
  let reply: PinataReply

  try {
    reply = await pinataRequest(PINATA.pinByHash, {
      method: 'POST',
      token: auth,
      what,
      headers: { 'content-type': 'application/json' },
      makeBody: () => JSON.stringify(body),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {})
    })
  } catch (err) {
    if (isCancellation(err)) {
      throw err
    }
    return failed(wanted, plainMessage(err, auth))
  }

  if (reply.ok) {
    const row = asRecord(reply.json)
    const requestId = firstString(row, ['id', 'requestId', 'request_id', 'ipfsPinJobId'])
    const rawStatus = firstString(row, ['status'])
    const mapped = rawStatus === undefined ? undefined : mapJobStatus(rawStatus)

    // Pinata occasionally answers "already done" straight away.
    if (mapped?.state === 'pinned') {
      return pinned(wanted, requestId)
    }
    if (mapped?.state === 'failed') {
      return failed(wanted, withRawStatus(auth, mapped.message, rawStatus), requestId)
    }

    return {
      cid: wanted,
      target: TARGET,
      state: 'pinning',
      ...(requestId !== undefined ? { requestId } : {})
    }
  }

  // Re-pinning something already on the account is a success, not an error; it
  // is exactly what happens when a member re-runs a rescue over the same rows.
  if (reply.status === 400 && /already pinned|duplicate/i.test(reply.reason ?? '')) {
    return pinned(wanted)
  }

  return failed(wanted, describeFailure(reply.status, reply.reason, what))
}

/**
 * Where a queued pin job has got to.
 *
 * Returns `unknown` — never `pinned` — when Pinata no longer lists the job. A
 * finished job simply drops out of the queue, so "not in the queue" is a hint to
 * confirm with {@link listPinnedCids}, not proof of anything. It also returns
 * `unknown` when we could not ask at all (bad token, network down), because not
 * knowing is different from not pinned.
 *
 * Use {@link pinJobResult} instead when you need the failure text, which is
 * where the important `expired` guidance lives.
 *
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function pinJobStatus(
  token: string,
  requestId: string,
  signal?: AbortSignal
): Promise<PinState> {
  const result = await pinJobResult(token, requestId, signal !== undefined ? { signal } : {})
  return result.state
}

/**
 * The same lookup as {@link pinJobStatus}, but with the plain-English reason
 * attached in `PinResult.error` when the job failed.
 *
 * The reason that matters most is `expired`: it is what Pinata reports when it
 * searched the network and found nothing, which is exactly what a member gets if
 * they try to pin one of our dead CIDs with no node serving it. That case is
 * given the instructions needed to fix it.
 *
 * @throws An `Error` with `name === 'AbortError'` if `opts.signal` is aborted.
 */
export async function pinJobResult(
  token: string,
  requestId: string,
  opts: PinJobLookupOptions = {}
): Promise<PinResult> {
  const auth = normalizeToken(token)
  const jobId = requestId.trim()
  const cid = (opts.cid ?? '').trim()

  const problem = tokenProblem(auth)
  if (problem !== undefined) {
    return unknownState(cid, requestId, problem)
  }
  if (jobId === '') {
    return unknownState(cid, requestId, 'No Pinata job reference was given, so its progress could not be checked.')
  }

  const what = "read Pinata's pin queue"

  try {
    for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
      const url = new URL(PINATA.pinJobs)
      url.searchParams.set('limit', String(PAGE_SIZE))
      url.searchParams.set('offset', String(page * PAGE_SIZE))
      if (cid !== '') {
        // Not personal data — a public content address — and it narrows the
        // queue from "everything you ever queued" to "this one item".
        url.searchParams.set('ipfs_pin_hash', cid)
      }

      const reply = await pinataRequest(url.toString(), {
        method: 'GET',
        token: auth,
        what,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      })

      if (!reply.ok) {
        return unknownState(cid, jobId, describeFailure(reply.status, reply.reason, what))
      }

      const rows = rowsOf(reply.json)

      for (const row of rows) {
        const id = firstString(row, ['id', 'requestId', 'request_id'])
        if (id !== jobId) {
          continue
        }

        const rowCid = firstString(row, ['ipfs_pin_hash', 'ipfsHash', 'cid']) ?? cid
        const rawStatus = firstString(row, ['status'])
        const details = firstString(row, ['reason', 'details', 'message'])
        const mapped = rawStatus === undefined ? undefined : mapJobStatus(rawStatus)

        if (mapped === undefined) {
          return unknownState(
            rowCid,
            jobId,
            `Pinata reported a status this app does not recognise${
              rawStatus === undefined ? '' : ` (${redact(rawStatus, auth)})`
            }. Check the pin in your Pinata dashboard.`
          )
        }

        if (mapped.state === 'pinned') {
          return pinned(rowCid, jobId)
        }
        if (mapped.state === 'pinning') {
          return { cid: rowCid, target: TARGET, state: 'pinning', requestId: jobId }
        }

        return failed(rowCid, withRawStatus(auth, mapped.message, rawStatus, details), jobId)
      }

      // A short page is the last page.
      if (rows.length < PAGE_SIZE) {
        break
      }
    }
  } catch (err) {
    if (isCancellation(err)) {
      throw err
    }
    return unknownState(cid, jobId, plainMessage(err, auth))
  }

  return unknownState(
    cid,
    jobId,
    'Pinata is no longer showing a job for this content. That usually means the pin finished — ' +
      'refresh the pinned list to confirm it really landed.'
  )
}

/**
 * Every CID currently pinned on the account, as a set.
 *
 * One page of a thousand rows answers "is this pinned?" for a thousand assets,
 * so the Assets view resolves a whole archive with a handful of requests instead
 * of one request per row. This is also the *verification* step: a `pinning`
 * result only becomes trustworthy once the CID shows up here.
 *
 * @throws A plain-English `Error` if the list cannot be read. It never returns a
 * partial set after an error, because a short set would be silently misread as
 * "these are not pinned".
 * @throws An `Error` with `name === 'AbortError'` if `opts.signal` is aborted.
 */
export async function listPinnedCids(
  token: string,
  opts: ListPinnedOptions = {}
): Promise<Set<string>> {
  const auth = normalizeToken(token)
  const problem = tokenProblem(auth)
  if (problem !== undefined) {
    throw new PlainError(problem)
  }

  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_PIN_LIST_LIMIT))
  const maxPages = Math.ceil(limit / PAGE_SIZE) + 1
  const what = 'read your Pinata pin list'
  const cids = new Set<string>()

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(PINATA.pinList)
    url.searchParams.set('status', 'pinned')
    url.searchParams.set('pageLimit', String(PAGE_SIZE))
    url.searchParams.set('pageOffset', String(page * PAGE_SIZE))

    let reply: PinataReply
    try {
      reply = await pinataRequest(url.toString(), {
        method: 'GET',
        token: auth,
        what,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      })
    } catch (err) {
      if (isCancellation(err)) {
        throw err
      }
      throw new PlainError(plainMessage(err, auth))
    }

    if (!reply.ok) {
      throw new PlainError(describeFailure(reply.status, reply.reason, what))
    }

    const rows = rowsOf(reply.json)

    for (const row of rows) {
      // A row with an unpin date is history, not a live pin.
      if (firstString(row, ['date_unpinned']) !== undefined) {
        continue
      }
      const cid = firstString(row, ['ipfs_pin_hash', 'ipfsHash', 'cid'])
      if (cid !== undefined) {
        cids.add(cid)
      }
      if (cids.size >= limit) {
        return cids
      }
    }

    if (rows.length < PAGE_SIZE) {
      break
    }
  }

  return cids
}

/**
 * Upload raw bytes to Pinata directly.
 *
 * This is the fallback for when there is no Kubo node to serve the content from,
 * and it comes with an honest caveat that the caller MUST respect:
 *
 *   **The CID Pinata returns may not be the CID you started with.** A direct
 *   upload re-chunks and re-encodes the bytes with Pinata's own settings (chunk
 *   size, CID version, raw-leaves), and any difference produces a different
 *   hash. The content is then pinned under an address nothing in the archive,
 *   the metadata or the token contract refers to — which does not rescue the
 *   original CID at all.
 *
 * So `PinResult.cid` here is *whatever Pinata assigned*, not what was asked for.
 * The caller must compare it against the original and report a mismatch to the
 * member plainly, rather than presenting a changed CID as a successful rescue.
 * Only the Kubo-import route in {@link pinByCid} preserves the original CID.
 *
 * On any failure `cid` is empty, because no address was ever assigned; the
 * caller should show the CID it was trying to rescue instead.
 *
 * @throws An `Error` with `name === 'AbortError'` if `signal` is aborted.
 */
export async function uploadFileToPinata(
  token: string,
  bytes: Uint8Array,
  name: string,
  signal?: AbortSignal
): Promise<PinResult> {
  const auth = normalizeToken(token)
  const problem = tokenProblem(auth)
  if (problem !== undefined) {
    return failed('', problem)
  }
  if (bytes.byteLength === 0) {
    return failed('', 'That file is empty, so there was nothing to upload.')
  }

  const filename = safeFilename(name)
  const what = 'upload this file to Pinata'
  let reply: PinataReply

  try {
    reply = await pinataRequest(PINATA.uploadV3, {
      method: 'POST',
      token: auth,
      what,
      // Built fresh per attempt: a body cannot be sent twice.
      makeBody: () => {
        const form = new FormData()
        // `network: public` puts the file on the public IPFS network, which is
        // the only kind of pin that helps anyone else retrieve it.
        form.append('network', 'public')
        form.append('name', filename)
        form.append('file', new Blob([bytes]), filename)
        return form
      },
      timeoutMs: uploadTimeoutMs(bytes.byteLength),
      ...(signal !== undefined ? { signal } : {})
    })
  } catch (err) {
    if (isCancellation(err)) {
      throw err
    }
    return failed('', plainMessage(err, auth))
  }

  if (!reply.ok) {
    return failed('', describeFailure(reply.status, reply.reason, what))
  }

  const envelope = asRecord(reply.json)
  const data = asRecord(envelope?.data) ?? envelope
  const cid = firstString(data, ['cid', 'IpfsHash', 'ipfsHash'])

  if (cid === undefined) {
    // The bytes very probably landed, so calling this a failure would be a lie.
    return unknownState(
      '',
      undefined,
      'Pinata accepted the upload but did not say which content address it stored it under. ' +
        'Check the Files list in your Pinata dashboard before relying on this one.'
    )
  }

  return pinned(cid)
}

// ---------------------------------------------------------------------------
// Pinata pin-job statuses
// ---------------------------------------------------------------------------

interface JobStatusMapping {
  state: PinState
  /** Plain English, safe to show a member. */
  message: string
}

/**
 * Map a Pinata pin-job status onto a {@link PinState}.
 *
 * Returns `undefined` for a status we do not know, so the caller can say so
 * honestly instead of guessing.
 */
function mapJobStatus(raw: string): JobStatusMapping | undefined {
  switch (raw.trim().toLowerCase()) {
    case 'prechecking':
      return { state: 'pinning', message: 'Pinata is checking this content before it starts.' }
    case 'searching':
      return { state: 'pinning', message: 'Pinata is searching the network for this content.' }
    case 'retrieving':
      return { state: 'pinning', message: 'Pinata has found the content and is downloading it.' }
    case 'backfilled':
      return { state: 'pinning', message: 'Pinata has queued this content to be picked up.' }
    case 'pinned':
      return { state: 'pinned', message: 'Pinata has this content pinned.' }

    // The failure this whole app exists to explain.
    case 'expired':
      return {
        state: 'failed',
        message:
          'Pinata could not find this content anywhere on the network. Start your own IPFS node ' +
          'and import the backup so Pinata has somewhere to fetch it from.'
      }
    case 'over_free_limit':
      return {
        state: 'failed',
        message:
          'Your Pinata account has used up its free storage allowance, so this content was not pinned. ' +
          'Free up space or upgrade the plan, then try again.'
      }
    case 'over_max_size':
      return {
        state: 'failed',
        message:
          'This content is larger than Pinata will accept in a single pin, so it was not pinned. ' +
          'It is still safe in the .car backup.'
      }
    case 'invalid_object':
      return {
        state: 'failed',
        message:
          'Pinata could not read this as valid IPFS content, so it was not pinned. ' +
          'Check that the content address was copied correctly.'
      }
    case 'bad_host_node':
      return {
        state: 'failed',
        message:
          'Pinata could not connect to the IPFS node address it was given. Make sure your node is ' +
          'running and reachable from the internet (port 4001 open, or run it with a public address), ' +
          'then try again.'
      }
    default:
      return undefined
  }
}

/**
 * Keep Pinata's own wording alongside ours, so nothing is lost in translation —
 * `expired` in particular is worth showing verbatim to anyone who searches for
 * it. Both fields come from Pinata, so both go through {@link redact}.
 */
function withRawStatus(
  token: string,
  message: string,
  rawStatus?: string,
  details?: string
): string {
  const parts: string[] = []

  if (rawStatus !== undefined && rawStatus.trim() !== '') {
    parts.push(`Pinata reported: ${redact(rawStatus.trim(), token)}`)
  }
  if (details !== undefined && details.trim() !== '') {
    parts.push(truncate(redact(details.trim(), token), MAX_REASON_CHARS))
  }

  return parts.length === 0 ? message : `${message} (${parts.join(' — ')})`
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface RequestOptions {
  method: 'GET' | 'POST'
  /** Already normalised. Sent only as an `Authorization` header. */
  token: string
  /** Infinitive phrase for error text: "Could not reach Pinata to <what>". */
  what: string
  headers?: Record<string, string>
  /** Called once per attempt, because a request body cannot be re-sent. */
  makeBody?: () => string | FormData
  signal?: AbortSignal
  timeoutMs?: number
}

interface PinataReply {
  status: number
  ok: boolean
  /** Parsed JSON body, or `undefined` if there was none / it was unparsable. */
  json: unknown
  /** Redacted, truncated text of an error body. `undefined` when there is none. */
  reason: string | undefined
}

/**
 * One authenticated call to Pinata, with a deadline and bounded retries.
 *
 * Any HTTP status is returned rather than thrown — status handling is
 * per-endpoint. Transport failures and timeouts throw a {@link PlainError} whose
 * message is already written for a member and already redacted.
 */
async function pinataRequest(url: string, opts: RequestOptions): Promise<PinataReply> {
  let last: PinataReply | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    throwIfCancelled(opts.signal)

    const { reply, retryAfter } = await attemptRequest(url, opts)
    last = reply

    // 429 means "ask again more slowly", 5xx means "Pinata is having a moment".
    // Neither is a reason to give up on a CID; a 401 or a 400 is.
    const retryable = reply.status === 429 || reply.status >= 500
    if (!retryable || attempt === MAX_ATTEMPTS) {
      return reply
    }

    await delay(backoffMs(attempt, retryAfter), opts.signal)
  }

  // Unreachable: the loop always returns on its last iteration.
  return last ?? { status: 0, ok: false, json: undefined, reason: undefined }
}

async function attemptRequest(
  url: string,
  opts: RequestOptions
): Promise<{ reply: PinataReply; retryAfter: number | undefined }> {
  const deadline = createDeadline(opts.timeoutMs ?? API_TIMEOUT_MS, opts.signal)

  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(opts.headers ?? {}),
      // Last, so nothing above can shadow it. The token appears here and
      // nowhere else — never in the URL, never in a log line.
      authorization: `Bearer ${opts.token}`
    }

    const body = opts.makeBody?.()

    const response = await fetch(url, {
      method: opts.method,
      headers,
      redirect: 'follow',
      signal: deadline.signal,
      ...(body === undefined ? {} : { body })
    })

    const text = await readLimitedText(response)

    let json: unknown
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }

    const reply: PinataReply = {
      status: response.status,
      ok: response.ok,
      json,
      reason: response.ok ? undefined : errorReason(json, text, opts.token)
    }

    return { reply, retryAfter: retryAfterMs(response) }
  } catch (err) {
    throw translateTransportError(err, deadline, opts)
  } finally {
    deadline.cleanup()
  }
}

/** Read a response body as text, refusing to buffer an unreasonable amount. */
async function readLimitedText(response: Response): Promise<string> {
  const body = response.body
  if (body === null) {
    return ''
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value === undefined) {
      continue
    }
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new PlainError(
        'Pinata sent back far more data than expected, so the reply was refused. Try again in a few minutes.'
      )
    }
    text += decoder.decode(value, { stream: true })
  }

  return text + decoder.decode()
}

/** `Retry-After`, in milliseconds, when Pinata tells us how long to wait. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null || header.trim() === '') {
    return undefined
  }

  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, BACKOFF_MAX_MS)
  }

  const when = Date.parse(header)
  if (Number.isFinite(when)) {
    return Math.min(Math.max(0, when - Date.now()), BACKOFF_MAX_MS)
  }

  return undefined
}

/** Exponential backoff with jitter, unless Pinata named a delay itself. */
function backoffMs(attempt: number, retryAfter: number | undefined): number {
  if (retryAfter !== undefined) {
    return retryAfter
  }
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

/** An upload gets its base budget plus an allowance for a slow connection. */
function uploadTimeoutMs(byteLength: number): number {
  const allowance = (byteLength / ASSUMED_UPLOAD_BPS) * 1000
  return Math.min(UPLOAD_MAX_TIMEOUT_MS, UPLOAD_BASE_TIMEOUT_MS + allowance)
}

// ---------------------------------------------------------------------------
// Deadlines and cancellation
// ---------------------------------------------------------------------------

interface Deadline {
  readonly signal: AbortSignal
  /** True when *our* clock fired, as opposed to the caller cancelling. */
  readonly expired: boolean
  readonly budgetMs: number
  cleanup(): void
}

function createDeadline(ms: number, outer: AbortSignal | undefined): Deadline {
  const controller = new AbortController()
  const budgetMs = Math.max(1, Math.round(ms))
  let expired = false

  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, budgetMs)

  const onOuterAbort = (): void => {
    controller.abort()
  }

  if (outer !== undefined) {
    if (outer.aborted) {
      controller.abort()
    } else {
      outer.addEventListener('abort', onOuterAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    get expired(): boolean {
      return expired
    },
    budgetMs,
    cleanup(): void {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}

/** Sleep, but wake immediately if the run is cancelled. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelledError())
      return
    }

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelledError())
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function cancelledError(): Error {
  const err = new Error('This was cancelled.')
  err.name = 'AbortError'
  return err
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancelledError()
  }
}

// ---------------------------------------------------------------------------
// Error text — everything a member reads comes from here
// ---------------------------------------------------------------------------

/** An error whose message is already plain English and already redacted. */
class PlainError extends Error {
  override readonly name = 'PinataError'
}

/** Turn one failed HTTP exchange into a cancellation, a timeout, or a reason. */
function translateTransportError(err: unknown, deadline: Deadline, opts: RequestOptions): Error {
  if (err instanceof PlainError) {
    return err
  }
  if (opts.signal?.aborted === true) {
    return cancelledError()
  }
  if (deadline.expired) {
    const seconds = Math.max(1, Math.round(deadline.budgetMs / 1000))
    return new PlainError(
      `Pinata did not respond within ${seconds} seconds when trying to ${opts.what}. ` +
        'It may be busy — wait a minute and try again.'
    )
  }
  if (isCancellation(err)) {
    return cancelledError()
  }
  return new PlainError(
    redact(`Could not reach Pinata to ${opts.what}: ${describeNetworkError(err)}.`, opts.token)
  )
}

function describeNetworkError(err: unknown): string {
  const text = causeChain(err)
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(text)) {
    return 'the address api.pinata.cloud could not be looked up — check your internet connection'
  }
  if (/ECONNREFUSED/i.test(text)) {
    return 'the connection was refused'
  }
  if (/ECONNRESET|socket hang up|terminated|premature close|aborted/i.test(text)) {
    return 'the connection dropped part-way through'
  }
  if (/certificate|SSL|TLS|self.signed/i.test(text)) {
    return 'there is a security certificate problem, which can happen behind a company firewall'
  }
  if (/ETIMEDOUT|timeout/i.test(text)) {
    return 'the connection timed out'
  }
  return 'the connection failed'
}

/** Plain English for a non-2xx status, with Pinata's own words appended. */
function describeFailure(status: number, reason: string | undefined, what: string): string {
  let headline: string

  switch (status) {
    case 400:
      headline = `Pinata rejected that request as invalid (400) when asked to ${what}.`
      break
    case 401:
      headline = 'That Pinata token was not accepted. Check you copied the whole JWT.'
      break
    case 403:
      headline =
        'Pinata refused this request (403). The key may not have permission to pin — check its ' +
        'permissions in your Pinata account, then save the token again.'
      break
    case 404:
      headline = `Pinata did not recognise that request (404) when asked to ${what}.`
      break
    case 413:
      headline = 'Pinata refused this because it is larger than it will accept in one go (413).'
      break
    case 429:
      headline =
        'Pinata is limiting how often we can ask right now, and it did not clear after several ' +
        'tries. Nothing was lost — wait a few minutes and run this again.'
      break
    default:
      headline =
        status >= 500
          ? `Pinata is having a problem at its end (${status}). Nothing was lost — try again in a few minutes.`
          : `Pinata refused this request (${status}) when asked to ${what}.`
  }

  return reason === undefined || reason === '' ? headline : `${headline} Pinata said: ${reason}`
}

/** Reduce any thrown value to a member-safe sentence. */
function plainMessage(err: unknown, token: string): string {
  if (err instanceof PlainError) {
    return redact(err.message, token)
  }
  if (err instanceof Error) {
    return redact(`Something went wrong talking to Pinata: ${err.message}`, token)
  }
  return 'Something went wrong talking to Pinata.'
}

/** Pull a usable reason out of an error body, redact it, and keep it short. */
function errorReason(json: unknown, text: string, token: string): string | undefined {
  const fromJson = reasonFromJson(json)
  const fallback = text.trim()

  // A proxy or WAF may return an HTML page; that is noise, not a reason.
  const raw = fromJson ?? (fallback === '' || fallback.startsWith('<') ? undefined : fallback)
  if (raw === undefined || raw === '') {
    return undefined
  }

  return truncate(redact(raw, token), MAX_REASON_CHARS)
}

function reasonFromJson(json: unknown): string | undefined {
  const record = asRecord(json)
  if (record === undefined) {
    return undefined
  }

  const error = record.error
  if (typeof error === 'string' && error.trim() !== '') {
    return error.trim()
  }

  const errorRecord = asRecord(error)
  if (errorRecord !== undefined) {
    const reason = firstString(errorRecord, ['reason', 'message', 'code'])
    const details = firstString(errorRecord, ['details', 'description'])
    if (reason !== undefined && details !== undefined) {
      return `${reason}: ${details}`
    }
    if (reason !== undefined) {
      return reason
    }
    if (details !== undefined) {
      return details
    }
  }

  return firstString(record, ['message', 'reason', 'details'])
}

function causeChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err

  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message)
      const code = (current as { code?: unknown }).code
      if (typeof code === 'string') {
        parts.push(code)
      }
      current = (current as { cause?: unknown }).cause
    } else {
      parts.push(String(current))
      break
    }
  }

  return parts.join(' | ')
}

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

/**
 * Tidy up a pasted token. Members paste from a dashboard, so leading and
 * trailing whitespace and a copied `Bearer ` prefix are both common.
 */
function normalizeToken(token: string): string {
  const trimmed = (token ?? '').trim()
  return /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, '').trim() : trimmed
}

/**
 * Why this token cannot be used, in plain English — or `undefined` if it looks
 * usable. Never quotes the token back, not even a fragment of it.
 *
 * The whitespace check is also a safety measure: a stray newline in a header
 * value would otherwise blow up inside `fetch` with an unreadable error.
 */
function tokenProblem(token: string): string | undefined {
  if (token === '') {
    return 'No Pinata token has been saved yet. Add your Pinata JWT in Settings to pin through Pinata.'
  }
  if (/[\s\u0000-\u001f\u007f]/.test(token)) {
    return (
      'That Pinata token does not look complete — a Pinata JWT is one long unbroken line of ' +
      'characters. Copy the whole key from Pinata and paste it again.'
    )
  }
  if (token.length < 20) {
    return (
      'That Pinata token looks too short to be a JWT. Copy the whole key from Pinata — it is ' +
      'much longer than an API key — and paste it again.'
    )
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pinned(cid: string, requestId?: string): PinResult {
  return {
    cid,
    target: TARGET,
    state: 'pinned',
    ...(requestId !== undefined ? { requestId } : {})
  }
}

function failed(cid: string, error: string, requestId?: string): PinResult {
  return {
    cid,
    target: TARGET,
    state: 'failed',
    error,
    ...(requestId !== undefined ? { requestId } : {})
  }
}

function unknownState(cid: string, requestId: string | undefined, error: string): PinResult {
  return {
    cid,
    target: TARGET,
    state: 'unknown',
    error,
    ...(requestId !== undefined && requestId !== '' ? { requestId } : {})
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** First key that holds a non-empty string. Tolerates Pinata's naming drift. */
function firstString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  if (record === undefined) {
    return undefined
  }
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return undefined
}

/** Rows out of a `{ count, rows }` envelope, or a bare array. */
function rowsOf(json: unknown): Array<Record<string, unknown>> {
  const envelope = asRecord(json)
  const raw = Array.isArray(json) ? json : envelope?.rows

  if (!Array.isArray(raw)) {
    return []
  }

  const rows: Array<Record<string, unknown>> = []
  for (const item of raw) {
    const record = asRecord(item)
    if (record !== undefined) {
      rows.push(record)
    }
  }
  return rows
}

/**
 * Keep only multiaddrs Pinata could actually dial.
 *
 * Loopback and unspecified addresses are meaningless to a machine in someone
 * else's data centre; sending them risks a `bad_host_node` verdict on a request
 * that might otherwise have worked.
 */
function usableHostNodes(hostNodes: readonly string[] | undefined): string[] {
  if (hostNodes === undefined) {
    return []
  }

  const out: string[] = []
  const seen = new Set<string>()

  for (const entry of hostNodes) {
    const addr = typeof entry === 'string' ? entry.trim() : ''
    if (addr === '' || !addr.startsWith('/') || isUndialable(addr) || seen.has(addr)) {
      continue
    }
    seen.add(addr)
    out.push(addr)
    if (out.length >= MAX_HOST_NODES) {
      break
    }
  }

  return out
}

function isUndialable(addr: string): boolean {
  const parts = addr.split('/')
  const protocol = parts[1]
  const value = parts[2] ?? ''

  if (protocol === 'ip4') {
    return value.startsWith('127.') || value === '0.0.0.0'
  }
  if (protocol === 'ip6') {
    return value === '::1' || value === '::'
  }
  return false
}

/** A filename Pinata will accept, without inventing one the member never chose. */
function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
  return cleaned === '' ? 'file' : cleaned.slice(0, MAX_PIN_NAME_CHARS)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
