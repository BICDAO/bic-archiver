/**
 * The asset inventory.
 *
 * The May-2026 sweep of the DAO's real 1.8 GB backup is what this table exists
 * to make visible: 10,270 of 10,762 CIDs were still served by strangers, and the
 * 428 that were not were almost entirely the assets BIC had itself rescued from
 * Arweave and the ordinary web — 96.5% and 88.6% dead, against 0.7% for native
 * IPFS content other people also pin. Twelve NFTs had gone completely dark.
 *
 * Two things therefore have to be exactly right, and both are tested against a
 * DAG built with the app's own importer rather than a hand-written fixture.
 *
 * **Folder or file.** `ipfs-unixfs-exporter`'s `recursive()` yields entries with
 * no `type` field in this version, so a walk built on it counts every folder as
 * a file and quietly reports the archive at several times its real weight. The
 * hard case is not a folder — it is a *multi-chunk file*, which is also a dag-pb
 * node with links, and must not be walked into or measured by its `Tsize`.
 *
 * **What the thing is.** `arweave image` and `web metadata` are not decoration:
 * they name the two categories that died. A row whose role is guessed wrong is a
 * row a member cannot filter on, which makes the one number that matters —
 * "pinned nowhere, and not known to be alive" — unreadable.
 */

import * as dagPb from '@ipld/dag-pb'
import { sha256 } from 'multiformats/hashes/sha2'
import { CID } from 'multiformats/cid'
import { describe, expect, it } from 'vitest'

import type { AssetRow } from '../../src/shared/pinning'
import type { HealthResult } from '../../src/shared/types'
import type { ArchiveStore } from '../../src/main/archive/store'
import {
  buildAssetRows,
  cidSpellings,
  mergeHealth,
  mergePinStates,
  summarise
} from '../../src/main/pinning/assets'
import { buildDirectory, cumulativeSize } from '../../src/main/ipfs/dag'
import { addBytes } from '../../src/main/ipfs/importer'
import { at, memoryStore, pseudoRandomBytes, readBlock, utf8 } from '../helpers/support'
import type { Blockstore } from 'interface-blockstore'

/* -------------------------------------------------------------------------- */
/* Building an archive to walk                                                 */
/* -------------------------------------------------------------------------- */

interface Entry {
  name: string
  cid: CID
  size: number
}

/** A file inside the archive, imported exactly as the app would import it. */
async function file(store: Blockstore, name: string, content: string | Uint8Array): Promise<Entry> {
  const bytes = typeof content === 'string' ? utf8(content) : content
  const { cid } = await addBytes(bytes, store)
  return { name, cid, size: await cumulativeSize(cid, store) }
}

/** A folder inside the archive. */
async function folder(store: Blockstore, name: string, entries: Entry[]): Promise<Entry> {
  const cid = await buildDirectory(
    entries.map((entry) => ({ name: entry.name, cid: entry.cid, size: entry.size })),
    store
  )
  return { name, cid, size: await cumulativeSize(cid, store) }
}

/**
 * `buildAssetRows` reads exactly two things off the store: the manifest's root
 * CID and the blockstore. Handing it those directly keeps the test about the
 * walk rather than about archive bookkeeping.
 */
function archive(rootCid: string | undefined, blockstore: Blockstore): ArchiveStore {
  return { manifest: { rootCid }, blockstore } as unknown as ArchiveStore
}

/** Find one row by its path, failing with the available paths if it is missing. */
function rowAt(rows: AssetRow[], path: string): AssetRow {
  const row = rows.find((entry) => entry.path === path)
  if (row === undefined) {
    throw new Error(`No row for "${path}". Rows were:\n  ${rows.map((r) => r.path).join('\n  ')}`)
  }
  return row
}

/**
 * A realistic archive: two NFTs whose assets came from IPFS, from Arweave and
 * from the ordinary web, plus one large file that spans several chunks.
 */
const BIG_FILE_BYTES = 700_000

async function sampleArchive(): Promise<{ store: Blockstore; rootCid: string }> {
  const store = memoryStore()

  const ape = await folder(store, 'Bored Ape #1', [
    await file(store, 'metadata', '{"name":"Bored Ape #1"}'),
    await file(store, 'image', 'PNG bytes'),
    await file(store, '_provenance.json', '{"source":"ipfs"}'),
    await folder(store, 'arweave image', [await file(store, 'ape.png', 'rescued from arweave')]),
    await folder(store, 'web metadata', [await file(store, 'meta.json', '{"rescued":"web"}')])
  ])

  const punk = await folder(store, 'Punk #7', [
    await file(store, 'animation', 'MP4 bytes'),
    await folder(store, 'arweave metadata', [await file(store, 'token.json', '{"ar":true}')]),
    await folder(store, 'web image', [await file(store, 'punk.jpeg', 'rescued from a website')]),
    await file(store, 'cover.png', 'a picture'),
    await file(store, 'clip.mp4', 'a video'),
    await file(store, 'data.json', '{"some":"json"}'),
    await file(store, 'notes.txt', 'just a note'),
    await file(store, 'image_url', 'aliased image'),
    await file(store, 'animation_url', 'aliased animation')
  ])

  const big = await folder(store, 'Big Video', [
    // Three 256 KiB chunks: a dag-pb node WITH links that is emphatically a file.
    await file(store, 'movie.mp4', pseudoRandomBytes(BIG_FILE_BYTES))
  ])

  const root = await folder(store, 'BIC Backup', [ape, punk, big])
  return { store, rootCid: root.cid.toString() }
}

/* ========================================================================== */
/* Folders versus files                                                       */
/* ========================================================================== */

describe('buildAssetRows: telling folders from files', () => {
  it('marks every folder as a folder and every file as a file', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))

    const folders = rows.filter((row) => row.isDirectory).map((row) => row.path)
    expect(folders.sort()).toEqual(
      [
        '',
        'Big Video',
        'Bored Ape #1',
        'Bored Ape #1/arweave image',
        'Bored Ape #1/web metadata',
        'Punk #7',
        'Punk #7/arweave metadata',
        'Punk #7/web image'
      ].sort()
    )

    // The counts the header shows. Getting these wrong by counting folders as
    // files is the exact bug this walk was written to avoid.
    const summary = summarise(rows)
    expect(summary.folders).toBe(8)
    expect(summary.files).toBe(15)
    expect(summary.total).toBe(rows.length)
  })

  it('treats a multi-chunk file as one file, not as a folder full of chunks', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))
    const movie = rowAt(rows, 'Big Video/movie.mp4')

    // It is a dag-pb node with links, exactly like a directory — and it is not one.
    const block = await readBlock(store, CID.parse(movie.cid))
    expect(CID.parse(movie.cid).code).toBe(dagPb.code)
    expect(dagPb.decode(block).Links.length).toBeGreaterThan(1)

    expect(movie.isDirectory).toBe(false)
    expect(movie.role).toBe('animation')
    // Its chunks are its contents, not entries in the archive: one row, not four.
    expect(rows.filter((row) => row.path.startsWith('Big Video/'))).toHaveLength(1)
  })

  it('reports the real size of a file, not the sub-DAG size in its parent link', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))
    const movie = rowAt(rows, 'Big Video/movie.mp4')

    expect(movie.size).toBe(BIG_FILE_BYTES)
    // The link's Tsize includes the block overhead of every chunk, so trusting
    // it would over-report the archive.
    const tsize = await cumulativeSize(CID.parse(movie.cid), store)
    expect(tsize).toBeGreaterThan(BIG_FILE_BYTES)
  })

  it('adds up file bytes only, because a folder already contains its children', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))
    const summary = summarise(rows)

    const byHand = rows
      .filter((row) => !row.isDirectory)
      .reduce((total, row) => total + row.size, 0)
    expect(summary.bytes).toBe(byHand)
    // A folder's own size is the whole sub-DAG beneath it; counting both would
    // report a 1.8 GB archive at several times its weight.
    expect(summary.bytes).toBeLessThan(rowAt(rows, '').size * 2)
  })

  it('lists a raw (non-dag-pb) block as a file without trying to read it', async () => {
    const store = memoryStore()
    const leaf = await file(store, 'image', 'small enough for a single raw block')
    expect(leaf.cid.code).toBe(0x55)

    const root = await folder(store, 'BIC Backup', [leaf])
    const rows = await buildAssetRows(archive(root.cid.toString(), store))

    expect(rowAt(rows, 'image').isDirectory).toBe(false)
  })
})

/* ========================================================================== */
/* Roles                                                                      */
/* ========================================================================== */

describe('buildAssetRows: what each entry is', () => {
  it('derives the role from the archive layout', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))
    const roleOf = (path: string): string => rowAt(rows, path).role

    // The archive root: pinning this one CID recursively covers everything.
    expect(roleOf('')).toBe('archive root')
    // A direct child of the root is an NFT's own folder, whatever it is called.
    expect(roleOf('Bored Ape #1')).toBe('folder')

    // Native IPFS content, stored under its bare role name.
    expect(roleOf('Bored Ape #1/metadata')).toBe('metadata')
    expect(roleOf('Bored Ape #1/image')).toBe('image')
    expect(roleOf('Punk #7/animation')).toBe('animation')
    expect(roleOf('Bored Ape #1/_provenance.json')).toBe('provenance')

    // Content BIC rescued. These two categories died at 96.5% and 88.6%, so the
    // name of the folder IS the interesting fact about the file inside it.
    expect(roleOf('Punk #7/web image')).toBe('web image')
    expect(roleOf('Punk #7/web image/punk.jpeg')).toBe('web image')
    expect(roleOf('Punk #7/arweave metadata')).toBe('arweave metadata')
    expect(roleOf('Punk #7/arweave metadata/token.json')).toBe('arweave metadata')
    expect(roleOf('Bored Ape #1/arweave image')).toBe('arweave image')
    expect(roleOf('Bored Ape #1/arweave image/ape.png')).toBe('arweave image')
  })

  it('falls back to the file name, then the extension, for anything else', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))
    const roleOf = (path: string): string => rowAt(rows, path).role

    // Metadata field names, as the archiver stores them.
    expect(roleOf('Punk #7/image_url')).toBe('image')
    expect(roleOf('Punk #7/animation_url')).toBe('animation')
    // Then extensions.
    expect(roleOf('Punk #7/cover.png')).toBe('image')
    expect(roleOf('Punk #7/clip.mp4')).toBe('animation')
    expect(roleOf('Punk #7/data.json')).toBe('metadata')
    // And an honest shrug rather than a guess.
    expect(roleOf('Punk #7/notes.txt')).toBe('file')
  })

  it('groups every row under the NFT it belongs to', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))

    expect(rowAt(rows, '').nft).toBe('')
    expect(rowAt(rows, 'Bored Ape #1').nft).toBe('Bored Ape #1')
    expect(rowAt(rows, 'Bored Ape #1/arweave image/ape.png').nft).toBe('Bored Ape #1')
    expect(rowAt(rows, 'Punk #7/web image/punk.jpeg').nft).toBe('Punk #7')
  })

  it('puts the archive root first, since pinning it covers the whole archive', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))

    expect(at(rows, 0).path).toBe('')
    expect(at(rows, 0).cid).toBe(rootCid)
    expect(at(rows, 0).isDirectory).toBe(true)
  })

  it('starts every row unchecked and unpinned, guessing nothing', async () => {
    const { store, rootCid } = await sampleArchive()

    const rows = await buildAssetRows(archive(rootCid, store))

    for (const row of rows) {
      expect(row.network).toBe('unchecked')
      expect(row.pins).toEqual({})
    }
  })
})

/* ========================================================================== */
/* Holes in the archive                                                       */
/* ========================================================================== */

describe('buildAssetRows: an archive with something missing', () => {
  it('shows a missing block as a row rather than an empty screen', async () => {
    const { store, rootCid } = await sampleArchive()
    const complete = await buildAssetRows(archive(rootCid, store))
    const victim = rowAt(complete, 'Bored Ape #1/arweave image')

    await store.delete(CID.parse(victim.cid))

    const rows = await buildAssetRows(archive(rootCid, store))
    const hole = rowAt(rows, 'Bored Ape #1/arweave image')

    // A member whose archive has a hole needs to see the hole.
    expect(hole.role).toBe('missing')
    expect(rows.some((row) => row.path.startsWith('Bored Ape #1/arweave image/'))).toBe(false)
    // Everything else still lists.
    expect(rowAt(rows, 'Punk #7/web image/punk.jpeg').role).toBe('web image')
  })

  it('shows a corrupt block as damaged, which is a different problem', async () => {
    const store = memoryStore()
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const brokenCid = CID.createV1(dagPb.code, await sha256.digest(garbage))
    await store.put(brokenCid, garbage)

    const root = await buildDirectory(
      [{ name: 'metadata', cid: brokenCid, size: garbage.byteLength }],
      store
    )
    const rows = await buildAssetRows(archive(root.toString(), store))

    // "Download it again" and "this copy is corrupt" call for different actions.
    expect(rowAt(rows, 'metadata').role).toBe('damaged')
  })

  it('explains an archive that has never been assembled', async () => {
    const store = memoryStore()

    await expect(buildAssetRows(archive(undefined, store))).rejects.toThrow(
      /has not been put together into a backup folder yet/i
    )
  })

  it('explains an unreadable root address instead of throwing a parser error', async () => {
    const store = memoryStore()

    await expect(buildAssetRows(archive('definitely-not-a-cid', store))).rejects.toThrow(
      /not an address this app can read/i
    )
  })

  it('stops when the member cancels', async () => {
    const { store, rootCid } = await sampleArchive()
    const controller = new AbortController()
    controller.abort()

    await expect(buildAssetRows(archive(rootCid, store), controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

/* ========================================================================== */
/* summarise — the one number that matters                                    */
/* ========================================================================== */

/** A row with just enough filled in to be counted. */
function row(over: Partial<AssetRow> = {}): AssetRow {
  return {
    cid: 'bafybeieo2p3k22c3swpk24bckghbv53m3alpr2hmptg5uhwuaghi6ird7a',
    path: 'Ape/image',
    nft: 'Ape',
    role: 'image',
    size: 100,
    isDirectory: false,
    network: 'unchecked',
    pins: {},
    ...over
  }
}

describe('summarise: unpinnedEverywhere', () => {
  it('counts a row that nobody keeps and nobody is known to serve', async () => {
    const rows = [
      // Kept nowhere, and gone from the network: one lost hard drive from gone.
      row({ path: 'a', network: 'unreachable', pins: { kubo: 'not-pinned', pinata: 'not-pinned' } }),
      // Kept nowhere, and nobody has even looked. Before a health run there is
      // no evidence anyone serves it and none that anyone keeps it — which is
      // exactly the state the DAO's 428 dead CIDs sat in for two years.
      row({ path: 'b', network: 'unchecked', pins: {} }),
      // At risk and kept nowhere.
      row({ path: 'c', network: 'at-risk', pins: { kubo: 'failed' } })
    ]

    expect(summarise(rows).unpinnedEverywhere).toBe(3)
  })

  it('does not count a row that somebody is keeping', async () => {
    const rows = [
      row({ path: 'a', network: 'unreachable', pins: { kubo: 'pinned' } }),
      row({ path: 'b', network: 'unreachable', pins: { kubo: 'not-pinned', pinata: 'pinned' } }),
      row({ path: 'c', network: 'unchecked', pins: { pinata: 'pinned' } })
    ]

    // Pinned somewhere is the whole point; the network verdict does not matter.
    expect(summarise(rows).unpinnedEverywhere).toBe(0)
  })

  it('does not count a row the network is confirmed to be serving', async () => {
    const rows = [row({ network: 'healthy', pins: { kubo: 'not-pinned', pinata: 'not-pinned' } })]

    expect(summarise(rows).unpinnedEverywhere).toBe(0)
  })

  it('does not treat "pinning" or "unknown" as kept', async () => {
    const rows = [
      row({ path: 'a', network: 'unchecked', pins: { pinata: 'pinning' } }),
      row({ path: 'b', network: 'unchecked', pins: { kubo: 'unknown' } })
    ]

    // A queued pin is a promise, not a backup.
    expect(summarise(rows).unpinnedEverywhere).toBe(2)
  })

  it('counts folders as well as files, because a folder is a thing to look after', async () => {
    const rows = [
      row({ path: 'a', isDirectory: true, size: 5_000, network: 'unreachable', pins: {} }),
      row({ path: 'b', isDirectory: false, size: 1_000, network: 'unreachable', pins: {} })
    ]

    const summary = summarise(rows)
    expect(summary.unpinnedEverywhere).toBe(2)
    expect(summary.unreachable).toBe(2)
    expect(summary.folders).toBe(1)
    expect(summary.files).toBe(1)
    // Only the file's bytes are added up.
    expect(summary.bytes).toBe(1_000)
  })

  it('reports zeroes for an empty list rather than dividing by nothing', async () => {
    expect(summarise([])).toEqual({
      total: 0,
      files: 0,
      folders: 0,
      bytes: 0,
      unreachable: 0,
      unpinnedEverywhere: 0
    })
  })
})

/* ========================================================================== */
/* Merging in what we learned                                                 */
/* ========================================================================== */

const CID_V1 = 'bafybeieo2p3k22c3swpk24bckghbv53m3alpr2hmptg5uhwuaghi6ird7a'
const CID_V0 = 'QmXxC4gWwta8M211tpZ4r3kQE7jRKEeKd2qzXRBrPd67zo'

function health(cid: string, verdict: HealthResult['verdict']): HealthResult {
  return {
    cid,
    label: 'Ape — image',
    providers: verdict === 'healthy' ? 3 : 0,
    gateways: [],
    verdict,
    checkedAt: '2026-05-01T00:00:00.000Z'
  }
}

describe('mergeHealth and mergePinStates', () => {
  it('matches a health result recorded under the other CID spelling', async () => {
    const rows = [row({ cid: CID_V1 })]

    const merged = mergeHealth(rows, [health(CID_V0, 'unreachable')])

    // A 2023 backup says `Qm…`, this app says `bafy…`, and they are the same
    // block. Missing that would show checked assets as unchecked forever.
    expect(at(merged, 0).network).toBe('unreachable')
  })

  it('leaves rows nothing was checked for alone', async () => {
    const rows = [row({ cid: CID_V1 }), row({ path: 'other', cid: 'bafybeihujzsooxzzjdu7op4n7kkhehcm5df3j4tfyr4qy4blfva47pzhkm' })]

    const merged = mergeHealth(rows, [health(CID_V1, 'healthy')])

    expect(at(merged, 0).network).toBe('healthy')
    expect(at(merged, 1).network).toBe('unchecked')
  })

  it('keeps the worse verdict when one CID was checked twice', async () => {
    const rows = [row({ cid: CID_V1 })]

    const merged = mergeHealth(rows, [health(CID_V1, 'healthy'), health(CID_V1, 'unreachable')])

    expect(at(merged, 0).network).toBe('unreachable')
  })

  it("leaves a target we did not ask about as unknown, never as 'not pinned'", async () => {
    const rows = [row({ cid: CID_V1 })]

    const merged = mergePinStates(rows, new Set([CID_V1]), null)

    expect(at(merged, 0).pins.kubo).toBe('pinned')
    // Absent, which reads as `unknown`. Rendering it as "not pinned" would send
    // a member off re-pinning content that was never at risk.
    expect(at(merged, 0).pins.pinata).toBeUndefined()
    expect('pinata' in at(merged, 0).pins).toBe(false)
  })

  it('treats an empty set as the real answer it is', async () => {
    const rows = [row({ cid: CID_V1 })]

    const merged = mergePinStates(rows, new Set<string>(), new Set<string>())

    // Both list functions throw rather than return a short set, which is
    // precisely what makes an empty one trustworthy.
    expect(at(merged, 0).pins).toEqual({ kubo: 'not-pinned', pinata: 'not-pinned' })
  })

  it('matches a pin recorded under either spelling', async () => {
    const rows = [row({ cid: CID_V1 })]

    const merged = mergePinStates(rows, new Set([CID_V0]), new Set([CID_V0]))

    expect(at(merged, 0).pins).toEqual({ kubo: 'pinned', pinata: 'pinned' })
  })

  it('never modifies the rows it was given', async () => {
    const original = row({ cid: CID_V1 })
    const rows = [original]

    mergeHealth(rows, [health(CID_V1, 'unreachable')])
    mergePinStates(rows, new Set([CID_V1]), new Set([CID_V1]))

    expect(original.network).toBe('unchecked')
    expect(original.pins).toEqual({})
  })
})

describe('cidSpellings', () => {
  it('returns both forms of a dag-pb CID and nothing for an empty string', async () => {
    expect(cidSpellings(CID_V1)).toContain(CID_V0)
    expect(cidSpellings(CID_V0)).toContain(CID_V1)
    expect(cidSpellings('   ')).toEqual([])
  })

  it('returns an unparseable value unchanged rather than dropping it', async () => {
    expect(cidSpellings('not-a-cid')).toEqual(['not-a-cid'])
  })
})
