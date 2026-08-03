/**
 * Every IPC handler the window can reach.
 *
 * Three rules hold for every handler in this file, without exception:
 *
 *  1. It resolves, never rejects. The result is always the discriminated shape
 *     `{ ok: true, value } | { ok: false, error }`.
 *  2. `error` is a finished, plain-English sentence. A DAO member should be able
 *     to read it and know what to do next. Stack traces, error codes and library
 *     jargon stay in the main-process log.
 *  3. Anything that touches the network or the disk can be stopped. Long jobs
 *     take an `opId`, hold an `AbortController`, and stream `progress` events so
 *     the window is never a frozen rectangle.
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { CID } from 'multiformats/cid'

import type {
  ArchiveManifest,
  ArchivedToken,
  HealthResult,
  ProgressEvent,
  TokenInputSpec,
  TokenRef
} from '../shared/types'
import type {
  AddTokensResult,
  ArchiveSnapshot,
  BuildRootResult,
  ExportCarResult,
  ExportFolderResult,
  HealthCheckItem,
  HealthCheckResult,
  ImportCarResult,
  IpcResult,
  MergeExistingResult
} from '../preload/index'

/* ========================================================================== */
/* ENGINE BINDING                                                             */
/* -------------------------------------------------------------------------- */
/* The only place this file talks to the archive engine. Everything below this */
/* block is written against the local helpers, so if an engine signature moves */
/* this is the region to reconcile — nothing else.                             */
/*                                                                             */
/* The engine persists as it goes — `archiveMany` calls `store.addToken` per    */
/* token, `buildArchiveRoot` calls `store.setRootCid`, `mergeExistingBackup`    */
/* calls `store.addImportedRoot` — and each of those saves the manifest. So     */
/* this file does NOT record those facts a second time; it reads them back off  */
/* `store.manifest`, which is the live object. The one thing it does own is     */
/* invalidating `rootCid` when the contents change, because adding a token does */
/* not clear the previously assembled root and nothing else does it.            */
/*                                                                             */
/* `buildArchiveRoot` returns a `CID` and `mergeExistingBackup` returns `void`, */
/* so both are read as `unknown` and normalised by `asCidString`, falling back  */
/* to `manifest.rootCid`. Only the *arguments* are load-bearing.                */
/* ========================================================================== */

import { archiveMany, buildArchiveRoot, mergeExistingBackup } from './archive/archiver'
import { ArchiveStore } from './archive/store'
import { parseTokenInput, sanitizeFolderName } from './archive/inputs'
import { checkMany } from './health/check'
import { exportBrowsableFolder, exportCar, importCar } from './ipfs/car'

/** What the engine functions accept alongside their positional arguments. */
interface EngineRunOptions {
  signal?: AbortSignal
  onProgress?: (event: ProgressEvent) => void
}

/* ========================================================================== */
/* Tunables                                                                   */
/* ========================================================================== */

/**
 * Progress can arrive far faster than a human can read it — the CAR exporter
 * reports every block. Coalescing to ~16 updates a second per token keeps the
 * window responsive without ever dropping a `done` or `error`.
 */
const MIN_PROGRESS_INTERVAL_MS = 60

/**
 * A ceiling on one "Archive these" click. `parseTokenInput` already refuses a
 * single range over 10 000; this is the second gate, because 10 000 tokens is
 * hours of network time and a member who typed an extra zero should be told,
 * not left watching a bar for an afternoon.
 */
const MAX_TOKENS_PER_RUN = 1000

/** A ceiling on one health sweep, for the same reason. */
const MAX_HEALTH_ITEMS = 5000

const CANCELLED_MESSAGE = 'Stopped at your request.'

/* ========================================================================== */
/* Plain-English errors                                                       */
/* ========================================================================== */

/**
 * An error whose message is already written for a member. The engine modules
 * mark theirs `ArchiverError` too, and both pass through `toPlainMessage`
 * untouched.
 */
function plain(message: string): Error {
  const err = new Error(message)
  err.name = 'ArchiverError'
  return err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** Operating-system failures, translated out of errno-speak. */
const FS_MESSAGES: Record<string, string> = {
  ENOENT: 'That file or folder is not there any more. Check the location and try again.',
  EACCES:
    "This app is not allowed to use that location. Pick a folder you own — somewhere in Documents or on the Desktop — and try again.",
  EPERM:
    "This app is not allowed to use that location. Pick a folder you own — somewhere in Documents or on the Desktop — and try again.",
  EROFS: 'That location is read-only. Choose somewhere you can save files and try again.',
  ENOSPC: 'There is not enough free space on the disk to finish this. Free some space and try again.',
  EDQUOT: 'You have run out of storage quota on that disk. Free some space and try again.',
  EEXIST: 'Something with that name is already there. Choose a different name.',
  ENOTDIR: 'Part of that location is a file, not a folder. Check the path and try again.',
  EISDIR: 'That is a folder, not a file. Choose a file and try again.',
  EBUSY: 'That file is being used by another program. Close it and try again.',
  ENOTEMPTY: 'That folder is not empty. Choose an empty folder or a new one.',
  EMFILE: 'Too many files are open at once. Close some other apps and try again.',
  ENFILE: 'Too many files are open at once. Close some other apps and try again.',
  ELOOP: 'That location points at itself in a loop. Choose a different folder.',
  ENAMETOOLONG: 'That name is too long for this disk. Use a shorter name.',
  ECONNREFUSED: 'The internet connection was refused. Check your connection and try again.',
  ECONNRESET: 'The connection dropped part-way through. Check your connection and try again.',
  ENOTFOUND: 'Could not reach that server. Check your internet connection and try again.',
  EAI_AGAIN: 'Could not look up that address. Check your internet connection and try again.',
  ENETUNREACH: 'There seems to be no internet connection right now. Reconnect and try again.',
  ETIMEDOUT: 'The connection timed out. Check your internet connection and try again.'
}

/**
 * Would a member understand this sentence? Library and runtime errors leak
 * things like "Cannot read properties of undefined" or a stack frame; those get
 * swapped for a plain fallback instead of being shown.
 */
function looksPlainEnglish(text: string): boolean {
  // The ceiling is deliberately generous. The engine's most valuable messages
  // are its longest: when the DAO's own backup CID has fallen off the network,
  // `mergeExistingBackup` explains what happened, why, and exactly what to ask
  // other members for — around 500 characters of genuinely useful advice. An
  // earlier 400-character limit silently replaced that with "something went
  // wrong", which is the opposite of what this app is for. Pasted stack dumps
  // are caught by the patterns below, not by length.
  if (text.length < 8 || text.length > 1200) return false
  if (!text.includes(' ')) return false
  if (/\sat\s\S+\s\(|\sat\s\/|node_modules|\.[tj]sx?:\d+/.test(text)) return false
  if (/^[A-Za-z]*Error\b/.test(text)) return false
  if (
    /Cannot read propert|is not a function|is not iterable|is not defined|undefined is not|null is not|Assignment to constant|Maximum call stack|Invalid array length|Converting circular/.test(
      text
    )
  ) {
    return false
  }
  return true
}

/**
 * The single funnel every failure passes through on its way to the window.
 *
 * @param action a gerund phrase naming what failed, e.g. "saving the backup".
 */
function toPlainMessage(err: unknown, action: string): string {
  if (isAbortError(err)) {
    // A handler may have tailored the wording (see `runOperation`'s
    // `cancelMessage`); anything else — an engine's internal "aborted", a
    // fetch's "The operation was aborted" — becomes the plain constant.
    const own = err instanceof Error ? err.message.replace(/\s+/g, ' ').trim() : ''
    return own.startsWith(CANCELLED_MESSAGE) ? own : CANCELLED_MESSAGE
  }

  // The full error is for whoever is debugging, never for the member.
  console.error(`[bic-archiver] failed while ${action}:`, err)

  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (typeof code === 'string') {
      const known = FS_MESSAGES[code]
      if (known !== undefined) return known
    }
    // Collapse rather than truncate at the first line: an `Error.message` never
    // carries the stack (that lives on `.stack`), so a newline in there is
    // deliberate formatting, and cutting at it would throw away the half of the
    // message that tells the member what to do.
    const flattened = err.message.replace(/\s+/g, ' ').trim()
    if (looksPlainEnglish(flattened)) return flattened
  }

  if (typeof err === 'string') {
    const flattened = err.replace(/\s+/g, ' ').trim()
    if (looksPlainEnglish(flattened)) return flattened
  }

  return `Something went wrong while ${action}. Please try again — and if it keeps happening, note what you were doing and tell the team.`
}

/* ========================================================================== */
/* Serialisation                                                              */
/* ========================================================================== */

/**
 * Electron's IPC uses the structured clone algorithm, which throws on class
 * instances with private state and on BigInt in older channels. A JSON round
 * trip guarantees whatever we hand back is plain, cloneable data.
 */
function toSerializable<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item))
  ) as T
}

/**
 * Read a CID out of whatever the engine handed back — a string, a multiformats
 * `CID`, or a `{ cid }` / `{ root }` / `{ rootCid }` wrapper. Returns null when
 * there is nothing CID-shaped in there.
 */
function asCidString(value: unknown, depth = 0): string | null {
  if (depth > 4) return null

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }

  if (typeof value !== 'object' || value === null) return null

  const record = value as Record<string, unknown>

  // multiformats' CID.toJSON() shape.
  const slash = record['/']
  if (typeof slash === 'string' && slash !== '') return slash

  for (const key of ['rootCid', 'root', 'cid']) {
    if (key in record) {
      const nested = asCidString(record[key], depth + 1)
      if (nested !== null) return nested
    }
  }

  // A real CID instance stringifies to its base-encoded form.
  const printed = String(value).trim()
  if (printed !== '' && printed !== '[object Object]') {
    try {
      CID.parse(printed)
      return printed
    } catch {
      return null
    }
  }

  return null
}

/* ========================================================================== */
/* Streaming: progress + health                                               */
/* ========================================================================== */

function cleanProgressEvent(event: ProgressEvent): ProgressEvent {
  const cleaned: ProgressEvent = {
    id: typeof event.id === 'string' && event.id !== '' ? event.id : 'unknown',
    phase: event.phase,
    message: typeof event.message === 'string' ? event.message : ''
  }
  if (typeof event.progress === 'number' && Number.isFinite(event.progress)) {
    cleaned.progress = Math.min(1, Math.max(0, event.progress))
  }
  if (typeof event.detail === 'string' && event.detail !== '') cleaned.detail = event.detail
  return cleaned
}

/**
 * Coalesces progress per token id. A `done` or `error` always goes out
 * immediately — those are the events the GUI uses to close a row out, and
 * dropping one would leave a spinner turning forever.
 */
class ProgressPump {
  private readonly pending = new Map<string, ProgressEvent>()
  private readonly lastSentAt = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly sender: WebContents) {}

  readonly push = (event: ProgressEvent): void => {
    if (this.disposed) return
    const cleaned = cleanProgressEvent(event)
    const terminal = cleaned.phase === 'done' || cleaned.phase === 'error'
    const now = Date.now()
    const last = this.lastSentAt.get(cleaned.id) ?? 0

    if (terminal || now - last >= MIN_PROGRESS_INTERVAL_MS) {
      this.pending.delete(cleaned.id)
      this.lastSentAt.set(cleaned.id, now)
      this.emit(cleaned)
      return
    }

    this.pending.set(cleaned.id, cleaned)
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, MIN_PROGRESS_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  flush(): void {
    if (this.pending.size === 0) return
    const now = Date.now()
    const queued = [...this.pending.values()]
    this.pending.clear()
    for (const event of queued) {
      this.lastSentAt.set(event.id, now)
      this.emit(event)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.flush()
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    this.lastSentAt.clear()
  }

  private emit(event: ProgressEvent): void {
    if (this.sender.isDestroyed()) return
    try {
      this.sender.send('progress', event)
    } catch (err) {
      console.error('[bic-archiver] could not deliver a progress update', err)
    }
  }
}

function sendHealth(sender: WebContents, result: HealthResult): void {
  if (sender.isDestroyed()) return
  try {
    sender.send('health', toSerializable(result))
  } catch (err) {
    console.error('[bic-archiver] could not deliver a health result', err)
  }
}

/* ========================================================================== */
/* Operations + cancellation                                                  */
/* ========================================================================== */

interface Operation {
  id: string
  /** Gerund phrase, reused in the "still busy" message. */
  label: string
  controller: AbortController
  webContentsId: number
  startedAt: number
}

const operations = new Map<string, Operation>()

interface RunContext {
  /** The operation id, also used as the ProgressEvent id for whole-archive jobs. */
  id: string
  signal: AbortSignal
  progress: (event: ProgressEvent) => void
  /** Convenience: throws the cancellation error if the member pressed Stop. */
  throwIfCancelled: () => void
}

function normalizeOpId(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '' && trimmed.length <= 128) return trimmed
  }
  return `op-${randomUUID()}`
}

/**
 * Wrap a long job: register a controller so `op:cancel` can reach it, give it a
 * progress pump, and make sure both are torn down however it ends.
 */
async function runOperation<T>(
  event: IpcMainInvokeEvent,
  rawOpId: unknown,
  label: string,
  body: (ctx: RunContext) => Promise<T>,
  /** Overrides the wording shown when the member presses Stop. */
  cancelMessage: string = CANCELLED_MESSAGE
): Promise<T> {
  const id = normalizeOpId(rawOpId)
  if (operations.has(id)) {
    throw plain('That job is already running. Wait for it to finish, or press Stop.')
  }

  const controller = new AbortController()
  const sender = event.sender
  const pump = new ProgressPump(sender)

  const operation: Operation = {
    id,
    label,
    controller,
    webContentsId: sender.id,
    startedAt: Date.now()
  }
  operations.set(id, operation)

  const ctx: RunContext = {
    id,
    signal: controller.signal,
    progress: pump.push,
    throwIfCancelled: () => {
      if (controller.signal.aborted) {
        const err = new Error(cancelMessage)
        err.name = 'AbortError'
        throw err
      }
    }
  }

  try {
    return await body(ctx)
  } catch (err) {
    // Not every engine function propagates AbortError verbatim — some wrap it,
    // and `exportCar` surfaces cancellation as a write failure. If the member
    // pressed Stop, that is the only explanation worth showing them.
    if (controller.signal.aborted) {
      const cancelled = new Error(cancelMessage)
      cancelled.name = 'AbortError'
      throw cancelled
    }
    throw err
  } finally {
    pump.dispose()
    operations.delete(id)
  }
}

/** Stop one operation, every operation belonging to one window, or all of them. */
function cancelOperations(filter: { opId?: string; webContentsId?: number }): number {
  let stopped = 0
  for (const operation of operations.values()) {
    if (filter.opId !== undefined && operation.id !== filter.opId) continue
    if (filter.webContentsId !== undefined && operation.webContentsId !== filter.webContentsId) continue
    if (!operation.controller.signal.aborted) {
      operation.controller.abort()
      stopped += 1
    }
  }
  return stopped
}

/** Called from the main process on window close and on quit. */
export function cancelAllOperations(): number {
  return cancelOperations({})
}

/* ========================================================================== */
/* The open archive                                                           */
/* ========================================================================== */

let store: ArchiveStore | null = null
/** Tracked here rather than read off the store, so the store surface stays small. */
let storeDir: string | null = null
/** Non-null while a job that mutates the archive is in flight. */
let mutating: string | null = null

function requireStore(): ArchiveStore {
  if (store === null || storeDir === null) {
    throw plain(
      'No archive is open yet. Start a new archive, or open a folder you archived to earlier, and then try again.'
    )
  }
  return store
}

/**
 * Two jobs writing the manifest at once would lose one of them. Rather than
 * queue silently — which looks like the app has hung — the second one says so.
 */
async function withArchiveLock<T>(label: string, body: () => Promise<T>): Promise<T> {
  if (mutating !== null) {
    throw plain(`The archiver is busy ${mutating}. Wait for that to finish, or press Stop, then try again.`)
  }
  mutating = label
  try {
    return await body()
  } finally {
    mutating = null
  }
}

function normalizeManifest(manifest: ArchiveManifest): ArchiveManifest {
  const clone = toSerializable(manifest)
  const root = asCidString(manifest.rootCid)
  if (root !== null) {
    clone.rootCid = root
  } else {
    delete clone.rootCid
  }
  clone.importedRoots = (Array.isArray(manifest.importedRoots) ? manifest.importedRoots : [])
    .map((entry) => asCidString(entry))
    .filter((entry): entry is string => entry !== null)
  if (!Array.isArray(clone.tokens)) clone.tokens = []
  return clone
}

function snapshot(): ArchiveSnapshot {
  const open = requireStore()
  return { dir: storeDir as string, manifest: normalizeManifest(open.manifest) }
}

function touchManifest(manifest: ArchiveManifest): void {
  manifest.updatedAt = new Date().toISOString()
}

/**
 * Identity of one token, matching `ArchiveStore`'s own comparison: the address
 * is case-insensitive and the id is compared numerically, so "007" and "7" are
 * the same token. Diverging from the store here would let the same NFT appear
 * twice in a member's archive.
 */
function tokenKey(ref: Pick<TokenRef, 'chainId' | 'contract' | 'tokenId'>): string {
  const raw = String(ref.tokenId)
  let tokenId = raw
  try {
    tokenId = BigInt(raw).toString(10)
  } catch {
    // Non-numeric ids are unusual but must still group consistently.
  }
  return `${ref.chainId}:${String(ref.contract).toLowerCase()}:${tokenId}`
}

/**
 * Fold this run's results into the manifest.
 *
 * `archiveMany` already persists each token as it lands, so this is normally a
 * no-op — but its failure path swallows a manifest write error, and a token the
 * member can see in the GUI but not in the manifest is worse than a redundant
 * write. Upsert (never append) keeps it idempotent.
 */
function upsertTokens(manifest: ArchiveManifest, tokens: ArchivedToken[]): void {
  if (!Array.isArray(manifest.tokens)) manifest.tokens = []
  const index = new Map<string, number>()
  manifest.tokens.forEach((existing, position) => {
    if (existing?.ref) index.set(tokenKey(existing.ref), position)
  })
  for (const token of tokens) {
    if (!token?.ref) continue
    const key = tokenKey(token.ref)
    const position = index.get(key)
    if (position === undefined) {
      index.set(key, manifest.tokens.length)
      manifest.tokens.push(token)
    } else {
      manifest.tokens[position] = token
    }
  }
}

/**
 * The contents changed, so any root CID built earlier no longer describes this
 * archive. Clearing it means the GUI can never show a stale hash as if it were
 * the backup's fingerprint.
 */
function invalidateRoot(manifest: ArchiveManifest): void {
  delete manifest.rootCid
}

/**
 * Refuse to assemble or export an archive with nothing in it.
 *
 * Only ever called from *inside* the archive lock: a job that is halfway
 * through adding tokens has not written them to the manifest yet, so checking
 * beforehand would tell a member their archive is empty when it is actually
 * busy filling up.
 */
function requireContents(manifest: ArchiveManifest): void {
  const tokens = Array.isArray(manifest.tokens) ? manifest.tokens.length : 0
  const imported = Array.isArray(manifest.importedRoots) ? manifest.importedRoots.length : 0
  if (tokens === 0 && imported === 0) {
    throw plain('There is nothing in this archive yet. Add some tokens first, then try again.')
  }
}

async function closeCurrentStore(): Promise<void> {
  const open = store
  store = null
  storeDir = null
  if (open === null) return
  try {
    await open.close()
  } catch (err) {
    // Failing to close cleanly must not stop the member opening another
    // archive; the blockstore is crash-safe either way.
    console.error('[bic-archiver] could not close the previous archive cleanly', err)
  }
}

/* ========================================================================== */
/* Paths the member has actually chosen                                       */
/* ========================================================================== */

/**
 * `shell.openPath` hands a path to the operating system, so it is only ever
 * given somewhere the member picked themselves: the archive folder, or a file
 * that came back from one of the native dialogs. Nothing the renderer invents
 * on its own gets opened.
 */
const approvedPaths = new Set<string>()

function approvePath(target: string): void {
  const absolute = resolve(target)
  approvedPaths.add(absolute)
  // So "show me where it saved" works on the containing folder too.
  const parent = dirname(absolute)
  if (parent !== absolute) approvedPaths.add(parent)
}

function isApproved(target: string): boolean {
  const absolute = resolve(target)
  for (const base of approvedPaths) {
    if (absolute === base) return true
    const prefix = base.endsWith(sep) ? base : base + sep
    if (absolute.startsWith(prefix)) return true
  }
  return false
}

/* ========================================================================== */
/* Payload validation                                                         */
/* ========================================================================== */

function asRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return {}
}

function readString(payload: unknown, field: string, description: string): string {
  const value = asRecord(payload)[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw plain(`${description} is missing. Please fill it in and try again.`)
  }
  return value.trim()
}

function readOptionalString(payload: unknown, field: string): string | undefined {
  const value = asRecord(payload)[field]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function readPath(payload: unknown, field: string, description: string): string {
  const raw = readString(payload, field, description)
  const absolute = isAbsolute(raw) ? raw : resolve(raw)
  if (absolute.includes('\0')) {
    throw plain(`${description} contains characters that are not allowed in a file name.`)
  }
  return absolute
}

function readSpecs(payload: unknown): TokenInputSpec[] {
  const raw = asRecord(payload)['specs']
  if (!Array.isArray(raw) || raw.length === 0) {
    throw plain('No tokens were selected. Paste a contract address with the token numbers you want, then try again.')
  }
  return raw.map((entry, position) => {
    const record = asRecord(entry)
    const chainId = record['chainId']
    const contract = record['contract']
    const tokenIds = record['tokenIds']
    if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
      throw plain(`Entry ${position + 1} does not say which network it is on. Please re-enter it and try again.`)
    }
    if (typeof contract !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(contract.trim())) {
      throw plain(`Entry ${position + 1} does not have a valid contract address. It should start with "0x" and be 42 characters long.`)
    }
    if (!Array.isArray(tokenIds) || tokenIds.some((id) => typeof id !== 'string')) {
      throw plain(`Entry ${position + 1} has token numbers the archiver could not read. Please re-enter them and try again.`)
    }
    return {
      chainId,
      contract: contract.trim().toLowerCase(),
      tokenIds: (tokenIds as string[]).map((id) => id.trim()).filter((id) => id !== '')
    }
  })
}

function readTokenRef(payload: unknown): TokenRef {
  const record = asRecord(asRecord(payload)['ref'])
  const chainId = record['chainId']
  const contract = record['contract']
  const tokenId = record['tokenId']
  if (typeof chainId !== 'number' || typeof contract !== 'string' || typeof tokenId !== 'string') {
    throw plain('That token could not be identified. Refresh the list and try again.')
  }
  const standard = record['standard']
  return {
    chainId,
    contract: contract.trim(),
    tokenId: tokenId.trim(),
    standard: standard === 'erc721' || standard === 'erc1155' ? standard : 'unknown'
  }
}

function readHealthItems(payload: unknown): HealthCheckItem[] {
  const raw = asRecord(payload)['items']
  if (!Array.isArray(raw) || raw.length === 0) {
    throw plain('There is nothing to check yet. Archive some tokens first, then run the check.')
  }
  if (raw.length > MAX_HEALTH_ITEMS) {
    throw plain(
      `That is ${raw.length.toLocaleString('en-US')} things to check at once, which is more than this app will do in one go. Check up to ${MAX_HEALTH_ITEMS.toLocaleString('en-US')} at a time.`
    )
  }
  const items: HealthCheckItem[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const cid = record['cid']
    if (typeof cid !== 'string' || cid.trim() === '') continue
    const label = record['label']
    items.push({
      cid: cid.trim(),
      label: typeof label === 'string' && label.trim() !== '' ? label.trim() : cid.trim()
    })
  }
  if (items.length === 0) {
    throw plain('None of those entries had a content ID to check. Archive some tokens first, then run the check.')
  }
  return items
}

/** Turn "which tokens" into the flat list of tokens to fetch. */
function expandSpecs(specs: TokenInputSpec[]): TokenRef[] {
  const refs: TokenRef[] = []
  const seen = new Set<string>()

  for (const spec of specs) {
    if (spec.tokenIds.length === 0) {
      throw plain(
        `Which token numbers from ${spec.contract} should be archived? Add them after the address — for example "${spec.contract} 1-25".`
      )
    }
    for (const tokenId of spec.tokenIds) {
      const ref: TokenRef = {
        chainId: spec.chainId,
        contract: spec.contract,
        tokenId,
        standard: 'unknown'
      }
      const key = tokenKey(ref)
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(ref)
    }
  }

  if (refs.length > MAX_TOKENS_PER_RUN) {
    throw plain(
      `That is ${refs.length.toLocaleString('en-US')} tokens in one go, which is more than this app will archive at once. Do it in batches of up to ${MAX_TOKENS_PER_RUN.toLocaleString('en-US')}.`
    )
  }
  return refs
}

/* ========================================================================== */
/* Handler registration                                                       */
/* ========================================================================== */

type HandlerBody<T> = (event: IpcMainInvokeEvent, payload: unknown) => Promise<T>

/**
 * Registers one channel. This is the only place a `try` is needed for the
 * result contract: every throw below becomes `{ ok: false, error }`.
 */
function handle<T>(channel: string, action: string, body: HandlerBody<T>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: toSerializable(await body(event, payload)) }
    } catch (err) {
      return { ok: false, error: toPlainMessage(err, action) }
    }
  })
}

/** Parse a root CID string, with a message a member can act on. */
function parseRoot(rootCid: string): CID {
  try {
    return CID.parse(rootCid)
  } catch {
    throw plain(
      'This archive\'s fingerprint could not be read, so it cannot be saved yet. Try assembling the archive again.'
    )
  }
}

/** Assemble the archive if it has not been assembled since the last change. */
async function ensureRoot(open: ArchiveStore, ctx: RunContext): Promise<string> {
  const existing = asCidString(open.manifest.rootCid)
  if (existing !== null) return existing

  ctx.progress({
    id: ctx.id,
    phase: 'storing',
    message: 'Putting the archive together…'
  })

  const options: EngineRunOptions = { signal: ctx.signal, onProgress: ctx.progress }
  const returned: unknown = await buildArchiveRoot(open, options)
  const rootCid = asCidString(returned) ?? asCidString(open.manifest.rootCid)
  if (rootCid === null) {
    throw plain('The archive could not be put together. Try archiving the tokens again, then retry.')
  }

  open.manifest.rootCid = rootCid
  touchManifest(open.manifest)
  await open.save()
  return rootCid
}

export function registerIpcHandlers(): void {
  /* ---------------------------------------------------------------------- */
  /* Archive workspace                                                      */
  /* ---------------------------------------------------------------------- */

  handle<ArchiveSnapshot>('archive:create', 'creating the archive', async (_event, payload) => {
    const dir = readPath(payload, 'dir', 'The folder to save the archive in')
    const name = readString(payload, 'name', 'A name for this archive')
    return withArchiveLock('creating an archive', async () => {
      await closeCurrentStore()
      store = await ArchiveStore.create(dir, name)
      storeDir = dir
      approvePath(dir)
      return snapshot()
    })
  })

  handle<ArchiveSnapshot>('archive:open', 'opening the archive', async (_event, payload) => {
    const dir = readPath(payload, 'dir', 'The archive folder')
    return withArchiveLock('opening an archive', async () => {
      await closeCurrentStore()
      store = await ArchiveStore.open(dir)
      storeDir = dir
      approvePath(dir)
      return snapshot()
    })
  })

  handle<ArchiveSnapshot | null>('archive:current', 'reading the archive', async () => {
    if (store === null || storeDir === null) return null
    return snapshot()
  })

  /* ---------------------------------------------------------------------- */
  /* Adding and removing tokens                                             */
  /* ---------------------------------------------------------------------- */

  handle<TokenInputSpec[]>('archive:parseInput', 'reading what you pasted', async (_event, payload) => {
    const text = asRecord(payload)['text']
    if (typeof text !== 'string' || text.trim() === '') {
      throw plain('Paste a contract address, or an OpenSea link, and the token numbers you want to archive.')
    }
    return parseTokenInput(text)
  })

  handle<AddTokensResult>('archive:addTokens', 'archiving those tokens', async (event, payload) => {
    const open = requireStore()
    const refs = expandSpecs(readSpecs(payload))

    return withArchiveLock('archiving tokens', async () =>
      runOperation(event, asRecord(payload)['opId'], 'archiving tokens', async (ctx) => {
        ctx.progress({
          id: ctx.id,
          phase: 'resolving',
          message:
            refs.length === 1
              ? 'Looking up that token on the blockchain…'
              : `Looking up ${refs.length} tokens on the blockchain…`,
          progress: 0
        })

        const options: EngineRunOptions = { signal: ctx.signal, onProgress: ctx.progress }

        let tokens: ArchivedToken[]
        try {
          tokens = await archiveMany(refs, open, options)
        } finally {
          // The engine writes each token to the manifest the moment it lands,
          // including the ones finished before the member pressed Stop. So by
          // the time we get here the archive's contents have changed whether
          // this run succeeded, failed or was cancelled — and any root CID
          // assembled earlier no longer describes them.
          //
          // Leaving a stale root in place would let a member export a .car
          // whose fingerprint silently omits everything they just archived.
          // That is the exact failure this app exists to prevent, so it is
          // cleared on every path out.
          invalidateRoot(open.manifest)
          touchManifest(open.manifest)
          try {
            await open.save()
          } catch (saveErr) {
            console.error('[bic-archiver] could not record the archive change', saveErr)
          }
        }

        ctx.throwIfCancelled()
        upsertTokens(open.manifest, tokens)
        await open.save()

        const okCount = tokens.filter((token) => token.status === 'ok').length
        const partialCount = tokens.filter((token) => token.status === 'partial').length
        const failedCount = tokens.filter((token) => token.status === 'failed').length

        ctx.progress({
          id: ctx.id,
          phase: 'done',
          message:
            failedCount === 0
              ? `Archived ${tokens.length} of ${refs.length}.`
              : `Archived ${okCount + partialCount} of ${refs.length}. ${failedCount} could not be archived — open them to see why.`,
          progress: 1
        })

        return { snapshot: snapshot(), tokens, okCount, partialCount, failedCount }
      },
      // Tokens finished before Stop was pressed are already saved, so telling a
      // member "stopped" and then showing them a longer list than they started
      // with would look like a bug rather than a feature.
      `${CANCELLED_MESSAGE} Everything archived before you stopped has been kept.`)
    )
  })

  handle<ArchiveSnapshot>('archive:removeToken', 'removing that token', async (_event, payload) => {
    const open = requireStore()
    const ref = readTokenRef(payload)

    return withArchiveLock('removing a token', async () => {
      // The store owns this: it matches token ids numerically, clears the
      // assembled root, keeps the shared blocks (another token may use the very
      // same image) and saves. Re-implementing any of that here would drift.
      const removed = await open.removeToken(ref)
      if (!removed) {
        throw plain('That token is not in this archive any more. Refresh the list and try again.')
      }
      return snapshot()
    })
  })

  /* ---------------------------------------------------------------------- */
  /* Assembling                                                             */
  /* ---------------------------------------------------------------------- */

  handle<BuildRootResult>('archive:buildRoot', 'putting the archive together', async (event, payload) => {
    const open = requireStore()

    return withArchiveLock('putting the archive together', async () =>
      runOperation(event, asRecord(payload)['opId'], 'putting the archive together', async (ctx) => {
        requireContents(open.manifest)
        // A rebuild must genuinely rebuild, so any earlier root is dropped first.
        invalidateRoot(open.manifest)
        const rootCid = await ensureRoot(open, ctx)
        ctx.progress({
          id: ctx.id,
          phase: 'done',
          message: 'The archive is assembled and ready to save.',
          progress: 1,
          detail: rootCid
        })
        return { snapshot: snapshot(), rootCid }
      })
    )
  })

  handle<MergeExistingResult>('archive:mergeExisting', 'adding that older backup', async (event, payload) => {
    const open = requireStore()
    const cid = readString(payload, 'cid', "The older backup's content ID")

    return withArchiveLock('adding an older backup', async () =>
      runOperation(event, asRecord(payload)['opId'], 'adding an older backup', async (ctx) => {
        ctx.progress({
          id: ctx.id,
          phase: 'fetching-metadata',
          message: 'Looking for the older backup on IPFS…',
          detail: cid
        })

        const options: EngineRunOptions = { signal: ctx.signal, onProgress: ctx.progress }
        const returned: unknown = await mergeExistingBackup(cid, open, options)
        ctx.throwIfCancelled()

        // `mergeExistingBackup` resolves to void: it has already recorded the
        // imported root and reassembled the archive through the store. Reading
        // the root back is the only thing left to do — and recording the CID
        // again here would double-list it, because the engine stores the
        // canonical form of the address while `cid` is whatever the member
        // pasted ("ipfs://bafy…/" and "bafy…" are the same backup).
        const rootCid = asCidString(returned) ?? asCidString(open.manifest.rootCid)
        if (rootCid === null) {
          throw plain(
            'That backup was added, but the archive could not be put together afterwards. Try assembling the archive again.'
          )
        }

        ctx.progress({
          id: ctx.id,
          phase: 'done',
          message: 'The older backup is now part of this archive.',
          progress: 1,
          detail: rootCid
        })

        return { snapshot: snapshot(), rootCid, mergedCid: cid }
      })
    )
  })

  /* ---------------------------------------------------------------------- */
  /* Health                                                                 */
  /* ---------------------------------------------------------------------- */

  handle<HealthCheckResult>('health:check', 'checking whether that content is still online', async (event, payload) => {
    const items = readHealthItems(payload)

    // Deliberately not behind the archive lock: checking is read-only and a
    // member should be able to watch the health table while nothing else runs.
    return runOperation(event, asRecord(payload)['opId'], 'checking content', async (ctx) => {
      ctx.progress({
        id: ctx.id,
        phase: 'verifying',
        message: `Checking ${items.length} ${items.length === 1 ? 'item' : 'items'} against public IPFS gateways…`,
        progress: 0
      })

      let completed = 0
      const results = await checkMany(
        items,
        (result) => {
          completed += 1
          sendHealth(event.sender, result)
          ctx.progress({
            id: ctx.id,
            phase: 'verifying',
            message: `Checked ${completed} of ${items.length}…`,
            progress: completed / items.length,
            detail: result.label
          })
        },
        ctx.signal
      )

      const cancelled = ctx.signal.aborted
      const unreachable = results.filter((result) => result.verdict === 'unreachable').length
      const atRisk = results.filter((result) => result.verdict === 'at-risk').length

      ctx.progress({
        id: ctx.id,
        phase: 'done',
        message: cancelled
          ? `${CANCELLED_MESSAGE} ${results.length} of ${items.length} were checked.`
          : unreachable === 0 && atRisk === 0
            ? 'Everything checked is still online.'
            : `${unreachable} could not be found anywhere${atRisk > 0 ? `, and ${atRisk} are at risk` : ''}.`,
        progress: 1
      })

      return { results, cancelled }
    })
  })

  /* ---------------------------------------------------------------------- */
  /* Export / import                                                        */
  /* ---------------------------------------------------------------------- */

  handle<ExportCarResult>('export:car', 'saving the backup file', async (event, payload) => {
    const open = requireStore()
    const outPath = readPath(payload, 'outPath', 'The place to save the backup')

    return withArchiveLock('saving the backup', async () =>
      runOperation(event, asRecord(payload)['opId'], 'saving the backup', async (ctx) => {
        requireContents(open.manifest)
        const rootCid = await ensureRoot(open, ctx)
        const root = parseRoot(rootCid)

        ctx.progress({
          id: ctx.id,
          phase: 'storing',
          message: `Writing ${basename(outPath)}…`,
          detail: rootCid
        })

        const written = await exportCar(root, open.blockstore, outPath, (blocks) => {
          // exportCar has no signal of its own, so Stop is enforced here — the
          // exporter deletes the half-written file when the walk fails.
          ctx.throwIfCancelled()
          ctx.progress({
            id: ctx.id,
            phase: 'storing',
            message: `Writing ${basename(outPath)}…`,
            detail: `${blocks.toLocaleString('en-US')} pieces saved`
          })
        })

        approvePath(outPath)
        ctx.progress({
          id: ctx.id,
          phase: 'done',
          message: `Backup saved. ${written.blocks.toLocaleString('en-US')} pieces, ${formatBytes(written.bytes)}.`,
          progress: 1,
          detail: outPath
        })

        return { path: outPath, blocks: written.blocks, bytes: written.bytes }
      })
    )
  })

  handle<ExportFolderResult>('export:folder', 'saving the browsable copy', async (event, payload) => {
    const open = requireStore()
    const outDir = readPath(payload, 'outDir', 'The folder to save the copy in')

    return withArchiveLock('saving a browsable copy', async () =>
      runOperation(event, asRecord(payload)['opId'], 'saving a browsable copy', async (ctx) => {
        requireContents(open.manifest)
        const rootCid = await ensureRoot(open, ctx)
        const root = parseRoot(rootCid)

        ctx.progress({
          id: ctx.id,
          phase: 'storing',
          message: 'Writing the files where you can open them…',
          detail: outDir
        })

        const written = await exportBrowsableFolder(root, open.blockstore, outDir)
        approvePath(outDir)

        ctx.progress({
          id: ctx.id,
          phase: 'done',
          message: `Saved ${written.files.toLocaleString('en-US')} files (${formatBytes(written.bytes)}). Note that a plain folder does not carry the IPFS fingerprints — keep the .car backup for that.`,
          progress: 1,
          detail: outDir
        })

        return { path: outDir, files: written.files, bytes: written.bytes }
      })
    )
  })

  handle<ImportCarResult>('import:car', 'reading that backup file', async (event, payload) => {
    const open = requireStore()
    const inPath = readPath(payload, 'inPath', 'The backup file to read')

    return withArchiveLock('reading a backup file', async () =>
      runOperation(event, asRecord(payload)['opId'], 'reading a backup file', async (ctx) => {
        ctx.progress({
          id: ctx.id,
          phase: 'verifying',
          message: `Reading ${basename(inPath)} and checking every piece…`,
          detail: inPath
        })

        const imported = await importCar(inPath, open.blockstore)
        ctx.throwIfCancelled()

        const roots = imported.roots
          .map((root) => asCidString(root))
          .filter((root): root is string => root !== null)

        if (!Array.isArray(open.manifest.importedRoots)) open.manifest.importedRoots = []
        for (const root of roots) {
          if (!open.manifest.importedRoots.includes(root)) open.manifest.importedRoots.push(root)
        }
        touchManifest(open.manifest)
        await open.save()
        approvePath(inPath)

        ctx.progress({
          id: ctx.id,
          phase: 'done',
          message:
            roots.length === 0
              ? `Read ${imported.blocks.toLocaleString('en-US')} pieces, but the file did not say what its contents are.`
              : `Read ${imported.blocks.toLocaleString('en-US')} pieces. Use "add an existing backup" to fold its contents into this archive.`,
          progress: 1
        })

        return { snapshot: snapshot(), roots, blocks: imported.blocks }
      })
    )
  })

  /* ---------------------------------------------------------------------- */
  /* Native pickers                                                         */
  /* ---------------------------------------------------------------------- */

  handle<string | null>('dialog:pickDirectory', 'opening the folder picker', async (event, payload) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: readOptionalString(payload, 'title') ?? 'Choose a folder for the archive',
      defaultPath: readOptionalString(payload, 'defaultPath') ?? storeDir ?? undefined,
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const chosen = result.canceled ? undefined : result.filePaths[0]
    if (chosen === undefined) return null
    approvePath(chosen)
    return chosen
  })

  handle<string | null>('dialog:saveCar', 'opening the save window', async (event, payload) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const suggested = readOptionalString(payload, 'defaultName') ?? defaultBackupName()
    const options = {
      title: readOptionalString(payload, 'title') ?? 'Save the verifiable backup',
      defaultPath: readOptionalString(payload, 'defaultPath') ?? suggested,
      buttonLabel: 'Save backup',
      filters: [
        { name: 'IPFS backup', extensions: ['car'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'] as Array<
        'createDirectory' | 'showOverwriteConfirmation'
      >
    }
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || result.filePath === undefined || result.filePath === '') return null
    const chosen = result.filePath.toLowerCase().endsWith('.car') ? result.filePath : `${result.filePath}.car`
    approvePath(chosen)
    return chosen
  })

  handle<string | null>('dialog:openCar', 'opening the file picker', async (event, payload) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: readOptionalString(payload, 'title') ?? 'Choose a backup file',
      defaultPath: readOptionalString(payload, 'defaultPath') ?? storeDir ?? undefined,
      buttonLabel: 'Read this backup',
      filters: [
        { name: 'IPFS backup', extensions: ['car'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile'] as Array<'openFile'>
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const chosen = result.canceled ? undefined : result.filePaths[0]
    if (chosen === undefined) return null
    approvePath(chosen)
    return chosen
  })

  /* ---------------------------------------------------------------------- */
  /* Shell                                                                  */
  /* ---------------------------------------------------------------------- */

  handle<null>('shell:openPath', 'opening that in Finder', async (_event, payload) => {
    const target = readPath(payload, 'path', 'The file or folder to open')

    if (!isApproved(target)) {
      throw plain('That location has not been opened in this app, so it cannot be revealed. Choose it with the folder picker first.')
    }

    let isDirectory: boolean
    try {
      isDirectory = (await stat(target)).isDirectory()
    } catch {
      throw plain('That file or folder is not there any more. It may have been moved or deleted.')
    }

    if (isDirectory) {
      const failure = await shell.openPath(target)
      if (failure !== '') {
        throw plain(`Your computer would not open that folder. You can find it yourself at: ${target}`)
      }
      return null
    }

    // Nothing on a normal computer knows how to open a `.car` file, so trying to
    // launch it would just fail. Falling back to revealing it means "show me my
    // backup" always does something useful.
    const failure = await shell.openPath(target)
    if (failure !== '') shell.showItemInFolder(target)
    return null
  })

  handle<null>('shell:openExternal', 'opening that link', async (_event, payload) => {
    const raw = readString(payload, 'url', 'The link to open')

    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw plain('That does not look like a web address, so it was not opened.')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'mailto:') {
      throw plain('Only web links and email addresses can be opened from here, for your safety.')
    }

    await shell.openExternal(parsed.toString())
    return null
  })

  /* ---------------------------------------------------------------------- */
  /* Cancellation                                                           */
  /* ---------------------------------------------------------------------- */

  handle<number>('op:cancel', 'stopping that job', async (event, payload) => {
    // Always scoped to the window that asked, so one window can never reach
    // into another's work. With no `opId`, everything this window started stops.
    const opId = readOptionalString(payload, 'opId')
    return cancelOperations({ opId, webContentsId: event.sender.id })
  })
}

/* ========================================================================== */
/* Shutdown                                                                   */
/* ========================================================================== */

/** Stop everything and close the archive cleanly. Called on quit. */
export async function shutdownIpc(): Promise<void> {
  cancelAllOperations()
  await closeCurrentStore()
}

/** Called when a window goes away, so its jobs do not keep running unseen. */
export function cancelOperationsForWebContents(webContentsId: number): number {
  return cancelOperations({ webContentsId })
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

function defaultBackupName(): string {
  const name = store?.manifest?.name
  const base = sanitizeFolderName(typeof name === 'string' && name !== '' ? name : 'archive', 'archive')
  const stamp = new Date().toISOString().slice(0, 10)
  return `${base} ${stamp}.car`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown size'
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] ?? 'TB'}`
}
