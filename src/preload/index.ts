/**
 * Preload — the *only* bridge between the archive engine (main process) and the
 * window (renderer).
 *
 * The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and
 * Electron's default sandbox. Nothing here hands it `ipcRenderer`, `require`,
 * `process`, or any Node capability: it gets a fixed list of plain functions and
 * nothing else. If a channel is not listed in `ArchiverApi`, the window cannot
 * reach it.
 *
 * This file is also the single source of truth for the *shape* of every IPC
 * call. `src/main/ipc.ts` imports these types (type-only, erased at build time)
 * so the two ends cannot drift, and `src/preload/index.d.ts` re-exports them so
 * the renderer is type-checked against the same contract.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ArchiveManifest,
  ArchivedToken,
  HealthResult,
  ProgressEvent,
  TokenInputSpec,
  TokenRef
} from '../shared/types'
import type {
  AssetRow,
  PinProgress,
  PinRunSummary,
  PinTargetStatus,
  PinningSettings
} from '../shared/pinning'

/* -------------------------------------------------------------------------- */
/* Result contract                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every call resolves — none of them reject. A failure comes back as
 * `{ ok: false, error }` where `error` is a complete, plain-English sentence
 * that is safe to put straight in front of a non-technical DAO member. Stack
 * traces never cross this boundary; they stay in the main-process log.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** The exact wording used whenever a member presses Stop. */
export const CANCELLED_MESSAGE = 'Stopped at your request.'

/* -------------------------------------------------------------------------- */
/* Payload / value shapes                                                     */
/* -------------------------------------------------------------------------- */

/** The open archive: where it lives on disk, and everything it contains. */
export interface ArchiveSnapshot {
  /** Absolute path of the archive folder. */
  dir: string
  manifest: ArchiveManifest
}

/** One row for the health table. */
export interface HealthCheckItem {
  cid: string
  label: string
}

export interface AddTokensResult {
  snapshot: ArchiveSnapshot
  /** Just the tokens touched by this run, in the order they were requested. */
  tokens: ArchivedToken[]
  /** How many of them came back fully archived / partly archived / not at all. */
  okCount: number
  partialCount: number
  failedCount: number
}

export interface BuildRootResult {
  snapshot: ArchiveSnapshot
  /** Root CID of the assembled archive. */
  rootCid: string
}

export interface MergeExistingResult {
  snapshot: ArchiveSnapshot
  /** Root CID of the archive after the older backup was folded in. */
  rootCid: string
  /** The backup CID that was merged. */
  mergedCid: string
}

export interface ExportCarResult {
  /** Absolute path of the `.car` file that was written. */
  path: string
  blocks: number
  bytes: number
}

export interface ExportFolderResult {
  /** Absolute path of the folder that was written. */
  path: string
  files: number
  bytes: number
}

export interface ImportCarResult {
  snapshot: ArchiveSnapshot
  /** Root CIDs the backup file declared, as strings. */
  roots: string[]
  blocks: number
}

export interface HealthCheckResult {
  results: HealthResult[]
  /** True when the member pressed Stop before the sweep finished. */
  cancelled: boolean
}

/**
 * Acknowledgement that a credential change went through.
 *
 * Deliberately says nothing else. A "yes, that worked" is all the window needs,
 * and any richer answer would be a place for the key to leak back out. Call
 * `getSettings()` afterwards to see the resulting `pinata.hasToken`.
 */
export interface TokenResult {
  ok: boolean
}

/** What one `.car` import put into the local Kubo node. */
export interface KuboImportResult {
  /** Root CIDs the backup declared, as strings. Empty for a rootless `.car`. */
  roots: string[]
  /** Blocks the node reports having taken in. */
  blocks: number
}

/** Optional dressing for the native file/folder pickers. */
export interface DialogOptions {
  title?: string
  /** Where the picker should open. */
  defaultPath?: string
  /** Suggested file name, used by the "save backup" picker. */
  defaultName?: string
}

/* -------------------------------------------------------------------------- */
/* The surface exposed on window.api                                          */
/* -------------------------------------------------------------------------- */

export interface ArchiverApi {
  // --- archive workspace ---------------------------------------------------
  /** `archive:create` — start a new archive in an empty folder. */
  createArchive(dir: string, name: string): Promise<IpcResult<ArchiveSnapshot>>
  /** `archive:open` — reopen an archive folder made earlier. */
  openArchive(dir: string): Promise<IpcResult<ArchiveSnapshot>>
  /** `archive:current` — the archive that is open right now, or null. */
  currentArchive(): Promise<IpcResult<ArchiveSnapshot | null>>

  // --- adding tokens -------------------------------------------------------
  /** `archive:parseInput` — turn pasted text into contracts + token numbers. */
  parseInput(text: string): Promise<IpcResult<TokenInputSpec[]>>
  /** `archive:addTokens` — long-running; streams `progress` events. */
  addTokens(specs: TokenInputSpec[], opId?: string): Promise<IpcResult<AddTokensResult>>
  /** `archive:removeToken` — drop one token from the archive. */
  removeToken(ref: TokenRef): Promise<IpcResult<ArchiveSnapshot>>

  // --- assembling ----------------------------------------------------------
  /** `archive:buildRoot` — assemble everything into one root CID. */
  buildRoot(opId?: string): Promise<IpcResult<BuildRootResult>>
  /** `archive:mergeExisting` — fold an older backup CID into this archive. */
  mergeExisting(cid: string, opId?: string): Promise<IpcResult<MergeExistingResult>>

  // --- health --------------------------------------------------------------
  /** `health:check` — long-running; streams `health` events as rows land. */
  checkHealth(items: HealthCheckItem[], opId?: string): Promise<IpcResult<HealthCheckResult>>

  // --- import / export -----------------------------------------------------
  /** `export:car` — write the verifiable `.car` backup. */
  exportCar(outPath: string, opId?: string): Promise<IpcResult<ExportCarResult>>
  /** `export:folder` — write a plain, browsable copy (hashes not preserved). */
  exportFolder(outDir: string, opId?: string): Promise<IpcResult<ExportFolderResult>>
  /** `import:car` — read someone else's `.car` backup into this archive. */
  importCar(inPath: string, opId?: string): Promise<IpcResult<ImportCarResult>>

  // --- pinning settings ----------------------------------------------------
  /**
   * `settings:get` — the member's pinning preferences.
   *
   * `pinata.hasToken` is a boolean and nothing more: the Pinata key itself never
   * crosses this bridge, so the window can show "a key is saved" without ever
   * holding one.
   */
  getSettings(): Promise<IpcResult<PinningSettings>>
  /**
   * `settings:save` — write the preferences and get back the stored result.
   *
   * Any `pinata.hasToken` you send is ignored; the value that comes back is the
   * live answer from the system keychain.
   */
  saveSettings(settings: PinningSettings): Promise<IpcResult<PinningSettings>>
  /**
   * `settings:setPinataToken` — hand the Pinata key to the main process, which
   * puts it straight into the operating system's keychain.
   *
   * This is the one value that travels *into* the main process and never comes
   * back. Pass it straight from the input element and let it go: do not put it
   * in component state, a store, a log line, or anywhere it could end up in a
   * crash report. Fails with a plain-English explanation on a computer that has
   * no secure place to keep a credential.
   */
  setPinataToken(token: string): Promise<IpcResult<TokenResult>>
  /** `settings:clearPinataToken` — forget the saved key completely. */
  clearPinataToken(): Promise<IpcResult<TokenResult>>

  // --- pinning -------------------------------------------------------------
  /**
   * `pin:targets` — which pinning targets are usable right now, and if one is
   * not, a plain-English reason a member can act on.
   */
  pinTargets(opId?: string): Promise<IpcResult<PinTargetStatus[]>>
  /**
   * `pin:assets` — one row per piece of content in the open archive, with its
   * network health and its pin state at each target folded in.
   */
  pinAssets(opId?: string): Promise<IpcResult<AssetRow[]>>
  /**
   * `pin:all` — pin these specific CIDs; streams `pin-progress` events.
   *
   * Pass `carPath` when the content may no longer be on the public network. The
   * backup is imported into the local Kubo node first, which makes that node a
   * real provider for those CIDs — without it, asking Pinata to fetch content
   * nobody hosts cannot work.
   */
  pinAll(cids: string[], carPath?: string, opId?: string): Promise<IpcResult<PinRunSummary>>
  /** `pin:archive` — pin everything in the open archive; streams `pin-progress`. */
  pinArchive(carPath?: string, opId?: string): Promise<IpcResult<PinRunSummary>>
  /**
   * `kubo:importCar` — load a `.car` backup into the local Kubo node, keeping
   * every content ID exactly as it was. Streams `pin-progress` events.
   */
  kuboImportCar(carPath: string, opId?: string): Promise<IpcResult<KuboImportResult>>

  // --- native pickers ------------------------------------------------------
  /** `dialog:pickDirectory` — resolves to null when the member cancels. */
  pickDirectory(options?: DialogOptions): Promise<IpcResult<string | null>>
  /** `dialog:saveCar` — resolves to null when the member cancels. */
  saveCar(options?: DialogOptions): Promise<IpcResult<string | null>>
  /** `dialog:openCar` — resolves to null when the member cancels. */
  openCar(options?: DialogOptions): Promise<IpcResult<string | null>>

  // --- shell ---------------------------------------------------------------
  /** `shell:openPath` — reveal a file or folder the member already chose. */
  openPath(path: string): Promise<IpcResult<null>>
  /** `shell:openExternal` — open an http(s) or mailto link in the browser. */
  openExternal(url: string): Promise<IpcResult<null>>

  // --- cancellation --------------------------------------------------------
  /**
   * `op:cancel` — stop a running operation. Pass the `opId` you handed to
   * `addTokens` / `buildRoot` / … , or omit it to stop everything this window
   * has running. Resolves to how many operations were told to stop.
   */
  cancel(opId?: string): Promise<IpcResult<number>>
  /** Mint an id to pass to a long-running call so you can cancel it later. */
  newOperationId(): string

  // --- streams -------------------------------------------------------------
  /** Subscribe to progress. Returns an unsubscribe function. */
  onProgress(callback: (event: ProgressEvent) => void): () => void
  /** Subscribe to health rows. Returns an unsubscribe function. */
  onHealth(callback: (result: HealthResult) => void): () => void
  /** Subscribe to pinning progress. Returns an unsubscribe function. */
  onPinProgress(callback: (progress: PinProgress) => void): () => void
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `ipcRenderer.invoke` rejects if the channel has no handler or the main process
 * died. Neither is something a member can act on, and a rejected promise in the
 * GUI is an unhandled error dialog waiting to happen — so every call is
 * funnelled into the same `{ ok, error }` shape the handlers already use.
 */
async function call<T>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
  try {
    const result: unknown = await ipcRenderer.invoke(channel, payload)
    if (
      typeof result === 'object' &&
      result !== null &&
      'ok' in (result as Record<string, unknown>)
    ) {
      return result as IpcResult<T>
    }
    return {
      ok: false,
      error: 'The archiver sent back something unexpected. Please restart the app and try again.'
    }
  } catch {
    return {
      ok: false,
      error: 'The archiver stopped responding. Please restart the app and try again.'
    }
  }
}

/**
 * Attach a listener and hand back the matching detach function, so a React
 * effect can clean up without ever seeing `ipcRenderer`. A throwing callback is
 * contained here: one bad render must not tear down the channel for everything
 * else that is still streaming.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    try {
      callback(payload)
    } catch (err) {
      console.error(`[bic-archiver] a "${channel}" listener threw`, err)
    }
  }
  ipcRenderer.on(channel, listener)
  let attached = true
  return () => {
    if (!attached) return
    attached = false
    ipcRenderer.removeListener(channel, listener)
  }
}

let operationCounter = 0

/**
 * Operation ids only need to be unique within one run of the app — they are a
 * correlation handle for cancellation, never a secret — so this deliberately
 * avoids depending on `crypto`, which is not guaranteed in a sandboxed preload.
 */
function newOperationId(): string {
  operationCounter += 1
  const stamp = Date.now().toString(36)
  const seq = operationCounter.toString(36)
  const salt = Math.random().toString(36).slice(2, 8)
  return `op-${stamp}-${seq}-${salt}`
}

const api: ArchiverApi = {
  createArchive: (dir, name) => call<ArchiveSnapshot>('archive:create', { dir, name }),
  openArchive: (dir) => call<ArchiveSnapshot>('archive:open', { dir }),
  currentArchive: () => call<ArchiveSnapshot | null>('archive:current', {}),

  parseInput: (text) => call<TokenInputSpec[]>('archive:parseInput', { text }),
  addTokens: (specs, opId) => call<AddTokensResult>('archive:addTokens', { specs, opId }),
  removeToken: (ref) => call<ArchiveSnapshot>('archive:removeToken', { ref }),

  buildRoot: (opId) => call<BuildRootResult>('archive:buildRoot', { opId }),
  mergeExisting: (cid, opId) => call<MergeExistingResult>('archive:mergeExisting', { cid, opId }),

  checkHealth: (items, opId) => call<HealthCheckResult>('health:check', { items, opId }),

  exportCar: (outPath, opId) => call<ExportCarResult>('export:car', { outPath, opId }),
  exportFolder: (outDir, opId) => call<ExportFolderResult>('export:folder', { outDir, opId }),
  importCar: (inPath, opId) => call<ImportCarResult>('import:car', { inPath, opId }),

  getSettings: () => call<PinningSettings>('settings:get', {}),
  saveSettings: (settings) => call<PinningSettings>('settings:save', { settings }),
  // The key goes over as a plain argument and is never held here: `call` builds
  // the payload inline, so nothing in this file keeps a reference to it.
  setPinataToken: (token) => call<TokenResult>('settings:setPinataToken', { token }),
  clearPinataToken: () => call<TokenResult>('settings:clearPinataToken', {}),

  pinTargets: (opId) => call<PinTargetStatus[]>('pin:targets', { opId }),
  pinAssets: (opId) => call<AssetRow[]>('pin:assets', { opId }),
  pinAll: (cids, carPath, opId) => call<PinRunSummary>('pin:all', { cids, carPath, opId }),
  pinArchive: (carPath, opId) => call<PinRunSummary>('pin:archive', { carPath, opId }),
  kuboImportCar: (carPath, opId) => call<KuboImportResult>('kubo:importCar', { carPath, opId }),

  pickDirectory: (options) => call<string | null>('dialog:pickDirectory', options ?? {}),
  saveCar: (options) => call<string | null>('dialog:saveCar', options ?? {}),
  openCar: (options) => call<string | null>('dialog:openCar', options ?? {}),

  openPath: (path) => call<null>('shell:openPath', { path }),
  openExternal: (url) => call<null>('shell:openExternal', { url }),

  cancel: (opId) => call<number>('op:cancel', { opId }),
  newOperationId,

  onProgress: (callback) => subscribe<ProgressEvent>('progress', callback),
  onHealth: (callback) => subscribe<HealthResult>('health', callback),
  onPinProgress: (callback) => subscribe<PinProgress>('pin-progress', callback)
}

contextBridge.exposeInMainWorld('api', api)
