/**
 * Typed React hooks over `window.api`.
 *
 * Three things shape this file:
 *
 * 1. **Nothing here throws.** Every `window.api` call resolves to
 *    `{ ok, value | error }`, and the hooks keep that contract: a failure ends
 *    up in an `error` string that is already a plain-English sentence, safe to
 *    put straight in front of a non-technical DAO member.
 *
 * 2. **Shared state lives in module-level stores**, read through
 *    `useSyncExternalStore`. Two different views asking `useArchive()` see the
 *    same archive, and a view that finishes archiving can push the new snapshot
 *    to everyone with `setArchiveSnapshot`. No context provider, no state
 *    library.
 *
 * 3. **Progress is subscribed to per row.** A run of several hundred tokens
 *    emits thousands of events; re-rendering the whole list on each one drops
 *    frames. `useProgress()` therefore returns only *structural* information
 *    (which rows exist, how many are done) and changes identity only when that
 *    structure changes, while `useProgressRow(id)` re-renders exactly one row
 *    when that row moves. See {@link ProgressState}.
 *
 * Dependency-free: React and the preload bridge, nothing else.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ArchivedToken, HealthResult, ProgressEvent } from '../shared/types'
import type {
  ArchiveSnapshot,
  ArchiverApi,
  HealthCheckItem,
  HealthCheckResult,
  IpcResult
} from '../preload'

/* ========================================================================== */
/* Reaching the bridge                                                        */
/* ========================================================================== */

/**
 * Shown when `window.api` is not there at all. That only happens if the preload
 * script failed to load, which a member cannot fix from inside the window — so
 * the message tells them the one thing that does help.
 */
const MISSING_API_MESSAGE =
  'This window could not reach the archiver. Please quit BIC Archiver and open it again.'

function missing<T>(): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error: MISSING_API_MESSAGE })
}

let fallbackOperationCounter = 0

/**
 * A stand-in with the same shape as the real bridge. Every call fails politely
 * instead of throwing `undefined is not a function` at a member, which would
 * leave them looking at a blank window with no idea what went wrong.
 */
const FALLBACK_API: ArchiverApi = {
  createArchive: () => missing(),
  openArchive: () => missing(),
  currentArchive: () => missing(),
  parseInput: () => missing(),
  addTokens: () => missing(),
  removeToken: () => missing(),
  buildRoot: () => missing(),
  mergeExisting: () => missing(),
  checkHealth: () => missing(),
  exportCar: () => missing(),
  exportFolder: () => missing(),
  importCar: () => missing(),
  getSettings: () => missing(),
  saveSettings: () => missing(),
  setPinataToken: () => missing(),
  clearPinataToken: () => missing(),
  pinTargets: () => missing(),
  pinAssets: () => missing(),
  pinAll: () => missing(),
  pinArchive: () => missing(),
  kuboImportCar: () => missing(),
  mirrorStatus: () => missing(),
  mirrorCapabilities: () => missing(),
  runMirror: () => missing(),
  listGallery: () => missing(),
  galleryItem: () => missing(),
  nodeStatus: () => missing(),
  installNode: () => missing(),
  startNode: () => missing(),
  stopNode: () => missing(),
  uninstallNode: () => missing(),
  setAutostart: () => missing(),
  checkDrift: () => missing(),
  suggestArchivePath: () => missing(),
  pickDirectory: () => missing(),
  saveCar: () => missing(),
  openCar: () => missing(),
  openPath: () => missing(),
  openExternal: () => missing(),
  cancel: () => missing(),
  newOperationId: () => {
    fallbackOperationCounter += 1
    return `op-unavailable-${String(fallbackOperationCounter)}`
  },
  onProgress: () => () => undefined,
  onHealth: () => () => undefined,
  onPinProgress: () => () => undefined,
  onMirrorProgress: () => () => undefined,
  onNodeProgress: () => () => undefined
}

function looksLikeApi(candidate: unknown): candidate is ArchiverApi {
  if (typeof candidate !== 'object' || candidate === null) return false
  const record = candidate as Record<string, unknown>
  return typeof record['parseInput'] === 'function' && typeof record['onProgress'] === 'function'
}

/**
 * The archive engine, or a polite stand-in.
 *
 * Exported because the components in this folder call it directly, and because
 * a view that needs a channel these hooks do not wrap (`exportCar`, say) should
 * still go through the same guard rather than touching `window.api` raw.
 */
export function getApi(): ArchiverApi {
  const candidate: unknown = (globalThis as unknown as Record<string, unknown>)['api']
  return looksLikeApi(candidate) ? candidate : FALLBACK_API
}

/** True when the preload bridge is actually present. */
export function isApiAvailable(): boolean {
  return looksLikeApi((globalThis as unknown as Record<string, unknown>)['api'])
}

/* ========================================================================== */
/* A minimal external store                                                   */
/* ========================================================================== */

/**
 * The smallest thing `useSyncExternalStore` needs: a value, a way to replace it,
 * and a subscriber list. Values are immutable — every change makes a new object
 * — so React's identity comparison is all the change detection required.
 */
class Store<T> {
  private value: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) {
    this.value = initial
  }

  readonly get = (): T => this.value

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(next: T): void {
    if (Object.is(next, this.value)) return
    this.value = next
    this.notify()
  }

  update(change: (previous: T) => T): void {
    this.set(change(this.value))
  }

  protected notify(): void {
    // Copied first: a listener may unsubscribe while we are walking the set.
    for (const listener of [...this.listeners]) listener()
  }
}

function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/* ========================================================================== */
/* useAsyncAction                                                             */
/* ========================================================================== */

export interface AsyncActionOptions<T> {
  onSuccess?: (value: T) => void
  /** `error` is already a complete, plain-English sentence. */
  onError?: (error: string) => void
}

export interface AsyncAction<A extends readonly unknown[], T> {
  /** Resolves to the value on success, or `undefined` when it failed. */
  run: (...args: A) => Promise<T | undefined>
  pending: boolean
  /** A plain-English sentence, or null. */
  error: string | null
  /** The value from the most recent successful run. */
  value: T | undefined
  reset: () => void
}

interface AsyncActionState<T> {
  pending: boolean
  error: string | null
  value: T | undefined
}

const IDLE_ACTION_STATE = { pending: false, error: null, value: undefined }

/**
 * Drive one `window.api` call: pending flag, plain-English error, last value.
 *
 * ```ts
 * const add = useAsyncAction((specs: TokenInputSpec[]) =>
 *   getApi().addTokens(specs, opId)
 * )
 * await add.run(specs)
 * ```
 *
 * `run` keeps a stable identity even when `fn` is an inline closure, so it is
 * safe in a dependency array. Overlapping runs are handled last-one-wins: an
 * earlier call that resolves late cannot overwrite a later result, and nothing
 * is written to state after unmount.
 */
export function useAsyncAction<A extends readonly unknown[], T>(
  fn: (...args: A) => Promise<IpcResult<T>>,
  options?: AsyncActionOptions<T>
): AsyncAction<A, T> {
  const [state, setState] = useState<AsyncActionState<T>>(IDLE_ACTION_STATE)

  const fnRef = useRef(fn)
  fnRef.current = fn
  const optionsRef = useRef(options)
  optionsRef.current = options

  const mounted = useRef(true)
  const runToken = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (...args: A): Promise<T | undefined> => {
    runToken.current += 1
    const token = runToken.current
    setState((previous) => ({ pending: true, error: null, value: previous.value }))

    let result: IpcResult<T>
    try {
      result = await fnRef.current(...args)
    } catch {
      // window.api never rejects, but a caller's own wrapper might.
      result = {
        ok: false,
        error: 'Something went wrong inside the app. Please try that again.'
      }
    }

    if (!mounted.current || token !== runToken.current) return result.ok ? result.value : undefined

    if (result.ok) {
      setState({ pending: false, error: null, value: result.value })
      optionsRef.current?.onSuccess?.(result.value)
      return result.value
    }

    setState((previous) => ({ pending: false, error: result.error, value: previous.value }))
    optionsRef.current?.onError?.(result.error)
    return undefined
  }, [])

  const reset = useCallback(() => {
    runToken.current += 1
    if (mounted.current) setState(IDLE_ACTION_STATE)
  }, [])

  return useMemo(
    () => ({ run, reset, pending: state.pending, error: state.error, value: state.value }),
    [run, reset, state.pending, state.error, state.value]
  )
}

/* ========================================================================== */
/* useArchive                                                                 */
/* ========================================================================== */

interface ArchiveState {
  snapshot: ArchiveSnapshot | null
  /** True while the archive is being read, opened or created. */
  loading: boolean
  error: string | null
  /** False until the first `currentArchive()` answer has come back. */
  ready: boolean
}

const archiveStore = new Store<ArchiveState>({
  snapshot: null,
  loading: false,
  error: null,
  ready: false
})

let archiveRefreshInFlight: Promise<void> | null = null

/**
 * Publish a snapshot every view should now be looking at.
 *
 * Any call that changes the archive — `addTokens`, `mergeExisting`, `buildRoot`,
 * `importCar`, `removeToken` — hands one back, and pushing it here saves a
 * round trip and keeps two views from disagreeing about what is in the archive.
 */
export function setArchiveSnapshot(snapshot: ArchiveSnapshot | null): void {
  archiveStore.update((previous) => ({
    snapshot,
    loading: previous.loading,
    error: null,
    ready: true
  }))
}

/** Re-read the open archive from the main process. Never rejects. */
export async function refreshArchive(): Promise<void> {
  if (archiveRefreshInFlight !== null) return archiveRefreshInFlight

  const work = (async (): Promise<void> => {
    archiveStore.update((previous) => ({ ...previous, loading: true }))
    const result = await getApi().currentArchive()
    if (result.ok) {
      archiveStore.set({ snapshot: result.value, loading: false, error: null, ready: true })
    } else {
      archiveStore.update((previous) => ({
        snapshot: previous.snapshot,
        loading: false,
        error: result.error,
        ready: true
      }))
    }
  })()

  archiveRefreshInFlight = work.finally(() => {
    archiveRefreshInFlight = null
  })
  return archiveRefreshInFlight
}

const NO_TOKENS: readonly ArchivedToken[] = []

export interface ArchiveController {
  /** The open archive, or null when none is open yet. */
  snapshot: ArchiveSnapshot | null
  /** Convenience: `snapshot.manifest.tokens`, or an empty array. */
  tokens: readonly ArchivedToken[]
  /** Absolute path of the archive folder, or null. */
  dir: string | null
  loading: boolean
  /** False until the first answer has come back — do not say "no archive" yet. */
  ready: boolean
  /** A plain-English sentence, or null. */
  error: string | null
  refresh: () => Promise<void>
  /** Opens an archive folder made earlier. Resolves true on success. */
  open: (dir: string) => Promise<boolean>
  /** Starts a new archive in an empty folder. Resolves true on success. */
  create: (dir: string, name: string) => Promise<boolean>
  /** Publish a snapshot returned by another call. */
  set: (snapshot: ArchiveSnapshot | null) => void
}

async function openArchiveFolder(dir: string): Promise<boolean> {
  archiveStore.update((previous) => ({ ...previous, loading: true, error: null }))
  const result = await getApi().openArchive(dir)
  if (result.ok) {
    archiveStore.set({ snapshot: result.value, loading: false, error: null, ready: true })
    return true
  }
  archiveStore.update((previous) => ({
    snapshot: previous.snapshot,
    loading: false,
    error: result.error,
    ready: true
  }))
  return false
}

async function createArchiveFolder(dir: string, name: string): Promise<boolean> {
  archiveStore.update((previous) => ({ ...previous, loading: true, error: null }))
  const result = await getApi().createArchive(dir, name)
  if (result.ok) {
    archiveStore.set({ snapshot: result.value, loading: false, error: null, ready: true })
    return true
  }
  archiveStore.update((previous) => ({
    snapshot: previous.snapshot,
    loading: false,
    error: result.error,
    ready: true
  }))
  return false
}

/**
 * The archive that is open right now, shared by every component that asks.
 *
 * The first component to mount triggers one `currentArchive()` read; later ones
 * reuse the answer. `ready` distinguishes "we have not looked yet" from "there
 * is genuinely no archive open", so the window never flashes a misleading
 * "no archive" state on start-up.
 */
export function useArchive(): ArchiveController {
  const state = useStore(archiveStore)

  useEffect(() => {
    if (!archiveStore.get().ready) void refreshArchive()
  }, [])

  return useMemo(
    () => ({
      snapshot: state.snapshot,
      tokens: state.snapshot?.manifest.tokens ?? NO_TOKENS,
      dir: state.snapshot?.dir ?? null,
      loading: state.loading,
      ready: state.ready,
      error: state.error,
      refresh: refreshArchive,
      open: openArchiveFolder,
      create: createArchiveFolder,
      set: setArchiveSnapshot
    }),
    [state]
  )
}

/* ========================================================================== */
/* Progress                                                                   */
/* ========================================================================== */

/** The three parts of a token-shaped `ProgressEvent.id`. */
export interface TokenProgressId {
  chainId: number
  /** Lowercase 0x address. */
  contract: string
  /** Decimal string. */
  tokenId: string
}

/**
 * The engine builds a per-token progress id as
 * `chainId:contract:tokenId` (see `progressId` in `archiver.ts`). Whole-archive
 * jobs use the operation id instead, which never matches this shape — that is
 * how a row is told apart from a job.
 */
const TOKEN_PROGRESS_ID_RE = /^(\d{1,10}):(0x[0-9a-fA-F]{40}):(\d{1,78})$/

/** Split a token-shaped progress id, or return null for a job-level id. */
export function parseProgressId(id: string): TokenProgressId | null {
  const match = TOKEN_PROGRESS_ID_RE.exec(id)
  if (match === null) return null
  const chain = match[1]
  const contract = match[2]
  const tokenId = match[3]
  if (chain === undefined || contract === undefined || tokenId === undefined) return null
  const chainId = Number(chain)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null
  return { chainId, contract: contract.toLowerCase(), tokenId }
}

/** The progress id the engine will use for a token — for matching manifest rows. */
export function progressIdFor(ref: {
  chainId: number
  contract: string
  tokenId: string
}): string {
  let tokenId = String(ref.tokenId)
  try {
    tokenId = BigInt(tokenId).toString(10)
  } catch {
    // Leave odd token ids alone; they still group consistently.
  }
  return `${String(ref.chainId)}:${ref.contract.toLowerCase()}:${tokenId}`
}

/** One line of live progress. Immutable: every update makes a new object. */
export interface ProgressRow {
  id: string
  /** Set when this row is about one token; null for whole-archive jobs. */
  token: TokenProgressId | null
  phase: ProgressEvent['phase']
  /** Plain English, straight from the engine. */
  message: string
  /** 0..1, or null when the engine cannot say how far along it is. */
  progress: number | null
  /** Extra context for this exact moment, e.g. the file being downloaded. */
  detail: string | null
  startedAt: number
  updatedAt: number
  finished: boolean
  failed: boolean
}

/**
 * What `useProgress()` returns.
 *
 * Deliberately *not* the rows themselves. This object changes identity only
 * when a row appears, disappears or changes phase — never on a plain progress
 * tick — so a list of several hundred rows is not re-rendered thousands of
 * times during one run. Each row subscribes to its own updates through
 * {@link useProgressRow}.
 */
export interface ProgressState {
  /** Every row id, in the order it was first seen. */
  ids: readonly string[]
  /** Just the rows that are about one token. */
  tokenIds: readonly string[]
  /** Just the whole-archive job rows. */
  jobIds: readonly string[]
  /** Token rows still working, in the order they were first seen. */
  activeIds: readonly string[]
  /** Token rows that failed, in the order they were first seen. */
  failedIds: readonly string[]
  /** Token rows still working. */
  activeCount: number
  /** Token rows that finished successfully. */
  doneCount: number
  /** Token rows that failed. */
  failedCount: number
  /** Token rows in total. */
  total: number
  /** True while anything at all — token or job — is unfinished. */
  busy: boolean
  /** Forget every row. */
  clear: () => void
  /** Forget the finished rows, keep whatever is still working. */
  clearFinished: () => void
  /**
   * Mark everything unfinished as failed, with `reason` as the message. Call
   * this when a run comes back `{ ok: false }`: the engine had no chance to
   * close those rows out, and a spinner that turns forever is worse than a
   * clear "this did not finish".
   */
  failUnfinished: (reason: string) => void
}

class ProgressStore {
  private rows = new Map<string, ProgressRow>()
  private order: string[] = []
  private readonly rowListeners = new Map<string, Set<() => void>>()
  private readonly structuralListeners = new Set<() => void>()
  private readonly jobListeners = new Set<() => void>()
  private cached: ProgressState | null = null
  private latestJob: ProgressRow | null = null
  private attached = false

  /* --- wiring ------------------------------------------------------------ */

  /**
   * Attach to the bridge once and stay attached. Detaching when the last
   * component unmounts would drop the events that arrive while a view is being
   * swapped, and the listener costs nothing when nothing is running.
   */
  readonly attach = (): void => {
    if (this.attached) return
    if (!isApiAvailable()) return
    this.attached = true
    getApi().onProgress(this.handle)
  }

  /* --- reading ----------------------------------------------------------- */

  readonly getState = (): ProgressState => {
    if (this.cached === null) this.cached = this.build()
    return this.cached
  }

  readonly subscribeStructure = (listener: () => void): (() => void) => {
    this.attach()
    this.structuralListeners.add(listener)
    return () => {
      this.structuralListeners.delete(listener)
    }
  }

  readonly getRow = (id: string): ProgressRow | null => this.rows.get(id) ?? null

  readonly subscribeRow = (id: string, listener: () => void): (() => void) => {
    this.attach()
    let set = this.rowListeners.get(id)
    if (set === undefined) {
      set = new Set()
      this.rowListeners.set(id, set)
    }
    set.add(listener)
    return () => {
      const current = this.rowListeners.get(id)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.rowListeners.delete(id)
    }
  }

  readonly getLatestJob = (): ProgressRow | null => this.latestJob

  readonly subscribeJob = (listener: () => void): (() => void) => {
    this.attach()
    this.jobListeners.add(listener)
    return () => {
      this.jobListeners.delete(listener)
    }
  }

  /* --- writing ----------------------------------------------------------- */

  readonly handle = (event: ProgressEvent): void => {
    if (typeof event !== 'object' || event === null) return
    const id = typeof event.id === 'string' && event.id !== '' ? event.id : 'unknown'
    const previous = this.rows.get(id)
    const now = Date.now()
    const phase = event.phase
    const finished = phase === 'done' || phase === 'error'

    let progress: number | null = previous?.progress ?? null
    if (typeof event.progress === 'number' && Number.isFinite(event.progress)) {
      progress = Math.min(1, Math.max(0, event.progress))
    } else if (phase === 'done') {
      progress = 1
    }

    const row: ProgressRow = {
      id,
      token: previous?.token ?? parseProgressId(id),
      phase,
      message: typeof event.message === 'string' ? event.message : '',
      progress,
      detail: typeof event.detail === 'string' && event.detail !== '' ? event.detail : null,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      finished,
      failed: phase === 'error'
    }

    const structural = previous === undefined || previous.phase !== row.phase
    this.commit(row, structural)
  }

  private commit(row: ProgressRow, structural: boolean): void {
    if (!this.rows.has(row.id)) this.order.push(row.id)
    this.rows.set(row.id, row)

    if (row.token === null) {
      this.latestJob = row
      for (const listener of [...this.jobListeners]) listener()
    }

    const listeners = this.rowListeners.get(row.id)
    if (listeners !== undefined) for (const listener of [...listeners]) listener()

    if (structural) this.invalidate()
  }

  readonly clear = (): void => {
    if (this.order.length === 0 && this.latestJob === null) return
    const ids = [...this.order]
    this.rows = new Map()
    this.order = []
    this.latestJob = null
    for (const id of ids) {
      const listeners = this.rowListeners.get(id)
      if (listeners !== undefined) for (const listener of [...listeners]) listener()
    }
    for (const listener of [...this.jobListeners]) listener()
    this.invalidate()
  }

  readonly clearFinished = (): void => {
    const removed: string[] = []
    for (const id of this.order) {
      const row = this.rows.get(id)
      if (row !== undefined && row.finished) removed.push(id)
    }
    if (removed.length === 0) return
    for (const id of removed) this.rows.delete(id)
    this.order = this.order.filter((id) => this.rows.has(id))
    if (this.latestJob !== null && !this.rows.has(this.latestJob.id)) {
      this.latestJob = null
      for (const listener of [...this.jobListeners]) listener()
    }
    for (const id of removed) {
      const listeners = this.rowListeners.get(id)
      if (listeners !== undefined) for (const listener of [...listeners]) listener()
    }
    this.invalidate()
  }

  readonly failUnfinished = (reason: string): void => {
    const message =
      typeof reason === 'string' && reason.trim() !== ''
        ? reason
        : 'This did not finish, and the archiver did not say why.'
    let changed = false
    for (const id of [...this.order]) {
      const row = this.rows.get(id)
      if (row === undefined || row.finished) continue
      changed = true
      this.commit(
        { ...row, phase: 'error', message, updatedAt: Date.now(), finished: true, failed: true },
        false
      )
    }
    if (changed) this.invalidate()
  }

  private invalidate(): void {
    this.cached = null
    for (const listener of [...this.structuralListeners]) listener()
  }

  private build(): ProgressState {
    const ids: string[] = []
    const tokenIds: string[] = []
    const jobIds: string[] = []
    const activeIds: string[] = []
    const failedIds: string[] = []
    let doneCount = 0
    let busy = false

    for (const id of this.order) {
      const row = this.rows.get(id)
      if (row === undefined) continue
      ids.push(id)
      if (!row.finished) busy = true
      if (row.token === null) {
        jobIds.push(id)
        continue
      }
      tokenIds.push(id)
      if (row.phase === 'done') doneCount += 1
      else if (row.phase === 'error') failedIds.push(id)
      else activeIds.push(id)
    }

    return {
      ids,
      tokenIds,
      jobIds,
      activeIds,
      failedIds,
      activeCount: activeIds.length,
      doneCount,
      failedCount: failedIds.length,
      total: tokenIds.length,
      busy,
      clear: this.clear,
      clearFinished: this.clearFinished,
      failUnfinished: this.failUnfinished
    }
  }
}

const progressStore = new ProgressStore()

/**
 * Live progress for the whole window: which rows exist and how they are doing.
 *
 * Returns structure only — see {@link ProgressState} for why, and use
 * {@link useProgressRow} to render an individual row.
 */
export function useProgress(): ProgressState {
  return useSyncExternalStore(
    progressStore.subscribeStructure,
    progressStore.getState,
    progressStore.getState
  )
}

/**
 * One row of progress, re-rendering only when *that* row moves.
 *
 * `id` may be null — for a job whose operation id is not known yet — in which
 * case this returns null and subscribes to nothing.
 */
export function useProgressRow(id: string | null | undefined): ProgressRow | null {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      if (id === null || id === undefined) return () => undefined
      return progressStore.subscribeRow(id, listener)
    },
    [id]
  )
  const snapshot = useCallback(
    (): ProgressRow | null =>
      id === null || id === undefined ? null : progressStore.getRow(id),
    [id]
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * The most recent whole-archive progress line — "Putting the archive
 * together…", "Looking for the older backup on IPFS…" — as opposed to the
 * per-token rows. Useful as a headline above the list.
 */
export function useLatestJobProgress(): ProgressRow | null {
  return useSyncExternalStore(
    progressStore.subscribeJob,
    progressStore.getLatestJob,
    progressStore.getLatestJob
  )
}

/** Forget every progress row. */
export function clearProgress(): void {
  progressStore.clear()
}

/** Forget the finished progress rows, keep whatever is still working. */
export function clearFinishedProgress(): void {
  progressStore.clearFinished()
}

/**
 * Close out every unfinished row with `reason`. Call it when a long-running
 * call comes back `{ ok: false }` — including a cancellation — so no row is
 * left spinning after the run it belonged to has ended.
 */
export function failUnfinishedProgress(reason: string): void {
  progressStore.failUnfinished(reason)
}

/* ========================================================================== */
/* Health                                                                     */
/* ========================================================================== */

interface HealthStoreState {
  results: readonly HealthResult[]
  byCid: ReadonlyMap<string, HealthResult>
  running: boolean
  /** True when the last sweep was stopped early. */
  cancelled: boolean
  error: string | null
}

const EMPTY_HEALTH: HealthStoreState = {
  results: [],
  byCid: new Map(),
  running: false,
  cancelled: false,
  error: null
}

const healthStore = new Store<HealthStoreState>(EMPTY_HEALTH)

let healthAttached = false
let healthOpId: string | null = null

function attachHealth(): void {
  if (healthAttached || !isApiAvailable()) return
  healthAttached = true
  getApi().onHealth((result) => {
    if (typeof result !== 'object' || result === null || typeof result.cid !== 'string') return
    healthStore.update((previous) => {
      const byCid = new Map(previous.byCid)
      const existed = byCid.has(result.cid)
      byCid.set(result.cid, result)
      const results = existed
        ? previous.results.map((row) => (row.cid === result.cid ? result : row))
        : [...previous.results, result]
      return { ...previous, results, byCid }
    })
  })
}

export interface HealthController {
  /** One row per CID checked, in the order the answers arrived. */
  results: readonly HealthResult[]
  byCid: ReadonlyMap<string, HealthResult>
  running: boolean
  /** True when the last sweep was stopped early. */
  cancelled: boolean
  error: string | null
  /** Check a batch. Streams rows into `results` as they land. */
  check: (items: HealthCheckItem[]) => Promise<HealthCheckResult | undefined>
  /** Stop a sweep that is running. */
  cancel: () => Promise<void>
  clear: () => void
}

async function runHealthCheck(items: HealthCheckItem[]): Promise<HealthCheckResult | undefined> {
  attachHealth()
  const opId = getApi().newOperationId()
  healthOpId = opId
  healthStore.update((previous) => ({ ...previous, running: true, cancelled: false, error: null }))

  const result = await getApi().checkHealth(items, opId)
  if (healthOpId === opId) healthOpId = null

  if (result.ok) {
    healthStore.update((previous) => {
      const byCid = new Map(previous.byCid)
      const results = [...previous.results]
      for (const row of result.value.results) {
        const index = results.findIndex((existing) => existing.cid === row.cid)
        if (index === -1) results.push(row)
        else results[index] = row
        byCid.set(row.cid, row)
      }
      return {
        results,
        byCid,
        running: false,
        cancelled: result.value.cancelled,
        error: previous.error
      }
    })
    return result.value
  }

  healthStore.update((previous) => ({
    ...previous,
    running: false,
    error: result.error
  }))
  return undefined
}

async function cancelHealthCheck(): Promise<void> {
  const opId = healthOpId
  if (opId === null) return
  await getApi().cancel(opId)
}

function clearHealth(): void {
  healthStore.set(EMPTY_HEALTH)
}

/**
 * The health table: "is this content still out there?".
 *
 * Rows stream in through the `health` channel as each CID is probed, so a long
 * sweep fills the table gradually instead of sitting blank for a minute.
 */
export function useHealth(): HealthController {
  const state = useStore(healthStore)

  useEffect(() => {
    attachHealth()
  }, [])

  return useMemo(
    () => ({
      results: state.results,
      byCid: state.byCid,
      running: state.running,
      cancelled: state.cancelled,
      error: state.error,
      check: runHealthCheck,
      cancel: cancelHealthCheck,
      clear: clearHealth
    }),
    [state]
  )
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/**
 * `value`, but only after it has stopped changing for `delayMs`.
 *
 * Used for the live preview of what a member is pasting: parsing on every
 * keystroke would fire an IPC call per character.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    if (Object.is(value, debounced)) return undefined
    const timer = setTimeout(() => {
      setDebounced(value)
    }, Math.max(0, delayMs))
    return () => {
      clearTimeout(timer)
    }
  }, [value, delayMs, debounced])

  return debounced
}
