/**
 * Archive orchestration — the whole manual ritual, automated.
 *
 * What a DAO member used to do by hand, in order: install IPFS Desktop, open
 * Etherscan, find the contract, click "Read as Proxy", call `tokenURI`, copy the
 * result, paste a base64 blob into an online decoder, copy the image CID out of
 * the JSON, paste each CID into IPFS Desktop's "Import from IPFS", create
 * folders called "Ape #1", "web image" and so on, drag the pinned items into
 * them, and finally right-click the top folder and copy its hash. When a file
 * had already fallen off IPFS they were told to find a copy somewhere and then
 * re-run `ipfs add` with different flags until the hash matched.
 *
 * This module does all of that:
 *
 *   1. `resolveTokenUri`  replaces Etherscan + "Read as Proxy" + base64 decoding.
 *   2. Trustless CAR retrieval replaces "Import from IPFS", and preserves the
 *      original CID *by construction* rather than by luck.
 *   3. `reconstructCid`   replaces the guess-the-chunker ritual, and only runs
 *      when verifiable retrieval has already failed everywhere.
 *   4. `buildTokenFolder` / `buildArchiveRoot` replace the drag-and-drop folder
 *      building, producing byte-identical dag-pb to what IPFS Desktop would.
 *   5. `_provenance.json` records what none of the manual steps ever did: where
 *      each byte came from, when, from which gateway, and whether the original
 *      address survived.
 *
 * Every step reports progress in plain English, every network call has a
 * deadline, and a single broken image never costs a member the rest of the
 * token.
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { exporter } from 'ipfs-unixfs-exporter'
import { CID } from 'multiformats/cid'

import { ARWEAVE_GATEWAYS, LAYOUT } from '../../shared/constants.js'
import type {
  ArchivedToken,
  FetchedResource,
  HealthResult,
  ProgressEvent,
  ResolvedTokenUri,
  TokenRef
} from '../../shared/types.js'
import { parseIpfsUri, resolveTokenUri } from '../chain/tokenUri.js'
import { checkHealth } from '../health/check.js'
import { getBlockBytes, hasBlock, type Blockstore } from '../ipfs/blockstore.js'
import { buildDirectory, cumulativeSize, listDirectory } from '../ipfs/dag.js'
import { addBytes, reconstructCid, sha256Hex } from '../ipfs/importer.js'
import {
  fetchDag,
  fetchHttpBytes,
  fetchIpfsBytesFallback,
  resolvePath
} from '../ipfs/trustlessFetch.js'
import { extractAssetUrls, sanitizeFolderName } from './inputs.js'
import { buildProvenance, layoutPathFor } from './provenance.js'
import type { ArchiveStore } from './store.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How many tokens to archive at once by default.
 *
 * Three is deliberate politeness: every public gateway in `TRUSTLESS_GATEWAYS`
 * is run by a volunteer or a foundation, and each token can fan out to several
 * requests. Hammering them earns a 429 and makes the archive *slower*.
 */
const DEFAULT_CONCURRENCY = 3

/** Refuse to treat anything larger than this as a metadata document. */
const MAX_METADATA_BYTES = 64 * 1024 * 1024

/**
 * Above this size, a rescued file is stored as-is rather than being re-imported
 * up to seven times to hunt for its original CID. Reconstruction needs the whole
 * file in memory for every attempt.
 */
const MAX_RECONSTRUCT_BYTES = 256 * 1024 * 1024

/**
 * Ceiling on how many assets one token may declare. Ordinary metadata lists one
 * to five; anything past this is either a mistake or hostile, and would tie up
 * the gateways for hours.
 */
const MAX_ASSETS_PER_TOKEN = 64

/** Name of the folder the whole backup is assembled under. */
const ARCHIVE_ROOT_LABEL = 'BIC Backup'

// ---------------------------------------------------------------------------
// Errors and cancellation
// ---------------------------------------------------------------------------

/** An error whose message is already fit to show a non-technical member. */
function plain(message: string, cause?: unknown): Error {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause })
  err.name = 'ArchiverError'
  return err
}

/**
 * A fatal failure for one token, optionally carrying however much of the token
 * we had managed to work out — {@link archiveMany} uses it so a failed row still
 * shows the member what the contract said.
 */
function fatal(message: string, partial?: ArchivedToken): Error {
  const err = plain(message)
  if (partial !== undefined) {
    ;(err as Error & { partial?: ArchivedToken }).partial = partial
  }
  return err
}

function cancelled(): Error {
  const err = new Error('This archive was cancelled.')
  err.name = 'AbortError'
  return err
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled()
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message
  const text = String(err).trim()
  return text === '' ? 'Something went wrong, but no reason was given.' : text
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

type Emit = (
  phase: ProgressEvent['phase'],
  message: string,
  progress?: number,
  detail?: string
) => void

/** Progress listener plus the knobs a caller might want, as one object. */
interface RunOptions {
  onProgress?: (event: ProgressEvent) => void
  signal?: AbortSignal
  concurrency?: number
}

/**
 * What the exported functions accept where a progress listener goes.
 *
 * A bare callback is the documented form. An options object is accepted too,
 * because the IPC layer already has `{ signal, onProgress }` in hand and passing
 * it straight through is one less place for the two halves of the app to drift
 * apart.
 */
type ProgressArg = ((event: ProgressEvent) => void) | RunOptions | undefined

/** Flatten the two accepted shapes, letting explicit positional values win. */
function runSettings(
  arg: ProgressArg,
  signal?: AbortSignal,
  extra?: { concurrency?: number }
): { onProgress: (event: ProgressEvent) => void; signal?: AbortSignal; concurrency?: number } {
  const listener = typeof arg === 'function' ? arg : arg?.onProgress
  const settings: {
    onProgress: (event: ProgressEvent) => void
    signal?: AbortSignal
    concurrency?: number
  } = {
    onProgress: listener ?? ((): void => undefined)
  }

  const chosenSignal = signal ?? (typeof arg === 'function' ? undefined : arg?.signal)
  if (chosenSignal !== undefined) settings.signal = chosenSignal

  const chosenConcurrency =
    extra?.concurrency ?? (typeof arg === 'function' ? undefined : arg?.concurrency)
  if (chosenConcurrency !== undefined) settings.concurrency = chosenConcurrency

  return settings
}

/** A stable id so the GUI can group every event about one token. */
function progressId(ref: TokenRef): string {
  let tokenId = String(ref.tokenId)
  try {
    tokenId = BigInt(tokenId).toString(10)
  } catch {
    // Leave odd token ids alone; they still group consistently.
  }
  return `${ref.chainId}:${String(ref.contract).toLowerCase()}:${tokenId}`
}

/**
 * Wrap the caller's listener so a mistake in the GUI can never abort an archive
 * that is already halfway through downloading someone's collection.
 */
function makeEmit(id: string, onProgress: (event: ProgressEvent) => void): Emit {
  return (phase, message, progress, detail) => {
    const event: ProgressEvent = { id, phase, message }
    if (progress !== undefined) event.progress = Math.max(0, Math.min(1, progress))
    if (detail !== undefined) event.detail = detail
    try {
      onProgress(event)
    } catch {
      // A broken progress listener is not a reason to lose an archive.
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Archive one token: read its `tokenURI`, fetch its metadata and every asset the
 * metadata points at, and store the whole thing as a folder of IPFS blocks.
 *
 * The token is saved into `store` before this resolves, so an interrupted batch
 * still leaves everything that finished.
 *
 * Assets are best-effort: an image that has fallen off the network is recorded
 * as a plain-English problem and the token comes back with `status: 'partial'`.
 * Only failures that leave nothing worth keeping — the contract will not answer,
 * or the metadata itself is gone — throw.
 *
 * @throws An `Error` with `name === 'ArchiverError'` and a message safe to show
 * a member verbatim. It may carry a `partial` property holding the half-built
 * {@link ArchivedToken}.
 * @throws An `Error` with `name === 'AbortError'` when `signal` is aborted.
 */
export async function archiveToken(
  ref: TokenRef,
  store: ArchiveStore,
  onProgress: ProgressArg,
  signalArg?: AbortSignal
): Promise<ArchivedToken> {
  const run = runSettings(onProgress, signalArg)
  const signal = run.signal
  const emit = makeEmit(progressId(ref), run.onProgress)
  const blockstore = store.blockstore
  const archivedAt = new Date().toISOString()

  throwIfCancelled(signal)

  // --- 1. Ask the contract where this token's information lives -------------

  emit('resolving', `Asking Ethereum where token ${ref.tokenId}'s information is kept…`, 0.02)

  let tokenUri: ResolvedTokenUri
  try {
    tokenUri = await resolveTokenUri(ref)
  } catch (err) {
    if (isCancellation(err)) throw err
    const message = messageOf(err)
    emit('error', message)
    throw fatal(message)
  }

  throwIfCancelled(signal)
  emit('resolving', `The collection says it is ${describeTokenUri(tokenUri)}.`, 0.08)

  const token: ArchivedToken = {
    ref,
    name: `#${ref.tokenId}`,
    folderName: `#${ref.tokenId}`,
    tokenUri,
    assets: {},
    status: 'ok',
    errors: [],
    archivedAt
  }

  // --- 2. Fetch the metadata ------------------------------------------------

  emit('fetching-metadata', "Downloading the token's information…", 0.12)

  const metadataTarget = targetFromTokenUri(tokenUri)
  let metadataBytes: Uint8Array

  try {
    const resource = await fetchResource('metadata', metadataTarget, blockstore, signal, emit)
    token.metadata = resource
    metadataBytes = await readStoredBytes(CID.parse(resource.cid), blockstore, MAX_METADATA_BYTES)
  } catch (err) {
    if (isCancellation(err)) throw err
    const message = `The information for token ${ref.tokenId} could not be downloaded. ${messageOf(err)}`
    token.status = 'failed'
    token.errors.push(message)
    emit('error', message)
    throw fatal(message, token)
  }

  emit(
    'fetching-metadata',
    `Got the token's information (${formatBytes(token.metadata?.bytes ?? 0)}).`,
    0.24
  )

  // --- 3. Read the name out of the metadata ---------------------------------

  const parsed = parseMetadataJson(metadataBytes)

  if (parsed.json === undefined) {
    const message =
      tokenUri.kind === 'data'
        ? "This token's information is stored on-chain but is not readable as JSON, so no name or images " +
          'could be read from it. The information itself has still been archived exactly as the contract ' +
          'returned it.'
        : `This token's information was downloaded but could not be read as JSON, so no name or images ` +
          `could be found in it. It has still been archived exactly as it was served. (${parsed.problem})`
    token.status = 'partial'
    token.errors.push(message)
    emit('fetching-metadata', message, 0.26)
  } else {
    token.metadataJson = parsed.json
  }

  token.name = readName(parsed.json, ref)
  token.folderName = pickFolderName(token.name, ref, store)

  // --- 4. Fetch every asset the metadata points at --------------------------

  const assetUrls = parsed.json === undefined ? [] : extractAssetUrls(parsed.json)
  const context = assetContext(tokenUri, metadataTarget)

  if (assetUrls.length > MAX_ASSETS_PER_TOKEN) {
    const message =
      `This token's information lists ${assetUrls.length} files, which is far more than an NFT normally ` +
      `has. Only the first ${MAX_ASSETS_PER_TOKEN} were archived.`
    token.status = 'partial'
    token.errors.push(message)
    emit('fetching-assets', message, 0.3)
  }

  const wanted = assetUrls.slice(0, MAX_ASSETS_PER_TOKEN)

  if (wanted.length === 0) {
    emit('fetching-assets', 'This token has no images or other files to download.', 0.6)
  }

  for (let index = 0; index < wanted.length; index++) {
    const asset = wanted[index]
    if (asset === undefined) continue

    throwIfCancelled(signal)

    const share = 0.3 + (0.55 * index) / wanted.length
    emit(
      'fetching-assets',
      `Downloading ${describeRole(asset.role)} (${index + 1} of ${wanted.length})…`,
      share,
      asset.url.length > 120 ? `${asset.url.slice(0, 117)}…` : asset.url
    )

    let target: FetchTarget
    try {
      target = targetFromAssetUrl(asset.url, context)
    } catch (err) {
      if (isCancellation(err)) throw err
      const message = `The ${describeRole(asset.role)} could not be archived. ${messageOf(err)}`
      token.status = 'partial'
      token.errors.push(message)
      emit('fetching-assets', message, share)
      continue
    }

    try {
      token.assets[asset.role] = await fetchResource(asset.role, target, blockstore, signal, emit)
    } catch (err) {
      if (isCancellation(err)) throw err
      // One missing image must never cost a member the rest of the token.
      const message = `The ${describeRole(asset.role)} could not be downloaded. ${messageOf(err)}`
      token.status = 'partial'
      token.errors.push(message)
      emit('fetching-assets', message, share)
    }
  }

  // --- 5. Build this token's folder ----------------------------------------

  throwIfCancelled(signal)
  emit('storing', 'Building the archive folder for this token…', 0.88)

  try {
    await buildTokenFolder(token, blockstore)
  } catch (err) {
    if (isCancellation(err)) throw err
    const message = `Everything was downloaded, but the archive folder could not be built. ${messageOf(err)}`
    token.status = 'failed'
    token.errors.push(message)
    emit('error', message)
    throw fatal(message, token)
  }

  // --- 6. Check what we stored is actually there ----------------------------

  emit('verifying', 'Checking that every piece was saved…', 0.94)

  const missing = await findMissingBlocks(token, blockstore)
  if (missing.length > 0) {
    const message =
      `Some pieces of this token did not save correctly (${missing.join(', ')}). ` +
      'Try archiving it again; if it keeps happening, check the free space on the drive.'
    token.status = 'partial'
    token.errors.push(message)
  }

  await store.addToken(token)

  emit('done', doneMessage(token), 1)

  return token
}

/**
 * Archive many tokens with bounded concurrency, never stopping for one bad one.
 *
 * Every reference produces exactly one entry in the returned array, in the order
 * given. Tokens that failed outright come back with `status: 'failed'` and a
 * plain-English reason in `errors`, and are saved into the archive too so the
 * member can see what did not work and retry just those.
 */
export async function archiveMany(
  refs: TokenRef[],
  store: ArchiveStore,
  onProgress: ProgressArg,
  opts?: { concurrency?: number },
  signalArg?: AbortSignal
): Promise<ArchivedToken[]> {
  const run = runSettings(onProgress, signalArg, opts)
  const signal = run.signal
  const results: ArchivedToken[] = new Array<ArchivedToken>(refs.length)
  const requested = run.concurrency ?? DEFAULT_CONCURRENCY
  const concurrency = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 1, 8))

  let next = 0
  let cancelledEarly = false

  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelledEarly) return
      const index = next++
      if (index >= refs.length) return

      const ref = refs[index]
      if (ref === undefined) continue

      if (signal?.aborted === true) {
        cancelledEarly = true
        return
      }

      try {
        results[index] = await archiveToken(ref, store, run.onProgress, signal)
      } catch (err) {
        if (isCancellation(err)) {
          cancelledEarly = true
          return
        }
        const carried = (err as Error & { partial?: ArchivedToken }).partial
        const failed = carried ?? placeholderToken(ref, messageOf(err))
        failed.status = 'failed'
        if (!failed.errors.includes(messageOf(err))) {
          failed.errors.push(messageOf(err))
        }
        results[index] = failed
        // Persist the failure too: the member should be able to see which items
        // did not work and retry only those.
        try {
          await store.addToken(failed)
        } catch {
          // If even the manifest cannot be written, the error already reported
          // to the GUI is the more useful one.
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, () => worker()))

  if (cancelledEarly) {
    throw cancelled()
  }

  // Defensive: every slot should be filled by now.
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index]
    if (results[index] === undefined && ref !== undefined) {
      results[index] = placeholderToken(ref, 'This token was not archived.')
    }
  }

  return results
}

/**
 * Assemble every archived token folder — plus everything merged in from older
 * backups — under one directory, and record its CID.
 *
 * The returned CID is the thing a member shares, pins, or checks a `.car`
 * against. **It changes every single time the contents change**, exactly as the
 * manual instructions warn: adding one token, or re-archiving one image,
 * produces a completely different root hash, and the old hash keeps pointing at
 * the old contents forever. That is a property of content addressing, not a bug.
 *
 * The directory returned *is* the "BIC Backup" folder; a folder's own name lives
 * in whatever links to it, so the name is applied when the archive is exported
 * as a browsable folder.
 */
export async function buildArchiveRoot(store: ArchiveStore, opts?: ProgressArg): Promise<CID> {
  const run = runSettings(opts)
  const emit = makeEmit('archive-root', run.onProgress)
  const blockstore = store.blockstore

  emit('storing', `Putting the ${ARCHIVE_ROOT_LABEL} folder together…`, 0.02)

  // Collected first and encoded once at the end. Adding entries one at a time
  // would re-encode the whole directory node on every addition, which is fine
  // for a dozen tokens and pathological for a merged backup holding thousands.
  const children: DirectoryChild[] = []

  // Entries merged in from previously imported backups go in first, so a
  // freshly verified copy of the same item replaces the historical one.
  const importedNames = new Set<string>()

  for (const importedRoot of store.manifest.importedRoots) {
    throwIfCancelled(run.signal)

    let cid: CID
    try {
      cid = CID.parse(importedRoot.trim())
    } catch {
      throw plain(
        `One of the backups merged into this archive has an address this app cannot read ` +
          `("${importedRoot}"). Remove it from the archive and import it again.`
      )
    }

    let entries
    try {
      entries = await listDirectory(cid, blockstore)
    } catch (err) {
      throw plain(
        `The previously merged backup ${importedRoot} is no longer stored on this computer, so the ` +
          'backup folder cannot be rebuilt. Import that backup again and try once more. ' +
          `(${messageOf(err)})`,
        err
      )
    }

    emit(
      'storing',
      `Adding ${entries.length} ${entries.length === 1 ? 'item' : 'items'} from an earlier backup…`,
      0.05
    )

    for (const entry of entries) {
      const name = uniqueName(sanitizeFolderName(entry.name, 'imported item'), importedNames)
      // Trust the size already recorded in the imported directory; only fall
      // back to walking the sub-DAG when the original archive omitted it.
      const size = entry.size > 0 ? entry.size : await cumulativeSize(entry.cid, blockstore)
      children.push({ name, cid: entry.cid, size })
    }
  }

  const tokenNames = new Set<string>()
  const tokens = store.listTokens()
  let done = 0

  for (const token of tokens) {
    throwIfCancelled(run.signal)
    done++
    emit(
      'storing',
      `Adding "${token.folderName}" to the ${ARCHIVE_ROOT_LABEL} folder (${done} of ${tokens.length})…`,
      0.1 + (0.8 * done) / Math.max(1, tokens.length)
    )

    if (token.metadata === undefined && Object.keys(token.assets).length === 0) {
      // Nothing was ever downloaded for this one; an empty folder would only
      // make the backup look like it contains something it does not.
      continue
    }

    const folderCid = await buildTokenFolder(token, blockstore)
    const name = uniqueName(sanitizeFolderName(token.folderName, `#${token.ref.tokenId}`), tokenNames)

    // A freshly archived token replaces the historical copy of the same item
    // rather than sitting beside it under a suffixed name.
    const replaced = children.findIndex((child) => child.name.toLowerCase() === name.toLowerCase())
    const child = { name, cid: folderCid, size: await cumulativeSize(folderCid, blockstore) }
    if (replaced >= 0) {
      children[replaced] = child
    } else {
      children.push(child)
    }
  }

  const root = await buildDirectory(children, blockstore)

  await store.setRootCid(root.toString())

  emit(
    'done',
    `The ${ARCHIVE_ROOT_LABEL} folder is ready. Its address is ${root.toString()} — note that this ` +
      'address changes every time anything in the archive changes.',
    1,
    root.toString()
  )

  return root
}

/**
 * Merge a backup that already exists on IPFS into this archive.
 *
 * This is the replacement for "IPFS Desktop → Import → From IPFS → paste the
 * hash". The whole backup is downloaded as verified blocks, so afterwards the
 * archive can re-export it (or any part of it) without depending on anyone
 * else's node staying online.
 *
 * When the backup has fallen off the network — the common and important case,
 * and the reason this app exists — this fails within a couple of minutes with a
 * message that says what actually happened and what can still be done, instead
 * of hanging.
 */
export async function mergeExistingBackup(
  rootCid: string,
  store: ArchiveStore,
  onProgress: ProgressArg,
  signalArg?: AbortSignal
): Promise<void> {
  const run = runSettings(onProgress, signalArg)
  const signal = run.signal
  const text = String(rootCid ?? '').trim()
  const emit = makeEmit(`import:${text}`, run.onProgress)
  const blockstore = store.blockstore

  emit('resolving', 'Checking the backup address…', 0.02)

  const cid = parseBackupAddress(text)

  throwIfCancelled(signal)

  emit(
    'fetching-metadata',
    'Downloading the existing backup. Large backups can take several minutes…',
    0.1
  )

  // Ask the routing system who is holding this backup *while* the download is
  // running rather than after it fails. Content that has fallen off the network
  // takes over a minute to give up on, and a member should not watch a silent
  // progress bar for that long wondering whether the app has frozen. The answer
  // is also exactly what is needed to explain the failure, so it costs nothing.
  let downloadFinished = false
  const healthProbe = checkHealth(cid.toString(), 'existing backup', signal)
    .then((result) => {
      if (!downloadFinished && result.verdict === 'unreachable') {
        emit(
          'fetching-metadata',
          'No computer on the IPFS network says it has this backup. Still trying the gateways directly, ' +
            'in case one of them has a copy…',
          0.15
        )
      }
      return result
    })
    .catch(() => undefined)

  let downloaded
  try {
    downloaded = await fetchDag(cid, blockstore, { signal, headersTimeoutMs: 20_000 })
    downloadFinished = true
  } catch (err) {
    downloadFinished = true
    if (isCancellation(err)) throw err
    const explanation = explainUnreachable(await healthProbe)
    const message = `That backup could not be downloaded. ${messageOf(err)}${explanation}`
    emit('error', message)
    throw plain(message, err)
  }

  emit(
    'storing',
    `Downloaded ${downloaded.blocks} pieces (${formatBytes(downloaded.bytes)}) from ${hostOf(downloaded.gateway)}.`,
    0.6
  )

  let entries
  try {
    entries = await listDirectory(cid, blockstore)
  } catch (err) {
    const message =
      `That address was downloaded, but it is not a backup folder — it looks like a single file. ` +
      `Paste the address of the folder that contains the token folders. (${messageOf(err)})`
    emit('error', message)
    throw plain(message, err)
  }

  await store.addImportedRoot(cid.toString())

  const preview = entries
    .slice(0, 5)
    .map((entry) => entry.name)
    .join(', ')

  emit(
    'storing',
    `That backup contains ${entries.length} ${entries.length === 1 ? 'item' : 'items'}. Adding them to this archive…`,
    0.8,
    preview === '' ? undefined : `${preview}${entries.length > 5 ? ', …' : ''}`
  )

  emit('verifying', `Rebuilding the ${ARCHIVE_ROOT_LABEL} folder…`, 0.92)

  let newRoot: CID
  try {
    // Only the cancellation signal is passed on: this operation reports its own
    // progress under its own id, and a second stream of `done` events would
    // confuse a GUI that groups events by id.
    newRoot = await buildArchiveRoot(store, { signal })
  } catch (err) {
    const message =
      `The backup was downloaded and added to this archive, but the ${ARCHIVE_ROOT_LABEL} folder could ` +
      `not be rebuilt afterwards. ${messageOf(err)}`
    emit('error', message)
    throw plain(message, err)
  }

  emit(
    'done',
    `Merged ${entries.length} ${entries.length === 1 ? 'item' : 'items'} from the existing backup. ` +
      `The ${ARCHIVE_ROOT_LABEL} folder now has a new address: ${newRoot.toString()}`,
    1
  )
}

// ---------------------------------------------------------------------------
// Working out where content lives
// ---------------------------------------------------------------------------

/** Somewhere content can be fetched from, already classified. */
type FetchTarget =
  | { kind: 'ipfs'; root: CID; path: string; sourceUrl: string }
  | { kind: 'http'; url: string; sourceUrl: string }
  | { kind: 'arweave'; urls: string[]; sourceUrl: string }
  | { kind: 'data'; raw: string }

/** What relative links inside the metadata should be resolved against. */
interface AssetContext {
  /** The IPFS folder the metadata itself was in, when it came from IPFS. */
  ipfsBase?: { root: CID; dir: string }
  /** The https address the metadata came from, when it came off the web. */
  httpBase?: string
}

function targetFromTokenUri(tokenUri: ResolvedTokenUri): FetchTarget {
  if (tokenUri.kind === 'data') {
    return { kind: 'data', raw: tokenUri.raw }
  }

  if (tokenUri.kind === 'ipfs') {
    const ipfsPath = tokenUri.ipfsPath
    if (ipfsPath === undefined) {
      throw plain(
        'The collection gave back an IPFS link that this app could not make sense of, so there is ' +
          'nothing to download.'
      )
    }
    return ipfsTarget(parseCid(ipfsPath.cid), ipfsPath.path)
  }

  const url = tokenUri.normalizedUrl ?? tokenUri.raw

  if (tokenUri.kind === 'arweave') {
    return { kind: 'arweave', urls: arweaveCandidates(url), sourceUrl: tokenUri.raw }
  }

  return { kind: 'http', url, sourceUrl: tokenUri.raw }
}

function ipfsTarget(root: CID, path: string): FetchTarget {
  const clean = trimPath(path)
  return {
    kind: 'ipfs',
    root,
    path: clean,
    sourceUrl: clean === '' ? `ipfs://${root.toString()}` : `ipfs://${root.toString()}/${clean}`
  }
}

function assetContext(tokenUri: ResolvedTokenUri, metadataTarget: FetchTarget): AssetContext {
  const context: AssetContext = {}

  if (metadataTarget.kind === 'ipfs') {
    const segments = trimPath(metadataTarget.path).split('/').filter((s) => s !== '')
    segments.pop() // drop the metadata file itself
    context.ipfsBase = { root: metadataTarget.root, dir: segments.join('/') }
  }

  if (metadataTarget.kind === 'http' || metadataTarget.kind === 'arweave') {
    const base = metadataTarget.kind === 'http' ? metadataTarget.url : metadataTarget.urls[0]
    if (base !== undefined) context.httpBase = base
  }

  if (tokenUri.kind === 'http' && tokenUri.normalizedUrl !== undefined) {
    context.httpBase = tokenUri.normalizedUrl
  }

  return context
}

/**
 * Classify one link found inside the metadata.
 *
 * Order matters. Gateway URLs such as `https://ipfs.io/ipfs/Qm…/1.png` are
 * recognised as IPFS *before* they are treated as ordinary web links, because
 * that is what lets the original CID be preserved instead of the file being
 * re-downloaded and re-hashed into something new.
 */
function targetFromAssetUrl(raw: string, context: AssetContext): FetchTarget {
  const text = String(raw ?? '').trim()

  if (text === '') {
    throw plain('The link in the token information was empty.')
  }

  if (/^data:/i.test(text)) {
    return { kind: 'data', raw: text }
  }

  if (/^ar:\/\//i.test(text)) {
    return { kind: 'arweave', urls: arweaveCandidates(text), sourceUrl: text }
  }

  if (isArweaveUrl(text)) {
    return { kind: 'arweave', urls: arweaveCandidates(text), sourceUrl: text }
  }

  const ipfs = parseIpfsUri(text)
  if (ipfs !== null) {
    return ipfsTarget(parseCid(ipfs.cid), ipfs.path)
  }

  if (/^https?:\/\//i.test(text)) {
    return { kind: 'http', url: text, sourceUrl: text }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    throw plain(
      `"${shorten(text, 80)}" is a kind of link this app does not know how to download. ` +
        'Only IPFS, Arweave, https and on-chain links can be archived.'
    )
  }

  // A bare relative name such as "1.png" — resolve it beside the metadata.
  const base = context.ipfsBase
  if (base !== undefined) {
    const joined = joinPath(base.dir, text)
    return ipfsTarget(base.root, joined)
  }

  if (context.httpBase !== undefined) {
    try {
      return { kind: 'http', url: new URL(text, context.httpBase).toString(), sourceUrl: text }
    } catch {
      // Fall through to the error below.
    }
  }

  throw plain(
    `"${shorten(text, 80)}" is not a complete link, and there is nothing to work out where it points ` +
      'from, so it could not be downloaded.'
  )
}

function parseCid(value: string): CID {
  try {
    return CID.parse(value.trim())
  } catch {
    throw plain(`"${shorten(value, 80)}" is not a valid IPFS address, so it could not be downloaded.`)
  }
}

/** Accept a bare CID, an `ipfs://…` link, or a `/ipfs/…` gateway path. */
function parseBackupAddress(text: string): CID {
  if (text === '') {
    throw plain('Please paste the address of the backup you want to bring in.')
  }

  const parsed = parseIpfsUri(text)
  if (parsed !== null && trimPath(parsed.path) === '') {
    return parseCid(parsed.cid)
  }
  if (parsed !== null) {
    throw plain(
      `"${shorten(text, 80)}" points at something inside a backup rather than the backup itself. ` +
        'Paste the address of the whole backup folder, without anything after it.'
    )
  }

  throw plain(
    `"${shorten(text, 80)}" is not an IPFS address. It should look like ` +
      '"bafybei…" or "Qm…", or a link such as "ipfs://bafybei…".'
  )
}

function isArweaveUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase()
    return host === 'arweave.net' || host.endsWith('.arweave.net') || host === 'ar-io.net'
  } catch {
    return false
  }
}

/** Every address worth trying for one piece of Arweave content, in order. */
function arweaveCandidates(value: string): string[] {
  const text = value.trim()
  const urls: string[] = []

  if (/^ar:\/\//i.test(text)) {
    const id = text.slice(5).replace(/^\/+/, '')
    for (const gateway of ARWEAVE_GATEWAYS) {
      urls.push(`${gateway.replace(/\/$/, '')}/${id}`)
    }
    return urls
  }

  urls.push(text)

  try {
    const parsed = new URL(text)
    for (const gateway of ARWEAVE_GATEWAYS) {
      const alternate = `${gateway.replace(/\/$/, '')}${parsed.pathname}${parsed.search}`
      if (!urls.includes(alternate)) urls.push(alternate)
    }
  } catch {
    // Not parseable as a URL; the original string is the only candidate.
  }

  return urls
}

// ---------------------------------------------------------------------------
// Fetching one resource
// ---------------------------------------------------------------------------

/**
 * Download one item and store it in the blockstore, whatever kind of address it
 * has.
 *
 * The three-way logic is the same for metadata and for every asset:
 *
 *   IPFS     — verified blocks first, so the original CID survives untouched.
 *              Only if every trustless gateway fails do we fall back to an
 *              ordinary gateway and then try to rebuild the original CID from
 *              the bytes.
 *   web/Arweave — plain download; there is no original CID to preserve, so the
 *              content is imported with our own settings and `cidPreserved` is
 *              true because there was nothing to fail to match.
 *   on-chain — nothing to download at all.
 */
async function fetchResource(
  role: string,
  target: FetchTarget,
  blockstore: Blockstore,
  signal: AbortSignal | undefined,
  emit: Emit
): Promise<FetchedResource> {
  throwIfCancelled(signal)

  switch (target.kind) {
    case 'data':
      return fetchOnChain(target.raw, blockstore)
    case 'http':
      return fetchOverWeb(target.url, target.sourceUrl, 'http', blockstore, signal)
    case 'arweave':
      return fetchFromArweave(target.urls, target.sourceUrl, blockstore, signal)
    case 'ipfs':
      return fetchFromIpfs(role, target, blockstore, signal, emit)
  }
}

async function fetchOnChain(raw: string, blockstore: Blockstore): Promise<FetchedResource> {
  const decoded = decodeDataUri(raw)
  const stored = await addBytes(decoded.bytes, blockstore)

  const resource: FetchedResource = {
    cid: stored.cid.toString(),
    cidPreserved: true,
    bytes: decoded.bytes.byteLength,
    sha256: sha256Hex(decoded.bytes),
    source: 'onchain',
    sourceUrl: shorten(raw, 256),
    fetchedAt: new Date().toISOString(),
    notes: [
      'This content is stored directly on the Ethereum blockchain, so there was nothing to download ' +
        'from IPFS or the web. It is saved here exactly as the contract returned it.'
    ]
  }
  if (decoded.contentType !== undefined) resource.contentType = decoded.contentType
  return resource
}

async function fetchOverWeb(
  url: string,
  sourceUrl: string,
  source: 'http' | 'arweave',
  blockstore: Blockstore,
  signal: AbortSignal | undefined
): Promise<FetchedResource> {
  const response = await fetchHttpBytes(url, { signal })

  if (response.bytes.byteLength === 0) {
    throw plain(`${hostOf(url)} returned an empty file.`)
  }

  const stored = await addBytes(response.bytes, blockstore)

  const note =
    source === 'arweave'
      ? `Downloaded from Arweave through ${hostOf(url)}. Arweave content is paid for up front and is ` +
        'meant to be permanent, but it is copied into this backup so it survives independently.'
      : `Downloaded over the web from ${hostOf(url)}. A web address is not content-addressed — nobody ` +
        'can prove from the address alone that this is what the link served years ago — which is exactly ' +
        'why it has been copied into IPFS here.'

  const resource: FetchedResource = {
    cid: stored.cid.toString(),
    // Nothing to match against: web and Arweave addresses carry no CID.
    cidPreserved: true,
    bytes: response.bytes.byteLength,
    sha256: sha256Hex(response.bytes),
    source,
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    notes: [note]
  }
  if (response.contentType !== undefined) resource.contentType = response.contentType
  if (source === 'arweave') resource.gateway = originOf(url)
  return resource
}

async function fetchFromArweave(
  urls: string[],
  sourceUrl: string,
  blockstore: Blockstore,
  signal: AbortSignal | undefined
): Promise<FetchedResource> {
  const problems: string[] = []

  for (const url of urls) {
    throwIfCancelled(signal)
    try {
      return await fetchOverWeb(url, sourceUrl, 'arweave', blockstore, signal)
    } catch (err) {
      if (isCancellation(err)) throw err
      problems.push(`${hostOf(url)} — ${messageOf(err)}`)
    }
  }

  throw plain(
    `This content could not be downloaded from Arweave. What each address said: ${problems.join('; ')}.`
  )
}

/**
 * The IPFS path: verified blocks first, rescue second.
 *
 * On the happy path the CID is preserved because we never reassemble anything —
 * we store the original blocks, hash-checked one by one. Only when that fails
 * everywhere do we reach for an ordinary gateway, and then the honest question
 * is whether the bytes we got back can be re-built into the original CID.
 */
async function fetchFromIpfs(
  role: string,
  target: Extract<FetchTarget, { kind: 'ipfs' }>,
  blockstore: Blockstore,
  signal: AbortSignal | undefined,
  emit: Emit
): Promise<FetchedResource> {
  const { root, path, sourceUrl } = target

  try {
    const downloaded = await fetchDag(root, blockstore, { path, signal })
    const exact = await resolvePath(root, path, blockstore, { signal })
    const measured = await measureStored(exact, blockstore)

    const notes = [
      `Downloaded as verifiable IPFS blocks from ${hostOf(downloaded.gateway)}. Every block was ` +
        're-hashed as it arrived, so this is byte-for-byte the content the collection pointed at and ' +
        'its original IPFS address is unchanged.'
    ]
    if (measured.isDirectory) {
      notes.push(
        'This item is a folder containing several files rather than a single file. The SHA-256 shown ' +
          "is of the folder's own IPFS block, not of one file."
      )
    }

    const resource: FetchedResource = {
      cid: exact.toString(),
      cidPreserved: true,
      originalCid: exact.toString(),
      bytes: measured.bytes,
      sha256: measured.sha256,
      source: 'ipfs',
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      gateway: downloaded.gateway,
      notes
    }
    const contentType = guessContentType(sourceUrl)
    if (contentType !== undefined) resource.contentType = contentType
    return resource
  } catch (err) {
    if (isCancellation(err)) throw err

    emit(
      role === 'metadata' ? 'fetching-metadata' : 'fetching-assets',
      `No gateway would hand over the ${describeRole(role)} in verifiable form. Trying ordinary IPFS ` +
        'gateways so at least the content is not lost…',
      undefined,
      messageOf(err)
    )

    return rescueFromIpfs(target, blockstore, signal, messageOf(err))
  }
}

/**
 * Last resort: fetch the reassembled bytes from an ordinary gateway and try to
 * rebuild the original CID from them.
 *
 * This is the automated version of the part of the manual instructions that
 * tells a member to keep re-running `ipfs add` with different flags and compare
 * the result at cid.ipfs.tech until it matches.
 */
async function rescueFromIpfs(
  target: Extract<FetchTarget, { kind: 'ipfs' }>,
  blockstore: Blockstore,
  signal: AbortSignal | undefined,
  trustlessProblem: string
): Promise<FetchedResource> {
  const { root, path, sourceUrl } = target

  // Which CID should the rescued bytes reproduce? If the link pointed straight
  // at a file we know it. If it pointed inside a folder we only know it when we
  // already hold that folder's listing — so ask, but strictly offline (no
  // gateways), because the network has already told us it has nothing.
  let originalCid: CID | undefined
  if (path === '') {
    originalCid = root
  } else if (await hasBlock(blockstore, root)) {
    try {
      originalCid = await resolvePath(root, path, blockstore, { gateways: [] })
    } catch {
      originalCid = undefined
    }
  }

  const rescued = await fetchIpfsBytesFallback(root, path, { signal })

  const notes = [
    `The verifiable download failed on every gateway (${trustlessProblem}). The content was instead ` +
      `downloaded in ordinary form from ${hostOf(rescued.gateway)}, which cannot be checked against the ` +
      'original address as it arrives.'
  ]

  if (originalCid !== undefined && rescued.bytes.byteLength <= MAX_RECONSTRUCT_BYTES) {
    const rebuilt = await reconstructCid(rescued.bytes, originalCid, blockstore)

    const settings = `${rebuilt.tried} different ${rebuilt.tried === 1 ? 'setting' : 'settings'}`

    notes.push(
      rebuilt.matched
        ? `The bytes were then re-built locally: after trying ${settings}, the original IPFS address was ` +
          'reproduced exactly, which confirms this is the original content byte-for-byte.'
        : `The bytes were then re-built locally with ${settings}, and none reproduced the original ` +
          `address (${originalCid.toString()}). The content has been saved, but under a different ` +
          'address, so it cannot be proved to be byte-identical to the original.'
    )

    const resource: FetchedResource = {
      cid: rebuilt.cid.toString(),
      cidPreserved: rebuilt.matched,
      originalCid: originalCid.toString(),
      bytes: rescued.bytes.byteLength,
      sha256: sha256Hex(rescued.bytes),
      source: 'ipfs',
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      gateway: rescued.gateway,
      notes
    }
    const contentType = rescued.contentType ?? guessContentType(sourceUrl)
    if (contentType !== undefined) resource.contentType = contentType
    return resource
  }

  if (originalCid === undefined) {
    notes.push(
      'The folder listing this file belongs to could not be downloaded either, so the file\'s own ' +
        'original IPFS address is unknown and there was nothing to check the rescued content against. ' +
        `The address it came from was ${sourceUrl}.`
    )
  } else {
    notes.push(
      'The file is too large to rebuild repeatedly in memory, so no attempt was made to reproduce its ' +
        'original address. The content is saved under a newly computed address.'
    )
  }

  const stored = await addBytes(rescued.bytes, blockstore)

  const resource: FetchedResource = {
    cid: stored.cid.toString(),
    cidPreserved: false,
    originalCid: (originalCid ?? root).toString(),
    bytes: rescued.bytes.byteLength,
    sha256: sha256Hex(rescued.bytes),
    source: 'ipfs',
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    gateway: rescued.gateway,
    notes
  }
  const contentType = rescued.contentType ?? guessContentType(sourceUrl)
  if (contentType !== undefined) resource.contentType = contentType
  return resource
}

// ---------------------------------------------------------------------------
// Building the folders
// ---------------------------------------------------------------------------

/**
 * Build one token's folder in the archive, exactly as the hand-made backups are
 * laid out, and return its CID.
 *
 * Deterministic: it depends only on the token record and on blocks already in
 * the blockstore, which is what lets {@link buildArchiveRoot} rebuild every
 * folder from the manifest and always get the same answer.
 */
async function buildTokenFolder(token: ArchivedToken, blockstore: Blockstore): Promise<CID> {
  const tree = emptyFolderNode()

  if (token.metadata !== undefined) {
    insertAtPath(tree, layoutPathFor('metadata', token.metadata), parseCid(token.metadata.cid))
  }

  for (const [role, resource] of Object.entries(token.assets)) {
    insertAtPath(tree, layoutPathFor(role, resource), parseCid(resource.cid))
  }

  // The audit record describes everything above, so it is generated last.
  const provenance = await addBytes(encodeProvenance(token), blockstore)
  insertAtPath(tree, [LAYOUT.provenance], provenance.cid)

  return encodeFolderNode(tree, blockstore)
}

/** The provenance record as the exact bytes written into the archive. */
function encodeProvenance(token: ArchivedToken): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(buildProvenance(token), null, 2) + '\n', 'utf8'))
}

/** One entry of a directory being assembled. `size` is the dag-pb `Tsize`. */
interface DirectoryChild {
  name: string
  cid: CID
  size: number
}

/**
 * A folder being planned in memory before any of it is encoded.
 *
 * dag-pb directories are immutable: adding a link means re-encoding the node and
 * every node above it. Planning the whole shape first and encoding each folder
 * exactly once turns what would be quadratic work into a single pass — which
 * matters the moment a member merges a backup holding thousands of entries.
 */
interface FolderNode {
  files: Array<{ name: string; cid: CID }>
  dirs: Map<string, FolderNode>
}

function emptyFolderNode(): FolderNode {
  return { files: [], dirs: new Map<string, FolderNode>() }
}

function insertAtPath(node: FolderNode, segments: string[], cid: CID): void {
  const head = segments[0]

  if (head === undefined) {
    throw plain('Internal error: an item was added to the archive without a name.')
  }

  if (segments.length === 1) {
    node.files.push({ name: head, cid })
    return
  }

  let child = node.dirs.get(head)
  if (child === undefined) {
    child = emptyFolderNode()
    node.dirs.set(head, child)
  }
  insertAtPath(child, segments.slice(1), cid)
}

/** Encode a planned folder bottom-up. Link order is canonicalised by dag.ts. */
async function encodeFolderNode(node: FolderNode, blockstore: Blockstore): Promise<CID> {
  const children: DirectoryChild[] = []

  for (const file of node.files) {
    children.push({ name: file.name, cid: file.cid, size: await cumulativeSize(file.cid, blockstore) })
  }

  for (const [name, sub] of node.dirs) {
    const cid = await encodeFolderNode(sub, blockstore)
    children.push({ name, cid, size: await cumulativeSize(cid, blockstore) })
  }

  return buildDirectory(children, blockstore)
}

/** Folder names must be unique and must not collide case-insensitively. */
function uniqueName(base: string, taken: Set<string>): string {
  const claim = (name: string): string => {
    taken.add(name.toLowerCase())
    return name
  }

  if (!taken.has(base.toLowerCase())) return claim(base)

  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})`
    if (!taken.has(candidate.toLowerCase())) return claim(candidate)
  }

  return claim(`${base} (${Date.now()})`)
}

/** Pick a folder name for a token that does not clash with the ones already saved. */
function pickFolderName(name: string, ref: TokenRef, store: ArchiveStore): string {
  const base = sanitizeFolderName(name, `#${ref.tokenId}`)
  const taken = new Set<string>()

  for (const other of store.listTokens()) {
    if (
      other.ref.chainId === ref.chainId &&
      String(other.ref.contract).toLowerCase() === String(ref.contract).toLowerCase() &&
      String(other.ref.tokenId) === String(ref.tokenId)
    ) {
      continue // this is the token being re-archived; it may keep its name
    }
    taken.add(other.folderName.toLowerCase())
  }

  return uniqueName(base, taken)
}

// ---------------------------------------------------------------------------
// Reading content back out of the blockstore
// ---------------------------------------------------------------------------

/** Size and SHA-256 of stored content, without ever buffering the whole thing. */
interface Measured {
  bytes: number
  sha256: string
  isDirectory: boolean
}

async function measureStored(cid: CID, blockstore: Blockstore): Promise<Measured> {
  const entry = await exporter(cid, blockstore)

  if (entry.type === 'directory') {
    // A folder has no single stream of bytes; hash its own block instead, which
    // is what its CID commits to anyway.
    const block = await getBlockBytes(blockstore, cid)
    return {
      bytes: await cumulativeSize(cid, blockstore),
      sha256: sha256Hex(block),
      isDirectory: true
    }
  }

  const hash = createHash('sha256')
  let total = 0

  for await (const chunk of streamOf(entry, cid)) {
    hash.update(chunk)
    total += chunk.byteLength
  }

  return { bytes: total, sha256: hash.digest('hex'), isDirectory: false }
}

/** Read stored content back as one buffer. Used for metadata, which we parse. */
async function readStoredBytes(
  cid: CID,
  blockstore: Blockstore,
  maxBytes: number
): Promise<Uint8Array> {
  const entry = await exporter(cid, blockstore)

  if (entry.type === 'directory') {
    throw plain(
      'The link in the contract points at a folder rather than a file, so there is no token ' +
        'information to read. It may be missing the file name at the end.'
    )
  }

  const chunks: Uint8Array[] = []
  let total = 0

  for await (const chunk of streamOf(entry, cid)) {
    total += chunk.byteLength
    if (total > maxBytes) {
      throw plain(
        `The token information is larger than ${formatBytes(maxBytes)}, which is far bigger than any ` +
          'real NFT description. It has not been read.'
      )
    }
    chunks.push(chunk)
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** The byte stream of an exported entry, whichever UnixFS shape it has. */
function streamOf(entry: Awaited<ReturnType<typeof exporter>>, cid: CID): AsyncIterable<Uint8Array> {
  if (entry.type === 'file') return entry.content()
  if (entry.type === 'raw') return entry.content()
  if (entry.type === 'identity') return entry.content()

  throw plain(
    `The content at ${cid.toString()} is stored in a form this app cannot read as a file ` +
      `(${entry.type}). It has not been changed; it simply cannot be opened here.`
  )
}

/** Are the root blocks of everything we recorded actually on disk? */
async function findMissingBlocks(token: ArchivedToken, blockstore: Blockstore): Promise<string[]> {
  const missing: string[] = []
  const items: Array<[string, FetchedResource]> = []

  if (token.metadata !== undefined) items.push(['the token information', token.metadata])
  for (const [role, resource] of Object.entries(token.assets)) {
    items.push([describeRole(role), resource])
  }

  for (const [label, resource] of items) {
    let cid: CID
    try {
      cid = CID.parse(resource.cid)
    } catch {
      missing.push(label)
      continue
    }
    if (!(await hasBlock(blockstore, cid))) {
      missing.push(label)
    }
  }

  return missing
}

// ---------------------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------------------

interface ParsedMetadata {
  json?: Record<string, unknown>
  problem: string
}

function parseMetadataJson(bytes: Uint8Array): ParsedMetadata {
  let text: string
  try {
    text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
  } catch {
    return { problem: 'the file is not text' }
  }

  // Strip a UTF-8 byte order mark, which JSON.parse refuses.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (err) {
    return { problem: messageOf(err) }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { problem: 'the file is valid JSON but is not a description of a token' }
  }

  return { json: value as Record<string, unknown>, problem: '' }
}

function readName(json: Record<string, unknown> | undefined, ref: TokenRef): string {
  if (json !== undefined) {
    for (const field of ['name', 'title']) {
      const value = json[field]
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim()
      }
    }
  }
  return `#${ref.tokenId}`
}

// ---------------------------------------------------------------------------
// `data:` URIs
// ---------------------------------------------------------------------------

/**
 * Decode a `data:` URI — the automated replacement for pasting a base64 blob
 * into an online decoder, which is what the manual instructions ask for.
 */
function decodeDataUri(uri: string): { bytes: Uint8Array; contentType?: string } {
  const text = String(uri ?? '').trim()

  if (!/^data:/i.test(text)) {
    throw plain('The on-chain information for this token is not in a form this app can read.')
  }

  const comma = text.indexOf(',')
  if (comma === -1) {
    throw plain(
      'The on-chain information for this token is incomplete — the contract returned a data link with ' +
        'no content after it.'
    )
  }

  const header = text.slice('data:'.length, comma)
  const payload = text.slice(comma + 1)
  const isBase64 = /;\s*base64\s*$/i.test(header)
  const mediaType = header.replace(/;\s*base64\s*$/i, '').split(';')[0]?.trim() ?? ''

  let bytes: Uint8Array
  if (isBase64) {
    bytes = new Uint8Array(Buffer.from(payload.replace(/\s+/g, ''), 'base64'))
  } else {
    let decoded = payload
    try {
      decoded = decodeURIComponent(payload)
    } catch {
      // Some contracts emit unescaped characters; use them as they are.
    }
    bytes = new Uint8Array(Buffer.from(decoded, 'utf8'))
  }

  if (bytes.byteLength === 0) {
    throw plain('The on-chain information for this token is empty.')
  }

  const result: { bytes: Uint8Array; contentType?: string } = { bytes }
  if (mediaType !== '') result.contentType = mediaType
  return result
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Extensions worth guessing a media type from, so exports open by double-click. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  json: 'application/json',
  txt: 'text/plain',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json'
}

function guessContentType(url: string): string | undefined {
  const withoutQuery = url.split(/[?#]/)[0] ?? ''
  const last = withoutQuery.split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  if (dot <= 0) return undefined
  return TYPE_BY_EXTENSION[last.slice(dot + 1).toLowerCase()]
}

function describeTokenUri(tokenUri: ResolvedTokenUri): string {
  switch (tokenUri.kind) {
    case 'data':
      return 'stored directly on the Ethereum blockchain'
    case 'ipfs':
      return `on IPFS at ${tokenUri.ipfsPath?.cid ?? 'an address we could not read'}`
    case 'arweave':
      return 'on Arweave'
    default:
      return `on the web at ${hostOf(tokenUri.normalizedUrl ?? tokenUri.raw)}`
  }
}

/** Turn an asset role such as `image_original` into something readable. */
function describeRole(role: string): string {
  if (role === 'metadata') return 'token information'
  return role.replace(/_/g, ' ')
}

function doneMessage(token: ArchivedToken): string {
  const count = (token.metadata === undefined ? 0 : 1) + Object.keys(token.assets).length
  const bytes =
    (token.metadata?.bytes ?? 0) +
    Object.values(token.assets).reduce((sum, asset) => sum + asset.bytes, 0)

  const rescued = [
    ...(token.metadata === undefined ? [] : [token.metadata]),
    ...Object.values(token.assets)
  ].filter((resource) => !resource.cidPreserved)

  const head = `${token.name} archived — ${count} ${count === 1 ? 'file' : 'files'}, ${formatBytes(bytes)}`

  if (token.status === 'partial') {
    return `${head}, with ${token.errors.length} ${token.errors.length === 1 ? 'problem' : 'problems'} to look at.`
  }
  if (rescued.length > 0) {
    return `${head}. ${rescued.length} of them could not keep their original IPFS address.`
  }
  return `${head}, all with their original IPFS addresses intact.`
}

function placeholderToken(ref: TokenRef, message: string): ArchivedToken {
  return {
    ref,
    name: `#${ref.tokenId}`,
    folderName: `#${ref.tokenId}`,
    // Nothing was ever read from the contract, so there is no real token URI to
    // record; the reason is in `errors`.
    tokenUri: { raw: '', kind: 'http', onchain: false },
    assets: {},
    status: 'failed',
    errors: [message],
    archivedAt: new Date().toISOString()
  }
}

/**
 * Say *why* something is unreachable, from what the routing system reported,
 * rather than guessing. Only ever used after a download has already failed.
 */
function explainUnreachable(health: HealthResult | undefined): string {
  if (health === undefined) return ''

  if (health.providers === 0) {
    return (
      ' No computer on the IPFS network is currently offering this content, which usually means every ' +
      'copy of it has gone offline. If a member still has the files, ask them to add and pin them again, ' +
      'or to send you their .car file so it can be imported directly.'
    )
  }

  return (
    ` ${health.providers} ${health.providers === 1 ? 'computer says it has' : 'computers say they have'} ` +
    'this content, but no gateway would pass it on to us. It is worth trying again in a few minutes.'
  )
}

function trimPath(path: string): string {
  return String(path ?? '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/** Join a relative link onto a folder path, honouring `.` and `..`. */
function joinPath(dir: string, relative: string): string {
  const out = dir.split('/').filter((segment) => segment !== '')

  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }

  return out.join('/')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} characters in total)`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown amount'
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
