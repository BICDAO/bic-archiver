import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  root: projectRoot,
  test: {
    include: ['test/pinning/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'release/**'],
    environment: 'node',
    setupFiles: ['test/setup/no-network.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    reporters: ['default']
  }
})
