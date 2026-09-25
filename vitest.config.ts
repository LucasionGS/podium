import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@core': resolve('src/core'), '@shared': resolve('src/shared') } },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' }
})
