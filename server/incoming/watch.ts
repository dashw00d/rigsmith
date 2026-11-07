import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { incomingDir, listIncoming } from './read.ts'
import { events, WORKSPACE } from '../store.ts'
let rootWatch: FSWatcher | undefined; let parentWatch: FSWatcher | undefined; let packageWatch: FSWatcher | undefined
let timer: ReturnType<typeof setTimeout> | undefined; let current = ''
let running = false; let queued = false; let generation = 0; let lastPending: number | undefined
async function changed (): Promise<void> {
  const dir = await incomingDir()
  if (dir !== current || packageWatch === undefined) {
    packageWatch?.close(); packageWatch = undefined; parentWatch?.close(); parentWatch = undefined; current = dir
    if (path.dirname(dir) !== WORKSPACE) {
      try {
        parentWatch = watch(path.dirname(dir), rootChanged); parentWatch.on('error', () => { parentWatch?.close(); parentWatch = undefined }); parentWatch.unref()
      } catch { /* parent may not exist yet */ }
    }
    try {
      packageWatch = watch(dir, { recursive: true }, packageChanged)
      packageWatch.on('error', () => { packageWatch?.close(); packageWatch = undefined }); packageWatch.unref()
    } catch { /* folder may not exist yet */ }
  }
  const pending = (await listIncoming()).pending
  if (pending !== lastPending) { lastPending = pending; events.emit('incoming', { pending }) }
}
function rootChanged (event: string, name: string | Buffer | null): void {
  if (event === 'rename' && (!name || name.toString() === path.basename(current))) { packageWatch?.close(); packageWatch = undefined }
  schedule()
}
function packageChanged (_event: string, name: string | Buffer | null): void {
  if (name && name.toString().split(/[\\/]/)[0].startsWith('.')) return
  schedule()
}
function schedule (): void {
  clearTimeout(timer)
  timer = setTimeout(() => { void run().catch(console.error) }, 100); timer.unref()
}
async function run (): Promise<void> {
  if (running) { queued = true; return }
  running = true; const started = generation
  try { do { queued = false; await changed() } while (queued && started === generation) } finally { running = false }
}
export async function startIncomingWatch (): Promise<void> {
  if (rootWatch) return
  try { rootWatch = watch(WORKSPACE, rootChanged); rootWatch.on('error', () => { rootWatch?.close(); rootWatch = undefined }); rootWatch.unref() } catch { /* workspace may not exist yet */ }
  await run()
}
export function stopIncomingWatch (): void { generation++; queued = false; rootWatch?.close(); parentWatch?.close(); packageWatch?.close(); rootWatch = undefined; parentWatch = undefined; packageWatch = undefined; current = ''; lastPending = undefined; clearTimeout(timer) }
