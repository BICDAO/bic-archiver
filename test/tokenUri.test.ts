/**
 * `resolveTokenUri` — reading the metadata link off-chain and making sense of it.
 *
 * These tests are offline: `fetch` is replaced with a stub that speaks JSON-RPC, so the
 * real `ethCall` -> `decodeAbiString` -> `classifyUri` path runs end to end without a
 * network. That is the only way to reach the `data:` decoder and the ERC-1155 `{id}`
 * substitution, both of which are internal to the module.
 *
 * The `data:` cases matter more than they look: they replace the manual step where a DAO
 * member pastes a base64 blob into some website and hopes.
 */

import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SELECTOR_TOKEN_CONTENT_HASHES,
  SELECTOR_TOKEN_METADATA_HASHES,
  SELECTOR_TOKEN_METADATA_URI,
  SELECTOR_TOKEN_URI,
  SELECTOR_URI
} from '../src/shared/constants'
import { resolveTokenMetadataUri, resolveTokenUri } from '../src/main/chain/tokenUri'
import type { TokenRef } from '../src/shared/types'
import { abiEncodeString, makeRpcStub } from './helpers/support'

const CONTRACT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'

function ref(tokenId: string, standard: TokenRef['standard'] = 'unknown'): TokenRef {
  return { chainId: 1, contract: CONTRACT, tokenId, standard }
}

/** Answer `tokenURI(uint256)` with `uri`; refuse everything else. */
function erc721Returning(uri: string): ReturnType<typeof makeRpcStub> {
  return makeRpcStub((data) =>
    data.startsWith(SELECTOR_TOKEN_URI)
      ? abiEncodeString(uri)
      : { revert: 'function does not exist' }
  )
}

/** Answer `uri(uint256)` with `uri`; refuse `tokenURI`. */
function erc1155Returning(uri: string): ReturnType<typeof makeRpcStub> {
  return makeRpcStub((data) =>
    data.startsWith(SELECTOR_URI) ? abiEncodeString(uri) : { revert: 'ERC721: invalid token ID' }
  )
}

afterEach(() => {
  // Puts the offline guard from test/setup/no-network.ts back.
  vi.unstubAllGlobals()
})

describe('resolveTokenUri — link kinds', () => {
  it('classifies an ipfs:// link and splits out the CID and path', async () => {
    const stub = erc721Returning('ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1')
    vi.stubGlobal('fetch', stub.fetch)

    const token = ref('1')
    const resolved = await resolveTokenUri(token)

    expect(resolved.kind).toBe('ipfs')
    expect(resolved.onchain).toBe(false)
    expect(resolved.ipfsPath).toEqual({
      cid: 'QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq',
      path: '1'
    })
    // The standard that actually answered is recorded on the ref, in place.
    expect(token.standard).toBe('erc721')
  })

  it('classifies a gateway URL as IPFS, not as plain http', async () => {
    // This is what preserves the original CID for a collection that stored an
    // https://ipfs.io/ipfs/… link instead of an ipfs:// one.
    vi.stubGlobal(
      'fetch',
      erc721Returning('https://ipfs.io/ipfs/QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/7')
        .fetch
    )

    const resolved = await resolveTokenUri(ref('7'))
    expect(resolved.kind).toBe('ipfs')
    expect(resolved.ipfsPath?.cid).toBe('QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq')
    expect(resolved.ipfsPath?.path).toBe('7')
  })

  it('classifies an ordinary https link', async () => {
    vi.stubGlobal('fetch', erc721Returning('https://api.example.com/metadata/1.json').fetch)

    const resolved = await resolveTokenUri(ref('1'))
    expect(resolved.kind).toBe('http')
    expect(resolved.normalizedUrl).toBe('https://api.example.com/metadata/1.json')
    expect(resolved.onchain).toBe(false)
  })

  it('classifies ar:// and points it at an Arweave gateway', async () => {
    vi.stubGlobal('fetch', erc721Returning('ar://8Q0Xn2y5rlD9k1Sample_TxId-0000000000000000').fetch)

    const resolved = await resolveTokenUri(ref('1'))
    expect(resolved.kind).toBe('arweave')
    expect(resolved.normalizedUrl).toBe(
      'https://arweave.net/8Q0Xn2y5rlD9k1Sample_TxId-0000000000000000'
    )
  })

  it('falls back from tokenURI to uri when the contract refuses the first one', async () => {
    const stub = erc1155Returning('ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq')
    vi.stubGlobal('fetch', stub.fetch)

    const token = ref('1') // standard 'unknown' -> tokenURI is tried first
    const resolved = await resolveTokenUri(token)

    expect(resolved.kind).toBe('ipfs')
    expect(token.standard).toBe('erc1155')
    expect(stub.calls.length).toBeGreaterThanOrEqual(2)
    expect(stub.calls[0]?.startsWith(SELECTOR_TOKEN_URI)).toBe(true)
  })

  it('explains, in plain English, when neither function answers', async () => {
    vi.stubGlobal(
      'fetch',
      makeRpcStub(() => ({ revert: 'nonexistent token' })).fetch
    )

    await expect(resolveTokenUri(ref('999999'))).rejects.toThrow(
      /wouldn't give us a link to token 999999's information/i
    )
  })

  it('refuses a link scheme it cannot open, and says which ones it can', async () => {
    vi.stubGlobal('fetch', erc721Returning('ftp://files.example.com/1.json').fetch)

    await expect(resolveTokenUri(ref('1'))).rejects.toThrow(/ipfs:\/\/, https:\/\/, ar:\/\/ and data:/)
  })

  it('rejects a non-address contract before making any request', async () => {
    const stub = makeRpcStub(() => '0x')
    vi.stubGlobal('fetch', stub.fetch)

    await expect(
      resolveTokenUri({ chainId: 1, contract: 'feistydao.eth', tokenId: '1', standard: 'unknown' })
    ).rejects.toThrow(/doesn't look like a collection address/i)
    expect(stub.calls).toHaveLength(0)
  })

  it('refuses a non-mainnet chain rather than reading the wrong contract', async () => {
    const stub = makeRpcStub(() => '0x')
    vi.stubGlobal('fetch', stub.fetch)

    await expect(
      resolveTokenUri({ chainId: 137, contract: CONTRACT, tokenId: '1', standard: 'unknown' })
    ).rejects.toThrow(/Ethereum main network/i)
    expect(stub.calls).toHaveLength(0)
  })
})

describe('resolveTokenUri — data: URIs (on-chain metadata)', () => {
  it('decodes a real base64 on-chain metadata blob', async () => {
    // The shape Nouns-style fully-on-chain collections return: JSON with an inline SVG.
    const metadata = {
      name: 'Noun 1',
      description: 'Noun 1 is a member of the Nouns DAO',
      image:
        'data:image/svg+xml;base64,' +
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#d5d7e1"/></svg>',
          'utf8'
        ).toString('base64'),
      attributes: [{ trait_type: 'Background', value: 'Cool' }]
    }
    const blob = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64')
    const uri = `data:application/json;base64,${blob}`

    vi.stubGlobal('fetch', erc721Returning(uri).fetch)

    const resolved = await resolveTokenUri(ref('1'))

    expect(resolved.kind).toBe('data')
    expect(resolved.onchain).toBe(true)
    expect(resolved.raw).toBe(uri)
    expect(resolved.inlineJson).toBeDefined()
    expect(resolved.inlineJson?.['name']).toBe('Noun 1')
    expect(String(resolved.inlineJson?.['image'])).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(resolved.normalizedUrl).toBeUndefined()
  })

  it('decodes a plain (non-base64) data: URI', async () => {
    const uri = 'data:application/json,{"name":"Plain Jane","image":"ipfs://Qm123"}'
    vi.stubGlobal('fetch', erc721Returning(uri).fetch)

    const resolved = await resolveTokenUri(ref('2'))

    expect(resolved.kind).toBe('data')
    expect(resolved.onchain).toBe(true)
    expect(resolved.inlineJson?.['name']).toBe('Plain Jane')
  })

  it('decodes a percent-encoded data: URI', async () => {
    const json = '{"name":"Encoded #1","description":"100% on-chain"}'
    const uri = `data:application/json,${encodeURIComponent(json)}`
    vi.stubGlobal('fetch', erc721Returning(uri).fetch)

    const resolved = await resolveTokenUri(ref('3'))
    expect(resolved.inlineJson?.['name']).toBe('Encoded #1')
    expect(resolved.inlineJson?.['description']).toBe('100% on-chain')
  })

  it('decodes the "utf-8" spelling some contracts use in place of base64', async () => {
    const uri = 'data:application/json;utf-8,{"name":"Moonbird-ish","animation_url":"about:blank"}'
    vi.stubGlobal('fetch', erc721Returning(uri).fetch)

    const resolved = await resolveTokenUri(ref('4'))
    expect(resolved.kind).toBe('data')
    expect(resolved.inlineJson?.['name']).toBe('Moonbird-ish')
  })

  it('keeps an on-chain SVG as data even though it is not JSON', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'
    const uri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
    vi.stubGlobal('fetch', erc721Returning(uri).fetch)

    const resolved = await resolveTokenUri(ref('5'))
    expect(resolved.kind).toBe('data')
    expect(resolved.onchain).toBe(true)
    expect(resolved.inlineJson).toBeUndefined()
  })

  it('does not fail the whole token when the on-chain JSON is broken', async () => {
    const uri = 'data:application/json;base64,' + Buffer.from('{"name": ', 'utf8').toString('base64')
    vi.stubGlobal('fetch', erc721Returning(uri).fetch)

    const resolved = await resolveTokenUri(ref('6'))
    expect(resolved.kind).toBe('data')
    expect(resolved.onchain).toBe(true)
    expect(resolved.inlineJson).toBeUndefined()
  })

  it('refuses a data: URI with no comma at all', async () => {
    vi.stubGlobal('fetch', erc721Returning('data:application/json;base64').fetch)
    await expect(resolveTokenUri(ref('7'))).rejects.toThrow(/stored data is incomplete/i)
  })
})

describe('resolveTokenUri — ERC-1155 {id} substitution', () => {
  it('replaces {id} with a 64-character lowercase zero-padded hex token id', async () => {
    vi.stubGlobal('fetch', erc1155Returning('https://api.example.com/{id}.json').fetch)

    const token = ref('3735928559', 'erc1155') // 0xdeadbeef
    const resolved = await resolveTokenUri(token)

    const expectedId = `${'0'.repeat(56)}deadbeef`
    expect(expectedId).toHaveLength(64)
    expect(resolved.normalizedUrl).toBe(`https://api.example.com/${expectedId}.json`)
    expect(resolved.normalizedUrl).toMatch(/\/[0-9a-f]{64}\.json$/)
    // The raw value keeps the placeholder, so provenance records what the contract said.
    expect(resolved.raw).toBe('https://api.example.com/{id}.json')
  })

  it('pads token id 1 to 63 zeros and a 1', async () => {
    vi.stubGlobal('fetch', erc1155Returning('https://api.example.com/{id}').fetch)

    const resolved = await resolveTokenUri(ref('1', 'erc1155'))
    expect(resolved.normalizedUrl).toBe(`https://api.example.com/${'0'.repeat(63)}1`)
  })

  it('substitutes inside an ipfs:// path too, and is case-insensitive about {ID}', async () => {
    vi.stubGlobal(
      'fetch',
      erc1155Returning('ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/{ID}.json').fetch
    )

    const resolved = await resolveTokenUri(ref('255', 'erc1155'))
    expect(resolved.kind).toBe('ipfs')
    expect(resolved.ipfsPath?.path).toBe(`${'0'.repeat(62)}ff.json`)
  })

  it('replaces every occurrence, not just the first', async () => {
    vi.stubGlobal('fetch', erc1155Returning('https://api.example.com/{id}/{id}.json').fetch)

    const resolved = await resolveTokenUri(ref('0', 'erc1155'))
    const zero = '0'.repeat(64)
    expect(resolved.normalizedUrl).toBe(`https://api.example.com/${zero}/${zero}.json`)
  })

  it('asks uri() before tokenURI() when the ref already says erc1155', async () => {
    const stub = erc1155Returning('https://api.example.com/{id}.json')
    vi.stubGlobal('fetch', stub.fetch)

    await resolveTokenUri(ref('1', 'erc1155'))
    expect(stub.calls[0]?.startsWith(SELECTOR_URI)).toBe(true)
  })
})

describe('resolveTokenMetadataUri — Zora v1 Media keeps the metadata at a second link', () => {
  const ZORA_MEDIA = '0xabefbc9fd2f806065b4f3c237d4b59d9a97bcac7'

  /*
   * Captured live on 2026-10-04: `eth_call` against Zora's v1 Media contract for
   * token 3366 through https://ethereum-rpc.publicnode.com. `tokenURI` gave the
   * PNG; `tokenMetadataURI` gave the JSON. Both hashes are the SHA-256 of the
   * files those links serve, checked against copies fetched by CID.
   */
  const LIVE_TOKEN_URI_3366 =
    '0x' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000056' +
    '68747470733a2f2f697066732e666c65656b2e636f2f697066732f6261667962' +
    '6569656a76376f337a7163697a696f336a70636335676575636476636937336b' +
    '6c6d66376b617a797a7076797035716e36346e79346100000000000000000000'
  const LIVE_METADATA_URI_3366 =
    '0x' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000056' +
    '68747470733a2f2f697066732e666c65656b2e636f2f697066732f6261667962' +
    '656966747a616b61726a6163637277776b336b67646e7873753365367962326d' +
    '797275776775347a3568726d686534657066626b796100000000000000000000'
  const LIVE_CONTENT_HASH_3366 = '0x719265be92e8968a3ccff31e2300ac9be2f76e5cb4d622e57228c3534538765d'
  const LIVE_METADATA_HASH_3366 = '0x9813da96e18221082811af4db66e40456b2d895c134f02cc96d6526f996252e5'

  function zora(): TokenRef {
    return { chainId: 1, contract: ZORA_MEDIA, tokenId: '3366', standard: 'erc721' }
  }

  /** Answers the four Zora calls with the captured payloads; refuses anything else. */
  function zoraStub(
    overrides: Record<string, string | { revert: string }> = {}
  ): ReturnType<typeof makeRpcStub> {
    const answers: Record<string, string | { revert: string }> = {
      [SELECTOR_TOKEN_URI]: LIVE_TOKEN_URI_3366,
      [SELECTOR_TOKEN_METADATA_URI]: LIVE_METADATA_URI_3366,
      [SELECTOR_TOKEN_CONTENT_HASHES]: LIVE_CONTENT_HASH_3366,
      [SELECTOR_TOKEN_METADATA_HASHES]: LIVE_METADATA_HASH_3366,
      ...overrides
    }
    return makeRpcStub((data) => answers[data.slice(0, 10)] ?? { revert: 'function does not exist' })
  }

  it('reads the metadata link and both mint-time hashes from the captured live answers', async () => {
    const stub = zoraStub()
    vi.stubGlobal('fetch', stub.fetch)

    const link = await resolveTokenMetadataUri(zora())

    expect(link).toBeDefined()
    expect(link?.metadataUri.raw).toBe(
      'https://ipfs.fleek.co/ipfs/bafybeiftzakarjaccrwwk3kgdnxsu3e6yb2myruwgu4z5hrmhe4epfbkya'
    )
    // The dead fleek gateway doesn't matter: the CID is read out of the link.
    expect(link?.metadataUri.kind).toBe('ipfs')
    expect(link?.metadataUri.ipfsPath).toEqual({
      cid: 'bafybeiftzakarjaccrwwk3kgdnxsu3e6yb2myruwgu4z5hrmhe4epfbkya',
      path: ''
    })
    expect(link?.contentSha256).toBe('719265be92e8968a3ccff31e2300ac9be2f76e5cb4d622e57228c3534538765d')
    expect(link?.metadataSha256).toBe('9813da96e18221082811af4db66e40456b2d895c134f02cc96d6526f996252e5')

    // Token 3366 is 0xd26, encoded as one 32-byte word after each selector.
    const word = `${'0'.repeat(61)}d26`
    expect(stub.calls).toEqual([
      SELECTOR_TOKEN_METADATA_URI + word,
      SELECTOR_TOKEN_CONTENT_HASHES + word,
      SELECTOR_TOKEN_METADATA_HASHES + word
    ])
  })

  it('while tokenURI on the same contract is the artwork, not the metadata', async () => {
    vi.stubGlobal('fetch', zoraStub().fetch)

    const resolved = await resolveTokenUri(zora())
    expect(resolved.ipfsPath?.cid).toBe('bafybeiejv7o3zqcizio3jpcc5geucdvci73klmf7kazyzpvyp5qn64ny4a')
  })

  it('returns nothing, after one call, for an ordinary ERC-721 that refuses the question', async () => {
    const stub = erc721Returning('ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1')
    vi.stubGlobal('fetch', stub.fetch)

    expect(await resolveTokenMetadataUri(ref('1', 'erc721'))).toBeUndefined()
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.startsWith(SELECTOR_TOKEN_METADATA_URI)).toBe(true)
  })

  it('returns nothing when the contract answers with an empty link', async () => {
    vi.stubGlobal('fetch', zoraStub({ [SELECTOR_TOKEN_METADATA_URI]: abiEncodeString('') }).fetch)
    expect(await resolveTokenMetadataUri(zora())).toBeUndefined()
  })

  it('returns nothing for a contract whose fallback answers every call with no data', async () => {
    vi.stubGlobal('fetch', makeRpcStub(() => '0x').fetch)
    expect(await resolveTokenMetadataUri(zora())).toBeUndefined()
  })

  it('returns nothing for a link of a kind this app cannot open, rather than failing the token', async () => {
    vi.stubGlobal(
      'fetch',
      zoraStub({ [SELECTOR_TOKEN_METADATA_URI]: abiEncodeString('ftp://files.example.com/3366.json') }).fetch
    )
    expect(await resolveTokenMetadataUri(zora())).toBeUndefined()
  })

  it('leaves out a hash that is all zeros or that the contract refuses', async () => {
    vi.stubGlobal(
      'fetch',
      zoraStub({
        [SELECTOR_TOKEN_CONTENT_HASHES]: `0x${'0'.repeat(64)}`,
        [SELECTOR_TOKEN_METADATA_HASHES]: { revert: 'nope' }
      }).fetch
    )

    const link = await resolveTokenMetadataUri(zora())
    expect(link?.metadataUri.kind).toBe('ipfs')
    expect(link).not.toHaveProperty('contentSha256')
    expect(link).not.toHaveProperty('metadataSha256')
  })

  it('never throws, even when no Ethereum service answers', async () => {
    // The offline guard is still in place here, so every request rejects.
    expect(await resolveTokenMetadataUri(zora())).toBeUndefined()
  })

  it('asks nothing for an address that is not one, or for another network', async () => {
    const stub = zoraStub()
    vi.stubGlobal('fetch', stub.fetch)

    expect(
      await resolveTokenMetadataUri({ chainId: 1, contract: 'zora.eth', tokenId: '1', standard: 'erc721' })
    ).toBeUndefined()
    expect(
      await resolveTokenMetadataUri({ chainId: 137, contract: ZORA_MEDIA, tokenId: '1', standard: 'erc721' })
    ).toBeUndefined()
    expect(stub.calls).toHaveLength(0)
  })
})
