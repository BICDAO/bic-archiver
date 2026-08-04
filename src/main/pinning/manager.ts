/**
 * The pin run — turning "we have a backup file" into "somebody is keeping this".
 *
 * A `.car` on a Google Drive is not a backup of an *address*. It holds the bytes,
 * but the CID stays dead until some machine on the network answers for it. That
 * is the whole gap this module closes, and the order it does it in is the point:
 *
 *   1. **Import the archive into a local Kubo node first.** `dag/import`
 *      preserves every CID exactly and makes that node a genuine provider for
 *      all of them — including the ones nothing on earth has served for two
 *      years.
 *   2. Pin them there, so the node's next garbage collection does not undo it.
 *   3. Ask Pinata to pin the same CIDs, handing it the node's multiaddrs as
 *      `hostNodes` so it knows where to fetch from.
 *   4. Confirm the pins actually landed by reading Pinata's pin list, rather
 *      than believing the queue.
 *
 * Step 1 is not optional decoration. Pinata's pin-by-CID *searches* the network;
 * for the 428 CIDs the May-2026 sweep found dead there is nothing to search for,
 * and the job simply expires. Skipping straight to step 3 looks like it worked —
 * requests are accepted, jobs are queued — and rescues nothing. So when there is
 * no node to serve from, this module says so in plain words and only attempts
 * the CIDs somebody is still providing, instead of queueing thousands of pins
 * that will quietly expire overnight.
 *
 * Nothing here ever sees more of the Pinata token than passing it to
 * `pinata.ts` requires: it is never logged, never put in a message, and every
 * error string that reaches the GUI is run through {@link redact} first.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers'

import { CID } from 'multiformats/cid'

import { HEALTH_CONCURRENCY } from '../../shared/constants.js'
import type {
  PinProgress,
  PinResult,
  PinRunSummary,
  PinState,
  PinTargetId,
  PinTargetStatus,
  PinningSettings
} from '../../shared/pinning.js'
import type { ProgressEvent } from '../../shared/types.js'
import { buildArchiveRoot } from '../archive/archiver.js'
import type { ArchiveStore } from '../archive/store.js'
import { checkProviders } from '../health/check.js'
import { exportCar } from '../ipfs/car.js'
import { buildAssetRows, cidSpellings } from './assets.js'
import { importCarToKubo, detectKubo, listPins, pinCid } from './kubo.js'
import { listPinnedCids, pinByCid, pinJobResult, testPinataAuth } from './pinata.js'

/* -------------------------------------------------------------------------- */
/* tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How many Pinata requests to have in flight at once.
 *
 * Four is deliberate politeness rather than a performance figure. Pinata rate
 * limits, `pinata.ts` already backs off on a 429, and a rescue that finishes in
 * twenty minutes instead of ten but never gets throttled is the better outcome.
 */
const DEFAULT_CONCURRENCY = 4

/** How long to keep checking on queued Pinata jobs before reporting back. */
const DEFAULT_MAX_WAIT_MS = 10 * 60_000

/**
 * Gaps between checks on queued jobs, then every minute after that. Pinata
 * fetches content over IPFS; a large file from a home connection is minutes of
 * work, so the early checks are frequent and the later ones are patient.
 */
const POLL_STEPS_MS = [5_000, 10_000, 20_000, 30_000, 30_000] as const
const POLL_STEADY_MS = 60_000

/**
 * At or below this many outstanding jobs, each one is asked about individually
 * every round. That catches `expired` — the verdict that means "Pinata looked
 * and found nothing", the single most informative failure in this app — within
 * seconds instead of at the end. Above it, one pin-list request per round
 * answers for all of them at a fraction of the cost.
 */
const SMALL_JOB_SET = 50

/** Ceiling on the individual job lookups done at the end, to explain failures. */
const JOB_LOOKUP_CAP = 250

/**
 * How many per-CID failures to describe in the summary. The *count* is always
 * exact; only the detail list is capped, so a target that is switched off does
 * not send ten thousand identical sentences across the IPC boundary. The case
 * that matters — the DAO's 428 dead CIDs — fits inside this comfortably.
 */
const MAX_FAILURE_DETAILS = 500

/** Only report CAR export progress this often, so the GUI is not flooded. */
const EXPORT_PROGRESS_INTERVAL_MS = 750

/* -------------------------------------------------------------------------- */
/* public types                                                                */
/* -------------------------------------------------------------------------- */

/** Everything a pin run needs. */
export interface PinRunOptions {
  /** Which targets are switched on, and where the node lives. */
  settings: PinningSettings
  /**
   * The Pinata token, read from the OS keychain by the main process. `null`
   * when none is stored — Pinata is then reported as unavailable with an
   * explanation, and the Kubo half of the run continues normally.
   */
  token: string | null
  /**
   * A `.car` file to import into the node first. This is what makes the node a
   * provider for dead CIDs, so supply it whenever one exists.
   */
  carPath?: string
  /**
   * The archive itself. Used to produce a `.car` when `carPath` is not given,
   * and to label pins so the Pinata dashboard is readable.
   */
  store?: ArchiveStore
  /** Streamed to the GUI. Run-wide messages arrive with an empty `cid`. */
  onProgress: (p: PinProgress) => void
  signal?: AbortSignal
  /** Pinata requests in flight at once. Defaults to 4. */
  concurrency?: number
  /** How long to keep checking queued Pinata jobs. Defaults to 10 minutes. */
  maxWaitMs?: number
  /** Human labels per CID, e.g. `Bored Ape #1/arweave image/ape.png`. */
  labels?: ReadonlyMap<string, string>
}

/* -------------------------------------------------------------------------- */
/* small utilities                                                             */
/* -------------------------------------------------------------------------- */

function abortError(): Error {
  const err = new Error('The pinning run was cancelled.')
  err.name = 'AbortError'
  return err
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** Wait, but wake up immediately if the member cancels. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    let timer: ReturnType<typeof setTimer> | undefined

    const cleanup = (): void => {
      if (timer !== undefined) clearTimer(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    function onAbort(): void {
      cleanup()
      reject(abortError())
    }

    timer = setTimer(() => {
      cleanup()
      resolve()
    }, ms)
    // Never let a pending wait hold the whole app open at shutdown.
    timer.unref()

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Strip anything credential-shaped out of text on its way to the screen.
 *
 * `pinata.ts` already redacts its own errors; this is the second net, for text
 * that came from somewhere else entirely — an undici error quoting a header, a
 * message we did not write. A CID is never touched: it contains no dots, and
 * mangling one would destroy the single identifier a member needs in order to
 * ask anybody for help.
 */
export function redact(text: string, token?: string | null): string {
  let out = typeof text === 'string' ? text : String(text ?? '')

  const secret = (token ?? '').trim()
  if (secret.length >= 8) {
    out = out.split(secret).join('[token-hidden]')
  }

  // `Bearer <anything>` and bare JWT / dotted-secret shapes.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [token-hidden]')
  out = out.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[token-hidden]')
  out = out.replace(/\b(token|jwt|api_key|apikey|access_token)=[^\s&]+/gi, '$1=[token-hidden]')

  return out
}

/** Plain text for an unknown thrown value, safe to put in front of a member. */
function errorText(err: unknown, token?: string | null): string {
  const raw = err instanceof Error ? err.message : String(err)
  const cleaned = redact(raw, token).trim()
  return cleaned === '' ? 'Something went wrong.' : cleaned
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
      // Safe: index < items.length, which `noUncheckedIndexedAccess` cannot see.
      out[index] = await worker(items[index] as T, index)
    }
  }

  await Promise.all(Array.from({ length: lanes }, runLane))
  return out
}

/**
 * Is this CID in the set, under any spelling of it?
 *
 * Kubo's pin list already returns both `Qm…` and `bafy…` forms; Pinata's returns
 * whatever spelling the pin was created with. Checking every spelling means a
 * CID pinned last year as `Qm…` is not re-pinned today because the archive now
 * records it as `bafy…` — and, more importantly, is not reported as unpinned.
 */
function hasCid(set: ReadonlySet<string>, cid: string): boolean {
  if (set.has(cid)) return true
  for (const spelling of cidSpellings(cid)) {
    if (set.has(spelling)) return true
  }
  return false
}

/** Trimmed, non-empty, first spelling wins, original order preserved. */
function dedupeCids(cids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of cids) {
    const cid = typeof raw === 'string' ? raw.trim() : ''
    if (cid === '' || seen.has(cid)) continue
    seen.add(cid)
    out.push(cid)
  }
  return out
}

function emptySummary(): PinRunSummary {
  return { requested: 0, pinned: 0, queued: 0, failed: 0, skipped: 0, failures: [] }
}

/* -------------------------------------------------------------------------- */
/* progress                                                                    */
/* -------------------------------------------------------------------------- */

interface Emitter {
  /** A message about one CID. */
  (cid: string, target: PinTargetId, phase: PinProgress['phase'], message: string, progress?: number): void
}

/**
 * Wrap the caller's listener so a throwing GUI callback can never take down a
 * rescue that is half finished.
 */
function makeEmitter(onProgress: PinRunOptions['onProgress']): Emitter {
  return (cid, target, phase, message, progress) => {
    const event: PinProgress = { cid, target, phase, message }
    if (progress !== undefined && Number.isFinite(progress)) {
      event.progress = Math.max(0, Math.min(1, progress))
    }
    try {
      onProgress(event)
    } catch {
      /* a misbehaving listener must not abort the run */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* targets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Ask both destinations whether they are usable right now.
 *
 * Always returns exactly two entries — Kubo first, then Pinata — so the settings
 * screen can draw both rows whatever the answer is. A target that is switched
 * off is reported `available: false` with a `detail` saying so, which is
 * different from one that is switched on and broken, and the member needs to be
 * able to tell those apart.
 *
 * The two checks run at the same time; neither can delay the other. Never throws
 * except an `Error` with `name === 'AbortError'` when `signal` is aborted.
 */
export async function getTargets(
  settings: PinningSettings,
  token: string | null,
  signal?: AbortSignal
): Promise<PinTargetStatus[]> {
  throwIfCancelled(signal)

  const kuboCheck = async (): Promise<PinTargetStatus> => {
    if (!settings.kubo.enabled) {
      return {
        target: 'kubo',
        available: false,
        detail:
          'Your own IPFS node is switched off. Turn it on in Settings to keep a copy of the archive on ' +
          'this computer — it is the only way to bring back content that has fallen off the network.'
      }
    }
    return await detectKubo(settings.kubo.apiUrl, signal)
  }

  const pinataCheck = async (): Promise<PinTargetStatus> => {
    if (!settings.pinata.enabled) {
      return {
        target: 'pinata',
        available: false,
        detail: 'Pinata is switched off. Turn it on in Settings if you want a copy kept in the cloud too.'
      }
    }
    const auth = (token ?? '').trim()
    if (auth === '') {
      return {
        target: 'pinata',
        available: false,
        detail:
          'Pinata is switched on but no access key has been saved. Paste your Pinata key in Settings — ' +
          'it is stored in this computer’s keychain and never leaves the app.'
      }
    }
    return await testPinataAuth(auth, signal)
  }

  const [kubo, pinata] = await Promise.all([kuboCheck(), pinataCheck()])
  return [kubo, pinata]
}

/* -------------------------------------------------------------------------- */
/* per-target outcomes                                                         */
/* -------------------------------------------------------------------------- */

/** What happened to one CID at one target. */
interface Outcome {
  state: PinState
  error?: string
  requestId?: string
  /** True when there was nothing to do because it was already pinned. */
  skipped: boolean
}

type OutcomeMap = Map<string, Outcome>

function record(map: OutcomeMap, cid: string, outcome: Outcome): void {
  map.set(cid, outcome)
}

function fromResult(result: PinResult, skipped = false): Outcome {
  const outcome: Outcome = { state: result.state, skipped }
  if (result.error !== undefined) outcome.error = result.error
  if (result.requestId !== undefined) outcome.requestId = result.requestId
  return outcome
}

/* -------------------------------------------------------------------------- */
/* the Kubo half                                                               */
/* -------------------------------------------------------------------------- */

/** Read the node's pin set, or `null` if it could not be read. */
async function safeListPins(
  apiUrl: string,
  signal: AbortSignal | undefined,
  emit: Emitter
): Promise<Set<string> | null> {
  try {
    return await listPins(apiUrl, signal)
  } catch (err) {
    if (isCancellation(err)) throw err
    emit(
      '',
      'kubo',
      'verifying',
      'Could not read what your IPFS node is already keeping, so everything will be offered to it again. ' +
        'That is harmless — pinning something twice does nothing.'
    )
    return null
  }
}

/**
 * Somewhere with room for a copy of the whole archive.
 *
 * Deliberately *not* `os.tmpdir()` by default. On a good many Linux systems
 * `/tmp` is a tmpfs — that is, RAM — and streaming a 1.8 GB backup into it would
 * take the machine down. The archive's own folder is on the volume that already
 * holds those exact bytes, so if the archive fits there, a copy of it plausibly
 * does too. The system temporary folder is kept only as a fallback for an
 * archive sitting on read-only media.
 *
 * The folder is dot-prefixed so it is hidden beside the member's real backups,
 * and it is removed whatever happens — including on failure and cancellation.
 */
async function makeScratchDir(store: ArchiveStore): Promise<string> {
  try {
    return await mkdtemp(join(store.root, '.pin-scratch-'))
  } catch {
    return await mkdtemp(join(tmpdir(), 'bic-archiver-pin-'))
  }
}

/**
 * Get a `.car` of the archive onto disk so it can be streamed into the node.
 *
 * Written to a scratch folder that is deleted afterwards rather than into the
 * archive's `exports/` folder, so a cancelled run never leaves a half-written
 * file among the member's real backup files.
 */
async function exportTemporaryCar(
  store: ArchiveStore,
  emit: Emitter,
  signal: AbortSignal | undefined
): Promise<{ carPath: string; tempDir: string; rootCid: string }> {
  throwIfCancelled(signal)

  let rootText = store.manifest.rootCid?.trim() ?? ''

  if (rootText === '') {
    // Nothing has been assembled yet. Doing it now is exactly what "pin this
    // archive" means, so build it rather than refusing.
    emit('', 'kubo', 'importing', 'Putting the backup folder together first…', 0.01)
    const built = await buildArchiveRoot(store, {
      onProgress: (event: ProgressEvent) => {
        emit('', 'kubo', 'importing', event.message, 0.02)
      },
      ...(signal !== undefined ? { signal } : {})
    })
    rootText = built.toString()
  }

  let root: CID
  try {
    root = CID.parse(rootText)
  } catch (err) {
    throw new Error(
      `This archive records its backup folder as "${rootText}", which is not an address this app can read. ` +
        'Build the backup folder again and try once more.',
      { cause: err }
    )
  }

  const tempDir = await makeScratchDir(store)
  const carPath = join(tempDir, 'archive.car')

  emit('', 'kubo', 'importing', 'Packing the archive into a file your IPFS node can read…', 0.05)

  let lastReport = 0
  const written = await exportCar(root, store.blockstore, carPath, (blocks) => {
    const now = Date.now()
    if (now - lastReport < EXPORT_PROGRESS_INTERVAL_MS) return
    lastReport = now
    emit(
      rootText,
      'kubo',
      'importing',
      `Packing the archive… ${blocks.toLocaleString('en-GB')} pieces so far.`,
      0.05
    )
  })

  // `exportCar` cannot be interrupted part-way, so a member who cancelled during
  // it is honoured here, at the first opportunity, before anything is uploaded.
  throwIfCancelled(signal)

  emit(
    rootText,
    'kubo',
    'importing',
    `Packed ${written.blocks.toLocaleString('en-GB')} pieces (${formatBytes(written.bytes)}).`,
    0.1
  )

  return { carPath, tempDir, rootCid: rootText }
}

/** Bytes as something a member reads without counting digits. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes'
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit] ?? 'bytes'}`
}

/**
 * Step 1: put the archive's blocks inside the node.
 *
 * Returns whether an import actually happened, so the caller knows to re-read
 * the pin list afterwards. A failure here is reported and the run continues:
 * the node may already hold some of this content, and pinning what it does have
 * is better than pinning nothing.
 */
async function importIntoNode(
  apiUrl: string,
  opts: PinRunOptions,
  emit: Emitter,
  alreadyPinned: ReadonlySet<string> | null
): Promise<boolean> {
  const signal = opts.signal
  const explicitCar = opts.carPath?.trim() ?? ''
  const store = opts.store

  if (explicitCar === '' && store === undefined) {
    emit(
      '',
      'kubo',
      'importing',
      'No backup file was given, so your IPFS node can only keep content it already has, or content it ' +
        'can still find on the network. Anything it has to go looking for takes up to two minutes ' +
        'before it gives up, and content that has gone dark will never be found — that can only be ' +
        'brought back from a backup file.'
    )
    return false
  }

  // A repeat run should not push 1.8 GB through the node again for nothing.
  if (explicitCar === '' && store !== undefined) {
    const knownRoot = store.manifest.rootCid?.trim() ?? ''
    if (knownRoot !== '' && alreadyPinned !== null && hasCid(alreadyPinned, knownRoot)) {
      emit(
        knownRoot,
        'kubo',
        'importing',
        'Your IPFS node already has this archive, so there is nothing to import.',
        0.1
      )
      return false
    }
  }

  let carPath = explicitCar
  let tempDir = ''
  let label = ''

  try {
    if (carPath === '' && store !== undefined) {
      const exported = await exportTemporaryCar(store, emit, signal)
      carPath = exported.carPath
      tempDir = exported.tempDir
      label = exported.rootCid
    }

    throwIfCancelled(signal)
    emit(
      label,
      'kubo',
      'importing',
      'Copying the archive into your IPFS node. A large backup takes a while, and this is the step ' +
        'that makes your computer able to share every address in it — including the ones nothing ' +
        'else on the network still has.',
      0.15
    )

    const result = await importCarToKubo(apiUrl, carPath, {
      pinRoots: true,
      ...(signal !== undefined ? { signal } : {})
    })

    const roots = result.roots.length > 0 ? result.roots.join(', ') : ''
    emit(
      result.roots[0] ?? label,
      'kubo',
      'importing',
      `Your IPFS node took in ${result.blocks.toLocaleString('en-GB')} pieces` +
        (roots === '' ? '.' : ` and is now sharing ${roots}.`),
      0.3
    )

    if (result.roots.length === 0) {
      emit(
        label,
        'kubo',
        'importing',
        'That backup file did not name a top folder, so the pieces were stored but nothing was kept ' +
          'automatically. Each address is pinned individually below instead.'
      )
    }

    return true
  } catch (err) {
    if (isCancellation(err)) throw err
    emit(
      label,
      'kubo',
      'error',
      `The archive could not be copied into your IPFS node. ${errorText(err, opts.token)} ` +
        'Pinning will still be attempted for anything the node can already reach.'
    )
    return false
  } finally {
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/** Steps 1 and 2: import, then pin every requested CID on the local node. */
async function runKubo(
  cids: readonly string[],
  status: PinTargetStatus,
  opts: PinRunOptions,
  emit: Emitter,
  outcomes: OutcomeMap
): Promise<void> {
  const signal = opts.signal
  const apiUrl = opts.settings.kubo.apiUrl

  if (!status.available) {
    const detail =
      status.detail ??
      'Your IPFS node could not be reached, so nothing could be kept on this computer.'
    emit('', 'kubo', 'error', detail)
    for (const cid of cids) {
      record(outcomes, cid, { state: 'failed', error: detail, skipped: false })
    }
    return
  }

  if (status.detail !== undefined && status.detail !== '') {
    // Available, but with a caveat worth reading — normally "your node is only
    // reachable on this network, so Pinata cannot fetch from it".
    emit('', 'kubo', 'verifying', status.detail)
  }

  const before = await safeListPins(apiUrl, signal, emit)
  const imported = await importIntoNode(apiUrl, opts, emit, before)

  // After an import the root is pinned recursively, so everything under it is
  // being kept too. Re-reading the list is one request and saves thousands.
  const pinned = imported ? await safeListPins(apiUrl, signal, emit) : before

  let done = 0
  const total = cids.length

  await mapWithConcurrency(cids, DEFAULT_CONCURRENCY, async (cid) => {
    throwIfCancelled(signal)

    if (pinned !== null && hasCid(pinned, cid)) {
      // Importing pins the root recursively, so everything under it is already
      // kept by the time we get here. That is this run's doing, not something
      // that was true beforehand, and reporting it as "skipped" would tell a
      // member nothing happened on the very run that rescued their archive.
      const wasAlreadyKept = before !== null && hasCid(before, cid)
      record(outcomes, cid, { state: 'pinned', skipped: wasAlreadyKept })
      done += 1
      emit(
        cid,
        'kubo',
        'done',
        wasAlreadyKept
          ? 'Your IPFS node was already keeping this.'
          : 'Your IPFS node is now keeping this.',
        done / total
      )
      return
    }

    emit(cid, 'kubo', 'requesting', 'Asking your IPFS node to keep this…', done / total)

    const label = opts.labels?.get(cid)
    const result = await pinCid(apiUrl, cid, {
      recursive: true,
      ...(label !== undefined && label !== '' ? { name: label } : {}),
      ...(signal !== undefined ? { signal } : {})
    })

    record(outcomes, cid, fromResult(result))
    done += 1

    if (result.state === 'pinned') {
      emit(cid, 'kubo', 'done', 'Your IPFS node is now keeping this.', done / total)
    } else {
      emit(cid, 'kubo', 'error', result.error ?? 'Your IPFS node could not keep this.', done / total)
    }
  })
}

/* -------------------------------------------------------------------------- */
/* the Pinata half                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read Pinata's pin list, or `null` if it could not be read.
 *
 * The limit is raised to cover the run rather than left at the module default:
 * this list is the *proof* that a pin landed, and a list that stopped short
 * would report perfectly good pins as missing. Paging stops early on a short
 * page, so asking for headroom costs nothing on a small account.
 */
async function safeListPinnedCids(
  token: string,
  signal: AbortSignal | undefined,
  emit: Emitter,
  limit: number,
  quiet = false
): Promise<Set<string> | null> {
  try {
    return await listPinnedCids(token, {
      limit: Math.max(20_000, limit),
      ...(signal !== undefined ? { signal } : {})
    })
  } catch (err) {
    if (isCancellation(err)) throw err
    if (!quiet) {
      emit('', 'pinata', 'verifying', `Could not read your Pinata pin list. ${errorText(err, token)}`)
    }
    return null
  }
}

/**
 * Which of these CIDs is anybody still providing?
 *
 * Only used when there is no node for Pinata to fetch from. It is the same
 * question Pinata's own pin-by-CID asks — "who has this?" — so a CID with no
 * providers is one Pinata cannot possibly retrieve, whatever it says when it
 * accepts the request. Asking here costs one small lookup per CID and saves
 * queueing thousands of jobs that expire hours later having achieved nothing.
 *
 * A gateway cache hit is deliberately *not* counted as alive: gateways serve
 * bytes to browsers, they do not announce content to the network, so they
 * cannot help Pinata find it.
 */
async function findProvidedCids(
  cids: readonly string[],
  emit: Emitter,
  signal: AbortSignal | undefined
): Promise<Set<string>> {
  const alive = new Set<string>()
  let checked = 0
  const total = cids.length
  if (total === 0) return alive

  emit(
    '',
    'pinata',
    'verifying',
    `Checking which of these ${total.toLocaleString('en-GB')} items anybody on the network still has…`,
    0
  )

  await mapWithConcurrency(cids, HEALTH_CONCURRENCY, async (cid) => {
    throwIfCancelled(signal)
    const providers = await checkProviders(cid, signal)
    checked += 1
    if (providers > 0) {
      alive.add(cid)
      emit(cid, 'pinata', 'verifying', 'Still on the network — Pinata can fetch this.', checked / total)
    } else {
      emit(
        cid,
        'pinata',
        'verifying',
        'Nobody on the network has this any more, so Pinata has nowhere to fetch it from.',
        checked / total
      )
    }
  })

  emit(
    '',
    'pinata',
    'verifying',
    `${alive.size.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} are still on the network.`,
    1
  )

  return alive
}

/** The sentence a member gets when Pinata has no node to fetch from. */
function noHostNodeMessage(kubo: PinTargetStatus, kuboEnabled: boolean): string {
  const preface =
    'Pinata can only pin content that somebody is still sharing on the network. Anything that has gone ' +
    'dark — which is exactly what this archive exists to rescue — cannot be brought back this ' +
    'way, because there is nothing for Pinata to fetch. '

  if (!kuboEnabled) {
    return (
      preface +
      'To rescue those, turn on your own IPFS node in Settings and run this again: the archive is copied ' +
      'into your node first, which gives Pinata somewhere to fetch from. The items that are still on the ' +
      'network will be pinned now.'
    )
  }

  if (!kubo.available) {
    return (
      preface +
      'Your own IPFS node is not running, so there is nothing to fetch from. ' +
      (kubo.detail ?? '') +
      ' Once it is running, run this again and the dead items can be rescued too. The items that are ' +
      'still on the network will be pinned now.'
    )
  }

  return (
    preface +
    'Your IPFS node is running, but nothing outside your own network can reach it, so Pinata cannot ' +
    'fetch from it either. ' +
    (kubo.detail ?? '') +
    ' The items that are still on the network will be pinned now.'
  )
}

/** Steps 3 and 4: ask Pinata to pin, then confirm it really happened. */
async function runPinata(
  cids: readonly string[],
  status: PinTargetStatus,
  kuboStatus: PinTargetStatus,
  hostNodes: readonly string[],
  opts: PinRunOptions,
  emit: Emitter,
  outcomes: OutcomeMap
): Promise<void> {
  const signal = opts.signal
  const token = (opts.token ?? '').trim()

  if (!status.available || token === '') {
    const detail =
      status.detail ?? 'Pinata could not be reached, so no cloud copy was made.'
    emit('', 'pinata', 'error', detail)
    for (const cid of cids) {
      record(outcomes, cid, { state: 'failed', error: detail, skipped: false })
    }
    return
  }

  const already = await safeListPinnedCids(token, signal, emit, cids.length * 2)

  // Without a dialable node, dead content cannot be rescued. Say so once, then
  // work out which items are still retrievable and attempt only those.
  let provided: Set<string> | null = null
  if (hostNodes.length === 0) {
    emit('', 'pinata', 'error', noHostNodeMessage(kuboStatus, opts.settings.kubo.enabled))
    const toCheck = cids.filter((cid) => already === null || !hasCid(already, cid))
    provided = await findProvidedCids(toCheck, emit, signal)
  }

  const deadMessage =
    'Nobody on the network is sharing this any more, so Pinata has nothing to fetch. It can only be ' +
    'brought back by importing the backup into an IPFS node on this computer first — that is what ' +
    'gives Pinata somewhere to get it from.'

  const queued = new Map<string, string>()
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY))
  let done = 0
  const total = cids.length

  await mapWithConcurrency(cids, concurrency, async (cid) => {
    throwIfCancelled(signal)

    if (already !== null && hasCid(already, cid)) {
      record(outcomes, cid, { state: 'pinned', skipped: true })
      done += 1
      emit(cid, 'pinata', 'done', 'Pinata is already keeping this.', done / total)
      return
    }

    if (provided !== null && !provided.has(cid)) {
      record(outcomes, cid, { state: 'failed', error: deadMessage, skipped: false })
      done += 1
      emit(cid, 'pinata', 'error', deadMessage, done / total)
      return
    }

    emit(
      cid,
      'pinata',
      'requesting',
      hostNodes.length > 0
        ? 'Asking Pinata to fetch this from your IPFS node…'
        : 'Asking Pinata to fetch this from the network…',
      done / total
    )

    const label = opts.labels?.get(cid)
    const result = await pinByCid(token, cid, {
      ...(label !== undefined && label !== '' ? { name: label } : {}),
      ...(hostNodes.length > 0 ? { hostNodes: [...hostNodes] } : {}),
      ...(signal !== undefined ? { signal } : {})
    })

    record(outcomes, cid, fromResult(result))
    done += 1

    if (result.state === 'pinning' && result.requestId !== undefined) {
      queued.set(cid, result.requestId)
      emit(cid, 'pinata', 'waiting', 'Pinata has queued this and is fetching it…', done / total)
    } else if (result.state === 'pinned') {
      emit(cid, 'pinata', 'done', 'Pinata is now keeping this.', done / total)
    } else {
      emit(cid, 'pinata', 'error', result.error ?? 'Pinata could not pin this.', done / total)
    }
  })

  if (queued.size > 0) {
    await settleQueuedJobs(queued, token, opts, emit, outcomes)
  }
}

/**
 * Step 4: wait for queued jobs, then check the pin list rather than the queue.
 *
 * "Pinata accepted the request" and "Pinata has the content" are different
 * claims, and only the second one is a backup. The pin list is the authority
 * here; the job queue is used to learn *why* something never arrived, which is
 * where the `expired` verdict lives — the one that tells a member their content
 * is genuinely gone from the network and needs the Kubo route instead.
 */
async function settleQueuedJobs(
  queued: ReadonlyMap<string, string>,
  token: string,
  opts: PinRunOptions,
  emit: Emitter,
  outcomes: OutcomeMap
): Promise<void> {
  const signal = opts.signal
  const maxWaitMs = Math.max(0, Math.floor(opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS))
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY))
  const startedAt = Date.now()

  const pending = new Map(queued)
  let round = 0

  const settle = (cid: string, state: PinState, error?: string): void => {
    const outcome: Outcome = { state, skipped: false }
    if (error !== undefined) outcome.error = error
    const requestId = pending.get(cid)
    if (requestId !== undefined) outcome.requestId = requestId
    record(outcomes, cid, outcome)
    pending.delete(cid)
  }

  while (pending.size > 0 && Date.now() - startedAt < maxWaitMs) {
    const step = POLL_STEPS_MS[round] ?? POLL_STEADY_MS
    round += 1

    emit(
      '',
      'pinata',
      'waiting',
      `Waiting for Pinata to finish fetching ${pending.size.toLocaleString('en-GB')} ` +
        `${pending.size === 1 ? 'item' : 'items'}…`
    )

    await sleep(step, signal)
    throwIfCancelled(signal)

    // With only a handful outstanding, asking about each job individually is
    // both cheap and far more informative: `expired` — "Pinata looked and found
    // nothing" — arrives in seconds instead of at the end of the whole wait.
    // Above that, one pin-list request answers for all of them at once.
    let needsListCheck = pending.size > SMALL_JOB_SET

    if (!needsListCheck) {
      let vanished = 0
      const entries = [...pending.entries()]
      await mapWithConcurrency(entries, concurrency, async ([cid, requestId]) => {
        throwIfCancelled(signal)
        const result = await pinJobResult(token, requestId, {
          cid,
          ...(signal !== undefined ? { signal } : {})
        })
        if (result.state === 'failed') {
          const reason = result.error ?? 'Pinata could not fetch this.'
          settle(cid, 'failed', reason)
          emit(cid, 'pinata', 'error', reason)
        } else if (result.state === 'pinned') {
          settle(cid, 'pinned')
          emit(cid, 'pinata', 'done', 'Pinata has it.')
        } else if (result.state === 'unknown') {
          // A finished job simply drops out of the queue, so this is a hint to
          // go and confirm — never proof on its own.
          vanished += 1
        }
      })
      needsListCheck = vanished > 0
    }

    // The pin list is the proof. `pinning` in the queue is a promise; a row
    // here is the content.
    if (needsListCheck && pending.size > 0) {
      const confirmed = await safeListPinnedCids(token, signal, emit, pending.size * 2, true)
      if (confirmed !== null) {
        for (const cid of [...pending.keys()]) {
          if (hasCid(confirmed, cid)) {
            settle(cid, 'pinned')
            emit(cid, 'pinata', 'done', 'Pinata has it — confirmed in your pin list.')
          }
        }
      }
    }
  }

  if (pending.size === 0) return

  // Time is up. One last look at the pin list, because the most likely reason a
  // job is still "outstanding" is that it finished between rounds.
  const finalList = await safeListPinnedCids(token, signal, emit, pending.size * 2, true)
  if (finalList !== null) {
    for (const cid of [...pending.keys()]) {
      if (hasCid(finalList, cid)) {
        settle(cid, 'pinned')
        emit(cid, 'pinata', 'done', 'Pinata has it — confirmed in your pin list.')
      }
    }
  }

  // Then ask about a bounded number of the stragglers, so the summary carries
  // real reasons rather than a shrug. Bounded because a run of ten thousand
  // items must not end with ten thousand more requests.
  const stragglers = [...pending.entries()].slice(0, JOB_LOOKUP_CAP)
  await mapWithConcurrency(stragglers, concurrency, async ([cid, requestId]) => {
    throwIfCancelled(signal)
    const result = await pinJobResult(token, requestId, {
      cid,
      ...(signal !== undefined ? { signal } : {})
    })
    if (result.state === 'failed') {
      const reason = result.error ?? 'Pinata could not fetch this.'
      settle(cid, 'failed', reason)
      emit(cid, 'pinata', 'error', reason)
    } else if (result.state === 'pinned') {
      settle(cid, 'pinned')
      emit(cid, 'pinata', 'done', 'Pinata has it.')
    }
  })

  // Anything still outstanding is genuinely still in progress. That is not a
  // failure and must not be reported as one — Pinata keeps working after this
  // app stops watching.
  for (const cid of pending.keys()) {
    const requestId = pending.get(cid)
    const outcome: Outcome = {
      state: 'pinning',
      error:
        'Pinata is still fetching this. It carries on in the background — check the pinned list ' +
        'again in a little while to confirm it arrived.',
      skipped: false
    }
    if (requestId !== undefined) outcome.requestId = requestId
    record(outcomes, cid, outcome)
    emit(cid, 'pinata', 'waiting', outcome.error ?? '')
  }
}

/* -------------------------------------------------------------------------- */
/* the run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pin every CID at every destination that is switched on.
 *
 * The order matters and is not negotiable: the archive goes into the local node
 * *first*, because that is what makes the node an actual provider for content
 * the rest of the network has forgotten, and only then is Pinata asked to fetch
 * from it. Doing it the other way round produces a run that looks successful and
 * rescues nothing.
 *
 * A CID is counted `pinned` only when every switched-on destination is keeping
 * it; if one destination failed, the CID is counted as `failed` and the reason
 * is in `failures`, because half a backup is the situation this app exists to
 * end. `skipped` means every destination already had it. Individual failures
 * never stop the run.
 *
 * `failures` is capped at 500 entries so a switched-off destination cannot send
 * ten thousand identical sentences to the GUI; the `failed` count is always
 * exact.
 *
 * @throws An `Error` with `name === 'AbortError'` if `opts.signal` is aborted.
 * Progress events already told the GUI how far the run got.
 */
export async function pinAll(cids: string[], opts: PinRunOptions): Promise<PinRunSummary> {
  const signal = opts.signal
  const emit = makeEmitter(opts.onProgress)
  throwIfCancelled(signal)

  const wanted = dedupeCids(cids)
  if (wanted.length === 0) return emptySummary()

  const kuboEnabled = opts.settings.kubo.enabled
  const pinataEnabled = opts.settings.pinata.enabled

  if (!kuboEnabled && !pinataEnabled) {
    const message =
      'Nothing was pinned because no destination is switched on. Turn on your own IPFS node, or Pinata, ' +
      'or both in Settings — a backup file on its own does not keep anything alive on the network.'
    emit('', 'kubo', 'error', message)
    return {
      requested: wanted.length,
      pinned: 0,
      queued: 0,
      failed: wanted.length,
      skipped: 0,
      failures: wanted.slice(0, MAX_FAILURE_DETAILS).map((cid) => ({
        cid,
        target: 'kubo' as PinTargetId,
        state: 'failed' as PinState,
        error: message
      }))
    }
  }

  const targets = await getTargets(opts.settings, opts.token, signal)
  const kuboStatus =
    targets.find((entry) => entry.target === 'kubo') ??
    ({ target: 'kubo', available: false } satisfies PinTargetStatus)
  const pinataStatus =
    targets.find((entry) => entry.target === 'pinata') ??
    ({ target: 'pinata', available: false } satisfies PinTargetStatus)

  const kuboOutcomes: OutcomeMap = new Map()
  const pinataOutcomes: OutcomeMap = new Map()

  if (kuboEnabled) {
    await runKubo(wanted, kuboStatus, opts, emit, kuboOutcomes)
  }

  if (pinataEnabled) {
    const hostNodes = kuboStatus.available ? (kuboStatus.multiaddrs ?? []) : []
    await runPinata(wanted, pinataStatus, kuboStatus, hostNodes, opts, emit, pinataOutcomes)
  }

  return tally(
    wanted,
    kuboEnabled ? kuboOutcomes : null,
    pinataEnabled ? pinataOutcomes : null,
    emit,
    kuboEnabled ? 'kubo' : 'pinata'
  )
}

/** Fold the per-target outcomes into the one summary the GUI shows. */
function tally(
  cids: readonly string[],
  kubo: OutcomeMap | null,
  pinata: OutcomeMap | null,
  emit: Emitter,
  primary: PinTargetId
): PinRunSummary {
  let pinned = 0
  let queued = 0
  let failed = 0
  let skipped = 0
  const failures: PinResult[] = []

  const addFailure = (cid: string, target: PinTargetId, outcome: Outcome): void => {
    if (failures.length >= MAX_FAILURE_DETAILS) return
    const entry: PinResult = { cid, target, state: 'failed' }
    if (outcome.error !== undefined) entry.error = outcome.error
    if (outcome.requestId !== undefined) entry.requestId = outcome.requestId
    failures.push(entry)
  }

  for (const cid of cids) {
    const parts: Array<{ target: PinTargetId; outcome: Outcome }> = []
    const k = kubo?.get(cid)
    const p = pinata?.get(cid)
    if (k !== undefined) parts.push({ target: 'kubo', outcome: k })
    if (p !== undefined) parts.push({ target: 'pinata', outcome: p })

    if (parts.length === 0) {
      // No destination reported on this CID at all. That should not happen; if
      // it ever does, "we do not know" is a failure, not a success.
      failed += 1
      addFailure(cid, 'kubo', {
        state: 'failed',
        error: 'This item was not offered to any destination. Please try the run again.',
        skipped: false
      })
      continue
    }

    let anyFailed = false
    let anyPending = false
    let allSkipped = true

    for (const part of parts) {
      const state = part.outcome.state
      if (state === 'pinned') {
        if (!part.outcome.skipped) allSkipped = false
      } else if (state === 'pinning') {
        anyPending = true
        allSkipped = false
      } else {
        anyFailed = true
        allSkipped = false
        addFailure(cid, part.target, part.outcome)
      }
    }

    if (anyFailed) failed += 1
    else if (anyPending) queued += 1
    else if (allSkipped) skipped += 1
    else pinned += 1
  }

  const summary: PinRunSummary = {
    requested: cids.length,
    pinned,
    queued,
    failed,
    skipped,
    failures
  }

  emit('', primary, failed > 0 ? 'error' : 'done', summaryMessage(summary), 1)

  return summary
}

/** One sentence a non-technical member can act on. */
function summaryMessage(summary: PinRunSummary): string {
  const safe = summary.pinned + summary.skipped
  const parts: string[] = [
    `${safe.toLocaleString('en-GB')} of ${summary.requested.toLocaleString('en-GB')} items are now being kept`
  ]
  if (summary.queued > 0) {
    parts.push(`${summary.queued.toLocaleString('en-GB')} still arriving`)
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed.toLocaleString('en-GB')} could not be kept`)
  }
  const sentence = parts.join(', ') + '.'
  return summary.failed > 0
    ? `${sentence} The list below says what went wrong for each one.`
    : sentence
}

/**
 * Pin an entire archive: every folder and every file in it, root first.
 *
 * The root CID leads the list on purpose. Pinning it recursively covers the
 * whole archive in one action, so by the time the individual assets come round
 * they are usually already being kept and cost nothing. Each CID is still
 * offered individually afterwards, which is what makes them show up one by one
 * in Pinata's pin list — and therefore what makes it possible to *verify* that a
 * particular NFT's image is safe, rather than assuming it because its parent
 * folder is.
 *
 * `opts.store` is filled in from `store`, and pin labels are derived from each
 * asset's path so the Pinata dashboard reads like the archive rather than like a
 * wall of hashes.
 *
 * @throws A plain-English `Error` when the archive cannot be listed.
 * @throws An `Error` with `name === 'AbortError'` if `opts.signal` is aborted.
 */
export async function pinArchive(store: ArchiveStore, opts: PinRunOptions): Promise<PinRunSummary> {
  const signal = opts.signal
  throwIfCancelled(signal)

  // "Pin this archive" implies assembling it, if that has not happened yet.
  if ((store.manifest.rootCid?.trim() ?? '') === '') {
    const emit = makeEmitter(opts.onProgress)
    emit('', 'kubo', 'importing', 'Putting the backup folder together first…', 0.01)
    await buildArchiveRoot(store, {
      onProgress: (event: ProgressEvent) => {
        emit('', 'kubo', 'importing', event.message, 0.02)
      },
      ...(signal !== undefined ? { signal } : {})
    })
  }

  const rows = await buildAssetRows(store, signal)

  // De-duplicated here rather than by `pinAll` alone, so the label map keeps the
  // first path each CID was seen at — the one a member recognises — and so the
  // root stays at the front of the list.
  const labels = new Map<string, string>()
  const seen = new Set<string>()
  const cids: string[] = []
  for (const row of rows) {
    if (seen.has(row.cid)) continue
    seen.add(row.cid)
    labels.set(row.cid, row.path === '' ? store.manifest.name : row.path)
    cids.push(row.cid)
  }

  return await pinAll(cids, { ...opts, store, labels })
}
