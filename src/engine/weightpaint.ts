// Weight painting on a posed body (the Rig step's "Fix weights"). Vertices split at UV seams are one point here (they
// always get the same weights, so a seam never tears). Brushes work on the body as it stands now (a clip paused on the
// frame that shows the problem):
//   area    mark the problem skin; "Heal" then refills its weights smoothly from the good skin round it (each point
//           the mean of its neighbours, the skin round the area held): skin pulled by a wrong bone goes with what
//           surrounds it
//   add / remove / smooth   a chosen bone's weight under the brush, by hand
// At most four bones a vertex, normalized. Edits are kept by vertex and bone name, to save and to re-apply after a
// re-rig (the source mesh, and so its vertex order, stays).
import * as THREE from 'three'

export type Weights = Map<number, number>   // bone index -> weight

interface Part {
  mesh: THREE.SkinnedMesh
  /** vertex -> its point (the first vertex at that position) */
  point: Int32Array
  /** point -> its vertices */
  members: Map<number, number[]>
  /** point -> neighbouring points */
  adj: Map<number, Set<number>>
  rest: Float32Array
}

export interface Edit { mesh: number, vertex: number, weights: Array<[string, number]> }

export class WeightPainter {
  readonly parts: Part[] = []
  /** The area marked (point -> 0..1), per part. */
  readonly area: Array<Map<number, number>> = []
  /** Points changed since the last save, per part. */
  readonly edited: Array<Set<number>> = []
  private undo: Array<Array<{ part: number, point: number, weights: Weights }>> = []

  constructor (meshes: THREE.SkinnedMesh[]) {
    for (const mesh of meshes) {
      const g = mesh.geometry
      const pos = g.attributes.position
      const point = new Int32Array(pos.count)
      const key = new Map<string, number>()
      const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute)
      const tol = 1e-5 * Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6)
      for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(pos.getX(i) / tol)},${Math.round(pos.getY(i) / tol)},${Math.round(pos.getZ(i) / tol)}`
        const at = key.get(k)
        if (at === undefined) { key.set(k, i); point[i] = i } else point[i] = at
      }
      const members = new Map<number, number[]>()
      for (let i = 0; i < pos.count; i++) (members.get(point[i]) ?? members.set(point[i], []).get(point[i])!).push(i)
      const adj = new Map<number, Set<number>>()
      const link = (a: number, b: number): void => {
        const pa = point[a]; const pb = point[b]
        if (pa === pb) return
        ;(adj.get(pa) ?? adj.set(pa, new Set()).get(pa)!).add(pb)
        ;(adj.get(pb) ?? adj.set(pb, new Set()).get(pb)!).add(pa)
      }
      const index = g.index
      const tri = index !== null ? index.count : pos.count
      for (let t = 0; t < tri; t += 3) {
        const a = index !== null ? index.getX(t) : t; const b = index !== null ? index.getX(t + 1) : t + 1; const c = index !== null ? index.getX(t + 2) : t + 2
        link(a, b); link(b, c); link(c, a)
      }
      this.parts.push({ mesh, point, members, adj, rest: Float32Array.from(pos.array as ArrayLike<number>) })
      this.area.push(new Map())
      this.edited.push(new Set())
    }
  }

  get editedCount (): number { return this.edited.reduce((n, s) => n + s.size, 0) }

  weights (part: number, p: number): Weights {
    const g = this.parts[part].mesh.geometry
    const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight
    const w: Weights = new Map()
    for (let k = 0; k < 4; k++) {
      const x = sw.getComponent(p, k)
      if (x > 0) w.set(si.getComponent(p, k), (w.get(si.getComponent(p, k)) ?? 0) + x)
    }
    return w
  }

  /** A point's weights set (on all its vertices): the four largest, summing to one. */
  private set (part: number, p: number, w: Weights, log: Array<{ part: number, point: number, weights: Weights }> | null): void {
    const g = this.parts[part].mesh.geometry
    const si = g.attributes.skinIndex as THREE.BufferAttribute; const sw = g.attributes.skinWeight as THREE.BufferAttribute
    if (log !== null) log.push({ part, point: p, weights: this.weights(part, p) })
    const top = [...w.entries()].filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = top.reduce((t, [, x]) => t + x, 0)
    if (total <= 0) return
    for (const v of this.parts[part].members.get(p) ?? [p]) {
      for (let k = 0; k < 4; k++) {
        si.setComponent(v, k, top[k]?.[0] ?? 0)
        sw.setComponent(v, k, (top[k]?.[1] ?? 0) / total)
      }
    }
    si.needsUpdate = true; sw.needsUpdate = true
    this.edited[part].add(p)
  }

  /** Where each point of a part is now (the body as it stands, in world space). */
  private posed (part: number): Map<number, THREE.Vector3> {
    const { mesh, members } = this.parts[part]
    mesh.updateMatrixWorld(true)
    const out = new Map<number, THREE.Vector3>()
    const v = new THREE.Vector3()
    for (const p of members.keys()) {
      mesh.getVertexPosition(p, v)
      out.set(p, v.clone().applyMatrix4(mesh.matrixWorld))
    }
    return out
  }

  /** The points under a brush at `at` (world), within `radius`, with their falloff (1 at the middle, 0 at the edge). */
  under (part: number, at: THREE.Vector3, radius: number): Map<number, number> {
    const out = new Map<number, number>()
    for (const [p, x] of this.posed(part)) {
      const d = x.distanceTo(at)
      if (d < radius) { const t = 1 - d / radius; out.set(p, t * t * (3 - 2 * t)) }
    }
    return out
  }

  /** A stroke begins (one undo step). */
  begin (): void { this.undo.push([]) }
  private get log (): Array<{ part: number, point: number, weights: Weights }> | null { return this.undo[this.undo.length - 1] ?? null }

  mark (part: number, points: Map<number, number>, on = true): void {
    const a = this.area[part]
    for (const [p, f] of points) {
      if (on) a.set(p, Math.max(a.get(p) ?? 0, f))
      else a.delete(p)
    }
  }
  clearArea (): void { for (const a of this.area) a.clear() }

  add (part: number, points: Map<number, number>, bone: number, strength: number): void {
    for (const [p, f] of points) {
      const w = this.weights(part, p)
      const was = w.get(bone) ?? 0
      const now = Math.min(1, was + strength * f * (1 - was))
      const scale = was < 1 ? (1 - now) / (1 - was) : 0
      for (const [b, x] of w) if (b !== bone) w.set(b, x * scale)
      w.set(bone, now)
      this.set(part, p, w, this.log)
    }
  }

  remove (part: number, points: Map<number, number>, bone: number, strength: number): void {
    for (const [p, f] of points) {
      const w = this.weights(part, p)
      const was = w.get(bone) ?? 0
      if (was === 0) continue
      const now = was * (1 - strength * f)
      const rest = 1 - was
      // (what it gives up goes to the others it has, else to its neighbours' bones)
      if (rest > 1e-4) for (const [b, x] of w) { if (b !== bone) w.set(b, x + (was - now) * x / rest) }
      else for (const [b, x] of this.average(part, p)) if (b !== bone) w.set(b, (w.get(b) ?? 0) + (was - now) * x)
      w.set(bone, now)
      this.set(part, p, w, this.log)
    }
  }

  private average (part: number, p: number): Weights {
    const out: Weights = new Map()
    const n = this.parts[part].adj.get(p) ?? new Set()
    for (const q of n) for (const [b, x] of this.weights(part, q)) out.set(b, (out.get(b) ?? 0) + x / n.size)
    return out
  }

  smooth (part: number, points: Map<number, number>, strength: number): void {
    const next = new Map<number, Weights>()
    for (const [p, f] of points) {
      const w = this.weights(part, p); const a = this.average(part, p)
      const out: Weights = new Map()
      const k = strength * f
      for (const b of new Set([...w.keys(), ...a.keys()])) out.set(b, (1 - k) * (w.get(b) ?? 0) + k * (a.get(b) ?? 0))
      next.set(p, out)
    }
    for (const [p, w] of next) this.set(part, p, w, this.log)
  }

  /** Heal the marked area: its weights filled in smoothly from the skin round it (each point the mean of its
   * neighbours, the skin round the area held), so skin pulled by a wrong bone goes with what surrounds it. */
  heal (): number {
    this.begin()
    let fixed = 0
    for (let part = 0; part < this.parts.length; part++) {
      const area = this.area[part]
      if (area.size === 0) continue
      const { mesh, adj } = this.parts[part]
      const R = [...area.keys()]
      const inR = new Set(R)
      // 1. harmonic weights: each point the mean of its neighbours, the skin round the area held
      const w = new Map<number, Weights>()
      const weightOf = (p: number): Weights => w.get(p) ?? this.weights(part, p)
      for (const p of R) w.set(p, this.weights(part, p))
      for (let it = 0; it < 400; it++) {
        let change = 0
        for (const p of R) {
          const n = adj.get(p); if (n === undefined || n.size === 0) continue
          const out: Weights = new Map()
          for (const q of n) for (const [b, x] of weightOf(q)) out.set(b, (out.get(b) ?? 0) + x / n.size)
          const old = w.get(p)!
          for (const b of new Set([...old.keys(), ...out.keys()])) change = Math.max(change, Math.abs((old.get(b) ?? 0) - (out.get(b) ?? 0)))
          w.set(p, out)
        }
        if (change < 1e-4) break
      }
      for (const p of R) {
        // the brush's edge eases in: the healed weights at full strength in the middle
        const f = area.get(p) ?? 1
        const was = this.weights(part, p); const solved = w.get(p)!
        const out: Weights = new Map()
        for (const b of new Set([...was.keys(), ...solved.keys()])) out.set(b, (1 - f) * (was.get(b) ?? 0) + f * (solved.get(b) ?? 0))
        this.set(part, p, out, this.log)
        fixed++
      }
    }
    return fixed
  }

  /** Back one stroke (or fix). */
  stepBack (): boolean {
    const last = this.undo.pop()
    if (last === undefined) return false
    for (const e of last.reverse()) this.set(e.part, e.point, e.weights, null)
    return true
  }

  /** The changed points' weights by bone name, to save (every vertex of each point). */
  edits (): Edit[] {
    const out: Edit[] = []
    this.parts.forEach(({ mesh, members }, part) => {
      const names = mesh.skeleton.bones.map(b => b.name)
      for (const p of this.edited[part]) {
        const w = [...this.weights(part, p).entries()].map(([b, x]) => [names[b], Math.round(x * 1e5) / 1e5] as [string, number])
        for (const v of members.get(p) ?? [p]) out.push({ mesh: part, vertex: v, weights: w })
      }
    })
    return out
  }

  saved (): void { for (const e of this.edited) e.clear(); this.undo = [] }
}
