/**
 * The Pinata client.
 *
 * Two things decide whether this module is right, and they are not the obvious
 * ones.
 *
 * **`hostNodes` is the mechanism, not a tuning knob.** Pinata's pin-by-CID asks
 * Pinata to *find* content on the network. For the 428 CIDs the May-2026 sweep
 * found dead there is nothing to find, so the request is accepted, the job is
 * queued, and hours later it expires having rescued nothing. The only thing that
 * changes that outcome is telling Pinata where to fetch from — the member's own
 * Kubo node, which has the bytes because the `.car` was imported into it. So the
 * exact JSON body of `pinByHash` is asserted here field by field, and the
 * `expired` verdict is asserted to carry the instruction that fixes it.
 *
 * **The token is a bearer credential.** Anyone holding it can unpin the DAO's
 * content or burn its quota. It may only ever appear in an `Authorization`
 * header, so these tests use a recognisable fake key and then go looking for it
 * everywhere a leak could happen: request URLs, returned messages, thrown
 * errors, and text Pinata itself echoed back at us.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PINATA } from '../../src/shared/pinning'
import {
  listPinnedCids,
  pinByCid,
  pinJobResult,
  pinJobStatus,
  testPinataAuth,
  uploadFileToPinata
} from '../../src/main/pinning/pinata'
import { at } from '../helpers/support'
import {
  DECOY_JWT,
  FAKE_TOKEN,
  FetchRouter,
  findTokenLeak,
  jsonReply,
  textReply,
  transportFailure
} from './helpers'

const CID_A = 'bafybeieo2p3k22c3swpk24bckghbv53m3alpr2hmptg5uhwuaghi6ird7a'
const CID_A_V0 = 'QmXxC4gWwta8M211tpZ4r3kQE7jRKEeKd2qzXRBrPd67zo'
const CID_B = 'bafybeihujzsooxzzjdu7op4n7kkhehcm5df3j4tfyr4qy4blfva47pzhkm'

const HOST_NODE = '/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWTestPeerIdForTheOfflineSuite'

function router(): FetchRouter {
  const routes = new FetchRouter()
  vi.stubGlobal('fetch', routes.fetch)
  return routes
}

/** Fail with a useful message if any part of the fake key shows up in `text`. */
function expectNoToken(text: string): void {
  const leak = findTokenLeak(text)
  expect(leak === undefined ? text : `LEAKED "${leak}" in: ${text}`).toBe(text)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ========================================================================== */
/* pinByCid — the request body is the whole design                            */
/* ========================================================================== */

describe('pinByCid: what is actually sent to Pinata', () => {
  it('puts hostNodes inside pinataOptions, exactly', async () => {
    const routes = router().on(PINATA.pinByHash, () =>
      jsonReply({ id: 'job-1', ipfsHash: CID_A, status: 'searching' })
    )

    const result = await pinByCid(FAKE_TOKEN, CID_A, {
      name: 'Bored Ape #1/arweave image/ape.png',
      hostNodes: [HOST_NODE]
    })

    const request = at(routes.calls, 0)
    expect(request.method).toBe('POST')
    expect(request.url).toBe(PINATA.pinByHash)
    // Asserted whole rather than field by field: an extra key here (or a
    // hostNodes list that quietly became empty) is exactly the kind of change
    // that makes a rescue silently stop rescuing.
    expect(request.json()).toEqual({
      hashToPin: CID_A,
      pinataMetadata: { name: 'Bored Ape #1/arweave image/ape.png' },
      pinataOptions: { hostNodes: [HOST_NODE] }
    })

    // A queued job is deliberately NOT reported as pinned.
    expect(result.state).toBe('pinning')
    expect(result.requestId).toBe('job-1')
  })

  it('sends the key as a Bearer header and never in the URL', async () => {
    const routes = router().on(PINATA.pinByHash, () => jsonReply({ id: 'job-1', status: 'searching' }))

    await pinByCid(FAKE_TOKEN, CID_A, { hostNodes: [HOST_NODE] })

    const request = at(routes.calls, 0)
    expect(request.headers.get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`)
    expectNoToken(request.url)
    expectNoToken(String(request.body))
  })

  it('accepts a key pasted with its "Bearer " prefix still attached', async () => {
    const routes = router().on(PINATA.pinByHash, () => jsonReply({ id: 'job-1', status: 'searching' }))

    await pinByCid(`Bearer ${FAKE_TOKEN}`, CID_A)

    expect(at(routes.calls, 0).headers.get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`)
  })

  it('omits pinataOptions entirely when there is no node to fetch from', async () => {
    const routes = router().on(PINATA.pinByHash, () => jsonReply({ id: 'job-1', status: 'searching' }))

    await pinByCid(FAKE_TOKEN, CID_A)

    expect(at(routes.calls, 0).json()).toEqual({ hashToPin: CID_A })
  })

  it('drops host addresses Pinata could not possibly dial', async () => {
    const routes = router().on(PINATA.pinByHash, () => jsonReply({ id: 'job-1', status: 'searching' }))

    await pinByCid(FAKE_TOKEN, CID_A, {
      hostNodes: [
        '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWLoop',
        '/ip6/::1/tcp/4001/p2p/12D3KooWLoop',
        '/ip4/0.0.0.0/tcp/4001/p2p/12D3KooWLoop',
        HOST_NODE,
        // A duplicate: sending it twice is noise, and risks a bad_host_node
        // verdict on a request that would otherwise have worked.
        HOST_NODE
      ]
    })

    expect(at(routes.calls, 0).json()).toEqual({
      hashToPin: CID_A,
      pinataOptions: { hostNodes: [HOST_NODE] }
    })
  })

  it('still sends the request when every host address was unusable', async () => {
    const routes = router().on(PINATA.pinByHash, () => jsonReply({ id: 'job-1', status: 'searching' }))

    // Pinata may still find the content by itself; and if it cannot, the
    // `expired` message is what tells the member what to do about it.
    const result = await pinByCid(FAKE_TOKEN, CID_A, { hostNodes: ['/ip4/127.0.0.1/tcp/4001'] })

    expect(result.state).toBe('pinning')
    expect(at(routes.calls, 0).json()).toEqual({ hashToPin: CID_A })
  })

  it('treats "already pinned" as the success it is', async () => {
    router().on(PINATA.pinByHash, () =>
      jsonReply({ error: { reason: 'DUPLICATE_PIN', details: 'This CID is already pinned' } }, 400)
    )

    const result = await pinByCid(FAKE_TOKEN, CID_A)

    expect(result.state).toBe('pinned')
  })

  it('reports a rejection as a result, not an exception, so one CID cannot stop a run', async () => {
    router().on(PINATA.pinByHash, () => jsonReply({ error: 'INVALID_CID' }, 400))

    const result = await pinByCid(FAKE_TOKEN, CID_A)

    expect(result.state).toBe('failed')
    expect(result.error ?? '').toContain('INVALID_CID')
    expect(result.cid).toBe(CID_A)
  })

  it('turns a dropped connection into a sentence, not a stack trace', async () => {
    router().on(PINATA.pinByHash, () => {
      throw transportFailure('ECONNRESET', 'socket hang up')
    })

    const result = await pinByCid(FAKE_TOKEN, CID_A)

    expect(result.state).toBe('failed')
    expect(result.error ?? '').toMatch(/connection dropped part-way through/i)
    expect(result.error ?? '').not.toMatch(/\bat .+:\d+:\d+/)
  })
})

/* ========================================================================== */
/* Pin job status — where the single most useful failure lives                */
/* ========================================================================== */

describe('pin job status', () => {
  /** Pinata's pin queue, answering with one job in the given state. */
  function queueWith(row: Record<string, unknown>): FetchRouter {
    return router().on(PINATA.pinJobs, () => jsonReply({ count: 1, rows: [row] }))
  }

  it("maps 'expired' to failed, and says to run a node so Pinata has somewhere to fetch from", async () => {
    queueWith({ id: 'job-1', ipfs_pin_hash: CID_A, status: 'expired' })

    const state = await pinJobStatus(FAKE_TOKEN, 'job-1')
    const result = await pinJobResult(FAKE_TOKEN, 'job-1', { cid: CID_A })

    expect(state).toBe('failed')
    expect(result.state).toBe('failed')

    // This is the sentence the whole app exists to be able to say: the content
    // is gone from the network, and the fix is a local node with the backup in
    // it — not another pin request.
    const error = result.error ?? ''
    expect(error).toMatch(/could not find this content anywhere on the network/i)
    expect(error).toMatch(/Start your own IPFS node/i)
    expect(error).toMatch(/import the backup so Pinata has somewhere to fetch it from/i)
    // Pinata's own word is kept too, so a member searching for it finds it.
    expect(error).toContain('expired')
  })

  it('narrows the queue by CID instead of walking it, when the CID is known', async () => {
    const routes = queueWith({ id: 'job-1', ipfs_pin_hash: CID_A, status: 'expired' })

    await pinJobResult(FAKE_TOKEN, 'job-1', { cid: CID_A })

    expect(at(routes.calls, 0).search.get('ipfs_pin_hash')).toBe(CID_A)
  })

  it("maps the in-progress states to 'pinning', never to 'pinned'", async () => {
    for (const status of ['prechecking', 'searching', 'retrieving', 'backfilled']) {
      vi.unstubAllGlobals()
      queueWith({ id: 'job-1', ipfs_pin_hash: CID_A, status })
      await expect(pinJobStatus(FAKE_TOKEN, 'job-1')).resolves.toBe('pinning')
    }
  })

  it('explains the other failure states in terms of what to do', async () => {
    const cases: Array<[string, RegExp]> = [
      ['over_free_limit', /used up its free storage allowance/i],
      ['over_max_size', /larger than Pinata will accept/i],
      ['invalid_object', /could not read this as valid IPFS content/i],
      ['bad_host_node', /could not connect to the IPFS node address it was given/i]
    ]

    for (const [status, expected] of cases) {
      vi.unstubAllGlobals()
      queueWith({ id: 'job-1', ipfs_pin_hash: CID_A, status })
      const result = await pinJobResult(FAKE_TOKEN, 'job-1', { cid: CID_A })
      expect(result.state).toBe('failed')
      expect(result.error ?? '').toMatch(expected)
    }
  })

  it("returns 'unknown' — never 'pinned' — when the job has dropped out of the queue", async () => {
    router().on(PINATA.pinJobs, () => jsonReply({ count: 0, rows: [] }))

    const result = await pinJobResult(FAKE_TOKEN, 'job-1', { cid: CID_A })

    // A finished job simply disappears, so this is a hint to check the pin list,
    // not proof of anything.
    expect(result.state).toBe('unknown')
    expect(result.error ?? '').toMatch(/refresh the pinned list to confirm/i)
  })

  it("returns 'unknown' for a status this app has never heard of", async () => {
    queueWith({ id: 'job-1', ipfs_pin_hash: CID_A, status: 'quantum_entangled' })

    const result = await pinJobResult(FAKE_TOKEN, 'job-1', { cid: CID_A })

    expect(result.state).toBe('unknown')
    expect(result.error ?? '').toMatch(/status this app does not recognise/i)
  })
})

/* ========================================================================== */
/* Verification, not trust                                                    */
/* ========================================================================== */

describe('listPinnedCids', () => {
  it('collects pinned CIDs and ignores rows that have been unpinned', async () => {
    router().on(PINATA.pinList, () =>
      jsonReply({
        count: 2,
        rows: [
          { ipfs_pin_hash: CID_A, date_pinned: '2026-05-01T00:00:00Z' },
          { ipfs_pin_hash: CID_B, date_unpinned: '2026-06-01T00:00:00Z' }
        ]
      })
    )

    const pins = await listPinnedCids(FAKE_TOKEN)

    expect(pins.has(CID_A)).toBe(true)
    expect(pins.has(CID_B)).toBe(false)
  })

  it('asks only for pinned rows', async () => {
    const routes = router().on(PINATA.pinList, () => jsonReply({ count: 0, rows: [] }))

    await listPinnedCids(FAKE_TOKEN)

    expect(at(routes.calls, 0).search.get('status')).toBe('pinned')
  })

  it('throws rather than returning a short list, because a short list reads as "not pinned"', async () => {
    router().on(PINATA.pinList, () => jsonReply({ error: 'INTERNAL' }, 400))

    await expect(listPinnedCids(FAKE_TOKEN)).rejects.toThrow(/Pinata rejected that request/i)
  })
})

/* ========================================================================== */
/* Authentication                                                             */
/* ========================================================================== */

describe('testPinataAuth', () => {
  it('reports a working key as available', async () => {
    router().on(PINATA.testAuth, () => jsonReply({ message: 'Congratulations! ...' }))

    await expect(testPinataAuth(FAKE_TOKEN)).resolves.toEqual({ target: 'pinata', available: true })
  })

  it('explains a missing key without quoting anything back', async () => {
    const routes = router()

    const status = await testPinataAuth('')

    expect(status.available).toBe(false)
    expect(status.detail ?? '').toMatch(/No Pinata token has been saved yet/i)
    expect(routes.calls).toHaveLength(0)
  })

  it('spots a truncated paste before spending a request on it', async () => {
    const routes = router()

    const short = await testPinataAuth('eyJhbGciOiJI')
    const broken = await testPinataAuth('eyJhbGciOiJIUzI1NiJ9.FAKE\n.TOKEN')

    expect(short.detail ?? '').toMatch(/looks too short to be a JWT/i)
    expect(broken.detail ?? '').toMatch(/does not look complete/i)
    expect(routes.calls).toHaveLength(0)
  })
})

/* ========================================================================== */
/* The credential must not escape                                             */
/* ========================================================================== */

describe('the Pinata key never leaks', () => {
  it('produces a plain message for a 401, with no trace of the key in it', async () => {
    // Worst realistic case: Pinata echoes the Authorization header back at us.
    router().on(PINATA.testAuth, () =>
      jsonReply(
        { error: { reason: 'INVALID_CREDENTIALS', details: `token rejected: Bearer ${FAKE_TOKEN}` } },
        401
      )
    )

    const status = await testPinataAuth(FAKE_TOKEN)

    expect(status.available).toBe(false)
    const detail = status.detail ?? ''
    expect(detail).toMatch(/That Pinata token was not accepted\. Check you copied the whole JWT\./)
    expectNoToken(detail)
    expect(detail).not.toContain('FAKE')
  })

  it('keeps the key out of a failed pin result as well', async () => {
    router().on(PINATA.pinByHash, () =>
      textReply(`unauthorized for Bearer ${FAKE_TOKEN}`, 401)
    )

    const result = await pinByCid(FAKE_TOKEN, CID_A, { hostNodes: [HOST_NODE] })

    expect(result.state).toBe('failed')
    expectNoToken(result.error ?? '')
  })

  it('strips a token-shaped string it has never seen before', async () => {
    // Not the configured key: this has to be caught on shape alone, because we
    // do not control what a service echoes back.
    router().on(PINATA.pinByHash, () => jsonReply({ error: `bad header: ${DECOY_JWT}` }, 400))

    const result = await pinByCid(FAKE_TOKEN, CID_A)

    expect(result.error ?? '').not.toContain(DECOY_JWT)
    expect(result.error ?? '').not.toContain('eyJzdWIiOiJERUNPWSJ9')
    expect(result.error ?? '').toContain('[token-hidden]')
  })

  it('strips credentials out of a thrown transport error too', async () => {
    router().on(PINATA.pinList, () => {
      throw new TypeError(`fetch failed: sent authorization: Bearer ${FAKE_TOKEN}`)
    })

    await expect(listPinnedCids(FAKE_TOKEN)).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      expect(findTokenLeak(message)).toBeUndefined()
      return true
    })
  })

  it('never puts the key in a URL, on any endpoint', async () => {
    const routes = router()
      .on(PINATA.testAuth, () => jsonReply({ message: 'ok' }))
      .on(PINATA.pinByHash, () => jsonReply({ id: 'job-1', status: 'searching' }))
      .on(PINATA.pinJobs, () => jsonReply({ count: 0, rows: [] }))
      .on(PINATA.pinList, () => jsonReply({ count: 0, rows: [] }))
      .on(PINATA.uploadV3, () => jsonReply({ data: { cid: CID_A } }))

    await testPinataAuth(FAKE_TOKEN)
    await pinByCid(FAKE_TOKEN, CID_A, { hostNodes: [HOST_NODE] })
    await pinJobResult(FAKE_TOKEN, 'job-1', { cid: CID_A })
    await listPinnedCids(FAKE_TOKEN)
    await uploadFileToPinata(FAKE_TOKEN, new TextEncoder().encode('bytes'), 'ape.png')

    expect(routes.calls.length).toBeGreaterThanOrEqual(5)
    for (const call of routes.calls) {
      expectNoToken(call.url)
      expect(call.headers.get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`)
    }
  })
})

/* ========================================================================== */
/* Rate limiting                                                              */
/* ========================================================================== */

describe('rate limiting', () => {
  it('retries a 429 and then gives up with an honest, calm message', async () => {
    let attempts = 0
    router().on(PINATA.pinByHash, () => {
      attempts += 1
      // `retry-after: 0` keeps the test instant while still exercising the
      // real backoff path — Pinata's own delay always wins over ours.
      return jsonReply({ error: 'RATE_LIMITED' }, 429, { 'retry-after': '0' })
    })

    const result = await pinByCid(FAKE_TOKEN, CID_A)

    expect(attempts).toBe(4)
    expect(result.state).toBe('failed')
    expect(result.error ?? '').toMatch(/Nothing was lost — wait a few minutes and run this again/i)
  })

  it('does not retry a 401, because a rejected key will never become an accepted one', async () => {
    let attempts = 0
    router().on(PINATA.pinByHash, () => {
      attempts += 1
      return jsonReply({ error: 'INVALID_CREDENTIALS' }, 401)
    })

    await pinByCid(FAKE_TOKEN, CID_A)

    expect(attempts).toBe(1)
  })
})

/* ========================================================================== */
/* Direct upload — the caveat that must not be hidden                         */
/* ========================================================================== */

describe('uploadFileToPinata', () => {
  it('reports whatever CID Pinata assigned, which may not be the one we asked about', async () => {
    router().on(PINATA.uploadV3, () => jsonReply({ data: { cid: CID_A_V0 } }))

    const result = await uploadFileToPinata(FAKE_TOKEN, new TextEncoder().encode('bytes'), 'ape.png')

    // A direct upload re-chunks the bytes, so the address can change — and a
    // changed address rescues nothing the archive refers to. The caller has to
    // be able to see that, so the assigned CID is returned rather than the
    // requested one.
    expect(result.state).toBe('pinned')
    expect(result.cid).toBe(CID_A_V0)
  })

  it('does not claim success when Pinata never said where it put the bytes', async () => {
    router().on(PINATA.uploadV3, () => jsonReply({ data: {} }))

    const result = await uploadFileToPinata(FAKE_TOKEN, new TextEncoder().encode('bytes'), 'ape.png')

    expect(result.state).toBe('unknown')
    expect(result.error ?? '').toMatch(/did not say which content address/i)
  })

  it('sends the file to the public network, which is the only pin that helps anyone', async () => {
    const routes = router().on(PINATA.uploadV3, () => jsonReply({ data: { cid: CID_A } }))

    await uploadFileToPinata(FAKE_TOKEN, new TextEncoder().encode('bytes'), 'ape.png')

    const body = at(routes.calls, 0).body
    expect(body).toBeInstanceOf(FormData)
    expect((body as FormData).get('network')).toBe('public')
    expect((body as FormData).get('name')).toBe('ape.png')
  })
})
