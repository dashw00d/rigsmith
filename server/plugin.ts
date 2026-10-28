// Vite plugin: mounts the API on the dev and preview servers, so `npm run dev` is the whole app. At start it reads
// every character (migrating v1 files), sets aside gear folders nothing uses, and picks up work a restart cut off.
import type { Plugin } from 'vite'
import { handle, resumeInterrupted } from './api.ts'
import { ensureWorkspace, sweepOrphanGarments } from './store.ts'

async function start (): Promise<void> {
  await ensureWorkspace()
  try {
    const moved = await sweepOrphanGarments()
    if (moved > 0) console.log(`rigsmith: ${moved} unused gear folder${moved === 1 ? '' : 's'} moved to workspace/trash`)
  } catch (error) {
    console.error('rigsmith: the gear folder sweep failed:', error)
  }
  await resumeInterrupted()
}

export function rigsmithServer (): Plugin {
  return {
    name: 'rigsmith-server',
    async configureServer (server) {
      await start()
      server.middlewares.use((req, res, next) => { void handle(req, res, next) })
    },
    async configurePreviewServer (server) {
      await start()
      server.middlewares.use((req, res, next) => { void handle(req, res, next) })
    },
  }
}
