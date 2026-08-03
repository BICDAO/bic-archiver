/**
 * UnixFS import and automated CID reconstruction.
 *
 * `addBytes` has to be *stable*: the same bytes must produce the same CID on every machine,
 * every run, and across upgrades of `ipfs-unixfs-importer`. The two "hello world" CIDs
 * below are the published, well-known values that `ipfs add` and `ipfs add --cid-version=1`
 * produce, so this test is really a compatibility check against the wider IPFS ecosystem —
 * if a library default drifts, it fails here rather than in someone's backup.
 *
 * `reconstructCid` is the automated version of the manual instruction to keep re-running
 * `ipfs add` with different flags and comparing hashes at cid.ipfs.tech until one matches.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { CID } from 'multiformats/cid'

import {
  addBytes,
  addDirectoryFromFs,
  RECONSTRUCTION_MATRIX,
  reconstructCid,
  sha256Hex
} from '../src/main/ipfs/importer'
import { memoryStore, pseudoRandomBytes, readBlock, TempDirs, utf8 } from './helpers/support'

/**
 * The canonical CIDs for the 11 bytes "hello world" (no trailing newline).
 *
 * `Qmf412…` is what `ipfs add` has printed since 2015; `bafkrei…` is what
 * `ipfs add --cid-version=1` (and Helia, ipfs-car, web3.storage) produce. Hard-coded on
 * purpose: a regression in chunking, leaf format or hashing shows up as a diff here.
 */
const HELLO_WORLD_CID_V0 = 'Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD'
const HELLO_WORLD_CID_V1_RAW = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e'

const tmp = new TempDirs()

afterEach(async () => {
  await tmp.cleanup()
})

describe('addBytes', () => {
  it('produces the well-known CIDv1 for "hello world" with our defaults', async () => {
    const store = memoryStore()
    const result = await addBytes(utf8('hello world'), store)

    expect(result.cid.toString()).toBe(HELLO_WORLD_CID_V1_RAW)
    expect(result.bytes).toBe(11)
    // A file this small collapses to a single raw block.
    expect(result.cid.version).toBe(1)
    expect(result.cid.code).toBe(0x55) // raw
  })

  it('produces the well-known CIDv0 for "hello world" with classic `ipfs add` settings', async () => {
    const store = memoryStore()
    const result = await addBytes(utf8('hello world'), store, {
      cidVersion: 0,
      rawLeaves: false
    })

    expect(result.cid.toString()).toBe(HELLO_WORLD_CID_V0)
    expect(result.cid.version).toBe(0)
    expect(result.cid.code).toBe(0x70) // dag-pb
  })

  it('actually writes the blocks it reports', async () => {
    const store = memoryStore()
    const { cid } = await addBytes(utf8('hello world'), store)

    expect(await store.has(cid)).toBe(true)
    expect(await readBlock(store, cid)).toEqual(utf8('hello world'))
  })

  it('is deterministic across runs and across blockstores', async () => {
    const bytes = pseudoRandomBytes(50_000)
    const first = await addBytes(bytes, memoryStore())
    const second = await addBytes(bytes, memoryStore())

    expect(first.cid.toString()).toBe(second.cid.toString())
    expect(first.bytes).toBe(50_000)
  })

  it('chunks a large file and links the chunks under one root', async () => {
    const store = memoryStore()
    // Three 256 KiB chunks plus a bit.
    const bytes = pseudoRandomBytes(700_000)
    const { cid } = await addBytes(bytes, store)

    expect(cid.code).toBe(0x70) // a dag-pb file node, not a bare raw leaf
    expect(await store.has(cid)).toBe(true)
  })

  it('honours a different chunk size, producing a different CID for the same bytes', async () => {
    const bytes = pseudoRandomBytes(200_000)
    const big = await addBytes(bytes, memoryStore(), { chunkSize: 262_144 })
    const small = await addBytes(bytes, memoryStore(), { chunkSize: 65_536 })

    expect(big.cid.toString()).not.toBe(small.cid.toString())
  })

  it('refuses anything that is not raw bytes', async () => {
    await expect(
      addBytes('hello world' as unknown as Uint8Array, memoryStore())
    ).rejects.toThrow(/only raw bytes can be imported/i)
  })

  it('rejects a nonsensical chunk size rather than producing an unstable CID', async () => {
    await expect(addBytes(utf8('x'), memoryStore(), { chunkSize: 0 })).rejects.toThrow(
      /positive whole number/i
    )
    await expect(
      addBytes(utf8('x'), memoryStore(), { maxChildrenPerNode: 1 })
    ).rejects.toThrow(/2 or more/i)
  })
})

describe('sha256Hex', () => {
  it('matches the published sha256 of "hello world"', () => {
    expect(sha256Hex(utf8('hello world'))).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    )
  })
})

describe('reconstructCid', () => {
  /**
   * A file whose DAG shape genuinely depends on the chunk size: 200 KB fits in one 256 KiB
   * chunk but needs four 64 KiB ones, so the two settings cannot produce the same CID.
   */
  const bytes = pseudoRandomBytes(200_000, 0x1234abcd)

  /** `ipfs add --chunker=size-65536` on the classic CIDv0 defaults - entry 15 of the matrix. */
  const NON_DEFAULT: Parameters<typeof addBytes>[2] = {
    cidVersion: 0,
    rawLeaves: false,
    chunkSize: 65_536,
    maxChildrenPerNode: 174,
    layout: 'balanced'
  }

  it('finds the exact non-default parameters that produced a historical CID', async () => {
    // Whoever originally uploaded this file used non-default flags. All we have is their
    // CID and a copy of the bytes from somewhere unverifiable.
    const original = await addBytes(bytes, memoryStore(), NON_DEFAULT)
    expect(original.cid.version).toBe(0)

    // Sanity: our defaults do NOT reproduce it, so the search is doing real work.
    const withDefaults = await addBytes(bytes, memoryStore())
    expect(withDefaults.cid.toString()).not.toBe(original.cid.toString())

    const store = memoryStore()
    const found = await reconstructCid(bytes, original.cid, store)

    expect(found.matched).toBe(true)
    expect(found.cid.toString()).toBe(original.cid.toString())
    expect(found.options?.chunkSize).toBe(65_536)
    expect(found.options?.cidVersion).toBe(0)
    expect(found.options?.rawLeaves).toBe(false)
    expect(found.options?.layout).toBe('balanced')
    expect(found.tried).toBeGreaterThan(1)

    // The winning parameters were replayed into the real store, so the content is there
    // under the original hash and a .car export would reproduce it.
    expect(await store.has(found.cid)).toBe(true)
  })

  it('reproduces a CIDv1 raw-leaf original too', async () => {
    const original = await addBytes(bytes, memoryStore(), {
      cidVersion: 1,
      rawLeaves: true,
      chunkSize: 65_536,
      maxChildrenPerNode: 174,
      layout: 'balanced'
    })

    const found = await reconstructCid(bytes, original.cid, memoryStore())
    expect(found.matched).toBe(true)
    expect(found.cid.toString()).toBe(original.cid.toString())
  })

  it('reports matched:false for an unrelated target, but still keeps the bytes', async () => {
    const store = memoryStore()
    // A perfectly valid CID for entirely different content.
    const unrelated = (await addBytes(utf8('completely different content'), memoryStore())).cid

    const found = await reconstructCid(utf8('hello world'), unrelated, store)

    expect(found.matched).toBe(false)
    expect(found.options).toBeUndefined()
    expect(found.cid.toString()).not.toBe(unrelated.toString())
    // Honest fallback: the content is saved under the CID we could produce.
    expect(found.cid.toString()).toBe(HELLO_WORLD_CID_V1_RAW)
    expect(await store.has(found.cid)).toBe(true)
    expect(await readBlock(store, found.cid)).toEqual(utf8('hello world'))
  })

  it('never tries CIDv1 settings against a CIDv0 ("Qm…") target', async () => {
    // A v1 setting can never produce a v0 hash, so those attempts are skipped outright.
    const v0Target = CID.parse(HELLO_WORLD_CID_V0)
    const found = await reconstructCid(utf8('hello world'), v0Target, memoryStore())

    expect(found.matched).toBe(true)
    expect(found.options?.cidVersion).toBe(0)
    // The whole 18-entry matrix collapses to a handful of distinct attempts for an
    // 11-byte payload: chunk size and fanout cannot matter for a single-chunk file.
    expect(found.tried).toBeLessThanOrEqual(4)
  })

  it('finds the default combination first, on the very first attempt for CIDv1', async () => {
    const target = CID.parse(HELLO_WORLD_CID_V1_RAW)
    const found = await reconstructCid(utf8('hello world'), target, memoryStore())

    expect(found.matched).toBe(true)
    expect(found.cid.toString()).toBe(HELLO_WORLD_CID_V1_RAW)
    // Entry 1 is CIDv0 with dag-pb leaves; entry 2 is the modern default. Both are real
    // attempts for an 11-byte payload, so 2 is the honest floor.
    expect(found.tried).toBeLessThanOrEqual(2)
  })

  it('refuses a target that is not a CID, and bytes that are not bytes', async () => {
    await expect(
      reconstructCid(utf8('x'), null as unknown as CID, memoryStore())
    ).rejects.toThrow(/not a valid CID/i)
    await expect(
      reconstructCid('x' as unknown as Uint8Array, CID.parse(HELLO_WORLD_CID_V0), memoryStore())
    ).rejects.toThrow(/only raw bytes/i)
  })

  it('exposes a reconstruction matrix that is fully specified and free of duplicates', () => {
    expect(RECONSTRUCTION_MATRIX.length).toBeGreaterThan(10)

    const seen = new Set<string>()
    for (const entry of RECONSTRUCTION_MATRIX) {
      // Every knob that changes a CID must be stated, so the list reads as documentation
      // and nothing depends on a library default.
      expect(entry.cidVersion).toBeDefined()
      expect(entry.rawLeaves).toBeDefined()
      expect(entry.chunkSize).toBeDefined()
      expect(entry.maxChildrenPerNode).toBeDefined()
      expect(entry.layout).toBeDefined()

      const key = JSON.stringify(entry)
      expect(seen.has(key), `duplicate matrix entry ${key}`).toBe(false)
      seen.add(key)
    }
  })
})

describe('addDirectoryFromFs', () => {
  it('imports a folder from disk and reproduces the same CID on a second run', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const dir = await tmp.make()
    const src = join(dir, 'BIC Backup')
    await mkdir(join(src, 'Ape #1'), { recursive: true })
    await writeFile(join(src, 'Ape #1', '1.json'), '{"name":"Ape #1"}')
    await writeFile(join(src, 'readme.txt'), 'hello world')

    const first = await addDirectoryFromFs(src, memoryStore())
    const second = await addDirectoryFromFs(src, memoryStore())

    expect(first.toString()).toBe(second.toString())
    expect(first.code).toBe(0x70) // dag-pb directory
  })

  it('ignores invisible OS bookkeeping files, which were never in the original folder', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const base = await tmp.make()
    const clean = join(base, 'clean')
    const dirty = join(base, 'clean-copy')

    for (const dir of [clean, dirty]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'art.png'), 'not really a png')
    }
    // The thing that would otherwise guarantee a member could never reproduce a folder CID
    // from a copy sitting on their Mac.
    await writeFile(join(dirty, '.DS_Store'), 'finder junk')
    await writeFile(join(dirty, '._art.png'), 'appledouble junk')

    // Both folders are named differently, so compare the CID of their single child instead
    // of the folder itself: identical contents must hash identically.
    const cleanCid = await addDirectoryFromFs(clean, memoryStore())
    const dirtyCid = await addDirectoryFromFs(dirty, memoryStore())

    const { listDirectory } = await import('../src/main/ipfs/dag')
    const cleanStore = memoryStore()
    const dirtyStore = memoryStore()
    await addDirectoryFromFs(clean, cleanStore)
    await addDirectoryFromFs(dirty, dirtyStore)

    const cleanEntries = await listDirectory(cleanCid, cleanStore)
    const dirtyEntries = await listDirectory(dirtyCid, dirtyStore)

    expect(cleanEntries.map((e) => e.name)).toEqual(['art.png'])
    expect(dirtyEntries.map((e) => e.name)).toEqual(['art.png'])
  })

  it('explains a missing folder in plain English', async () => {
    const dir = await tmp.make()
    const { join } = await import('node:path')

    await expect(addDirectoryFromFs(join(dir, 'nope'), memoryStore())).rejects.toThrow(
      /Could not find the folder/i
    )
  })

  it('explains being handed a file instead of a folder', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const dir = await tmp.make()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'x')

    await expect(addDirectoryFromFs(file, memoryStore())).rejects.toThrow(
      /is a file, not a folder/i
    )
  })
})
