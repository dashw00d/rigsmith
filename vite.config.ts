import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { rigsmithServer } from './server/plugin.ts'

export default defineConfig({
  root: 'src/',
  publicDir: '../static/',
  base: './',
  server: { host: '127.0.0.1', port: 5180, strictPort: false, open: false },
  preview: { host: '127.0.0.1', port: 5181 },
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 2000 },
  plugins: [svelte({ configFile: '../svelte.config.js' }), rigsmithServer()],
})
