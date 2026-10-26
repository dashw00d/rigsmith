// Retarget a clip from its source skeleton onto a character's skeleton, baking a new clip.
//
// Bones are matched by canonical (Mixamo) name. Rotations transfer in world space with a per-bone
// offset computed after aligning the two rest poses' bone directions, so a T-pose clip drives an
// A-pose character correctly (arms end up where the animation puts them, not offset by the rest
// difference). Hips translation is scaled by the ratio of hip heights.
//
// Arms also get their twist aligned: a stylized A-pose character's palms usually face its thighs, not
// the floor like the T-pose clip skeleton's, and aligning bone directions alone keeps that roll in
// every clip (hands turned, fingers curling sideways). Like Mixamo, we turn the hand so the palm
// faces where the clip's palm faces; the forearm takes half the twist so the wrist doesn't wring.
import * as THREE from 'three'

export interface RestBone {
  name: string
  node: THREE.Object3D
  parent: string | null
  localPosition: THREE.Vector3
  localQuaternion: THREE.Quaternion
  localScale: THREE.Vector3
  worldPosition: THREE.Vector3
  worldQuaternion: THREE.Quaternion
}

export type Side = 'Left' | 'Right'

export interface RestSkeleton {
  bones: Map<string, RestBone>
  /** Bones in parent-before-child order. */
  order: string[]
  /** World transform of the object holding the root bone(s). */
  parentWorld: Map<string, THREE.Matrix4>
  /** World direction each palm faces at rest, when known (measured from the skin, or a T-pose). */
  palms: Partial<Record<Side, THREE.Vector3>>
}

const PREFIX = /^mixamorig\d*[:_]?/

// Mesh2Motion's human rig (UE-mannequin style) -> Mixamo names, so its clips drive Mixamo characters.
const UE_TO_MIXAMO: Record<string, string> = {
  pelvis: 'Hips', spine_01: 'Spine', spine_02: 'Spine1', spine_03: 'Spine2', neck_01: 'Neck', head: 'Head', head_leaf: 'HeadTop_End',
}
const UE_SIDED: Record<string, string> = { clavicle: 'Shoulder', upperarm: 'Arm', lowerarm: 'ForeArm', hand: 'Hand', thigh: 'UpLeg', calf: 'Leg', foot: 'Foot', ball: 'ToeBase', ball_leaf: 'Toe_End' }

export function canonical (name: string): string {
  const bare = name.replace(PREFIX, '')
  if (UE_TO_MIXAMO[bare] !== undefined) return UE_TO_MIXAMO[bare]
  const sided = /^(.+)_(l|r)$/.exec(bare)
  if (sided !== null) {
    const side = sided[2] === 'l' ? 'Left' : 'Right'
    if (UE_SIDED[sided[1]] !== undefined) return side + UE_SIDED[sided[1]]
    const finger = /^(thumb|index|middle|ring|pinky)_0(\d)(_leaf)?$/.exec(sided[1])
    if (finger !== null) return `${side}Hand${finger[1][0].toUpperCase()}${finger[1].slice(1)}${finger[3] !== undefined ? 4 : finger[2]}`
  }
  return bare
}

/** The bone that carries body translation: Hips for humanoids, hips/pelvis for creatures. */
export function pelvisName (skeleton: RestSkeleton): string {
  for (const n of ['Hips', 'hips', 'pelvis', 'Pelvis']) if (skeleton.bones.has(n)) return n
  const root = skeleton.order[0]
  return [...skeleton.bones.values()].find(b => b.parent === root)?.name ?? root
}

/**
 * Snapshot the current (rest) pose of every node under root that looks like a skeleton joint.
 * `rename` maps a node name to its canonical (Mixamo) name for custom skeletons; null falls back to
 * the built-in naming rules.
 */
export function captureRest (root: THREE.Object3D, isJoint: (o: THREE.Object3D) => boolean, rename?: (name: string) => string | null): RestSkeleton {
  const nameOf = (o: THREE.Object3D): string => rename?.(o.name) ?? canonical(o.name)
  root.updateMatrixWorld(true)
  const bones = new Map<string, RestBone>()
  const order: string[] = []
  const parentWorld = new Map<string, THREE.Matrix4>()
  root.traverse(object => {
    if (!isJoint(object)) return
    const name = nameOf(object)
    if (bones.has(name)) return
    const parentIsJoint = object.parent !== null && isJoint(object.parent)
    const parent = parentIsJoint ? nameOf(object.parent!) : null
    if (!parentIsJoint) parentWorld.set(name, object.parent?.matrixWorld.clone() ?? new THREE.Matrix4())
    bones.set(name, {
      name,
      node: object,
      parent,
      localPosition: object.position.clone(),
      localQuaternion: object.quaternion.clone(),
      localScale: object.scale.clone(),
      worldPosition: object.getWorldPosition(new THREE.Vector3()),
      worldQuaternion: object.getWorldQuaternion(new THREE.Quaternion()),
    })
    order.push(name)
  })
  const skeleton: RestSkeleton = { bones, order, parentWorld, palms: {} }
  skeleton.palms = restPalms(root, skeleton, nameOf)
  return skeleton
}

const FORWARD = new THREE.Vector3(0, 0, 1)

/** Palm normal for a hand pointing along `direction` with the thumb forward (A/T-pose convention). */
function assumedPalm (direction: THREE.Vector3, side: Side): THREE.Vector3 {
  const lateral = FORWARD.clone().addScaledVector(direction, -FORWARD.dot(direction)).normalize()
  return side === 'Left' ? new THREE.Vector3().crossVectors(direction, lateral).normalize() : new THREE.Vector3().crossVectors(lateral, direction).normalize()
}

/** Rest direction of a hand: toward the middle (or index) knuckle, else along the forearm. */
function handDirection (skeleton: RestSkeleton, side: Side): THREE.Vector3 | null {
  const hand = skeleton.bones.get(side + 'Hand')
  if (hand === undefined) return null
  for (const knuckle of ['Middle1', 'Index1', 'Ring1', 'Pinky1']) {
    const b = skeleton.bones.get(side + 'Hand' + knuckle)
    if (b !== undefined && b.worldPosition.distanceTo(hand.worldPosition) > 1e-5) return b.worldPosition.clone().sub(hand.worldPosition).normalize()
  }
  const forearm = skeleton.bones.get(side + 'ForeArm')
  if (forearm === undefined) return null
  const d = hand.worldPosition.clone().sub(forearm.worldPosition)
  return d.lengthSq() < 1e-12 ? null : d.normalize()
}

/**
 * Palms from the skinned mesh: the flattest axis of the vertices the hand bones drive, signed so the
 * thumb points forward. Skeletons without a mesh (clip sources) get the T-pose convention (palms
 * down) when their arms are horizontal.
 */
function restPalms (root: THREE.Object3D, skeleton: RestSkeleton, nameOf: (o: THREE.Object3D) => string): Partial<Record<Side, THREE.Vector3>> {
  const out: Partial<Record<Side, THREE.Vector3>> = {}
  const points: Record<Side, THREE.Vector3[]> = { Left: [], Right: [] }
  const v = new THREE.Vector3()
  root.traverse(o => {
    const mesh = o as THREE.SkinnedMesh
    if (mesh.isSkinnedMesh !== true || mesh.skeleton === undefined) return
    const sideOf = mesh.skeleton.bones.map(b => { const n = nameOf(b); return n.startsWith('LeftHand') ? 'Left' : n.startsWith('RightHand') ? 'Right' : null })
    const position = mesh.geometry.attributes.position
    const index = mesh.geometry.attributes.skinIndex
    const weight = mesh.geometry.attributes.skinWeight
    if (index === undefined || weight === undefined) return
    for (let i = 0; i < position.count; i++) {
      const total = { Left: 0, Right: 0 }
      for (let k = 0; k < 4; k++) {
        const side = sideOf[index.getComponent(i, k)]
        if (side !== null && side !== undefined) total[side] += weight.getComponent(i, k)
      }
      for (const side of ['Left', 'Right'] as const) {
        if (total[side] > 0.5) points[side].push(v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).clone())
      }
    }
  })
  for (const side of ['Left', 'Right'] as const) {
    const direction = handDirection(skeleton, side)
    if (direction === null) continue
    const expected = assumedPalm(direction, side)
    const measured = points[side].length >= 24 ? flattestAxis(points[side]) : null
    if (measured !== null) {
      const palm = measured.addScaledVector(direction, -measured.dot(direction)).normalize()
      out[side] = palm.dot(expected) < 0 ? palm.negate() : palm
    } else if (points[side].length === 0 && Math.abs(direction.y) < 0.3) {
      out[side] = expected
    }
  }
  return out
}

/** Unit normal of the best-fit plane of a point set, or null when the points aren't flat. */
function flattestAxis (points: THREE.Vector3[]): THREE.Vector3 | null {
  const mean = new THREE.Vector3()
  for (const p of points) mean.add(p)
  mean.divideScalar(points.length)
  const c = [0, 0, 0, 0, 0, 0] // xx xy xz yy yz zz
  for (const p of points) {
    const x = p.x - mean.x; const y = p.y - mean.y; const z = p.z - mean.z
    c[0] += x * x; c[1] += x * y; c[2] += x * z; c[3] += y * y; c[4] += y * z; c[5] += z * z
  }
  const { values, vectors } = symmetricEigen([[c[0], c[1], c[2]], [c[1], c[3], c[4]], [c[2], c[4], c[5]]])
  // Ascending eigenvalues: [0] is the plane normal. A blob (fist) has no clear plane.
  if (Math.sqrt(values[0] / Math.max(values[1], 1e-12)) > 0.8) return null
  return vectors[0]
}

/** Jacobi eigen-decomposition of a symmetric 3x3 matrix; eigenvalues ascending with their vectors. */
function symmetricEigen (m: number[][]): { values: number[], vectors: THREE.Vector3[] } {
  const a = m.map(r => r.slice())
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q]
    if (off < 1e-20) break
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const cos = 1 / Math.sqrt(t * t + 1)
        const sin = t * cos
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p]; const akq = a[k][q]
          a[k][p] = cos * akp - sin * akq; a[k][q] = sin * akp + cos * akq
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k]; const aqk = a[q][k]
          a[p][k] = cos * apk - sin * aqk; a[q][k] = sin * apk + cos * aqk
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p]; const vkq = v[k][q]
          v[k][p] = cos * vkp - sin * vkq; v[k][q] = sin * vkp + cos * vkq
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j])
  return { values: order.map(i => a[i][i]), vectors: order.map(i => new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize()) }
}

const MAIN_CHILD: Record<string, string> = { Hips: 'Spine', Spine2: 'Neck', LeftHand: 'LeftHandMiddle1', RightHand: 'RightHandMiddle1' }

function descendants (skeleton: RestSkeleton, name: string): number {
  let count = 0
  for (const b of skeleton.bones.values()) if (b.parent === name) count += 1 + descendants(skeleton, b.name)
  return count
}

/**
 * The child a bone points at: the continuation of its chain. Must not depend on file order, so the
 * source and target skeletons agree: known Mixamo cases, else the child with the largest subtree
 * (spine over legs and tail), ties broken by name.
 */
export function mainChild (skeleton: RestSkeleton, name: string): string | null {
  const children = [...skeleton.bones.values()].filter(b => b.parent === name)
  const known = children.find(c => c.name === MAIN_CHILD[name])
  if (known !== undefined) return known.name
  if (children.length === 0) return null
  return children
    .map(c => ({ name: c.name, size: descendants(skeleton, c.name) }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))[0].name
}

/** The direction a bone points at rest: toward its main child (or the given one), or null for leaves. */
function restDirection (skeleton: RestSkeleton, name: string, toward?: string): THREE.Vector3 | null {
  const bone = skeleton.bones.get(name)!
  const childName = toward ?? mainChild(skeleton, name)
  const child = childName === null ? undefined : skeleton.bones.get(childName)
  if (child === undefined) return null
  const d = child.worldPosition.clone().sub(bone.worldPosition)
  return d.lengthSq() < 1e-12 ? null : d.normalize()
}

/** Hands point at the same knuckle on both skeletons (a mitten rig has no middle finger). */
function sharedChild (source: RestSkeleton, target: RestSkeleton, name: string): string | undefined {
  if (name !== 'LeftHand' && name !== 'RightHand') return undefined
  for (const knuckle of ['Middle1', 'Index1', 'Ring1', 'Pinky1']) {
    const child = name + knuckle
    if (source.bones.has(child) && target.bones.has(child)) return child
  }
  return undefined
}

/** Which palm (if any) sets a bone's twist, and how much of it: half on the forearm, all on the hand. */
function twistOf (name: string): { side: Side, amount: number } | null {
  for (const side of ['Left', 'Right'] as const) {
    if (name === side + 'ForeArm') return { side, amount: 0.5 }
    if (name.startsWith(side + 'Hand')) return { side, amount: 1 }
  }
  return null
}

/** Rotation whose Y axis is `direction` and whose Z axis is `palm` made perpendicular to it. */
function basis (direction: THREE.Vector3, palm: THREE.Vector3): THREE.Quaternion | null {
  const z = palm.clone().addScaledVector(direction, -palm.dot(direction))
  if (z.lengthSq() < 1e-6) return null
  z.normalize()
  const x = new THREE.Vector3().crossVectors(direction, z)
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, direction, z))
}

/** Rotation taking the target's rest bone onto the source's: direction always, palm twist for arms. */
function alignment (source: RestSkeleton, target: RestSkeleton, name: string): THREE.Quaternion {
  const toward = sharedChild(source, target, name)
  const ds = restDirection(source, name, toward)
  const dt = restDirection(target, name, toward)
  if (ds === null || dt === null) return new THREE.Quaternion()
  const swing = new THREE.Quaternion().setFromUnitVectors(dt, ds)
  const twist = twistOf(name)
  const ps = twist === null ? undefined : source.palms[twist.side]
  const pt = twist === null ? undefined : target.palms[twist.side]
  if (twist === null || ps === undefined || pt === undefined) return swing
  const fs = basis(ds, ps)
  const ft = basis(dt, pt)
  if (fs === null || ft === null) return swing
  const full = fs.multiply(ft.invert())
  // full = T * swing with T a rotation about ds; apply only `amount` of T.
  const t = full.clone().multiply(swing.clone().invert())
  return new THREE.Quaternion().slerp(t, twist.amount).multiply(swing)
}

export interface RetargetOptions {
  fps?: number
  /** Bake exactly this many evenly spaced frames instead of sampling at fps (used for previews). */
  samples?: number
  inPlace?: boolean
  /** Mirror left/right (swap sides and reflect across the YZ plane). */
  mirror?: boolean
}

function hipsHeight (skeleton: RestSkeleton): number {
  const hips = skeleton.bones.get(pelvisName(skeleton))
  if (hips === undefined) return 1
  let min = Infinity
  for (const b of skeleton.bones.values()) min = Math.min(min, b.worldPosition.y)
  return Math.max(hips.worldPosition.y - Math.min(min, 0), 1e-4)
}

/** A joint's world matrix at rest, from its rig's parent down its chain of rest locals; `null` the frame above the top
 * joint `child` hangs in. */
function restWorld (skeleton: RestSkeleton, name: string | null, child: string): THREE.Matrix4 {
  if (name === null) return (skeleton.parentWorld.get(child) ?? new THREE.Matrix4()).clone()
  const b = skeleton.bones.get(name)!
  return restWorld(skeleton, b.parent, name).multiply(new THREE.Matrix4().compose(b.localPosition, b.localQuaternion, b.localScale))
}

export function retarget (sourceRoot: THREE.Object3D, source: RestSkeleton, clip: THREE.AnimationClip, target: RestSkeleton, options: RetargetOptions = {}): THREE.AnimationClip {
  const fps = options.fps ?? 30
  // Single-frame pose clips have zero duration, which breaks looping; give them one frame of length.
  const duration = Math.max(clip.duration, 1 / fps)
  // Per-bone world-space offsets K so that Qtarget = Qsource(t) * K.
  const offsets = new Map<string, THREE.Quaternion>()
  for (const name of target.order) {
    const s = source.bones.get(name)
    const t = target.bones.get(name)!
    if (s === undefined) continue
    const aligned = alignment(source, target, name).multiply(t.worldQuaternion)
    offsets.set(name, s.worldQuaternion.clone().invert().multiply(aligned))
  }

  const sourceRig = new Map<string, THREE.Object3D>()
  sourceRoot.traverse(o => { const c = canonical(o.name); if (source.bones.has(c) && !sourceRig.has(c)) sourceRig.set(c, o) })
  const mixer = new THREE.AnimationMixer(sourceRoot)
  const action = mixer.clipAction(clip)
  // Once and held at the end: sampled at its very end, a looping action wraps to frame 0, and a clip that doesn't
  // loop (a death) would end on a copy of its first pose (a corpse standing back up when the game holds the end).
  action.setLoop(THREE.LoopOnce, 1)
  action.clampWhenFinished = true
  action.play()

  const frames = options.samples ?? Math.max(2, Math.round(duration * fps) + 1)
  const times = new Float32Array(frames)
  const rotations = new Map<string, Float32Array>()
  for (const name of target.order) rotations.set(name, new Float32Array(frames * 4))
  const hipsPositions = new Float32Array(frames * 3)
  const hipsName = pelvisName(target)
  const scale = hipsHeight(target) / hipsHeight(source)
  const sourceHips = source.bones.get(pelvisName(source))

  const world = new Map<string, THREE.Quaternion>()
  const q = new THREE.Quaternion()
  const parentQ = new THREE.Quaternion()
  const tmp = new THREE.Quaternion()
  const sPos = new THREE.Vector3()
  const hipsWorld: THREE.Vector3[] = []

  for (let f = 0; f < frames; f++) {
    const time = options.samples !== undefined ? (duration * f) / Math.max(frames - 1, 1) : Math.min(f / fps, duration)
    times[f] = time
    mixer.setTime(Math.min(time, clip.duration))
    sourceRoot.updateMatrixWorld(true)
    world.clear()
    for (const name of target.order) {
      const t = target.bones.get(name)!
      if (t.parent !== null && world.has(t.parent)) parentQ.copy(world.get(t.parent)!)
      else parentQ.setFromRotationMatrix(new THREE.Matrix4().extractRotation(target.parentWorld.get(name) ?? new THREE.Matrix4()))
      const node = sourceRig.get(name)
      const offset = offsets.get(name)
      if (node !== undefined && offset !== undefined) {
        node.getWorldQuaternion(q).multiply(offset)
      } else {
        q.copy(parentQ).multiply(t.localQuaternion)
      }
      world.set(name, q.clone())
      tmp.copy(parentQ).invert().multiply(q)
      rotations.get(name)!.set([tmp.x, tmp.y, tmp.z, tmp.w], f * 4)
    }
    const hipsNode = sourceRig.get(pelvisName(source))
    if (hipsNode !== undefined && sourceHips !== undefined) {
      hipsNode.getWorldPosition(sPos)
      hipsWorld.push(sPos.clone().sub(sourceHips.worldPosition).multiplyScalar(scale))
    }
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(sourceRoot)

  const tracks: THREE.KeyframeTrack[] = []
  for (const name of target.order) {
    const node = target.bones.get(name)!.node
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, rotations.get(name)!))
  }
  const hips = target.bones.get(hipsName)
  if (hips !== undefined && hipsWorld.length === frames) {
    if (options.inPlace === true) removeTravel(hipsWorld)
    // (into the frame the hips hang in: the rig's own parent, or the joint above them, a creature's root bone)
    const parentInverse = restWorld(target, hips.parent ?? null, hipsName).invert()
    const p = new THREE.Vector3()
    for (let f = 0; f < frames; f++) {
      p.copy(hips.worldPosition).add(hipsWorld[f]).applyMatrix4(parentInverse)
      hipsPositions.set([p.x, p.y, p.z], f * 3)
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${hips.node.name}.position`, times, hipsPositions))
  }
  let result = new THREE.AnimationClip(clip.name, duration, tracks)
  if (options.mirror === true) result = mirrorClip(result, target)
  return result
}

/** Remove net horizontal travel but keep sway: subtract the straight line from start to end. */
function removeTravel (offsets: THREE.Vector3[]): void {
  const n = offsets.length
  if (n < 2) {
    for (const o of offsets) { o.x = 0; o.z = 0 }
    return
  }
  // Some clips end on a copy of their first frame: the travel snaps back on the last step. The line is
  // fitted without that frame, which then closes the loop.
  const steps = offsets.slice(1).map((o, i) => Math.hypot(o.x - offsets[i].x, o.z - offsets[i].z))
  const typical = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]
  const wraps = n > 3 && steps[n - 2] > 4 * Math.max(typical, 1e-6)
  const m = wraps ? n - 1 : n
  // Least-squares line through the hips' horizontal path: the travel.
  let st = 0; let sx = 0; let sz = 0; let stt = 0; let stx = 0; let stz = 0
  for (let i = 0; i < m; i++) {
    st += i; sx += offsets[i].x; sz += offsets[i].z; stt += i * i; stx += i * offsets[i].x; stz += i * offsets[i].z
  }
  const d = m * stt - st * st
  const bx = d === 0 ? 0 : (m * stx - st * sx) / d
  const bz = d === 0 ? 0 : (m * stz - st * sz) / d
  const ax = (sx - bx * st) / m
  const az = (sz - bz * st) / m
  for (let i = 0; i < m; i++) {
    offsets[i].x -= ax + bx * i
    offsets[i].z -= az + bz * i
  }
  if (wraps) offsets[n - 1].copy(offsets[0]).setY(offsets[n - 1].y)
}

/** Mirror a baked clip: swap Left/Right tracks and reflect rotations/positions across X. */
export function mirrorClip (clip: THREE.AnimationClip, skeleton: RestSkeleton): THREE.AnimationClip {
  const byName = new Map(clip.tracks.map(t => [t.name, t]))
  const tracks = clip.tracks.map(track => {
    const [node, property] = track.name.split('.')
    const name = canonical(node)
    const other = name.startsWith('Left') ? 'Right' + name.slice(4) : name.startsWith('Right') ? 'Left' + name.slice(5) : name
    const otherNode = skeleton.bones.get(other)?.node.name ?? node
    const source = byName.get(`${otherNode}.${property}`) ?? track
    const values = source.values.slice()
    if (property === 'quaternion') {
      // Reflection across the YZ plane in parent space: (x, y, z, w) -> (x, -y, -z, w).
      for (let i = 0; i < values.length; i += 4) { values[i + 1] = -values[i + 1]; values[i + 2] = -values[i + 2] }
    } else if (property === 'position') {
      for (let i = 0; i < values.length; i += 3) values[i] = -values[i]
    }
    const Track = property === 'quaternion' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack
    return new Track(track.name, source.times.slice(), values)
  })
  return new THREE.AnimationClip(`${clip.name} (mirrored)`, clip.duration, tracks)
}
