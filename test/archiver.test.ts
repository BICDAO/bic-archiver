/**
 * `archiveToken` end to end, for a contract that keeps a token's metadata apart from its
 * artwork: Zora's original (v1) Media contract.
 *
 * On that contract `tokenURI` is the artwork file itself (token 3366's is a PNG) and the
 * metadata (name, description, mimeType) is at `tokenMetadataURI`. The metadata has no
 * `image` field. Before this was handled, the archiver saved the PNG as if it were the metadata,
 * could not read it as JSON, marked the token "partial" and named its folder "#3366"
 * instead of "Doge" (BICDAO/bic-archiver#8).
 *
 * These tests are offline. `fetch` is replaced with a stub that answers JSON-RPC like a
 * public Ethereum endpoint and answers trustless gateway requests with real CAR files
 * built from an in-memory "network" blockstore, so the whole path runs: eth_call, CAR
 * verification, block storage, folder building and the provenance record.
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { exporter } from 'ipfs-unixfs-exporter'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 as sha256Hasher } from 'multiformats/hashes/sha2'
import type { Blockstore } from 'interface-blockstore'

import { archiveToken, buildArchiveRoot } from '../src/main/archive/archiver'
import { ArchiveStore } from '../src/main/archive/store'
import { listDirectory } from '../src/main/ipfs/dag'
import { addBytes } from '../src/main/ipfs/importer'
import {
  SELECTOR_TOKEN_CONTENT_HASHES,
  SELECTOR_TOKEN_METADATA_HASHES,
  SELECTOR_TOKEN_METADATA_URI,
  SELECTOR_TOKEN_URI,
  SELECTOR_URI
} from '../src/shared/constants'
import type { ProgressEvent, TokenRef } from '../src/shared/types'
import { abiEncodeString, memoryStore, pseudoRandomBytes, readBlock, TempDirs, utf8 } from './helpers/support'

const ZORA_MEDIA = '0xabefbc9fd2f806065b4f3c237d4b59d9a97bcac7'
const ORDINARY_721 = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'

const tmp = new TempDirs()
const openStores: ArchiveStore[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const store of openStores.splice(0, openStores.length)) await store.close()
  await tmp.cleanup()
})

/* -------------------------------------------------------------------------- */
/* A tiny offline Ethereum + IPFS                                             */
/* -------------------------------------------------------------------------- */

type RpcAnswer = string | { revert: string }

interface FakeNetwork {
  fetch: typeof globalThis.fetch
  /** Calldata of every `eth_call`, in order. */
  rpcCalls: string[]
}

/**
 * Answers `eth_call` with `rpc(calldata)`, and `GET {gateway}/ipfs/{cid}?format=car` with a
 * CAR of every block under `cid` in `network`. A CID that is not in `network`, or that is
 * listed in `missing`, gets a 504 from every gateway, which is what content that has
 * fallen off IPFS looks like. A plain `GET {gateway}/ipfs/{cid}`, the ordinary download the
 * archiver falls back to, is answered from `plain` and is otherwise a 504 too.
 */
function fakeNetwork(
  rpc: (data: string) => RpcAnswer,
  network: Blockstore,
  missing: ReadonlySet<string> = new Set(),
  plain: ReadonlyMap<string, Uint8Array> = new Map()
): FakeNetwork {
  const rpcCalls: string[] = []

  const stub = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url

    if (init?.method === 'POST') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        id?: number
        params?: Array<{ data?: string }>
      }
      const data = body.params?.[0]?.data ?? ''
      rpcCalls.push(data)
      const answer = rpc(data)
      const id = body.id ?? 1
      const payload =
        typeof answer === 'string'
          ? { jsonrpc: '2.0', id, result: answer }
          : { jsonrpc: '2.0', id, error: { code: 3, message: `execution reverted: ${answer.revert}` } }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const parsed = new URL(url)
    const match = /^\/ipfs\/([^/]+)\/?$/.exec(parsed.pathname)
    const cidText = match?.[1]
    if (cidText === undefined) return new Response('', { status: 504 })
    if (parsed.searchParams.get('format') !== 'car') {
      const served = plain.get(cidText)
      return served === undefined ? new Response('', { status: 504 }) : new Response(Buffer.from(served))
    }

    const cid = CID.parse(cidText)
    if (missing.has(cid.toString()) || !(await network.has(cid))) {
      return new Response('', { status: 504 })
    }

    const car = await carOf(cid, network, parsed.searchParams.get('dag-scope') === 'block')
    return new Response(car, {
      status: 200,
      headers: { 'content-type': 'application/vnd.ipld.car; version=1' }
    })
  }

  return { fetch: stub as unknown as typeof globalThis.fetch, rpcCalls }
}

/** A CAR holding `root` and, unless `onlyRoot`, every block beneath it. */
async function carOf(root: CID, store: Blockstore, onlyRoot: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const { writer, out } = CarWriter.create([root])
  const collecting = (async () => {
    const chunks: Uint8Array[] = []
    for await (const chunk of out) chunks.push(chunk)
    return Buffer.concat(chunks)
  })()

  const seen = new Set<string>()
  const queue: CID[] = [root]
  for (let cid = queue.shift(); cid !== undefined; cid = queue.shift()) {
    if (seen.has(cid.toString())) continue
    seen.add(cid.toString())
    const bytes = await readBlock(store, cid)
    await writer.put({ cid, bytes })
    if (!onlyRoot && cid.code === dagPb.code) {
      for (const link of dagPb.decode(bytes).Links) queue.push(link.Hash)
    }
  }

  await writer.close()
  return new Uint8Array(await collecting)
}

/** The contract side of Zora v1 Media: two links and two hashes per token. */
function zoraContract(answers: {
  tokenUri: string
  metadataUri: string
  contentSha256?: string
  metadataSha256?: string
}): (data: string) => RpcAnswer {
  return (data) => {
    switch (data.slice(0, 10)) {
      case SELECTOR_TOKEN_URI:
        return abiEncodeString(answers.tokenUri)
      case SELECTOR_TOKEN_METADATA_URI:
        return abiEncodeString(answers.metadataUri)
      case SELECTOR_TOKEN_CONTENT_HASHES:
        return answers.contentSha256 === undefined ? `0x${'0'.repeat(64)}` : `0x${answers.contentSha256}`
      case SELECTOR_TOKEN_METADATA_HASHES:
        return answers.metadataSha256 === undefined ? `0x${'0'.repeat(64)}` : `0x${answers.metadataSha256}`
      default:
        return { revert: 'function does not exist' }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Metadata in the shape Zora v1 wrote at mint: `description`, `mimeType`, `name` and
 * `version`, in that order, and no `image` field. All seven of DeVamp's heritage Zora
 * tokens have exactly these four keys. The descriptions here are placeholders.
 */
function zoraMetadata(name: string, mimeType: string): Uint8Array {
  return utf8(
    JSON.stringify({
      description: `Test fixture standing in for the description of "${name}".`,
      mimeType,
      name,
      version: 'zora-20210101'
    })
  )
}

/** Bytes that start like a PNG, and are big enough to be stored as several blocks. */
function pngLike(length: number): Uint8Array {
  const bytes = pseudoRandomBytes(length, 0x3366)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

function zoraRef(tokenId: string): TokenRef {
  return { chainId: 1, contract: ZORA_MEDIA, tokenId, standard: 'unknown' }
}

async function newArchive(): Promise<ArchiveStore> {
  const store = await ArchiveStore.createArchive(await tmp.make(), 'Test archive')
  openStores.push(store)
  return store
}

/** Read one stored file back in full. */
async function readStoredFile(cid: CID, blockstore: Blockstore): Promise<Uint8Array> {
  const entry = await exporter(cid, blockstore)
  if (entry.type !== 'file' && entry.type !== 'raw') {
    throw new Error(`Expected a file at ${cid.toString()}, found ${entry.type}`)
  }
  const chunks: Uint8Array[] = []
  for await (const chunk of entry.content()) chunks.push(chunk)
  return new Uint8Array(Buffer.concat(chunks))
}

/** The token folder `name` inside the assembled backup, as a map of entry name → CID. */
async function tokenFolder(store: ArchiveStore, name: string): Promise<Map<string, CID>> {
  const root = await buildArchiveRoot(store)
  const folder = (await listDirectory(root, store.blockstore)).find((entry) => entry.name === name)
  if (folder === undefined) throw new Error(`No folder called "${name}" in the backup`)
  const entries = await listDirectory(folder.cid, store.blockstore)
  return new Map(entries.map((entry) => [entry.name, entry.cid]))
}

async function provenanceIn(store: ArchiveStore, folder: Map<string, CID>): Promise<Record<string, unknown>> {
  const cid = folder.get('_provenance.json')
  if (cid === undefined) throw new Error('No _provenance.json in the token folder')
  return JSON.parse(Buffer.from(await readStoredFile(cid, store.blockstore)).toString('utf8')) as Record<
    string,
    unknown
  >
}

/* -------------------------------------------------------------------------- */
/* Zora v1 Media                                                              */
/* -------------------------------------------------------------------------- */

describe('archiveToken — a Zora v1 Media token, whose metadata has a link of its own', () => {
  it("saves the token's metadata file, names the folder after it, and keeps the artwork as the image", async () => {
    const network = memoryStore()
    const metadata = zoraMetadata('Doge', 'image/png')
    const artwork = pngLike(300_000)
    const metadataCid = (await addBytes(metadata, network)).cid
    const artworkCid = (await addBytes(artwork, network)).cid

    // Token 3366's real links are on ipfs.fleek.co, which answered 522 for both files on
    // 2026-10-04. The CID is read out of the link, so the dead host never matters.
    const tokenUri = `https://ipfs.fleek.co/ipfs/${artworkCid.toString()}`
    const metadataUri = `https://ipfs.fleek.co/ipfs/${metadataCid.toString()}`
    const net = fakeNetwork(
      zoraContract({
        tokenUri,
        metadataUri,
        contentSha256: sha256(artwork),
        metadataSha256: sha256(metadata)
      }),
      network
    )
    vi.stubGlobal('fetch', net.fetch)

    const store = await newArchive()
    const events: ProgressEvent[] = []
    const token = await archiveToken(zoraRef('3366'), store, (event) => events.push(event))

    // The whole point: nothing is missing, and the token has its own name.
    expect(token.errors).toEqual([])
    expect(token.status).toBe('ok')
    expect(token.name).toBe('Doge')
    expect(token.folderName).toBe('Doge')

    // The metadata came from tokenMetadataURI, under its original CID.
    expect(token.metadataUri?.raw).toBe(metadataUri)
    expect(token.metadata?.cid).toBe(metadataCid.toString())
    expect(token.metadata?.cidPreserved).toBe(true)
    expect(token.metadata?.sha256).toBe(sha256(metadata))
    expect(token.metadataJson).toEqual(JSON.parse(Buffer.from(metadata).toString('utf8')))

    // The tokenURI file is the artwork, filed by the metadata's mimeType.
    expect(token.tokenUri.raw).toBe(tokenUri)
    expect(Object.keys(token.assets)).toEqual(['image'])
    expect(token.assets['image']?.cid).toBe(artworkCid.toString())
    expect(token.assets['image']?.cidPreserved).toBe(true)
    expect(token.assets['image']?.contentType).toBe('image/png')

    // Both files match the fingerprints the contract recorded at mint.
    expect(token.contractSha256).toEqual({ content: sha256(artwork), metadata: sha256(metadata) })
    expect(token.metadata?.notes?.join(' ')).toMatch(/matches it exactly/)
    expect(token.assets['image']?.notes?.join(' ')).toMatch(/matches it exactly/)

    // Four calls: the two links and the two hashes.
    expect(net.rpcCalls.map((data) => data.slice(0, 10))).toEqual([
      SELECTOR_TOKEN_URI,
      SELECTOR_TOKEN_METADATA_URI,
      SELECTOR_TOKEN_CONTENT_HASHES,
      SELECTOR_TOKEN_METADATA_HASHES
    ])

    expect(events.some((event) => /keeps this token's information/.test(event.message))).toBe(true)
    expect(events.at(-1)?.phase).toBe('done')

    // The saved folder holds the metadata byte for byte, the artwork, and the record.
    const folder = await tokenFolder(store, 'Doge')
    expect([...folder.keys()].sort()).toEqual(['_provenance.json', 'image', 'metadata'])
    expect(folder.get('metadata')?.toString()).toBe(metadataCid.toString())
    expect(await readStoredFile(metadataCid, store.blockstore)).toEqual(metadata)
    expect(folder.get('image')?.toString()).toBe(artworkCid.toString())
    expect(await readStoredFile(artworkCid, store.blockstore)).toEqual(artwork)

    const provenance = await provenanceIn(store, folder)
    expect(provenance['status']).toBe('ok')
    expect((provenance['tokenUri'] as Record<string, unknown>)['raw']).toBe(tokenUri)
    expect((provenance['metadataUri'] as Record<string, unknown>)['raw']).toBe(metadataUri)
    expect(provenance['contractSha256']).toEqual({ content: sha256(artwork), metadata: sha256(metadata) })
    expect((provenance['howToCheckThis'] as string[]).join(' ')).toMatch(/keeps two links/)
  })

  it("files a video under 'animation', chosen by the metadata's mimeType", async () => {
    const network = memoryStore()
    const metadata = zoraMetadata('Surprised Kitty', 'video/mp4')
    const video = pseudoRandomBytes(40_000, 0x5941)
    const metadataCid = (await addBytes(metadata, network)).cid
    const videoCid = (await addBytes(video, network)).cid

    // Token 5941's real links are ipfs:// ones rather than gateway URLs.
    vi.stubGlobal(
      'fetch',
      fakeNetwork(
        zoraContract({
          tokenUri: `ipfs://${videoCid.toString()}`,
          metadataUri: `ipfs://${metadataCid.toString()}`,
          contentSha256: sha256(video),
          metadataSha256: sha256(metadata)
        }),
        network
      ).fetch
    )

    const store = await newArchive()
    const token = await archiveToken(zoraRef('5941'), store, () => undefined)

    expect(token.status).toBe('ok')
    expect(token.name).toBe('Surprised Kitty')
    expect(Object.keys(token.assets)).toEqual(['animation'])
    expect(token.assets['animation']?.cid).toBe(videoCid.toString())
    expect(token.assets['animation']?.contentType).toBe('video/mp4')

    const folder = await tokenFolder(store, 'Surprised Kitty')
    expect([...folder.keys()].sort()).toEqual(['_provenance.json', 'animation', 'metadata'])
  })

  it('marks the token partly saved when the artwork does not match the hash recorded at mint', async () => {
    const network = memoryStore()
    const metadata = zoraMetadata('Doge', 'image/png')
    const artwork = pngLike(20_000)
    const metadataCid = (await addBytes(metadata, network)).cid
    const artworkCid = (await addBytes(artwork, network)).cid

    // The owner can repoint tokenURI after mint; the hash stays as it was.
    const mintedHash = sha256(utf8('the file that was actually minted'))
    vi.stubGlobal(
      'fetch',
      fakeNetwork(
        zoraContract({
          tokenUri: `ipfs://${artworkCid.toString()}`,
          metadataUri: `ipfs://${metadataCid.toString()}`,
          contentSha256: mintedHash,
          metadataSha256: sha256(metadata)
        }),
        network
      ).fetch
    )

    const store = await newArchive()
    const token = await archiveToken(zoraRef('3366'), store, () => undefined)

    expect(token.status).toBe('partial')
    expect(token.errors).toHaveLength(1)
    expect(token.errors[0]).toMatch(/image saved for this token is not the file the contract recorded/)
    // The copy came with its IPFS address checked, so the gateway is not a suspect.
    expect(token.assets['image']?.cidPreserved).toBe(true)
    expect(token.errors[0]).not.toMatch(/gateway/)
    // Still kept: it is what the contract points at today.
    expect(token.assets['image']?.cid).toBe(artworkCid.toString())
    expect(token.assets['image']?.notes?.join(' ')).toContain(mintedHash)
    // The metadata did match, and says so.
    expect(token.metadata?.notes?.join(' ')).toMatch(/matches it exactly/)
    expect(token.name).toBe('Doge')
  })

  it('still archives the artwork when the metadata file cannot be downloaded', async () => {
    const network = memoryStore()
    const metadata = zoraMetadata('Doge', 'image/png')
    const artwork = pngLike(20_000)
    const metadataCid = (await addBytes(metadata, network)).cid
    const artworkCid = (await addBytes(artwork, network)).cid

    vi.stubGlobal(
      'fetch',
      fakeNetwork(
        zoraContract({
          tokenUri: `ipfs://${artworkCid.toString()}`,
          metadataUri: `ipfs://${metadataCid.toString()}`,
          contentSha256: sha256(artwork),
          metadataSha256: sha256(metadata)
        }),
        network,
        new Set([metadataCid.toString()])
      ).fetch
    )

    const store = await newArchive()
    const token = await archiveToken(zoraRef('3366'), store, () => undefined)

    expect(token.status).toBe('partial')
    expect(token.errors[0]).toMatch(/information for token 3366 could not be downloaded/)
    expect(token.metadata).toBeUndefined()
    // Without the metadata there is no name and no mimeType, so it is filed as the image.
    expect(token.name).toBe('#3366')
    expect(token.assets['image']?.cid).toBe(artworkCid.toString())
    expect(token.assets['image']?.notes?.join(' ')).toMatch(/matches it exactly/)
    expect(store.listTokens()).toHaveLength(1)
  })

  /*
   * When no gateway will hand over the artwork in verifiable form, the archiver downloads it
   * the ordinary way and tries to rebuild its IPFS address. The address below stands in for
   * a file added with settings the archiver does not know, so the rebuild never matches.
   */
  async function unrebuildableArtwork(mintedSha256?: string): Promise<{ artwork: Uint8Array; store: ArchiveStore }> {
    const network = memoryStore()
    const metadata = zoraMetadata('Doge', 'image/png')
    const artwork = pngLike(20_000)
    const metadataCid = (await addBytes(metadata, network)).cid
    const artworkCid = CID.createV1(raw.code, await sha256Hasher.digest(utf8('added with unknown settings')))

    vi.stubGlobal(
      'fetch',
      fakeNetwork(
        zoraContract({
          tokenUri: `ipfs://${artworkCid.toString()}`,
          metadataUri: `ipfs://${metadataCid.toString()}`,
          contentSha256: mintedSha256 ?? sha256(artwork),
          metadataSha256: sha256(metadata)
        }),
        network,
        new Set(),
        new Map([[artworkCid.toString(), artwork]])
      ).fetch
    )

    return { artwork, store: await newArchive() }
  }

  it('says the bytes are the minted ones when the artwork could only be fetched unverified', async () => {
    const { artwork, store } = await unrebuildableArtwork()
    const token = await archiveToken(zoraRef('3366'), store, () => undefined)

    expect(token.errors).toEqual([])
    expect(token.status).toBe('ok')
    expect(token.assets['image']?.cidPreserved).toBe(false)
    expect(token.assets['image']?.sha256).toBe(sha256(artwork))
    expect(token.assets['image']?.notes?.join(' ')).toMatch(
      /matches it exactly.*could not be rebuilt, but this fingerprint shows the bytes are exactly the ones that were minted/
    )
  })

  it('names the gateway as a possible cause when an unverified copy does not match the mint hash', async () => {
    const { store } = await unrebuildableArtwork(sha256(utf8('the file that was actually minted')))
    const token = await archiveToken(zoraRef('3366'), store, () => undefined)

    expect(token.status).toBe('partial')
    expect(token.assets['image']?.cidPreserved).toBe(false)
    expect(token.errors).toHaveLength(1)
    expect(token.errors[0]).toMatch(/image saved for this token is not the file the contract recorded/)
    expect(token.errors[0]).toMatch(/ordinary gateway this copy came from may have sent a different file/)
  })
})

/* -------------------------------------------------------------------------- */
/* Every other contract                                                       */
/* -------------------------------------------------------------------------- */

describe('archiveToken — every other contract keeps the old behaviour', () => {
  it('treats tokenURI as the metadata when the contract refuses tokenMetadataURI', async () => {
    const network = memoryStore()
    const image = pngLike(20_000)
    const imageCid = (await addBytes(image, network)).cid
    const metadata = utf8(JSON.stringify({ name: 'Ape #1', image: `ipfs://${imageCid.toString()}` }))
    const metadataCid = (await addBytes(metadata, network)).cid

    const net = fakeNetwork(
      (data) =>
        data.startsWith(SELECTOR_TOKEN_URI)
          ? abiEncodeString(`ipfs://${metadataCid.toString()}`)
          : { revert: 'function does not exist' },
      network
    )
    vi.stubGlobal('fetch', net.fetch)

    const store = await newArchive()
    const token = await archiveToken(
      { chainId: 1, contract: ORDINARY_721, tokenId: '1', standard: 'unknown' },
      store,
      () => undefined
    )

    expect(token.status).toBe('ok')
    expect(token.name).toBe('Ape #1')
    expect(token.metadata?.cid).toBe(metadataCid.toString())
    expect(token.assets['image']?.cid).toBe(imageCid.toString())
    expect(token).not.toHaveProperty('metadataUri')
    expect(token).not.toHaveProperty('contractSha256')
    expect(token.metadata?.notes?.join(' ')).not.toMatch(/fingerprint for the/)

    // One extra question, refused, and no hash reads after it.
    expect(net.rpcCalls.map((data) => data.slice(0, 10))).toEqual([
      SELECTOR_TOKEN_URI,
      SELECTOR_TOKEN_METADATA_URI
    ])

    // The provenance record has exactly the keys it had before, so an existing folder
    // rebuilds to the same CID.
    const provenance = await provenanceIn(store, await tokenFolder(store, 'Ape #1'))
    expect(Object.keys(provenance)).toEqual([
      'schema',
      'generatedBy',
      'archivedAt',
      'status',
      'token',
      'tokenUri',
      'metadata',
      'assets',
      'files',
      'summary',
      'problems',
      'howToCheckThis'
    ])
    expect(Object.keys(provenance['tokenUri'] as Record<string, unknown>)).toEqual([
      'raw',
      'rawWasShortened',
      'rawLength',
      'kind',
      'storedOnChain',
      'ipfs'
    ])
    expect(provenance['howToCheckThis']).toHaveLength(6)
  })

  it('does not ask an ERC-1155 for a second link', async () => {
    const network = memoryStore()
    const metadata = utf8(JSON.stringify({ name: 'Edition 7' }))
    const metadataCid = (await addBytes(metadata, network)).cid

    const net = fakeNetwork(
      (data) =>
        data.startsWith(SELECTOR_URI)
          ? abiEncodeString(`ipfs://${metadataCid.toString()}`)
          : { revert: 'function does not exist' },
      network
    )
    vi.stubGlobal('fetch', net.fetch)

    const store = await newArchive()
    const token = await archiveToken(
      { chainId: 1, contract: ORDINARY_721, tokenId: '7', standard: 'erc1155' },
      store,
      () => undefined
    )

    expect(token.name).toBe('Edition 7')
    expect(net.rpcCalls.map((data) => data.slice(0, 10))).toEqual([SELECTOR_URI])
  })
})
