// The derive worker (./derive.ts asks it): a skin piece's weights and what it covers of the body worked out off the
// main thread, by the same code the game export runs (./fit.ts). It keeps the last few bodies it was sent, each with
// its grid; a body it no longer has is asked for again.
import { coverVertices, gridOf, regionHits, skinWeights, type BodyCore, type TriangleGrid } from './fit.ts'
import type { DeriveReply, DeriveRequest } from './derive.ts'

const BODIES = 4
const bodies = new Map<string, { core: BodyCore, grid: TriangleGrid | null }>()

interface Scope { postMessage: (m: unknown, transfer?: Transferable[]) => void, onmessage: ((e: MessageEvent<DeriveRequest>) => void) | null }
const scope = self as unknown as Scope

scope.onmessage = (e) => {
  const m = e.data
  if (m.type === 'body') {
    bodies.delete(m.key)
    bodies.set(m.key, { core: m.core, grid: null })
    while (bodies.size > BODIES) bodies.delete(bodies.keys().next().value!)
    return
  }
  const body = bodies.get(m.body)
  if (body === undefined) { reply({ id: m.id, needBody: true }); return }
  // (the most recent last: let go last)
  bodies.delete(m.body); bodies.set(m.body, body)
  try {
    const weights = m.policy === null ? null : m.meshes.map(mesh => skinWeights(body.core, body.grid ??= gridOf(body.core), mesh, m.policy!))
    const hits = m.cover ? regionHits(body.core.regionOf, body.core.regionVertices.length, coverVertices(body.core, m.meshes)) : null
    const transfer: Transferable[] = []
    for (const w of weights ?? []) transfer.push(w.indices.buffer, w.weights.buffer)
    if (hits !== null) transfer.push(hits.buffer)
    reply({ id: m.id, weights, hits }, transfer)
  } catch (error) {
    reply({ id: m.id, error: error instanceof Error ? error.message : String(error) })
  }
}

function reply (r: DeriveReply, transfer: Transferable[] = []): void {
  scope.postMessage(r, transfer)
}
