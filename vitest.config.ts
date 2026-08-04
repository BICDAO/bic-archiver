import { defineConfig } from 'vitest/config'

/**
 * The DEFAULT suite: `npx vitest run` / `npm test`.
 *
 * Everything here must pass with the network cable unplugged. `test/setup/no-network.ts`
 * enforces that by replacing `globalThis.fetch` with a stub that throws, so a test that
 * quietly starts depending on a gateway fails loudly instead of turning the suite into a
 * weather report. Tests that need to exercise a network-shaped code path (`resolveTokenUri`
 * decoding a `data:` URI, for instance) stub `fetch` themselves with `vi.stubGlobal` and
 * hand it back afterwards.
 *
 * Live tests live in `test/live/` and are deliberately unreachable from this config —
 * they run only via `npm run test:live` (see vitest.live.config.ts).
 *
 * `test/pinning/` is included here on purpose. It is offline (it stubs `fetch` and
 * binds its one real HTTP server to 127.0.0.1), so it belongs in the suite CI runs
 * — and it is the only coverage the pinning engine has. It carries its own config
 * as well, for running that subset alone; the two must agree.
 *
 * `test/node/` is here for the same reason. It is offline (its harness routes
 * `fetch` itself and serves a real tar.gz from memory), and `test/node/vitest.config.ts`
 * already documents itself as a subset of this suite — so leaving it out meant 25
 * tests over the code that downloads and executes a binary never ran in CI.
 *
 * `test/drift/` likewise. It routes `fetch` and additionally replaces
 * `node:dns/promises`, because taking `fetch` away does nothing about a DNS
 * lookup — left alone, the drift tests would resolve a real domain and turn into
 * a report on whoever's network. With that replaced they are fully offline, and
 * they are the only coverage of the check that decides whether a member is told
 * to re-copy 1.8 GB.
 */
export default defineConfig({
  test: {
    include: [
      'test/*.test.ts',
      'test/pinning/*.test.ts',
      'test/node/*.test.ts',
      'test/drift/*.test.ts'
    ],
    exclude: ['test/live/**', 'node_modules/**', 'out/**', 'release/**'],
    environment: 'node',
    setupFiles: ['test/setup/no-network.ts'],
    // Reconstructing a CID replays up to 18 import parameter sets; on a cold
    // cache that is comfortably under 30s but well over vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    reporters: ['default']
  }
})
