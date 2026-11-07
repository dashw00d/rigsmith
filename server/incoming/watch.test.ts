// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ callbacks: [] as Array<(event: string, name: string) => void>, calls: 0, active: 0, max: 0, pending: 1, releases: [] as Array<() => void> }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, watch: (_path: string, ...args: unknown[]) => {
    const callback = args.at(-1) as (event: string, name: string) => void
    mock.callbacks.push(callback)
    return Object.assign(new EventEmitter(), { close: () => {}, unref: () => {} })
  } }
})
vi.mock('../store.ts', () => ({ WORKSPACE: '/workspace', events: new EventEmitter() }))
vi.mock('./read.ts', () => ({ incomingDir: async () => '/workspace/incoming', listIncoming: async () => {
  mock.calls++; mock.active++; mock.max = Math.max(mock.max, mock.active)
  await new Promise<void>(resolve => { mock.releases.push(resolve) })
  mock.active--; return { pending: mock.pending, packages: [] }
} }))
const { startIncomingWatch, stopIncomingWatch } = await import('./watch.ts')
const { events } = await import('../store.ts')
afterEach(() => { stopIncomingWatch(); vi.useRealTimers() })
it('ignores partial writes and serializes bursts, emitting only changed counts', async () => {
  vi.useFakeTimers()
  const messages: number[] = []
  events.on('incoming', ({ pending }: { pending: number }) => { messages.push(pending) })
  const started = startIncomingWatch()
  await vi.waitFor(() => expect(mock.releases.length).toBe(1))
  mock.releases.shift()!(); await started
  const packageEvent = mock.callbacks.at(-1)!
  packageEvent('change', '.writing.partial/part.glb')
  await vi.advanceTimersByTimeAsync(150)
  expect(mock.calls).toBe(1)
  packageEvent('change', 'published/file.glb')
  await vi.advanceTimersByTimeAsync(150)
  expect(mock.calls).toBe(2)
  packageEvent('change', 'published/file.glb')
  await vi.advanceTimersByTimeAsync(150)
  expect(mock.max).toBe(1)
  mock.pending = 2; mock.releases.shift()!()
  await vi.waitFor(() => expect(mock.releases.length).toBe(1))
  mock.releases.shift()!()
  await vi.waitFor(() => expect(mock.active).toBe(0))
  expect(mock.calls).toBe(3)
  expect(messages).toEqual([1, 2])
  mock.pending = 1
  events.emit('character', { entry: { what: 'undo' } })
  await vi.advanceTimersByTimeAsync(150)
  expect(mock.calls).toBe(4)
  mock.releases.shift()!()
  await vi.waitFor(() => expect(mock.active).toBe(0))
  expect(messages).toEqual([1, 2, 1])
})
