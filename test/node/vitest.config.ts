import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Runs the managed-node tests alone: `npx vitest run --config test/node/vitest.config.ts`.
 *
 * These files are also part of the default suite (see the root `vitest.config.ts`),
 * because they are offline — `test/setup/no-network.ts` takes `fetch` away and every
 * test here stubs its own — and offline is what CI runs. The two configs must agree.
 */
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  root: projectRoot,
  test: {
    include: ['test/node/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'release/**'],
    environment: 'node',
    setupFiles: ['test/setup/no-network.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    reporters: ['default']
  }
})
