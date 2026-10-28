// three.js's loaders and exporter made to run in Node, as the app runs them in the browser: importing this installs the
// shims once (GLTFLoader wants `self` and decides on createImageBitmap; GLTFExporter reads its chunks with a
// FileReader) and quiets the loader's warnings about what Node can't do (textures). Tools, dev scripts and the
// server's headless routes import it; the app never does.
import { readFileSync } from 'node:fs'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in node') }
g.FileReader ??= class {
  result: ArrayBuffer | string | null = null
  onloadend: (() => void) | null = null
  readAsArrayBuffer (blob: Blob): void { void blob.arrayBuffer().then(b => { this.result = b; this.onloadend?.() }) }
  readAsDataURL (blob: Blob): void {
    void blob.arrayBuffer().then(b => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`; this.onloadend?.() })
  }
}
const warn = console.warn
console.warn = (...a: unknown[]) => { if (!String(a[0]).includes('THREE.GLTFLoader')) warn(...a) }
// (a model's own textures don't load in node: nothing headless needs them)
const error = console.error
console.error = (...a: unknown[]) => { if (!String(a[0]).includes("THREE.GLTFLoader: Couldn't load texture")) error(...a) }

/** A GLB's bytes parsed as the app's loader parses them (textures left out). */
export async function loadGlb (data: Uint8Array): Promise<GLTF> {
  // (a copy: Node hands small files out of a shared pool, and the loader keeps the buffer)
  return await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, '')
}

export async function loadGlbFile (file: string): Promise<GLTF> {
  return await loadGlb(readFileSync(file))
}
