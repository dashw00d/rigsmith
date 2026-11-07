import { realpathSync } from 'node:fs'
import path from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { rigsmithServer } from './server/plugin.ts'

// (a worktree's node_modules may be a link to another checkout's: vite serves files from where it really is)
const modules = ((): string[] => {
  try { return [realpathSync(path.join(import.meta.dirname, 'node_modules'))] } catch { return [] }
})()

export default defineConfig({
  root: 'src/',
  publicDir: '../static/',
  base: './',
  server: {
    host: '127.0.0.1', port: 5180, strictPort: false, open: false,
    fs: { allow: [searchForWorkspaceRoot(import.meta.dirname), ...modules] },
  },
  preview: { host: '127.0.0.1', port: 5181 },
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 2000 },
  plugins: [svelte({ configFile: '../svelte.config.js' }), rigsmithServer()],
})
