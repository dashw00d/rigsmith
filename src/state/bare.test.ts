import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { makeCharacter } from '../model/fixtures.ts'

const mocks = vi.hoisted(() => ({
  app: { do: vi.fn(), toast: vi.fn() },
  assets: { asset: vi.fn((_c: unknown, file: string) => `/assets/${file}`) },
  viewer: { shownId: 'body', character: null as unknown },
  sent: [] as Array<{ meshes: Array<{ index: Uint16Array | Uint32Array | null }> }>,
}))
vi.mock('./app.svelte.ts', () => ({ app: mocks.app }))
vi.mock('./assets.svelte.ts', () => ({ assets: mocks.assets }))
vi.mock('./viewer.svelte.ts', () => ({ viewer: mocks.viewer }))

class FakeWorker {
  onerror: ((e: { message: string }) => void) | null = null
  onmessage: ((e: { data: { png: Blob } }) => void) | null = null
  postMessage (request: { meshes: Array<{ index: Uint16Array | Uint32Array | null }> }): void {
    mocks.sent.push(request)
    queueMicrotask(() => this.onmessage?.({ data: { png: new Blob(['png']) } }))
  }
  terminate (): void {}
}

const c = makeCharacter({ id: 'body', look: { layers: [], skins: [
  { name: 'one', file: 'one.png' }, { name: 'two', file: 'two.png' },
] } })

beforeEach(() => {
  vi.stubGlobal('$state', <T>(v: T): T => v)
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => ({ path: `bare/${url.endsWith('one') ? 'one' : 'two'}.png` }) })))
  mocks.sent.length = 0
  mocks.app.do.mockReset().mockResolvedValue({ seq: 1 })
  mocks.app.toast.mockReset()
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2))
  geometry.setIndex([0, 1, 2])
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  mesh.userData.fullIndex = new THREE.Uint16BufferAttribute([0, 1, 2, 1, 3, 2], 1)
  mocks.viewer.character = { bodySkinned: [mesh], height: 2 }
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Make bare', () => {
  it('sends the full body index even when worn gear hides triangles', async () => {
    const { bare } = await import('./bare.svelte.ts')
    await bare.make(c, [c.look.skins![0]])
    expect([...mocks.sent[0].meshes[0].index!]).toEqual([0, 1, 2, 1, 3, 2])
  })

  it('commits all generated skins as one undoable batch', async () => {
    const { bare } = await import('./bare.svelte.ts')
    await bare.make(c, c.look.skins!)
    expect(mocks.app.do).toHaveBeenCalledTimes(1)
    expect(mocks.app.do).toHaveBeenCalledWith('body', [
      { type: 'look.skin.bare', name: 'one', file: 'bare/one.png' },
      { type: 'look.skin.bare', name: 'two', file: 'bare/two.png' },
    ], 'look.bare')
  })

  it('does not attach any generated skin if a later upload fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('two')
      ? { ok: false, status: 500, text: async () => 'failed' }
      : { ok: true, json: async () => ({ path: 'bare/one.png' }) }))
    const { bare } = await import('./bare.svelte.ts')
    await bare.make(c, c.look.skins!)
    expect(mocks.app.do).not.toHaveBeenCalled()
    expect(mocks.app.toast).toHaveBeenCalledWith('error', expect.stringContaining('Could not save bare skin'))
  })
})
