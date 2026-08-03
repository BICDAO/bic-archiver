/**
 * LIVE — talks to real IPFS gateways and the delegated routing endpoint.
 * Run with `npm run test:live`.
 *
 * The last test in this file is documentation as much as it is a test: it asserts that the
 * DAO's own October-2025 backup root is unreachable. That single fact is why this app was
 * written. If it ever starts failing, somebody has re-pinned the content — delete the test
 * and celebrate.
 */

import { describe, expect, it } from 'vitest'

import { CID } from 'multiformats/cid'

import { checkHealth, checkProviders, probeGateway } from '../../src/main/health/check'
import { fetchCar, fetchDag, verifyBlock } from '../../src/main/ipfs/trustlessFetch'
import { memoryStore } from '../helpers/support'

/**
 * The Bored Ape Yacht Club metadata directory — heavily pinned, heavily mirrored, and the
 * exact CID a live `tokenURI` call returns.
 */
const LIVE_CID = CID.parse('QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq')

/**
 * The DAO's own Oct-2025 backup root. Verified dead: 504 from every gateway, zero
 * providers. Handling this gracefully is the app's entire reason to exist.
 */
const DEAD_CID = 'bafybeidgu3wl7p6lggejzxcvzcbnwrbcatbgktcvk6aqfe3ficuhxwilym'

describe('live: trustless CAR retrieval', () => {
  it('fetches verified blocks for a CID that is still on the network', async () => {
    // dag-scope=block: one block is enough to prove the protocol works, and it keeps the
    // test from pulling a whole 10,000-entry directory listing.
    const result = await fetchCar(LIVE_CID, { scope: 'block', headersTimeoutMs: 30_000 })

    expect(result.blocks.size).toBeGreaterThan(0)
    expect(result.gateway).toMatch(/^https:\/\//)

    // fetchCar re-hashes every block before returning, but assert it independently:
    // this is the property that makes the original CID preserved by construction.
    let foundRoot = false
    for (const [key, bytes] of result.blocks) {
      const cid = CID.parse(key)
      expect(await verifyBlock(cid, bytes), `block ${key} failed verification`).toBe(true)
      if (cid.multihash.digest.every((b, i) => b === LIVE_CID.multihash.digest[i])) {
        foundRoot = true
      }
    }
    expect(foundRoot, 'the CAR did not contain the block we asked for').toBe(true)
  })

  it('persists a fetched sub-DAG into a blockstore under its own CID', async () => {
    const store = memoryStore()
    const result = await fetchDag(LIVE_CID, store, {
      // The directory listing itself, not all 10,000 metadata files below it.
      path: '1',
      headersTimeoutMs: 30_000
    })

    expect(result.root.toString()).toBe(LIVE_CID.toString())
    expect(result.blocks).toBeGreaterThan(0)
    expect(result.bytes).toBeGreaterThan(0)
    expect(await store.has(LIVE_CID)).toBe(true)
  })
})

describe('live: health checking', () => {
  it('reports a well-pinned CID as healthy', async () => {
    const result = await checkHealth(LIVE_CID.toString(), 'Bored Ape #1 — metadata folder')

    expect(result.cid).toBe(LIVE_CID.toString())
    expect(result.label).toBe('Bored Ape #1 — metadata folder')
    expect(result.gateways.length).toBeGreaterThan(0)
    expect(result.gateways.some((probe) => probe.ok), 'no gateway served it').toBe(true)
    expect(result.providers, 'nobody is announcing it via delegated routing').toBeGreaterThan(0)
    expect(result.verdict).toBe('healthy')
    expect(Date.parse(result.checkedAt)).not.toBeNaN()
  })

  it('finds providers for live content via delegated routing', async () => {
    expect(await checkProviders(LIVE_CID.toString())).toBeGreaterThan(0)
  })

  it('gets a straight answer from a single gateway probe', async () => {
    const probe = await probeGateway('https://trustless-gateway.link', LIVE_CID.toString())
    expect(probe.gateway).toBe('https://trustless-gateway.link')
    expect(probe.ms).toBeGreaterThanOrEqual(0)
    expect(typeof probe.status === 'number' || typeof probe.status === 'string').toBe(true)
  })

  it("reports the DAO's own Oct-2025 backup as unreachable, quickly", async () => {
    // Documenting reality: this CID returns 504 from every gateway and has zero providers.
    // The point of the assertion is not just the verdict — it is that a dead CID resolves
    // in seconds instead of hanging for minutes.
    const startedAt = Date.now()
    const result = await checkHealth(DEAD_CID, "DAO backup root (October 2025)")
    const elapsed = Date.now() - startedAt

    expect(result.verdict).toBe('unreachable')
    expect(result.providers).toBe(0)
    expect(result.gateways.every((probe) => !probe.ok)).toBe(true)
    // Hard-capped at ~20s inside checkHealth; allow generous slack for a slow connection.
    expect(elapsed).toBeLessThan(60_000)
  }, 120_000)

  it('explains, in plain English, that dead content could not be downloaded', async () => {
    let message = ''
    try {
      await fetchCar(CID.parse(DEAD_CID), {
        scope: 'block',
        // Do not spend three minutes per gateway proving what we already know.
        timeoutMs: 30_000,
        headersTimeoutMs: 15_000
      })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).not.toBe('')
    expect(message).toMatch(/could not be (found|downloaded)/i)
    expect(message).toMatch(/gateways/i)
    expect(message).toMatch(new RegExp(DEAD_CID))
    // No stack-trace jargon in front of a non-technical member.
    expect(message).not.toMatch(/undici|ECONN|ETIMEDOUT|TypeError/i)
  }, 180_000)
})
