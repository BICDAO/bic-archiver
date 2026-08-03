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

import { SELECTOR_TOKEN_URI, SELECTOR_URI } from '../src/shared/constants'
import { resolveTokenUri } from '../src/main/chain/tokenUri'
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
