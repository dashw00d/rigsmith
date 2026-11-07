import type { Character, Skin } from '../model/types.ts'
import { app } from './app.svelte.ts'
import { assets } from './assets.svelte.ts'
import { viewer } from './viewer.svelte.ts'

class Bare {
  busy = $state(false)
  progress = $state(0)
  label = $state('')

  async make (c: Character, skins: readonly Skin[]): Promise<void> {
    if (this.busy || skins.length === 0) return
    const view = viewer.shownId === c.id ? viewer.character : null
    if (view === null) { app.toast('error', 'Wait for the body to load before making bare skins'); return }
    try {
      const meshes = view.bodySkinned.map(mesh => {
        const position = mesh.geometry.getAttribute('position'); const uv = mesh.geometry.getAttribute('uv')
        if (position === undefined || uv === undefined || position.itemSize !== 3 || uv.itemSize !== 2 || !(position.array instanceof Float32Array) || !(uv.array instanceof Float32Array)) throw new Error('Body needs float position and UV attributes')
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        return { positions: position.array, uv: uv.array, index: mesh.geometry.index?.array ?? null, matrix: mesh.bindMatrix.toArray(), material: material.name }
      })
      this.busy = true
      for (let i = 0; i < skins.length; i++) {
        const skin = skins[i]; this.label = skin.name; this.progress = i / skins.length
        const url = assets.asset(c, skin.file)
        if (url === null) throw new Error(`No image for ${skin.name}`)
        const png = await new Promise<Blob>((resolve, reject) => {
          const worker = new Worker(new URL('../engine/workers/bare.worker.ts', import.meta.url), { type: 'module', name: 'rigsmith-bare' })
          worker.onerror = e => { worker.terminate(); reject(new Error(e.message)) }
          worker.onmessage = (e: MessageEvent<{ progress?: number, png?: Blob, error?: string }>) => {
            if (e.data.error !== undefined) { worker.terminate(); reject(new Error(e.data.error)); return }
            if (e.data.progress !== undefined) this.progress = (i + e.data.progress) / skins.length
            if (e.data.png !== undefined) { worker.terminate(); resolve(e.data.png) }
          }
          worker.postMessage({ url, meshes, height: view.height })
        })
        const response = await fetch(`/api/characters/${encodeURIComponent(c.id)}/look/bare/${encodeURIComponent(skin.name)}`, { method: 'PUT', headers: { 'Content-Type': 'image/png', 'x-rigsmith': '1', 'x-rigsmith-schema': '5' }, body: png })
        if (!response.ok) throw new Error(`Could not save bare skin (${response.status}): ${await response.text()}`)
        const result = await response.json() as { path: string }
        if (await app.do(c.id, { type: 'look.skin.bare', name: skin.name, file: result.path }) === null) throw new Error(`Could not attach bare skin ${skin.name}`)
      }
    } catch (error) { app.toast('error', `Make bare: ${(error as Error).message}`) } finally { this.busy = false; this.label = ''; this.progress = 0 }
  }
}
export const bare = new Bare()
