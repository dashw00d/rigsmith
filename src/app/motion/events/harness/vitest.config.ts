// The Events lane and inspector mounted in jsdom against a TimelineView made here (the timeline that mounts them is
// built elsewhere): `npx vitest run --config src/app/motion/events/harness/vitest.config.ts`.
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [svelte({ configFile: false, compilerOptions: { css: 'injected' } })],
  resolve: { conditions: ['browser'] },
  test: {
    root: import.meta.dirname,
    include: ['*.harness.svelte.ts'],
    environment: 'jsdom',
    globals: true,
  },
})
