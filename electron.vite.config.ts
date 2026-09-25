import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const alias = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared')
}

/**
 * React components hot-swap fine, but stores hold singletons. Hot-swapping those leaves two copies
 * alive: the UI writes to the new one while long-lived code keeps reading the old one. For plain .ts
 * files, reload the page instead.
 */
function fullReloadForLogic(): Plugin {
  return {
    name: 'podium:full-reload-for-logic',
    handleHotUpdate({ file, server }) {
      if (!file.endsWith('.ts') || !file.includes('/src/')) return
      server.ws.send({ type: 'full-reload' })
      return []
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), capture: resolve('src/preload/capture.ts') }
      }
    }
  },
  renderer: {
    resolve: { alias: { ...alias, '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss(), fullReloadForLogic()],
    build: {
      rollupOptions: {
        // `capture` is the hidden audio-capture page of the Windows engine.
        input: { index: resolve('src/renderer/index.html'), capture: resolve('src/renderer/capture.html') }
      }
    }
  }
})
