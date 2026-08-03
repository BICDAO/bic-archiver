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
 */
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
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
