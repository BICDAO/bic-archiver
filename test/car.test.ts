/**
 * CAR import / export, and the browsable-folder escape hatch.
 *
 * The `.car` file is the app's deliverable, and the reason it exists rather than a `.zip`
 * is that it preserves block structure, so the original CID can be proved years later.
 * Two properties are therefore load-bearing:
 *
 *   1. export -> import round-trips every block, and the root CID is unchanged;
 *   2. a block whose bytes do not match its CID is REFUSED, not stored. Backups get
 *      emailed around a DAO; the recipient must not have to trust the sender.
 *
 * `exportBrowsableFolder` writes attacker-influenced link names straight onto the member's
 * disk, so its refusal to follow ".." out of the chosen folder is tested with a
 * hand-crafted dag-pb node that the app's own `buildDirectory` would never produce.
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

import { exportBrowsableFolder, exportCar, importCar } from '../src/main/ipfs/car'
import { buildDirectory, cumulativeSize } from '../src/main/ipfs/dag'
import { addBytes } from '../src/main/ipfs/importer'
import { at, memoryStore, pseudoRandomBytes, readBlock, TempDirs, utf8 } from './helpers/support'
import type { Blockstore } from 'interface-blockstore'
import type { PBLink } from '@ipld/dag-pb'

const tmp = new TempDirs()

afterEach(async () => {
  await tmp.cleanup()
})

/**
 * A small but genuinely multi-block archive: a folder holding two little files and one
 * file big enough to be chunked, which is what makes the export a real DAG walk rather
 * than a flat list.
 */
async function buildSampleArchive(store: Blockstore): Promise<{
  root: CID
  files: Record<string, { cid: CID; content: Uint8Array }>
}> {
  const metadata = utf8('{"name":"Bored Ape #1","image":"ipfs://QmImage"}')
  const provenance = utf8('{"sha256":"deadbeef"}')
  const image = pseudoRandomBytes(600_000, 0x5eed)

  const added = {
    '1.json': { ...(await addBytes(metadata, store)), content: metadata },
    '_provenance.json': { ...(await addBytes(provenance, store)), content: provenance },
    'image.png': { ...(await addBytes(image, store)), content: image }
  }

  const entries = await Promise.all(
    Object.entries(added).map(async ([name, value]) => ({
      name,
      cid: value.cid,
      size: await cumulativeSize(value.cid, store)
    }))
  )

  const root = await buildDirectory(entries, store)

  const files: Record<string, { cid: CID; content: Uint8Array }> = {}
  for (const [name, value] of Object.entries(added)) {
    files[name] = { cid: value.cid, content: value.content }
  }

  return { root, files }
}

/** Every distinct block CID reachable from `root`, depth-first. */
async function walkBlocks(root: CID, store: Blockstore): Promise<CID[]> {
  const seen = new Set<string>()
  const out: CID[] = []
  const stack: CID[] = [root]

  while (stack.length > 0) {
    const cid = stack.pop()
    if (cid === undefined) break
    const key = cid.toV1().toString()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cid)

    const bytes = await readBlock(store, cid)
    if (cid.code === dagPb.code) {
      for (const link of dagPb.decode(bytes).Links) stack.push(link.Hash)
    }
  }

  return out
}

/** Store a hand-crafted dag-pb directory node whose link names bypass our own validation. */
async function storeRawDirectory(links: PBLink[], store: Blockstore): Promise<CID> {
  const node = { Data: new UnixFS({ type: 'directory' }).marshal(), Links: links }
  const bytes = dagPb.encode(dagPb.prepare(node))
  const cid = CID.createV1(dagPb.code, await sha256.digest(bytes))
  await store.put(cid, bytes)
  return cid
}

describe('exportCar / importCar round trip', () => {
  it('writes every block and reads them all back under an unchanged root CID', async () => {
    const source = memoryStore()
    const { root, files } = await buildSampleArchive(source)
    const expected = await walkBlocks(root, source)
    expect(expected.length).toBeGreaterThan(4) // root + 2 small files + a chunked one

    const carPath = await tmp.file('backup.car')

    const progress: number[] = []
    const exported = await exportCar(root, source, carPath, (n) => progress.push(n))

    expect(exported.blocks).toBe(expected.length)
    expect(exported.bytes).toBeGreaterThan(0)
    expect(exported.bytes).toBe((await stat(carPath)).size)
    // Progress is reported per block, monotonically, ending at the total.
    expect(progress).toEqual(Array.from({ length: expected.length }, (_, i) => i + 1))

    // A completely fresh computer: nothing but the .car file.
    const restored = memoryStore()
    const imported = await importCar(carPath, restored)

    expect(imported.blocks).toBe(expected.length)
    expect(imported.roots.map((cid) => cid.toString())).toEqual([root.toString()])

    for (const cid of expected) {
      expect(await restored.has(cid), `missing block ${cid.toString()}`).toBe(true)
      expect(await readBlock(restored, cid)).toEqual(await readBlock(source, cid))
    }

    // And the restored blocks really do rebuild the same files.
    const outDir = await tmp.make()
    await exportBrowsableFolder(root, restored, outDir)
    for (const [name, value] of Object.entries(files)) {
      expect(new Uint8Array(await readFile(join(outDir, name)))).toEqual(value.content)
    }
  })

  it('round-trips a single file with no wrapping folder', async () => {
    const source = memoryStore()
    const { cid } = await addBytes(utf8('hello world'), source)
    const carPath = await tmp.file('one.car')

    const exported = await exportCar(cid, source, carPath)
    expect(exported.blocks).toBe(1)

    const restored = memoryStore()
    const imported = await importCar(carPath, restored)
    expect(imported.blocks).toBe(1)
    expect(at(imported.roots, 0).toString()).toBe(cid.toString())
    expect(await readBlock(restored, cid)).toEqual(utf8('hello world'))
  })

  it('refuses to write a half-backup when a block is missing locally', async () => {
    // The exact failure this app exists to prevent: a .car that looks fine and does not
    // verify. Better to fail loudly than to hand a member a broken backup.
    const source = memoryStore()
    const { root } = await buildSampleArchive(source)
    const blocks = await walkBlocks(root, source)
    const victim = at(blocks, blocks.length - 1)
    await source.delete(victim)

    const carPath = await tmp.file('incomplete.car')
    await expect(exportCar(root, source, carPath)).rejects.toThrow(
      /This backup is incomplete/i
    )

    // The partial file is cleaned up, not left lying around looking like a backup.
    await expect(stat(carPath)).rejects.toThrow()
  })
})

describe('importCar — verification', () => {
  it('REJECTS a tampered block instead of storing it', async () => {
    const store = memoryStore()
    const honest = utf8('the real artwork')
    const { cid } = await addBytes(honest, store)

    // Write a CAR by hand: the right CID, the wrong bytes. This is what a malicious or
    // corrupted mirror looks like.
    const { writer, out } = CarWriter.create([cid])
    const collecting = (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of out) chunks.push(chunk)
      return Buffer.concat(chunks)
    })()
    await writer.put({ cid, bytes: utf8('a completely different payload') })
    await writer.close()

    const carPath = await tmp.file('tampered.car')
    await writeFile(carPath, await collecting)

    const restored = memoryStore()
    await expect(importCar(carPath, restored)).rejects.toThrow(
      /damaged .* does not match its fingerprint/is
    )
    await expect(importCar(carPath, restored)).rejects.toThrow(/fresh copy/i)

    // Nothing from a rejected backup is kept.
    expect(await restored.has(cid)).toBe(false)
  })

  it('accepts the same CAR when the bytes are honest', async () => {
    const store = memoryStore()
    const honest = utf8('the real artwork')
    const { cid } = await addBytes(honest, store)

    const { writer, out } = CarWriter.create([cid])
    const collecting = (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of out) chunks.push(chunk)
      return Buffer.concat(chunks)
    })()
    await writer.put({ cid, bytes: honest })
    await writer.close()

    const carPath = await tmp.file('honest.car')
    await writeFile(carPath, await collecting)

    const restored = memoryStore()
    const result = await importCar(carPath, restored)
    expect(result.blocks).toBe(1)
    expect(await readBlock(restored, cid)).toEqual(honest)
  })

  it('explains a file that is not a CAR at all', async () => {
    const path = await tmp.file('notes.txt')
    await writeFile(path, 'Dear DAO, here are the monkeys.')

    await expect(importCar(path, memoryStore())).rejects.toThrow(
      /does not look like an IPFS backup \(\.car\) file/i
    )
  })

  it('explains a file that is not there', async () => {
    const path = await tmp.file('missing.car')
    await expect(importCar(path, memoryStore())).rejects.toThrow(/Could not open/i)
  })

  it('explains being handed a folder', async () => {
    const dir = await tmp.make()
    await expect(importCar(dir, memoryStore())).rejects.toThrow(/is a folder, not a backup file/i)
  })
})

describe('exportBrowsableFolder', () => {
  it('writes a normal, browsable folder tree', async () => {
    const store = memoryStore()
    const inner = await addBytes(utf8('inner file'), store)
    const subdir = await buildDirectory(
      [{ name: 'deep.txt', cid: inner.cid, size: await cumulativeSize(inner.cid, store) }],
      store
    )
    const top = await addBytes(utf8('top file'), store)
    const root = await buildDirectory(
      [
        { name: 'top.txt', cid: top.cid, size: await cumulativeSize(top.cid, store) },
        { name: 'nested', cid: subdir, size: await cumulativeSize(subdir, store) }
      ],
      store
    )

    const outDir = await tmp.make()
    const result = await exportBrowsableFolder(root, store, outDir)

    expect(result.files).toBe(2)
    expect(result.bytes).toBe('inner file'.length + 'top file'.length)
    expect(await readFile(join(outDir, 'top.txt'), 'utf8')).toBe('top file')
    expect(await readFile(join(outDir, 'nested', 'deep.txt'), 'utf8')).toBe('inner file')
  })

  it('names a single archived file after its CID', async () => {
    const store = memoryStore()
    const { cid } = await addBytes(utf8('hello world'), store)

    const outDir = await tmp.make()
    const result = await exportBrowsableFolder(cid, store, outDir)

    expect(result.files).toBe(1)
    expect(await readFile(join(outDir, cid.toString()), 'utf8')).toBe('hello world')
  })

  it('REJECTS an entry named ".." rather than writing outside the chosen folder', async () => {
    const store = memoryStore()
    const payload = await addBytes(utf8('pwned'), store)
    const root = await storeRawDirectory(
      [{ Name: '..', Tsize: 5, Hash: payload.cid }],
      store
    )

    const outDir = await tmp.make()
    await expect(exportBrowsableFolder(root, store, outDir)).rejects.toThrow(
      /could write outside the folder you chose/i
    )
  })

  it('REJECTS an entry whose name contains a path separator', async () => {
    const store = memoryStore()
    const payload = await addBytes(utf8('pwned'), store)

    for (const name of ['../escape.txt', 'a/b.txt', 'a\\b.txt', '/etc/passwd']) {
      const root = await storeRawDirectory([{ Name: name, Tsize: 5, Hash: payload.cid }], store)
      const outDir = await tmp.make()
      await expect(
        exportBrowsableFolder(root, store, outDir),
        `name ${JSON.stringify(name)}`
      ).rejects.toThrow(/could write outside the folder you chose/i)
    }
  })

  it('REJECTS an entry with no name at all', async () => {
    const store = memoryStore()
    const payload = await addBytes(utf8('pwned'), store)
    const root = await storeRawDirectory([{ Name: '', Tsize: 5, Hash: payload.cid }], store)

    const outDir = await tmp.make()
    await expect(exportBrowsableFolder(root, store, outDir)).rejects.toThrow(
      /item with no name/i
    )
  })

  it('says the archive is incomplete rather than writing a truncated file', async () => {
    const store = memoryStore()
    const missing = (await addBytes(utf8('never stored here'), memoryStore())).cid
    const root = await storeRawDirectory([{ Name: 'gone.txt', Tsize: 17, Hash: missing }], store)

    const outDir = await tmp.make()
    await expect(exportBrowsableFolder(root, store, outDir)).rejects.toThrow(
      /archive is incomplete/i
    )
  })
})
