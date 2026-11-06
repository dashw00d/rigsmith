// Vite plugin: mounts the API on the dev and preview servers, so `npm run dev` is the whole app. At start it reads
// every character (migrating v1 files), sets aside gear folders nothing uses, picks up work a restart cut off and
// starts following the workspace's files (server/files.ts). In dev, a change to the app's state, kernel or model
// reloads the page whole: those modules hold singletons with hooks registered on each other (the gear on the viewer,
// the animator on the viewer), which a hot update would leave registered twice. Components keep hot updates.
import type { Plugin } from 'vite'
import { handle, resumeInterrupted } from './api.ts'
import { onRecordChanged, startFiles, written } from './files.ts'
import { adopt, ensureWorkspace, onWritten, sweepOrphanGarments } from './store.ts'

async function start (): Promise<void> {
  await ensureWorkspace()
  onWritten(written)
  onRecordChanged(adopt)
  await startFiles()
  try {
    const moved = await sweepOrphanGarments()
    if (moved > 0) console.log(`rigsmith: ${moved} unused gear folder${moved === 1 ? '' : 's'} moved to workspace/trash`)
  } catch (error) {
    console.error('rigsmith: the gear folder sweep failed:', error)
  }
  await resumeInterrupted()
}

/** Whether a changed file is one of the modules a hot update can't swap safely (src/state, src/engine, src/model). */
export function reloadsWhole (file: string): boolean {
  return /[\\/]src[\\/](state|engine|model)[\\/]/.test(file)
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
    handleHotUpdate (ctx) {
      if (!reloadsWhole(ctx.file)) return
      ctx.server.ws.send({ type: 'full-reload', path: '*' })
      return []
    },
  }
}
