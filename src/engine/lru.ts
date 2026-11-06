// The one cache every client cache is (docs/dressing-plan.md Phase 0): least recently used first out, held to a byte
// budget (and a count), whatever falls out disposed (three.js geometry and textures: their GPU memory). Keys are
// content-addressed URLs (src/engine/assetUrls.ts), so nothing is ever stale in it and nothing has to be forgotten by
// hand: a file that changed is a new key, the old one ages out. Disposing what is still drawn is safe in three.js (it
// is uploaded again on its next draw), so the budget is a bound on memory, not a lifetime.
import * as THREE from 'three'

export interface LruOptions<V> {
  /** Bytes it may hold (entries of unknown size count 0). */
  budget: number
  /** Entries it may hold at most. */
  max?: number
  /** A value's bytes (once it is in, a loaded one once it has loaded). */
  size?: (value: V) => number
  /** Called on a value that falls out or is deleted. */
  dispose?: (value: V) => void
}

interface Entry<V> { promise: Promise<V>, value?: V, loaded: boolean, bytes: number }

export class Lru<V> {
  private readonly entries = new Map<string, Entry<V>>()
  private readonly o: LruOptions<V>
  private held = 0

  constructor (o: LruOptions<V>) { this.o = o }

  /** Bytes held now. */
  get bytes (): number { return this.held }
  get size (): number { return this.entries.size }

  has (key: string): boolean { return this.entries.has(key) }

  /** The value if it is in and loaded (made the most recent). */
  get (key: string): V | undefined {
    const e = this.touch(key)
    return e?.loaded === true ? e.value : undefined
  }

  /** The value, loaded once by `make` (the same promise to every caller meanwhile); a failed load isn't kept. */
  async load (key: string, make: () => Promise<V>): Promise<V> {
    const had = this.touch(key)
    if (had !== undefined) return await had.promise
    const entry: Entry<V> = { promise: undefined as unknown as Promise<V>, loaded: false, bytes: 0 }
    entry.promise = make().then(value => {
      if (this.entries.get(key) !== entry) {
        // (deleted while it loaded: nobody keeps it, but the callers waiting get it)
        return value
      }
      entry.value = value
      entry.loaded = true
      entry.bytes = this.o.size?.(value) ?? 0
      this.held += entry.bytes
      this.trim(key)
      return value
    }, (error: unknown) => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    })
    this.entries.set(key, entry)
    this.trim(key)
    return await entry.promise
  }

  /** Put a value in (replacing and disposing one under the key, unless it is the same). */
  set (key: string, value: V): void {
    const was = this.entries.get(key)
    if (was !== undefined) {
      this.entries.delete(key)
      this.held -= was.bytes
      if (was.loaded && was.value !== value) this.o.dispose?.(was.value as V)
    }
    const bytes = this.o.size?.(value) ?? 0
    this.entries.set(key, { promise: Promise.resolve(value), value, loaded: true, bytes })
    this.held += bytes
    this.trim(key)
  }

  /** Take an entry out (disposed once loaded). */
  delete (key: string): void {
    const e = this.entries.get(key)
    if (e === undefined) return
    this.entries.delete(key)
    this.held -= e.bytes
    if (e.loaded) this.o.dispose?.(e.value as V)
  }

  /** Take out every entry whose key `drop` says (disposed). */
  deleteWhere (drop: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (drop(key)) this.delete(key)
  }

  clear (): void {
    for (const key of [...this.entries.keys()]) this.delete(key)
  }

  keys (): string[] { return [...this.entries.keys()] }

  private touch (key: string): Entry<V> | undefined {
    const e = this.entries.get(key)
    if (e === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, e)
    return e
  }

  /** The oldest loaded entries out until it is within its budget and count (never `keep`, the one just used, nor one
   * still loading). */
  private trim (keep: string): void {
    const max = this.o.max ?? Infinity
    if (this.held <= this.o.budget && this.entries.size <= max) return
    for (const [key, e] of this.entries) {
      if (this.held <= this.o.budget && this.entries.size <= max) break
      if (key === keep || !e.loaded) continue
      this.delete(key)
    }
  }
}

// ---- three.js sizes and disposal ---------------------------------------------------------------------------------

/** A texture's bytes on the GPU, about: four bytes a pixel, a third more with mipmaps. */
export function textureBytes (t: THREE.Texture): number {
  const image = t.image as { width?: number, height?: number } | null | undefined
  const w = image?.width ?? 0
  const h = image?.height ?? 0
  return Math.round(w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1))
}

export function geometryBytes (g: THREE.BufferGeometry): number {
  let n = g.index?.array.byteLength ?? 0
  for (const a of Object.values(g.attributes)) n += (a as THREE.BufferAttribute).array?.byteLength ?? 0
  for (const list of Object.values(g.morphAttributes)) for (const a of list) n += (a as THREE.BufferAttribute).array?.byteLength ?? 0
  return n
}

function materialsOf (o: THREE.Object3D): THREE.Material[] {
  const m = (o as THREE.Mesh).material
  return m === undefined ? [] : Array.isArray(m) ? m : [m]
}

function texturesOf (m: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = []
  for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture === true) out.push(v as THREE.Texture)
  return out
}

/** A loaded scene's bytes: its geometry and its textures, each counted once. */
export function objectBytes (root: THREE.Object3D): number {
  const geometries = new Set<THREE.BufferGeometry>()
  const textures = new Set<THREE.Texture>()
  root.traverse(o => {
    const g = (o as THREE.Mesh).geometry
    if (g !== undefined) geometries.add(g)
    for (const m of materialsOf(o)) for (const t of texturesOf(m)) textures.add(t)
  })
  let n = 0
  for (const g of geometries) n += geometryBytes(g)
  for (const t of textures) n += textureBytes(t)
  return n
}

/** A loaded scene's geometry, materials and textures disposed (each once). */
export function disposeObject (root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  root.traverse(o => {
    const g = (o as THREE.Mesh).geometry
    if (g !== undefined) geometries.add(g)
    for (const m of materialsOf(o)) {
      materials.add(m)
      for (const t of texturesOf(m)) textures.add(t)
    }
  })
  for (const g of geometries) g.dispose()
  // (a texture's image is left to the garbage collector, not closed: a copy still drawn uploads it again from it)
  for (const t of textures) t.dispose()
  for (const m of materials) m.dispose()
}

/** Megabytes, for budgets. */
export const MB = 1 << 20
