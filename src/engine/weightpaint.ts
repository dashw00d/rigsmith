// Weight painting on a posed body (the Skin step's weight painting, and a gear piece's in the Gear step). Vertices split
// at UV seams are one point here (they always get the same weights, so a seam never tears). Brushes work on the body
// as it stands now (a clip paused on the frame that shows the problem):
//   area    mark the problem skin; "Heal" then refills its weights smoothly from the good skin round it (each point
//           the mean of its neighbours, the skin round the area held): skin pulled by a wrong bone goes with what
//           surrounds it
//   add / remove / smooth   a chosen bone's weight under the brush, by hand
//   follow  the brushed skin takes the weights of what it covers (the legs under a coat), or of the nearest bones
//           where nothing is close under it: cloth the body should push (a hem the legs walk through). It reaches
//           through the cloth layers under the painted sheet at rest (column), sharing its target and falloff.
//           Strength blends each layer from its own source, without overwriting the lining at the brush edge
//   cloth   clothing over the legs (a coat's skirts, a robe, a cape's hem), weighted by where it hangs at rest and nothing
//           else: the hips at the waist blending down into each leg, its own side's more, a share of the shin below
//           the knee, no arm; layers share that target. Clip-pose checks limit folds, collapsed faces and edge spikes
//   bone    (rigid) the brushed skin moves with only one bone, every other pull dropped (a face a hood drags): the bone
//           leading where the stroke began
//   lift    not weights but shape: the brushed skin pushed out off the skin under it to a gap (a cape off the body it
//           follows, so the body doesn't show through it or its lining), the cloth's own inner side going with it;
//           measured on the body as it stands, saved as rest positions (server/shapes.ts)
// Mirror (on by default): each stroke lands on the other side too, on each point's mirror twin with its bones swapped
// for the other side's (LeftArm for RightArm), and a point on the middle line is evened between its sides; "Copy a
// side" sets the whole other side from one. Twins are found at rest, across the hips; the other side's bone is the
// skeleton's own pair (templates.ts skeletonSpec's mirror, which the joint editor uses too; a person's by default).
// At most four bones a vertex, normalized. Edits are kept by vertex and bone name, to save and to re-apply after a
// re-rig (the source mesh, and so its vertex order, stays).
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { MeshBVH } from 'three-mesh-bvh'
import { SurfaceContacts } from './surface-contacts.ts'
import { swapSide as personMirror } from './templates.ts'

export type Weights = Map<number, number>   // bone index -> weight

/** A through-layer footprint retains the point on the painted sheet above each covered point. */
class LayerColumn extends Map<number, number> {
  readonly anchors = new Map<number, { part: number, points: number[], bary: number[] }>()
}

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

interface UndoStroke {
  changes: Array<{
    part: number
    point: number
    skin?: Array<{ vertex: number, index: number[], weight: number[] }>
    positions?: Array<{ vertex: number, at: [number, number, number] }>
  }>
  edited: Array<Set<number>>
  shaped: Array<Set<number>>
  area: Array<Map<number, number>>
  protectedPoints: Array<Set<number>>
}

export interface Edit { mesh: number, vertex: number, weights: Array<[string, number]> }
export interface ShapeEdit { mesh: number, vertex: number, from: [number, number, number], to: [number, number, number] }

export interface PaintHit {
  part: number
  point: THREE.Vector3
  normal: THREE.Vector3
  face: [number, number, number]
  distance: number
}

export interface PaintPick extends PaintHit { points: Map<number, number> }

interface GuardAnimation { root: THREE.Object3D, clip: THREE.AnimationClip | null }

interface GuardPose {
  transforms: THREE.Matrix4[][]
  before: Array<Map<number, THREE.Vector3>>
  faces: Array<Map<number, { normal: THREE.Vector3, area: number, edges: number[] }>>
  layers: Array<Map<LayerPair, number>>
  contacts?: SurfaceContacts
}

interface LayerPair {
  part: number
  facePart: number
  point: number
  points: number[]
  bary: number[]
  side: number
  gap: number
  normal: THREE.Vector3
}

interface LayerTransaction {
  weights: Map<number, Map<number, Weights>>
  shapes: Map<number, Map<number, THREE.Vector3>>
  fields: Map<number, (p: number) => Weights | null>
  mirrors: Map<number, number>
  blends: Map<number, { target: Weights, strength: number }>
}

function normalizedWeights (w: Weights): Weights {
  const top = [...w].filter(([, x]) => Number.isFinite(x) && x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4)
  const total = top.reduce((sum, [, x]) => sum + x, 0)
  return new Map(top.map(([b, x]) => [b, x / total]))
}

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
  /** Original separation from the innermost cloth in the same local stack. */
  spacing: Map<number, number>
  bvh: MeshBVH
}

/** The bone on the other side's name (itself for a bone in the middle). */
export type MirrorName = (bone: string) => string

export class WeightPainter {
  readonly parts: Part[] = []
  /** The area marked (point -> 0..1), per part. */
  readonly area: Array<Map<number, number>> = []
  /** Session-only point protection. Change through protect/clearProtection so physical aliases and Undo agree. */
  readonly protectedPoints: Array<Set<number>> = []
  /** Points changed since the last save, per part. */
  readonly edited: Array<Set<number>> = []
  private undo: UndoStroke[] = []
  private strokeSource: Array<{ index: Float32Array, weight: Float32Array }> | null = null
  private readonly coverage: Array<Map<number, number>> = []
  private readonly manualCoverage = new Map<number, number>()
  private readonly shapeCoverage: Array<Map<number, number>> = []
  private readonly logged = new Set<string>()
  /** Points lifted since the last save, per part (Lift). */
  readonly shaped: Array<Set<number>> = []
  /** Original positions before saved lifts, for stable layer identity, spacing and mirror partners. */
  private readonly origin: Float32Array[] = []
  /** Strokes land on both sides. */
  mirror = true
  /** point -> its connected surface, per part (found when first asked). */
  private readonly surfaces: Array<Int32Array | undefined> = []
  private readonly posedTrees = new Map<number, { geometry: THREE.BufferGeometry, bvh: MeshBVH }>()
  private poseQuery: Map<number, Map<number, THREE.Vector3>> | null = null
  private strokeSurface: Map<number, Map<number, THREE.Vector3>> | null = null
  private strokeShape: Float32Array[] | null = null
  private guardPoses: GuardPose[] = []
  private guardRest: Float32Array[] | null = null
  private releaseAnimation: GuardAnimation | null = null
  private validating = false
  private strokeOpen = false
  private protectionStroke = false
  private strokeVersion = 0
  private readonly limited = new Set<string>()
  private readonly contactLimited = new Set<number>()
  private readonly separationCache = new Map<number, LayerPair[]>()
  private readonly offsets: number[] = []
  private readonly owners: number[] = []
  private readonly seams = new Map<number, number[]>()
  private readonly crossMirrors = new Map<number, number[]>()
  private readonly materialEdges: Array<{ fromPart: number, from: number[], toPart: number, to: number[] }> = []
  private readonly boneMaps = new Map<number, Int32Array>()
  private readonly editable?: ReadonlySet<THREE.SkinnedMesh>
  private pending: LayerTransaction | null = null
  private readonly bodyFaceCache = new Map<number, Int8Array>()
  /** Points whose requested change was limited to keep the cloth surface intact. */
  get limitedCount (): number { return this.limited.size }
  /** Limits caused by newly intersecting, nonadjacent triangles at the tested poses. */
  get contactLimitedCount (): number { return this.contactLimited.size }
  get protectedCount (): number { return this.protectedPoints.reduce((sum, points) => sum + points.size, 0) }

  /** `mirror`: the skeleton's left/right pairs (a person's by default). */
  constructor (meshes: THREE.SkinnedMesh[], mirror: MirrorName = personMirror,
    editable?: ReadonlySet<THREE.SkinnedMesh>, reference: readonly ShapeEdit[] = []) {
    this.editable = editable
    for (const [part, mesh] of meshes.entries()) {
      const g = mesh.geometry
      const pos = g.attributes.position
      const original = Float32Array.from(pos.array as ArrayLike<number>)
      for (const edit of reference) {
        if (edit.mesh !== part || !Number.isInteger(edit.vertex) || edit.vertex < 0 || edit.vertex >= pos.count ||
          !Array.isArray(edit.from) || !Array.isArray(edit.to) || edit.from.length !== 3 || edit.to.length !== 3 ||
          ![...edit.from, ...edit.to].every(x => Number.isFinite(x) && Number.isFinite(Math.fround(x)))) continue
        // A re-import or re-rig can leave records for another topology. Only a matching saved destination can
        // supply this vertex's reference; neither the live shape nor the editable/Undo state is changed here.
        if (edit.to.some((x, k) => Math.fround(x) !== pos.getComponent(edit.vertex, k))) continue
        original.set(edit.from, edit.vertex * 3)
      }
      const referencePosition = new THREE.BufferAttribute(original, 3)
      this.offsets.push(this.owners.length)
      for (let v = 0; v < pos.count; v++) this.owners.push(this.parts.length)
      const point = new Int32Array(pos.count)
      const key = new Map<string, number>()
      const box = new THREE.Box3().setFromBufferAttribute(referencePosition)
      const tol = 1e-5 * Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6)
      for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(referencePosition.getX(i) / tol)},${Math.round(referencePosition.getY(i) / tol)},${Math.round(referencePosition.getZ(i) / tol)}`
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
      const { twin, side } = twins(mesh, members, tol, referencePosition)
      const names = mesh.skeleton.bones.map(b => b.name)
      const swap = Int32Array.from(names.map((n, i) => { const j = names.indexOf(mirror(n)); return j >= 0 ? j : i }))
      this.parts.push({ mesh, point, members, adj, rest: Float32Array.from(pos.array as ArrayLike<number>), twin, swap, side })
      this.area.push(new Map())
      this.protectedPoints.push(new Set())
      this.edited.push(new Set())
      this.shaped.push(new Set())
      this.coverage.push(new Map()); this.shapeCoverage.push(new Map())
      this.origin.push(original)
    }
    this.connectParts()
  }

  /** Material primitives may duplicate a boundary, or contain opposite halves of a mirrored surface. Reference
   * positions share the first primitive's bind frame; coincident layers with different bindings stay independent. */
  private connectParts (): void {
    if (this.parts.length < 2) return
    const frame = this.parts[0].mesh.bindMatrix.clone().invert()
    const positions = new Map<number, THREE.Vector3>(); const box = new THREE.Box3()
    this.parts.forEach(({ mesh, members }, q) => {
      for (const p of members.keys()) {
        const x = new THREE.Vector3().fromArray(this.origin[q], p * 3).applyMatrix4(mesh.bindMatrix).applyMatrix4(frame)
        positions.set(this.offsets[q] + p, x); box.expandByPoint(x)
      }
    })
    const tolerance = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6) * 1e-5
    const coordinate = (x: THREE.Vector3): string => `${Math.round(x.x / tolerance)},${Math.round(x.y / tolerance)},${Math.round(x.z / tolerance)}`
    const buckets = new Map<string, number[]>()
    for (const [key, x] of positions) { const k = coordinate(x); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k)!.push(key) }
    const ids = new Map<THREE.Bone, number>()
    const binding = (key: number): string => {
      const q = this.owners[key]; const skeleton = this.parts[q].mesh.skeleton
      return [...this.weights(q, key - this.offsets[q])].map(([b, w]) => {
        const bone = skeleton.bones[b]; if (!ids.has(bone)) ids.set(bone, ids.size)
        return `${ids.get(bone)}:${Math.round(w * 1e7)}:${skeleton.boneInverses[b].elements.map(x => Math.round(x * 1e6)).join(',')}`
      }).sort().join(';')
    }
    for (const group of buckets.values()) {
      if (!group.some(key => this.owners[key] !== this.owners[group[0]])) continue
      const byBinding = new Map<string, number[]>()
      for (const key of group) { const signature = binding(key); if (!byBinding.has(signature)) byBinding.set(signature, []); byBinding.get(signature)!.push(key) }
      for (const seam of byBinding.values()) if (new Set(seam.map(key => this.owners[key])).size > 1) for (const key of seam) this.seams.set(key, seam)
    }
    // Coincident hem vertices also join a lining folded back under the outside. Only edges with material on
    // opposite sides are brush continuations; common vertices alone would let the cursor jump onto that lining.
    const edges = new Map<string, Array<{ part: number, points: number[], third: number }>>()
    this.parts.forEach(({ mesh, point }, part) => {
      const index = mesh.geometry.index; const count = index?.count ?? mesh.geometry.attributes.position.count
      for (let f = 0; f < count; f += 3) {
        const pts = [0, 1, 2].map(k => this.offsets[part] + point[index?.getX(f + k) ?? f + k])
        for (const [i, j, k] of [[0, 1, 2], [1, 2, 0], [2, 0, 1]]) {
          const a = this.seams.get(pts[i]); const b = this.seams.get(pts[j])
          if (a === undefined || b === undefined) continue
          const pa = Math.min(...a); const pb = Math.min(...b); const key = `${Math.min(pa, pb)}:${Math.max(pa, pb)}`
          if (pa === pb) continue
          if (!edges.has(key)) edges.set(key, [])
          edges.get(key)!.push({ part, points: pa < pb ? [pts[i], pts[j]] : [pts[j], pts[i]], third: pts[k] })
        }
      }
    })
    const world = (key: number): THREE.Vector3 => positions.get(key)!.clone().applyMatrix4(this.parts[0].mesh.bindMatrix)
    for (const faces of edges.values()) for (const a of faces) for (const b of faces) {
      if (a.part === b.part) continue
      const start = world(a.points[0]); const direction = world(a.points[1]).sub(start).normalize()
      const u = world(a.third).sub(start); u.addScaledVector(direction, -u.dot(direction))
      const v = world(b.third).sub(start); v.addScaledVector(direction, -v.dot(direction))
      if (u.lengthSq() < 1e-24 || v.lengthSq() < 1e-24) continue
      if (u.dot(v) > 1e-8 * u.length() * v.length()) continue
      this.materialEdges.push({ fromPart: a.part, from: a.points.map(p => p - this.offsets[a.part]),
        toPart: b.part, to: b.points.map(p => p - this.offsets[b.part]) })
    }
    const skeleton = this.parts[0].mesh.skeleton; const hips = skeleton.bones.findIndex(b => /(^|:)Hips$/.test(b.name))
    const centre = hips >= 0 ? new THREE.Vector3().setFromMatrixPosition(skeleton.boneInverses[hips].clone().invert()).applyMatrix4(frame).x : box.getCenter(new THREE.Vector3()).x
    for (const [key, x] of positions) {
      const q = this.owners[key]; const bones = new Set(this.parts[q].mesh.skeleton.bones)
      // Existing twins and their physical seam aliases already define this sheet. Positional matches from another
      // coincident sheet must not merge it into the brush group merely because it shares the character's bones.
      if (this.parts[q].twin.has(key - this.offsets[q])) continue
      const candidates = buckets.get(coordinate(new THREE.Vector3(2 * centre - x.x, x.y, x.z))) ?? []
      const matches = candidates.filter(other => this.owners[other] !== q && this.parts[this.owners[other]].mesh.skeleton.bones.some(b => bones.has(b)))
      const sheets = new Set(matches.map(other => Math.min(...(this.seams.get(other) ?? [other]))))
      if (sheets.size === 1) this.crossMirrors.set(key, matches)
    }
    const proposedMirrors = new Map(this.crossMirrors)
    for (const [key, matches] of proposedMirrors) {
      const reciprocal = matches.filter(other => proposedMirrors.get(other)?.includes(key) === true)
      if (reciprocal.length === 0) this.crossMirrors.delete(key)
      else this.crossMirrors.set(key, reciprocal)
    }
  }

  private mirroredTarget (part: number, p: number): Weights | undefined {
    const source = this.pending?.mirrors.get(part)
    if (source === undefined) return undefined
    const key = [...this.manualGroup(part, p)].find(([key, flags]) => this.owners[key] === source && (flags & 2) !== 0)?.[0]
    if (key === undefined) return undefined
    const field = this.pending?.fields.get(source)?.(key - this.offsets[source])
    if (field === null || field === undefined) return undefined
    const map = this.boneMap(source, part); const out: Weights = new Map()
    for (const [b, w] of this.swapped(source, field)) if (map[b] >= 0) out.set(map[b], (out.get(map[b]) ?? 0) + w)
    return out.size > 0 ? out : undefined
  }

  get editedCount (): number { return this.edited.reduce((n, s, part) => n + new Set([...s, ...this.shaped[part]]).size, 0) }

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

  private sourceWeights (part: number, p: number): Weights {
    const source = this.strokeSource?.[part]
    if (source === undefined) return this.weights(part, p)
    const out: Weights = new Map()
    for (let k = 0; k < 4; k++) {
      const w = source.weight[p * 4 + k]; const b = source.index[p * 4 + k]
      if (w > 0) out.set(b, (out.get(b) ?? 0) + w)
    }
    return out
  }

  /** Bounded strokes apply Strength once at each point's strongest coverage. Device event rate and overlapping
   * dabs cannot turn a light stroke into full weight. Direct engine operations retain their iterative behaviour. */
  private covered (part: number, points: Map<number, number>, acrossParts = false): Map<number, number> {
    if (acrossParts) {
      const chosen = new Map<number, { point: number, falloff: number, group: Map<number, number> }>()
      const preferred = (a: number, b: number): boolean => {
        const aq = this.owners[a]; const bq = this.owners[b]
        const as = this.parts[aq].side.get(a - this.offsets[aq]) ?? 0; const bs = this.parts[bq].side.get(b - this.offsets[bq]) ?? 0
        return as > bs || (as === bs && a < b)
      }
      for (const [p, f] of points) {
        if (!Number.isFinite(f) || f <= 0) continue
        const group = this.manualGroup(part, p); const key = Math.min(...group.keys()); const falloff = Math.min(1, f)
        const prior = chosen.get(key)
        if (prior === undefined || falloff > prior.falloff || (falloff === prior.falloff &&
          preferred(this.offsets[part] + p, this.offsets[part] + prior.point))) {
          chosen.set(key, { point: p, falloff, group })
        }
      }
      const out = new Map<number, number>()
      for (const [key, { point, falloff, group }] of [...chosen].sort((a, b) => a[0] - b[0])) {
        const before = Math.max(0, ...[...group.keys()].map(key => {
          const q = this.owners[key]; return this.coverage[q].get(key - this.offsets[q]) ?? 0
        }))
        const winner = this.manualCoverage.get(key); const at = this.offsets[part] + point
        if (this.strokeSource !== null && (falloff < before || (falloff === before &&
          (winner === undefined || !preferred(at, winner))))) continue
        for (const key of group.keys()) {
          const q = this.owners[key]; this.coverage[q].set(key - this.offsets[q], falloff)
        }
        this.manualCoverage.set(key, at)
        out.set(point, falloff)
      }
      return out
    }
    const out = points instanceof LayerColumn ? new LayerColumn() : new Map<number, number>()
    if (out instanceof LayerColumn && points instanceof LayerColumn) for (const [p, a] of points.anchors) out.anchors.set(p, a)
    const mask = this.coverage[part]; const { twin, side } = this.parts[part]
    // Resolve both halves of a dab before writing either coverage mask. Otherwise a weak point visited first can
    // remain in the dab and overwrite its stronger twin when Mirror is applied later. Ties favour the body's left.
    const chosen = new Map<number, { point: number, falloff: number }>()
    for (const [p, f] of points) {
      if (!Number.isFinite(f) || f <= 0) continue
      const q = this.mirror ? twin.get(p) : undefined
      const key = q === undefined ? p : Math.min(p, q); const falloff = Math.min(1, f)
      const prior = chosen.get(key)
      if (prior === undefined || falloff > prior.falloff || (falloff === prior.falloff &&
        ((side.get(p) ?? 0) > (side.get(prior.point) ?? 0) || ((side.get(p) ?? 0) === (side.get(prior.point) ?? 0) && p < prior.point)))) {
        chosen.set(key, { point: p, falloff })
      }
    }
    for (const [, { point: p, falloff: f }] of [...chosen].sort((a, b) => a[0] - b[0])) {
      const q = this.mirror ? twin.get(p) : undefined
      if (this.strokeSource !== null && f <= Math.max(mask.get(p) ?? 0, q === undefined ? 0 : mask.get(q) ?? 0) + 1e-7) continue
      mask.set(p, f); if (q !== undefined) mask.set(q, f)
      out.set(p, f)
    }
    return out
  }

  /** A physical seam and its mirror aliases form one coverage group. Bits retain both orientations on the centre
   * line, so a centre point is evened once even when several material primitives duplicate it. */
  private manualGroup (part: number, p: number): Map<number, number> {
    const start = this.offsets[part] + p; const group = new Map<number, number>([[start, 1]]); const queue = [start]
    const visit = (key: number, flags: number): void => {
      const prior = group.get(key) ?? 0
      if ((prior | flags) !== prior) { group.set(key, prior | flags); queue.push(key) }
    }
    while (queue.length > 0) {
      const key = queue.pop()!; const q = this.owners[key]; const point = key - this.offsets[q]; const flags = group.get(key)!
      for (const alias of this.seams.get(key) ?? []) visit(alias, flags)
      if (!this.mirror) continue
      const swapped = ((flags & 1) << 1) | ((flags & 2) >> 1)
      const twin = this.parts[q].twin.get(point)
      if (twin !== undefined) visit(this.offsets[q] + twin, swapped)
      for (const twin of this.crossMirrors.get(key) ?? []) visit(twin, swapped)
    }
    return group
  }

  private writable (part: number, p: number): boolean {
    return (this.seams.get(this.offsets[part] + p) ?? [this.offsets[part] + p])
      .every(key => {
        const q = this.owners[key]
        return (this.editable === undefined || this.editable.has(this.parts[q].mesh)) &&
          !this.protectedPoints[q].has(key - this.offsets[q])
      })
  }

  private requirePaintStroke (): void {
    if (this.protectionStroke) throw new Error('Finish the protection stroke before editing weights, shape or area')
  }

  /** A point's weights set (on all its vertices): the four largest, summing to one. */
  private set (part: number, p: number, w: Weights, log: UndoStroke['changes'] | null, preserveTiny = false): void {
    this.requirePaintStroke()
    if (!this.writable(part, p)) return
    const g = this.parts[part].mesh.geometry
    const si = g.attributes.skinIndex as THREE.BufferAttribute; const sw = g.attributes.skinWeight as THREE.BufferAttribute
    const authored = preserveTiny ? [...w].filter(([, x]) => Number.isFinite(x) && x > 0).sort((a, b) => b[1] - a[1]) : []
    const total = authored.slice(0, 4).reduce((sum, [, x]) => sum + x, 0)
    // Explicit Copy side retains valid authored float values and tiny influences. A centre-line average can
    // introduce more than four bones; only that truncation (or a non-normalized source) needs normalization.
    const normalized = preserveTiny ? new Map(authored.slice(0, 4).map(([b, x]) =>
      [b, authored.length <= 4 && Math.abs(total - 1) < 1e-6 ? x : x / total])) : normalizedWeights(w)
    if (normalized.size === 0) return
    const top = [...normalized]
    const current = this.weights(part, p)
    if ([...new Set([...current.keys(), ...normalized.keys()])].every(b => preserveTiny
      ? (current.get(b) ?? 0) === (normalized.get(b) ?? 0)
      : Math.abs((current.get(b) ?? 0) - (normalized.get(b) ?? 0)) < 1e-7)) return
    const key = `w:${part}:${p}`
    if (log !== null && !this.logged.has(key)) {
      log.push({ part, point: p, skin: (this.parts[part].members.get(p) ?? [p]).map(vertex => ({
        vertex, index: [0, 1, 2, 3].map(k => si.getComponent(vertex, k)), weight: [0, 1, 2, 3].map(k => sw.getComponent(vertex, k)),
      })) })
      this.logged.add(key)
    }
    for (const v of this.parts[part].members.get(p) ?? [p]) {
      for (let k = 0; k < 4; k++) {
        si.setComponent(v, k, top[k]?.[0] ?? 0)
        sw.setComponent(v, k, top[k]?.[1] ?? 0)
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

  /** Explicit Copy side uses the whole source result, including across material primitives. All proposals are
   * mapped before writing, and a duplicated centre-line point is evened just once from its frozen source. */
  private follow (part: number, points: Iterable<number>): number {
    if (!this.mirror) return 0
    const next = new Map<number, Weights>()
    for (const p of points) {
      const source = this.sourceWeights(part, p); const swapped = this.swapped(part, source)
      for (const [key, flags] of this.manualGroup(part, p)) {
        if (flags === 1) continue // preserve the chosen side, including its authored raw slots
        const q = this.owners[key]; const map = this.boneMap(part, q); const target: Weights = new Map()
        const field = flags === 3 ? new Map([...new Set([...source.keys(), ...swapped.keys()])].map(b =>
          [b, ((source.get(b) ?? 0) + (swapped.get(b) ?? 0)) / 2])) : swapped
        if ([...field].some(([b, w]) => w > 0 && map[b] < 0)) continue
        for (const [b, w] of field) if (map[b] >= 0) target.set(map[b], w)
        next.set(key, target)
      }
    }
    return this.repairWeights(next, true).changed
  }

  /** Repair commands share physical seams without altering unrelated skin or any read-only copy. Return accepted
   * points separately from changed weights: healing already-correct skin still clears its selected area. */
  private repairWeights (next: Map<number, Weights>, preserveTiny = false): { accepted: Set<number>, changed: number } {
    const groups = new Set<number[]>()
    for (const key of next.keys()) groups.add(this.seams.get(key) ?? [key])
    for (const group of groups) {
      const from = this.owners[group[0]]; const expected = normalizedWeights(next.get(group[0]) ?? new Map())
      const valid = expected.size > 0 && group.every(key => {
        const q = this.owners[key]; const p = key - this.offsets[q]
        if (!this.writable(q, p) || !next.has(key)) return false
        const map = this.boneMap(from, q); const actual = normalizedWeights(next.get(key)!)
        if ([...expected].some(([b]) => map[b] < 0)) return false
        const mapped = new Map([...expected].map(([b, w]) => [map[b], w]))
        return [...new Set([...mapped.keys(), ...actual.keys()])].every(b => Math.abs((mapped.get(b) ?? 0) - (actual.get(b) ?? 0)) < 1e-7)
      })
      if (!valid) for (const key of group) next.delete(key)
    }
    let changed = 0
    for (const [key, w] of next) {
      const q = this.owners[key]; const p = key - this.offsets[q]; const before = this.weights(q, p)
      if ([...new Set([...before.keys(), ...w.keys()])].every(b => preserveTiny
        ? (before.get(b) ?? 0) === (w.get(b) ?? 0)
        : Math.abs((before.get(b) ?? 0) - (w.get(b) ?? 0)) < 1e-12)) continue
      this.set(q, p, w, this.log, preserveTiny)
      const after = this.weights(q, p)
      if ([...new Set([...before.keys(), ...after.keys()])].some(b => preserveTiny
        ? (before.get(b) ?? 0) !== (after.get(b) ?? 0)
        : Math.abs((before.get(b) ?? 0) - (after.get(b) ?? 0)) >= 1e-7)) changed++
    }
    return { accepted: new Set(next.keys()), changed }
  }

  /** A mirrored brush repeats its operation from each side's own source; copying an already-blended result can
   * erase a painted twin even at tiny Strength. Keep full result copying for explicit Copy side only. */
  private brushWeights (part: number, points: Map<number, number>, change: (part: number, p: number, f: number, mirrored: boolean) => Weights | null): void {
    this.requirePaintStroke()
    const next = new Map<number, Weights>()
    for (const [p, f] of points) {
      for (const [key, flags] of this.manualGroup(part, p)) {
        const q = this.owners[key]; const point = key - this.offsets[q]
        if (!this.writable(q, point)) continue
        const w = change(q, point, f, flags === 2)
        if (w === null) continue
        if (flags === 3) {
          const other = change(q, point, f, true)
          if (other === null) continue
          const even: Weights = new Map()
          for (const b of new Set([...w.keys(), ...other.keys()])) even.set(b, ((w.get(b) ?? 0) + (other.get(b) ?? 0)) / 2)
          next.set(key, even)
        } else next.set(key, w)
      }
    }
    // A missing bone or incompatible palette must pin a whole physical seam, rather than moving just one copy.
    const activeSeams = new Set<number[]>()
    for (const key of next.keys()) { const group = this.seams.get(key); if (group !== undefined) activeSeams.add(group) }
    for (const group of activeSeams) {
      const active = group.find(key => next.has(key))
      if (active === undefined) continue
      const from = this.owners[active]; const expected = normalizedWeights(next.get(active)!)
      const compatible = group.every(key => {
        if (!next.has(key)) return false
        const q = this.owners[key]; const map = this.boneMap(from, q); const actual = normalizedWeights(next.get(key)!)
        if ([...expected].some(([b]) => map[b] < 0)) return false
        const mapped = new Map([...expected].map(([b, w]) => [map[b], w]))
        return [...new Set([...mapped.keys(), ...actual.keys()])].every(b => Math.abs((mapped.get(b) ?? 0) - (actual.get(b) ?? 0)) < 1e-7)
      })
      if (!compatible) for (const key of group) next.delete(key)
    }
    const proposals = new Map<number, Map<number, Weights>>()
    for (const [key, w] of next) {
      const q = this.owners[key]; const p = key - this.offsets[q]; const source = this.sourceWeights(q, p)
      if ([...new Set([...source.keys(), ...w.keys()])].every(b => Math.abs((source.get(b) ?? 0) - (w.get(b) ?? 0)) < 1e-12)) continue
      if (!proposals.has(q)) proposals.set(q, new Map())
      proposals.get(q)!.set(p, w)
    }
    for (const [q, weights] of this.preserveStack(proposals)) for (const [p, w] of weights) this.set(q, p, w, this.log)
  }

  /** Share the sheet's TARGET across a stack, then blend each layer from its own stroke source. Copying the sheet's
   * already-blended result overwrites the lining wholesale even at zero Strength or a nearly-zero brush edge. */
  private applyLayers (part: number, points: Map<number, number>, targets: Map<number, Weights>, strength: number,
    field: (p: number) => Weights | null): void {
    const next = new Map<number, Weights>()
    const blend = (p: number, to: Weights, k: number): void => {
      this.requirePaintStroke()
      if (!this.writable(part, p)) return
      const from = this.sourceWeights(part, p); const out: Weights = new Map()
      for (const b of new Set([...from.keys(), ...to.keys()])) out.set(b, (1 - k) * (from.get(b) ?? 0) + k * (to.get(b) ?? 0))
      next.set(p, out)
      this.pending?.blends.set(this.offsets[part] + p, { target: to, strength: k })
    }
    for (const [p, f] of points) {
      let to = targets.get(p)
      if (to === undefined) continue // the covered body is a donor, never a receiver
      const k = THREE.MathUtils.clamp(strength * f, 0, 1)
      if (k <= 0) continue
      const anchor = points instanceof LayerColumn ? points.anchors.get(p) : undefined
      if (anchor !== undefined) {
        const shared: Weights = new Map()
        const lookup = anchor.part === part ? field : this.pending?.fields.get(anchor.part)
        const map = this.boneMap(anchor.part, part)
        anchor.points.forEach((q, i) => {
          const source = lookup?.(q)
          if (source === null || source === undefined) {
            for (const [b, w] of to!) shared.set(b, (shared.get(b) ?? 0) + w * anchor.bary[i])
          } else for (const [b, w] of source) if (map[b] >= 0) shared.set(map[b], (shared.get(map[b]) ?? 0) + w * anchor.bary[i])
        })
        if (shared.size > 0) to = this.centred(part, shared) // interpolation must not reintroduce opposing left/right pulls
      }
      // Mirror the target and coverage, not the blended result: a weak stroke must preserve the twin's own paint.
      const q = this.mirror ? this.parts[part].twin.get(p) : undefined
      if (q === p) {
        const swapped = this.swapped(part, to); const even: Weights = new Map()
        for (const b of new Set([...to.keys(), ...swapped.keys()])) even.set(b, ((to.get(b) ?? 0) + (swapped.get(b) ?? 0)) / 2)
        blend(p, even, k)
      } else {
        blend(p, to, k)
        if (q !== undefined) blend(q, this.swapped(part, to), k)
      }
    }
    if (this.pending !== null) {
      if (!this.pending.weights.has(part)) this.pending.weights.set(part, new Map())
      for (const [p, w] of next) this.pending.weights.get(part)!.set(p, w)
    }
    else for (const [p, w] of this.preserveSurface(part, next)) this.set(part, p, w, this.log)
  }

  private transforms (mesh: THREE.SkinnedMesh): THREE.Matrix4[] {
    return mesh.skeleton.bones.map((b, i) => new THREE.Matrix4().copy(mesh.matrixWorld).multiply(mesh.bindMatrixInverse)
      .multiply(b.matrixWorld).multiply(mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix))
  }

  /** Guard on a copy of the animation rig. No sampling may seek the user's player or alter live bone transforms. */
  private prepareGuard (animation?: GuardAnimation): void {
    this.guardRest = this.strokeShape ?? this.parts.map(p => p.rest.slice())
    const pose = (transforms: THREE.Matrix4[][]): GuardPose => ({ transforms, before: this.parts.map(() => new Map()),
      faces: this.parts.map(() => new Map()), layers: this.parts.map(() => new Map()) })
    this.guardPoses = [pose(this.parts.map(({ mesh }) => this.transforms(mesh)))]
    if (animation?.clip === null || animation?.clip === undefined) return
    const original: THREE.Object3D[] = []; animation.root.traverse(o => { original.push(o) })
    const root = cloneSkinned(animation.root); const copies: THREE.Object3D[] = []; root.traverse(o => { copies.push(o) })
    // The root can itself sit under a scaled/rotated stage or mount. Preserve that parent frame in the private copy.
    const frame = new THREE.Group(); frame.matrixAutoUpdate = false
    if (animation.root.parent !== null) frame.matrix.copy(animation.root.parent.matrixWorld)
    frame.add(root)
    const meshes = this.parts.map(({ mesh }) => copies[original.indexOf(mesh)] as THREE.SkinnedMesh | undefined)
    if (meshes.some(m => m?.isSkinnedMesh !== true)) return
    const saved: Array<{ o: THREE.Object3D, p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3 }> = []
    root.traverse(o => { saved.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }) })
    const mixer = new THREE.AnimationMixer(root)
    const action = mixer.clipAction(animation.clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play()
    // Include quarter-frame samples for ordinary 30 fps clips. Real upper-coat strokes crossed between 60 Hz probes.
    // Bound long-clip work; this remains sampled validation, rather than continuous collision detection.
    const duration = animation.clip.duration
    const step = Math.max(1 / 120, duration / 240)
    const times = new Set([0, duration, ...[.5, .4, .65, .3, .8, .2, .1].map(u => u * duration)])
    for (let t = step; t < duration; t += step) times.add(t)
    for (const time of times) {
      for (const s of saved) { s.o.position.copy(s.p); s.o.quaternion.copy(s.q); s.o.scale.copy(s.s) }
      action.reset().play() // the previous sample may have clamped at the clip end
      mixer.setTime(time); frame.updateMatrixWorld(true)
      this.guardPoses.push(pose(meshes.map(mesh => this.transforms(mesh!))))
    }
    mixer.stopAllAction(); mixer.uncacheRoot(root)
  }

  private skinPoint (part: number, p: number, w: Weights, transforms: THREE.Matrix4[], at?: THREE.Vector3): THREE.Vector3 {
    const rest = this.parts[part].rest
    const x = at?.x ?? rest[p * 3]; const y = at?.y ?? rest[p * 3 + 1]; const z = at?.z ?? rest[p * 3 + 2]
    const out = new THREE.Vector3()
    for (const [b, weight] of w) {
      const e = transforms[b].elements
      const scale = weight / (e[3] * x + e[7] * y + e[11] * z + e[15])
      out.x += (e[0] * x + e[4] * y + e[8] * z + e[12]) * scale
      out.y += (e[1] * x + e[5] * y + e[9] * z + e[13]) * scale
      out.z += (e[2] * x + e[6] * y + e[10] * z + e[14]) * scale
    }
    return out
  }

  /** Keep a proposed weight field intact through the sampled clip, including four-bone truncation. */
  private preserveSurface (part: number, proposed: Map<number, Weights>): Map<number, Weights> {
    return this.preserveStack(new Map([[part, proposed]])).get(part) ?? new Map()
  }

  private preserveStack (proposals: Map<number, Map<number, Weights>>): Map<number, Map<number, Weights>> {
    if (this.protectedCount > 0) proposals = new Map([...proposals].map(([q, weights]) =>
      [q, new Map([...weights].filter(([p]) => this.writable(q, p)))]))
    if (this.guardPoses.length === 0) return proposals
    const current = new Map<number, Weights>(); const sources = new Map<number, Weights>(); const targets = new Map<number, Weights>()
    const points = new Map<number, Set<number>>()
    for (const [part, proposed] of proposals) for (const [p, w] of proposed) {
      if (!this.writable(part, p)) continue
      const before = this.weights(part, p); const after = normalizedWeights(w)
      if (![...new Set([...before.keys(), ...after.keys()])].some(b => Math.abs((before.get(b) ?? 0) - (after.get(b) ?? 0)) >= 1e-7)) continue
      const key = this.offsets[part] + p
      current.set(key, before); sources.set(key, this.sourceWeights(part, p)); targets.set(key, after)
      if (!points.has(part)) points.set(part, new Set())
      points.get(part)!.add(p)
    }
    const mixed = new Map<number, Map<number, Weights>>()
    const weightsAt = (key: number, alpha: number): Weights => {
      if (alpha === 0) return current.get(key)!
      let cached = mixed.get(key)
      if (cached === undefined) { cached = new Map(); mixed.set(key, cached) }
      if (!cached.has(alpha)) {
        // Recompute a bounded requested blend from its fixed source. Reblending from an already capped live result
        // would accumulate extra strength when weaker dabs precede the centre. A zero cap retains current data.
        const from = sources.get(key)!; const to = targets.get(key)!; const w: Weights = new Map()
        for (const b of new Set([...from.keys(), ...to.keys()])) w.set(b, (1 - alpha) * (from.get(b) ?? 0) + alpha * (to.get(b) ?? 0))
        cached.set(alpha, normalizedWeights(w))
      }
      return cached.get(alpha)!
    }
    const caps = this.surfaceStackSteps(points, (q, p, alpha, transforms) => this.skinPoint(q, p, weightsAt(this.offsets[q] + p, alpha), transforms))
    const accepted = new Map<number, Map<number, Weights>>()
    for (const [key, alpha] of caps) if (alpha > 0) {
      const part = this.owners[key]
      if (!accepted.has(part)) accepted.set(part, new Map())
      accepted.get(part)!.set(key - this.offsets[part], weightsAt(key, alpha))
    }
    return accepted
  }

  /** Reject inversions, severe area loss and edge spikes from either weight or shape proposals. Limits are local,
   * with a fixed stroke baseline; a damaged triangle cannot disable unrelated brush points. */
  private surfaceSteps (part: number, proposed: ReadonlySet<number>, at: (p: number, alpha: number, transforms: THREE.Matrix4[]) => THREE.Vector3): Map<number, number> {
    const caps = this.surfaceStackSteps(new Map([[part, proposed]]), (_q, p, alpha, transforms) => at(p, alpha, transforms))
    return new Map([...caps].map(([key, alpha]) => [key - this.offsets[part], alpha]))
  }

  /** One set of proposals, evaluated together before any receiving mesh is written. Keys are private flattened
   * point addresses; saved edits retain their original mesh/vertex indices. */
  private surfaceStackSteps (proposals: ReadonlyMap<number, ReadonlySet<number>>,
    at: (part: number, p: number, alpha: number, transforms: THREE.Matrix4[]) => THREE.Vector3): Map<number, number> {
    const steps = this.surfaceStackIterations(proposals, at)
    let next = steps.next()
    while (!next.done) next = steps.next()
    return next.value
  }

  /** The synchronous and cooperative release paths evaluate exactly the same constraints and limits. */
  private *surfaceStackIterations (proposals: ReadonlyMap<number, ReadonlySet<number>>,
    at: (part: number, p: number, alpha: number, transforms: THREE.Matrix4[]) => THREE.Vector3): Generator<void, Map<number, number>, void> {
    if (this.protectedCount > 0) proposals = new Map([...proposals].map(([q, points]) =>
      [q, new Set([...points].filter(p => this.writable(q, p)))]))
    const key = (q: number, p: number): number => this.offsets[q] + p
    const local = (p: number): number => p - this.offsets[this.owners[p]]
    const proposed = new Set([...proposals].flatMap(([q, points]) => [...points].map(p => key(q, p))))
    const caps = new Map([...proposed].map(p => [p, 1]))
    if (this.guardPoses.length === 0 || proposed.size === 0) return caps
    const layers = this.parts.flatMap((_, q) => this.separations(q).map(pair => ({ ...pair, original: pair,
      point: key(q, pair.point), points: pair.points.map(p => key(pair.facePart, p)) })))
      .filter(pair => proposed.has(pair.point) || pair.points.some(p => proposed.has(p)))
    const orientation = this.parts.map(({ mesh }) => Math.sign(mesh.matrixWorld.determinant()) || 1)
    const normalMatrices = this.parts.map(({ mesh }) => new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
    const restGaps = layers.map(pair => pair.gap / Math.max(pair.normal.clone().applyMatrix3(normalMatrices[pair.facePart]).length(), 1e-12))
    const faces: Array<{ part: number, id: number, pts: number[], active: number[], restArea: number, restEdges: number[] }> = []
    const contactFaces: Array<[number, number, number]> = []
    for (const [q, part] of this.parts.entries()) {
      const tris = this.restOf(q).tris
      for (let f = 0; f < tris.length; f += 3) {
        const pts = [0, 1, 2].map(k => key(q, part.point[tris[f + k]])) as [number, number, number]
        if (new Set(pts).size === 3) contactFaces.push(pts)
      }
    }
    for (const [part, points] of proposals) {
      const { point, rest, mesh } = this.parts[part]; const r = this.restOf(part)
      const reference = this.guardRest?.[part] ?? rest
      for (let f = 0; f < r.tris.length; f += 3) {
        const pts = [point[r.tris[f]], point[r.tris[f + 1]], point[r.tris[f + 2]]]
        if (!pts.some(p => points.has(p))) continue
        const [a, b, c] = pts.map(p => new THREE.Vector3().fromArray(reference, p * 3).applyMatrix4(mesh.matrixWorld))
        const encoded = pts.map(p => key(part, p))
        faces.push({ part, id: f, pts: encoded, active: encoded.filter(p => proposed.has(p)), restArea: b.clone().sub(a).cross(c.clone().sub(a)).length(),
          restEdges: [a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a)] })
      }
    }
    const activeLayers = layers.map(pair => [pair.point, ...pair.points].filter(p => proposed.has(p)))
    const height = Math.max(...this.parts.map((_, q) => this.restOf(q).height))
    const separation = (pair: LayerPair, read: (p: number) => THREE.Vector3): number => {
      const a = read(pair.points[0]); const b = read(pair.points[1]); const c = read(pair.points[2]); const p = read(pair.point)
      const ux = b.x - a.x; const uy = b.y - a.y; const uz = b.z - a.z
      const vx = c.x - a.x; const vy = c.y - a.y; const vz = c.z - a.z
      const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx
      const size = Math.hypot(nx, ny, nz)
      if (size < 1e-12) return 0
      const [i, j, k] = pair.bary
      return ((p.x - a.x * i - b.x * j - c.x * k) * nx + (p.y - a.y * i - b.y * j - c.y * k) * ny +
        (p.z - a.z * i - b.z * j - c.z * k) * nz) / size * pair.side * orientation[pair.facePart]
    }
    let contactTopology = this.guardPoses.find(pose => pose.contacts !== undefined)?.contacts
    // Weight fields and reference positions do not depend on the sampled pose. Keep their snapshots once for this
    // proposal instead of rebuilding maps for every pose; only the bone transforms vary during validation.
    const sourceWeights = new Map<number, Weights>(); const currentWeights = new Map<number, Weights>()
    const referencePoints = new Map<number, THREE.Vector3>()
    const frameFor = (pose: GuardPose) => {
      const before = (encoded: number): THREE.Vector3 => {
        const q = this.owners[encoded]; const p = local(encoded); const base = pose.before[q]
        if (!base.has(p)) {
          if (!sourceWeights.has(encoded)) sourceWeights.set(encoded, this.sourceWeights(q, p))
          if (!referencePoints.has(encoded)) referencePoints.set(encoded, new THREE.Vector3().fromArray(this.guardRest?.[q] ?? this.parts[q].rest, p * 3))
          base.set(p, this.skinPoint(q, p, sourceWeights.get(encoded)!, pose.transforms[q], referencePoints.get(encoded)!))
        }
        return base.get(p)!
      }
      // Keep unchanged/capped positions across local limit iterations. Only recompute a point when its cap changes.
      const after = new Map<number, { alpha: number, position: THREE.Vector3 }>()
      const now = (p: number): THREE.Vector3 => {
        const alpha = caps.get(p) ?? -1; const prior = after.get(p)
        if (prior?.alpha === alpha) return prior.position
        const q = this.owners[p]; const v = local(p); const transforms = pose.transforms[q]
        if (alpha < 0 && !currentWeights.has(p)) currentWeights.set(p, this.weights(q, v))
        const position = alpha >= 0 ? at(q, v, alpha, transforms) : this.skinPoint(q, v, currentWeights.get(p)!, transforms)
        after.set(p, { alpha, position }); return position
      }
      const metrics = faces.map(face => {
        let metric = pose.faces[face.part].get(face.id)
        if (metric === undefined) {
          const [a, b, c] = face.pts.map(before); const normal = b.clone().sub(a).cross(c.clone().sub(a))
          metric = { normal, area: normal.length(), edges: [a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a)] }
          pose.faces[face.part].set(face.id, metric)
        }
        return metric
      })
      const floors = layers.map((pair, i) => {
        let floor = pose.layers[pair.part].get(pair.original)
        if (floor === undefined) {
          const was = separation(pair, before)
          floor = was > 0 ? Math.min(was * .98, restGaps[i] * .25) : was - Math.abs(was) * .02
          pose.layers[pair.part].set(pair.original, floor)
        }
        return floor
      })
      pose.contacts ??= contactTopology === undefined
        ? new SurfaceContacts(contactFaces, p => Math.min(...(this.seams.get(p) ?? [p])))
        : new SurfaceContacts(contactTopology)
      contactTopology ??= pose.contacts
      return { now, before, metrics, floors, contacts: pose.contacts }
    }
    const frames: Array<ReturnType<typeof frameFor>> = []
    for (const pose of this.guardPoses) { frames.push(frameFor(pose)); yield }
    for (let iteration = 0; iteration < 24; iteration++) {
      const bad = new Set<number>()
      for (const { now, before, metrics, floors, contacts } of frames) {
        for (let f = 0; f < faces.length; f++) {
          const face = faces[f]; const metric = metrics[f]
          // Once every moving corner is already scheduled for reduction, more failures cannot change this pass.
          // It will be checked again with the new caps; no pose or constraint is removed from final acceptance.
          if (face.active.every(p => bad.has(p))) continue
          const { pts } = face
          const x = now(pts[0]); const y = now(pts[1]); const z = now(pts[2])
          const ux = y.x - x.x; const uy = y.y - x.y; const uz = y.z - x.z
          const vx = z.x - x.x; const vy = z.y - x.y; const vz = z.z - x.z
          const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx
          const area1 = Math.hypot(nx, ny, nz)
          let safe = !(metric.area > 1e-12 && (area1 < Math.min(metric.area * .98, face.restArea * .25) - 1e-12 ||
            metric.normal.x * nx + metric.normal.y * ny + metric.normal.z * nz < .05 * metric.area * area1))
          if (x.distanceToSquared(y) > Math.max(metric.edges[0] * 1.02, face.restEdges[0] * 4, 1e-12) + 1e-12 ||
            y.distanceToSquared(z) > Math.max(metric.edges[1] * 1.02, face.restEdges[1] * 4, 1e-12) + 1e-12 ||
            z.distanceToSquared(x) > Math.max(metric.edges[2] * 1.02, face.restEdges[2] * 4, 1e-12) + 1e-12) safe = false
          if (!safe) for (const p of pts) if (proposed.has(p)) bad.add(p)
        }
        // Intact triangles can still pass through another intact sheet. Keep each rest-adjacent point on its own
        // side of the material triangle below it, including when only the triangle's other corners were brushed.
        for (let i = 0; i < layers.length; i++) {
          const pair = layers[i]
          if (activeLayers[i].every(p => bad.has(p))) continue
          if (separation(pair, now) < floors[i] - 1e-8 * height) {
            for (const p of [pair.point, ...pair.points]) if (proposed.has(p)) bad.add(p)
          }
        }
        // The local normal/area checks and rest-layer rays cannot see a different leg or a distant fold entering
        // an intact triangle. Check the actual posed triangles together, including read-only body primitives.
        for (const p of yield * contacts.newContactSteps(proposed, now, before, iteration === 0, bad)) {
          bad.add(p); this.contactLimited.add(p)
        }
        yield
      }
      if (bad.size === 0) return caps
      for (const p of bad) {
        for (const alias of this.seams.get(p) ?? []) if (proposed.has(alias)) bad.add(alias)
        if (!this.mirror) continue
        const part = this.owners[p]; const twin = this.parts[part].twin.get(local(p))
        if (twin !== undefined && proposed.has(key(part, twin))) bad.add(key(part, twin))
        for (const q of this.crossMirrors.get(p) ?? []) if (proposed.has(q)) bad.add(q)
      }
      let changed = false
      for (const p of bad) {
        this.limited.add(`${this.owners[p]}:${local(p)}`)
        const alpha = caps.get(p)!
        if (alpha === 0) continue
        caps.set(p, alpha <= 1 / 4096 ? 0 : alpha / 2); changed = true
      }
      if (!changed) break
    }
    return new Map()
  }

  /** The whole other side set from one (`from`: the body's left, +1, or its right, -1): one undo step. Returns the
   * points set. */
  copySide (from: 1 | -1): number {
    this.begin({ bounded: true })
    const mirror = this.mirror; this.mirror = true
    let changed = 0
    try {
      const seen = new Set<number>()
      for (const [part, { members, side }] of this.parts.entries()) for (const p of members.keys()) {
        if (side.get(p) !== from && side.get(p) !== 0) continue
        const group = this.manualGroup(part, p); const id = Math.min(...group.keys())
        if (seen.has(id)) continue
        seen.add(id)
        const source = [...group.keys()].filter(key => {
          const q = this.owners[key]; return this.parts[q].side.get(key - this.offsets[q]) === from
        }).sort((a, b) => a - b)[0] ?? [...group.keys()].filter(key => {
          const q = this.owners[key]; return this.parts[q].side.get(key - this.offsets[q]) === 0
        }).sort((a, b) => a - b)[0]
        if (source === undefined) continue
        const q = this.owners[source]
        changed += this.follow(q, [source - this.offsets[q]])
      }
    } finally {
      this.mirror = mirror; this.end()
    }
    return changed
  }

  /** Where each point of a part is now (the body as it stands, in world space). */
  private posed (part: number): Map<number, THREE.Vector3> {
    const cached = this.poseQuery?.get(part)
    if (cached !== undefined) return cached
    const { mesh, members } = this.parts[part]
    mesh.updateMatrixWorld(true)
    const out = new Map<number, THREE.Vector3>()
    const v = new THREE.Vector3()
    for (const p of members.keys()) {
      mesh.getVertexPosition(p, v)
      out.set(p, v.clone().applyMatrix4(mesh.matrixWorld))
    }
    this.poseQuery?.set(part, out)
    return out
  }

  /** Pick and measure one surface footprint from one posed snapshot. The cache exists only for this synchronous
   * query, so animation, sculpting, and subsequent weight changes never leave stale picking geometry behind. */
  pick (ray: THREE.Ray, radius: number, held?: { part: number, sheet: ReadonlySet<number> }, crossMaterials = true): PaintPick | null {
    this.poseQuery = this.strokeSurface ?? new Map()
    try {
      const hits = this.raycast(ray, crossMaterials ? undefined : held?.part)
      const hit = held === undefined ? hits[0] : held.sheet.size === 0 ? hits.find(h => h.part === held.part) : hits.find(h => {
        if (h.part === held.part) return this.continuesStroke(h.part, h.point, h.face, held.sheet, radius)
        const boundary = new Set<number>()
        for (const edge of this.materialEdges) {
          if (edge.fromPart === held.part && edge.toPart === h.part && edge.from.every(p => held.sheet.has(p))) {
            for (const p of edge.to) boundary.add(p)
          }
        }
        return boundary.size > 0 && this.continuesStroke(h.part, h.point, h.face, boundary, radius)
      })
      return hit === undefined ? null : { ...hit, points: this.under(hit.part, hit.point, radius, hit.face) }
    } finally {
      this.poseQuery = null
    }
  }

  /** All surface hits, preserving the source triangle and vertex numbering. A private posed BVH is refitted after
   * skinning; building it must never reorder the live mesh that saved weight/shape edits address by vertex. */
  raycast (ray: THREE.Ray, onlyPart?: number): PaintHit[] {
    const hits: PaintHit[] = []
    this.parts.forEach(({ mesh }, part) => {
      if (onlyPart !== undefined && part !== onlyPart) return
      const posed = this.posed(part)
      let tree = this.posedTrees.get(part)
      if (tree === undefined) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(mesh.geometry.attributes.position.count * 3), 3))
        if (mesh.geometry.index !== null) geometry.setIndex(mesh.geometry.index.clone())
        const position = geometry.attributes.position
        for (let v = 0; v < position.count; v++) {
          const p = posed.get(this.parts[part].point[v])!
          position.setXYZ(v, p.x, p.y, p.z)
        }
        tree = { geometry, bvh: new MeshBVH(geometry, { indirect: true }) }
        this.posedTrees.set(part, tree)
      } else {
        const position = tree.geometry.attributes.position
        for (let v = 0; v < position.count; v++) {
          const p = posed.get(this.parts[part].point[v])!
          position.setXYZ(v, p.x, p.y, p.z)
        }
        tree.bvh.refit()
      }
      for (const h of tree.bvh.raycast(ray, THREE.DoubleSide)) {
        if (h.face === undefined || h.face === null) continue
        const face: [number, number, number] = [h.face.a, h.face.b, h.face.c]
        const [a, b, c] = face.map(v => posed.get(this.parts[part].point[v])!)
        const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
        if (normal.dot(ray.direction) > 0) normal.negate()
        hits.push({ part, face, point: h.point, normal, distance: h.distance })
      }
    })
    return hits.sort((a, b) => a.distance - b.distance)
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

  /** Continue from the last dab, including its triangle when a small brush reaches no vertices. Whole-stroke history
   * would let a stroke jump back onto another fold near somewhere it painted much earlier. */
  continuesStroke (part: number, at: THREE.Vector3, face: readonly number[], previous: ReadonlySet<number>, radius: number): boolean {
    if (face.some(v => previous.has(this.parts[part].point[v]))) return true
    for (const p of this.under(part, at, radius * 2, face).keys()) if (previous.has(p)) return true
    return false
  }

  /** The connected surface of a part a vertex is on: one number for a whole sheet (a cape, a shirt, the body under
   * them when they are one mesh), so a stroke can keep to the surface it began on. */
  surface (part: number, vertex: number): number {
    const { point, adj, members } = this.parts[part]
    let label = this.surfaces[part]
    if (label === undefined) {
      label = new Int32Array(point.length).fill(-1)
      let n = 0
      for (const start of members.keys()) {
        if (label[start] >= 0) continue
        label[start] = n
        const stack = [start]
        while (stack.length > 0) {
          for (const q of adj.get(stack.pop()!) ?? []) if (label[q] < 0) { label[q] = n; stack.push(q) }
        }
        n++
      }
      this.surfaces[part] = label
    }
    return label[point[vertex]]
  }

  /** A stroke begins (one undo step). Bounded painting blends from a frozen source with maximum coverage; direct
   * scripted operations default to iterative dabs. */
  begin (options: { bounded?: boolean, stableSurface?: boolean, preserveSurface?: boolean, deferClip?: boolean, animation?: GuardAnimation } = {}): void {
    if (this.validating) throw new Error('Wait for the stroke check to finish')
    if (this.strokeOpen && this.protectionStroke) throw new Error('Finish the protection stroke before starting another stroke')
    this.strokeOpen = true; this.protectionStroke = false
    this.strokeVersion++
    this.strokeSurface = null
    if (options.stableSurface === true) this.strokeSurface = new Map(this.parts.map((_, q) => [q, this.posed(q)]))
    this.strokeShape = options.bounded === true || options.preserveSurface === true ? this.parts.map(p => p.rest.slice()) : null
    this.undo.push({ changes: [], edited: this.edited.map(s => new Set(s)), shaped: this.shaped.map(s => new Set(s)), area: this.area.map(s => new Map(s)),
      protectedPoints: this.protectedPoints.map(points => new Set(points)) })
    this.strokeBone = null; this.strokePart = null; this.logged.clear()
    this.strokeSource = options.bounded === true || options.preserveSurface === true ? this.parts.map(({ mesh }) => {
      const index = mesh.geometry.attributes.skinIndex; const weight = mesh.geometry.attributes.skinWeight
      return {
        index: Float32Array.from({ length: index.count * 4 }, (_, k) => index.getComponent(k >> 2, k & 3)),
        weight: Float32Array.from({ length: weight.count * 4 }, (_, k) => weight.getComponent(k >> 2, k & 3)),
      }
    }) : null
    for (const mask of [...this.coverage, ...this.shapeCoverage]) mask.clear()
    this.manualCoverage.clear()
    this.limited.clear(); this.contactLimited.clear(); this.guardPoses = []; this.guardRest = null
    this.releaseAnimation = options.preserveSurface === true && options.deferClip === true && options.animation?.clip != null ? options.animation : null
    if (options.preserveSurface === true) this.prepareGuard(this.releaseAnimation === null ? options.animation : undefined)
  }

  /** Validate a provisional drag as ONE proposal over the clip. Candidate evaluations use the exact stroke source;
   * keep the preview visible until the final commit, and restore raw source records before applying any limits. */
  private *finishClipGuard (): Generator<void, void, void> {
    const animation = this.releaseAnimation; this.releaseAnimation = null
    const last = this.undo[this.undo.length - 1]
    if (animation === null || last === undefined) return
    const targets = new Map<number, { weights?: Weights, position?: THREE.Vector3 }>()
    const moved = new Set<number>()
    for (const change of last.changes) {
      const { part, point, skin, positions } = change
      if (!this.writable(part, point)) continue
      const { mesh, rest } = this.parts[part]; const a = mesh.geometry.attributes
      const weightsChanged = skin?.some(v => [0, 1, 2, 3].some(k =>
        !Object.is(a.skinIndex.getComponent(v.vertex, k), v.index[k]) || !Object.is(a.skinWeight.getComponent(v.vertex, k), v.weight[k]))) === true
      const shapeChanged = positions?.some(v => v.at.some((x, k) => !Object.is(a.position.getComponent(v.vertex, k), x))) === true
      if (weightsChanged || shapeChanged) {
        const key = this.offsets[part] + point; const target = targets.get(key) ?? {}
        if (weightsChanged) target.weights = this.weights(part, point)
        if (shapeChanged) target.position = new THREE.Vector3().fromArray(rest, point * 3)
        targets.set(key, target)
      }
    }
    if (targets.size > 0) {
      this.prepareGuard(animation)
      const proposals = new Map<number, Set<number>>()
      for (const key of targets.keys()) {
        const q = this.owners[key]
        if (!proposals.has(q)) proposals.set(q, new Set())
        proposals.get(q)!.add(key - this.offsets[q])
      }
      const sources = new Map<number, Weights>()
      const weightBlends = new Map<number, Map<number, Weights>>()
      const shapeBlends = new Map<number, Map<number, THREE.Vector3>>()
      const weightsAt = (q: number, p: number, alpha: number): Weights => {
        const key = this.offsets[q] + p
        if (!sources.has(key)) sources.set(key, this.sourceWeights(q, p))
        const from = sources.get(key)!; const to = targets.get(key)?.weights
        if (to === undefined || alpha === 0) return from
        let cached = weightBlends.get(key)
        if (cached === undefined) { cached = new Map(); weightBlends.set(key, cached) }
        if (!cached.has(alpha)) cached.set(alpha, normalizedWeights(new Map([...new Set([...from.keys(), ...to.keys()])].map(b => [b, (1 - alpha) * (from.get(b) ?? 0) + alpha * (to.get(b) ?? 0)]))))
        return cached.get(alpha)!
      }
      const positionAt = (q: number, p: number, alpha: number): THREE.Vector3 => {
        const key = this.offsets[q] + p
        let cached = shapeBlends.get(key)
        if (cached === undefined) { cached = new Map(); shapeBlends.set(key, cached) }
        if (!cached.has(alpha)) {
          const from = new THREE.Vector3().fromArray(this.strokeShape![q], p * 3); const to = targets.get(key)?.position
          cached.set(alpha, to === undefined ? from : from.lerp(to, alpha))
        }
        return cached.get(alpha)!
      }
      const caps = yield * this.surfaceStackIterations(proposals, (q, p, alpha, transforms) => this.skinPoint(q, p, weightsAt(q, p, alpha), transforms, positionAt(q, p, alpha)))
      // Commit once, after the cooperative check. No partially restored or partially limited mesh is shown.
      for (const { part, skin, positions } of last.changes) {
        const { mesh, rest } = this.parts[part]; const a = mesh.geometry.attributes
        if (skin !== undefined) {
          for (const v of skin) for (let k = 0; k < 4; k++) { a.skinIndex.setComponent(v.vertex, k, v.index[k]); a.skinWeight.setComponent(v.vertex, k, v.weight[k]) }
          a.skinIndex.needsUpdate = true; a.skinWeight.needsUpdate = true
        }
        if (positions !== undefined) {
          for (const v of positions) { a.position.setXYZ(v.vertex, ...v.at); rest.set(v.at, v.vertex * 3) }
          moved.add(part)
        }
      }
      for (const [key, alpha] of caps) if (alpha > 0) {
        const q = this.owners[key]; const p = key - this.offsets[q]; const target = targets.get(key)!
        if (target.weights !== undefined) this.set(q, p, weightsAt(q, p, alpha), this.log)
        if (target.position !== undefined) { this.place(q, p, positionAt(q, p, alpha).toArray()); this.shaped[q].add(p); moved.add(q) }
      }
    }
    for (const part of moved) this.reshaped(part)
  }

  /** Finish deferred clip validation, release stroke snapshots and omit empty gestures from Undo. */
  end (): void {
    if (this.validating) throw new Error('Wait for the stroke check to finish')
    try { const steps = this.finishClipGuard(); while (!steps.next().done) { /* direct callers retain synchronous validation */ } }
    catch (error) { this.stepBack(); throw error }
    this.finishStroke()
  }

  /** Yield between pose checks so the editor can redraw and cancel large strokes. Serialization stays locked until
   * the whole check commits; Undo/discard invalidates the generation and prevents a late result touching new work. */
  async endAsync (yieldTask: () => Promise<void> = async () => await new Promise(resolve => setTimeout(resolve, 0))): Promise<boolean> {
    if (this.validating) throw new Error('Wait for the stroke check to finish')
    const version = this.strokeVersion
    this.validating = true
    const steps = this.finishClipGuard()
    try {
      await yieldTask()
      let yieldedAt = performance.now()
      while (version === this.strokeVersion) {
        const next = steps.next()
        if (next.done) { this.finishStroke(); return true }
        if (performance.now() - yieldedAt >= 8) { await yieldTask(); yieldedAt = performance.now() }
      }
      return false
    } catch (error) {
      if (version === this.strokeVersion) this.stepBack()
      throw error
    } finally {
      steps.return()
      if (version === this.strokeVersion) this.validating = false
    }
  }

  private finishStroke (): void {
    const last = this.undo[this.undo.length - 1]
    if (last !== undefined) last.changes = last.changes.filter(change => {
      const attributes = this.parts[change.part].mesh.geometry.attributes
      const skinSame = change.skin === undefined || change.skin.every(v => [0, 1, 2, 3].every(k =>
        Object.is(attributes.skinIndex.getComponent(v.vertex, k), v.index[k]) && Object.is(attributes.skinWeight.getComponent(v.vertex, k), v.weight[k])))
      const shapeSame = change.positions === undefined || change.positions.every(v => [0, 1, 2].every(k => Object.is(attributes.position.getComponent(v.vertex, k), v.at[k])))
      if (change.skin !== undefined && skinSame) {
        if (last.edited[change.part].has(change.point)) this.edited[change.part].add(change.point)
        else this.edited[change.part].delete(change.point)
      }
      if (change.positions !== undefined && shapeSame) {
        if (last.shaped[change.part].has(change.point)) this.shaped[change.part].add(change.point)
        else this.shaped[change.part].delete(change.point)
      }
      return !skinSame || !shapeSame
    })
    if (last !== undefined && last.changes.length === 0 && this.area.every((a, part) =>
      a.size === last.area[part].size && [...a].every(([p, f]) => last.area[part].get(p) === f)) &&
      this.protectedPoints.every((points, part) => points.size === last.protectedPoints[part].size &&
        [...points].every(p => last.protectedPoints[part].has(p)))) this.undo.pop()
    this.strokeSource = null; this.logged.clear(); this.guardPoses = []; this.guardRest = null
    this.strokeSurface = null
    this.strokeShape = null
    this.strokeOpen = false; this.protectionStroke = false
  }
  /** The bone a Bone stroke holds to (picked on its first dab). */
  private strokeBone: number | null = null
  private strokePart: number | null = null
  private get log (): UndoStroke['changes'] | null { return this.undo[this.undo.length - 1]?.changes ?? null }

  mark (part: number, points: Map<number, number>, on = true): void {
    this.requirePaintStroke()
    if (this.validating) throw new Error('Wait for the stroke check to finish')
    if (this.editable !== undefined && !this.editable.has(this.parts[part].mesh)) return
    for (const [p, f] of points) {
      if (!Number.isFinite(f) || f <= 0) continue
      const group = this.manualGroup(part, p)
      const coverage = Math.max(Math.min(1, f), ...[...group.keys()].map(key => {
        const q = this.owners[key]; return this.area[q].get(key - this.offsets[q]) ?? 0
      }))
      for (const key of group.keys()) {
        const q = this.owners[key]; const point = key - this.offsets[q]
        if (!this.writable(q, point)) continue
        if (on) this.area[q].set(point, coverage)
        else this.area[q].delete(point)
      }
    }
  }
  clearArea (): void {
    this.requirePaintStroke()
    if (this.validating) throw new Error('Wait for the stroke check to finish')
    for (const a of this.area) a.clear()
  }

  /** Protect or erase points in a mask-only begin/end gesture. Physical seam copies and enabled mirror aliases
   * share the mask; protection never follows a layer column onto a separate donor or receiving sheet. */
  protect (part: number, points: ReadonlyMap<number, number>, on = true): void {
    if (this.validating) throw new Error('Wait for the stroke check to finish')
    if (!this.strokeOpen) throw new Error('Begin a protection stroke before changing protection')
    const last = this.undo[this.undo.length - 1]!
    if (this.releaseAnimation !== null || this.guardPoses.length > 0 || last.changes.length > 0 ||
      this.area.some((area, q) => area.size !== last.area[q].size || [...area].some(([p, f]) => last.area[q].get(p) !== f))) {
      throw new Error('Finish the weight, shape or area stroke before changing protection')
    }
    this.protectionStroke = true
    const surface = this.parts[part]
    if (surface === undefined) return
    for (const [vertex, coverage] of points) {
      if (!Number.isFinite(coverage) || coverage <= 0 || !Number.isInteger(vertex) || vertex < 0 || vertex >= surface.point.length) continue
      const p = surface.point[vertex]
      for (const key of this.manualGroup(part, p).keys()) {
        const q = this.owners[key]; const point = key - this.offsets[q]
        if (on) this.protectedPoints[q].add(point)
        else this.protectedPoints[q].delete(point)
      }
    }
  }

  /** Clearing protection is one independent Undo step; saved weight/shape payloads never contain this mask. */
  clearProtection (): void {
    if (this.validating) throw new Error('Wait for the stroke check to finish')
    if (this.strokeOpen) throw new Error('Finish the current stroke before clearing protection')
    if (this.protectedCount === 0) return
    this.begin()
    this.protectionStroke = true
    for (const points of this.protectedPoints) points.clear()
    this.end()
  }

  add (part: number, points: Map<number, number>, bone: number, strength: number): void {
    if (!Number.isFinite(strength) || strength <= 0 || (this.editable !== undefined && !this.editable.has(this.parts[part].mesh))) return
    strength = Math.min(1, strength)
    points = this.covered(part, points, true)
    this.brushWeights(part, points, (q, p, f, mirrored) => {
      const target = this.boneMap(part, q)[mirrored ? this.parts[part].swap[bone] : bone]
      if (target === undefined || target < 0) return null
      const w = this.sourceWeights(q, p)
      const was = w.get(target) ?? 0
      const now = Math.min(1, was + strength * f * (1 - was))
      const scale = was < 1 ? (1 - now) / (1 - was) : 0
      for (const [b, x] of w) if (b !== target) w.set(b, x * scale)
      w.set(target, now)
      return w
    })
  }

  remove (part: number, points: Map<number, number>, bone: number, strength: number): void {
    if (!Number.isFinite(strength) || strength <= 0 || (this.editable !== undefined && !this.editable.has(this.parts[part].mesh))) return
    strength = Math.min(1, strength)
    points = this.covered(part, points, true)
    this.brushWeights(part, points, (q, p, f, mirrored) => {
      const target = this.boneMap(part, q)[mirrored ? this.parts[part].swap[bone] : bone]
      if (target === undefined || target < 0) return null
      const w = this.sourceWeights(q, p)
      const was = w.get(target) ?? 0
      if (was === 0) return w
      const now = was * (1 - strength * f)
      const rest = 1 - was
      // (what it gives up goes to the others it has, else to its neighbours' bones)
      if (rest > 1e-4) for (const [b, x] of w) { if (b !== target) w.set(b, x + (was - now) * x / rest) }
      else {
        const neighbours = [...this.average(q, p, true)].filter(([b]) => b !== target)
        const total = neighbours.reduce((s, [, x]) => s + x, 0)
        if (total <= 0) return w
        for (const [b, x] of neighbours) w.set(b, (was - now) * x / total)
      }
      w.set(target, now)
      return w
    })
  }

  private average (part: number, p: number, acrossParts = false): Weights {
    const out: Weights = new Map()
    if (acrossParts) {
      const neighbours = new Set<number>()
      for (const key of this.seams.get(this.offsets[part] + p) ?? [this.offsets[part] + p]) {
        const q = this.owners[key]
        for (const neighbour of this.parts[q].adj.get(key - this.offsets[q]) ?? []) {
          const at = this.offsets[q] + neighbour
          neighbours.add(Math.min(...(this.seams.get(at) ?? [at])))
        }
      }
      for (const key of neighbours) {
        const q = this.owners[key]; const map = this.boneMap(q, part)
        for (const [b, w] of this.sourceWeights(q, key - this.offsets[q])) if (map[b] >= 0) out.set(map[b], (out.get(map[b]) ?? 0) + w / neighbours.size)
      }
      return out
    }
    const n = this.parts[part].adj.get(p) ?? new Set()
    for (const q of n) for (const [b, x] of this.sourceWeights(part, q)) out.set(b, (out.get(b) ?? 0) + x / n.size)
    return out
  }

  smooth (part: number, points: Map<number, number>, strength: number): void {
    if (!Number.isFinite(strength) || strength <= 0 || (this.editable !== undefined && !this.editable.has(this.parts[part].mesh))) return
    strength = Math.min(1, strength)
    points = this.covered(part, points, true)
    this.brushWeights(part, points, (q, p, f, mirrored) => {
      const w = this.sourceWeights(q, p)
      let a = this.average(q, p, true)
      if (a.size === 0) return w
      if (mirrored && this.manualGroup(q, p).get(this.offsets[q] + p) === 3) a = this.swapped(q, a)
      const out: Weights = new Map()
      const k = strength * f
      for (const b of new Set([...w.keys(), ...a.keys()])) out.set(b, (1 - k) * (w.get(b) ?? 0) + k * (a.get(b) ?? 0))
      return out
    })
  }

  /** Follow: the brushed skin takes on the weights of what is under it, so whatever it covers pushes it (a coat's
   * hem over the legs). Found at rest: looking in from each point toward its nearest bone, the deepest skin facing
   * back out (the trousers under a coat under a cape: every layer between takes the same skin, so they move as one;
   * a cloth's own inner side faces away and is passed), within a short reach; with nothing that close, the nearest
   * bones themselves, for the points in `bare` only (all of them when it is not given): the layer the stroke is on,
   * not the skin a column reached through to (it is what the rest follow). */
  followUnder (part: number, points: Map<number, number>, strength: number, bare?: ReadonlySet<number>): void {
    if (this.editable !== undefined && !this.editable.has(this.parts[part].mesh)) return
    if (!Number.isFinite(strength) || strength <= 0) return
    points = this.covered(part, points)
    // (every target first: a stroke can cover both a coat and the skin under it; a layer over another in the stroke
    // takes what that one takes, down to the skin under the stack)
    const memo = new Map<number, Weights | null>()
    const target = (p: number): Weights | null => {
      if (memo.has(p)) return memo.get(p)!
      memo.set(p, null)   // (a loop takes the point's own weights)
      const mirrored = this.mirroredTarget(part, p)
      if (mirrored !== undefined) { memo.set(p, mirrored); return mirrored }
      const t = this.beneath(part, p, bare === undefined || bare.has(p), q => points.has(q) ? target(q) : null)
      const c = t === null ? null : this.centred(part, t)
      memo.set(p, c)
      return c
    }
    const targets = new Map<number, Weights>()
    this.pending?.fields.set(part, target)
    for (const p of points.keys()) {
      const t = target(p)
      if (t !== null) targets.set(p, t)
    }
    this.applyLayers(part, points, targets, strength, target)
  }

  /** Weights with what they share between a bone and its other side's twin (a left leg and the right) moved to the
   * bone both hang from (the hips): cloth between the legs. Linear skinning blends the two legs' moves, so the layers of
   * a cape and coat there, the same weights at different depths, were drawn together as the legs parted (the designer,
   * 2026-10-31: "converging in between bones"); the hips' one move keeps them apart. Toward either side the leg takes
   * over again. */
  private centred (part: number, w: Weights): Weights {
    const { swap, mesh } = this.parts[part]
    const bones = mesh.skeleton.bones
    const out: Weights = new Map(w)
    for (const [b, x] of w) {
      const s = swap[b]
      if (s === undefined || s === b || s < b || !out.has(s)) continue
      const shared = Math.min(x, out.get(s)!)
      if (shared <= 0) continue
      // (the nearest bone both hang from)
      const up = new Set<THREE.Object3D>()
      for (let o: THREE.Object3D | null = bones[b]; o !== null; o = o.parent) up.add(o)
      let common: THREE.Object3D | null = bones[s]
      while (common !== null && !up.has(common)) common = common.parent
      const to = common === null ? -1 : bones.indexOf(common as THREE.Bone)
      if (to < 0) continue
      out.set(b, out.get(b)! - shared); out.set(s, out.get(s)! - shared)
      out.set(to, (out.get(to) ?? 0) + 2 * shared)
    }
    for (const [b, x] of out) if (x <= 1e-6) out.delete(b)
    return out
  }

  /** Cloth: the brushed points weighted as clothing over the legs, a share (`strength`) of the way each dab, from where
   * each hangs at rest and nothing else (so every layer at one place takes the same, and they move as one): above the
   * hips, the hips easing into the spine; below, the hips blending down into the legs (0.95 of it by the knees, all
   * its own side's leg over that leg),
   * leaning to its own side's leg, below the knee a growing share of the shin (a step carries the hem); no arm.
   * tools/rigsmith/skirt_weights.py's robe, as a brush (the designer, 2026-11-01). With `sheet` (the brushed sheet, when
   * `points` is the column under it), a point off the sheet is changed only if it covers skin at rest: the layers under
   * the sheet, never the legs or trousers the column reaches (they cover nothing). Nothing when the skeleton lacks the
   * hips, spine or legs. Returns the points changed. */
  cloth (part: number, points: Map<number, number>, strength: number, sheet?: ReadonlySet<number>): number {
    if (this.editable !== undefined && !this.editable.has(this.parts[part].mesh)) return 0
    if (!Number.isFinite(strength) || strength <= 0) return 0
    points = this.covered(part, points)
    const { mesh } = this.parts[part]; const rest = this.origin[part]
    const bones = mesh.skeleton.bones
    const find = (name: string): number => bones.findIndex(b => new RegExp(`(^|:)${name}$`).test(b.name))
    const bindToMesh = mesh.bindMatrix.clone().invert()
    const at = (i: number): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(mesh.skeleton.boneInverses[i]).invert()).applyMatrix4(bindToMesh)
    const id = { hips: find('Hips'), spine: find('Spine'), lup: find('LeftUpLeg'), lleg: find('LeftLeg'), lfoot: find('LeftFoot'),
      rup: find('RightUpLeg'), rleg: find('RightLeg'), rfoot: find('RightFoot') }
    if (Object.values(id).some(i => i < 0)) return 0
    const hips = at(id.hips); const spine = at(id.spine)
    const knee = (at(id.lleg).y + at(id.rleg).y) / 2; const ankle = (at(id.lfoot).y + at(id.rfoot).y) / 2
    // (which way is the body's left, and how far out the legs are)
    const leftX = at(id.lup).x - hips.x; const spread = Math.max(Math.abs(leftX), 1e-4)
    const smooth = (t: number): number => { const c = THREE.MathUtils.clamp(t, 0, 1); return c * c * (3 - 2 * c) }
    const profile = (p: number): Weights => {
      const mirrored = this.mirroredTarget(part, p)
      if (mirrored !== undefined) return mirrored
      const x = rest[p * 3]; const y = rest[p * 3 + 1]
      const target: Weights = new Map()
      if (y >= hips.y) {
        const t = smooth((y - hips.y) / Math.max(spine.y - hips.y, 1e-6))
        target.set(id.hips, 1 - t); target.set(id.spine, t)
      } else {
        // (strong on the legs, the designer, 2026-11-01: "not strong enough"; the robe script's 0.8, 0.4 and 0.4 let the
        // legs come through the coat. A little hips stays, and the far leg's share where the legs are close, so the
        // middle doesn't tear)
        const legs = 0.95 * smooth((hips.y - y) / Math.max(hips.y - knee, 1e-6))
        const lean = 0.5 + 0.5 * THREE.MathUtils.clamp((x - hips.x) / spread * Math.sign(leftX || 1), -1, 1)
        const shin = 0.6 * smooth((knee - y) / Math.max(knee - ankle, 1e-6))
        target.set(id.hips, 1 - legs)
        for (const [up, low, share] of [[id.lup, id.lleg, lean], [id.rup, id.rleg, 1 - lean]] as const) {
          target.set(up, legs * share * (1 - shin)); target.set(low, legs * share * shin)
        }
      }
      for (const [b, w] of target) if (w <= 1e-4) target.delete(b)
      // A shared pull from both legs crushes a loose sheet as the thighs turn apart. Keep that shared share on
      // their common parent, just as Follow does, and let only the remaining side-specific leg pull the cloth.
      return this.centred(part, target)
    }
    const targets = new Map<number, Weights>()
    this.pending?.fields.set(part, profile)
    for (const p of points.keys()) {
      if (sheet !== undefined && !sheet.has(p) && this.restUnder(part, p) === null) continue
      targets.set(p, profile(p))
    }
    this.applyLayers(part, points, targets, strength, profile)
    return targets.size
  }

  /** With `sheet`, project underlying layers onto its rest-space triangles, retaining their brush falloff and weight
   * correspondence even if their posed order reverses. Without it, query a radial column in the current pose. */
  paintLayers (tool: 'cloth' | 'follow' | 'lift', hit: PaintPick, radius: number, strength: number, gap = 0,
    editable?: ReadonlySet<THREE.SkinnedMesh>): number {
    if (this.editable !== undefined) {
      const requested = editable
      editable = new Set([...this.editable].filter(mesh => requested === undefined || requested.has(mesh)))
    }
    if (!Number.isFinite(strength) || strength <= 0 || !Number.isFinite(radius) || radius <= 0 ||
      (editable !== undefined && !editable.has(this.parts[hit.part].mesh))) return 0
    if (this.pending !== null) throw new Error('A layer brush transaction is already active')
    const pending = { weights: new Map<number, Map<number, Weights>>(), shapes: new Map<number, Map<number, THREE.Vector3>>(),
      fields: new Map<number, (p: number) => Weights | null>(), mirrors: new Map<number, number>(),
      blends: new Map<number, { target: Weights, strength: number }>() }
    const footprints = new Map<number, Map<number, number>>([[hit.part, hit.points]])
    if (this.mirror) for (const [p, f] of hit.points) for (const [key, flags] of this.manualGroup(hit.part, p)) {
      const q = this.owners[key]; const v = key - this.offsets[q]
      if (q === hit.part || (flags & 2) === 0) continue
      if (editable !== undefined && !editable.has(this.parts[q].mesh)) continue
      if (!footprints.has(q)) footprints.set(q, new Map())
      footprints.get(q)!.set(v, Math.max(footprints.get(q)!.get(v) ?? 0, f)); pending.mirrors.set(q, hit.part)
    }
    this.pending = pending
    const previousPoseQuery = this.poseQuery
    this.poseQuery = new Map()
    try {
      // Source first: other primitives interpolate its target field by bone name, while all donor weights remain
      // unchanged until the whole stack has passed the same pose checks.
      for (const [source, footprint] of footprints) for (const part of [source, ...this.parts.map((_, q) => q).filter(q => q !== source)]) {
        if (editable !== undefined && !editable.has(this.parts[part].mesh)) continue
        const column = this.column(source, hit.point, radius, footprint, part)
        if (column.size === 0) continue
        const sheet = part === source ? new Set(footprint.keys()) : new Set<number>()
        if (tool === 'cloth') this.cloth(part, column, strength, sheet)
        else if (tool === 'follow') this.followUnder(part, column, strength, sheet)
        else this.lift(part, column, gap, strength, sheet)
      }
    } finally {
      this.pending = null
      this.poseQuery = previousPoseQuery
    }
    this.syncSeams(pending, editable)
    let changed = 0
    for (const [part, weights] of this.preserveStack(pending.weights)) for (const [p, w] of weights) {
      this.set(part, p, w, this.log); changed++
    }
    if (pending.shapes.size > 0) {
      const proposals = new Map([...pending.shapes].map(([q, shapes]) => [q, new Set(shapes.keys())]))
      const caps = this.surfaceStackSteps(proposals, (q, p, alpha, transforms) => {
        const from = new THREE.Vector3().fromArray(this.strokeShape?.[q] ?? this.parts[q].rest, p * 3)
        return this.skinPoint(q, p, this.weights(q, p), transforms, from.lerp(pending.shapes.get(q)!.get(p)!, alpha))
      })
      for (const [part, shapes] of pending.shapes) {
        const localCaps = new Map([...shapes.keys()].map(p => [p, caps.get(this.offsets[part] + p) ?? 0]))
        changed += this.applyShapeTargets(part, shapes, localCaps, this.strokeShape?.[part])
      }
    }
    return changed
  }

  /** Shared material-boundary points receive one target/coverage and one limit. Read-only neighbours pin a seam. */
  private syncSeams (pending: LayerTransaction, editable?: ReadonlySet<THREE.SkinnedMesh>): void {
    for (const group of new Set(this.seams.values())) {
      const active = group.some(key => pending.blends.has(key) || pending.shapes.get(this.owners[key])?.has(key - this.offsets[this.owners[key]]) === true)
      if (!active) continue
      if (group.some(key => {
        const q = this.owners[key]
        return !this.writable(q, key - this.offsets[q]) || (editable !== undefined && !editable.has(this.parts[q].mesh))
      })) {
        for (const key of group) {
          const q = this.owners[key]; const p = key - this.offsets[q]
          pending.weights.get(q)?.delete(p); pending.shapes.get(q)?.delete(p)
          pending.blends.delete(key)
        }
        continue
      }
      const source = [...group].filter(key => pending.blends.has(key)).sort((a, b) =>
        pending.blends.get(b)!.strength - pending.blends.get(a)!.strength || a - b)[0]
      if (source !== undefined) {
        const blend = pending.blends.get(source)!; const part = this.owners[source]
        const coverage = this.coverage[part].get(source - this.offsets[part]) ?? 0
        const mapped = group.map(key => {
          const q = this.owners[key]; const map = this.boneMap(part, q); const target: Weights = new Map()
          for (const [b, w] of blend.target) { if (w > 0 && map[b] < 0) return null; if (map[b] >= 0) target.set(map[b], w) }
          return { key, target }
        })
        if (mapped.some(x => x === null)) {
          for (const key of group) pending.weights.get(this.owners[key])?.delete(key - this.offsets[this.owners[key]])
        } else for (const entry of mapped) {
          const { key, target } = entry!; const q = this.owners[key]; const p = key - this.offsets[q]
          const from = this.sourceWeights(q, p); const out: Weights = new Map()
          for (const b of new Set([...from.keys(), ...target.keys()])) out.set(b, (1 - blend.strength) * (from.get(b) ?? 0) + blend.strength * (target.get(b) ?? 0))
          if (!pending.weights.has(q)) pending.weights.set(q, new Map())
          pending.weights.get(q)!.set(p, out); this.coverage[q].set(p, Math.max(this.coverage[q].get(p) ?? 0, coverage))
        }
      }
      let displacement: THREE.Vector3 | null = null; let coverage = 0
      for (const key of group) {
        const q = this.owners[key]; const p = key - this.offsets[q]; const target = pending.shapes.get(q)?.get(p)
        if (target === undefined) continue
        const from = new THREE.Vector3().fromArray(this.strokeShape?.[q] ?? this.parts[q].rest, p * 3)
        const delta = target.clone().sub(from).applyMatrix3(new THREE.Matrix3().setFromMatrix4(this.parts[q].mesh.bindMatrix))
        if (displacement === null || delta.lengthSq() > displacement.lengthSq()) {
          displacement = delta; coverage = this.shapeCoverage[q].get(p) ?? 0
        }
      }
      if (displacement !== null) for (const key of group) {
        const q = this.owners[key]; const p = key - this.offsets[q]; const mesh = this.parts[q].mesh
        const from = new THREE.Vector3().fromArray(this.strokeShape?.[q] ?? this.parts[q].rest, p * 3).applyMatrix4(mesh.bindMatrix)
        if (!pending.shapes.has(q)) pending.shapes.set(q, new Map())
        pending.shapes.get(q)!.set(p, from.add(displacement).applyMatrix4(mesh.bindMatrix.clone().invert()))
        this.shapeCoverage[q].set(p, Math.max(this.shapeCoverage[q].get(p) ?? 0, coverage))
      }
    }
  }

  /** A receiver's projection onto the picked sheet in the original bind frame. */
  column (part: number, at: THREE.Vector3, radius: number, sheet?: ReadonlyMap<number, number>, receiver = part): Map<number, number> {
    const out = new LayerColumn()
    if (!Number.isFinite(radius) || radius <= 0) return out
    if (sheet !== undefined) {
      // Locate layers at rest. In a squat the leg can be in front of the skirt and the lining outside the outer
      // cloth; their posed order must not decide what the stroke reaches. Project onto the brushed triangles so a
      // layer also gets the falloff of the sheet above it, rather than an unrelated falloff at its posed position.
      const r = this.restOf(part); const { point, mesh } = this.parts[part]; const rest = this.origin[part]
      const height = Math.max(...this.parts.map(({ mesh }, q) => this.restOf(q).bvh.getBoundingBox(new THREE.Box3())
        .applyMatrix4(mesh.bindMatrix).getSize(new THREE.Vector3()).y), 1e-6)
      const corner = (p: number): THREE.Vector3 => new THREE.Vector3(rest[p * 3], rest[p * 3 + 1], rest[p * 3 + 2]).applyMatrix4(mesh.bindMatrix)
      const triangles: Array<{ pts: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, normal: THREE.Vector3 }> = []
      for (let f = 0; f < r.tris.length; f += 3) {
        const pts = [point[r.tris[f]], point[r.tris[f + 1]], point[r.tris[f + 2]]]
        if (!pts.some(p => sheet.has(p))) continue
        const [a, b, c] = pts.map(corner)
        const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
        const centre = a.clone().add(b).add(c).multiplyScalar(1 / 3)
        let nearest = Infinity; const bone = new THREE.Vector3()
        for (const s of r.bones) {
          const y = new THREE.Line3(s.a.clone().applyMatrix4(mesh.bindMatrix), s.b.clone().applyMatrix4(mesh.bindMatrix))
            .closestPointToPoint(centre, true, new THREE.Vector3())
          const d = y.distanceToSquared(centre)
          if (d < nearest) { nearest = d; bone.copy(y) }
        }
        if (normal.dot(centre.clone().sub(bone)) < 0) normal.negate()
        triangles.push({ pts, a, b, c, normal })
      }
      const hit = new THREE.Vector3(); const bary = new THREE.Vector3()
      for (const p of this.parts[receiver].members.keys()) {
        if (receiver === part && sheet.has(p)) { out.set(p, sheet.get(p)!); continue }
        const x = new THREE.Vector3().fromArray(this.origin[receiver], p * 3).applyMatrix4(this.parts[receiver].mesh.bindMatrix)
        let nearest = Infinity; let falloff = 0
        for (const t of triangles) {
          if (receiver === part && t.pts.includes(p)) continue
          const d = hit.copy(t.a).sub(x).dot(t.normal)
          if (d <= 1e-5 * height || d > 0.16 * height || d >= nearest) continue
          hit.copy(x).addScaledVector(t.normal, d)
          if (THREE.Triangle.getBarycoord(hit, t.a, t.b, t.c, bary) === null) continue
          if (Math.min(bary.x, bary.y, bary.z) < -1e-5) continue
          nearest = d
          const weights = [bary.x, bary.y, bary.z].map(w => Math.max(0, w))
          const total = weights.reduce((sum, w) => sum + w, 0)
          const normalized = weights.map(w => w / total)
          falloff = normalized.reduce((sum, w, k) => sum + w * (sheet.get(t.pts[k]) ?? 0), 0)
          out.anchors.set(p, { part, points: t.pts, bary: normalized })
        }
        if (falloff > 0) out.set(p, falloff)
      }
      return out
    }
    const { mesh } = this.parts[part]
    mesh.updateMatrixWorld(true)
    let best = Infinity; const bone = at.clone()
    for (const b of mesh.skeleton.bones) {
      if (/end|leaf|tip$/i.test(b.name)) continue
      const a = b.getWorldPosition(new THREE.Vector3())
      const ends = b.children.filter(c => (c as THREE.Bone).isBone).map(c => c.getWorldPosition(new THREE.Vector3()))
      for (const e of ends.length > 0 ? ends : [a]) {
        const ab = e.clone().sub(a); const t = ab.lengthSq() > 1e-12 ? THREE.MathUtils.clamp(at.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1) : 0
        const y = a.clone().addScaledVector(ab, t); const d = y.distanceTo(at)
        if (d < best) { best = d; bone.copy(y) }
      }
    }
    if (best < 1e-6) return out
    const d = bone.clone().sub(at).normalize(); const v = new THREE.Vector3()
    for (const [p, x] of this.posed(part)) {
      v.copy(x).sub(at)
      const t = v.dot(d)
      // (from just in front of the sheet: a layer poking out in front of it is not under it)
      if (t < -radius * 0.25 || t > best) continue
      const r = v.addScaledVector(d, -t).length()
      if (r >= radius) continue
      const k = 1 - r / radius
      out.set(p, k * k * (3 - 2 * k))
    }
    return out
  }

  private readonly restCache = new Map<number, Rest>()

  /** Material neighbours across a shell or a clothing stack. Winding can face either way on a lining; the signed
   * side comes from the original geometry. Skip attached surface neighbours and use finite triangle intersections. */
  private separations (part: number): LayerPair[] {
    const cached = this.separationCache.get(part)
    if (cached !== undefined) return cached
    const r = this.restOf(part); const { members, adj, mesh } = this.parts[part]
    const corner = (q: number, p: number): THREE.Vector3 => new THREE.Vector3().fromArray(this.origin[q], p * 3)
    const pairs: LayerPair[] = []
    const frames = this.parts.map(p => p.mesh.bindMatrix.clone().invert())
    const height = Math.max(...this.parts.map(({ mesh }, q) => this.restOf(q).bvh.getBoundingBox(new THREE.Box3())
      .applyMatrix4(mesh.bindMatrix).getSize(new THREE.Vector3()).y), 1e-6)
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.bindMatrix)
    const normals = new Map<number, THREE.Vector3>()
    for (let f = 0; f < r.tris.length; f += 3) for (let k = 0; k < 3; k++) {
      const p = this.parts[part].point[r.tris[f + k]]
      if (!normals.has(p)) normals.set(p, new THREE.Vector3())
      normals.get(p)!.add(r.normals[f / 3])
    }
    for (const p of members.keys()) {
      const x = corner(part, p).applyMatrix4(mesh.bindMatrix); let distance = Infinity; const nearest = new THREE.Vector3()
      for (const bone of r.bones) {
        const q = new THREE.Line3(bone.a.clone().applyMatrix4(mesh.bindMatrix), bone.b.clone().applyMatrix4(mesh.bindMatrix)).closestPointToPoint(x, true, new THREE.Vector3())
        const d = x.distanceToSquared(q)
        if (d < distance) { distance = d; nearest.copy(q) }
      }
      if (!Number.isFinite(distance) || distance < 1e-16) continue
      const toward = nearest.sub(x).normalize(); const normal = normals.get(p)?.clone().applyNormalMatrix(normalMatrix)
      const direction = normal !== undefined && normal.lengthSq() > .5 ? normal.multiplyScalar(normal.dot(toward) < 0 ? -1 : 1) : toward
      const end = x.clone().addScaledVector(direction, Math.min(Math.sqrt(distance), height * .08))
      const hits: Array<LayerPair & { distance: number }> = []
      this.parts.forEach(({ point }, facePart) => {
        const ref = this.restOf(facePart); const from = x.clone().applyMatrix4(frames[facePart]); const to = end.clone().applyMatrix4(frames[facePart])
        const ray = new THREE.Ray(from, to.clone().sub(from).normalize())
        const source = x
        for (const hit of ref.bvh.raycast(ray, THREE.DoubleSide, from.distanceTo(to) * 1e-5, from.distanceTo(to))) {
          if (hit.faceIndex === undefined || hit.faceIndex === null) continue
          const points = [0, 1, 2].map(k => point[ref.tris[hit.faceIndex! * 3 + k]])
          if (facePart === part && points.some(q => q === p || adj.get(p)?.has(q) === true)) continue
          const [a, b, c] = points.map(p => corner(facePart, p))
          const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
          if (Math.abs(normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(this.parts[facePart].mesh.bindMatrix)).dot(direction)) < .2) continue
          const bary = THREE.Triangle.getBarycoord(hit.point, a, b, c, new THREE.Vector3())
          const gap = from.clone().sub(hit.point).dot(normal)
          if (bary === null || hit.point.clone().applyMatrix4(this.parts[facePart].mesh.bindMatrix).distanceTo(x) < height * 1e-5) continue
          const distance = hit.point.clone().applyMatrix4(this.parts[facePart].mesh.bindMatrix).distanceToSquared(source)
          hits.push({ part, point: p, facePart, points, bary: bary.toArray(), side: Math.sign(gap), gap: Math.abs(gap), normal, distance })
        }
      })
      hits.sort((a, b) => a.distance - b.distance)
      if (hits[0] !== undefined) pairs.push(hits[0])
    }
    this.separationCache.set(part, pairs)
    return pairs
  }

  /** A part's rest shape for Follow: its bones as segments (each bone to its children; a bone with none, a point) and
   * its triangles, in the mesh's own space. */
  private restOf (part: number): Rest {
    const cached = this.restCache.get(part)
    if (cached !== undefined) return cached
    const { mesh } = this.parts[part]; const rest = this.origin[part]
    const skeleton = mesh.skeleton
    // Attached skins update bindMatrixInverse to the current world frame. Reference geometry belongs to the
    // original bind frame; using the current inverse makes a stage scale/rotation change layer identity.
    const bindToMesh = mesh.bindMatrix.clone().invert()
    const at = skeleton.bones.map((_, i) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(skeleton.boneInverses[i]).invert()).applyMatrix4(bindToMesh))
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
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(rest.slice(), 3))
    geometry.setIndex(new THREE.Uint32BufferAttribute(index, 1))
    const out: Rest = { height: Math.max(box.max.y - box.min.y, 1e-6), bones, tris: index, normals, boxes,
      under: new Map(), spacing: new Map(), bvh: new MeshBVH(geometry, { indirect: true }) }
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

  /** The held Bone target in the receiving primitive's palette. */
  strokeBoneFor (part: number): number | null {
    if (this.strokeBone === null || this.strokePart === null) return null
    const bone = this.boneMap(this.strokePart, part)[this.strokeBone]
    return bone >= 0 ? bone : null
  }

  /** Bone (rigid): the brushed skin moves with only one bone, every other pull dropped (a face a hood drags, a buckle, a
   * plate): the bone leading where the stroke began, held for the whole stroke. */
  rigid (part: number, points: Map<number, number>, strength: number): void {
    if (!Number.isFinite(strength) || strength <= 0 || (this.editable !== undefined && !this.editable.has(this.parts[part].mesh))) return
    strength = Math.min(1, strength)
    points = this.covered(part, points, true)
    if (this.strokeBone === null) {
      this.strokeBone = this.leadingBone(part, points)
      this.strokePart = part
    }
    const bone = this.strokeBoneFor(part)
    if (bone === null) return
    this.brushWeights(part, points, (q, p, f, mirrored) => {
      const target = this.boneMap(part, q)[mirrored ? this.parts[part].swap[bone] : bone]
      if (target === undefined || target < 0) return null
      const w = this.sourceWeights(q, p)
      const k = Math.min(1, strength * f)
      const out: Weights = new Map()
      for (const [b, x] of w) out.set(b, (1 - k) * x)
      out.set(target, (out.get(target) ?? 0) + k)
      return out
    })
  }

  /** One mesh's bone indices as another's (by name; the same skeleton maps to itself), -1 where it has no such bone. */
  private boneMap (from: number, to: number): Int32Array {
    const key = from * this.parts.length + to; const cached = this.boneMaps.get(key)
    if (cached !== undefined) return cached
    const a = this.parts[from].mesh.skeleton; const b = this.parts[to].mesh.skeleton
    const names = b.bones.map(x => x.name)
    const map = a === b ? Int32Array.from(a.bones, (_, i) => i) : Int32Array.from(a.bones, x => names.indexOf(x.name))
    this.boneMaps.set(key, map)
    return map
  }

  /** The covered skin under a point in the starting shape: in toward its nearest bone `near`, the deepest skin
   * facing back out within a short reach; null for skin itself or cloth hanging clear. Stable throughout painting. */
  private restUnder (part: number, p: number, near?: { at: THREE.Vector3, d: number }): { part: number, face: number, bary: [number, number, number] } | null {
    const r = this.restOf(part)
    if (r.under.has(p)) return r.under.get(p) ?? null
    const { mesh, point } = this.parts[part]; const rest = this.origin[part]
    const x = new THREE.Vector3(rest[p * 3], rest[p * 3 + 1], rest[p * 3 + 2])
    const bindPoint = x.clone().applyMatrix4(mesh.bindMatrix)
    if (near === undefined) {
      let best = Infinity; const at = new THREE.Vector3()
      for (const s of r.bones) {
        const a = s.a.clone().applyMatrix4(mesh.bindMatrix); const b = s.b.clone().applyMatrix4(mesh.bindMatrix)
        const y = new THREE.Line3(a, b).closestPointToPoint(bindPoint, true, new THREE.Vector3()); const d = y.distanceTo(bindPoint)
        if (d < best) { best = d; at.copy(y) }
      }
      if (!Number.isFinite(best)) return null
      near = { at: at.applyMatrix4(mesh.bindMatrix.clone().invert()), d: best }
    }
    // Each primitive owns a local bind frame. Compare physical distances in the original shared bind world, then
    // transform the finite ray into each target BVH. The current attached-skin inverse is a posed frame, not this one.
    const height = Math.max(...this.parts.map(({ mesh: m }, q) => this.restOf(q).bvh.getBoundingBox(new THREE.Box3())
      .applyMatrix4(m.bindMatrix).getSize(new THREE.Vector3()).y), 1e-6)
    const bone = near.at.clone().applyMatrix4(mesh.bindMatrix)
    const reach = Math.min(bone.distanceTo(bindPoint), 0.08 * height)
    const dir = bone.sub(bindPoint).normalize(); const end = bindPoint.clone().addScaledVector(dir, reach)
    let best: { part: number, face: number, bary: [number, number, number], t: number } | null = null
    for (let q = 0; q < this.parts.length; q++) {
      const o = q === part ? r : this.restOf(q); const target = this.parts[q].mesh
      const inverse = target.bindMatrix.clone().invert()
      const localStart = bindPoint.clone().applyMatrix4(inverse); const localEnd = end.clone().applyMatrix4(inverse)
      const delta = localEnd.sub(localStart); const far = delta.length()
      if (far < 1e-12) continue
      const ray = new THREE.Ray(localStart, delta.multiplyScalar(1 / far))
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(target.bindMatrix)
      for (const hit of o.bvh.raycast(ray, THREE.DoubleSide, 0, far)) {
        const f = hit.faceIndex
        if (f === undefined || f === null || o.normals[f].clone().applyNormalMatrix(normalMatrix).dot(dir) >= 0) continue
        const v = [o.tris[f * 3], o.tris[f * 3 + 1], o.tris[f * 3 + 2]]
        if (q === part && v.some(i => point[i] === p)) continue
        const t = hit.point.clone().applyMatrix4(target.bindMatrix).distanceTo(bindPoint)
        // The deepest outward-facing skin is the donor under the whole stack, not another cloth layer's old paint.
        if (t < 1e-4 * height || t > reach || (best !== null && t <= best.t)) continue
        const [a, b, c] = v.map(i => new THREE.Vector3().fromArray(this.origin[q], i * 3))
        const bary = THREE.Triangle.getBarycoord(hit.point, a, b, c, new THREE.Vector3())
        if (bary !== null) best = { part: q, face: f, bary: [bary.x, bary.y, bary.z], t }
      }
    }
    r.under.set(p, best === null ? null : { part: best.part, face: best.face, bary: best.bary })
    return r.under.get(p) ?? null
  }

  /** What a point follows (see followUnder); null when nothing is under it and `bare` is false. `chain`: the weights a
   * covered point of this part is about to take, when it is in the same stroke (so a cape over a coat takes what the
   * coat takes, however deep the skin under both). */
  private beneath (part: number, p: number, bare = true, chain?: (point: number) => Weights | null): Weights | null {
    const r = this.restOf(part)
    const rest = this.origin[part]
    const x = new THREE.Vector3(rest[p * 3], rest[p * 3 + 1], rest[p * 3 + 2])
    const bind = this.parts[part].mesh.bindMatrix; const inverse = bind.clone().invert()
    const bindPoint = x.clone().applyMatrix4(bind)
    const toward = (s: { a: THREE.Vector3, b: THREE.Vector3 }): THREE.Vector3 => {
      const a = s.a.clone().applyMatrix4(bind); const b = s.b.clone().applyMatrix4(bind)
      return new THREE.Line3(a, b).closestPointToPoint(bindPoint, true, new THREE.Vector3())
    }
    const near = r.bones.map(s => { const at = toward(s); return { bone: s.bone, d: at.distanceTo(bindPoint), at: at.applyMatrix4(inverse) } }).sort((a, b) => a.d - b.d)
    if (near.length === 0) return this.sourceWeights(part, p)
    const under = this.restUnder(part, p, near[0])
    const out: Weights = new Map()
    if (under !== null) {
      // the covered skin's weights as they are now (painted ones included), its bones as this mesh's
      const o = this.restOf(under.part)
      const map = this.boneMap(under.part, part)
      for (let k = 0; k < 3; k++) {
        const c = this.parts[under.part].point[o.tris[under.face * 3 + k]]
        for (const [b, w] of (under.part === part ? chain?.(c) : null) ?? this.sourceWeights(under.part, c)) {
          const to = map[b]
          if (to >= 0) out.set(to, (out.get(to) ?? 0) + w * under.bary[k])
        }
      }
      if (out.size > 0) return out
    }
    if (!bare) return null
    // nothing close under it: the nearest bones, the nearer far more (two, so a border between them stays soft)
    const two = near.filter((s, i) => i === 0 || s.bone !== near[0].bone).slice(0, 2)
    const inv = two.map(s => 1 / Math.max(s.d, 1e-6) ** 4); const total = inv.reduce((a, b) => a + b, 0)
    two.forEach((s, i) => out.set(s.bone, (out.get(s.bone) ?? 0) + inv[i] / total))
    return out
  }

  /** Heal the marked area: its weights filled in smoothly from the skin round it (each point the mean of its
   * physical neighbours, including across material seams). Unselected skin is held, and each mirrored side keeps
   * its own surrounding authored skin. A wholly selected component has no reliable boundary and stays selected. */
  heal (): number {
    this.begin({ bounded: true })
    try {
      const physical = (key: number): number => Math.min(...(this.seams.get(key) ?? [key]))
      const aliases = (key: number): number[] => this.seams.get(key) ?? [key]
      const neighbours = new Map<number, Set<number>>()
      const adjacent = (key: number): Set<number> => {
        const cached = neighbours.get(key)
        if (cached !== undefined) return cached
        const out = new Set<number>()
        for (const alias of aliases(key)) {
          const q = this.owners[alias]
          for (const p of this.parts[q].adj.get(alias - this.offsets[q]) ?? []) {
            const neighbour = physical(this.offsets[q] + p)
            if (neighbour !== key) out.add(neighbour)
          }
        }
        neighbours.set(key, out); return out
      }
      const selected = new Map<number, number>()
      for (const [part, area] of this.area.entries()) for (const [p, f] of area) {
        if (!Number.isFinite(f) || f <= 0) continue
        const key = physical(this.offsets[part] + p)
        selected.set(key, Math.max(selected.get(key) ?? 0, Math.min(1, f)))
      }
      const writable = new Set([...selected.keys()].filter(key => {
        const q = this.owners[key]; return this.writable(q, key - this.offsets[q])
      }))
      // Read-only selected points remain pinned; they cannot turn an entirely marked island into a good boundary.
      const anchored = new Set<number>()
      const queue = [...writable].filter(key => [...adjacent(key)].some(neighbour => !selected.has(neighbour)))
      for (let i = 0; i < queue.length; i++) {
        const key = queue[i]
        if (anchored.has(key)) continue
        anchored.add(key)
        for (const neighbour of adjacent(key)) if (writable.has(neighbour) && !anchored.has(neighbour)) queue.push(neighbour)
      }
      const source = new Map<number, Map<string, number>>()
      const original = (key: number): Map<string, number> => {
        let out = source.get(key)
        if (out === undefined) {
          const q = this.owners[key]; const bones = this.parts[q].mesh.skeleton.bones
          out = new Map([...this.sourceWeights(q, key - this.offsets[q])].map(([b, w]) => [bones[b].name, w]))
          source.set(key, out)
        }
        return out
      }
      const solved = new Map([...anchored].sort((a, b) => a - b).map(key => [key, original(key)]))
      for (let iteration = 0; iteration < 400; iteration++) {
        let change = 0
        for (const [key, old] of solved) {
          const n = adjacent(key)
          if (n.size === 0) continue
          const out = new Map<string, number>()
          for (const neighbour of n) for (const [bone, weight] of solved.get(neighbour) ?? original(neighbour)) {
            out.set(bone, (out.get(bone) ?? 0) + weight / n.size)
          }
          for (const bone of new Set([...old.keys(), ...out.keys()])) change = Math.max(change, Math.abs((old.get(bone) ?? 0) - (out.get(bone) ?? 0)))
          solved.set(key, out)
        }
        if (change < 1e-4) break
      }
      const next = new Map<number, Weights>()
      const names = this.parts.map(({ mesh }) => new Map(mesh.skeleton.bones.map((bone, index) => [bone.name, index])))
      for (const [key, target] of solved) for (const alias of aliases(key)) {
        const q = this.owners[alias]; const p = alias - this.offsets[q]; const from = this.sourceWeights(q, p)
        if ([...target].some(([bone, weight]) => weight > 0 && !names[q].has(bone))) continue
        const mapped = new Map([...target].map(([bone, weight]) => [names[q].get(bone)!, weight]))
        const f = selected.get(key)!; const out: Weights = new Map()
        for (const bone of new Set([...from.keys(), ...mapped.keys()])) out.set(bone, (1 - f) * (from.get(bone) ?? 0) + f * (mapped.get(bone) ?? 0))
        next.set(alias, out)
      }
      const { accepted } = this.repairWeights(next)
      for (const key of accepted) {
        const q = this.owners[key]; this.area[q].delete(key - this.offsets[q])
      }
      return accepted.size
    } finally {
      this.end()
    }
  }

  /** Back one stroke (or fix). */
  stepBack (): boolean {
    const last = this.undo.pop()
    if (last === undefined) return false
    this.strokeVersion++; this.validating = false
    const moved = new Set<number>()
    for (const e of last.changes.reverse()) {
      const { mesh, rest } = this.parts[e.part]
      if (e.skin !== undefined) {
        const si = mesh.geometry.attributes.skinIndex; const sw = mesh.geometry.attributes.skinWeight
        for (const v of e.skin) for (let k = 0; k < 4; k++) { si.setComponent(v.vertex, k, v.index[k]); sw.setComponent(v.vertex, k, v.weight[k]) }
        si.needsUpdate = true; sw.needsUpdate = true
      }
      if (e.positions !== undefined) {
        const position = mesh.geometry.attributes.position
        for (const v of e.positions) { position.setXYZ(v.vertex, ...v.at); rest.set(v.at, v.vertex * 3) }
        moved.add(e.part)
      }
    }
    for (const part of moved) this.reshaped(part)
    this.parts.forEach((_, part) => {
      this.edited[part] = last.edited[part]; this.shaped[part] = last.shaped[part]; this.area[part] = last.area[part]
      this.protectedPoints[part] = last.protectedPoints[part]
    })
    this.strokeSource = null; this.logged.clear(); this.guardPoses = []; this.guardRest = null; this.releaseAnimation = null; this.limited.clear(); this.contactLimited.clear()
    this.strokeSurface = null
    this.strokeShape = null
    this.strokeOpen = false; this.protectionStroke = false
    return true
  }

  /** The changed points' weights by bone name, to save (every vertex of each point). */
  edits (): Edit[] {
    this.requireReleased()
    const out: Edit[] = []
    this.parts.forEach(({ mesh, members }, part) => {
      const names = mesh.skeleton.bones.map(b => b.name)
      for (const p of this.edited[part]) {
        const w = [...this.weights(part, p).entries()].map(([b, x]) => [names[b], x] as [string, number])
        for (const v of members.get(p) ?? [p]) out.push({ mesh: part, vertex: v, weights: w })
      }
    })
    return out
  }

  /** The lifted points' rest positions, to save (every vertex of each point, and where it was before). */
  shapeEdits (): ShapeEdit[] {
    this.requireReleased()
    const out: ShapeEdit[] = []
    this.parts.forEach(({ mesh, members }, part) => {
      const pos = mesh.geometry.attributes.position; const o = this.origin[part]
      for (const p of this.shaped[part]) {
        for (const v of members.get(p) ?? [p]) out.push({ mesh: part, vertex: v, from: [o[v * 3], o[v * 3 + 1], o[v * 3 + 2]], to: [pos.getX(v), pos.getY(v), pos.getZ(v)] })
      }
    })
    return out
  }

  saved (): void {
    this.requireReleased()
    for (const e of this.edited) e.clear(); for (const e of this.shaped) e.clear()
    this.undo = []; this.strokeSource = null; this.guardPoses = []; this.guardRest = null; this.releaseAnimation = null; this.limited.clear(); this.contactLimited.clear()
    this.strokeSurface = null
    this.strokeShape = null
    this.strokeOpen = false; this.protectionStroke = false
  }

  /** Provisional dragging is observable through weights/positions, but cannot be published or checkpointed. */
  private requireReleased (): void {
    if (this.releaseAnimation !== null || this.validating || this.protectionStroke) throw new Error('Release the brush and finish its check before saving painting')
  }

  /** A point's rest position set (on all its vertices). */
  private place (part: number, p: number, at: ArrayLike<number>): void {
    this.requirePaintStroke()
    if (!this.writable(part, p)) return
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
    // Layer identity and spacing belong to the shape at the start of painting. Moving cloth must not turn it into
    // a different layer on the next dab, or change the baseline gap we are preserving.
  }

  /** Lift a local stack against its actual covered body surface, keeping its original layer spacing. A global
   * maximum over the whole brush spreads one collision into unrelated cloth, and nearest posed bones can change
   * abruptly during a squat. Rest-space body correspondences avoid both. */
  private liftLayers (part: number, points: Map<number, number>, gap: number, strength: number): number {
    if (!Number.isFinite(strength) || strength <= 0 || !Number.isFinite(gap) || gap < 0) return 0
    const brushed = new Map(points)
    if (this.mirror) for (const [p, f] of points) {
      const q = this.parts[part].twin.get(p)
      if (q !== undefined) brushed.set(q, Math.max(brushed.get(q) ?? 0, f))
    }
    if (brushed.size === 0) return 0
    const posed = this.parts.map((_, q) => this.posed(q))
    const reference = this.strokeShape?.[part]
    const transforms = reference === undefined ? null : this.transforms(this.parts[part].mesh)
    const source = new Map([...brushed.keys()].map(p => [p, reference === undefined ? posed[part].get(p)! :
      this.skinPoint(part, p, this.weights(part, p), transforms!, new THREE.Vector3().fromArray(reference, p * 3))]))
    const r = this.restOf(part)
    const height = Math.max(...this.parts.map(({ mesh }, q) => this.restOf(q).bvh.getBoundingBox(new THREE.Box3())
      .applyMatrix4(mesh.matrixWorld).getSize(new THREE.Vector3()).y), 1e-6)
    const bindHeight = Math.max(...this.parts.map(({ mesh }, q) => this.restOf(q).bvh.getBoundingBox(new THREE.Box3())
      .applyMatrix4(mesh.bindMatrix).getSize(new THREE.Vector3()).y), 1e-6)
    const epsilon = height * 1e-5
    const bindEpsilon = bindHeight * 1e-5
    const corner = (q: number, p: number): THREE.Vector3 => new THREE.Vector3().fromArray(this.origin[q], p * 3).applyMatrix4(this.parts[q].mesh.bindMatrix)
    const tris: Array<{ part: number, pts: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3 }> = []
    const span = new THREE.Box3()
    for (const p of brushed.keys()) { span.expandByPoint(posed[part].get(p)!); span.expandByPoint(source.get(p)!) }
    span.expandByScalar(height * 0.16 + gap)
    this.parts.forEach(({ point }, q) => {
      const o = this.restOf(q)
      let bodyFaces = this.bodyFaceCache.get(q)
      if (bodyFaces === undefined) { bodyFaces = new Int8Array(o.tris.length / 3); this.bodyFaceCache.set(q, bodyFaces) }
      for (let f = 0; f < o.tris.length; f += 3) {
        const pts = [point[o.tris[f]], point[o.tris[f + 1]], point[o.tris[f + 2]]]
        const [a, b, c] = pts.map(p => posed[q].get(p)!)
        if (Math.max(a.x, b.x, c.x) < span.min.x || Math.min(a.x, b.x, c.x) > span.max.x ||
          Math.max(a.y, b.y, c.y) < span.min.y || Math.min(a.y, b.y, c.y) > span.max.y ||
          Math.max(a.z, b.z, c.z) < span.min.z || Math.min(a.z, b.z, c.z) > span.max.z) continue
        if (bodyFaces[f / 3] === 0) bodyFaces[f / 3] = pts.some(p => this.restUnder(q, p) !== null) ? -1 : 1
        if (bodyFaces[f / 3] < 0) continue
        const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize().multiplyScalar(Math.sign(this.parts[q].mesh.matrixWorld.determinant()) || 1)
        if (n.lengthSq() < 1e-12) continue
        tris.push({ part: q, pts, a, b, c, n })
      }
    })
    if (tris.length === 0) return 0
    const bodyGeometry = new THREE.BufferGeometry()
    bodyGeometry.setAttribute('position', new THREE.Float32BufferAttribute(tris.flatMap(t => [...t.a.toArray(), ...t.b.toArray(), ...t.c.toArray()]), 3))
    const bodyTree = new MeshBVH(bodyGeometry, { indirect: true })
    const edgeKey = (q: number, a: number, b: number): string => `${q}:${Math.min(a, b)}:${Math.max(a, b)}`
    const edges = new Map<string, number>()
    for (const t of tris) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const key = edgeKey(t.part, t.pts[a], t.pts[b]); edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    const ray = new THREE.Ray()
    const moves = new Map<number, THREE.Vector3>()
    for (const [p, f] of brushed) {
      const under = this.restUnder(part, p)
      if (under === null) continue   // the body under the cloth remains fixed
      const o = this.restOf(under.part)
      const vertices = [0, 1, 2].map(k => this.parts[under.part].point[o.tris[under.face * 3 + k]])
      const base = new THREE.Vector3()
      vertices.forEach((v, k) => {
        base.addScaledVector(corner(under.part, v), under.bary[k])
      })
      const offset = corner(part, p).sub(base)
      const body = this.parts[under.part].mesh
      const restNormal = o.normals[under.face].clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(body.bindMatrix))
      if (!r.spacing.has(p)) {
        // The first cloth intersection from the body is the inside of this stack. Outer layers retain their own
        // distance above it; the requested gap is added once, between the body and the innermost cloth.
        const depth = Math.max(0, offset.dot(restNormal))
        let nearest = depth
        const end = corner(part, p)
        const inside = end.clone().addScaledVector(restNormal, -depth)
        this.parts.forEach(({ mesh }, q) => {
          const ref = this.restOf(q)
          const inverse = mesh.bindMatrix.clone().invert()
          const start = inside.clone().applyMatrix4(inverse)
          const delta = end.clone().applyMatrix4(inverse).sub(start); const far = delta.length()
          if (far < 1e-12) return
          ray.set(start, delta.multiplyScalar(1 / far))
          for (const hit of ref.bvh.raycast(ray, THREE.DoubleSide, 0, far)) {
            const d = hit.point.applyMatrix4(mesh.bindMatrix).distanceTo(inside)
            if (d > bindEpsilon && d < nearest) nearest = d
          }
        })
        r.spacing.set(p, Math.max(0, depth - nearest))
      }
      // Spacing is cached in the shared original bind world. Perpendicular distance transforms by the inverse
      // transpose, including anisotropic stages; multiplying a normal by the forward scale gives a wrong gap.
      const stage = body.matrixWorld.clone().multiply(body.bindMatrix.clone().invert())
      const normalScale = restNormal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(stage)).length()
      if (!Number.isFinite(normalScale) || normalScale <= 0) continue
      const target = gap + r.spacing.get(p)! / normalScale
      const x = source.get(p)!
      // Measure the finite body's actual nearest point. A rest correspondence supplies layer identity, not an
      // infinite collision plane: that plane can cut through distant cloth before the limb is anywhere near it.
      const closest = bodyTree.closestPointToPoint(x)
      if (closest === null) continue
      const tri = tris[closest.faceIndex]
      const away = x.clone().sub(closest.point)
      const bary = THREE.Triangle.getBarycoord(closest.point, tri.a, tri.b, tri.c, new THREE.Vector3())
      const boundary = bary !== null && [[bary.x, 1, 2], [bary.y, 0, 2], [bary.z, 0, 1]].some(([w, a, b]) =>
        w < 1e-5 && edges.get(edgeKey(tri.part, tri.pts[a], tri.pts[b])) === 1)
      // An open boundary has no "inside" beyond its edge. A cloth point far behind that edge is not penetration.
      const inside = !boundary && away.dot(tri.n) < -epsilon
      const need = inside ? target + closest.distance : Math.max(0, target - closest.distance)
      if (need <= epsilon * .01) continue
      const normal = closest.distance > epsilon ? away.normalize().multiplyScalar(inside ? -1 : 1) : tri.n.clone()
      const alpha = THREE.MathUtils.clamp(strength * f, 0, 1)
      if (this.strokeSource !== null) {
        const previous = this.shapeCoverage[part].get(p) ?? 0
        if (alpha <= previous + 1e-7) continue
        this.shapeCoverage[part].set(p, alpha)
      }
      const step = need * alpha
      if (step > epsilon * 0.01) moves.set(p, normal.multiplyScalar(step))
    }
    return this.moveShape(part, moves, reference !== undefined)
  }

  /** Lift against the current pose, saved as rest-shape changes. With `sheet`, clear the body's surface locally while
   * preserving the stack's original spacing. A single-sheet query without it also carries a nearby lining. This is
   * a shape edit, not a collision solve throughout an animation. Returns the points moved. */
  lift (part: number, points: Map<number, number>, gap: number, strength: number, sheet?: ReadonlySet<number>): number {
    if (this.editable !== undefined && !this.editable.has(this.parts[part].mesh)) return 0
    if (sheet !== undefined || this.strokeShape !== null) return this.liftLayers(part, points, gap, strength)
    const brushed = new Map(points)
    if (this.mirror) {
      for (const [p, f] of points) { const q = this.parts[part].twin.get(p); if (q !== undefined && q !== p) brushed.set(q, Math.max(brushed.get(q) ?? 0, f)) }
    }
    if (brushed.size === 0) return 0
    const height = Math.max(...this.parts.map((_, q) => this.restOf(q).height))
    const reach = 0.08 * height; const thick = 0.03 * height
    // the body as it stands: every part's points, and its bones as segments, in world space
    const posed = this.parts.map((_, q) => this.posed(q))
    const { mesh } = this.parts[part]
    const segments: Array<{ bone: number, a: THREE.Vector3, b: THREE.Vector3 }> = []
    mesh.skeleton.bones.forEach((bone, i) => {
      if (/end|leaf|tip$/i.test(bone.name)) return
      const a = bone.getWorldPosition(new THREE.Vector3())
      const children = bone.children.filter(c => (c as THREE.Bone).isBone)
      if (children.length === 0) segments.push({ bone: i, a, b: a })
      for (const c of children) segments.push({ bone: i, a, b: c.getWorldPosition(new THREE.Vector3()) })
    })
    // each point's distance from a bone as it began (the rest shape this painting started from, the bone at rest)
    const restBones = this.restOf(part).bones; const o = this.origin[part]
    const initial = (p: number, bone: number): number => {
      const x = new THREE.Vector3(o[p * 3], o[p * 3 + 1], o[p * 3 + 2])
      let d = Infinity
      for (const s of restBones) {
        if (s.bone !== bone) continue
        const ab = s.b.clone().sub(s.a); const t = ab.lengthSq() > 1e-12 ? THREE.MathUtils.clamp(x.clone().sub(s.a).dot(ab) / ab.lengthSq(), 0, 1) : 0
        d = Math.min(d, s.a.clone().addScaledVector(ab, t).distanceTo(x))
      }
      return d
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
    // (per cloth point: how far the pose drew it in toward its bone, and what clearing the skin under it would take)
    const grow = new Map<number, number>(); const clear = new Map<number, { d: number, on: readonly number[] }>()
    const lining = new Map<number, Set<number>>()
    const hit = new THREE.Vector3(); const ray = new THREE.Ray()
    for (const p of brushed.keys()) {
      const x = posed[part].get(p)!
      let best = Infinity; let at = x; let nearest = -1
      for (const s of segments) {
        const ab = s.b.clone().sub(s.a); const t = ab.lengthSq() > 1e-12 ? THREE.MathUtils.clamp(x.clone().sub(s.a).dot(ab) / ab.lengthSq(), 0, 1) : 0
        const y = s.a.clone().addScaledVector(ab, t); const d = y.distanceTo(x)
        if (d < best) { best = d; at = y; nearest = s.bone }
      }
      if (best < 1e-6) continue
      const inward = at.clone().sub(x).normalize(); const outward = inward.clone().negate()
      const far = Math.min(best, reach)
      let under = Infinity; let through = Infinity; let onto: readonly number[] = []
      const inner = new Set<number>()
      ray.set(x, inward)
      for (const tri of tris) {
        if (tri.q === part && tri.pts.includes(p)) continue
        if (ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit) !== null) {
          const t = hit.distanceTo(x)
          if (t > far || t < 1e-5 * height) continue
          if (tri.n.dot(inward) < 0) { if (t < under) { under = t; onto = tri.q === part ? tri.pts : [] } }
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
      const shows = through < thick
      const d = shows ? through + gap : under < Infinity ? Math.max(0, gap - under) : 0
      out.set(p, outward)
      // (skin or cloth is decided at rest, never from the pose: squatting, the legs come out over a coat and look like
      // cloth on it, so the posed test lifted the legs' skin; at rest they have nothing under them. The designer,
      // 2026-11-01: "only calculate from rest")
      if (shows || under < Infinity) {
        // cloth (something under it): back out to its own first distance from the bone, so the layers keep the spacing
        // they began with (the designer, 2026-11-01: "based on its initial distance")
        // Keep the sign: the inner layer may have moved OUT while the outer moved in. Clipping this to zero loses
        // their original separation and lifts the inner layer into the outer one.
        const g = initial(p, nearest) - best
        grow.set(p, Number.isFinite(g) ? g : 0)
        clear.set(p, { d, on: shows ? [] : onto })
      } else need.set(p, 0)   // (the skin under every layer stays)
      if (inner.size > 0) lining.set(p, inner)
    }
    // every cloth layer by its own way back out plus one shared clearance, so the layers go out together and the
    // innermost clears the skin: no layer lifted into the one over it
    // (the clearance is the innermost layer's, the one lying on the skin: a cape over the coat stays where the coat
    // puts it, not a whole gap off the coat)
    let extra = 0
    for (const [p, c] of clear) if (!c.on.some(y => grow.has(y))) extra = Math.max(extra, c.d - grow.get(p)!)
    for (const [p, g] of grow) need.set(p, Math.max(0, g + Math.max(0, extra)))
    // evened over the brush: a point lifts at least as far as its brushed neighbours, on average (no bumps)
    const { adj } = this.parts[part]
    for (let it = 0; it < 3; it++) {
      const next = new Map(need)
      for (const [p, d] of need) {
        if (!grow.has(p)) continue   // the body remains fixed, even where cloth and body share an attachment
        const n = [...(adj.get(p) ?? [])].filter(q => grow.has(q))
        if (n.length === 0) continue
        next.set(p, Math.max(d, 0.5 * (d + n.reduce((s, q) => s + need.get(q)!, 0) / n.length)))
      }
      for (const [p, d] of next) need.set(p, d)
    }
    // the moves, in world space: each brushed point, and its inner side by the most any point above it takes it
    const moves = new Map<number, THREE.Vector3>()
    // (a lining point moves as the brushed point nearest it does: the one right over it, not a tilted neighbour)
    const liner = new Map<number, number>()
    for (const [p, d] of need) {
      const step = d * Math.min(1, strength * (brushed.get(p) ?? 0))
      if (step <= 1e-7 * height) continue
      const m = out.get(p)!.clone().multiplyScalar(step)
      moves.set(p, m)
      for (const q of lining.get(p) ?? []) {
        const gap2 = posed[part].get(p)!.distanceToSquared(posed[part].get(q)!)
        if (gap2 < (liner.get(q) ?? Infinity)) { liner.set(q, gap2); moves.set(q, m.clone()) }
      }
    }
    return this.moveShape(part, moves)
  }

  /** World-space corrections persisted as rest positions through the inverse of the current skinning transform. */
  private moveShape (part: number, moves: Map<number, THREE.Vector3>, fromStroke = false): number {
    this.requirePaintStroke()
    if (moves.size === 0) return 0
    const { mesh } = this.parts[part]
    // each into rest space through its skinning as posed (the world move undone by its bones' blend)
    mesh.updateMatrixWorld(true)
    const g = mesh.geometry
    const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight
    const toMesh = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert())
    const bindInv = new THREE.Matrix3().setFromMatrix4(mesh.bindMatrixInverse)
    const bind = new THREE.Matrix3().setFromMatrix4(mesh.bindMatrix)
    const boneM = mesh.skeleton.bones.map((b, i) => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().multiplyMatrices(b.matrixWorld, mesh.skeleton.boneInverses[i])))
    const pos = g.attributes.position
    const reference = fromStroke ? this.strokeShape?.[part] : undefined
    const targets = new Map<number, THREE.Vector3>()
    for (const [p, m] of moves) {
      if (!this.writable(part, p)) continue
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
      const target = (reference === undefined ? new THREE.Vector3(pos.getX(p), pos.getY(p), pos.getZ(p)) : new THREE.Vector3().fromArray(reference, p * 3)).add(local)
      if ([target.x, target.y, target.z].every(Number.isFinite)) targets.set(p, target)
    }
    if (this.pending !== null) {
      if (!this.pending.shapes.has(part)) this.pending.shapes.set(part, new Map())
      for (const [p, target] of targets) this.pending.shapes.get(part)!.set(p, target)
      return targets.size
    }
    const caps = this.surfaceSteps(part, new Set(targets.keys()), (p, alpha, transforms) => {
      const at = (reference === undefined ? new THREE.Vector3(pos.getX(p), pos.getY(p), pos.getZ(p)) : new THREE.Vector3().fromArray(reference, p * 3)).lerp(targets.get(p)!, alpha)
      return this.skinPoint(part, p, this.weights(part, p), transforms, at)
    })
    return this.applyShapeTargets(part, targets, caps, reference)
  }

  private applyShapeTargets (part: number, targets: Map<number, THREE.Vector3>, caps: ReadonlyMap<number, number>, reference?: Float32Array): number {
    this.requirePaintStroke()
    const pos = this.parts[part].mesh.geometry.attributes.position
    let changed = 0
    for (const [p, alpha] of caps) {
      if (!this.writable(part, p)) continue
      if (alpha === 0 && reference === undefined) continue
      const target = (reference === undefined ? new THREE.Vector3(pos.getX(p), pos.getY(p), pos.getZ(p)) : new THREE.Vector3().fromArray(reference, p * 3)).lerp(targets.get(p)!, alpha)
      const members = this.parts[part].members.get(p) ?? [p]
      if (alpha === 0 && reference !== undefined) {
        if (members.every(v => [0, 1, 2].every(k => Object.is(pos.getComponent(v, k), reference[v * 3 + k])))) continue
      } else if (target.distanceToSquared(new THREE.Vector3(pos.getX(p), pos.getY(p), pos.getZ(p))) < 1e-18) continue
      const key = `p:${part}:${p}`
      if (!this.logged.has(key)) {
        this.log?.push({ part, point: p, positions: (this.parts[part].members.get(p) ?? [p]).map(vertex => ({
          vertex, at: [pos.getX(vertex), pos.getY(vertex), pos.getZ(vertex)],
        })) })
        this.logged.add(key)
      }
      if (alpha === 0 && reference !== undefined) {
        for (const v of members) {
          pos.setXYZ(v, reference[v * 3], reference[v * 3 + 1], reference[v * 3 + 2])
          this.parts[part].rest.set(reference.subarray(v * 3, v * 3 + 3), v * 3)
        }
        if (this.undo[this.undo.length - 1]?.shaped[part].has(p) !== true) this.shaped[part].delete(p)
      } else { this.place(part, p, target.toArray()); this.shaped[part].add(p) }
      changed++
    }
    if (changed > 0) this.reshaped(part)
    return changed
  }
}

/** Each point's mirror twin across the body's middle (the hips' x at rest, in the mesh's own space), within `tol`
 * of where its mirror image falls; a point on the middle line is its own. And which side each point is on. */
function twins (mesh: THREE.SkinnedMesh, members: Map<number, number[]>, tol: number,
  pos: THREE.BufferAttribute): { twin: Map<number, number>, side: Map<number, number> } {
  const bones = mesh.skeleton.bones
  const hips = bones.findIndex(b => /(^|:)Hips$/.test(b.name))
  let xc: number
  if (hips >= 0) {
    const at = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(mesh.skeleton.boneInverses[hips]).invert())
    xc = at.applyMatrix4(mesh.bindMatrix.clone().invert()).x
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
