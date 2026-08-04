/**
 * The Kubo RPC client.
 *
 * Kubo is load-bearing rather than optional here. Pinata's pin-by-CID asks
 * Pinata to *find* content on the network; for the 428 CIDs the May-2026 sweep
 * found dead there is nothing to find, so the only route that rescues them is
 * to import the backup into a node — which preserves the CIDs exactly and makes
 * that node a genuine provider — and then hand Pinata that node's addresses.
 *
 * So the two things this file leans hardest on are:
 *
 *   - **which addresses we would give Pinata**, because handing over `127.0.0.1`
 *     points a data centre at itself, and quietly dropping the only address the
 *     node has leaves a member wondering why a pin never lands; and
 *   - **whether a message is one a non-technical member can act on**. "No IPFS
 *     node is running on this computer", "that is the gateway, not the control
 *     port" and "it did not answer in time" call for three different actions, so
 *     the tests assert they really are three different sentences.
 *
 * Nothing here touches the network. Every `fetch` is routed by the stub in
 * `helpers.ts`; the one request that bypasses `fetch` entirely — the `.car`
 * upload, which streams over `node:http` so a multi-gigabyte archive never
 * lands in memory — talks to a throwaway server on 127.0.0.1.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  connectTo,
  detectKubo,
  importCarToKubo,
  isPinned,
  listPins,
  pinCid,
  repoStat
} from '../../src/main/pinning/kubo'
import { TempDirs, at } from '../helpers/support'
import {
  FetchRouter,
  aggregateTransportFailure,
  jsonReply,
  kuboError,
  multipartFile,
  multipartFilename,
  ndjsonReply,
  startFakeKubo,
  textReply,
  transportFailure,
  type FakeKubo
} from './helpers'

const API = 'http://127.0.0.1:5001'
const PEER = '12D3KooWTestPeerIdForTheOfflineSuite0000000000000'

/** Real, parseable CIDs. Nothing here depends on what they contain. */
const CID_A = 'bafybeieo2p3k22c3swpk24bckghbv53m3alpr2hmptg5uhwuaghi6ird7a'
const CID_A_V0 = 'QmXxC4gWwta8M211tpZ4r3kQE7jRKEeKd2qzXRBrPd67zo'
const CID_B = 'bafybeihujzsooxzzjdu7op4n7kkhehcm5df3j4tfyr4qy4blfva47pzhkm'

const temp = new TempDirs()

function router(): FetchRouter {
  const routes = new FetchRouter()
  vi.stubGlobal('fetch', routes.fetch)
  return routes
}

/** A node that answers `id` with exactly these announced addresses. */
function nodeAnnouncing(addresses: readonly string[], peerId = PEER): FetchRouter {
  return router().on('/api/v0/id', () => jsonReply({ ID: peerId, Addresses: addresses }))
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await temp.cleanup()
})

/* ========================================================================== */
/* detectKubo — which addresses Pinata would be given                         */
/* ========================================================================== */

describe('detectKubo: choosing addresses a pinning service could dial', () => {
  it('drops loopback and keeps the public address, with the peer id appended', async () => {
    nodeAnnouncing([
      '/ip4/127.0.0.1/tcp/4001',
      '/ip4/203.0.113.7/tcp/4001',
      '/ip6/::1/tcp/4001'
    ])

    const status = await detectKubo(API)

    expect(status.available).toBe(true)
    expect(status.peerId).toBe(PEER)
    expect(status.multiaddrs).toEqual([`/ip4/203.0.113.7/tcp/4001/p2p/${PEER}`])
    // Nothing is wrong, so there is nothing to warn a member about.
    expect(status.detail).toBeUndefined()
  })

  it('drops private addresses when a public one exists', async () => {
    nodeAnnouncing([
      '/ip4/127.0.0.1/tcp/4001',
      '/ip4/192.168.1.50/tcp/4001',
      '/ip4/10.0.0.4/tcp/4001',
      '/ip4/172.16.3.4/tcp/4001',
      '/ip4/100.64.0.1/tcp/4001',
      '/ip4/169.254.1.1/tcp/4001',
      '/ip6/fe80::1/tcp/4001',
      '/ip6/fd00::5/tcp/4001',
      '/ip4/203.0.113.7/tcp/4001'
    ])

    const status = await detectKubo(API)

    expect(status.multiaddrs).toEqual([`/ip4/203.0.113.7/tcp/4001/p2p/${PEER}`])
  })

  it('keeps private addresses when they are all that is left, and says why that matters', async () => {
    nodeAnnouncing(['/ip4/127.0.0.1/tcp/4001', '/ip4/192.168.1.50/tcp/4001'])

    const status = await detectKubo(API)

    // Still usable: importing and pinning locally work perfectly well.
    expect(status.available).toBe(true)
    expect(status.multiaddrs).toEqual([`/ip4/192.168.1.50/tcp/4001/p2p/${PEER}`])
    expect(status.detail ?? '').toMatch(/only reachable on your local network/i)
    expect(status.detail ?? '').toContain('192.168.1.50')
  })

  it('reports no usable address at all when the node only listens on this computer', async () => {
    nodeAnnouncing(['/ip4/127.0.0.1/tcp/4001', '/ip6/::1/tcp/4001', '/ip4/0.0.0.0/tcp/4001'])

    const status = await detectKubo(API)

    expect(status.available).toBe(true)
    expect(status.multiaddrs).toEqual([])
    expect(status.detail ?? '').toMatch(/only listening on this computer/i)
  })

  it('distinguishes "no addresses announced yet" from "only loopback"', async () => {
    nodeAnnouncing([])
    const empty = await detectKubo(API)

    vi.unstubAllGlobals()
    nodeAnnouncing(['/ip4/127.0.0.1/tcp/4001'])
    const loopbackOnly = await detectKubo(API)

    expect(empty.multiaddrs).toEqual([])
    expect(empty.detail ?? '').toMatch(/has not announced any network addresses yet/i)
    expect(empty.detail).not.toBe(loopbackOnly.detail)
  })

  it('prefers quic-v1 and IPv4, and never repeats an address', async () => {
    nodeAnnouncing([
      '/ip6/2001:db8::1/tcp/4001',
      '/ip4/203.0.113.7/tcp/4001',
      '/ip4/203.0.113.7/udp/4001/quic-v1',
      '/ip4/203.0.113.7/tcp/4001'
    ])

    const status = await detectKubo(API)

    expect(status.multiaddrs).toEqual([
      `/ip4/203.0.113.7/udp/4001/quic-v1/p2p/${PEER}`,
      `/ip4/203.0.113.7/tcp/4001/p2p/${PEER}`,
      `/ip6/2001:db8::1/tcp/4001/p2p/${PEER}`
    ])
  })

  it('does not append the peer id twice when the node already included it', async () => {
    nodeAnnouncing([`/ip4/203.0.113.7/tcp/4001/p2p/${PEER}`])

    const status = await detectKubo(API)

    expect(status.multiaddrs).toEqual([`/ip4/203.0.113.7/tcp/4001/p2p/${PEER}`])
  })

  it('treats a DNS address as public but /dns4/localhost as loopback', async () => {
    nodeAnnouncing(['/dns4/localhost/tcp/4001', '/dns4/node.example.org/tcp/4001'])

    const status = await detectKubo(API)

    expect(status.multiaddrs).toEqual([`/dns4/node.example.org/tcp/4001/p2p/${PEER}`])
  })

  it('uses POST, as every Kubo RPC endpoint requires', async () => {
    const routes = nodeAnnouncing(['/ip4/203.0.113.7/tcp/4001'])

    await detectKubo(API)

    expect(at(routes.calls, 0).method).toBe('POST')
    expect(at(routes.calls, 0).url).toBe(`${API}/api/v0/id`)
  })
})

/* ========================================================================== */
/* detectKubo — failures, and whether a member could act on them              */
/* ========================================================================== */

describe('detectKubo: telling a member what actually went wrong', () => {
  /** Run detectKubo against a node that fails in one specific way. */
  async function detailFor(
    respond: () => Response | Promise<Response>,
    apiUrl = API
  ): Promise<string> {
    vi.unstubAllGlobals()
    router().on('/api/v0/', respond)
    const status = await detectKubo(apiUrl)
    expect(status.available).toBe(false)
    return status.detail ?? ''
  }

  it('says no node is running when the connection is refused on this computer', async () => {
    const detail = await detailFor(() => {
      throw transportFailure('ECONNREFUSED')
    })

    expect(detail).toContain('No IPFS node is running on this computer')
    // The fix, not the diagnosis: a member needs to know what to type.
    expect(detail).toMatch(/ipfs daemon/)
    expect(detail).not.toMatch(/ECONNREFUSED/)
  })

  it('finds the refusal inside an AggregateError, which is what localhost really produces', async () => {
    const detail = await detailFor(() => {
      throw aggregateTransportFailure('ECONNREFUSED')
    })

    expect(detail).toContain('No IPFS node is running on this computer')
  })

  it('says the machine is not answering when the node is on another computer', async () => {
    const detail = await detailFor(() => {
      throw transportFailure('ECONNREFUSED')
    }, 'http://ipfs.example.org:5001')

    expect(detail).toContain('Nothing is accepting connections at ipfs.example.org:5001')
    expect(detail).not.toContain('No IPFS node is running on this computer')
  })

  it('maps a timeout onto "did not answer in time", not a refusal', async () => {
    const detail = await detailFor(() => {
      throw transportFailure('UND_ERR_HEADERS_TIMEOUT', 'headers timeout')
    })

    expect(detail).toMatch(/did not answer in time/i)
    expect(detail).toMatch(/running and not overloaded/i)
  })

  it('recognises the gateway port as "not the control port"', async () => {
    // Port 8080 answers, but with an HTML page rather than Kubo's JSON.
    const detail = await detailFor(() =>
      textReply('<html><body>ipfs gateway</body></html>')
    )

    expect(detail).toMatch(/not an IPFS node's control port/i)
    expect(detail).toContain('port 8080 is the gateway')
    // An HTML page is noise, not a reason; it must not be quoted at the member.
    expect(detail).not.toContain('<html>')
  })

  it('treats a 404 and a 200 with no peer id the same way — something else is listening', async () => {
    const notFound = await detailFor(() => textReply('not found', 404))
    const noPeerId = await detailFor(() => jsonReply({ Version: '0.42.0' }))

    expect(notFound).toMatch(/not an IPFS node's control port/i)
    expect(noPeerId).toBe(notFound)
  })

  it('explains an authenticated node separately from an unreachable one', async () => {
    const detail = await detailFor(() => textReply('unauthorized', 401))

    expect(detail).toMatch(/refused this app access/i)
    expect(detail).toMatch(/name:password@/)
  })

  it('produces four genuinely different sentences for four different problems', async () => {
    const refused = await detailFor(() => {
      throw transportFailure('ECONNREFUSED')
    })
    const timedOut = await detailFor(() => {
      throw transportFailure('ETIMEDOUT')
    })
    const notRpc = await detailFor(() => textReply('<html></html>'))
    const unauthorised = await detailFor(() => textReply('nope', 403))

    const details = [refused, timedOut, notRpc, unauthorised]
    expect(new Set(details).size).toBe(4)
    for (const detail of details) {
      expect(detail.length).toBeGreaterThan(40)
      // Nothing a member reads should look like a stack trace or an error code.
      expect(detail).not.toMatch(/\bat .+:\d+:\d+/)
    }
  })

  it('rejects an unusable address before opening a socket', async () => {
    const routes = router()

    const status = await detectKubo('not a url at all')

    expect(status.available).toBe(false)
    expect(status.detail ?? '').toMatch(/not a valid address/i)
    expect(status.detail ?? '').toContain('http://127.0.0.1:5001')
    expect(routes.calls).toHaveLength(0)
  })

  it('never echoes credentials embedded in the node address', async () => {
    vi.unstubAllGlobals()
    router().on('/api/v0/', () => {
      throw transportFailure('ECONNREFUSED')
    })

    const status = await detectKubo('http://alice:hunter2@ipfs.example.org:5001')

    expect(status.detail ?? '').not.toContain('hunter2')
    expect(status.detail ?? '').not.toContain('alice')
  })

  it('passes the caller cancellation straight through', async () => {
    router().on('/api/v0/', () => jsonReply({ ID: PEER, Addresses: [] }))
    const controller = new AbortController()
    controller.abort()

    await expect(detectKubo(API, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/* ========================================================================== */
/* isPinned — "not pinned" is an answer, not a failure                        */
/* ========================================================================== */

describe('isPinned', () => {
  it("returns 'not-pinned' when Kubo reports its 'is not pinned' error", async () => {
    // Kubo really does answer this question with HTTP 500 and an error body.
    router().on('/api/v0/pin/ls', () =>
      kuboError(`path '${CID_A}' is not pinned`, 500)
    )

    await expect(isPinned(API, CID_A)).resolves.toBe('not-pinned')
  })

  it("returns 'not-pinned' for the indirect-pin wording too", async () => {
    router().on('/api/v0/pin/ls', () =>
      kuboError(`${CID_A} is not pinned; check the pin type`, 500)
    )

    await expect(isPinned(API, CID_A)).resolves.toBe('not-pinned')
  })

  it("returns 'pinned' when the node lists a key for it", async () => {
    router().on('/api/v0/pin/ls', () =>
      jsonReply({ Keys: { [CID_A]: { Type: 'recursive' } } })
    )

    await expect(isPinned(API, CID_A)).resolves.toBe('pinned')
  })

  it("returns 'not-pinned' for a 200 with no keys at all", async () => {
    router().on('/api/v0/pin/ls', () => jsonReply({ Keys: {} }))

    await expect(isPinned(API, CID_A)).resolves.toBe('not-pinned')
  })

  it("returns 'unknown' — never 'not-pinned' — when the node cannot be asked", async () => {
    router().on('/api/v0/pin/ls', () => {
      throw transportFailure('ECONNREFUSED')
    })

    // The distinction is the whole point: "we could not ask" must not send a
    // member off re-pinning thousands of files that were never at risk.
    await expect(isPinned(API, CID_A)).resolves.toBe('unknown')
  })

  it("returns 'unknown' for a node failure that is not about pinning", async () => {
    router().on('/api/v0/pin/ls', () => kuboError('repo is locked by another process', 500))

    await expect(isPinned(API, CID_A)).resolves.toBe('unknown')
  })

  it("returns 'unknown' for an empty CID without making a request", async () => {
    const routes = router()

    await expect(isPinned(API, '   ')).resolves.toBe('unknown')
    expect(routes.calls).toHaveLength(0)
  })
})

/* ========================================================================== */
/* listPins — one request, every spelling                                     */
/* ========================================================================== */

describe('listPins', () => {
  it('collects streamed pins under both their v0 and v1 spellings', async () => {
    router().on('/api/v0/pin/ls', () =>
      ndjsonReply([{ Cid: CID_A_V0, Type: 'recursive' }, { Cid: CID_B, Type: 'indirect' }])
    )

    const pins = await listPins(API)

    // The node answered in `Qm…`; an archive built by this app records `bafy…`.
    // Both have to hit, or ten thousand safe files get reported as unpinned.
    expect(pins.has(CID_A_V0)).toBe(true)
    expect(pins.has(CID_A)).toBe(true)
    expect(pins.has(CID_B)).toBe(true)
  })

  it('asks for indirect pins as well, so files inside a pinned folder count', async () => {
    const routes = router().on('/api/v0/pin/ls', () => ndjsonReply([]))

    await listPins(API)

    expect(at(routes.calls, 0).search.get('type')).toBe('all')
    expect(at(routes.calls, 0).search.get('stream')).toBe('true')
  })

  it('throws rather than returning a short list when the node fails mid-stream', async () => {
    router().on('/api/v0/pin/ls', () =>
      ndjsonReply([
        { Cid: CID_A, Type: 'recursive' },
        { Message: 'context canceled', Code: 0, Type: 'error' }
      ])
    )

    // A partial set is indistinguishable from "nothing is pinned", and that
    // mistake is the expensive one.
    await expect(listPins(API)).rejects.toThrow(/could not finish listing/i)
  })
})

/* ========================================================================== */
/* pinCid                                                                     */
/* ========================================================================== */

describe('pinCid', () => {
  it('pins recursively by default and reports success', async () => {
    const routes = router().on('/api/v0/pin/add', () => ndjsonReply([{ Pins: [CID_A] }]))

    const result = await pinCid(API, CID_A)

    expect(result).toEqual({ cid: CID_A, target: 'kubo', state: 'pinned' })
    expect(at(routes.calls, 0).search.get('arg')).toBe(CID_A)
    expect(at(routes.calls, 0).search.get('recursive')).toBe('true')
  })

  it('keeps the pin when the node is too old to understand pin names', async () => {
    let attempt = 0
    const routes = router().on('/api/v0/pin/add', () => {
      attempt += 1
      if (attempt === 1) return kuboError('unknown option "name"', 400)
      return ndjsonReply([{ Pins: [CID_A] }])
    })

    const result = await pinCid(API, CID_A, { name: 'Bored Ape #1/image' })

    // Losing the label is much better than losing the pin.
    expect(result.state).toBe('pinned')
    expect(routes.count('/api/v0/pin/add')).toBe(2)
    expect(at(routes.calls, 0).search.get('name')).toBe('Bored Ape #1/image')
    expect(at(routes.calls, 1).search.has('name')).toBe(false)
  })

  it('reports a node failure as a result rather than an exception', async () => {
    router().on('/api/v0/pin/add', () => kuboError('merkledag: not found', 500))

    const result = await pinCid(API, CID_A)

    expect(result.state).toBe('failed')
    expect(result.error ?? '').toContain('merkledag: not found')
  })

  it('refuses an empty CID without asking the node', async () => {
    const routes = router()

    const result = await pinCid(API, '')

    expect(result.state).toBe('failed')
    expect(result.error ?? '').toMatch(/nothing to pin/i)
    expect(routes.calls).toHaveLength(0)
  })
})

/* ========================================================================== */
/* repoStat and connectTo                                                     */
/* ========================================================================== */

describe('repoStat and connectTo', () => {
  it('reads repository size and block count, tolerating string numbers', async () => {
    router().on('/api/v0/repo/stat', () => jsonReply({ RepoSize: '1887436800', NumObjects: 10762 }))

    await expect(repoStat(API)).resolves.toEqual({ repoSize: 1_887_436_800, numObjects: 10_762 })
  })

  it('reports a failed dial as false rather than throwing', async () => {
    router().on('/api/v0/swarm/connect', () => kuboError('all dials failed', 500))

    await expect(connectTo(API, `/ip4/203.0.113.7/tcp/4001/p2p/${PEER}`)).resolves.toBe(false)
  })

  it('reports a successful dial', async () => {
    router().on('/api/v0/swarm/connect', () =>
      jsonReply({ Strings: [`connect ${PEER} success`] })
    )

    await expect(connectTo(API, `/ip4/203.0.113.7/tcp/4001/p2p/${PEER}`)).resolves.toBe(true)
  })
})

/* ========================================================================== */
/* importCarToKubo — the step that makes a backup file into a provider        */
/* ========================================================================== */

describe('importCarToKubo', () => {
  let node: FakeKubo | undefined

  afterEach(async () => {
    await node?.close()
    node = undefined
  })

  /** A .car file on disk. Its contents are opaque to the node under test. */
  async function carFile(contents = 'pretend CAR bytes'): Promise<string> {
    const dir = await temp.make('bic-pin-car-')
    const path = join(dir, 'archive.car')
    await writeFile(path, contents)
    return path
  }

  it('parses newline-delimited JSON, collects every root, and counts blocks', async () => {
    node = await startFakeKubo(() => ({
      body:
        // Exactly the shape Kubo streams: a Root line per root, a trailing Stats
        // line, and — deliberately — a blank line and a non-JSON line, because a
        // parser that falls over on those loses a perfectly good import.
        JSON.stringify({ Root: { Cid: { '/': CID_A }, PinErrorMsg: '' } }) +
        '\n\n' +
        'not json at all\n' +
        JSON.stringify({ Root: { Cid: { '/': CID_B } } }) +
        '\n' +
        // The same root again: Kubo repeats it, and the list must not.
        JSON.stringify({ Root: { Cid: { '/': CID_A } } }) +
        '\n' +
        JSON.stringify({ Stats: { BlockCount: 10_762, BlockBytesCount: 1_887_436_800 } }) +
        '\n'
    }))

    const result = await importCarToKubo(node.url, await carFile())

    expect(result.roots).toEqual([CID_A, CID_B])
    expect(result.blocks).toBe(10_762)
  })

  it('accepts a bare-string Cid, as older nodes emit it', async () => {
    node = await startFakeKubo(() => ({
      body: JSON.stringify({ Root: { Cid: CID_A } }) + '\n'
    }))

    const result = await importCarToKubo(node.url, await carFile())

    expect(result.roots).toEqual([CID_A])
  })

  it('asks the node to pin the roots, because an unpinned import is deleted later', async () => {
    node = await startFakeKubo(() => ({ body: JSON.stringify({ Root: { Cid: { '/': CID_A } } }) }))

    await importCarToKubo(node.url, await carFile())

    const request = at(node.requests, 0)
    expect(request.method).toBe('POST')
    expect(request.pathname).toBe('/api/v0/dag/import')
    expect(request.query.get('pin-roots')).toBe('true')
    expect(request.query.get('stats')).toBe('true')
  })

  it('can be told not to pin the roots', async () => {
    node = await startFakeKubo(() => ({ body: JSON.stringify({ Root: { Cid: { '/': CID_A } } }) }))

    await importCarToKubo(node.url, await carFile(), { pinRoots: false })

    expect(at(node.requests, 0).query.get('pin-roots')).toBe('false')
  })

  it('uploads the file itself, byte for byte, as multipart form data', async () => {
    node = await startFakeKubo(() => ({ body: JSON.stringify({ Root: { Cid: { '/': CID_A } } }) }))
    const contents = 'CAR bytesÿ with a é in them'

    await importCarToKubo(node.url, await carFile(contents))

    const request = at(node.requests, 0)
    const uploaded = multipartFile(request.body, request.headers['content-type'])
    expect(uploaded.toString('utf8')).toBe(contents)
    expect(decodeURIComponent(multipartFilename(request.body))).toBe('archive.car')
    // An exact length, so the node is never handed an upload it must guess the end of.
    expect(Number(request.headers['content-length'])).toBe(request.body.length)
  })

  it('reports a rootless CAR honestly instead of inventing a root', async () => {
    node = await startFakeKubo(() => ({ body: JSON.stringify({ Stats: { BlockCount: 3 } }) + '\n' }))

    const result = await importCarToKubo(node.url, await carFile())

    expect(result.roots).toEqual([])
    expect(result.blocks).toBe(3)
  })

  it('turns a mid-stream error line into a plain-English failure', async () => {
    node = await startFakeKubo(() => ({
      body: JSON.stringify({ Message: 'unexpected EOF', Code: 0, Type: 'error' }) + '\n'
    }))

    await expect(importCarToKubo(node.url, await carFile())).rejects.toThrow(
      /could not import "archive\.car": unexpected EOF/i
    )
  })

  it('explains a full disk in terms of what to do about it', async () => {
    node = await startFakeKubo(() => ({
      body: JSON.stringify({ Message: 'write /data: no space left on device', Type: 'error' }) + '\n'
    }))

    await expect(importCarToKubo(node.url, await carFile())).rejects.toThrow(
      /ran out of disk space.*Free some space/is
    )
  })

  it('treats blocks that landed but could not be pinned as a failure, not a success', async () => {
    node = await startFakeKubo(() => ({
      body:
        JSON.stringify({
          Root: { Cid: { '/': CID_A }, PinErrorMsg: 'pin: cannot pin, out of space' }
        }) + '\n'
    }))

    // Unpinned blocks are deleted at the next garbage collection, which is
    // precisely how content goes missing in the first place.
    await expect(importCarToKubo(node.url, await carFile())).rejects.toThrow(
      /could not mark it as kept \(pinned\)/i
    )
  })

  it('says a missing file is missing, without a stack trace', async () => {
    node = await startFakeKubo(() => ({ body: '{}' }))
    const dir = await temp.make('bic-pin-car-')

    await expect(importCarToKubo(node.url, join(dir, 'nowhere.car'))).rejects.toThrow(
      /"nowhere\.car" could not be found/i
    )
    expect(node.requests).toHaveLength(0)
  })

  it('refuses an empty file before uploading anything', async () => {
    node = await startFakeKubo(() => ({ body: '{}' }))

    await expect(importCarToKubo(node.url, await carFile(''))).rejects.toThrow(
      /is empty, so there is nothing to import/i
    )
    expect(node.requests).toHaveLength(0)
  })

  it('explains an HTTP failure from the node in words, not a status code alone', async () => {
    node = await startFakeKubo(() => ({
      status: 413,
      body: 'request entity too large',
      contentType: 'text/plain'
    }))

    await expect(importCarToKubo(node.url, await carFile())).rejects.toThrow(
      /rejected the upload as too large.*proxy/is
    )
  })

  it('ignores a fetch stub entirely, because this upload streams over node:http', async () => {
    const routes = router()
    node = await startFakeKubo(() => ({ body: JSON.stringify({ Root: { Cid: { '/': CID_A } } }) }))

    await importCarToKubo(node.url, await carFile())

    // A 1.8 GB body through `fetch` is 1.8 GB of live buffers; this request
    // deliberately does not use it, and the test would silently stop proving
    // anything if that ever changed.
    expect(routes.calls).toHaveLength(0)
    expect(node.requests).toHaveLength(1)
  })
})
