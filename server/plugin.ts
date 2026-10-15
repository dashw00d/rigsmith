// Vite plugin: mounts the API on the dev server, so `npm run dev` is the whole app.
import type { Plugin } from 'vite'
import { handle, resumeInterrupted } from './api.ts'
import { ensureWorkspace } from './workspace.ts'

export function rigsmithServer (): Plugin {
  return {
    name: 'rigsmith-server',
    async configureServer (server) {
      await ensureWorkspace()
      await resumeInterrupted()
      server.middlewares.use((req, res, next) => { void handle(req, res, next) })
    },
    async configurePreviewServer (server) {
      await ensureWorkspace()
      server.middlewares.use((req, res, next) => { void handle(req, res, next) })
    },
  }
}
