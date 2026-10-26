// A clip edited in the animation editor written as a clip file of its own, on the skeleton it came from (a creature
// template's: a horse's clips aren't the library's Mixamo clips, src/engine/clipedit.ts unretarget gives the frames):
// the skeleton at rest (an Armature, its bones, a skin over one triangle so a loader makes them bones) and the clip.
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { pelvisName, type RestSkeleton } from './retarget.ts'
import type { SourceFrames } from './clipedit.ts'

/** The frames as a clip on the bones of `rest` (named as its nodes are), at their fps. */
export function framesClip (frames: SourceFrames, rest: RestSkeleton, name: string): THREE.AnimationClip {
  const times = frames.rotations.map((_, f) => f / frames.fps)
  const tracks: THREE.KeyframeTrack[] = frames.bones.map((bone, b) => {
    const node = rest.bones.get(bone)?.node.name ?? bone
    return new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, times, frames.rotations.flatMap(r => r[b]))
  })
  const hips = pelvisName(rest)
  const hipsNode = rest.bones.get(hips)?.node.name ?? hips
  tracks.push(new THREE.VectorKeyframeTrack(`${hipsNode}.position`, times, frames.hips.flat()))
  return new THREE.AnimationClip(name, times[times.length - 1] ?? 0, tracks)
}

/** A .glb of the skeleton `root` holds (at rest) and `clip`. */
export async function clipGlb (root: THREE.Object3D, rest: RestSkeleton, clip: THREE.AnimationClip): Promise<ArrayBuffer> {
  const copy = cloneSkinned(root)
  // (only the skeleton: no meshes; at rest)
  const meshes: THREE.Object3D[] = []
  copy.traverse(o => { if ((o as THREE.Mesh).isMesh === true) meshes.push(o) })
  for (const m of meshes) m.removeFromParent()
  const bones: THREE.Bone[] = []
  copy.traverse(o => {
    if ((o as THREE.Bone).isBone !== true) return
    const r = [...rest.bones.values()].find(b => b.node.name === o.name)
    if (r !== undefined) { o.position.copy(r.localPosition); o.quaternion.copy(r.localQuaternion); o.scale.copy(r.localScale) }
    bones.push(o as THREE.Bone)
  })
  copy.updateMatrixWorld(true)
  // a skin over one tiny triangle: what makes a glTF loader give the joints back as bones
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0], 3))
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4))
  const skin = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial())
  skin.name = 'skeleton'
  copy.add(skin)
  skin.bind(new THREE.Skeleton(bones))
  const out = await new GLTFExporter().parseAsync(copy, { binary: true, animations: [clip], onlyVisible: false })
  return out as ArrayBuffer
}
