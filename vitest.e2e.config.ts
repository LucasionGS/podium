import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** End-to-end export tests: drive the built app headlessly. Run `electron-vite build` first (see `pnpm test:export`). */
export default defineConfig({
  resolve: { alias: { '@core': resolve('src/core'), '@shared': resolve('src/shared') } },
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
})
