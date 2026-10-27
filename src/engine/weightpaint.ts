// Weight painting on a posed body (the Rig step's "Fix weights"). Vertices split at UV seams are one point here (they
// always get the same weights, so a seam never tears). Brushes work on the body as it stands now (a clip paused on the
// frame that shows the problem):
//   area    mark the problem skin; "Heal" then refills its weights smoothly from the good skin round it (each point
//           the mean of its neighbours, the skin round the area held): skin pulled by a wrong bone goes with what
//           surrounds it
//   add / remove / smooth   a chosen bone's weight under the brush, by hand
// Mirror (on by default): each stroke lands on the other side too, on each point's mirror twin with its bones swapped
// for the other side's (LeftArm for RightArm), and a point on the middle line is evened between its sides; "Copy a
// side" sets the whole other side from one. Twins are found at rest, across the hips.
// At most four bones a vertex, normalized. Edits are kept by vertex and bone name, to save and to re-apply after a
// re-rig (the source mesh, and so its vertex order, stays).
import * as THREE from 'three'

export type Weights = Map<number, number>   // bone index -> weight

interface Part {
  mesh: THREE.SkinnedMesh
  /** vertex -> its point (the first vertex at that position) */
  point: Int32Array
  /** point -> its mirror twin across the body's middle (itself on the middle line); none when it has none */
  twin: Map<number, number>
  /** bone index -> the other side's (itself for a bone in the middle) */
  swap: Int32Array
  /** point -> which side of the middle it is on at rest (+1 the body's left, -1 its right, 0 the middle) */
  side: Map<number, number>
  /** point -> its vertices */
  members: Map<number, number[]>
  /** point -> neighbouring points */
  adj: Map<number, Set<number>>
  rest: Float32Array
}

export interface Edit { mesh: number, vertex: number, weights: Array<[string, number]> }

/** The bone on the other side's name: Left/Right (a person's), and _l/_r, .L/.R, L_/R_ (a creature's: a horse's
 * front_leg_upper_l). The same name for a middle bone. */
export function mirrorName (n: string): string {
  if (/Left|Right/.test(n)) return n.replace(/Left|Right/g, m => (m === 'Left' ? 'Right' : 'Left'))
  const swapped = n.replace(/([_.])([lLrR])(?=$|[_.\d])/g, (_m, sep: string, c: string) => sep + ({ l: 'r', r: 'l', L: 'R', R: 'L' } as Record<string, string>)[c])
  if (swapped !== n) return swapped
  return n.replace(/^([lLrR])(?=[_.])/, c => ({ l: 'r', r: 'l', L: 'R', R: 'L' } as Record<string, string>)[c])
}

export class WeightPainter {
  readonly parts: Part[] = []
  /** The area marked (point -> 0..1), per part. */
  readonly area: Array<Map<number, number>> = []
  /** Points changed since the last save, per part. */
  readonly edited: Array<Set<number>> = []
  private undo: Array<Array<{ part: number, point: number, weights: Weights }>> = []
  /** Strokes land on both sides. */
  mirror = true

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
      const { twin, side } = twins(mesh, members, tol)
      const names = mesh.skeleton.bones.map(b => b.name)
      const swap = Int32Array.from(names.map((n, i) => { const j = names.indexOf(mirrorName(n)); return j >= 0 ? j : i }))
      this.parts.push({ mesh, point, members, adj, rest: Float32Array.from(pos.array as ArrayLike<number>), twin, swap, side })
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

  /** A point's weights as its twin should have them: each bone for the other side's. */
  private swapped (part: number, w: Weights): Weights {
    const swap = this.parts[part].swap
    const out: Weights = new Map()
    for (const [b, x] of w) out.set(swap[b], (out.get(swap[b]) ?? 0) + x)
    return out
  }

  /** The other side follows these points (Mirror): each twin gets their weights, swapped; a middle point is evened. */
  private follow (part: number, points: Iterable<number>): void {
    if (!this.mirror) return
    const { twin } = this.parts[part]
    for (const p of points) {
      const q = twin.get(p)
      if (q === undefined) continue
      const w = this.weights(part, p)
      if (q === p) {
        const even: Weights = new Map()
        for (const [b, x] of w) even.set(b, (even.get(b) ?? 0) + x / 2)
        for (const [b, x] of this.swapped(part, w)) even.set(b, (even.get(b) ?? 0) + x / 2)
        this.set(part, p, even, this.log)
      } else this.set(part, q, this.swapped(part, w), this.log)
    }
  }

  /** The whole other side set from one (`from`: the body's left, +1, or its right, -1): one undo step. Returns the
   * points set. */
  copySide (from: 1 | -1): number {
    this.begin()
    let n = 0
    this.parts.forEach(({ twin, side }, part) => {
      const mirror = this.mirror
      this.mirror = true
      const source = [...twin.keys()].filter(p => side.get(p) === from || twin.get(p) === p)
      this.follow(part, source)
      this.mirror = mirror
      n += source.length
    })
    return n
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
    const { twin } = this.parts[part]
    for (const [p, f] of points) {
      for (const x of this.mirror && twin.has(p) ? [p, twin.get(p)!] : [p]) {
        if (on) a.set(x, Math.max(a.get(x) ?? 0, f))
        else a.delete(x)
      }
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
    this.follow(part, points.keys())
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
    this.follow(part, points.keys())
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
    this.follow(part, next.keys())
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
      // (both sides were marked and healed: the body's left sets its right, so they match exactly)
      const { side } = this.parts[part]
      this.follow(part, R.filter(p => side.get(p) !== -1))
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

/** Each point's mirror twin across the body's middle (the hips' x at rest, in the mesh's own space), within `tol`
 * of where its mirror image falls; a point on the middle line is its own. And which side each point is on. */
function twins (mesh: THREE.SkinnedMesh, members: Map<number, number[]>, tol: number): { twin: Map<number, number>, side: Map<number, number> } {
  const pos = mesh.geometry.attributes.position
  const bones = mesh.skeleton.bones
  const hips = bones.findIndex(b => /(^|:)Hips$/.test(b.name))
  let xc: number
  if (hips >= 0) {
    const at = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(mesh.skeleton.boneInverses[hips]).invert())
    xc = at.applyMatrix4(new THREE.Matrix4().copy(mesh.bindMatrixInverse)).x
  } else {
    const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute)
    xc = 0.5 * (box.min.x + box.max.x)
  }
  const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute)
  const near = 0.002 * Math.max(box.max.y - box.min.y, box.max.z - box.min.z, 1e-6)
  const cell = Math.max(near, tol)
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  for (const p of members.keys()) { const k = key(pos.getX(p), pos.getY(p), pos.getZ(p)); (grid.get(k) ?? grid.set(k, []).get(k)!).push(p) }
  const twin = new Map<number, number>()
  const side = new Map<number, number>()
  for (const p of members.keys()) {
    const x = pos.getX(p) - xc
    side.set(p, Math.abs(x) <= near ? 0 : Math.sign(x))
    if (Math.abs(x) <= near) { twin.set(p, p); continue }
    const mx = xc - x; const y = pos.getY(p); const z = pos.getZ(p)
    const cx = Math.floor(mx / cell); const cy = Math.floor(y / cell); const cz = Math.floor(z / cell)
    let best = -1; let bd = near
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      for (const q of grid.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
        const d = Math.hypot(pos.getX(q) - mx, pos.getY(q) - y, pos.getZ(q) - z)
        if (d < bd) { bd = d; best = q }
      }
    }
    if (best >= 0) twin.set(p, best)
  }
  // (only twins that are each other's)
  for (const [p, q] of twin) if (twin.get(q) !== p) twin.delete(p)
  return { twin, side }
}
