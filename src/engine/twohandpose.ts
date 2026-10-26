// Seeds for a two-handed hold, from real people holding long things with both hands (the Mixamo library's rifles,
// staffs, great swords, bayonets, carried logs: static/templates/rom/human-twohand.json, written by
// tools/twohand_poses.ts). Given where the two fists must be (and the shaft's direction) relative to the body, it returns
// the most similar real upper-body poses, as local turns for a character, so a solver (src/engine/twohand.ts) starts
// from something a person does instead of from its fixed shares of the turn.
//
// The chest frame (the frame every grip is described and asked in): its origin the hips' joint raised by `rise` (the
// Spine2's height above the hips at rest: the chest's own upright place, so it moves with the hips but not with the
// spine's lean), its axes the world's (Y up); lengths in units of the body's `size` (the mean arm length, shoulder to
// wrist). A stored pose has its yaw taken out (the pelvis facing +Z: the heading of the line between the two hip
// joints), so a query is matched at the best heading: each seed comes with the yaw to turn the whole upper body by.
//
// A stored pose: the Hips' world turn with its yaw removed (the pelvis' tilt), and the local turns (on the Y Bot's rest, the
// library's) of Spine, Spine1, Spine2, Neck, Head and both Shoulder, Arm, ForeArm and Hand. A seed's turns are the
// character's own (the retarget's K: src/engine/retarget.ts), the hips' including the heading. Either hand may take
// either side of a pose: it is also tried mirrored (left for right, reflected across the body's middle).
import * as THREE from 'three'
import { handGrip } from './clipedit.ts'
import { retargetOffsets, type RestSkeleton } from './retarget.ts'

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

/** The bones a stored pose turns, parent before child: the first is the hips (stored as its yaw-free world turn). */
export const POSE_BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'] as const
export type PoseBone = typeof POSE_BONES[number]

const PARENT: Record<string, string> = {
  Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
}
const NQ = POSE_BONES.length * 4

const UP = new THREE.Vector3(0, 1, 0)
const tup = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z]

/** Which way a shaft's far end is, by convention (the library's props are unlabelled): towards the front of the body if the
 * shaft runs that way, else up, else to the body's right. +1: along `s`, -1: the other way. */
function farSign (s: Vec3 | THREE.Vector3): number {
  const [x, y, z] = Array.isArray(s) ? s : [s.x, s.y, s.z]
  const length = Math.hypot(x, y, z) || 1
  if (Math.abs(z) > 0.4 * length) return z > 0 ? 1 : -1
  if (Math.abs(y) > 1e-3) return y > 0 ? 1 : -1
  return x >= 0 ? 1 : -1
}

/** The other side's bone (the same bone for the middle ones). */
export function partnerOf (name: string): string {
  return name.startsWith('Left') ? 'Right' + name.slice(4) : name.startsWith('Right') ? 'Left' + name.slice(5) : name
}

/** A body's own measures, from its rest: its size (mean arm length) and the chest's rise above the hips. */
export interface BodyScale { size: number, rise: number }

export function bodyScale (rest: RestSkeleton): BodyScale | null {
  const at = (n: string): THREE.Vector3 | null => rest.bones.get(n)?.worldPosition ?? null
  const lengths: number[] = []
  for (const side of ['Left', 'Right']) {
    const a = at(`${side}Arm`); const f = at(`${side}ForeArm`); const h = at(`${side}Hand`)
    if (a !== null && f !== null && h !== null) lengths.push(a.distanceTo(f) + f.distanceTo(h))
  }
  const hips = at('Hips'); const chest = at('Spine2')
  if (lengths.length === 0 || hips === null || chest === null) return null
  return { size: lengths.reduce((s, x) => s + x, 0) / lengths.length, rise: chest.y - hips.y }
}

/** The bones of a posed body, in world: a posed skeleton's (a scene's: see `worldOfScene`), or a computed one. */
export interface PoseWorld {
  position: (name: string) => THREE.Vector3 | null
  quaternion: (name: string) => THREE.Quaternion | null
}

/** A posed scene's bones (by canonical name) as a PoseWorld; its world matrices must be up to date. */
export function worldOfBones (bones: Map<string, THREE.Object3D>): PoseWorld {
  return {
    position: n => bones.get(n)?.getWorldPosition(new THREE.Vector3()) ?? null,
    quaternion: n => bones.get(n)?.getWorldQuaternion(new THREE.Quaternion()) ?? null,
  }
}

/** The yaw of a body (about +Y, from +Z): the heading of the line across its hip joints (left to right), else of its hips' own turn. */
export function bodyYaw (w: PoseWorld): number | null {
  const l = w.position('LeftUpLeg'); const r = w.position('RightUpLeg')
  let f: THREE.Vector3 | null = null
  if (l !== null && r !== null) f = new THREE.Vector3().crossVectors(l.clone().sub(r), UP)
  else { const q = w.quaternion('Hips'); if (q !== null) f = new THREE.Vector3(0, 0, 1).applyQuaternion(q) }
  if (f === null) return null
  f.y = 0
  return f.lengthSq() < 1e-6 ? null : Math.atan2(f.x, f.z)
}

export interface Grip {
  /** The fists' middles in the chest frame, in units of size. */
  left: Vec3
  right: Vec3
  /** The shaft's direction (a unit vector; towards its far end: in the library, the end that points forward, else up). */
  shaft: Vec3
}

/** What a posed body's grip is: the fists in the chest frame (yaw taken out), the yaw, the hips' yaw-free world turn. */
export interface PoseGrip { grip: Grip, yaw: number, tilt: THREE.Quaternion, fists: [THREE.Vector3, THREE.Vector3] }

/** A body's grip as it stands (`fist`: each hand's fist middle in the hand's own frame: src/engine/clipedit.ts handGrip). */
export function gripOfPose (w: PoseWorld, fist: { Left: THREE.Vector3, Right: THREE.Vector3 }, scale: BodyScale): PoseGrip | null {
  const hips = w.position('Hips'); const hq = w.quaternion('Hips'); const yaw = bodyYaw(w)
  if (hips === null || hq === null || yaw === null) return null
  const unyaw = new THREE.Quaternion().setFromAxisAngle(UP, -yaw)
  const origin = hips.clone().add(new THREE.Vector3(0, scale.rise, 0))
  const fists = (['Left', 'Right'] as const).map(side => {
    const p = w.position(`${side}Hand`); const q = w.quaternion(`${side}Hand`)
    if (p === null || q === null) return null
    return p.add(fist[side].clone().applyQuaternion(q))
  })
  if (fists[0] === null || fists[1] === null) return null
  const f = fists.map(v => v!.clone().sub(origin).applyQuaternion(unyaw).divideScalar(scale.size)) as [THREE.Vector3, THREE.Vector3]
  const shaft = f[1].clone().sub(f[0]).normalize()
  if (farSign(shaft) < 0) shaft.negate()
  return { grip: { left: tup(f[0]), right: tup(f[1]), shaft: tup(shaft) }, yaw, tilt: unyaw.multiply(hq), fists: [fists[0], fists[1]] }
}

/** A grip, mirrored across the body's middle (the hands swap sides). */
export function mirrorGrip (g: Grip): Grip {
  const m = (v: Vec3): Vec3 => [-v[0], v[1], v[2]]
  return { left: m(g.right), right: m(g.left), shaft: m(g.shaft) }
}

/** The stored data (static/templates/rom/human-twohand.json). */
export interface TwoHandData {
  rig: 'human'
  bones: string[]
  /** The Y Bot's size and rise (m) the stored grips are in the units of. */
  size: number
  rise: number
  /** Where the poses come from: clip names; per pose its clip's index and frame (at 30 fps). */
  clips: string[]
  clip: number[]
  frame: number[]
  /** Per pose 9 numbers: the left fist, the right fist, the shaft (the chest frame, yaw out). */
  grip: number[]
  /** Per pose 56 numbers: the Hips' yaw-free world turn, then the local turns of the other 13 bones, in `bones` order. */
  turns: number[]
  [more: string]: unknown
}

/** What to ask: the fists' middles in the chest frame (metres of the character's own world; the chest frame's origin is the
 * hips' world position raised by `chestRise`, see `TwoHandSeeder.anchor`), and the shaft's direction if known (world axes,
 * towards its far end: the hand nearer it is the one the far end is beyond). */
export interface GripQuery { left: Vec3, right: Vec3, shaft?: Vec3 }

export interface SeedOptions {
  /** How many seeds (default 5). */
  k?: number
  /** Keep the heading within `within` radians of `near` (the body's own: the feet stay put). */
  heading?: { near: number, within: number }
  /** How many nearest in grip are posed and re-ranked by their real miss on this body (default 8 k). */
  pool?: number
}

export interface TwoHandSeed {
  /** The clip and frame it was taken from, and whether it is mirrored. */
  clip: string
  frame: number
  mirrored: boolean
  /** The turns to give the character's bones (local, [x, y, z, w]); the hips' include the heading. */
  turns: Partial<Record<PoseBone, Quat>>
  /** The yaw (about +Y, from +Z) the upper body is turned by. */
  heading: number
  /** How far each fist is from the query on this body with these turns, before any IK (m). */
  miss: { left: number, right: number, worst: number }
  /** The distance in grip space (units of size): the query's fists, the shaft. */
  distance: number
  /** The hand nearer the shaft's far end. */
  far: 'Left' | 'Right'
  /** Give a character's bones (by canonical name) these turns. */
  apply: (bones: Map<string, THREE.Object3D>) => void
}

const reflect = (q: THREE.Quaternion): THREE.Quaternion => new THREE.Quaternion(q.x, -q.y, -q.z, q.w)
const yawQ = (a: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(UP, a)

/** The yaw `a` (about +Y) that best turns the points `from` onto `to` (in the ground plane: both given), least squares. */
export function bestYaw (from: Vec3[], to: Vec3[]): number {
  let c = 0; let s = 0
  from.forEach((a, i) => { const b = to[i]; c += b[0] * a[0] + b[2] * a[2]; s += b[0] * a[2] - b[2] * a[0] })
  return Math.atan2(s, c)
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))
function clampHeading (a: number, h?: { near: number, within: number }): number {
  if (h === undefined) return a
  const d = wrap(a - h.near)
  return h.near + Math.max(-h.within, Math.min(h.within, d))
}

/**
 * The seeder for one character: `source` is the library's rest skeleton (a clip's, captureRest of its scene; the Y Bot's) and
 * `character` the character's own (captureRest of its rig). Both with Mixamo's canonical bone names.
 */
export class TwoHandSeeder {
  readonly scale: BodyScale
  private readonly data: TwoHandData
  private readonly source: RestSkeleton
  private readonly character: RestSkeleton
  private readonly k: Map<string, THREE.Quaternion>
  private readonly fist: { Left: THREE.Vector3, Right: THREE.Vector3 }
  /** Each bone's rest offset from its parent, in the parent's rest frame (the character's). */
  private readonly offset = new Map<string, THREE.Vector3>()
  private readonly hipsParent: THREE.Quaternion
  private readonly n: number

  constructor (data: TwoHandData, source: RestSkeleton, character: RestSkeleton) {
    this.data = data
    this.source = source
    this.character = character
    const scale = bodyScale(character)
    const left = handGrip(character, 'Left'); const right = handGrip(character, 'Right')
    if (scale === null || left === null || right === null) throw new Error('twohandpose: the character needs Mixamo arms, hands and fingers')
    for (const b of POSE_BONES) if (!character.bones.has(b) || !source.bones.has(b)) throw new Error(`twohandpose: no ${b}`)
    this.scale = scale
    this.fist = { Left: left.fist, Right: right.fist }
    this.k = retargetOffsets(source, character).offsets
    for (const b of POSE_BONES) {
      const p = PARENT[b]
      if (p === undefined) continue
      const pb = character.bones.get(p)!
      this.offset.set(b, character.bones.get(b)!.worldPosition.clone().sub(pb.worldPosition).applyQuaternion(pb.worldQuaternion.clone().invert()))
    }
    const parent = character.parentWorld.get('Hips')
    this.hipsParent = parent === undefined ? new THREE.Quaternion() : new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(parent))
    this.n = data.clip.length
  }

  /** The chest frame's origin for a body whose hips are at `hips` (world). */
  anchor (hips: THREE.Vector3): THREE.Vector3 {
    return hips.clone().add(new THREE.Vector3(0, this.scale.rise, 0))
  }

  /** A query from the world: the fists' middles (and the shaft) of a body whose hips are at `hips`. */
  queryFromWorld (hips: THREE.Vector3, left: THREE.Vector3, right: THREE.Vector3, shaft?: THREE.Vector3): GripQuery {
    const o = this.anchor(hips)
    return { left: tup(left.clone().sub(o)), right: tup(right.clone().sub(o)), shaft: shaft === undefined ? undefined : tup(shaft.clone().normalize()) }
  }

  /** The `i`th stored pose, as 56 numbers of the source's own, mirrored if asked (a pose in the same form). */
  private pose (i: number, mirrored: boolean): number[] {
    const q = this.data.turns.slice(i * NQ, (i + 1) * NQ)
    return mirrored ? this.mirror(q) : q
  }

  /** The source's world turns of a stored pose (Hips: as stored, the yaw-free tilt). */
  private sourceWorld (q: number[]): Map<string, THREE.Quaternion> {
    const w = new Map<string, THREE.Quaternion>()
    POSE_BONES.forEach((b, j) => {
      const turn = new THREE.Quaternion().fromArray(q, j * 4)
      const p = PARENT[b]
      w.set(b, p === undefined ? turn : w.get(p)!.clone().multiply(turn))
    })
    return w
  }

  /** A stored pose mirrored (each bone's world turn from its partner's change from rest, reflected, onto its own rest). */
  private mirror (q: number[]): number[] {
    const w = this.sourceWorld(q)
    const m = new Map<string, THREE.Quaternion>()
    for (const b of POSE_BONES) {
      const o = partnerOf(b)
      const restO = this.source.bones.get(o)!.worldQuaternion
      // (the hips' stored turn is already without yaw: its rest has the yaw it has)
      const delta = w.get(o)!.clone().multiply(restO.clone().invert())
      m.set(b, reflect(delta).multiply(this.source.bones.get(b)!.worldQuaternion))
    }
    const out: number[] = []
    for (const b of POSE_BONES) {
      const p = PARENT[b]
      const local = p === undefined ? m.get(b)! : m.get(p)!.clone().invert().multiply(m.get(b)!)
      out.push(local.x, local.y, local.z, local.w)
    }
    return out
  }

  /** The character's world turns of a stored pose turned by `heading`. */
  private characterWorld (q: number[], heading: number): Map<string, THREE.Quaternion> {
    const y = yawQ(heading)
    const w = this.sourceWorld(q)
    const c = new Map<string, THREE.Quaternion>()
    for (const b of POSE_BONES) c.set(b, y.clone().multiply(w.get(b)!).multiply(this.k.get(b) ?? new THREE.Quaternion()))
    return c
  }

  /** The character's local turns from its world ones. */
  private locals (c: Map<string, THREE.Quaternion>): Partial<Record<PoseBone, Quat>> {
    const out: Partial<Record<PoseBone, Quat>> = {}
    for (const b of POSE_BONES) {
      const p = PARENT[b]
      const local = (p === undefined ? this.hipsParent.clone() : c.get(p)!.clone()).invert().multiply(c.get(b)!).normalize()
      out[b] = [local.x, local.y, local.z, local.w]
    }
    return out
  }

  /** The fists' middles on the character (the chest frame, metres) with these world turns, the hips at the chest frame's origin less `rise`. */
  fistsOf (c: Map<string, THREE.Quaternion>): [THREE.Vector3, THREE.Vector3] {
    const p = new Map<string, THREE.Vector3>([['Hips', new THREE.Vector3(0, -this.scale.rise, 0)]])
    for (const b of POSE_BONES) {
      const parent = PARENT[b]
      if (parent === undefined) continue
      p.set(b, p.get(parent)!.clone().add(this.offset.get(b)!.clone().applyQuaternion(c.get(parent)!)))
    }
    return (['Left', 'Right'] as const).map(side => p.get(`${side}Hand`)!.clone().add(this.fist[side].clone().applyQuaternion(c.get(`${side}Hand`)!))) as [THREE.Vector3, THREE.Vector3]
  }

  /** A seed from a stored pose (in the source's own form), best-headed (or kept near) for the query. */
  private seedOf (q: number[], query: GripQuery, opts: SeedOptions, info: { clip: string, frame: number, mirrored: boolean, distance: number }): TwoHandSeed {
    const flat = this.fistsOf(this.characterWorld(q, 0))
    const heading = clampHeading(bestYaw(flat.map(tup), [query.left, query.right]), opts.heading)
    const c = this.characterWorld(q, heading)
    const f = this.fistsOf(c)
    const left = f[0].distanceTo(new THREE.Vector3(...query.left)); const right = f[1].distanceTo(new THREE.Vector3(...query.right))
    const turns = this.locals(c)
    const seed: TwoHandSeed = {
      ...info, turns, heading, miss: { left, right, worst: Math.max(left, right) }, far: this.farOf(f),
      apply: bones => { for (const b of POSE_BONES) { const o = bones.get(b); if (o !== undefined) { o.quaternion.fromArray(turns[b]!); o.updateMatrixWorld(true) } } },
    }
    this.posesOfSeeds.set(seed, q)
    return seed
  }

  private farOf (f: [THREE.Vector3, THREE.Vector3]): 'Left' | 'Right' {
    return farSign(f[1].clone().sub(f[0])) > 0 ? 'Right' : 'Left'
  }

  /** The distance (units of size, squared) from a stored grip (turned by the best yaw) to the query, and that yaw. */
  private distance (g: Grip, q: { left: Vec3, right: Vec3, shaft?: Vec3 }, heading?: { near: number, within: number }): { d: number, yaw: number } {
    const yaw = clampHeading(bestYaw([g.left, g.right], [q.left, q.right]), heading)
    const c = Math.cos(yaw); const s = Math.sin(yaw)
    const turn = (v: Vec3): Vec3 => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]
    const a = turn(g.left); const b = turn(g.right)
    let d = (a[0] - q.left[0]) ** 2 + (a[1] - q.left[1]) ** 2 + (a[2] - q.left[2]) ** 2 + (b[0] - q.right[0]) ** 2 + (b[1] - q.right[1]) ** 2 + (b[2] - q.right[2]) ** 2
    if (q.shaft !== undefined) {
      const t = turn(g.shaft)
      const dot = t[0] * q.shaft[0] + t[1] * q.shaft[1] + t[2] * q.shaft[2]
      // (a shaft along the same line: one end or the other is the far one: a smaller matter than where the fists are)
      d += 0.05 * (1 - Math.abs(dot)) + (dot < 0 ? 0.01 : 0)
    }
    return { d, yaw }
  }

  /**
   * The seeds for a query: the `k` stored poses whose grips are nearest (the best heading for each, either way round), posed on this
   * body and ranked by how far their fists really land from the query (before any IK), and the blend of them.
   */
  seeds (query: GripQuery, opts: SeedOptions = {}): { seeds: TwoHandSeed[], blend: TwoHandSeed | null } {
    const k = opts.k ?? 5
    const size = this.scale.size
    const q = { left: query.left.map(x => x / size) as Vec3, right: query.right.map(x => x / size) as Vec3, shaft: query.shaft }
    const grip = this.data.grip
    const found: Array<{ i: number, mirrored: boolean, d: number }> = []
    for (let i = 0; i < this.n; i++) {
      const g: Grip = { left: [grip[i * 9], grip[i * 9 + 1], grip[i * 9 + 2]], right: [grip[i * 9 + 3], grip[i * 9 + 4], grip[i * 9 + 5]], shaft: [grip[i * 9 + 6], grip[i * 9 + 7], grip[i * 9 + 8]] }
      found.push({ i, mirrored: false, d: this.distance(g, q, opts.heading).d })
      found.push({ i, mirrored: true, d: this.distance(mirrorGrip(g), q, opts.heading).d })
    }
    const pool = found.sort((a, b) => a.d - b.d).slice(0, Math.max(k, opts.pool ?? 8 * k))
    // (neighbouring frames of one clip are the same hold: one of them)
    const seen = new Set<string>()
    const seeds: TwoHandSeed[] = []
    for (const f of pool) {
      const key = `${this.data.clip[f.i]}${f.mirrored ? 'm' : ''}`
      if (seen.has(key)) continue
      seen.add(key)
      seeds.push(this.seedOf(this.pose(f.i, f.mirrored), query, opts, { clip: this.data.clips[this.data.clip[f.i]], frame: this.data.frame[f.i], mirrored: f.mirrored, distance: Math.sqrt(f.d) }))
    }
    seeds.sort((a, b) => a.miss.worst - b.miss.worst)
    seeds.length = Math.min(seeds.length, k)
    return { seeds, blend: this.blend(seeds, query, opts) }
  }

  /** The seeds' mean (each weighted by how near its fists land), a pose of its own, headed for the query. */
  private blend (seeds: TwoHandSeed[], query: GripQuery, opts: SeedOptions): TwoHandSeed | null {
    if (seeds.length === 0) return null
    const poses = seeds.map(s => this.poseOfSeed(s))
    const weights = seeds.map(s => 1 / (s.miss.worst + 0.02) ** 2)
    const sum = weights.reduce((a, b) => a + b, 0)
    const out: number[] = []
    for (let j = 0; j < POSE_BONES.length; j++) {
      const acc = new THREE.Quaternion(0, 0, 0, 0)
      const ref = new THREE.Quaternion().fromArray(poses[0], j * 4)
      poses.forEach((p, i) => {
        const q = new THREE.Quaternion().fromArray(p, j * 4)
        const sign = q.dot(ref) < 0 ? -1 : 1
        const w = weights[i] / sum * sign
        acc.set(acc.x + q.x * w, acc.y + q.y * w, acc.z + q.z * w, acc.w + q.w * w)
      })
      acc.normalize()
      out.push(acc.x, acc.y, acc.z, acc.w)
    }
    return this.seedOf(out, query, opts, { clip: seeds.map(s => s.clip).join('+'), frame: -1, mirrored: false, distance: Math.min(...seeds.map(s => s.distance)) })
  }

  /** The stored pose (source form, as mirrored) each seed was made from. */
  private readonly posesOfSeeds = new WeakMap<TwoHandSeed, number[]>()
  private poseOfSeed (s: TwoHandSeed): number[] {
    const known = this.posesOfSeeds.get(s)
    if (known === undefined) throw new Error('twohandpose: a seed of another seeder')
    return known
  }

  /** Where a stored pose's fists land on this body (the chest frame, metres) at a heading: for tests and diagnostics. */
  fistsOfStored (i: number, mirrored = false, heading = 0): [THREE.Vector3, THREE.Vector3] {
    return this.fistsOf(this.characterWorld(this.pose(i, mirrored), heading))
  }

  /** The stored grip of the `i`th pose (units of size). */
  storedGrip (i: number): Grip {
    const g = this.data.grip
    return { left: [g[i * 9], g[i * 9 + 1], g[i * 9 + 2]], right: [g[i * 9 + 3], g[i * 9 + 4], g[i * 9 + 5]], shaft: [g[i * 9 + 6], g[i * 9 + 7], g[i * 9 + 8]] }
  }

  get count (): number { return this.n }
}
