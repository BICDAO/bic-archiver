import { defineConfig } from 'vitest/config'

/**
 * The LIVE suite: `npm run test:live` only.
 *
 * These tests talk to Ethereum mainnet, real IPFS gateways and the delegated routing
 * endpoint. They are intentionally NOT reachable from vitest.config.ts, so CI and a plain
 * `npm test` never touch the network.
 *
 * They are also documentation: one of them asserts that the DAO's own Oct-2025 backup CID
 * is unreachable. If that test ever starts failing, somebody has re-pinned the content and
 * that is very good news.
 */
export default defineConfig({
  test: {
    include: ['test/live/*.live.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'release/**'],
    environment: 'node',
    // No no-network setup file here: these tests are the network.
    // A dead CID is allowed to take its full 20s health budget, and a CAR fetch
    // walks up to four gateways, so the per-test budget is generous.
    testTimeout: 240_000,
    hookTimeout: 60_000,
    globals: false,
    // Public RPCs and gateways rate-limit; keep the pressure low and predictable.
    fileParallelism: false,
    reporters: ['default']
  }
})
