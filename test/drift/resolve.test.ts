/**
 * Finding out what BIC publishes today.
 *
 * The archive is a UnixFS directory, so its root CID moves whenever Rex adds an
 * NFT, and BIC republishes by editing one TXT record at
 * `_dnslink.bureauofinternetculture.art`. Everything downstream of this file —
 * whether a member is told to re-copy 1.8 GB, whether the banner turns red —
 * rests on reading that record correctly, so this is where the reading is pinned
 * down.
 *
 * Three things get most of the attention, each because of something measured
 * rather than imagined:
 *
 *   1. **The DNS-over-HTTPS answer is the primary source, and providers disagree
 *      about it.** Cloudflare returns the value wrapped in quotes, Google does
 *      not, and long values arrive in chunks that have to be rejoined. A parser
 *      that only ever saw one provider's spelling would work perfectly until the
 *      day it mattered.
 *   2. **A gateway 504 is not a resolution failure.** Asking a gateway for
 *      `/ipns/bureauofinternetculture.art` makes it try to render a listing of
 *      20,808 entries and it times out. The answer is already in the headers of
 *      the 301 that precedes it, and in the subdomain form, so a 504 must never
 *      end the search — reporting "could not resolve" there would paint every
 *      healthy member's screen with a check that could not run.
 *   3. **Failing is not drifting.** When nothing can answer, the address compiled
 *      into this app is handed back as an *answer* but is never evidence of what
 *      BIC publishes today. `checkDrift.test.ts` holds the other half of that.
 *
 * Offline throughout: `fetch` is routed by the harness, and `node:dns/promises`
 * is replaced, so the machine running the suite is never asked about a real
 * domain and "everything is unreachable" genuinely means everything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BIC_ARCHIVE } from '../../src/shared/community'
import { FALLBACK_GATEWAYS } from '../../src/shared/constants'
import { FetchRouter, type RecordedCall, json, text } from '../node/harness'

import { dnsFailing, dnsHanging, dnsServing, dnsState, fakeResolveTxt, resetDns } from './fakeDns'

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  const { fakeResolveTxt: stub } = await import('./fakeDns')
  return { ...actual, resolveTxt: stub }
})

const { resolvePublishedCid } = await import('../../src/main/community/drift')

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** The domain BIC actually publishes from, per `BIC_ARCHIVE.pointer`. */
const DOMAIN = 'bureauofinternetculture.art'
const DNSLINK_HOST = `_dnslink.${DOMAIN}`

/** Two real directory CIDs, so "moved on" is two addresses rather than one. */
const MAY = 'bafybeihdtlvr3uypo2dnekk7kxfrzfqhsjrq3fjph5pctuda5m65whxcui'
/** The same directory, spelled the old way. */
const MAY_V0 = 'Qmdf8GUMaAmY2i6ZmpL7nrqjxaYB2Pf82KHsekVDdctEcy'
const AUGUST = 'bafybeidhevnylbsaz76nof4rkbygmgq67z4numejj6rq4yaby4ioomhbsi'

/** What this build was compiled with, i.e. the last-resort answer. */
const BUILT_IN = BIC_ARCHIVE.rootCid

/** Log lines, captured rather than printed. */
let warnings: string[] = []

beforeEach(() => {
  resetDns()
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDns()
})

/* -------------------------------------------------------------------------- */
/* building a DNS-over-HTTPS reply                                             */
/* -------------------------------------------------------------------------- */

type Zone = Readonly<Record<string, readonly string[]>>

/**
 * One provider's `application/dns-json`.
 *
 * Cloudflare quotes the value and Google does not — both measured against the
 * real endpoints — and that difference is exactly the kind of thing a stub
 * written from one provider's docs would hide.
 */
function dohReply(zone: Zone, style: 'cloudflare' | 'google'): (call: RecordedCall) => Response {
  return (call) => {
    const host = new URL(call.url).searchParams.get('name') ?? ''
    const records = zone[host]
    if (records === undefined) return json({ Status: 3 }) // NXDOMAIN

    return json({
      Status: 0,
      Answer: records.map((data) => ({
        name: host,
        type: 16,
        TTL: 300,
        data: style === 'cloudflare' ? `"${data}"` : data
      }))
    })
  }
}

/** Both DoH endpoints serving the same zone. */
function dohServing(router: FetchRouter, zone: Zone, style: 'cloudflare' | 'google' = 'cloudflare'): FetchRouter {
  return router
    .on(/cloudflare-dns\.com\/dns-query/, dohReply(zone, style))
    .on(/dns\.google\/resolve/, dohReply(zone, style))
}

const GATEWAY_HOSTS = FALLBACK_GATEWAYS.map((gateway) => new URL(gateway).host)
/** Anything at all aimed at a public gateway, in either request shape. */
const ANY_GATEWAY = new RegExp(GATEWAY_HOSTS.map((host) => host.replace(/\./g, '\\.')).join('|'))

/* -------------------------------------------------------------------------- */
/* the DNSLink record over DNS-over-HTTPS                                      */
/* -------------------------------------------------------------------------- */

describe('resolvePublishedCid, reading the DNSLink record over DNS-over-HTTPS', () => {
  it("parses 'dnslink=/ipfs/<cid>' out of a Cloudflare answer", async () => {
    const router = dohServing(new FetchRouter(), { [DNSLINK_HOST]: [`dnslink=/ipfs/${AUGUST}`] })
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)

    // The right question, asked the right way: the DNSLink host, TXT, and the
    // JSON content type these endpoints answer.
    const call = router.hits(/cloudflare-dns\.com/)[0]
    expect(call).toBeDefined()
    const query = new URL(call?.url ?? '').searchParams
    expect(query.get('name')).toBe(DNSLINK_HOST)
    expect(query.get('type')).toBe('TXT')
    expect(call?.headers['accept']).toBe('application/dns-json')
    expect(call?.method).toBe('GET')

    // One small request, and no gateway involved — which is the entire reason
    // the 20,808-entry listing timeout never comes up on a working network.
    expect(router.never(ANY_GATEWAY), 'a gateway was asked to resolve a name DNS had already answered').toBe(true)
    expect(dnsState.asked, "the operating system's resolver was asked unnecessarily").toEqual([])
  })

  it('parses the same record from Google, which does not quote it', async () => {
    dohServing(new FetchRouter(), { [DNSLINK_HOST]: [`dnslink=/ipfs/${AUGUST}`] }, 'google')
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
  })

  it('rejoins a value DNS split into chunks', async () => {
    // TXT strings are capped at 255 bytes, so a long value arrives as several
    // quoted pieces. Reading only the first would produce half a CID, which
    // parses as nothing and looks exactly like "the record is missing".
    const split = `"dnslink=/ipfs/${AUGUST.slice(0, 20)}" "${AUGUST.slice(20)}"`
    dohServing(new FetchRouter(), { [DNSLINK_HOST]: [split] }, 'google').offline().install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
  })

  it('ignores the other records living on the same name', async () => {
    dohServing(new FetchRouter(), {
      [DNSLINK_HOST]: [
        'v=spf1 -all',
        'google-site-verification=nothing-to-do-with-us',
        `dnslink=/ipfs/${AUGUST}`
      ]
    })
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
  })

  it('ignores an answer that is not a TXT record', async () => {
    // A CNAME in the answer section is ordinary; treating its target as a
    // DNSLink value would be reading a hostname as a content address.
    new FetchRouter()
      .on(/cloudflare-dns\.com|dns\.google/, () =>
        json({
          Status: 0,
          Answer: [
            { name: DNSLINK_HOST, type: 5, TTL: 300, data: 'dnslink.example.net.' },
            { name: DNSLINK_HOST, type: 16, TTL: 300, data: `"dnslink=/ipfs/${AUGUST}"` }
          ]
        })
      )
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
  })

  it('falls back to the bare domain, where the older convention put the record', async () => {
    const router = dohServing(new FetchRouter(), { [DOMAIN]: [`dnslink=/ipfs/${MAY}`] })
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(MAY)

    const names = router.hits(/cloudflare-dns\.com/).map((call) => new URL(call.url).searchParams.get('name'))
    // `_dnslink.` first, because that is where it belongs.
    expect(names[0]).toBe(DNSLINK_HOST)
    expect(names).toContain(DOMAIN)
  })

  it('asks the second provider when the first will not answer', async () => {
    // A member behind a network that blocks or hijacks one resolver still
    // deserves the current archive rather than a shrug.
    const router = new FetchRouter()
      .on(/cloudflare-dns\.com/, () => text('blocked by network policy', 403))
      .on(/dns\.google\/resolve/, dohReply({ [DNSLINK_HOST]: [`dnslink=/ipfs/${AUGUST}`] }, 'google'))
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
    expect(router.hits(/cloudflare-dns\.com/).length).toBeGreaterThan(0)
    expect(router.hits(/dns\.google/).length).toBeGreaterThan(0)
  })

  it('follows one hop to another DNSLink name, and stops there', async () => {
    dohServing(new FetchRouter(), {
      [DNSLINK_HOST]: ['dnslink=/ipns/archive.example.org'],
      '_dnslink.archive.example.org': [`dnslink=/ipfs/${MAY}`]
    })
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(MAY)
  })

  it('does not chase a chain somebody else made', async () => {
    const router = dohServing(new FetchRouter(), {
      [DNSLINK_HOST]: ['dnslink=/ipns/one.example.org'],
      '_dnslink.one.example.org': ['dnslink=/ipns/two.example.org'],
      '_dnslink.two.example.org': [`dnslink=/ipfs/${MAY}`]
    })
      .offline()
      .install()

    // Two hops is somebody's mistake or somebody's loop; either way this stops
    // and reports "could not establish it" rather than walking DNS all day.
    await expect(resolvePublishedCid()).resolves.toBe(BUILT_IN)
    expect(router.never(/two\.example\.org/)).toBe(true)
  })

  it('does not truncate a value that carries a path down to its first CID', async () => {
    // `/ipfs/<cid>/BIC Backup May-2026` names the folder at the END of that
    // path. Lopping the path off would silently substitute the directory above
    // the archive, and every comparison afterwards would be against the wrong
    // thing while looking perfectly valid.
    dohServing(new FetchRouter(), {
      [DNSLINK_HOST]: [`dnslink=/ipfs/${MAY}/BIC%20Backup%20May-2026`]
    })
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(BUILT_IN)
  })

  it('ignores a record whose address is not an address', async () => {
    dohServing(new FetchRouter(), { [DNSLINK_HOST]: ['dnslink=/ipfs/not-a-content-address'] })
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(BUILT_IN)
  })

  it('accepts either spelling of the address, and hands it back as published', async () => {
    // BIC could republish as `Qm…` tomorrow. That is the same directory, and it
    // is reported exactly as published rather than rewritten underneath anyone.
    dohServing(new FetchRouter(), { [DNSLINK_HOST]: [`dnslink=/ipfs/${MAY_V0}`] })
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(MAY_V0)
  })
})

/* -------------------------------------------------------------------------- */
/* the operating system's resolver, second                                     */
/* -------------------------------------------------------------------------- */

describe("resolvePublishedCid, falling back to this computer's own resolver", () => {
  it('uses it when DNS-over-HTTPS cannot be reached', async () => {
    dnsServing({ [DNSLINK_HOST]: [`dnslink=/ipfs/${AUGUST}`] })
    const router = new FetchRouter().offline().install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)

    // Both DoH endpoints were tried first: the OS resolver is second on purpose,
    // because home routers and corporate resolvers mangle underscore records
    // often enough that trusting it first loses the answer.
    expect(router.hits(/cloudflare-dns\.com/).length).toBeGreaterThan(0)
    expect(router.hits(/dns\.google/).length).toBeGreaterThan(0)
    expect(dnsState.asked).toContain(DNSLINK_HOST)
    expect(router.never(ANY_GATEWAY)).toBe(true)
  })

  it('rejoins the chunks it gets back', async () => {
    dnsServing({ [DNSLINK_HOST]: [`dnslink=/ipfs/${AUGUST.slice(0, 20)}|${AUGUST.slice(20)}`] })
    new FetchRouter().offline().install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
  })

  it('treats NXDOMAIN as "ask somebody else", not as an answer', async () => {
    // The measured local failure: public DNS serves this record perfectly and
    // this machine's resolver says it does not exist.
    dnsFailing('ENOTFOUND')
    const router = new FetchRouter()
      .on(new RegExp(GATEWAY_HOSTS[0]?.replace(/\./g, '\\.') ?? 'ipfs\\.io'), () =>
        new Response(null, { status: 301, headers: { 'x-ipfs-roots': AUGUST } })
      )
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
    expect(router.hits(ANY_GATEWAY).length).toBeGreaterThan(0)
  })

  it('does not wait for ever on a resolver that accepts the question and goes quiet', async () => {
    // `resolveTxt` has no deadline of its own. Without one imposed, a status
    // panel waits on a socket that will never answer.
    dnsHanging([DNSLINK_HOST])
    new FetchRouter().offline().install()

    const started = Date.now()
    await expect(resolvePublishedCid()).resolves.toBe(BUILT_IN)
    // The module gives it 5 s; anything under twenty proves a deadline exists
    // without pinning the exact number.
    expect(Date.now() - started).toBeLessThan(20_000)
  })
})

/* -------------------------------------------------------------------------- */
/* gateways, and the 504 that is not a resolution failure                      */
/* -------------------------------------------------------------------------- */

describe('resolvePublishedCid, asking a gateway when DNS is hopeless', () => {
  const IPFS_IO = FALLBACK_GATEWAYS[0] ?? 'https://ipfs.io'
  const PATH_FORM = `${IPFS_IO}/ipns/${DOMAIN}`
  /** What following the 301 asks for: a listing of 20,808 entries. */
  const ROOT_LISTING = `${PATH_FORM}/`

  beforeEach(() => {
    dnsFailing('ENOTFOUND')
  })

  it('takes the answer out of the 301 rather than following it into the timeout', async () => {
    const router = new FetchRouter()
      .on(
        (url) => url === PATH_FORM,
        () =>
          new Response(null, {
            status: 301,
            headers: { location: `/ipns/${DOMAIN}/`, 'x-ipfs-roots': AUGUST }
          })
      )
      // Present, and expected never to be touched. This is the request that
      // takes a minute and then 504s.
      .on((url) => url.startsWith(ROOT_LISTING), () => text('context deadline exceeded', 504))
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)

    // The whole trick, asserted rather than described: redirects are not
    // followed, so the listing is never requested.
    const head = router.hits(new RegExp(`^${PATH_FORM.replace(/[.]/g, '\\.')}$`))[0]
    expect(head?.method).toBe('HEAD')
    expect(head?.redirect, 'a followed redirect is what earns the 504').toBe('manual')
    expect(router.never(/ipns\/bureauofinternetculture\.art\//), 'the 20,808-entry listing was requested').toBe(
      true
    )
  })

  it('keeps going when a gateway does 504 on the root, and resolves by the other shape', async () => {
    // The failure this whole design is arranged around: a 504 here is the
    // gateway giving up on rendering a directory listing. It says nothing at all
    // about whether the name resolves, and must not end the search.
    const router = new FetchRouter()
      .on((url) => url.startsWith(PATH_FORM), () => text('context deadline exceeded', 504))
      .on(
        (url) => url.startsWith(`https://bureauofinternetculture-art.ipns.${new URL(IPFS_IO).host}/`),
        () =>
          new Response('', {
            status: 206,
            headers: { 'x-ipfs-roots': AUGUST, 'content-range': 'bytes 0-0/1874' }
          })
      )
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)

    // The subdomain form asks for one byte of the root block, so there is
    // nothing large for the gateway to time out on in the first place.
    const raw = router.hits(/ipns\.ipfs\.io/)[0]
    expect(raw?.headers['range']).toBe('bytes=0-0')
    expect(raw?.url).toContain('format=raw')
  })

  it('moves on to the next gateway when one is simply broken', async () => {
    const second = FALLBACK_GATEWAYS[1] ?? 'https://dweb.link'
    const router = new FetchRouter()
      .on((url) => url.includes(new URL(IPFS_IO).host), () => text('bad gateway', 502))
      .on(
        (url) => url.includes(new URL(second).host),
        () => new Response(null, { status: 200, headers: { 'x-ipfs-roots': MAY } })
      )
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(MAY)
    expect(router.hits(new RegExp(new URL(second).host.replace(/\./g, '\\.'))).length).toBeGreaterThan(0)
  })

  it('reads the last entry of x-ipfs-roots, which is what the name resolved to', async () => {
    // The header lists every CID walked to satisfy the request. The first is the
    // directory the path started from; the last is the thing addressed.
    new FetchRouter()
      .on(
        (url) => url.startsWith(PATH_FORM),
        () => new Response(null, { status: 200, headers: { 'x-ipfs-roots': `${MAY}, ${AUGUST}` } })
      )
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
  })

  it('falls back to the etag on a gateway that sends no roots header', async () => {
    new FetchRouter()
      .on(
        (url) => url.startsWith(PATH_FORM),
        () => new Response(null, { status: 200, headers: { etag: `W/"${AUGUST}.raw"` } })
      )
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(AUGUST)
  })

  it('is not fooled by a gateway that answers with prose', async () => {
    // Measured on the delegated-routing endpoint, which is why this module does
    // not use it: HTTP 200, `text/plain`, body "delegate error: routing: not
    // found". A 200 is not an answer.
    new FetchRouter()
      .on(ANY_GATEWAY, () => text('delegate error: routing: not found', 200))
      .offline()
      .install()

    await expect(resolvePublishedCid()).resolves.toBe(BUILT_IN)
  })
})

/* -------------------------------------------------------------------------- */
/* when nothing can answer                                                     */
/* -------------------------------------------------------------------------- */

describe('resolvePublishedCid, on a computer that can reach nothing', () => {
  it('hands back the address this app was built with, and says so once', async () => {
    dnsFailing('ECONNREFUSED')
    new FetchRouter().offline().install()

    await expect(resolvePublishedCid()).resolves.toBe(BUILT_IN)

    // One line, not sixteen. Every individual failure here is the expected
    // outcome on an offline machine, and a log that shouts about each one buries
    // the things that are genuinely news.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('/ipns/bureauofinternetculture.art')
    expect(warnings[0]).toMatch(/cannot say whether the copy here is current/)
  })

  it('stops when the member cancels, rather than working through the list', async () => {
    const controller = new AbortController()
    controller.abort()
    new FetchRouter().offline().install()

    await expect(resolvePublishedCid(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('gives up on the whole thing in seconds, not minutes', async () => {
    // Five gateways in two request shapes, plus two DoH endpoints and the OS
    // resolver. Unbounded, that is a status panel that never draws.
    dnsFailing('ENOTFOUND')
    new FetchRouter().offline().install()

    const started = Date.now()
    await resolvePublishedCid()
    expect(Date.now() - started).toBeLessThan(20_000)
  })
})
