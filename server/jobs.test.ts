// @vitest-environment node
// The job queue: one 'files' job at a time per character (others alongside), exclusive keys across characters, and
// cancelling a queued job, a running one (its signal) and a spawned process group.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-jobs-'))
process.env.RIGSMITH_WORKSPACE = dir // (nothing is written; the store is imported for its events)
let jobs: typeof import('./jobs.ts')

beforeAll(async () => { jobs = await import('./jobs.ts') })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function gate (): { wait: Promise<void>, open: () => void } {
  let open = (): void => {}
  const wait = new Promise<void>(resolve => { open = resolve })
  return { wait, open }
}

describe('jobs', () => {
  it("runs one 'files' job at a time per character, 'none' jobs and other characters alongside", async () => {
    const first = gate()
    const other = gate()
    const started: string[] = []
    const a1 = jobs.enqueue('rig', 'A1', 'char-a', async () => { started.push('a1'); await first.wait })
    const a2 = jobs.enqueue('texture', 'A2', 'char-a', async () => { started.push('a2') })
    jobs.enqueue('codex', 'A3', 'char-a', async () => { started.push('a3'); await other.wait }, { lock: 'none' })
    await vi.waitFor(() => { expect(started).toEqual(['a1', 'a3']) })
    expect(a2.status).toBe('queued')
    expect(jobs.busy('char-a', 'files')).toBe(a1)
    first.open()
    await vi.waitFor(() => { expect(a2.status).toBe('done') })
    expect(started).toEqual(['a1', 'a3', 'a2'])
    other.open()
  })

  it('runs jobs sharing an exclusive key one at a time', async () => {
    const first = gate()
    const e1 = jobs.enqueue('export', 'E1', undefined, async () => { await first.wait }, { exclusive: 'game-export' })
    const e2 = jobs.enqueue('export', 'E2', undefined, async () => {}, { exclusive: 'game-export' })
    await vi.waitFor(() => { expect(e1.status).toBe('running') })
    expect(e2.status).toBe('queued')
    first.open()
    await vi.waitFor(() => { expect(e2.status).toBe('done') })
  })

  it('cancels a queued job before it starts and a running one through its signal', async () => {
    let aborted = false
    const running = jobs.enqueue('rig', 'B1', 'char-b', async (job, update, signal) => {
      await new Promise<void>((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')) }) })
    })
    const ran: string[] = []
    const queued = jobs.enqueue('texture', 'B2', 'char-b', async () => { ran.push('b2') })
    await vi.waitFor(() => { expect(running.status).toBe('running') })
    expect(jobs.cancel(queued.id)?.status).toBe('cancelled')
    jobs.cancel(running.id)
    await vi.waitFor(() => { expect(running.status).toBe('cancelled') })
    expect(aborted).toBe(true)
    expect(ran).toEqual([])
    expect(jobs.busy('char-b')).toBeUndefined()
    expect(jobs.cancel(running.id)).toBeNull()
  })

  it('kills a spawned process group when the signal aborts', async () => {
    const controller = new AbortController()
    const child = jobs.spawnJob('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' }, controller.signal)
    const closed = new Promise<NodeJS.Signals | null>(resolve => { child.on('close', (code, signal) => { resolve(signal) }) })
    controller.abort()
    expect(await closed).not.toBeNull()
  })
})
