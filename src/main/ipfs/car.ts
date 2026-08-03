/**
 * CAR import / export.
 *
 * A `.car` file is the app's primary deliverable. Unlike a `.tar`, it preserves
 * the IPFS block structure — the chunking, the dag-pb layout and the hashes —
 * so the original CID can be reproduced from the backup years later. That is
 * exactly the property the DAO lost when its Oct-2025 root fell off the
 * network, so every function here is strict about verification and loud (in
 * plain English) about failure.
 *
 * Nothing in this module touches the network: it moves blocks between the local
 * blockstore and the local disk, so there is no request to time out. What it
 * does guard against is hanging forever on a stalled disk write, DAGs that link
 * back into themselves, and archives containing names crafted to escape the
 * folder the member chose.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { CarBlockIterator, CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { exporter } from 'ipfs-unixfs-exporter'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { sha256, sha512 } from 'multiformats/hashes/sha2'

import type { PBNode } from '@ipld/dag-pb'
import type { Blockstore } from 'interface-blockstore'
import type { UnixFSDirectory, UnixFSEntry } from 'ipfs-unixfs-exporter'
import type { MultihashHasher } from 'multiformats/hashes/interface'

/** Multihash code for the identity hash — such blocks carry their own bytes. */
const IDENTITY_HASH_CODE = 0x00

/**
 * Hash functions we can verify a block against. Anything else means we cannot
 * prove an imported block matches its CID, and we refuse rather than pretend.
 */
const HASHERS = new Map<number, MultihashHasher>([
  [sha256.code, sha256],
  [sha512.code, sha512],
  [identity.code, identity]
])

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** An Error a non-technical DAO member can act on, with the cause kept for logs. */
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
 * `interface-blockstore` v7 yields a (possibly async) stream of chunks; older
 * versions resolved a single `Uint8Array`. Both are accepted so this module
 * keeps working whichever blockstore the rest of the app hands us.
 */
async function readBlock(blockstore: Blockstore, cid: CID): Promise<Uint8Array> {
  if (cid.multihash.code === IDENTITY_HASH_CODE) {
    return cid.multihash.digest
  }

  const missing = (err?: unknown): Error =>
    plainError(
      `This backup is incomplete — one piece of the content (${cid.toString()}) is not on this computer. Fetch or import the missing content, then export again.`,
      err
    )

  let source: unknown
  try {
    source = await Promise.resolve(blockstore.get(cid) as unknown)
  } catch (err) {
    throw missing(err)
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
    throw missing(err)
  }

  return concatChunks(chunks, total)
}

/**
 * A stable de-duplication key. Normalising to v1 means the same block reached
 * through a CIDv0 link and a CIDv1 link is written to the CAR only once.
 */
function blockKey(cid: CID): string {
  return cid.toV1().toString()
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Walk the complete DAG rooted at `root` and stream every block into a CARv1
 * file at `outPath`. This replaces the manual "Export CAR" click.
 *
 * dag-pb nodes are decoded so their links are followed; raw, identity and any
 * other codec are treated as leaves (their bytes are still written, we simply
 * cannot see inside them). Blocks are written once each, in depth-first order.
 *
 * If any block of the DAG is not in the blockstore the export fails instead of
 * producing a half-backup that would not verify — a silently incomplete `.car`
 * is precisely the failure mode this app exists to prevent. The partial file is
 * removed on failure.
 *
 * @param onProgress called with the running total of blocks written so far.
 * @returns `blocks` — how many distinct blocks were written; `bytes` — the size
 *          of the finished `.car` file on disk.
 */
export async function exportCar(
  root: CID,
  blockstore: Blockstore,
  outPath: string,
  onProgress?: (n: number) => void
): Promise<{ blocks: number; bytes: number }> {
  const target = resolve(outPath)

  try {
    await mkdir(dirname(target), { recursive: true })
  } catch (err) {
    throw plainError(
      `Could not create the folder for "${target}". Choose a different location and try again.`,
      err
    )
  }

  const { writer, out } = CarWriter.create([root])
  const fileStream = createWriteStream(target)

  const writing = pipeline(Readable.from(out), fileStream)

  let walkDone = false

  // If the disk write dies, `writer.put()` would park forever on backpressure
  // waiting for a reader that has gone away. Racing the walk against the sink
  // guarantees we surface the disk error instead of hanging.
  const sinkFailed = new Promise<never>((_, reject) => {
    writing.then(
      () => {
        if (!walkDone) {
          reject(plainError('Writing the backup file stopped before all of the content was saved.'))
        }
      },
      (err: unknown) => {
        if (!walkDone) {
          reject(
            plainError(
              `Could not write the backup file "${target}". Check that the drive is connected and has enough free space.`,
              err
            )
          )
        }
      }
    )
  })
  // The race below consumes this; keep Node from reporting it as unhandled.
  sinkFailed.catch(() => {})

  let blocks = 0
  let blockBytes = 0

  const walk = async (): Promise<void> => {
    const seen = new Set<string>()
    const stack: CID[] = [root]

    while (stack.length > 0) {
      const cid = stack.pop()
      if (cid === undefined) {
        break
      }

      const key = blockKey(cid)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)

      const bytes = await readBlock(blockstore, cid)
      await writer.put({ cid, bytes })

      blocks++
      blockBytes += bytes.byteLength

      if (onProgress !== undefined) {
        try {
          onProgress(blocks)
        } catch {
          // A misbehaving progress listener must never abort a backup.
        }
      }

      if (cid.code === dagPb.code) {
        let node: PBNode
        try {
          node = dagPb.decode(bytes)
        } catch (err) {
          throw plainError(
            `Part of this archive (${cid.toString()}) is damaged and could not be read, so the backup was not created.`,
            err
          )
        }

        // Push in reverse so the DAG comes out in depth-first, link order.
        for (let i = node.Links.length - 1; i >= 0; i--) {
          const link = node.Links[i]
          if (link !== undefined && !seen.has(blockKey(link.Hash))) {
            stack.push(link.Hash)
          }
        }
      }
    }

    await writer.close()
    walkDone = true
  }

  try {
    await Promise.race([walk(), sinkFailed])
    await writing
  } catch (err) {
    // Deliberately not awaited: when the sink has died, a `put()` still parked
    // on backpressure would make `close()` wait forever, and failing fast with
    // a clear message matters more than a tidy shutdown.
    void writer.close().catch(() => {})
    void writing.catch(() => {})
    fileStream.destroy()
    await unlink(target).catch(() => {})
    throw err instanceof Error ? err : plainError('The backup could not be created.', err)
  }

  let bytes = blockBytes
  try {
    bytes = (await stat(target)).size
  } catch {
    // Fall back to the summed block sizes if the file cannot be measured.
  }

  return { blocks, bytes }
}

/* -------------------------------------------------------------------------- */
/* Import                                                                     */
/* -------------------------------------------------------------------------- */

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/**
 * Re-hash a block and confirm it really is the block its CID claims. This is
 * what makes an emailed backup trustworthy without trusting the sender.
 */
async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<void> {
  const hasher = HASHERS.get(cid.multihash.code)

  if (hasher === undefined) {
    throw plainError(
      `This backup uses a hashing method this app does not understand (code ${cid.multihash.code}), so its contents cannot be checked. It was not imported.`
    )
  }

  const digest = await hasher.digest(bytes)

  if (!bytesEqual(digest.digest, cid.multihash.digest)) {
    throw plainError(
      `This backup file is damaged — one of its pieces (${cid.toString()}) does not match its fingerprint. Ask whoever sent it for a fresh copy.`
    )
  }
}

/**
 * Read a CARv1 or CARv2 file from disk into the blockstore, verifying the hash
 * of every block before it is stored. Lets a member restore from a backup
 * someone emailed them.
 *
 * @returns the CAR's declared roots and how many blocks were imported.
 */
export async function importCar(
  inPath: string,
  blockstore: Blockstore
): Promise<{ roots: CID[]; blocks: number }> {
  const source = resolve(inPath)

  try {
    const info = await stat(source)
    if (!info.isFile()) {
      throw plainError(`"${source}" is a folder, not a backup file.`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('is a folder')) {
      throw err
    }
    throw plainError(`Could not open "${source}". Check that the file is still there and try again.`, err)
  }

  const stream = createReadStream(source)

  let reader: CarBlockIterator
  try {
    reader = await CarBlockIterator.fromIterable(stream)
  } catch (err) {
    stream.destroy()
    throw plainError(
      `"${source}" does not look like an IPFS backup (.car) file, so nothing was imported.`,
      err
    )
  }

  let roots: CID[]
  try {
    roots = await reader.getRoots()
  } catch (err) {
    stream.destroy()
    throw plainError(`"${source}" is damaged — its list of contents could not be read.`, err)
  }

  let blocks = 0

  try {
    for await (const block of reader) {
      await verifyBlock(block.cid, block.bytes)

      try {
        await Promise.resolve(blockstore.put(block.cid, block.bytes) as unknown)
      } catch (err) {
        throw plainError(
          'Could not save the imported content to local storage. Check that you have enough free disk space and try again.',
          err
        )
      }

      blocks++
    }
  } catch (err) {
    throw err instanceof Error
      ? err
      : plainError(`"${source}" could not be imported because it is damaged.`, err)
  } finally {
    stream.destroy()
  }

  return { roots, blocks }
}

/* -------------------------------------------------------------------------- */
/* Browsable folder export                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reject any path component that could take us outside the folder the member
 * chose. Link names inside a DAG are attacker-controlled in the general case,
 * so `..`, absolute paths, drive letters, separators and NULs are refused
 * outright rather than silently rewritten.
 */
function assertSafeComponent(name: string): void {
  if (name.length === 0) {
    throw plainError(
      'This archive contains an item with no name, so it cannot be saved as a normal folder. Save it as a .car backup instead.'
    )
  }
  if (name === '.' || name === '..') {
    throw plainError(
      `This archive contains an item named "${name}", which could write outside the folder you chose. Nothing was saved — the archive may be unsafe.`
    )
  }
  if (name.includes('/') || name.includes('\\')) {
    throw plainError(
      `This archive contains an item named "${name}", which could write outside the folder you chose. Nothing was saved — the archive may be unsafe.`
    )
  }
  if (name.includes('\0')) {
    throw plainError(
      'This archive contains an item whose name has an invalid character in it, so it cannot be saved as a normal folder.'
    )
  }
  if (isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
    throw plainError(
      `This archive contains an item named "${name}", which could write outside the folder you chose. Nothing was saved — the archive may be unsafe.`
    )
  }
}

/** Belt-and-braces: the resolved path must still sit inside `base`. */
function assertInside(base: string, candidate: string): void {
  const root = resolve(base)
  const full = resolve(candidate)
  if (full !== root && !full.startsWith(root + sep)) {
    throw plainError(
      'This archive tried to write a file outside the folder you chose, so nothing was saved. The archive may be unsafe.'
    )
  }
}

/** Stream a file-like entry to disk, returning how many bytes were written. */
async function writeFileEntry(entry: UnixFSEntry, target: string): Promise<number> {
  if (entry.type === 'directory') {
    throw plainError('Internal error: tried to write a folder as a file.')
  }

  if (entry.type === 'object') {
    // dag-cbor / dag-json nodes have no byte stream; save the encoded block.
    await writeFile(target, entry.node)
    return entry.node.byteLength
  }

  let written = 0
  const counted = async function* (): AsyncGenerator<Uint8Array> {
    for await (const chunk of entry.content()) {
      written += chunk.byteLength
      yield chunk
    }
  }

  try {
    await pipeline(Readable.from(counted()), createWriteStream(target))
  } catch (err) {
    throw plainError(
      `Could not save "${target}". Check that the drive is connected and has enough free space.`,
      err
    )
  }

  return written
}

/**
 * Write a normal, browsable directory tree to disk — the equivalent of the
 * manual "Download as .tar" option, but already unpacked.
 *
 * Note for members: a folder on disk does NOT preserve the IPFS hashes. Use
 * {@link exportCar} for anything that has to be verifiable later; this is for
 * looking at the files.
 *
 * @returns `files` — how many files were written; `bytes` — their total size.
 */
export async function exportBrowsableFolder(
  root: CID,
  blockstore: Blockstore,
  outDir: string
): Promise<{ files: number; bytes: number }> {
  const base = resolve(outDir)

  try {
    await mkdir(base, { recursive: true })
  } catch (err) {
    throw plainError(
      `Could not create the folder "${base}". Choose a different location and try again.`,
      err
    )
  }

  let rootEntry: UnixFSEntry
  try {
    rootEntry = await exporter(root, blockstore)
  } catch (err) {
    throw plainError(
      `This archive is incomplete — its contents (${root.toString()}) could not be read from this computer.`,
      err
    )
  }

  let files = 0
  let bytes = 0

  if (rootEntry.type !== 'directory') {
    // A single file was archived rather than a folder; name it after its CID.
    const target = join(base, root.toString())
    assertInside(base, target)
    bytes += await writeFileEntry(rootEntry, target)
    files++
    return { files, bytes }
  }

  const writeDirectory = async (
    directory: UnixFSDirectory,
    dirPath: string,
    ancestors: Set<string>
  ): Promise<void> => {
    const key = directory.cid.toString()
    if (ancestors.has(key)) {
      throw plainError('This archive contains a folder that links back into itself, so it cannot be unpacked.')
    }
    ancestors.add(key)

    for await (const child of directory.entries()) {
      assertSafeComponent(child.name)

      const target = join(dirPath, child.name)
      assertInside(base, target)

      let childEntry: UnixFSEntry
      try {
        childEntry = await exporter(child.cid, blockstore)
      } catch (err) {
        throw plainError(
          `This archive is incomplete — "${child.name}" could not be read from this computer.`,
          err
        )
      }

      if (childEntry.type === 'directory') {
        try {
          await mkdir(target, { recursive: true })
        } catch (err) {
          throw plainError(`Could not create the folder "${target}".`, err)
        }
        await writeDirectory(childEntry, target, ancestors)
      } else {
        bytes += await writeFileEntry(childEntry, target)
        files++
      }
    }

    ancestors.delete(key)
  }

  await writeDirectory(rootEntry, base, new Set<string>())

  return { files, bytes }
}
