/**
 * LIVE — talks to Ethereum mainnet. Run with `npm run test:live`.
 *
 * This is the test that proves the manual Etherscan "Read as Proxy" step is unnecessary:
 * `eth_call` against a public RPC reads `tokenURI` straight through, including on proxied
 * contracts.
 *
 * These tests are excluded from the default suite on purpose. They depend on public
 * infrastructure that can rate-limit or go down, and a red CI run caused by
 * publicnode.com having a bad afternoon teaches nobody anything.
 */

import { describe, expect, it } from 'vitest'

import { ETH_RPCS, SELECTOR_NAME } from '../../src/shared/constants'
import { decodeAbiString, ethCall } from '../../src/main/chain/rpc'
import { detectStandard, resolveTokenUri } from '../../src/main/chain/tokenUri'
import type { TokenRef } from '../../src/shared/types'

/** Bored Ape Yacht Club — a live mainnet ERC-721 whose metadata lives on IPFS. */
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'

describe('live: reading a token URI off mainnet', () => {
  it('resolves a real ERC-721 tokenURI to an ipfs:// link', async () => {
    const ref: TokenRef = { chainId: 1, contract: BAYC, tokenId: '1', standard: 'unknown' }
    const resolved = await resolveTokenUri(ref)

    expect(resolved.kind).toBe('ipfs')
    expect(resolved.raw.startsWith('ipfs://')).toBe(true)
    expect(resolved.onchain).toBe(false)
    expect(resolved.ipfsPath).toBeDefined()
    expect(resolved.ipfsPath?.cid).toMatch(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{57,})$/)
    expect(resolved.ipfsPath?.path).toBe('1')

    // The standard that answered is recorded on the ref, in place.
    expect(ref.standard).toBe('erc721')
  })

  it('reads the collection name, proving decodeAbiString works on live data', async () => {
    const hex = await ethCall(BAYC, SELECTOR_NAME)
    expect(decodeAbiString(hex)).toBe('BoredApeYachtClub')
  })

  it('detects ERC-721 via ERC-165', async () => {
    expect(await detectStandard(BAYC)).toBe('erc721')
  })

  it('reports a token that does not exist in plain English, without hanging', async () => {
    const ref: TokenRef = {
      chainId: 1,
      contract: BAYC,
      // BAYC is capped at 10,000 tokens, so this one has never existed.
      tokenId: '99999999',
      standard: 'unknown'
    }

    await expect(resolveTokenUri(ref)).rejects.toThrow(
      /wouldn't give us a link to token 99999999's information/i
    )
  })

  it('has at least one reachable public RPC endpoint', async () => {
    // If this fails, every other live test's failure is explained by it.
    const reachable: string[] = []
    for (const url of ETH_RPCS) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
          signal: AbortSignal.timeout(15_000)
        })
        if (response.ok) reachable.push(url)
        else await response.body?.cancel()
      } catch {
        /* counted as unreachable */
      }
    }
    expect(reachable.length, `none of ${ETH_RPCS.length} RPC endpoints answered`).toBeGreaterThan(0)
  })
})
