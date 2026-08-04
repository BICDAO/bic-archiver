/**
 * The four verdicts, and the one distinction that matters more than the rest.
 *
 * `behind` is an instruction: BIC has moved on, copy 1.8 GB again. `unknown` is
 * an admission: nobody could be asked, so nothing is being claimed. Confusing
 * them is not a cosmetic bug in either direction —
 *
 *   - `unknown` shown as a problem sends a member on a café wifi off to redo a
 *     two-hour copy of an archive that was already current, and teaches them to
 *     ignore the banner, which is how the next real warning gets missed;
 *   - `behind` quietly reported as `in-sync` recreates the exact silent failure
 *     this whole app exists to end. 428 assets were already unreachable before
 *     anybody looked.
 *
 * So the tests below do not only assert the verdict string. They assert that
 * `unknown` never carries a published CID for anyone to eyeball and draw their
 * own conclusion from, that its sentence says the check could not run rather
 * than that something is wrong, and that `behind` is never reached without first
 * asking the member's own node whether it already holds the current archive —
 * because a member who re-mirrored by other means is not behind, and telling
 * them they are costs them an afternoon.
 *
 * The gateway 504 gets its own section. It is what a gateway returns when asked
 * to render a listing of 20,808 entries, it is not a resolution failure, and a
 * check that read it as one would report every healthy member as unmeasurable.
 *
 * Offline throughout: `fetch` is routed by the harness and `node:dns/promises`
 * is replaced, so nothing here depends on the network or the clock of whoever
 * runs it.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BIC_ARCHIVE } from '../../src/shared/community'
import { FALLBACK_GATEWAYS } from '../../src/shared/constants'
import { DEFAULT_PINNING_SETTINGS, type PinningSettings } from '../../src/shared/pinning'
import { TempDirs } from '../helpers/support'
import { FetchRouter, type RecordedCall, json, kuboRpc, text } from '../node/harness'

import { dnsFailing, dnsServing, resetDns } from './fakeDns'

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  const { fakeResolveTxt } = await import('./fakeDns')
  return { ...actual, resolveTxt: fakeResolveTxt }
})

const { checkDrift, getLocalMirrorCid, recordMirrored } = await import(
  '../../src/main/community/drift'
)

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const DOMAIN = 'bureauofinternetculture.art'
const DNSLINK_HOST = `_dnslink.${DOMAIN}`

/** What the member copied in May. */
const MAY = 'bafybeihdtlvr3uypo2dnekk7kxfrzfqhsjrq3fjph5pctuda5m65whxcui'
/** The same directory, spelled the way an older node writes it. */
const MAY_V0 = 'Qmdf8GUMaAmY2i6ZmpL7nrqjxaYB2Pf82KHsekVDdctEcy'
/** What BIC publishes now, after adding some NFTs. */
const AUGUST = 'bafybeidhevnylbsaz76nof4rkbygmgq67z4numejj6rq4yaby4ioomhbsi'

const BUILT_IN = BIC_ARCHIVE.rootCid

const temps = new TempDirs()

/** Where the "what did I last copy?" note goes. A folder path is a valid store. */
let store = ''
let settings: PinningSettings
let warnings: string[] = []

beforeEach(async () => {
  resetDns()
  store = await temps.make('bic-drift-state-')
  settings = structuredClone(DEFAULT_PINNING_SETTINGS)
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDns()
  await temps.cleanup()
})

/** A DNS-over-HTTPS endpoint publishing one address for the archive. */
function bicPublishes(router: FetchRouter, cid: string): FetchRouter {
  return router.on(/cloudflare-dns\.com|dns\.google/, (call: RecordedCall) => {
    const host = new URL(call.url).searchParams.get('name') ?? ''
    if (host !== DNSLINK_HOST) return json({ Status: 3 })
    return json({
      Status: 0,
      Answer: [{ name: host, type: 16, TTL: 300, data: `"dnslink=/ipfs/${cid}"` }]
    })
  })
}

/** The member's own IPFS node, keeping exactly the addresses listed. */
function nodeKeeping(router: FetchRouter, pinned: readonly string[]): FetchRouter {
  return router.on(
    /127\.0\.0\.1:5001\//,
    kuboRpc({ peerId: '12D3KooWTheMemBerSoWnNodEiDeNtItYaAaAaAaAaAaAaAaAaAaAa', addresses: [], pinned })
  )
}

/** What the member's node was asked about, in order. */
function pinQuestions(router: FetchRouter): string[] {
  return router
    .hits(/\/api\/v0\/pin\/ls/)
    .map((call) => new URL(call.url).searchParams.get('arg') ?? '')
}

const GATEWAY_HOSTS = FALLBACK_GATEWAYS.map((gateway) => new URL(gateway).host)
const ANY_GATEWAY = new RegExp(GATEWAY_HOSTS.map((host) => host.replace(/\./g, '\\.')).join('|'))

/**
 * Words that turn a status into an instruction: a claim that the copy is old, or
 * a demand that the member do something about it. `unknown` must contain none of
 * them — it is the one verdict that is explicitly not asking for anything.
 *
 * Deliberately narrow. An earlier version of this pattern also looked for "wrong
 * with", and matched the sentence "not that anything is **wrong with** your
 * copy" — a reassurance flagged as an alarm by a regex that could not read a
 * negation. So the words here are only ones that cannot appear in a disclaimer,
 * and the reassuring half is asserted positively above rather than by absence.
 */
const READS_AS_A_PROBLEM = /out of date|stale|older version|copy(ing)? again|bring it up to date|behind/i

/* -------------------------------------------------------------------------- */
/* in-sync                                                                     */
/* -------------------------------------------------------------------------- */

describe('checkDrift, when the copy matches what BIC publishes', () => {
  it('says in-sync, and does not ask the node to prove it', async () => {
    await recordMirrored(store, AUGUST)
    const router = bicPublishes(new FetchRouter(), AUGUST).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('in-sync')
    expect(status.publishedCid).toBe(AUGUST)
    expect(status.localCid).toBe(AUGUST)
    expect(status.detail).toMatch(/matches the archive BIC publishes right now/i)
    expect(status.detail).toMatch(/nothing to do/i)
    expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false)
    expect(status.lastMirroredAt).toBeDefined()

    // The note and the published address already agree, so there is nothing the
    // node could add. A status panel should not wake a busy daemon to be told
    // what it already knows.
    expect(router.never(/127\.0\.0\.1:5001/)).toBe(true)
  })

  it('does not invent drift out of two spellings of the same directory', async () => {
    // A `Qm…` note against a `bafy…` published address is the same content. A
    // string comparison here would tell a perfectly up-to-date member to spend
    // an afternoon re-copying 1.8 GB.
    await recordMirrored(store, MAY_V0)
    bicPublishes(new FetchRouter(), MAY).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('in-sync')
    // Shown in the published spelling, so nobody reading the panel sees two
    // different-looking addresses side by side and concludes something is wrong.
    expect(status.localCid).toBe(MAY)
    expect(status.publishedCid).toBe(MAY)
  })

  it('believes the node over a stale note, rather than ordering a re-copy', async () => {
    // The member mirrored again from the command line, or on another install.
    // The note is out of date; the machine is not. Serving the current archive
    // is what actually matters, and the node is the thing doing it.
    await recordMirrored(store, MAY)
    const router = nodeKeeping(bicPublishes(new FetchRouter(), AUGUST), [AUGUST]).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('in-sync')
    expect(status.localCid).toBe(AUGUST)
    expect(pinQuestions(router)).toContain(AUGUST)
    // No date is invented: the node can say what it holds, never when a member
    // copied it, and a made-up "last mirrored" would be a lie on the screen.
    expect(status.lastMirroredAt).toBeUndefined()
  })

  it('recognises a member who copied the archive before this app kept notes', async () => {
    const router = nodeKeeping(bicPublishes(new FetchRouter(), AUGUST), [AUGUST]).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('in-sync')
    expect(status.localCid).toBe(AUGUST)
    expect(status.lastMirroredAt).toBeUndefined()
    expect(pinQuestions(router)).toContain(AUGUST)
  })
})

/* -------------------------------------------------------------------------- */
/* behind                                                                      */
/* -------------------------------------------------------------------------- */

describe('checkDrift, when BIC has moved on', () => {
  it('says behind, having first asked the node whether it already has the new one', async () => {
    await recordMirrored(store, MAY)
    const router = nodeKeeping(bicPublishes(new FetchRouter(), AUGUST), []).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('behind')
    expect(status.publishedCid).toBe(AUGUST)
    expect(status.localCid).toBe(MAY)
    expect(status.lastMirroredAt).toBeDefined()
    expect(status.detail).toMatch(/BIC has updated the archive since you last copied it/i)
    expect(status.detail).toMatch(/copying again will bring it up to date/i)

    // The instruction costs the member an afternoon, so it is not given until
    // the machine itself has been asked and said no.
    expect(pinQuestions(router)).toContain(AUGUST)
  })

  it('still says behind when the node cannot be reached to contradict it', async () => {
    // A stopped node contributes no answer either way. The note is then the only
    // evidence there is, and it says the copy is old.
    await recordMirrored(store, MAY)
    bicPublishes(new FetchRouter(), AUGUST).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('behind')
    expect(status.localCid).toBe(MAY)
  })

  it('says behind on the strength of a resolved address, whichever source found it', async () => {
    // DNS-over-HTTPS blocked, the operating system's resolver working: still a
    // real answer, so still a real verdict.
    dnsServing({ [DNSLINK_HOST]: [`dnslink=/ipfs/${AUGUST}`] })
    await recordMirrored(store, MAY)
    nodeKeeping(new FetchRouter(), []).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('behind')
    expect(status.publishedCid).toBe(AUGUST)
  })
})

/* -------------------------------------------------------------------------- */
/* not-mirrored                                                                */
/* -------------------------------------------------------------------------- */

describe('checkDrift, when there is no copy on this computer', () => {
  it('says not-mirrored, and frames it as the useful thing to do next', async () => {
    const router = nodeKeeping(bicPublishes(new FetchRouter(), AUGUST), []).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('not-mirrored')
    expect(status.localCid).toBeUndefined()
    expect(status.publishedCid).toBe(AUGUST)
    expect(status.detail).toMatch(/no sign of a copy of BIC's archive on this computer yet/i)
    expect(status.detail).toMatch(/the single most useful thing you can do/i)
    // Not a failure, and it must not read as one — this is a new member.
    expect(status.detail).not.toMatch(/error|failed|problem/i)

    // Both plausible addresses were put to the node before concluding there is
    // nothing here: a member may have copied a build's built-in snapshot.
    expect(pinQuestions(router)).toContain(AUGUST)
    expect(pinQuestions(router)).toContain(BUILT_IN)
  })

  it('says not-mirrored even when nothing could be resolved, because that part is a local fact', async () => {
    // Being offline does not stop this app knowing there is no copy here, and
    // "make one" is useful advice regardless of whether BIC could be reached.
    dnsFailing('ENOTFOUND')
    nodeKeeping(new FetchRouter(), []).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('not-mirrored')
    expect(status.publishedCid).toBeUndefined()
  })

  it('is not fooled by a node that is switched off into thinking a copy is missing', async () => {
    // No note and no reachable node means no evidence, so the honest answer is
    // "no sign of a copy" — worded as an absence of evidence rather than as a
    // finding, which is why `detail` says "no sign of" and not "you have not".
    bicPublishes(new FetchRouter(), AUGUST).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('not-mirrored')
    expect(status.detail).toMatch(/no sign of a copy/i)
  })
})

/* -------------------------------------------------------------------------- */
/* unknown — an admission, never a problem                                     */
/* -------------------------------------------------------------------------- */

describe('checkDrift, when BIC’s address could not be looked up', () => {
  it('says unknown, and says plainly that this is about the check and not the copy', async () => {
    await recordMirrored(store, MAY)
    dnsFailing('ENOTFOUND')
    new FetchRouter().offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('unknown')
    expect(status.detail).toMatch(/could not be looked up just now/i)
    expect(status.detail).toMatch(/usually because this computer is offline/i)
    expect(status.detail).toMatch(/only means this check could not run/i)
    expect(status.detail).toMatch(/not that anything is wrong with your copy/i)

    // The member's own copy is still reported — it is a fact about their machine
    // and does not depend on reaching anybody.
    expect(status.localCid).toBe(MAY)
  })

  it('publishes no address for anyone to draw their own conclusion from', async () => {
    // The address compiled into this app is a snapshot that goes stale the day
    // BIC adds an NFT. Putting it on screen beside the member's own would invite
    // exactly the comparison this verdict just refused to make.
    await recordMirrored(store, MAY)
    dnsFailing('ENOTFOUND')
    new FetchRouter().offline().install()

    const status = await checkDrift(settings, store)

    expect(status.publishedCid).toBeUndefined()
    expect(JSON.stringify(status)).not.toContain(BUILT_IN)
  })

  it('never turns an offline machine into "behind", even when the two addresses differ', async () => {
    // The sharpest version: what this member holds is genuinely a different
    // string from the address in the app. Comparing them would produce a
    // confident, wrong `behind` and send them off to re-copy 1.8 GB.
    expect(MAY_V0).not.toBe(BUILT_IN)
    await recordMirrored(store, MAY_V0)
    dnsFailing('ENOTFOUND')
    new FetchRouter().offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('unknown')
    expect(status.verdict).not.toBe('behind')
    // Nothing in the sentence claims the copy is old or asks for it to be redone…
    expect(status.detail).not.toMatch(READS_AS_A_PROBLEM)
    // …and it says outright that this is about the check, not the copy.
    expect(status.detail).toMatch(/not that anything is wrong with your copy/i)
  })

  it('does not quietly guess in-sync either', async () => {
    // The other way to be wrong: a member whose copy really is stale is told
    // everything is fine, which is the silent failure this app exists to end.
    await recordMirrored(store, BUILT_IN)
    dnsFailing('ENOTFOUND')
    new FetchRouter().offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('unknown')
    expect(status.detail).not.toMatch(/nothing to do/i)
  })

  it('reports unknown rather than throwing when everything at once is broken', async () => {
    // Unreadable note, dead DNS, dead gateways, dead node. A status panel that
    // cannot draw itself is worse than one that says "not known just now".
    await writeFile(join(store, 'mirror-state.json'), '{ this is not json', 'utf8')
    dnsFailing('ESERVFAIL')
    new FetchRouter().offline().install()

    const status = await checkDrift(settings, store)

    // No note and no node leaves nothing local, which is its own verdict.
    expect(status.verdict).toBe('not-mirrored')
    expect(status.detail).toBeTruthy()
    expect(warnings.some((line) => /not readable JSON/i.test(line))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* the 504 that is not a resolution failure                                    */
/* -------------------------------------------------------------------------- */

describe('checkDrift, and the gateway that times out listing 20,808 entries', () => {
  const IPFS_IO = FALLBACK_GATEWAYS[0] ?? 'https://ipfs.io'
  const PATH_FORM = `${IPFS_IO}/ipns/${DOMAIN}`

  it('never asks a gateway to list the archive at all when DNS can answer', async () => {
    await recordMirrored(store, AUGUST)
    const router = bicPublishes(new FetchRouter(), AUGUST)
      // Every gateway, in every shape, doing what the real ones do to that
      // request. None of it should be reached.
      .on(ANY_GATEWAY, () => text('context deadline exceeded', 504))
      .offline()
      .install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('in-sync')
    expect(router.never(ANY_GATEWAY), 'a gateway was asked to render the archive root').toBe(true)
  })

  it('does NOT report unknown when a gateway 504s: it resolves by the other request shape', async () => {
    // DNS is hopeless on this machine, so gateways are the only source left, and
    // the first thing one of them does is time out rendering a listing. That is
    // the gateway giving up on a directory of 20,808 entries — it says nothing
    // whatever about whether the name resolves. Treating it as a resolution
    // failure would put "could not check" in front of a member whose copy is
    // perfectly current.
    dnsFailing('ENOTFOUND')
    await recordMirrored(store, AUGUST)

    const router = new FetchRouter()
      .on((url) => url.startsWith(PATH_FORM), () => text('context deadline exceeded', 504))
      .on(
        (url) => url.startsWith(`https://bureauofinternetculture-art.ipns.${new URL(IPFS_IO).host}/`),
        () => new Response('', { status: 206, headers: { 'x-ipfs-roots': AUGUST } })
      )
      .offline()
      .install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).not.toBe('unknown')
    expect(status.verdict).toBe('in-sync')
    expect(status.publishedCid).toBe(AUGUST)
    expect(router.hits(/ipns\.ipfs\.io/).length).toBeGreaterThan(0)
  })

  it('reaches a real "behind" through the 301 without ever requesting the listing', async () => {
    // The measured shape: `HEAD /ipns/<name>` answers 301, and the redirect
    // itself already carries the resolved root. Following it is what asks for
    // the listing and earns the 504, so it is not followed.
    dnsFailing('ENOTFOUND')
    await recordMirrored(store, MAY)

    const router = new FetchRouter()
      .on(
        (url) => url === PATH_FORM,
        () =>
          new Response(null, {
            status: 301,
            headers: { location: `/ipns/${DOMAIN}/`, 'x-ipfs-roots': AUGUST }
          })
      )
      .on((url) => url.startsWith(`${PATH_FORM}/`), () => text('context deadline exceeded', 504))
    nodeKeeping(router, []).offline().install()

    const status = await checkDrift(settings, store)

    expect(status.verdict).toBe('behind')
    expect(status.publishedCid).toBe(AUGUST)
    expect(status.localCid).toBe(MAY)

    const head = router.hits(/ipfs\.io\/ipns\//)[0]
    expect(head?.method).toBe('HEAD')
    expect(head?.redirect).toBe('manual')
    expect(router.never(/ipns\/bureauofinternetculture\.art\//)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* the note itself                                                             */
/* -------------------------------------------------------------------------- */

describe('the record of what was last copied', () => {
  it('round-trips through the store shape the app actually passes', async () => {
    // `SettingsStore` satisfies this structurally: the note lives beside
    // `settings.json`, not inside it, because that file discards anything it
    // does not recognise on every write.
    const folder = await temps.make('bic-drift-settings-')
    const settingsStore = { settingsPath: join(folder, 'settings.json') }

    await recordMirrored(settingsStore, AUGUST)

    const written = JSON.parse(await readFile(join(folder, 'mirror-state.json'), 'utf8')) as {
      rootCid?: string
      mirroredAt?: string
    }
    expect(written.rootCid).toBe(AUGUST)
    expect(Number.isNaN(Date.parse(written.mirroredAt ?? ''))).toBe(false)

    new FetchRouter().offline().install()
    await expect(getLocalMirrorCid(settings, settingsStore)).resolves.toBe(AUGUST)
  })

  it('refuses to record something that is not an address, and keeps the old note', async () => {
    await recordMirrored(store, MAY)
    await recordMirrored(store, 'not-a-cid')

    new FetchRouter().offline().install()
    await expect(getLocalMirrorCid(settings, store)).resolves.toBe(MAY)
    expect(warnings.some((line) => /refusing to record/i.test(line))).toBe(true)
  })

  it('treats a corrupt note as no note rather than as evidence', async () => {
    await writeFile(join(store, 'mirror-state.json'), '{"rootCid": "gibberish"}', 'utf8')
    nodeKeeping(new FetchRouter(), []).offline().install()

    await expect(getLocalMirrorCid(settings, store)).resolves.toBeNull()
  })

  it('never throws, however impossible the place it is asked to write to', async () => {
    // This runs immediately after the longest and most valuable operation in the
    // app. Turning "1.8 GB copied successfully" into an error because a small
    // JSON file would not write would be an absurd trade.
    await expect(recordMirrored('', AUGUST)).resolves.toBeUndefined()
    await expect(recordMirrored(join(store, 'no', 'such', 'place'), AUGUST)).resolves.toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* cancellation                                                                */
/* -------------------------------------------------------------------------- */

describe('checkDrift, when the member stops it', () => {
  it('stops, and says so as an AbortError rather than a verdict', async () => {
    const controller = new AbortController()
    controller.abort()
    new FetchRouter().offline().install()

    await expect(checkDrift(settings, store, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})
