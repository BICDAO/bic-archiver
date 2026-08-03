/**
 * A test for the test suite itself.
 *
 * The brief for this tier is "must pass with NO network". That is enforced by
 * `test/setup/no-network.ts`, which replaces `globalThis.fetch` with a stub that
 * throws — but nothing so far proved the guard was actually *installed*.
 *
 * That is a real hole rather than a theoretical one: none of the other offline
 * tests call `fetch` without stubbing it first, so if `setupFiles` were dropped
 * from `vitest.config.ts` — or the path were mistyped, or the file deleted — the
 * whole suite would stay green while quietly losing its offline guarantee. The
 * next test to reach for a gateway would then pass on a developer's machine and
 * fail in CI, which is exactly the "suite as weather report" outcome the guard
 * exists to prevent.
 *
 * So: assert the guard is there, and assert it still bites after a test file has
 * finished stubbing `fetch` for its own purposes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the offline guard', () => {
  it('is installed — a bare fetch() fails instead of reaching the network', async () => {
    await expect(fetch('https://ipfs.io/ipfs/QmSomething')).rejects.toThrow(
      /offline test suite tried to reach the network/i
    )
  })

  it('names the URL, so a stray request is easy to track down', async () => {
    await expect(fetch('https://trustless-gateway.link/ipfs/QmXyz')).rejects.toThrow(
      /https:\/\/trustless-gateway\.link\/ipfs\/QmXyz/
    )
  })

  it('says what to do about it', async () => {
    await expect(fetch('https://ethereum-rpc.publicnode.com')).rejects.toThrow(
      /vi\.stubGlobal\('fetch'|move this test into test\/live/
    )
  })

  it('reports a Request or URL argument, not "[object Object]"', async () => {
    await expect(fetch(new URL('https://dweb.link/ipfs/QmUrl'))).rejects.toThrow(
      /https:\/\/dweb\.link\/ipfs\/QmUrl/
    )
    await expect(fetch(new Request('https://dweb.link/ipfs/QmRequest'))).rejects.toThrow(
      /https:\/\/dweb\.link\/ipfs\/QmRequest/
    )
  })

  /**
   * `tokenUri.test.ts` stubs `fetch` and calls `vi.unstubAllGlobals()` afterwards.
   * That restores whatever was on `globalThis` when the stub was installed — which
   * is the guard, precisely because `no-network.ts` assigns rather than stubs. If
   * that ever changed, `unstubAllGlobals` would hand back the *real* fetch and the
   * rest of that file would be silently online.
   */
  it('survives a test stubbing fetch and unstubbing it again', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'))
    expect((await fetch('https://example.com')).ok).toBe(true)

    vi.unstubAllGlobals()

    await expect(fetch('https://example.com')).rejects.toThrow(
      /offline test suite tried to reach the network/i
    )
  })

  it('keeps the live tier out of this config', async () => {
    // vitest.config.ts includes only `test/*.test.ts`, so `test/live/*.live.test.ts`
    // is unreachable from `npm test` by glob shape as well as by the explicit
    // exclude. If someone flattens a live test into test/, this fails.
    const { readdir } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')

    const testDir = dirname(fileURLToPath(import.meta.url))
    const flattened = (await readdir(testDir)).filter((name) => name.includes('.live.'))

    expect(flattened, 'live tests must stay in test/live/, not test/').toEqual([])

    // ...and the live directory really is where they live.
    const live = await readdir(join(testDir, 'live'))
    expect(live.some((name) => name.endsWith('.live.test.ts'))).toBe(true)
  })
})
