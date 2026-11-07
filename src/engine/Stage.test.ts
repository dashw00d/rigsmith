import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ env: vi.fn(), size: vi.fn(), loop: vi.fn(), dispose: vi.fn() }))
vi.mock('three', async importOriginal => {
  const three = await importOriginal<typeof import('three')>()
  return { ...three, WebGLRenderer: class {
    domElement = document.createElement('canvas')
    shadowMap = { enabled: false, type: 0 }
    setPixelRatio (): void {}
    setSize (...args: unknown[]): void { calls.size(...args) }
    setAnimationLoop (...args: unknown[]): void { calls.loop(...args) }
    dispose (): void { calls.dispose() }
  } }
})
vi.mock('three/addons/controls/OrbitControls.js', () => ({ OrbitControls: class {
  target = { set: () => {} }
  addEventListener (): void {}
  dispose (): void {}
} }))
vi.mock('./lighting.ts', async () => {
  const { Texture } = await import('three')
  const texture = new Texture()
  return { LIGHTING: { environment: 0.55 }, environment: () => { calls.env(); return texture }, light: () => ({}), tone: () => {}, place: () => {} }
})
class Observer { observe (): void {}; disconnect (): void {} }

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('ResizeObserver', Observer)
  calls.env.mockReset(); calls.size.mockReset(); calls.loop.mockReset(); calls.dispose.mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('waits for environment and canvas allocation before the stage is ready', async () => {
  const { Stage } = await import('./Stage.ts')
  const container = document.createElement('div')
  Object.defineProperties(container, { clientWidth: { value: 640 }, clientHeight: { value: 480 } })
  const stage = new Stage(container)
  expect(stage.scene.environment).toBeNull()
  expect(calls.size).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls.env).toHaveBeenCalledOnce()
  expect(stage.scene.environment).not.toBeNull()
  expect(calls.size).not.toHaveBeenCalled()
  await vi.runAllTimersAsync(); await stage.ready
  expect(calls.size).toHaveBeenCalledOnce()
  expect(calls.loop).toHaveBeenCalledOnce()
  stage.dispose()
})

it('stops deferred initialization if the stage is disposed first', async () => {
  const { Stage } = await import('./Stage.ts')
  const stage = new Stage(document.createElement('div'))
  stage.dispose()
  await vi.runAllTimersAsync(); await stage.ready
  expect(calls.env).not.toHaveBeenCalled()
  expect(calls.size).not.toHaveBeenCalled()
  expect(calls.dispose).toHaveBeenCalledOnce()
})
