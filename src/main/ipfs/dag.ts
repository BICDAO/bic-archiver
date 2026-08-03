/**
 * UnixFS directory construction.
 *
 * This module replaces the manual "New folder" / drag-and-drop steps a DAO
 * member would otherwise perform in IPFS Desktop. Everything here produces
 * *canonical* dag-pb, byte-for-byte identical to what Kubo and IPFS Desktop
 * produce for the same content, because a directory whose CID differs from the
 * reference implementation silently breaks compatibility with every other
 * backup and with the gateways used to verify it.
 *
 * The two rules that make that work:
 *
 *  1. Links are sorted by the raw UTF-8 bytes of their `Name` (Kubo sorts with
 *     Go's byte-wise string comparison). `@ipld/dag-pb`'s `prepare()` applies
 *     the same ordering; we sort explicitly as well so the intent is visible
 *     and so `validate()` can never reject our nodes.
 *  2. Every link carries a `Tsize` — the *cumulative* size of the whole sub-DAG
 *     it points at, i.e. the sum of every block byte length beneath it,
 *     including the linked block itself. `cumulativeSize()` computes it.
 *
 * Directory nodes carry no per-child bookkeeping inside their UnixFS `Data`
 * field: `filesize` and `blocksizes` are file-only fields (see
 * `UnixFS.marshal()` in `ipfs-unixfs`, which omits `filesize` for directories).
 * All size bookkeeping for a directory therefore lives in the parent's link
 * `Tsize`, which is what this module maintains.
 *
 * No function here performs any network I/O — everything is served from the
 * local blockstore, so there is nothing to time out.
 */

import * as dagPb from '@ipld/dag-pb'
import { exporter } from 'ipfs-unixfs-exporter'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

import type { PBLink, PBNode } from '@ipld/dag-pb'
import type { Blockstore } from 'interface-blockstore'

/** Multihash code for the identity hash — the block bytes live inside the CID. */
const IDENTITY_HASH_CODE = 0x00

const textEncoder = new TextEncoder()

/**
 * One entry in a directory listing. `size` is the dag-pb link `Tsize`, i.e. the
 * cumulative size of that entry's whole sub-DAG.
 */
interface DirectoryEntry {
  name: string
  cid: CID
  size: number
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build an Error whose message a non-technical DAO member can act on, while
 * keeping the technical cause attached for the log.
 */
function plainError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause })
}

/* -------------------------------------------------------------------------- */
/* Blockstore helpers                                                         */
/* -------------------------------------------------------------------------- */

function isIterable(value: unknown): value is Iterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Iterable<Uint8Array>)[Symbol.iterator] === 'function'
  )
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
  )
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const first = chunks[0]
  if (chunks.length === 1 && first !== undefined) {
    return first
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Read one whole block out of the blockstore.
 *
 * `interface-blockstore` v7 returns a (possibly async) stream of chunks rather
 * than a single buffer; older versions returned `Promise<Uint8Array>`. Both
 * shapes are accepted so this module keeps working whichever blockstore the
 * rest of the app hands us.
 */
async function readBlock(blockstore: Blockstore, cid: CID): Promise<Uint8Array> {
  if (cid.multihash.code === IDENTITY_HASH_CODE) {
    // Identity CIDs carry their own content — nothing to look up.
    return cid.multihash.digest
  }

  let source: unknown
  try {
    source = await Promise.resolve(blockstore.get(cid) as unknown)
  } catch (err) {
    throw plainError(
      `Part of this archive is missing from your computer (${cid.toString()}). Download or import it again before continuing.`,
      err
    )
  }

  if (source instanceof Uint8Array) {
    return source
  }

  if (!isAsyncIterable(source) && !isIterable(source)) {
    throw plainError(
      `Could not read part of this archive (${cid.toString()}) — the local storage returned something unexpected.`
    )
  }

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of source as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
      total += chunk.byteLength
    }
  } catch (err) {
    throw plainError(
      `Part of this archive is missing from your computer (${cid.toString()}). Download or import it again before continuing.`,
      err
    )
  }

  return concatChunks(chunks, total)
}

async function putBlock(blockstore: Blockstore, cid: CID, bytes: Uint8Array): Promise<void> {
  try {
    await Promise.resolve(blockstore.put(cid, bytes) as unknown)
  } catch (err) {
    throw plainError(
      'Could not save the archive folder to local storage. Check that you have enough free disk space and try again.',
      err
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Canonical link ordering                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compare two links exactly the way Kubo (and `@ipld/dag-pb`) do: byte-wise
 * over the UTF-8 encoding of the name, shorter-is-smaller on a common prefix.
 */
function compareLinks(a: PBLink, b: PBLink): number {
  const aBytes = textEncoder.encode(a.Name ?? '')
  const bBytes = textEncoder.encode(b.Name ?? '')
  const shared = Math.min(aBytes.length, bBytes.length)

  for (let i = 0; i < shared; i++) {
    const x = aBytes[i] ?? 0
    const y = bBytes[i] ?? 0
    if (x !== y) {
      return x < y ? -1 : 1
    }
  }

  if (aBytes.length === bBytes.length) {
    return 0
  }
  return aBytes.length < bBytes.length ? -1 : 1
}

/** Sort in place using the canonical dag-pb ordering. */
function sortLinks(links: PBLink[]): PBLink[] {
  links.sort(compareLinks)
  return links
}

/* -------------------------------------------------------------------------- */
/* Name / size validation                                                     */
/* -------------------------------------------------------------------------- */

function assertUsableName(name: string): void {
  if (name.length === 0) {
    throw plainError('A folder or file inside the archive needs a name — an empty name is not allowed.')
  }
  if (name === '.' || name === '..') {
    throw plainError(`"${name}" cannot be used as a name inside the archive.`)
  }
  if (name.includes('/') || name.includes('\\')) {
    throw plainError(
      `The name "${name}" contains a slash. Names inside the archive must be a single folder or file name.`
    )
  }
  if (name.includes('\0')) {
    throw plainError('A name inside the archive contains an invalid character and cannot be used.')
  }
}

function assertUsableSize(size: number, name: string): number {
  if (!Number.isFinite(size) || size < 0) {
    throw plainError(`The recorded size of "${name}" is not a valid number, so the archive folder cannot be built.`)
  }
  // dag-pb `Tsize` is an integer; `validate()` rejects anything else.
  return Math.round(size)
}

/* -------------------------------------------------------------------------- */
/* Node encoding                                                              */
/* -------------------------------------------------------------------------- */

/** Encode + hash + store a directory node, returning its CIDv1 dag-pb CID. */
async function storeDirectoryNode(
  data: Uint8Array | undefined,
  links: PBLink[],
  blockstore: Blockstore
): Promise<CID> {
  const prepared: PBNode = dagPb.prepare(
    data === undefined ? { Links: sortLinks(links) } : { Data: data, Links: sortLinks(links) }
  )
  dagPb.validate(prepared)

  const bytes = dagPb.encode(prepared)
  const cid = CID.createV1(dagPb.code, await sha256.digest(bytes))
  await putBlock(blockstore, cid, bytes)
  return cid
}

/** Decode a dag-pb node and confirm it really is a UnixFS directory. */
async function loadDirectoryNode(
  dirCid: CID,
  blockstore: Blockstore
): Promise<{ node: PBNode; unixfs?: UnixFS }> {
  if (dirCid.code !== dagPb.code) {
    throw plainError(
      `"${dirCid.toString()}" is a file, not a folder, so nothing can be added inside it.`
    )
  }

  const bytes = await readBlock(blockstore, dirCid)

  let node: PBNode
  try {
    node = dagPb.decode(bytes)
  } catch (err) {
    throw plainError(
      `The folder "${dirCid.toString()}" in this archive is damaged and could not be read.`,
      err
    )
  }

  if (node.Data === undefined) {
    // A links-only dag-pb node. Unusual, but it behaves like a directory.
    return { node }
  }

  let unixfs: UnixFS
  try {
    unixfs = UnixFS.unmarshal(node.Data)
  } catch (err) {
    throw plainError(
      `The folder "${dirCid.toString()}" in this archive is damaged and could not be read.`,
      err
    )
  }

  if (!unixfs.isDirectory()) {
    throw plainError(`"${dirCid.toString()}" is a file, not a folder, so nothing can be added inside it.`)
  }

  if (unixfs.type === 'hamt-sharded-directory') {
    throw plainError(
      'This folder was saved in a split (sharded) format that this app cannot add to. Export it as a browsable folder and re-archive it instead.'
    )
  }

  return { node, unixfs }
}

/**
 * Produce the UnixFS `Data` bytes for a directory we are about to re-encode.
 *
 * Normally the existing bytes are reused verbatim so that a node we only
 * re-linked round-trips byte-for-byte. If the node somehow carries file-only
 * bookkeeping (`blocksizes`, which directories must never have), it is
 * re-marshalled through `ipfs-unixfs` so the stale fields are dropped.
 */
function directoryData(node: PBNode, unixfs: UnixFS | undefined): Uint8Array | undefined {
  if (unixfs === undefined) {
    return node.Data
  }
  if (unixfs.blockSizes.length === 0) {
    return node.Data
  }
  const clean = new UnixFS({
    type: 'directory',
    data: unixfs.data,
    mode: unixfs.mode,
    mtime: unixfs.mtime
  })
  return clean.marshal()
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The canonical empty UnixFS directory.
 *
 * Returns the block rather than storing it, so the caller decides which
 * blockstore it belongs in. CIDv1 dag-pb / sha2-256, matching the default the
 * modern IPFS tooling (and the DAO's own `bafybei…` backup roots) uses.
 */
export async function emptyDirectory(): Promise<{ cid: CID; bytes: Uint8Array }> {
  const unixfs = new UnixFS({ type: 'directory' })
  const node: PBNode = dagPb.prepare({ Data: unixfs.marshal(), Links: [] })
  dagPb.validate(node)

  const bytes: Uint8Array = dagPb.encode(node)
  const cid = CID.createV1(dagPb.code, await sha256.digest(bytes))

  return { cid, bytes }
}

/**
 * Add (or replace) one named entry inside an existing directory.
 *
 * The links are re-sorted into canonical order and the node re-encoded, so the
 * returned CID is exactly what Kubo would produce for the same directory
 * contents. The new node is written to `blockstore`; the old one is left alone
 * (content addressing means nothing was mutated).
 *
 * `entrySize` must be the *cumulative* size of the sub-DAG being linked — use
 * {@link cumulativeSize} if you do not already have it.
 */
export async function addLinkToDirectory(
  dirCid: CID,
  name: string,
  entryCid: CID,
  entrySize: number,
  blockstore: Blockstore
): Promise<CID> {
  assertUsableName(name)
  const tsize = assertUsableSize(entrySize, name)

  const { node, unixfs } = await loadDirectoryNode(dirCid, blockstore)

  // Keep the surviving links exactly as decoded (a link with no `Name` must
  // stay nameless, not become ""), then append or replace ours.
  const links: PBLink[] = node.Links.filter((link) => (link.Name ?? '') !== name)
  links.push({ Name: name, Tsize: tsize, Hash: entryCid })

  return await storeDirectoryNode(directoryData(node, unixfs), links, blockstore)
}

/**
 * Build a directory node from scratch in one shot.
 *
 * `size` on each entry is the cumulative size of that entry's sub-DAG — the
 * value {@link cumulativeSize} returns, and the value that ends up in the
 * dag-pb link `Tsize`.
 */
export async function buildDirectory(
  entries: Array<{ name: string; cid: CID; size: number }>,
  blockstore: Blockstore
): Promise<CID> {
  const links: PBLink[] = []
  const used = new Set<string>()

  for (const entry of entries) {
    assertUsableName(entry.name)
    if (used.has(entry.name)) {
      throw plainError(
        `This archive folder would contain two items called "${entry.name}". Rename one of them and try again.`
      )
    }
    used.add(entry.name)
    links.push({
      Name: entry.name,
      Tsize: assertUsableSize(entry.size, entry.name),
      Hash: entry.cid
    })
  }

  const data = new UnixFS({ type: 'directory' }).marshal()
  return await storeDirectoryNode(data, links, blockstore)
}

/**
 * List the immediate children of a directory.
 *
 * Sharded (HAMT) directories — which this app never creates but an imported
 * backup might contain — are read through the UnixFS exporter so their entries
 * come back as real names rather than shard prefixes.
 */
export async function listDirectory(dirCid: CID, blockstore: Blockstore): Promise<DirectoryEntry[]> {
  if (dirCid.code !== dagPb.code) {
    throw plainError(`"${dirCid.toString()}" is a file, not a folder, so it has no contents to list.`)
  }

  const bytes = await readBlock(blockstore, dirCid)

  let node: PBNode
  try {
    node = dagPb.decode(bytes)
  } catch (err) {
    throw plainError(`The folder "${dirCid.toString()}" in this archive is damaged and could not be read.`, err)
  }

  if (node.Data !== undefined) {
    let unixfs: UnixFS
    try {
      unixfs = UnixFS.unmarshal(node.Data)
    } catch (err) {
      throw plainError(
        `The folder "${dirCid.toString()}" in this archive is damaged and could not be read.`,
        err
      )
    }

    if (!unixfs.isDirectory()) {
      throw plainError(`"${dirCid.toString()}" is a file, not a folder, so it has no contents to list.`)
    }

    if (unixfs.type === 'hamt-sharded-directory') {
      const entry = await exporter(dirCid, blockstore)
      if (entry.type !== 'directory') {
        throw plainError(`"${dirCid.toString()}" is a file, not a folder, so it has no contents to list.`)
      }
      const sharded: DirectoryEntry[] = []
      for await (const child of entry.entries()) {
        sharded.push({ name: child.name, cid: child.cid, size: Number(child.size) })
      }
      sharded.sort((a, b) => compareLinks({ Name: a.name, Hash: a.cid }, { Name: b.name, Hash: b.cid }))
      return sharded
    }
  }

  return node.Links.map((link) => ({
    name: link.Name ?? '',
    cid: link.Hash,
    size: link.Tsize ?? 0
  }))
}

/**
 * Total size in bytes of every block in the sub-DAG rooted at `cid`, including
 * the root block itself. This is the number that belongs in a parent link's
 * `Tsize`.
 *
 * Link `Tsize` values already present in the DAG are trusted (that is what Kubo
 * does), so this normally only reads one block.
 */
export async function cumulativeSize(cid: CID, blockstore: Blockstore): Promise<number> {
  return await cumulativeSizeInner(cid, blockstore, new Map<string, number>(), new Set<string>())
}

async function cumulativeSizeInner(
  cid: CID,
  blockstore: Blockstore,
  memo: Map<string, number>,
  inProgress: Set<string>
): Promise<number> {
  const key = cid.toString()

  const cached = memo.get(key)
  if (cached !== undefined) {
    return cached
  }
  if (inProgress.has(key)) {
    throw plainError('This archive links back to itself in a loop and cannot be measured.')
  }
  inProgress.add(key)

  try {
    const bytes = await readBlock(blockstore, cid)
    let total = bytes.byteLength

    if (cid.code === dagPb.code) {
      let node: PBNode
      try {
        node = dagPb.decode(bytes)
      } catch (err) {
        throw plainError(`Part of this archive (${key}) is damaged and could not be measured.`, err)
      }

      for (const link of node.Links) {
        total +=
          typeof link.Tsize === 'number'
            ? link.Tsize
            : await cumulativeSizeInner(link.Hash, blockstore, memo, inProgress)
      }
    }

    memo.set(key, total)
    return total
  } finally {
    inProgress.delete(key)
  }
}

/**
 * Create nested directories under `root`, returning the new root CID.
 *
 * This is what lets the app build `BIC Backup/<Token Name>/…` without a member
 * ever clicking "New folder". Segments that already exist are reused; empty
 * segments and `.` are ignored so a path like `"/BIC Backup/Ape #1"` split on
 * `/` just works.
 *
 * If nothing had to be created the original `root` is returned unchanged.
 */
export async function mkdirp(root: CID, segments: string[], blockstore: Blockstore): Promise<CID> {
  const clean: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue
    }
    assertUsableName(segment)
    clean.push(segment)
  }

  if (clean.length === 0) {
    return root
  }

  return await mkdirpInner(root, clean, 0, blockstore)
}

async function mkdirpInner(
  dirCid: CID,
  segments: string[],
  index: number,
  blockstore: Blockstore
): Promise<CID> {
  if (index >= segments.length) {
    return dirCid
  }

  const name = segments[index]
  if (name === undefined) {
    return dirCid
  }

  const children = await listDirectory(dirCid, blockstore)
  const existing = children.find((child) => child.name === name)

  let childCid: CID

  if (existing !== undefined) {
    if (!(await isDirectory(existing.cid, blockstore))) {
      throw plainError(
        `Cannot create the folder "${name}" because a file with that name is already there. Rename the file and try again.`
      )
    }
    childCid = await mkdirpInner(existing.cid, segments, index + 1, blockstore)
    if (childCid.equals(existing.cid)) {
      // Nothing below us changed, so this directory does not change either.
      return dirCid
    }
  } else {
    const empty = await emptyDirectory()
    await putBlock(blockstore, empty.cid, empty.bytes)
    childCid = await mkdirpInner(empty.cid, segments, index + 1, blockstore)
  }

  const size = await cumulativeSize(childCid, blockstore)
  return await addLinkToDirectory(dirCid, name, childCid, size, blockstore)
}

/** True when `cid` names a UnixFS directory that we can add entries to. */
async function isDirectory(cid: CID, blockstore: Blockstore): Promise<boolean> {
  if (cid.code !== dagPb.code) {
    return false
  }

  let node: PBNode
  try {
    node = dagPb.decode(await readBlock(blockstore, cid))
  } catch {
    return false
  }

  if (node.Data === undefined) {
    return true
  }

  try {
    return UnixFS.unmarshal(node.Data).isDirectory()
  } catch {
    return false
  }
}
