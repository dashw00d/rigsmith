// Weight painting on a posed body (the Rig step's "Fix weights"). Vertices split at UV seams are one point here (they
// always get the same weights, so a seam never tears). Brushes work on the body as it stands now (a clip paused on the
// frame that shows the problem):
//   area    mark the problem skin; "Heal" then refills its weights smoothly from the good skin round it (each point
//           the mean of its neighbours, the skin round the area held): skin pulled by a wrong bone goes with what
//           surrounds it
//   add / remove / smooth   a chosen bone's weight under the brush, by hand
//   follow  the brushed skin takes the weights of what it covers (the legs under a coat), or of the nearest bones
//           where nothing is close under it: cloth the body should push (a hem the legs walk through)
//   bone    (rigid) the brushed skin moves with only one bone, every other pull dropped (a face a hood drags): the bone
//           leading where the stroke began
//   lift    not weights but shape: the brushed skin pushed out off the skin under it to a gap (a cape off the body it
//           follows, so the body doesn't show through it or its lining), the cloth's own inner side going with it;
//           measured on the body as it stands, saved as rest positions (server/shapes.ts)
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

/** A part's rest shape for the Follow brush (WeightPainter.followUnder), in the mesh's own space. */
interface Rest {
  height: number
  /** each bone as segments to its children (a bone with none, a point) */
  bones: Array<{ bone: number, a: THREE.Vector3, b: THREE.Vector3 }>
  tris: Int32Array
  normals: THREE.Vector3[]
  boxes: THREE.Box3[]
  /** point -> the covered skin under it (a mesh painted on, a triangle and where on it), or null when none is close */
  under: Map<number, { part: number, face: number, bary: [number, number, number] } | null>
}

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
  private undo: Array<Array<{ part: number, point: number, weights?: Weights, position?: number[] }>> = []
  /** Points lifted since the last save, per part (Lift). */
  readonly shaped: Array<Set<number>> = []
  /** Each part's positions when the painter took it up (where a lifted vertex was before this session). */
  private readonly origin: Float32Array[] = []
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
      this.shaped.push(new Set())
      this.origin.push(Float32Array.from(pos.array as ArrayLike<number>))
    }
  }

  get editedCount (): number { return this.edited.reduce((n, s) => n + s.size, 0) + this.shaped.reduce((n, s) => n + s.size, 0) }

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
  private set (part: number, p: number, w: Weights, log: Array<{ part: number, point: number, weights?: Weights, position?: number[] }> | null): void {
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

  /** Distance over the posed surface from the picked triangle. Nearby fingers, the
   * opposite side of a thin limb, and separate cloth sheets are not brush neighbours. */
  under (part: number, at: THREE.Vector3, radius: number, face?: readonly number[]): Map<number, number> {
    const out = new Map<number, number>()
    if (!Number.isFinite(radius) || radius <= 0) return out
    const positions = this.posed(part)
    const { point, adj } = this.parts[part]
    let seeds: number[]
    if (face !== undefined) seeds = [...new Set(face.map(v => point[v]))]
    else {
      let nearest = -1; let best = Infinity
      for (const [p, x] of positions) { const d = x.distanceToSquared(at); if (d < best) { best = d; nearest = p } }
      seeds = nearest < 0 ? [] : [nearest]
    }
    const distance = new Map<number, number>()
    const heap: Array<[number, number]> = []
    const push = (p: number, d: number): void => {
      if (d >= radius || d >= (distance.get(p) ?? Infinity)) return
      distance.set(p, d)
      let i = heap.length; heap.push([p, d])
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (heap[parent][1] <= d) break
        heap[i] = heap[parent]; i = parent
      }
      heap[i] = [p, d]
    }
    for (const p of seeds) { const x = positions.get(p); if (x !== undefined) push(p, x.distanceTo(at)) }
    while (heap.length > 0) {
      const [p, d] = heap[0]; const last = heap.pop()!
      if (heap.length > 0) {
        let i = 0
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1
          if (child + 1 < heap.length && heap[child + 1][1] < heap[child][1]) child++
          if (last[1] <= heap[child][1]) break
          heap[i] = heap[child]; i = child
        }
        heap[i] = last
      }
      if (d !== distance.get(p)) continue
      const t = 1 - d / radius
      out.set(p, t * t * (3 - 2 * t))
      for (const q of adj.get(p) ?? []) push(q, d + positions.get(p)!.distanceTo(positions.get(q)!))
    }
    return out
  }

  /** A stroke begins (one undo step). */
  begin (): void { this.undo.push([]); this.strokeBone = null }
  /** The bone a Bone stroke holds to (picked on its first dab). */
  private strokeBone: number | null = null
  private get log (): Array<{ part: number, point: number, weights?: Weights, position?: number[] }> | null { return this.undo[this.undo.length - 1] ?? null }

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
      else {
        const neighbours = [...this.average(part, p)].filter(([b]) => b !== bone)
        const total = neighbours.reduce((s, [, x]) => s + x, 0)
        if (total <= 0) continue
        for (const [b, x] of neighbours) w.set(b, (was - now) * x / total)
      }
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

  /** Follow: the brushed skin takes on the weights of what is under it, so whatever it covers pushes it (a coat's
   * hem over the legs). Found at rest: looking in from each point toward its nearest bone, the first skin facing
   * back out (the hidden trousers under a coat; the cloth's own inner side faces away and is passed), within a short
   * reach; with nothing that close, the nearest bones themselves. */
  followUnder (part: number, points: Map<number, number>, strength: number): void {
    // (every target first: a stroke can cover both a coat and the skin under it)
    const targets = new Map<number, Weights>()
    for (const p of points.keys()) targets.set(p, this.beneath(part, p))
    for (const [p, f] of points) {
      const w = this.weights(part, p); const target = targets.get(p)!
      const k = Math.min(1, strength * f)
      const out: Weights = new Map()
      for (const b of new Set([...w.keys(), ...target.keys()])) out.set(b, (1 - k) * (w.get(b) ?? 0) + k * (target.get(b) ?? 0))
      this.set(part, p, out, this.log)
    }
    this.follow(part, points.keys())
  }

  private readonly restCache = new Map<number, Rest>()

  /** A part's rest shape for Follow: its bones as segments (each bone to its children; a bone with none, a point) and
   * its triangles, in the mesh's own space. */
  private restOf (part: number): Rest {
    const cached = this.restCache.get(part)
    if (cached !== undefined) return cached
    const { mesh, rest } = this.parts[part]
    const skeleton = mesh.skeleton
    const at = skeleton.bones.map((_, i) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(skeleton.boneInverses[i]).invert()).applyMatrix4(mesh.bindMatrixInverse))
    const bones: Array<{ bone: number, a: THREE.Vector3, b: THREE.Vector3 }> = []
    skeleton.bones.forEach((bone, i) => {
      // (an end marker moves nothing)
      if (/end|leaf|tip$/i.test(bone.name)) return
      const children = bone.children.map(c => skeleton.bones.indexOf(c as THREE.Bone)).filter(c => c >= 0)
      if (children.length === 0) bones.push({ bone: i, a: at[i], b: at[i] })
      for (const c of children) bones.push({ bone: i, a: at[i], b: at[c] })
    })
    const g = mesh.geometry
    const index = g.index !== null ? Int32Array.from(g.index.array as ArrayLike<number>) : Int32Array.from({ length: rest.length / 3 }, (_, i) => i)
    const corner = (v: number): THREE.Vector3 => new THREE.Vector3(rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2])
    const normals: THREE.Vector3[] = []; const boxes: THREE.Box3[] = []
    for (let t = 0; t < index.length; t += 3) {
      const a = corner(index[t]); const b = corner(index[t + 1]); const c = corner(index[t + 2])
      normals.push(b.clone().sub(a).cross(c.clone().sub(a)).normalize())
      boxes.push(new THREE.Box3().setFromPoints([a, b, c]))
    }
    const box = new THREE.Box3().setFromArray(rest)
    const out: Rest = { height: Math.max(box.max.y - box.min.y, 1e-6), bones, tris: index, normals, boxes, under: new Map() }
    this.restCache.set(part, out)
    return out
  }

  /** The bone moving most of the skin under the brush (the brush's edge counting less): what a Bone stroke begun
   * here would paint. */
  leadingBone (part: number, points: Map<number, number>): number | null {
    const lead: Weights = new Map()
    for (const [p, f] of points) for (const [b, x] of this.weights(part, p)) lead.set(b, (lead.get(b) ?? 0) + x * f)
    return [...lead].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }

  /** The bone the stroke under way holds to (a Bone stroke), if any. */
  get strokeBoneIndex (): number | null { return this.strokeBone }

  /** Bone (rigid): the brushed skin moves with only one bone, every other pull dropped (a face a hood drags, a buckle, a
   * plate): the bone leading where the stroke began, held for the whole stroke. */
  rigid (part: number, points: Map<number, number>, strength: number): void {
    this.strokeBone ??= this.leadingBone(part, points)
    const bone = this.strokeBone
    if (bone === null) return
    for (const [p, f] of points) {
      const w = this.weights(part, p)
      const k = Math.min(1, strength * f)
      const out: Weights = new Map()
      for (const [b, x] of w) out.set(b, (1 - k) * x)
      out.set(bone, (out.get(bone) ?? 0) + k)
      this.set(part, p, out, this.log)
    }
    this.follow(part, points.keys())
  }

  /** One mesh's bone indices as another's (by name; the same skeleton maps to itself), -1 where it has no such bone. */
  private boneMap (from: number, to: number): Int32Array {
    const a = this.parts[from].mesh.skeleton; const b = this.parts[to].mesh.skeleton
    if (a === b) return Int32Array.from(a.bones, (_, i) => i)
    const names = b.bones.map(x => x.name)
    return Int32Array.from(a.bones, x => names.indexOf(x.name))
  }

  /** What a point follows (see followUnder). */
  private beneath (part: number, p: number): Weights {
    const r = this.restOf(part)
    const { rest, point } = this.parts[part]
    const x = new THREE.Vector3(rest[p * 3], rest[p * 3 + 1], rest[p * 3 + 2])
    const toward = (s: { a: THREE.Vector3, b: THREE.Vector3 }): THREE.Vector3 => {
      const ab = s.b.clone().sub(s.a); const t = ab.lengthSq() > 1e-12 ? THREE.MathUtils.clamp(x.clone().sub(s.a).dot(ab) / ab.lengthSq(), 0, 1) : 0
      return s.a.clone().addScaledVector(ab, t)
    }
    const near = r.bones.map(s => ({ bone: s.bone, d: toward(s).distanceTo(x), at: toward(s) })).sort((a, b) => a.d - b.d)
    if (near.length === 0) return this.weights(part, p)
    if (!r.under.has(p)) {
      // (as far as a garment sits off the skin: by the character's size, the tallest mesh painted on, not a small piece's)
      const height = Math.max(...this.parts.map((_, q) => this.restOf(q).height))
      const reach = Math.min(near[0].d, 0.08 * height)
      const dir = near[0].at.clone().sub(x).normalize()
      const ray = new THREE.Ray(x, dir)
      const span = new THREE.Box3().setFromPoints([x, x.clone().addScaledVector(dir, reach)])
      const hit = new THREE.Vector3(); let best: { part: number, face: number, bary: [number, number, number], t: number } | null = null
      // (every mesh painted on: a garment's skin under it is the body's; the meshes share the body's rest space)
      for (let q = 0; q < this.parts.length; q++) {
        const o = q === part ? r : this.restOf(q)
        const orest = this.parts[q].rest
        for (let f = 0; f < o.normals.length; f++) {
          if (o.normals[f].dot(dir) >= 0 || !o.boxes[f].intersectsBox(span)) continue
          const v = [o.tris[f * 3], o.tris[f * 3 + 1], o.tris[f * 3 + 2]]
          if (q === part && v.some(i => point[i] === p)) continue
          const [a, b, c] = v.map(i => new THREE.Vector3(orest[i * 3], orest[i * 3 + 1], orest[i * 3 + 2]))
          if (ray.intersectTriangle(a, b, c, false, hit) === null) continue
          const t = hit.distanceTo(x)
          if (t < 1e-4 * r.height || t > reach || (best !== null && t >= best.t)) continue
          const bary = THREE.Triangle.getBarycoord(hit, a, b, c, new THREE.Vector3())
          if (bary !== null) best = { part: q, face: f, bary: [bary.x, bary.y, bary.z], t }
        }
      }
      r.under.set(p, best === null ? null : { part: best.part, face: best.face, bary: best.bary })
    }
    const under = r.under.get(p)
    const out: Weights = new Map()
    if (under !== undefined && under !== null) {
      // the covered skin's weights as they are now (painted ones included), its bones as this mesh's
      const o = this.restOf(under.part)
      const map = this.boneMap(under.part, part)
      for (let k = 0; k < 3; k++) {
        for (const [b, w] of this.weights(under.part, this.parts[under.part].point[o.tris[under.face * 3 + k]])) {
          const to = map[b]
          if (to >= 0) out.set(to, (out.get(to) ?? 0) + w * under.bary[k])
        }
      }
      if (out.size > 0) return out
    }
    // nothing close under it: the nearest bones, the nearer far more (two, so a border between them stays soft)
    const two = near.filter((s, i) => i === 0 || s.bone !== near[0].bone).slice(0, 2)
    const inv = two.map(s => 1 / Math.max(s.d, 1e-6) ** 4); const total = inv.reduce((a, b) => a + b, 0)
    two.forEach((s, i) => out.set(s.bone, (out.get(s.bone) ?? 0) + inv[i] / total))
    return out
  }

  /** Heal the marked area: its weights filled in smoothly from the skin round it (each point the mean of its
   * neighbours, the skin round the area held), so skin pulled by a wrong bone goes with what surrounds it. */
  heal (): number {
    this.begin()
    let fixed = 0
    for (let part = 0; part < this.parts.length; part++) {
      const area = this.area[part]
      if (area.size === 0) continue
      const { adj } = this.parts[part]
      // A closed selection has no reliable boundary. Leave that component alone
      // instead of diffusing every bone into a constant average over the island.
      const anchored = new Set<number>()
      const queue = [...area.keys()].filter(p => [...(adj.get(p) ?? [])].some(q => !area.has(q)))
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i]
        if (anchored.has(p)) continue
        anchored.add(p)
        for (const q of adj.get(p) ?? []) if (area.has(q) && !anchored.has(q)) queue.push(q)
      }
      const R = [...anchored]
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
        area.delete(p)
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
    const moved = new Set<number>()
    for (const e of last.reverse()) {
      if (e.weights !== undefined) this.set(e.part, e.point, e.weights, null)
      if (e.position !== undefined) { this.place(e.part, e.point, e.position); moved.add(e.part) }
    }
    for (const part of moved) this.reshaped(part)
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

  /** The lifted points' rest positions, to save (every vertex of each point, and where it was before). */
  shapeEdits (): Array<{ mesh: number, vertex: number, from: [number, number, number], to: [number, number, number] }> {
    const out: Array<{ mesh: number, vertex: number, from: [number, number, number], to: [number, number, number] }> = []
    this.parts.forEach(({ mesh, members }, part) => {
      const pos = mesh.geometry.attributes.position; const o = this.origin[part]
      for (const p of this.shaped[part]) {
        for (const v of members.get(p) ?? [p]) out.push({ mesh: part, vertex: v, from: [o[v * 3], o[v * 3 + 1], o[v * 3 + 2]], to: [pos.getX(v), pos.getY(v), pos.getZ(v)] })
      }
    })
    return out
  }

  saved (): void { for (const e of this.edited) e.clear(); for (const e of this.shaped) e.clear(); this.undo = [] }

  /** A point's rest position set (on all its vertices). */
  private place (part: number, p: number, at: ArrayLike<number>): void {
    const { mesh, members, rest } = this.parts[part]
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
    for (const v of members.get(p) ?? [p]) {
      pos.setXYZ(v, at[0], at[1], at[2])
      rest[v * 3] = at[0]; rest[v * 3 + 1] = at[1]; rest[v * 3 + 2] = at[2]
    }
  }

  /** A part's shape changed: its geometry redrawn, what Follow found at rest found again. */
  private reshaped (part: number): void {
    const g = this.parts[part].mesh.geometry
    g.attributes.position.needsUpdate = true
    g.computeBoundingBox(); g.computeBoundingSphere()
    this.restCache.clear()
  }

  /** Lift: the brushed skin pushed out off the skin under it until it is `gap` (world units) clear of it, a share
   * (`strength`) of the way each dab. Measured on the body as it stands: from each point toward its nearest bone, the
   * first skin facing back out (what it covers; Follow's look) within a short reach; skin already through it (facing
   * out just beyond it) lifts it past. The cloth's own inner side between (a lining, facing in) goes out with it, so a
   * cape's two sides move together. Lifts are evened over the brush so the cloth doesn't come up in bumps, and kept as
   * rest positions (each move undone through the pose's skinning). Returns the points moved. */
  lift (part: number, points: Map<number, number>, gap: number, strength: number): number {
    const brushed = new Map(points)
    if (this.mirror) for (const [p, f] of points) { const q = this.parts[part].twin.get(p); if (q !== undefined && q !== p) brushed.set(q, Math.max(brushed.get(q) ?? 0, f)) }
    if (brushed.size === 0) return 0
    const height = Math.max(...this.parts.map((_, q) => this.restOf(q).height))
    const reach = 0.08 * height; const thick = 0.03 * height
    // the body as it stands: every part's points, and its bones as segments, in world space
    const posed = this.parts.map((_, q) => this.posed(q))
    const { mesh } = this.parts[part]
    const segments: Array<{ a: THREE.Vector3, b: THREE.Vector3 }> = []
    for (const bone of mesh.skeleton.bones) {
      if (/end|leaf|tip$/i.test(bone.name)) continue
      const a = bone.getWorldPosition(new THREE.Vector3())
      const children = bone.children.filter(c => (c as THREE.Bone).isBone)
      if (children.length === 0) segments.push({ a, b: a })
      for (const c of children) segments.push({ a, b: c.getWorldPosition(new THREE.Vector3()) })
    }
    // the triangles near the brush (as far as a ray reaches), posed
    const span = new THREE.Box3()
    for (const p of brushed.keys()) span.expandByPoint(posed[part].get(p)!)
    span.expandByScalar(reach)
    const tris: Array<{ q: number, pts: [number, number, number], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3 }> = []
    this.parts.forEach(({ mesh: m, point }, q) => {
      const index = m.geometry.index
      const count = index !== null ? index.count : m.geometry.attributes.position.count
      const box = new THREE.Box3()
      for (let t = 0; t < count; t += 3) {
        const pts = [0, 1, 2].map(k => point[index !== null ? index.getX(t + k) : t + k]) as [number, number, number]
        const [a, b, c] = pts.map(x => posed[q].get(x)!)
        box.setFromPoints([a, b, c])
        if (!box.intersectsBox(span)) continue
        const n = b.clone().sub(a).cross(c.clone().sub(a))
        if (n.lengthSq() < 1e-20) continue
        tris.push({ q, pts, a, b, c, n: n.normalize() })
      }
    })
    // how far out each brushed point must go, and the inner side that goes with it
    const need = new Map<number, number>(); const out = new Map<number, THREE.Vector3>()
    const lining = new Map<number, Set<number>>()
    const hit = new THREE.Vector3(); const ray = new THREE.Ray()
    for (const p of brushed.keys()) {
      const x = posed[part].get(p)!
      let best = Infinity; let at = x
      for (const s of segments) {
        const ab = s.b.clone().sub(s.a); const t = ab.lengthSq() > 1e-12 ? THREE.MathUtils.clamp(x.clone().sub(s.a).dot(ab) / ab.lengthSq(), 0, 1) : 0
        const y = s.a.clone().addScaledVector(ab, t); const d = y.distanceTo(x)
        if (d < best) { best = d; at = y }
      }
      if (best < 1e-6) continue
      const inward = at.clone().sub(x).normalize(); const outward = inward.clone().negate()
      const far = Math.min(best, reach)
      let under = Infinity; let through = Infinity
      const inner = new Set<number>()
      ray.set(x, inward)
      for (const tri of tris) {
        if (tri.q === part && tri.pts.includes(p)) continue
        if (ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit) !== null) {
          const t = hit.distanceTo(x)
          if (t > far || t < 1e-5 * height) continue
          if (tri.n.dot(inward) < 0) under = Math.min(under, t)
          else if (tri.q === part && t < thick) for (const y of tri.pts) if (!brushed.has(y)) inner.add(y)
        }
      }
      ray.set(x, outward)
      for (const tri of tris) {
        if (tri.q === part && (tri.pts.includes(p) || tri.pts.some(y => brushed.has(y)))) continue
        // (skin already out through this point faces out just beyond it)
        if (tri.n.dot(outward) <= 0 || ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit) === null) continue
        const t = hit.distanceTo(x)
        if (t > 1e-5 * height) through = Math.min(through, t)
      }
      const d = through < thick ? through + gap : under < Infinity ? Math.max(0, gap - under) : 0
      need.set(p, d); out.set(p, outward)
      if (inner.size > 0) lining.set(p, inner)
    }
    // evened over the brush: a point lifts at least as far as its brushed neighbours, on average (no bumps)
    const { adj } = this.parts[part]
    for (let it = 0; it < 3; it++) {
      const next = new Map(need)
      for (const [p, d] of need) {
        const n = [...(adj.get(p) ?? [])].filter(q => need.has(q))
        if (n.length === 0) continue
        next.set(p, Math.max(d, 0.5 * (d + n.reduce((s, q) => s + need.get(q)!, 0) / n.length)))
      }
      for (const [p, d] of next) need.set(p, d)
    }
    // the moves, in world space: each brushed point, and its inner side by the most any point above it takes it
    const moves = new Map<number, THREE.Vector3>()
    for (const [p, d] of need) {
      const step = d * Math.min(1, strength * (brushed.get(p) ?? 0))
      if (step <= 1e-7 * height) continue
      const m = out.get(p)!.clone().multiplyScalar(step)
      moves.set(p, m)
      for (const q of lining.get(p) ?? []) { const was = moves.get(q); if (was === undefined || was.lengthSq() < m.lengthSq()) moves.set(q, m.clone()) }
    }
    if (moves.size === 0) return 0
    // each into rest space through its skinning as posed (the world move undone by its bones' blend)
    mesh.updateMatrixWorld(true)
    const g = mesh.geometry
    const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight
    const toMesh = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert())
    const bindInv = new THREE.Matrix3().setFromMatrix4(mesh.bindMatrixInverse)
    const bind = new THREE.Matrix3().setFromMatrix4(mesh.bindMatrix)
    const boneM = mesh.skeleton.bones.map((b, i) => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[i])))
    const pos = g.attributes.position
    for (const [p, m] of moves) {
      const blend = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0)
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(p, k)
        if (w <= 0) continue
        const e = boneM[si.getComponent(p, k)].elements
        for (let i = 0; i < 9; i++) blend.elements[i] += w * e[i]
      }
      // world move = matrixWorld · bindMatrixInverse · blend · bindMatrix · rest move
      const L = bindInv.clone().multiply(blend).multiply(bind)
      if (Math.abs(L.determinant()) < 1e-9) continue
      const local = m.clone().applyMatrix3(toMesh).applyMatrix3(L.invert())
      this.log?.push({ part, point: p, position: [pos.getX(p), pos.getY(p), pos.getZ(p)] })
      this.place(part, p, [pos.getX(p) + local.x, pos.getY(p) + local.y, pos.getZ(p) + local.z])
      this.shaped[part].add(p)
    }
    this.reshaped(part)
    return moves.size
  }
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
