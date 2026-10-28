// One WebGL context for every picture made away from the viewport (list thumbnails, library card sprites): a browser
// keeps only a handful of contexts alive, and each holds its own copies of textures and shaders. Its users take turns
// (offscreen() runs one at a time), so one never resizes or draws over another's picture.
import * as THREE from 'three'
import { tone } from './lighting.ts'

let renderer: THREE.WebGLRenderer | null = null
let turn: Promise<unknown> = Promise.resolve()

function shared (): THREE.WebGLRenderer {
  if (renderer === null) {
    // (its pictures are read back after drawing, so its buffer is kept)
    renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true })
    tone(renderer)
  }
  return renderer
}

/** Run `fn` with the shared renderer at `width` × `height`, after everyone who asked before. Read the picture back
 * (drawImage of renderer.domElement) inside `fn`: the next user draws over it. */
export async function offscreen<T> (width: number, height: number, fn: (renderer: THREE.WebGLRenderer) => T | Promise<T>): Promise<T> {
  const run = turn.then(async () => {
    const r = shared()
    r.setSize(width, height, false)
    return await fn(r)
  })
  // (one user's failure is its own: the next still runs)
  turn = run.catch(() => {})
  return await run
}

/** A copy of what the renderer drew last, on a 2D canvas of its own (to encode after the turn is over). */
export function grab (renderer: THREE.WebGLRenderer): HTMLCanvasElement {
  const from = renderer.domElement
  const canvas = document.createElement('canvas')
  canvas.width = from.width
  canvas.height = from.height
  canvas.getContext('2d')!.drawImage(from, 0, 0)
  return canvas
}

/** A canvas as an image file. */
export async function encode (canvas: HTMLCanvasElement, type = 'image/webp', quality = 0.9): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    canvas.toBlob(blob => { if (blob === null) reject(new Error('The picture could not be encoded')); else resolve(blob) }, type, quality)
  })
}
