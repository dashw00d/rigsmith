// A skin piece's derived data (docs/dressing-plan.md Phase 0 §4): its weights from the body under it and how much of
// each body region it covers, by content. Named for what it is made from (derivedName: the piece's meshes as placed,
// the body, the policy, the algorithm's version), so it is never stale and never has to be forgotten: found in this
// page's memory, else in the character's folder (a DerivedStore: garments/<gid>/derived/<name>.bin on the server),
// else worked out in a worker (./derive.worker.ts, the same code as the game export: ./fit.ts) and stored. The main
// thread never runs the fitting for a piece in a browser; where there are no workers (Node: the tools, the tests) it
// runs here, inline.
import type { SkinPolicy } from '../../model/types.ts'
import { Lru, MB } from '../lru.ts'
import { mark } from '../perf.ts'
import { ALGO, coverVertices, gridOf, meshesKey, regionHits, skinWeights, type BodyCore, type MeshCore, type TriangleGrid } from './fit.ts'

/** Where a character keeps a piece's derived files (by name). */
export interface DerivedStore {
  get: (name: string) => Promise<ArrayBuffer | null>
  put: (name: string, data: ArrayBuffer) => Promise<void>
}

export interface PieceWeights { indices: Uint16Array, weights: Float32Array }
/** Per mesh (the model's order) its weights; per body region how many of its vertices the piece covers (null: not
 * worked out: the piece doesn't hide the body). */
export interface Derived { weights: PieceWeights[], hits: Int32Array | null }

/** A body as the fitting reads it, and its identity (fit.ts bodyKey). */
export interface DeriveBody { core: BodyCore, key: string }

export type DeriveRequest =
  | { type: 'body', key: string, core: BodyCore }
  | { type: 'derive', id: number, body: string, policy: SkinPolicy | null, cover: boolean, meshes: MeshCore[] }
export interface DeriveReply { id: number, weights?: PieceWeights[] | null, hits?: Int32Array | null, needBody?: true, error?: string }

/** The file a piece's derived data is kept in: `<meshes>-<body>-<policy>-v<algo>.bin`. */
export const derivedName = (meshes: string, body: string, policy: SkinPolicy): string => `${meshes}-${body}-${policy}-v${ALGO}.bin`
export const DERIVED_NAME = /^[0-9a-f]{16}-[0-9a-f]{16}-[a-z]+-v\d+\.bin$/

// ---- the file -------------------------------------------------------------------------------------------------

const MAGIC = 0x31445352 // 'RSD1'

/** u32 magic, algo, meshes, regions (0: no coverage), then each mesh's vertex count; each mesh's indices (u16, 4 per
 * vertex) and weights (f32, 4 per vertex); the region counts (i32). Little-endian, every part 4-byte aligned. */
export function encodeDerived (d: Derived): ArrayBuffer {
  const m = d.weights.length
  const regions = d.hits?.length ?? 0
  const header = 4 + m
  let bytes = header * 4
  for (const w of d.weights) bytes += w.indices.byteLength + w.weights.byteLength
  bytes += regions * 4
  const out = new ArrayBuffer(bytes)
  const head = new Uint32Array(out, 0, header)
  head.set([MAGIC, ALGO, m, regions])
  for (const [i, w] of d.weights.entries()) head[4 + i] = w.indices.length / 4
  let at = header * 4
  for (const w of d.weights) {
    new Uint16Array(out, at, w.indices.length).set(w.indices); at += w.indices.byteLength
    new Float32Array(out, at, w.weights.length).set(w.weights); at += w.weights.byteLength
  }
  if (d.hits !== null) new Int32Array(out, at, regions).set(d.hits)
  return out
}

/** A derived file read back, if it is one for meshes of these vertex counts and a body of `regions` regions. */
export function decodeDerived (buf: ArrayBuffer, counts: readonly number[], regions: number): Derived | null {
  if (buf.byteLength < 16 || buf.byteLength % 4 !== 0) return null
  const head = new Uint32Array(buf, 0, 4)
  if (head[0] !== MAGIC || head[1] !== ALGO || head[2] !== counts.length || (head[3] !== 0 && head[3] !== regions)) return null
  const header = 4 + counts.length
  if (buf.byteLength < header * 4) return null
  const own = new Uint32Array(buf, 16, counts.length)
  let expected = header * 4 + head[3] * 4
  for (const [i, n] of counts.entries()) { if (own[i] !== n) return null; expected += n * 4 * 2 + n * 4 * 4 }
  if (buf.byteLength !== expected) return null
  let at = header * 4
  const weights: PieceWeights[] = counts.map(n => {
    const indices = new Uint16Array(buf.slice(at, at + n * 8)); at += n * 8
    const w = new Float32Array(buf.slice(at, at + n * 16)); at += n * 16
    return { indices, weights: w }
  })
  return { weights, hits: head[3] === 0 ? null : new Int32Array(buf.slice(at, at + head[3] * 4)) }
}

// ---- workers --------------------------------------------------------------------------------------------------

interface Slot { worker: Worker, bodies: string[], busy: number }
const BODIES = 4
let pool: Slot[] | null | undefined
let ids = 0
const waiting = new Map<number, { resolve: (r: DeriveReply) => void }>()

function workers (): Slot[] | null {
  if (pool !== undefined) return pool
  pool = null
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return pool
  const n = Math.max(1, Math.min(2, (navigator.hardwareConcurrency ?? 2) - 1))
  try {
    pool = Array.from({ length: n }, () => {
      const worker = new Worker(new URL('./derive.worker.ts', import.meta.url), { type: 'module', name: 'rigsmith-derive' })
      worker.onmessage = (e: MessageEvent<DeriveReply>) => { const w = waiting.get(e.data.id); waiting.delete(e.data.id); w?.resolve(e.data) }
      worker.onerror = (e) => { console.error('derive worker:', e.message) }
      return { worker, bodies: [], busy: 0 }
    })
  } catch (error) {
    console.warn('derive: no workers, fitting on the main thread', error)
    pool = null
  }
  return pool
}

async function ask (slot: Slot, body: DeriveBody, policy: SkinPolicy | null, cover: boolean, meshes: MeshCore[]): Promise<DeriveReply> {
  const send = (): Promise<DeriveReply> => {
    if (!slot.bodies.includes(body.key)) {
      // (a copy: the page keeps its body)
      slot.worker.postMessage({ type: 'body', key: body.key, core: body.core } satisfies DeriveRequest)
      slot.bodies.push(body.key)
      while (slot.bodies.length > BODIES) slot.bodies.shift()
    } else {
      slot.bodies.splice(slot.bodies.indexOf(body.key), 1)
      slot.bodies.push(body.key)
    }
    const id = ++ids
    // (copies of the piece's arrays, handed over)
    const own = meshes.map(m => ({ positions: m.positions.slice(), index: m.index === null ? null : m.index.slice() }))
    const transfer: Transferable[] = own.flatMap(m => (m.index === null ? [m.positions.buffer] : [m.positions.buffer, m.index.buffer]))
    return new Promise(resolve => {
      waiting.set(id, { resolve })
      slot.worker.postMessage({ type: 'derive', id, body: body.key, policy, cover, meshes: own } satisfies DeriveRequest, transfer)
    })
  }
  slot.busy++
  try {
    let r = await send()
    if (r.needBody === true) { slot.bodies = slot.bodies.filter(k => k !== body.key); r = await send() }
    return r
  } finally {
    slot.busy--
  }
}

const grids = new WeakMap<BodyCore, TriangleGrid>()
function inline (body: DeriveBody, policy: SkinPolicy | null, cover: boolean, meshes: MeshCore[]): Derived {
  let grid = grids.get(body.core)
  const weights = policy === null ? [] : meshes.map(m => {
    if (grid === undefined) { grid = gridOf(body.core); grids.set(body.core, grid) }
    return skinWeights(body.core, grid, m, policy)
  })
  const hits = cover ? regionHits(body.core.regionOf, body.core.regionVertices.length, coverVertices(body.core, meshes)) : null
  return { weights, hits }
}

/** Worked out now: in a worker (the least busy), else inline. */
async function compute (body: DeriveBody, policy: SkinPolicy | null, cover: boolean, meshes: MeshCore[], label?: string): Promise<Derived> {
  const slots = workers()
  if (slots === null || slots.length === 0) return inline(body, policy, cover, meshes)
  const slot = slots.reduce((a, b) => (b.busy < a.busy ? b : a))
  const done = mark('derive.worker', label)
  try {
    const r = await ask(slot, body, policy, cover, meshes)
    if (r.error !== undefined) throw new Error(r.error)
    return { weights: r.weights ?? [], hits: r.hits ?? null }
  } finally {
    done()
  }
}

// ---- deriving ---------------------------------------------------------------------------------------------------

/** What was derived, by file name (the page's own copy: re-wearing a piece needs no fetch). */
const memory = new Lru<Derived>({
  budget: 256 * MB, max: 2000,
  size: d => d.weights.reduce((t, w) => t + w.indices.byteLength + w.weights.byteLength, 0) + (d.hits?.byteLength ?? 0),
})
const pending = new Map<string, Promise<Derived>>()

/** Copies the caller owns (painted weights are laid over them in place). */
const handOut = (d: Derived): Derived => ({ weights: d.weights.map(w => ({ indices: w.indices.slice(), weights: w.weights.slice() })), hits: d.hits })

/** A skin piece's weights (per mesh) and, with `cover`, its per-region coverage of the body, from wherever it is
 * already known (this page, the store) or worked out off the main thread and stored. */
export async function derive (body: DeriveBody, meshes: MeshCore[], o: { policy: SkinPolicy, cover: boolean, store?: DerivedStore, label?: string }): Promise<Derived> {
  const name = derivedName(meshesKey(meshes), body.key, o.policy)
  const enough = (d: Derived | undefined): d is Derived => d !== undefined && (!o.cover || d.hits !== null)
  const known = memory.get(name)
  if (enough(known)) return handOut(known)
  const key = `${name}|${o.cover ? 1 : 0}`
  let p = pending.get(key)
  if (p === undefined) {
    p = (async (): Promise<Derived> => {
      const counts = meshes.map(m => m.positions.length / 3)
      const regions = body.core.regionVertices.length
      let have = memory.get(name) ?? null
      if (have === null && o.store !== undefined) {
        const done = mark('derive.read', o.label)
        const bytes = await o.store.get(name).catch(() => null)
        have = bytes === null ? null : decodeDerived(bytes, counts, regions)
        done()
      }
      if (enough(have ?? undefined)) { memory.set(name, have!); return have! }
      // (weights known, the coverage not yet: only that worked out)
      const made = have !== null
        ? { weights: have.weights, hits: (await compute(body, null, true, meshes, o.label)).hits }
        : await compute(body, o.policy, o.cover, meshes, o.label)
      memory.set(name, made)
      if (o.store !== undefined) void o.store.put(name, encodeDerived(made)).catch((error: unknown) => { console.warn(`derive: ${name} not stored`, error) })
      return made
    })()
    pending.set(key, p)
    void p.finally(() => { if (pending.get(key) === p) pending.delete(key) }).catch(() => {})
  }
  return handOut(await p)
}
