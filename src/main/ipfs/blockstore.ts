/**
 * Local content-addressed block storage.
 *
 * Every byte the archiver keeps lands here first, keyed by its CID. Keeping raw
 * IPFS *blocks* (rather than reassembled files) is what lets us hand the user a
 * `.car` whose root CID is bit-for-bit the CID the smart contract referenced —
 * no re-chunking, no guessing at chunker/CID-version parameters.
 *
 * This module is a thin, well-typed wrapper around `blockstore-fs`. The one
 * wrinkle worth knowing about: in this version of `interface-blockstore`,
 * `blockstore.get()` returns an *iterable of chunks*, not a `Uint8Array`. Use
 * {@link getBlockBytes} rather than calling `get()` directly.
 */

import { mkdir } from 'node:fs/promises'
import { FsBlockstore } from 'blockstore-fs'
import type { Blockstore as InterfaceBlockstore } from 'interface-blockstore'
import type { CID } from 'multiformats/cid'

/**
 * A content-addressed block store: `CID -> bytes`.
 *
 * Re-exported so other modules can depend on this alias instead of reaching
 * into `interface-blockstore` themselves. Any implementation satisfies it —
 * `FsBlockstore` in the app, `MemoryBlockstore` from `blockstore-core` in tests.
 */
export type Blockstore = InterfaceBlockstore

/** Multihash code for the `identity` hash function. */
const IDENTITY_HASH_CODE = 0x00

/**
 * Open (creating if necessary) a filesystem-backed blockstore at `dir`.
 *
 * Safe to call on a directory that already holds blocks — existing content is
 * reused, which is what makes an interrupted archive resumable.
 *
 * @param dir - Absolute path of the directory to hold the blocks.
 * @throws A plain-English error if the directory cannot be created or opened.
 */
export async function openBlockstore(dir: string): Promise<Blockstore> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    throw new Error(
      `The archive folder could not be created at "${dir}". ` +
        `Check that the drive is connected and that you have permission to write there. ` +
        `(${errorText(err)})`
    )
  }

  const store = new FsBlockstore(dir, { createIfMissing: true, errorIfExists: false })

  try {
    await store.open()
  } catch (err) {
    throw new Error(
      `The archive storage at "${dir}" could not be opened. ` +
        `It may be in use by another copy of this app, or the disk may be full or read-only. ` +
        `(${errorText(err)})`
    )
  }

  return store
}

/**
 * Close a blockstore opened by {@link openBlockstore}, flushing anything held
 * open. Blockstores that have no `close()` method are left alone.
 */
export async function closeBlockstore(blockstore: Blockstore): Promise<void> {
  const closable = blockstore as { close?: () => Promise<void> | void }
  if (typeof closable.close === 'function') {
    await closable.close()
  }
}

/**
 * Read one block back out as a single `Uint8Array`.
 *
 * Prefer this over `blockstore.get()`, which yields a stream of chunks.
 * `identity` CIDs carry their own bytes and are answered without touching disk.
 *
 * @throws Whatever the underlying store throws when the block is absent — call
 * {@link hasBlock} first if absence is an expected outcome.
 */
export async function getBlockBytes(blockstore: Blockstore, cid: CID): Promise<Uint8Array> {
  if (cid.multihash.code === IDENTITY_HASH_CODE) {
    return cid.multihash.digest
  }
  return collectBytes(blockstore.get(cid))
}

/** Store one block. Storing a block that is already present is a no-op. */
export async function putBlock(blockstore: Blockstore, cid: CID, bytes: Uint8Array): Promise<void> {
  if (cid.multihash.code === IDENTITY_HASH_CODE) {
    // The bytes are inside the CID itself; there is nothing to persist.
    return
  }
  await blockstore.put(cid, bytes)
}

/**
 * Is this block already stored locally?
 *
 * Never throws: a store that errors on `has()` (closed, disk unplugged) is
 * reported as "not present" so callers fall through to re-fetching.
 */
export async function hasBlock(blockstore: Blockstore, cid: CID): Promise<boolean> {
  if (cid.multihash.code === IDENTITY_HASH_CODE) {
    return true
  }
  try {
    return await blockstore.has(cid)
  } catch {
    return false
  }
}

/** Concatenate an (a)sync iterable of byte chunks into one `Uint8Array`. */
async function collectBytes(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0

  for await (const chunk of source) {
    chunks.push(chunk)
    total += chunk.byteLength
  }

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

/** Best-effort human-readable text for an unknown thrown value. */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}
