/**
 * Offline enforcement for the default test suite.
 *
 * The brief for the offline tier is "must pass with NO network". Asserting that by hand is
 * hopeless — one careless import and the suite silently becomes an availability monitor for
 * ipfs.io. So instead of trusting ourselves, we take `fetch` away.
 *
 * Any offline test that reaches the network gets a loud, specific failure naming the URL.
 * Tests that legitimately need to drive a network-shaped code path (`resolveTokenUri`, which
 * always goes through `eth_call`) install their own stub with `vi.stubGlobal('fetch', …)`;
 * `vi.unstubAllGlobals()` then restores *this* stub, not the real `fetch`, so the guard
 * survives for the rest of the file.
 */

/**
 * Deliberately `async`, so the failure arrives as a REJECTED PROMISE rather than
 * a synchronous throw. Real `fetch` never throws synchronously — it always
 * returns a promise — and code under test relies on that: a module that races
 * gateways with `urls.map(fetch)` and `Promise.allSettled` would explode out of
 * the `.map()` under a synchronously-throwing stub, failing in a shape that
 * could never happen against the real thing. A guard that lies about how the
 * network fails is a guard that teaches the wrong lesson.
 */
const offline = async (input: unknown): Promise<never> => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : ((input as { url?: string } | null)?.url ?? '(unknown URL)')

  throw new Error(
    `The offline test suite tried to reach the network: ${url}\n` +
      'Offline tests must not make real requests. Either stub fetch with ' +
      "vi.stubGlobal('fetch', …), or move this test into test/live/."
  )
}

// Deliberately assigned rather than stubbed: vi.unstubAllGlobals() in a test file must
// fall back to this, not to the real implementation.
globalThis.fetch = offline as unknown as typeof globalThis.fetch
