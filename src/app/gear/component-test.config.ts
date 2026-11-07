// Targeted Svelte component tests use the compiler and a worktree-local cache; the main Vitest config remains untouched.
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [svelte({ configFile: './svelte.config.js' })],
  cacheDir: './.work/component-vite-cache',
  resolve: { conditions: ['browser'] },
  test: { environment: 'jsdom', maxWorkers: 1, include: ['src/app/gear/*.component.ts'] },
})
