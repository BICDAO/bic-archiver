import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Runs the drift tests alone: `npx vitest run --config test/drift/vitest.config.ts`.
 *
 * These files are also part of the default suite (see the root `vitest.config.ts`),
 * because they are offline — `test/setup/no-network.ts` takes `fetch` away, every test
 * here routes its own, and `node:dns/promises` is replaced so the operating system's
 * resolver is never actually asked about a real domain. The two configs must agree; a
 * drift test that only ever ran from this file would be a check on the check that
 * nothing checks.
 */
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  root: projectRoot,
  test: {
    include: ['test/drift/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'release/**'],
    environment: 'node',
    setupFiles: ['test/setup/no-network.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    reporters: ['default']
  }
})
