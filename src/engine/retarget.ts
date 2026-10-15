// Retarget a clip from its source skeleton onto a character's skeleton, baking a new clip.
//
// Bones are matched by canonical (Mixamo) name. Rotations transfer in world space with a per-bone
// offset computed after aligning the two rest poses' bone directions, so a T-pose clip drives an
// A-pose character correctly (arms end up where the animation puts them, not offset by the rest
// difference). Hips translation is scaled by the ratio of hip heights.
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

export interface RestSkeleton {
  bones: Map<string, RestBone>
  /** Bones in parent-before-child order. */
  order: string[]
  /** World transform of the object holding the root bone(s). */
  parentWorld: Map<string, THREE.Matrix4>
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
  return { bones, order, parentWorld }
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

/** The direction a bone points at rest: toward its main child, or null for leaves. */
function restDirection (skeleton: RestSkeleton, name: string): THREE.Vector3 | null {
  const bone = skeleton.bones.get(name)!
  const childName = mainChild(skeleton, name)
  const child = childName === null ? undefined : skeleton.bones.get(childName)
  if (child === undefined) return null
  const d = child.worldPosition.clone().sub(bone.worldPosition)
  return d.lengthSq() < 1e-12 ? null : d.normalize()
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
    const ds = restDirection(source, name)
    const dt = restDirection(target, name)
    let aligned = t.worldQuaternion.clone()
    if (ds !== null && dt !== null) aligned = new THREE.Quaternion().setFromUnitVectors(dt, ds).multiply(aligned)
    offsets.set(name, s.worldQuaternion.clone().invert().multiply(aligned))
  }

  const sourceRig = new Map<string, THREE.Object3D>()
  sourceRoot.traverse(o => { const c = canonical(o.name); if (source.bones.has(c) && !sourceRig.has(c)) sourceRig.set(c, o) })
  const mixer = new THREE.AnimationMixer(sourceRoot)
  const action = mixer.clipAction(clip)
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
    const parentInverse = (target.parentWorld.get(hipsName) ?? new THREE.Matrix4()).clone().invert()
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
  const start = offsets[0].clone()
  const end = offsets[n - 1].clone()
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1)
    offsets[i].x -= start.x + (end.x - start.x) * t
    offsets[i].z -= start.z + (end.z - start.z) * t
  }
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
