import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte({ configFile: './svelte.config.js' })],
  cacheDir: resolve(import.meta.dirname, '.work/vitest-cache'),
  test: {
    globals: true,
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html']
    }
  },
  resolve: {
    conditions: ['browser'],
    alias: {
      '@': resolve(import.meta.dirname, './src')
    }
  }
})
