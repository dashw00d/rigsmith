// What the tools share to read Rigsmith's files in node as the app reads them in the browser: three's loaders made to
// run headless, the workspace, a character and its body (src/engine/CharacterView.ts, as the viewer holds it), a clip
// by its library id or bundled url.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import type { Character } from '../../server/workspace.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in node') }
// GLTFExporter reads its binary chunks with a FileReader.
g.FileReader ??= class {
  result: ArrayBuffer | string | null = null
  onloadend: (() => void) | null = null
  readAsArrayBuffer (blob: Blob): void { void blob.arrayBuffer().then(b => { this.result = b; this.onloadend?.() }) }
  readAsDataURL (blob: Blob): void {
    void blob.arrayBuffer().then(b => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`; this.onloadend?.() })
  }
}
const quiet = console.warn
console.warn = (...a: unknown[]) => { if (!String(a[0]).includes('THREE.GLTFLoader')) quiet(...a) }
// (a character's own textures don't load in node: nothing here needs them)
const loud = console.error
console.error = (...a: unknown[]) => { if (!String(a[0]).includes("THREE.GLTFLoader: Couldn't load texture")) loud(...a) }

export const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const WORKSPACE = path.join(ROOT, 'workspace')

export const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

export async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r as never) }, reject)
  })
}

export /** Where an entry's clip comes from: a converted library clip, or one bundled with the app (url /animations/<file>#<name>). */
async function entrySource (entry: { clipId: string, url?: string }): Promise<{ scene: THREE.Group, clip: THREE.AnimationClip }> {
  if (entry.url !== undefined) {
    const [file, hash] = entry.url.split('#')
    if (!file.startsWith('/animations/')) throw new Error(`clip ${entry.clipId}: ${entry.url} is not a clip bundled with Rigsmith`)
    const src = await load(path.join(ROOT, 'static', file))
    const name = hash === undefined ? undefined : decodeURIComponent(hash)
    const clip = name === undefined ? src.animations[0] : src.animations.find(a => a.name === name)
    if (clip === undefined) throw new Error(`clip ${entry.clipId}: no ${name} in ${file}`)
    return { scene: src.scene, clip }
  }
  const file = path.join(WORKSPACE, 'library', 'clips', `${entry.clipId}.glb`)
  if (!existsSync(file)) throw new Error(`clip ${entry.clipId}: not in the library`)
  const src = await load(file)
  return { scene: src.scene, clip: src.animations[0] }
}

/** A character's record (workspace/characters/<id>/character.json). */
export function character (id: string): Character {
  const file = path.join(WORKSPACE, 'characters', id, 'character.json')
  if (!existsSync(file)) throw new Error(`no character ${id}`)
  return JSON.parse(readFileSync(file, 'utf8')) as Character
}

/** A character's rigged body, as the viewer holds it. */
export async function body (id: string): Promise<CharacterView> {
  const c = character(id)
  const { scene } = await load(path.join(WORKSPACE, 'characters', id, c.files.rigged ?? 'rigged.glb'))
  return new CharacterView(scene)
}
