import { watch, type FSWatcher } from 'node:fs'
import { incomingDir, listIncoming } from './read.ts'
import { events, WORKSPACE } from '../store.ts'
let rootWatch: FSWatcher | undefined; let packageWatch: FSWatcher | undefined
let timer: ReturnType<typeof setTimeout> | undefined; let current = ''
async function changed (): Promise<void> {
  const dir = await incomingDir()
  if (dir !== current || packageWatch === undefined) {
    packageWatch?.close(); packageWatch = undefined; current = dir
    try { packageWatch = watch(dir, { recursive: true }, schedule); packageWatch.on('error', () => { packageWatch?.close(); packageWatch = undefined }); packageWatch.unref() } catch { /* folder may not exist yet */ }
  }
  events.emit('incoming', { pending: (await listIncoming()).pending })
}
function schedule (): void { clearTimeout(timer); timer = setTimeout(() => { void changed().catch(console.error) }, 100); timer.unref() }
export async function startIncomingWatch (): Promise<void> {
  if (rootWatch) return
  try { rootWatch = watch(WORKSPACE, schedule); rootWatch.unref() } catch { /* workspace may not exist yet */ }
  await changed()
}
export function stopIncomingWatch (): void { rootWatch?.close(); packageWatch?.close(); rootWatch = undefined; packageWatch = undefined; current = ''; clearTimeout(timer) }
