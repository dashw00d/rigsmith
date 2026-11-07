import { expect, it, vi } from 'vitest'
import { PreviewRenderer } from './PreviewRenderer.ts'

it('cancels a queued sprite without rendering it or cancelling another request', async () => {
  const renderer = new PreviewRenderer()
  let finish!: (url: string | null) => void
  const render = vi.spyOn(renderer as unknown as { render: (url: string) => Promise<string | null> }, 'render')
    .mockImplementationOnce(async () => await new Promise(resolve => { finish = resolve }))
    .mockResolvedValue('unexpected')
  const first = renderer.sheet('/first.glb')
  const controller = new AbortController()
  const second = renderer.sheet('/second.glb', controller.signal)
  controller.abort()
  const result = await Promise.race([second, new Promise<string>(resolve => { setTimeout(() => resolve('still queued'), 50) })])
  finish('first'); await first
  expect(result).toBeNull()
  expect(render).toHaveBeenCalledTimes(1)
})
