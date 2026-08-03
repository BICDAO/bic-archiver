/**
 * Content health checking.
 *
 * Answers the only question a DAO member really cares about: "is our backup
 * still out there?" Two independent signals are combined:
 *
 *   1. Delegated routing (IPIP-337) — is anybody *announcing* the CID? An empty
 *      provider list means nothing on the network claims to hold it any more.
 *   2. Direct gateway probes — will anybody actually *serve* the root block
 *      right now? Gateways cache, so a gateway hit with zero providers means
 *      "alive today, gone tomorrow": at-risk.
 *
 * Everything here is failure-tolerant by design. Nothing throws, every request
 * carries its own deadline, and a completely dead CID resolves in seconds
 * rather than hanging for minutes — the app exists precisely because content
 * dies quietly, so the checker must never die quietly with it.
 */

import { performance } from 'node:perf_hooks'
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers'

import {
  DELEGATED_ROUTING,
  HEALTH_CONCURRENCY,
  TRUSTLESS_GATEWAYS
} from '../../shared/constants'
import type { HealthResult } from '../../shared/types'

/** One gateway probe outcome, as embedded in `HealthResult.gateways`. */
export type GatewayProbe = HealthResult['gateways'][number]

/**
 * Deadline for the "who has this?" routing lookup. Deliberately short: the
 * routing endpoint either knows within a second or two, or it is having a bad
 * day, and either way a slow answer must not delay the verdict.
 */
const ROUTING_TIMEOUT_MS = 8_000

/**
 * Deadline for a single gateway probe. Dead content typically manifests as a
 * gateway holding the connection open while it searches the DHT, then a 504
 * around the one-minute mark. We are not willing to wait that long per gateway,
 * and we do not need to: an honest "we could not get it in 8s" is exactly the
 * signal the member needs.
 */
const PROBE_TIMEOUT_MS = 8_000

/** Hard ceiling on one whole `checkHealth` call, whatever goes wrong inside. */
const HEALTH_TIMEOUT_MS = 20_000

/** Never buffer more than this from the routing endpoint (it may stream). */
const MAX_ROUTING_BYTES = 512 * 1024

/** Asking for the single root block, not the (possibly enormous) whole file. */
const RAW_ACCEPT = 'application/vnd.ipld.raw'

/* -------------------------------------------------------------------------- */
/* internals                                                                   */
/* -------------------------------------------------------------------------- */

interface Deadline {
  /** Pass to `fetch`. Fires on our timer *or* on the caller's signal. */
  readonly signal: AbortSignal
  /** True when our own timer fired (as opposed to the caller cancelling). */
  expired: () => boolean
  /** Always call in a `finally`: clears the timer and unsubscribes. */
  release: () => void
}

/**
 * A self-contained timeout that also honours an optional caller signal, so a
 * user hitting "Cancel" tears down in-flight sockets immediately.
 */
function createDeadline(ms: number, outer?: AbortSignal): Deadline {
  const controller = new AbortController()
  let expired = false

  const timer = setTimer(() => {
    expired = true
    controller.abort(new Error(`Timed out after ${Math.round(ms / 1000)}s`))
  }, ms)
  // Never let a pending health probe hold the process open.
  timer.unref()

  const onOuterAbort = (): void => controller.abort(outer?.reason)
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason)
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }

  return {
    signal: controller.signal,
    expired: () => expired,
    release: () => {
      clearTimer(timer)
      if (outer) outer.removeEventListener('abort', onOuterAbort)
    }
  }
}

/**
 * Reduce whatever the user pasted to a bare root CID: `ipfs://Qm…/1`,
 * `/ipfs/Qm…`, and `Qm…?filename=x` all collapse to `Qm…`.
 */
function normalizeCid(input: string): string {
  let s = typeof input === 'string' ? input.trim() : ''
  if (s === '') return ''

  s = s.replace(/^ipfs:\/\//i, '')
  if (s.startsWith('/ipfs/')) s = s.slice('/ipfs/'.length)
  else if (s.startsWith('ipfs/')) s = s.slice('ipfs/'.length)

  const cut = s.search(/[/?#]/)
  if (cut >= 0) s = s.slice(0, cut)
  return s
}

/**
 * A cheap lexical sanity check — deliberately permissive. Its only job is to
 * stop us firing five network requests at obvious junk ("", "hello world",
 * a bare token id). Real multibase alphabets are covered, so a valid CID is
 * never rejected here.
 */
function isPlausibleCid(cid: string): boolean {
  return cid.length >= 10 && /^[0-9A-Za-z+/=_-]+$/.test(cid)
}

/** Walk an error's `cause` chain looking for a Node/undici error code. */
function errorCode(err: unknown): string | undefined {
  let current: unknown = err
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Turn a thrown fetch error into a short, honest word for the results table.
 * Kept lowercase and jargon-free — a member reading "dns" or "timeout" learns
 * something; "UND_ERR_CONNECT_TIMEOUT" teaches them nothing.
 */
function describeFailure(err: unknown, deadline: Deadline, outer?: AbortSignal): string {
  if (deadline.expired()) return 'timeout'
  if (outer?.aborted) return 'cancelled'

  switch (errorCode(err)) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'dns'
    case 'ECONNREFUSED':
      return 'refused'
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return 'reset'
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'timeout'
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'tls'
    default:
      break
  }

  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return 'timeout'
    if (err.name === 'AbortError') return 'cancelled'
  }
  return 'network'
}

/** Release a response body we are not going to read. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    /* the socket is going away regardless */
  }
}

/**
 * Read a response body up to `maxBytes`, returning whatever arrived even if the
 * stream was aborted part-way. That matters for NDJSON routing responses: a
 * server that streams records and then keeps the connection open would yield
 * nothing at all from `res.text()`, and we would wrongly report zero providers.
 */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const body = res.body
  if (!body) {
    try {
      return await res.text()
    } catch {
      return ''
    }
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0

  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      const value = chunk.value
      if (value && value.byteLength > 0) {
        bytes += value.byteLength
        text += decoder.decode(value, { stream: true })
        if (bytes >= maxBytes) break
      }
    }
    text += decoder.decode()
  } catch {
    /* keep whatever we managed to read */
  }

  try {
    await reader.cancel()
  } catch {
    /* ignore */
  }
  return text
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Does this object look like a routing provider record rather than an error? */
function isProviderRecord(value: object): boolean {
  const rec = value as Record<string, unknown>
  return (
    'Schema' in rec ||
    'ID' in rec ||
    'Addrs' in rec ||
    'Protocol' in rec ||
    'Protocols' in rec
  )
}

/** Count providers in one parsed JSON value (a wrapper, an array, or a record). */
function countInValue(value: unknown): number {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'object' && entry !== null).length
  }
  if (typeof value === 'object' && value !== null) {
    const providers = (value as { Providers?: unknown }).Providers
    if (Array.isArray(providers)) {
      return providers.filter((entry) => typeof entry === 'object' && entry !== null).length
    }
    if (providers === null) return 0
    return isProviderRecord(value) ? 1 : 0
  }
  return 0
}

/**
 * Count providers from either shape the routing endpoint may emit:
 * a single `{"Providers":[…]}` document, or newline-delimited records.
 */
function countProviders(body: string): number {
  const text = body.trim()
  if (text === '') return 0

  const whole = tryParse(text)
  if (whole !== undefined) return countInValue(whole)

  let total = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const record = tryParse(trimmed)
    if (record === undefined) continue
    total += countInValue(record)
  }
  return total
}

/** Run `worker` over `items`, at most `limit` at a time, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  if (items.length === 0) return out

  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0

  const runLane = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      // Safe: index < items.length, but noUncheckedIndexedAccess cannot see it.
      const item = items[index] as T
      out[index] = await worker(item, index)
    }
  }

  await Promise.all(Array.from({ length: lanes }, runLane))
  return out
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

/* -------------------------------------------------------------------------- */
/* public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many peers are announcing `cid` to the network right now.
 *
 * Never throws. A 404, an unparseable body, a dead endpoint or a timeout all
 * report 0 — which is the conservative reading, since a caller acting on 0 will
 * re-pin the content rather than assume it is safe.
 *
 * @param cid    A CID, optionally wrapped as `ipfs://…` or `/ipfs/…/path`.
 * @param signal Optional caller cancellation.
 */
export async function checkProviders(cid: string, signal?: AbortSignal): Promise<number> {
  const root = normalizeCid(cid)
  if (!isPlausibleCid(root)) return 0

  const deadline = createDeadline(ROUTING_TIMEOUT_MS, signal)
  try {
    const res = await fetch(`${DELEGATED_ROUTING}/providers/${encodeURIComponent(root)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: deadline.signal
    })

    // 404 is the endpoint's way of saying "nobody has this". Not an error.
    if (!res.ok) {
      await discard(res)
      return 0
    }

    return countProviders(await readBounded(res, MAX_ROUTING_BYTES))
  } catch {
    return 0
  } finally {
    deadline.release()
  }
}

/**
 * Ask one gateway whether it will serve the root block of `cid`.
 *
 * Uses `?format=raw`, so we request a single block (a few hundred bytes)
 * instead of pulling a potentially multi-gigabyte file just to prove it exists.
 * HEAD first; if the gateway rejects the method we retry with a one-byte ranged
 * GET.
 *
 * Never throws — a failure is encoded in the result, with `status` as a short
 * word ('timeout', 'dns', 'refused', 'reset', 'tls', 'cancelled', 'network')
 * instead of an HTTP code.
 */
export async function probeGateway(
  gateway: string,
  cid: string,
  signal?: AbortSignal
): Promise<GatewayProbe> {
  const root = normalizeCid(cid)
  if (!isPlausibleCid(root)) {
    return { gateway, ok: false, ms: 0, status: 'invalid cid' }
  }

  const base = gateway.trim().replace(/\/+$/, '')
  const url = `${base}/ipfs/${encodeURIComponent(root)}?format=raw`
  const startedAt = performance.now()
  const deadline = createDeadline(PROBE_TIMEOUT_MS, signal)

  try {
    let res = await fetch(url, {
      method: 'HEAD',
      headers: { accept: RAW_ACCEPT },
      signal: deadline.signal
    })

    // Some gateways refuse HEAD outright; a one-byte range is the cheap retry.
    if (res.status === 405 || res.status === 501) {
      await discard(res)
      res = await fetch(url, {
        method: 'GET',
        headers: { accept: RAW_ACCEPT, range: 'bytes=0-0' },
        signal: deadline.signal
      })
    }

    const ok = res.ok
    const status = res.status
    await discard(res)
    return { gateway, ok, ms: elapsedMs(startedAt), status }
  } catch (err) {
    return {
      gateway,
      ok: false,
      ms: elapsedMs(startedAt),
      status: describeFailure(err, deadline, signal)
    }
  } finally {
    deadline.release()
  }
}

/**
 * Full health check for one CID: routing lookup plus a probe of every trustless
 * gateway, at most `HEALTH_CONCURRENCY` probes in flight.
 *
 * Verdicts:
 *   healthy     — announced by providers *and* served by at least one gateway
 *   at-risk     — served by a gateway but nobody is announcing it; likely alive
 *                 only in gateway caches, so it can vanish without warning
 *   unreachable — no gateway would serve it; treat the backup as lost
 *
 * Never throws, and is hard-capped at ~20 seconds so a dead CID (the DAO's
 * Oct-2025 backup, for example) comes back in seconds rather than minutes.
 */
export async function checkHealth(
  cid: string,
  label: string,
  signal?: AbortSignal
): Promise<HealthResult> {
  const deadline = createDeadline(HEALTH_TIMEOUT_MS, signal)
  const gatewayList = [...TRUSTLESS_GATEWAYS]

  try {
    // The routing lookup hits a different host, so it runs alongside the probes
    // rather than consuming one of the HEALTH_CONCURRENCY gateway slots.
    const [providers, gateways] = await Promise.all([
      checkProviders(cid, deadline.signal),
      mapWithConcurrency(gatewayList, HEALTH_CONCURRENCY, (gateway) =>
        probeGateway(gateway, cid, deadline.signal)
      )
    ])

    const served = gateways.some((probe) => probe.ok)
    const verdict: HealthResult['verdict'] = !served
      ? 'unreachable'
      : providers > 0
        ? 'healthy'
        : 'at-risk'

    return { cid, label, providers, gateways, verdict, checkedAt: new Date().toISOString() }
  } catch {
    // Defensive: the calls above are already non-throwing, but a health check
    // must always produce a row for the table.
    return {
      cid,
      label,
      providers: 0,
      gateways: gatewayList.map((gateway) => ({
        gateway,
        ok: false,
        ms: 0,
        status: 'network'
      })),
      verdict: 'unreachable',
      checkedAt: new Date().toISOString()
    }
  } finally {
    deadline.release()
  }
}

/**
 * Sweep many CIDs with bounded concurrency, streaming each result to
 * `onResult` the moment it lands so the GUI table fills in progressively.
 *
 * Repeated CIDs within one sweep share a single set of network calls; each item
 * still gets its own result object carrying its own label.
 *
 * Never throws. If `signal` aborts mid-sweep the remaining items are skipped and
 * the results gathered so far are returned (in input order) — callers detect
 * cancellation from their own signal, not from an exception.
 */
export async function checkMany(
  items: Array<{ cid: string; label: string }>,
  onResult: (r: HealthResult) => void,
  signal?: AbortSignal
): Promise<HealthResult[]> {
  if (items.length === 0) return []

  const slots = new Array<HealthResult | undefined>(items.length)
  const shared = new Map<string, Promise<HealthResult>>()

  await mapWithConcurrency(items, HEALTH_CONCURRENCY, async (item, index) => {
    if (signal?.aborted) return

    const key = normalizeCid(item.cid)
    let pending = key === '' ? undefined : shared.get(key)
    if (!pending) {
      pending = checkHealth(item.cid, item.label, signal)
      if (key !== '') shared.set(key, pending)
    }

    const base = await pending
    if (signal?.aborted) return

    const result: HealthResult = {
      ...base,
      cid: item.cid,
      label: item.label,
      // Clone so two items sharing a CID cannot mutate each other's row.
      gateways: base.gateways.map((probe) => ({ ...probe }))
    }
    slots[index] = result

    try {
      onResult(result)
    } catch {
      /* a failing UI callback must not abort the sweep */
    }
  })

  const results: HealthResult[] = []
  for (const result of slots) {
    if (result) results.push(result)
  }
  return results
}
