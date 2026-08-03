/**
 * UnixFS directory construction.
 *
 * The property that matters here is *canonicality*: a folder built by clicking "New folder"
 * in IPFS Desktop and a folder built by this app must have the same CID, and the order the
 * app happened to add entries in must not change it. Kubo sorts directory links by the raw
 * UTF-8 bytes of their names, so these tests deliberately use names whose UTF-16 order and
 * UTF-8 byte order disagree.
 */

import { describe, expect, it } from 'vitest'

import * as dagPb from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'

import {
  addLinkToDirectory,
  buildDirectory,
  cumulativeSize,
  emptyDirectory,
  listDirectory,
  mkdirp
} from '../src/main/ipfs/dag'
import { addBytes } from '../src/main/ipfs/importer'
import { at, memoryStore, utf8 } from './helpers/support'
import type { Blockstore } from 'interface-blockstore'

/** The canonical empty UnixFS directory, as produced by every modern IPFS tool. */
const EMPTY_DIR_CID = 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354'

interface Entry {
  name: string
  cid: CID
  size: number
}

/** Add a file to `store` and describe it the way a directory link needs. */
async function file(store: Blockstore, name: string, content: string): Promise<Entry> {
  const { cid } = await addBytes(utf8(content), store)
  return { name, cid, size: await cumulativeSize(cid, store) }
}

/** Fold a list of entries into a directory one `addLinkToDirectory` call at a time. */
async function buildByAdding(entries: Entry[], store: Blockstore): Promise<CID> {
  const empty = await emptyDirectory()
  await store.put(empty.cid, empty.bytes)

  let dir = empty.cid
  for (const entry of entries) {
    dir = await addLinkToDirectory(dir, entry.name, entry.cid, entry.size, store)
  }
  return dir
}

describe('emptyDirectory', () => {
  it('is the canonical empty UnixFS directory', async () => {
    const empty = await emptyDirectory()
    expect(empty.cid.toString()).toBe(EMPTY_DIR_CID)
    expect(empty.cid.version).toBe(1)
    expect(empty.cid.code).toBe(dagPb.code)
  })

  it('does not store itself — the caller decides where the block belongs', async () => {
    const store = memoryStore()
    const empty = await emptyDirectory()
    expect(await store.has(empty.cid)).toBe(false)
  })
})

describe('buildDirectory / addLinkToDirectory — canonical link ordering', () => {
  it('produces the same CID whatever order buildDirectory is given the entries in', async () => {
    const store = memoryStore()
    const a = await file(store, 'a.json', 'alpha')
    const b = await file(store, 'b.png', 'beta')
    const c = await file(store, 'c.html', 'gamma')

    const forwards = await buildDirectory([a, b, c], store)
    const backwards = await buildDirectory([c, b, a], store)
    const shuffled = await buildDirectory([b, c, a], store)

    expect(backwards.toString()).toBe(forwards.toString())
    expect(shuffled.toString()).toBe(forwards.toString())
  })

  it('produces the same CID whatever order addLinkToDirectory is called in', async () => {
    const store = memoryStore()
    const a = await file(store, 'a.json', 'alpha')
    const b = await file(store, 'b.png', 'beta')
    const c = await file(store, 'c.html', 'gamma')

    const forwards = await buildByAdding([a, b, c], store)
    const backwards = await buildByAdding([c, b, a], store)

    expect(backwards.toString()).toBe(forwards.toString())
  })

  it('agrees with buildDirectory — one folder, two ways of assembling it', async () => {
    // This is what lets the archiver plan a whole folder in memory (fast) instead of
    // re-encoding it once per entry (quadratic) without changing any CID.
    const store = memoryStore()
    const entries = [
      await file(store, 'metadata.json', '{"name":"Ape #1"}'),
      await file(store, 'image.png', 'not really a png'),
      await file(store, '_provenance.json', '{"sha256":"…"}')
    ]

    const built = await buildDirectory(entries, store)
    const added = await buildByAdding(entries, store)

    expect(added.toString()).toBe(built.toString())
  })

  it('sorts by UTF-8 bytes, not UTF-16 code units', async () => {
    const store = memoryStore()
    // U+FF21 (fullwidth A) is one UTF-16 unit but three UTF-8 bytes; U+1F412 is two
    // UTF-16 units (a surrogate pair) but four UTF-8 bytes starting 0xF0. Sorting by
    // UTF-16 code unit puts the emoji's lead surrogate (0xD83D) BEFORE U+FF21, while
    // sorting by UTF-8 bytes puts it after. Kubo does the latter.
    const wide = await file(store, 'Ａ.txt', 'wide A')
    const monkey = await file(store, '\u{1F412}.txt', 'monkey')

    const one = await buildDirectory([wide, monkey], store)
    const two = await buildDirectory([monkey, wide], store)
    expect(two.toString()).toBe(one.toString())

    const listed = await listDirectory(one, store)
    expect(listed.map((entry) => entry.name)).toEqual(['Ａ.txt', '\u{1F412}.txt'])
  })

  it('sorts shorter-first when one name is a prefix of another', async () => {
    const store = memoryStore()
    const short = await file(store, '1', 'one')
    const long = await file(store, '10', 'ten')
    const longer = await file(store, '100', 'hundred')

    const dir = await buildDirectory([longer, short, long], store)
    expect((await listDirectory(dir, store)).map((e) => e.name)).toEqual(['1', '10', '100'])
  })

  it('replaces an entry of the same name rather than duplicating it', async () => {
    const store = memoryStore()
    const first = await file(store, 'image.png', 'version one')
    const second = await file(store, 'image.png', 'version two')

    let dir = await buildDirectory([first], store)
    dir = await addLinkToDirectory(dir, 'image.png', second.cid, second.size, store)

    const listed = await listDirectory(dir, store)
    expect(listed).toHaveLength(1)
    expect(at(listed, 0).cid.toString()).toBe(second.cid.toString())

    // ...and the result is identical to having built it with the new content from the start.
    expect(dir.toString()).toBe((await buildDirectory([second], store)).toString())
  })

  it('leaves the previous directory block untouched — nothing is mutated', async () => {
    const store = memoryStore()
    const a = await file(store, 'a.txt', 'alpha')
    const b = await file(store, 'b.txt', 'beta')

    const one = await buildDirectory([a], store)
    const two = await addLinkToDirectory(one, 'b.txt', b.cid, b.size, store)

    expect(two.toString()).not.toBe(one.toString())
    expect(await store.has(one)).toBe(true)
    expect(await listDirectory(one, store)).toHaveLength(1)
  })

  it('refuses names that would break a path', async () => {
    const store = memoryStore()
    const a = await file(store, 'a.txt', 'alpha')

    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      await expect(
        buildDirectory([{ ...a, name: bad }], store),
        `name ${JSON.stringify(bad)}`
      ).rejects.toThrow()
    }
  })

  it('refuses two entries with the same name in one build', async () => {
    const store = memoryStore()
    const a = await file(store, 'same.txt', 'alpha')
    const b = await file(store, 'same.txt', 'beta')

    await expect(buildDirectory([a, b], store)).rejects.toThrow(
      /would contain two items called "same.txt"/i
    )
  })

  it('refuses to add an entry inside something that is not a folder', async () => {
    const store = memoryStore()
    const a = await file(store, 'a.txt', 'alpha')

    await expect(addLinkToDirectory(a.cid, 'x', a.cid, a.size, store)).rejects.toThrow(
      /is a file, not a folder/i
    )
  })

  it('explains a missing block instead of producing a broken folder', async () => {
    const store = memoryStore()
    const elsewhere = await file(memoryStore(), 'a.txt', 'alpha')

    await expect(
      addLinkToDirectory(CID.parse(EMPTY_DIR_CID), 'a.txt', elsewhere.cid, 1, store)
    ).rejects.toThrow(/missing from your computer/i)
  })
})

describe('listDirectory', () => {
  it('round-trips names, CIDs and cumulative sizes', async () => {
    const store = memoryStore()
    const entries = [
      await file(store, 'z-last.txt', 'zeta'),
      await file(store, 'a-first.txt', 'alpha'),
      await file(store, 'm-middle.txt', 'mu')
    ]

    const dir = await buildDirectory(entries, store)
    const listed = await listDirectory(dir, store)

    expect(listed).toHaveLength(3)
    // Sorted canonically, regardless of the order they went in.
    expect(listed.map((e) => e.name)).toEqual(['a-first.txt', 'm-middle.txt', 'z-last.txt'])

    for (const entry of entries) {
      const found = listed.find((candidate) => candidate.name === entry.name)
      expect(found, entry.name).toBeDefined()
      expect(found?.cid.toString()).toBe(entry.cid.toString())
      expect(found?.size).toBe(entry.size)
    }
  })

  it('lists an empty directory as empty', async () => {
    const store = memoryStore()
    const empty = await emptyDirectory()
    await store.put(empty.cid, empty.bytes)

    expect(await listDirectory(empty.cid, store)).toEqual([])
  })

  it('refuses to list a file', async () => {
    const store = memoryStore()
    const a = await file(store, 'a.txt', 'alpha')

    await expect(listDirectory(a.cid, store)).rejects.toThrow(/is a file, not a folder/i)
  })
})

describe('cumulativeSize', () => {
  it('counts the block itself for a single raw leaf', async () => {
    const store = memoryStore()
    const { cid } = await addBytes(utf8('hello world'), store)
    expect(await cumulativeSize(cid, store)).toBe(11)
  })

  it('counts a directory node plus everything beneath it', async () => {
    const store = memoryStore()
    const a = await file(store, 'a.txt', 'alpha')
    const b = await file(store, 'b.txt', 'beta')
    const dir = await buildDirectory([a, b], store)

    const total = await cumulativeSize(dir, store)
    expect(total).toBeGreaterThan(a.size + b.size)
  })
})

describe('mkdirp', () => {
  it('creates nested folders and returns a new root', async () => {
    const store = memoryStore()
    const empty = await emptyDirectory()
    await store.put(empty.cid, empty.bytes)

    const root = await mkdirp(empty.cid, ['BIC Backup', 'Bored Ape #1'], store)
    expect(root.toString()).not.toBe(empty.cid.toString())

    const top = await listDirectory(root, store)
    expect(top.map((e) => e.name)).toEqual(['BIC Backup'])

    const inner = await listDirectory(at(top, 0).cid, store)
    expect(inner.map((e) => e.name)).toEqual(['Bored Ape #1'])
  })

  it('ignores empty segments and ".", so splitting a path on "/" just works', async () => {
    const store = memoryStore()
    const empty = await emptyDirectory()
    await store.put(empty.cid, empty.bytes)

    const viaSplit = await mkdirp(empty.cid, '/BIC Backup/Ape #1/'.split('/'), store)
    const direct = await mkdirp(empty.cid, ['BIC Backup', 'Ape #1'], store)
    expect(viaSplit.toString()).toBe(direct.toString())
  })

  it('returns the root unchanged when there is nothing to create', async () => {
    const store = memoryStore()
    const empty = await emptyDirectory()
    await store.put(empty.cid, empty.bytes)

    expect((await mkdirp(empty.cid, [], store)).toString()).toBe(empty.cid.toString())
    expect((await mkdirp(empty.cid, ['', '.'], store)).toString()).toBe(empty.cid.toString())
  })

  it('is idempotent — creating an existing path changes nothing', async () => {
    const store = memoryStore()
    const empty = await emptyDirectory()
    await store.put(empty.cid, empty.bytes)

    const once = await mkdirp(empty.cid, ['BIC Backup', 'Ape #1'], store)
    const twice = await mkdirp(once, ['BIC Backup', 'Ape #1'], store)
    expect(twice.toString()).toBe(once.toString())
  })

  it('refuses to create a folder where a file of that name already exists', async () => {
    const store = memoryStore()
    const a = await file(store, 'notes', 'I am a file')
    const dir = await buildDirectory([a], store)

    await expect(mkdirp(dir, ['notes', 'deeper'], store)).rejects.toThrow(
      /a file with that name is already there/i
    )
  })
})
