/**
 * The archive workspace on disk.
 *
 * One `ArchiveStore` owns one folder that a DAO member picked, laid out as:
 *
 *   <root>/blocks/         raw IPFS blocks, content-addressed (the blockstore)
 *   <root>/manifest.json   everything we know about what has been archived
 *   <root>/exports/        finished .car files and browsable folder exports
 *
 * The manifest is the only mutable file, and it is the one file whose loss would
 * hurt: the blocks are still there but nobody would know what they are. So every
 * write goes to a temporary file, is flushed to the physical disk, and is then
 * moved into place with a single atomic rename. A crash — or a laptop lid
 * closing mid-save — can therefore leave either the old manifest or the new one,
 * never a half-written mixture. The previous version is also kept as
 * `manifest.json.bak` and is used automatically if the main file is ever
 * unreadable.
 *
 * Saves are serialised through an internal queue, so several tokens being
 * archived at once cannot interleave their writes.
 */

import { copyFile, mkdir, open as openFile, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { closeBlockstore, openBlockstore, type Blockstore } from '../ipfs/blockstore.js'
import type { ArchiveManifest, ArchivedToken, TokenRef } from '../../shared/types.js'

/** File and folder names inside an archive workspace. */
const MANIFEST_FILE = 'manifest.json'
const BACKUP_SUFFIX = '.bak'
const BLOCKS_DIR = 'blocks'
const EXPORTS_DIR = 'exports'

/** Used when a member does not give the archive a name of its own. */
const DEFAULT_ARCHIVE_NAME = 'BIC Backup'

/** An error whose message is already written for a non-technical member. */
function plain(message: string, cause?: unknown): Error {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause })
  err.name = 'ArchiverError'
  return err
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Token IDs are decimal strings that can exceed `Number.MAX_SAFE_INTEGER`. */
function normalizeTokenId(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  try {
    return BigInt(text).toString(10)
  } catch {
    return text
  }
}

/**
 * Do two references point at the same NFT?
 *
 * Addresses are compared case-insensitively because they arrive both
 * checksummed and lowercased depending on where the member pasted them from,
 * and token IDs are compared numerically so `007` and `7` are one token.
 */
function sameToken(a: TokenRef, b: TokenRef): boolean {
  return (
    a.chainId === b.chainId &&
    String(a.contract).toLowerCase() === String(b.contract).toLowerCase() &&
    normalizeTokenId(a.tokenId) === normalizeTokenId(b.tokenId)
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Does this look enough like an archived token to keep? */
function looksLikeToken(value: unknown): value is ArchivedToken {
  if (!isRecord(value)) return false
  const ref = value.ref
  if (!isRecord(ref)) return false
  return typeof ref.contract === 'string' && typeof ref.tokenId === 'string'
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
  }
  return out
}

function isoOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/**
 * Turn whatever was on disk into a manifest we can rely on.
 *
 * Deliberately forgiving: a member may have copied an archive between machines,
 * or an older build may have written a slightly different shape. Anything
 * unrecognisable is replaced with a sane default rather than throwing away the
 * whole file, but a manifest from a *newer* version of the app is refused,
 * because silently dropping fields we do not understand would corrupt it.
 */
function normalizeManifest(value: unknown, fallbackName: string): ArchiveManifest {
  if (!isRecord(value)) {
    throw plain(
      'The archive list in this folder could not be read — "manifest.json" does not contain archive information.'
    )
  }

  const version = value.version
  if (typeof version === 'number' && version > 1) {
    throw plain(
      `This archive was made with a newer version of BIC Archiver (format ${version}). ` +
        'Please update the app before opening it, so nothing already saved is lost.'
    )
  }

  const now = new Date().toISOString()
  const tokens: ArchivedToken[] = []
  if (Array.isArray(value.tokens)) {
    for (const entry of value.tokens) {
      if (!looksLikeToken(entry)) continue
      const token = entry as ArchivedToken
      // Fields the rest of the app dereferences without checking first.
      if (!isRecord(token.assets)) token.assets = {}
      if (!Array.isArray(token.errors)) token.errors = []
      if (typeof token.status !== 'string') token.status = 'ok'
      if (typeof token.name !== 'string') token.name = `#${String(token.ref.tokenId)}`
      if (typeof token.folderName !== 'string' || token.folderName === '') {
        token.folderName = token.name
      }
      token.archivedAt = isoOr(token.archivedAt, now)
      tokens.push(token)
    }
  }

  const manifest: ArchiveManifest = {
    version: 1,
    name: typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : fallbackName,
    createdAt: isoOr(value.createdAt, now),
    updatedAt: isoOr(value.updatedAt, now),
    tokens,
    importedRoots: asStringArray(value.importedRoots)
  }

  if (typeof value.rootCid === 'string' && value.rootCid.trim() !== '') {
    manifest.rootCid = value.rootCid.trim()
  }

  return manifest
}

/**
 * One archive workspace: its manifest, its blockstore, and the folder they live
 * in.
 *
 * Create one with {@link ArchiveStore.createArchive} (new folder) or
 * {@link ArchiveStore.open} (existing folder). Both are `static` because opening
 * a workspace involves asynchronous work — creating folders and opening the
 * blockstore — that a constructor cannot do.
 */
export class ArchiveStore {
  /** Absolute path of the archive workspace folder. */
  readonly root: string
  /** Absolute path of the block storage folder. */
  readonly blocksDir: string
  /** Absolute path of the folder finished `.car` files are written to. */
  readonly exportsDir: string
  /** Absolute path of `manifest.json`. */
  readonly manifestPath: string

  #manifest: ArchiveManifest
  #blockstore: Blockstore
  #saveQueue: Promise<void> = Promise.resolve()
  #closed = false

  private constructor(root: string, manifest: ArchiveManifest, blockstore: Blockstore) {
    this.root = root
    this.blocksDir = join(root, BLOCKS_DIR)
    this.exportsDir = join(root, EXPORTS_DIR)
    this.manifestPath = join(root, MANIFEST_FILE)
    this.#manifest = manifest
    this.#blockstore = blockstore
  }

  /**
   * Start a brand new archive in `dir`.
   *
   * Refuses to touch a folder that already holds an archive — overwriting a
   * member's existing manifest would throw away the record of everything they
   * had already saved.
   */
  static async createArchive(dir: string, name: string): Promise<ArchiveStore> {
    const root = resolve(dir)

    if (await pathExists(join(root, MANIFEST_FILE))) {
      throw plain(
        `There is already an archive in "${root}". Open that archive instead of creating a new one, ` +
          'so the tokens already saved there are not lost.'
      )
    }

    await ArchiveStore.#prepareFolders(root)

    const now = new Date().toISOString()
    const cleanName = typeof name === 'string' && name.trim() !== '' ? name.trim() : basename(root) || DEFAULT_ARCHIVE_NAME

    const manifest: ArchiveManifest = {
      version: 1,
      name: cleanName,
      createdAt: now,
      updatedAt: now,
      tokens: [],
      importedRoots: []
    }

    const blockstore = await openBlockstore(join(root, BLOCKS_DIR))
    const store = new ArchiveStore(root, manifest, blockstore)
    await store.save()
    return store
  }

  /**
   * Alias for {@link ArchiveStore.createArchive}, so callers can read
   * `ArchiveStore.create(dir, name)` alongside `ArchiveStore.open(dir)`.
   */
  static create(dir: string, name: string): Promise<ArchiveStore> {
    return ArchiveStore.createArchive(dir, name)
  }

  /**
   * Open the archive already stored in `dir`.
   *
   * If `manifest.json` is missing or unreadable, the automatic backup copy is
   * used instead and immediately written back, so a member never loses their
   * archive list to a single bad file.
   */
  static async open(dir: string): Promise<ArchiveStore> {
    const root = resolve(dir)
    const manifestPath = join(root, MANIFEST_FILE)
    const backupPath = manifestPath + BACKUP_SUFFIX

    const mainText = await readIfPresent(manifestPath)
    let parsed = mainText === undefined ? undefined : tryParse(mainText)
    let recovered = false

    if (parsed === undefined) {
      const backupText = await readIfPresent(backupPath)
      const backupParsed = backupText === undefined ? undefined : tryParse(backupText)
      if (backupParsed !== undefined) {
        parsed = backupParsed
        recovered = true
      }
    }

    if (parsed === undefined) {
      if (mainText === undefined) {
        throw plain(
          `There is no archive in "${root}" yet. Choose the folder where you saved an archive before, ` +
            'or start a new archive in this folder.'
        )
      }
      throw plain(
        `The archive list in "${root}" could not be read — "${MANIFEST_FILE}" appears to be damaged, ` +
          'and there is no usable backup copy beside it. The archived files themselves are still in the ' +
          '"blocks" folder, so nothing is lost; please contact whoever supports this app before continuing.'
      )
    }

    const manifest = normalizeManifest(parsed, basename(root) || DEFAULT_ARCHIVE_NAME)

    await ArchiveStore.#prepareFolders(root)
    const blockstore = await openBlockstore(join(root, BLOCKS_DIR))
    const store = new ArchiveStore(root, manifest, blockstore)

    if (recovered) {
      // Put the recovered list back where it belongs before anything else runs.
      await store.save()
    }

    return store
  }

  static async #prepareFolders(root: string): Promise<void> {
    for (const path of [root, join(root, BLOCKS_DIR), join(root, EXPORTS_DIR)]) {
      try {
        await mkdir(path, { recursive: true })
      } catch (err) {
        throw plain(
          `The archive folder "${path}" could not be created. Check that the drive is connected, ` +
            `has free space, and that you have permission to write there. (${errorText(err)})`,
          err
        )
      }
    }
  }

  /**
   * The live manifest object.
   *
   * Read freely. If you change it directly you must call {@link save} yourself;
   * the helper methods below (`addToken`, `removeToken`, `setRootCid`,
   * `addImportedRoot`) save for you.
   */
  get manifest(): ArchiveManifest {
    return this.#manifest
  }

  /** The blockstore holding every block this archive has collected. */
  get blockstore(): Blockstore {
    return this.#blockstore
  }

  /** Everything archived so far, in the order it was archived. */
  listTokens(): ArchivedToken[] {
    return [...this.#manifest.tokens]
  }

  /** The token already archived for this reference, if any. */
  findToken(ref: TokenRef): ArchivedToken | undefined {
    return this.#manifest.tokens.find((token) => sameToken(token.ref, ref))
  }

  /**
   * Add a token, or replace the previously archived version of the same token.
   *
   * Replacement keeps the original position in the list, so re-archiving one
   * item does not reshuffle a member's archive.
   */
  async addToken(token: ArchivedToken): Promise<void> {
    const index = this.#manifest.tokens.findIndex((existing) => sameToken(existing.ref, token.ref))
    if (index >= 0) {
      this.#manifest.tokens[index] = token
    } else {
      this.#manifest.tokens.push(token)
    }
    await this.save()
  }

  /**
   * Forget a token.
   *
   * The blocks it referenced are deliberately left in place: they are shared by
   * content address, so another token may well be using the very same image,
   * and deleting them is never worth the risk of losing content that cannot be
   * downloaded again.
   *
   * @returns true when something was actually removed.
   */
  async removeToken(ref: TokenRef): Promise<boolean> {
    const before = this.#manifest.tokens.length
    this.#manifest.tokens = this.#manifest.tokens.filter((token) => !sameToken(token.ref, ref))
    if (this.#manifest.tokens.length === before) {
      return false
    }
    // The assembled backup folder no longer describes what is in the archive.
    delete this.#manifest.rootCid
    await this.save()
    return true
  }

  /** Record the root CID of the most recently assembled backup folder. */
  async setRootCid(cid: string): Promise<void> {
    const clean = cid.trim()
    if (clean === '') {
      throw plain('Internal error: an empty IPFS address cannot be recorded as the backup root.')
    }
    this.#manifest.rootCid = clean
    await this.save()
  }

  /** Record that a pre-existing backup was merged into this archive. */
  async addImportedRoot(cid: string): Promise<void> {
    const clean = cid.trim()
    if (clean === '') {
      throw plain('Internal error: an empty IPFS address cannot be recorded as an imported backup.')
    }
    if (!this.#manifest.importedRoots.includes(clean)) {
      this.#manifest.importedRoots.push(clean)
      await this.save()
    }
  }

  /**
   * Write the manifest to disk.
   *
   * Calls are queued, so concurrent archiving never produces interleaved
   * writes, and each call resolves only once its own write is on disk.
   */
  async save(): Promise<void> {
    if (this.#closed) {
      throw plain('Internal error: this archive has been closed and can no longer be saved.')
    }

    const run = this.#saveQueue.then(
      () => this.#writeManifest(),
      () => this.#writeManifest()
    )
    // Failures must not poison the queue for later saves.
    this.#saveQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async #writeManifest(): Promise<void> {
    this.#manifest.updatedAt = new Date().toISOString()

    let text: string
    try {
      text = JSON.stringify(this.#manifest, null, 2) + '\n'
    } catch (err) {
      throw plain(
        'The archive list could not be saved because one of the archived items contains information ' +
          `this app cannot write to a file. (${errorText(err)})`,
        err
      )
    }

    const tmpPath = `${this.manifestPath}.${process.pid}.tmp`

    try {
      // 1. Write the new manifest to a temporary file and flush it to the disk
      //    itself, not just to the operating system's cache.
      const handle = await openFile(tmpPath, 'w')
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }

      // 2. Keep the previous version beside it as a safety net.
      if (await pathExists(this.manifestPath)) {
        try {
          await copyFile(this.manifestPath, this.manifestPath + BACKUP_SUFFIX)
        } catch {
          // A missing backup copy is not worth failing the save over.
        }
      }

      // 3. Swap the new file into place. A rename is atomic, so a crash at any
      //    moment leaves either the old manifest or the new one intact.
      await rename(tmpPath, this.manifestPath)
    } catch (err) {
      throw plain(
        `The archive list could not be saved to "${this.manifestPath}". Check that the drive is still ` +
          `connected, is not full, and is not write-protected. (${errorText(err)})`,
        err
      )
    }

    // 4. Ask the operating system to record the rename itself. Best effort:
    //    some platforms and filesystems refuse to sync a directory.
    try {
      const dirHandle = await openFile(dirname(this.manifestPath), 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch {
      // Not supported here; the rename is still atomic.
    }
  }

  /** Flush and close the blockstore. The manifest is saved first. */
  async close(): Promise<void> {
    if (this.#closed) return
    await this.save()
    this.#closed = true
    await closeBlockstore(this.#blockstore)
  }
}
