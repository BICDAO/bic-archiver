/**
 * The pin run.
 *
 * A `.car` on a Google Drive keeps the *bytes*; it does not make the CID
 * resolvable. Closing that gap has an order, and the order is the whole design:
 * the archive goes into a local IPFS node first — which preserves every CID
 * exactly and makes that node a genuine provider — and only then is Pinata asked
 * to fetch from it. Done the other way round, the run looks successful (requests
 * accepted, jobs queued) and rescues nothing, because Pinata's pin-by-CID
 * *searches* the network and there is nothing left to find.
 *
 * So the cases that matter here are the unhappy ones:
 *
 *   - **no node, Pinata switched on.** The run has to say plainly that dead
 *     content cannot be rescued this way, and then not waste hours queueing pins
 *     that will expire — while still pinning the things somebody *is* still
 *     sharing.
 *   - **something failed half way.** One CID must never stop a run of ten
 *     thousand, and the summary at the end has to be arithmetically true.
 *   - **the member pressed cancel.** It has to actually stop.
 *
 * Every request is routed by the stub in `helpers.ts`; nothing here touches a
 * real node, a real Pinata, or the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PINATA, type PinProgress, type PinningSettings } from '../../src/shared/pinning'
import { getTargets, pinAll, redact } from '../../src/main/pinning/manager'
import { at } from '../helpers/support'
import {
  DECOY_JWT,
  FAKE_TOKEN,
  FetchRouter,
  findTokenLeak,
  jsonReply,
  kuboError,
  ndjsonReply,
  transportFailure
} from './helpers'

const API = 'http://127.0.0.1:5001'
const PEER = '12D3KooWTestPeerIdForTheOfflineSuite0000000000000'
const HOST_NODE = `/ip4/203.0.113.7/tcp/4001/p2p/${PEER}`

/** Two real CIDs: one the network still has, one it does not. */
const ALIVE = 'bafybeieo2p3k22c3swpk24bckghbv53m3alpr2hmptg5uhwuaghi6ird7a'
const DEAD = 'bafybeihujzsooxzzjdu7op4n7kkhehcm5df3j4tfyr4qy4blfva47pzhkm'
const CID_C = 'bafybeif6tvmh335b6daj55e6wf7ca2mdux4pqke6ikaymc6q5znbswjmm4'
const CID_D = 'bafybeicpjkkbb76n7ck4jlnyqbsz5g24bxi7eorqpediinalh2vmwbctta'

const ROUTING = '/routing/v1/providers/'

function settingsFor(kubo: boolean, pinata: boolean, apiUrl = API): PinningSettings {
  return {
    kubo: { enabled: kubo, apiUrl },
    pinata: { enabled: pinata, hasToken: pinata },
    pinOnImport: true
  }
}

function router(): FetchRouter {
  const routes = new FetchRouter()
  vi.stubGlobal('fetch', routes.fetch)
  return routes
}

/** Collects everything the GUI would have been shown. */
function recorder(): { onProgress: (p: PinProgress) => void; events: PinProgress[]; text: () => string } {
  const events: PinProgress[] = []
  return {
    events,
    onProgress: (event: PinProgress) => {
      events.push(event)
    },
    text: () => events.map((event) => event.message).join('\n')
  }
}

/** A node that is up, reachable from the outside, and keeping nothing yet. */
function nodeIsUp(routes: FetchRouter, pinned: readonly string[] = []): FetchRouter {
  return routes
    .on('/api/v0/id', () => jsonReply({ ID: PEER, Addresses: ['/ip4/203.0.113.7/tcp/4001'] }))
    .on('/api/v0/pin/ls', () => ndjsonReply(pinned.map((cid) => ({ Cid: cid, Type: 'recursive' }))))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ========================================================================== */
/* No node to fetch from — the case this module exists for                    */
/* ========================================================================== */

describe('Pinata with nothing serving the content', () => {
  it('says dead content cannot be rescued this way, and only attempts the live ones', async () => {
    let pinListCalls = 0
    const routes = router()
      // The node is switched on in Settings but is not actually running.
      .on('/api/v0/id', () => {
        throw transportFailure('ECONNREFUSED')
      })
      .on(PINATA.testAuth, () => jsonReply({ message: 'ok' }))
      .on(PINATA.pinList, () => {
        pinListCalls += 1
        return jsonReply({ count: 0, rows: [] })
      })
      .on(ROUTING, (request) =>
        request.url.includes(ALIVE)
          ? jsonReply({ Providers: [{ Schema: 'peer', ID: '12D3KooWSomebodyElse' }] })
          : jsonReply({ Providers: [] })
      )
      .on(PINATA.pinByHash, () => jsonReply({ id: 'job-1', status: 'searching' }))
      // The queued job for the live CID eventually expires in this scenario too:
      // with no host node, Pinata is searching a network that may not answer.
      .on(PINATA.pinJobs, () =>
        jsonReply({ count: 1, rows: [{ id: 'job-1', ipfs_pin_hash: ALIVE, status: 'expired' }] })
      )

    const progress = recorder()
    const summary = await pinAll([ALIVE, DEAD], {
      settings: settingsFor(true, true),
      token: FAKE_TOKEN,
      onProgress: progress.onProgress,
      maxWaitMs: 0
    })

    // Said once, in words, before anything is attempted.
    expect(progress.text()).toMatch(
      /Pinata can only pin content that somebody is still sharing on the network/i
    )
    expect(progress.text()).toMatch(/Your own IPFS node is not running/i)

    // The dead CID is never offered to Pinata: queueing it would achieve nothing
    // except a job that expires hours later.
    const asked = routes.callsTo(PINATA.pinByHash).map((call) => (call.json() as { hashToPin: string }).hashToPin)
    expect(asked).toEqual([ALIVE])
    // …and with no node to fetch from, no hostNodes are invented.
    expect(at(routes.callsTo(PINATA.pinByHash), 0).json()).toEqual({ hashToPin: ALIVE })

    // Both were checked against the network before deciding.
    expect(routes.count(ROUTING)).toBe(2)
    expect(pinListCalls).toBeGreaterThan(0)

    expect(summary.requested).toBe(2)
    expect(summary.failed).toBe(2)
    expect(summary.pinned).toBe(0)

    const reasons = summary.failures.map((failure) => `${failure.target}: ${failure.error ?? ''}`)
    expect(reasons.some((text) => /kubo: No IPFS node is running on this computer/.test(text))).toBe(true)
    expect(
      reasons.some((text) =>
        /pinata: Nobody on the network is sharing this any more.*importing the backup into an IPFS node/s.test(text)
      )
    ).toBe(true)
    // The expired verdict, which is the one that tells a member what to do.
    expect(reasons.some((text) => /pinata:.*Start your own IPFS node/s.test(text))).toBe(true)
  })

  it('tells a member to switch their node on when it is switched off in Settings', async () => {
    let pinListCalls = 0
    const routes = router()
      .on(PINATA.testAuth, () => jsonReply({ message: 'ok' }))
      .on(PINATA.pinList, () => {
        pinListCalls += 1
        return jsonReply({
          count: 0,
          rows: pinListCalls === 1 ? [] : [{ ipfs_pin_hash: ALIVE, date_pinned: '2026-05-01' }]
        })
      })
      .on(ROUTING, (request) =>
        request.url.includes(ALIVE)
          ? jsonReply({ Providers: [{ Schema: 'peer', ID: '12D3KooWSomebodyElse' }] })
          : jsonReply({ Providers: [] })
      )
      .on(PINATA.pinByHash, () => jsonReply({ id: 'job-2', status: 'searching' }))

    const progress = recorder()
    const summary = await pinAll([ALIVE, DEAD], {
      settings: settingsFor(false, true),
      token: FAKE_TOKEN,
      onProgress: progress.onProgress,
      maxWaitMs: 0
    })

    expect(progress.text()).toMatch(/turn on your own IPFS node in Settings and run this again/i)

    // Nothing was asked of a node that is switched off.
    expect(routes.count('127.0.0.1')).toBe(0)

    // The live one is rescued; the dead one is reported honestly.
    expect(summary).toMatchObject({ requested: 2, pinned: 1, queued: 0, failed: 1, skipped: 0 })
    expect(at(summary.failures, 0).cid).toBe(DEAD)
    expect(at(summary.failures, 0).target).toBe('pinata')
  })

  it('hands Pinata the node addresses when there is a node, and skips the provider check', async () => {
    let pinListCalls = 0
    const routes = nodeIsUp(router())
      .on('/api/v0/pin/add', () => ndjsonReply([{ Pins: [ALIVE] }]))
      .on(PINATA.testAuth, () => jsonReply({ message: 'ok' }))
      .on(PINATA.pinList, () => {
        pinListCalls += 1
        return jsonReply({
          count: 0,
          rows:
            pinListCalls === 1
              ? []
              : [ALIVE, DEAD].map((cid) => ({ ipfs_pin_hash: cid, date_pinned: '2026-05-01' }))
        })
      })
      .on(PINATA.pinByHash, () => jsonReply({ id: 'job-3', status: 'searching' }))

    const progress = recorder()
    const summary = await pinAll([ALIVE, DEAD], {
      settings: settingsFor(true, true),
      token: FAKE_TOKEN,
      onProgress: progress.onProgress,
      maxWaitMs: 0
    })

    // `hostNodes` is the mechanism, not a tuning knob: this is what makes it
    // possible for Pinata to fetch content nobody else has.
    for (const call of routes.callsTo(PINATA.pinByHash)) {
      expect(call.json()).toMatchObject({ pinataOptions: { hostNodes: [HOST_NODE] } })
    }

    // With somewhere to fetch from, there is no reason to ask who else has it.
    expect(routes.count(ROUTING)).toBe(0)

    // The node is asked first, and Pinata only afterwards.
    expect(routes.firstIndexOf('/api/v0/pin/add')).toBeLessThan(routes.firstIndexOf(PINATA.pinByHash))

    expect(summary).toMatchObject({ requested: 2, pinned: 2, failed: 0 })
  })
})

/* ========================================================================== */
/* One failure must not stop a run                                            */
/* ========================================================================== */

describe('pinAll: continuing past individual failures', () => {
  it('finishes every CID and reports numbers that add up', async () => {
    const routes = nodeIsUp(router(), [ALIVE]).on('/api/v0/pin/add', (request) => {
      const cid = request.search.get('arg') ?? ''
      if (cid === CID_C) return kuboError('merkledag: not found', 500)
      return ndjsonReply([{ Pins: [cid] }])
    })

    const progress = recorder()
    const summary = await pinAll([ALIVE, DEAD, CID_C, CID_D], {
      settings: settingsFor(true, false),
      token: null,
      onProgress: progress.onProgress
    })

    // Already kept, two newly kept, one refused — and the run got to all four.
    expect(summary).toEqual({
      requested: 4,
      pinned: 2,
      queued: 0,
      failed: 1,
      skipped: 1,
      failures: [
        {
          cid: CID_C,
          target: 'kubo',
          state: 'failed',
          error: expect.stringContaining('merkledag: not found') as unknown as string
        }
      ]
    })
    expect(summary.pinned + summary.skipped + summary.failed + summary.queued).toBe(summary.requested)

    // The one already being kept was not offered to the node again.
    const asked = routes.callsTo('/api/v0/pin/add').map((call) => call.search.get('arg'))
    expect(asked).toEqual([DEAD, CID_C, CID_D])
  })

  it('explains that without a backup file the node can only keep what it can find', async () => {
    nodeIsUp(router()).on('/api/v0/pin/add', () => ndjsonReply([{ Pins: [ALIVE] }]))

    const progress = recorder()
    await pinAll([ALIVE], {
      settings: settingsFor(true, false),
      token: null,
      onProgress: progress.onProgress
    })

    // The honest version of "nothing to import": content that has gone dark can
    // only come back from a backup file.
    expect(progress.text()).toMatch(/No backup file was given/i)
    expect(progress.text()).toMatch(/content that has gone dark will never be found/i)
  })

  it('never puts a stack trace or a raw error code in front of a member', async () => {
    nodeIsUp(router()).on('/api/v0/pin/add', () => {
      throw transportFailure('ECONNRESET', 'socket hang up')
    })

    const progress = recorder()
    const summary = await pinAll([ALIVE], {
      settings: settingsFor(true, false),
      token: null,
      onProgress: progress.onProgress
    })

    const everything = [progress.text(), ...summary.failures.map((f) => f.error ?? '')].join('\n')
    expect(everything).not.toMatch(/\bat .+:\d+:\d+/)
    expect(everything).not.toMatch(/ECONNRESET/)
    expect(everything).toMatch(/connection to your IPFS node.*was dropped/is)
  })

  it('reports one line per CID rather than ten thousand identical sentences', async () => {
    const many = Array.from({ length: 600 }, (_, index) => `${ALIVE}#${index}`)

    const summary = await pinAll(many, {
      settings: settingsFor(false, false),
      token: null,
      onProgress: () => undefined
    })

    // The count is exact; only the detail list is capped, so a switched-off
    // destination cannot flood the IPC boundary.
    expect(summary.failed).toBe(600)
    expect(summary.failures).toHaveLength(500)
  })

  it('refuses to pretend a run happened when nothing is switched on', async () => {
    const routes = router()
    const progress = recorder()

    const summary = await pinAll([ALIVE, DEAD], {
      settings: settingsFor(false, false),
      token: null,
      onProgress: progress.onProgress
    })

    expect(routes.calls).toHaveLength(0)
    expect(summary).toMatchObject({ requested: 2, pinned: 0, failed: 2, skipped: 0 })
    expect(progress.text()).toMatch(/no destination is switched on/i)
    expect(progress.text()).toMatch(/a backup file on its own does not keep anything alive/i)
  })

  it('does nothing at all for an empty list', async () => {
    const routes = router()

    const summary = await pinAll([], {
      settings: settingsFor(true, true),
      token: FAKE_TOKEN,
      onProgress: () => undefined
    })

    expect(summary).toEqual({ requested: 0, pinned: 0, queued: 0, failed: 0, skipped: 0, failures: [] })
    expect(routes.calls).toHaveLength(0)
  })

  it('survives a progress listener that throws', async () => {
    nodeIsUp(router()).on('/api/v0/pin/add', () => ndjsonReply([{ Pins: [ALIVE] }]))

    const summary = await pinAll([ALIVE], {
      settings: settingsFor(true, false),
      token: null,
      onProgress: () => {
        throw new Error('the GUI blew up')
      }
    })

    // A misbehaving listener must not abort a rescue that is half finished.
    expect(summary.pinned).toBe(1)
  })
})

/* ========================================================================== */
/* Cancellation                                                               */
/* ========================================================================== */

describe('cancelling a run', () => {
  it('stops before making a single request when cancelled up front', async () => {
    const routes = router()
    const controller = new AbortController()
    controller.abort()

    await expect(
      pinAll([ALIVE, DEAD], {
        settings: settingsFor(true, true),
        token: FAKE_TOKEN,
        onProgress: () => undefined,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(routes.calls).toHaveLength(0)
  })

  it('stops part-way through, leaving most of the work undone', async () => {
    const controller = new AbortController()
    const many = Array.from({ length: 24 }, (_, index) => [ALIVE, DEAD, CID_C, CID_D][index % 4] as string)
    const unique = [ALIVE, DEAD, CID_C, CID_D]

    const routes = nodeIsUp(router()).on('/api/v0/pin/add', () => {
      // The member presses Cancel while the first pin is in flight.
      controller.abort()
      return ndjsonReply([{ Pins: [ALIVE] }])
    })

    await expect(
      pinAll(many, {
        settings: settingsFor(true, false),
        token: null,
        onProgress: () => undefined,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    // Four lanes run at once, so up to four requests can already be in the air —
    // but the run must not carry on through the rest of the list. The lower
    // bound matters too: a run that stopped before it started would pass the
    // upper bound while proving nothing.
    expect(routes.count('/api/v0/pin/add')).toBeGreaterThanOrEqual(1)
    expect(routes.count('/api/v0/pin/add')).toBeLessThanOrEqual(4)
    expect(routes.count('/api/v0/pin/add')).toBeLessThan(unique.length + 1)
  })

  it('stops the Pinata half too', async () => {
    const controller = new AbortController()

    const routes = router()
      .on(PINATA.testAuth, () => jsonReply({ message: 'ok' }))
      .on(PINATA.pinList, () => jsonReply({ count: 0, rows: [] }))
      .on(ROUTING, () => jsonReply({ Providers: [{ Schema: 'peer', ID: '12D3KooWSomebodyElse' }] }))
      .on(PINATA.pinByHash, () => {
        controller.abort()
        return jsonReply({ id: 'job-9', status: 'searching' })
      })

    await expect(
      pinAll([ALIVE, DEAD, CID_C, CID_D], {
        settings: settingsFor(false, true),
        token: FAKE_TOKEN,
        onProgress: () => undefined,
        signal: controller.signal,
        concurrency: 1,
        maxWaitMs: 0
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(routes.count(PINATA.pinByHash)).toBe(1)
  })
})

/* ========================================================================== */
/* getTargets                                                                 */
/* ========================================================================== */

describe('getTargets', () => {
  it('always answers for both destinations, in a fixed order', async () => {
    const routes = router()

    const targets = await getTargets(settingsFor(false, false), null)

    expect(targets.map((target) => target.target)).toEqual(['kubo', 'pinata'])
    expect(routes.calls).toHaveLength(0)
  })

  it('tells a switched-off destination apart from a broken one', async () => {
    router().on('/api/v0/id', () => {
      throw transportFailure('ECONNREFUSED')
    })

    const off = await getTargets(settingsFor(false, false), null)
    const broken = await getTargets(settingsFor(true, false), null)

    expect(at(off, 0).detail ?? '').toMatch(/switched off/i)
    expect(at(broken, 0).detail ?? '').toMatch(/No IPFS node is running on this computer/i)
    // Different problems, different sentences, different fixes.
    expect(at(off, 0).detail).not.toBe(at(broken, 0).detail)
  })

  it('does not spend a request on Pinata when no key has been saved', async () => {
    const routes = router()

    const targets = await getTargets(settingsFor(false, true), null)

    expect(at(targets, 1).available).toBe(false)
    expect(at(targets, 1).detail ?? '').toMatch(/no access key has been saved/i)
    expect(at(targets, 1).detail ?? '').toMatch(/keychain/i)
    expect(routes.calls).toHaveLength(0)
  })

  it('reports a working node with the addresses Pinata would be given', async () => {
    nodeIsUp(router()).on(PINATA.testAuth, () => jsonReply({ message: 'ok' }))

    const targets = await getTargets(settingsFor(true, true), FAKE_TOKEN)

    expect(at(targets, 0)).toMatchObject({
      target: 'kubo',
      available: true,
      peerId: PEER,
      multiaddrs: [HOST_NODE]
    })
    expect(at(targets, 1)).toEqual({ target: 'pinata', available: true })
  })

  it('passes a cancellation straight through', async () => {
    router()
    const controller = new AbortController()
    controller.abort()

    await expect(getTargets(settingsFor(true, true), FAKE_TOKEN, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

/* ========================================================================== */
/* The credential must not reach the GUI                                      */
/* ========================================================================== */

describe('the Pinata key never reaches the screen', () => {
  it('keeps it out of every progress message and every failure, even when Pinata echoes it', async () => {
    router()
      .on(PINATA.testAuth, () => jsonReply({ message: 'ok' }))
      .on(PINATA.pinList, () => jsonReply({ count: 0, rows: [] }))
      .on(ROUTING, () => jsonReply({ Providers: [{ Schema: 'peer', ID: '12D3KooWSomebodyElse' }] }))
      // Worst realistic case: the service quotes our own header back at us, and
      // throws in a second credential for good measure.
      .on(PINATA.pinByHash, () =>
        jsonReply(
          { error: { reason: 'BAD_REQUEST', details: `sent Bearer ${FAKE_TOKEN} and ${DECOY_JWT}` } },
          400
        )
      )

    const progress = recorder()
    const summary = await pinAll([ALIVE], {
      settings: settingsFor(false, true),
      token: FAKE_TOKEN,
      onProgress: progress.onProgress,
      maxWaitMs: 0
    })

    const everything = [progress.text(), JSON.stringify(summary)].join('\n')
    const leak = findTokenLeak(everything)
    expect(leak === undefined ? 'no leak' : `LEAKED "${leak}"`).toBe('no leak')
    expect(everything).not.toContain(DECOY_JWT)
    expect(summary.failed).toBe(1)
  })

  it('redacts credential-shaped text without mangling a CID', async () => {
    expect(redact(`Authorization: Bearer ${FAKE_TOKEN}`, FAKE_TOKEN)).not.toContain(FAKE_TOKEN)
    expect(redact(`failed for ${DECOY_JWT}`)).not.toContain(DECOY_JWT)
    expect(redact(`token=${FAKE_TOKEN}&x=1`)).not.toContain(FAKE_TOKEN)

    // A CID has no dots in it, and it is the one identifier a member needs in
    // order to ask anybody for help.
    expect(redact(`Could not reach ${ALIVE}`, FAKE_TOKEN)).toContain(ALIVE)
  })
})
