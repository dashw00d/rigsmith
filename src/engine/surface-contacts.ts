import * as THREE from 'three'
import { ExtendedTriangle, MeshBVH, type SerializedBVH } from 'three-mesh-bvh'
import { ContactBVH } from './contact-bvh.ts'

type Face = readonly [number, number, number]
type ReadPoint = (point: number) => THREE.Vector3
type PairKey = number | string

/** Immutable point/face addressing and BVH layout shared by every pose of one stroke. Each pose keeps independent
 * positions, refitted bounds and baseline contact pairs. Indirect construction never changes this shared index. */
class ContactTopology {
  readonly faces: readonly Face[]
  readonly points: number[]
  readonly vertices = new Map<number, number>()
  readonly incident = new Map<number, number[]>()
  readonly aliases: Face[]
  readonly adjacent: Array<Set<number>>
  readonly index: THREE.BufferAttribute
  private template: SerializedBVH | null = null
  private readonly faceNodes: number[][] = []

  constructor (faces: readonly Face[], equivalent: (point: number) => number) {
    this.faces = faces
    this.points = [...new Set(faces.flat())]
    this.points.forEach((p, i) => this.vertices.set(p, i))
    const index: number[] = []
    this.aliases = faces.map((face, f) => {
      for (const p of face) {
        index.push(this.vertices.get(p)!)
        if (!this.incident.has(p)) this.incident.set(p, [])
        this.incident.get(p)!.push(f)
      }
      return face.map(equivalent) as [number, number, number]
    })
    this.index = new THREE.Uint32BufferAttribute(index, 1)
    const attached = new Map<number, number[]>()
    this.aliases.forEach((face, f) => {
      for (const p of face) {
        if (!attached.has(p)) attached.set(p, [])
        attached.get(p)!.push(f)
      }
    })
    this.adjacent = this.aliases.map(face => new Set(face.flatMap(p => attached.get(p)!)))
  }

  tree (geometry: THREE.BufferGeometry): MeshBVH {
    if (this.template === null) {
      const tree = new MeshBVH(geometry, { indirect: true })
      this.template = MeshBVH.serialize(tree)
      const path: number[] = []
      tree.shapecast({
        intersectsBounds: (_box, _leaf, _score, depth, node) => { path[depth] = node; path.length = depth + 1; return true },
        intersectsRange: (offset, count, _contained, depth, node) => {
          path[depth] = node; path.length = depth + 1
          for (let i = offset; i < offset + count; i++) this.faceNodes[tree.resolveTriangleIndex(i)] = path.slice()
          return false
        },
      })
      return tree
    }
    const tree = MeshBVH.deserialize({ ...this.template, roots: this.template.roots.map(root => root.slice(0)) }, geometry, { setIndex: false })
    tree.refit()
    return tree
  }

  /** Only changed-point leaves and all their ancestors need refitting during one pose's local limit iterations. */
  refit (tree: MeshBVH, active: ReadonlySet<number>): void {
    const nodes = new Set<number>()
    for (const p of active) for (const f of this.incident.get(p) ?? []) for (const node of this.faceNodes[f]) nodes.add(node)
    tree.refit(nodes)
  }
}

/** Actual finite-triangle contacts for one sampled pose. Point addresses and face order are private; the source
 * geometry is never indexed or written here. Existing contacts are exempt by pair, rather than disabling a whole
 * damaged region. This checks sampled positions, not swept motion or a requested cloth thickness. */
export class SurfaceContacts {
  private readonly topology: ContactTopology
  private readonly geometry = new THREE.BufferGeometry()
  private tree: MeshBVH | null = null
  private queries: ContactBVH | null = null
  private refreshPending = true
  private readonly baseline = new Map<PairKey, boolean>()
  private readonly bounds: Float64Array
  private readonly illConditioned: Uint8Array
  private readonly numericPairs: boolean
  private readonly triangle = new ExtendedTriangle()
  private readonly other = new ExtendedTriangle()
  private readonly wasA = new ExtendedTriangle()
  private readonly wasB = new ExtendedTriangle()
  private readonly box = new THREE.Box3()

  constructor (faces: readonly Face[] | SurfaceContacts, equivalent: (point: number) => number = p => p) {
    this.topology = faces instanceof SurfaceContacts ? faces.topology : new ContactTopology(faces, equivalent)
    // Keep double precision for the narrow phase. Refit bounds are float32, so queries need outward padding below.
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float64Array(this.topology.points.length * 3), 3))
    this.geometry.setIndex(this.topology.index)
    this.bounds = new Float64Array(this.topology.faces.length * 6)
    this.illConditioned = new Uint8Array(this.topology.faces.length)
    // Typical meshes use exact small integer pair IDs. Retain exact addressing for arbitrarily large face lists.
    this.numericPairs = Number.isSafeInteger(this.topology.faces.length ** 2)
  }

  /** `refresh` starts a new proposal with the current live positions, including points changed by earlier dabs.
   * Later limit iterations only move `active`; all receiving primitives must be supplied together. */
  newContacts (active: ReadonlySet<number>, now: ReadPoint, before: ReadPoint, refresh: boolean,
    alreadyLimited: ReadonlySet<number> = new Set()): Set<number> {
    const steps = this.newContactSteps(active, now, before, refresh, alreadyLimited)
    let next = steps.next()
    while (!next.done) next = steps.next()
    return next.value
  }

  /** Face boundaries are safe cooperative yield points: no BVH traversal or shared triangle scratch is suspended. */
  *newContactSteps (active: ReadonlySet<number>, now: ReadPoint, before: ReadPoint, refresh: boolean,
    alreadyLimited: ReadonlySet<number> = new Set()): Generator<void, Set<number>, void> {
    const bad = new Set<number>()
    const { faces: triangles, points, vertices, incident, adjacent, index } = this.topology
    this.refreshPending ||= refresh
    if (triangles.length === 0 || [...active].every(p => alreadyLimited.has(p))) return bad
    const position = this.geometry.attributes.position
    const refreshAll = this.refreshPending
    for (const p of this.refreshPending ? points : active) {
      const vertex = vertices.get(p)
      if (vertex === undefined) continue
      const x = now(p); position.setXYZ(vertex, x.x, x.y, x.z)
    }
    this.refreshPending = false
    const faces = new Set<number>()
    for (const p of active) for (const f of incident.get(p) ?? []) faces.add(f)
    const positions = position.array
    const indices = index.array
    const bounds = this.bounds
    // The exact triangle bounds are reused across queries, including unpainted body faces. They are distinct from
    // the BVH's rounded Float32 bounds, and are refreshed after every position update before any query is made.
    for (const f of refreshAll ? triangles.keys() : faces) {
      const a = indices[f * 3] * 3; const b = indices[f * 3 + 1] * 3; const c = indices[f * 3 + 2] * 3; const k = f * 6
      for (let axis = 0; axis < 3; axis++) {
        bounds[k + axis] = Math.min(positions[a + axis], positions[b + axis], positions[c + axis])
        bounds[k + axis + 3] = Math.max(positions[a + axis], positions[b + axis], positions[c + axis])
      }
      // Match Triangle.getNormal's arithmetic, including zero/underflow/overflow, and the predicate's tiny-edge
      // degeneracy. Its conservative degenerate results are retained even when exact AABBs are disjoint.
      const ux = positions[c] - positions[b]; const uy = positions[c + 1] - positions[b + 1]; const uz = positions[c + 2] - positions[b + 2]
      const vx = positions[a] - positions[b]; const vy = positions[a + 1] - positions[b + 1]; const vz = positions[a + 2] - positions[b + 2]
      const wx = positions[c] - positions[a]; const wy = positions[c + 1] - positions[a + 1]; const wz = positions[c + 2] - positions[a + 2]
      const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx
      const normalSq = nx * nx + ny * ny + nz * nz
      this.illConditioned[f] = !(normalSq > 0 && Number.isFinite(normalSq)) ||
        Math.min(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz) <= 1e-30 ? 1 : 0
    }
    if (this.tree === null) { this.tree = this.topology.tree(this.geometry); this.queries = new ContactBVH(this.tree) }
    else if (refreshAll) this.tree.refit()
    else this.topology.refit(this.tree, active)
    const seen = new Set<PairKey>()
    const readTriangle = (face: Face, read: ReadPoint, target: ExtendedTriangle): void => {
      target.a.copy(read(face[0])); target.b.copy(read(face[1])); target.c.copy(read(face[2])); target.needsUpdate = true
    }
    for (const f of faces) {
      const face = triangles[f]
      if (!face.some(p => active.has(p) && !alreadyLimited.has(p) && !bad.has(p))) continue
      readTriangle(face, now, this.triangle)
      this.box.setFromPoints([this.triangle.a, this.triangle.b, this.triangle.c])
      // MeshBVH.refit stores extrema in Float32 without rounding outward. A rounded node plane can otherwise cull
      // a real Double-precision intersection, including a coplanar contact. Pad only the broad phase; the exact
      // finite triangles still decide the contact, so this is not a physical clearance margin.
      this.box.expandByScalar(Math.max(1, ...this.box.min.toArray().map(Math.abs), ...this.box.max.toArray().map(Math.abs)) * 2 ** -22)
      this.queries!.shapecast(this.box, (offset, count) => {
        // Indirect range offsets are BVH primitive addresses, not source face IDs. Resolve first; preserve their
        // traversal order and the existing pair exemptions before decoding any triangle scratch objects.
        for (let i = offset; i < offset + count; i++) {
          const g = this.tree!.resolveTriangleIndex(i)
          if (adjacent[f].has(g)) continue
          const k = g * 6
          if (this.illConditioned[f] === 0 && this.illConditioned[g] === 0 &&
            (bounds[k] > this.box.max.x || bounds[k + 3] < this.box.min.x ||
            bounds[k + 1] > this.box.max.y || bounds[k + 4] < this.box.min.y ||
            bounds[k + 2] > this.box.max.z || bounds[k + 5] < this.box.min.z)) continue
          const first = Math.min(f, g); const second = Math.max(f, g)
          const pair = this.numericPairs ? first * triangles.length + second : `${first}:${second}`
          if (seen.has(pair)) continue
          seen.add(pair)
          if (this.baseline.get(pair) === true) continue
          const a = indices[g * 3] * 3; const b = indices[g * 3 + 1] * 3; const c = indices[g * 3 + 2] * 3
          this.other.a.fromArray(positions, a); this.other.b.fromArray(positions, b); this.other.c.fromArray(positions, c)
          this.other.needsUpdate = true
          if (!this.triangle.intersectsTriangle(this.other)) continue
          let existed = this.baseline.get(pair)
          if (existed === undefined) {
            readTriangle(face, before, this.wasA); readTriangle(triangles[g], before, this.wasB)
            existed = this.wasA.intersectsTriangle(this.wasB)
            this.baseline.set(pair, existed)
          }
          if (!existed) for (const p of [...face, ...triangles[g]]) if (active.has(p)) bad.add(p)
        }
        return false
      })
      yield
    }
    return bad
  }
}
