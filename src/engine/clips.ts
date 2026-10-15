// Library clip loading and per-character retarget caching.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { captureRest, canonical, retarget, type RestSkeleton, type RetargetOptions } from './retarget.ts'

export interface SourceClip {
  root: THREE.Object3D
  rest: RestSkeleton
  clip: THREE.AnimationClip
}

const loader = new GLTFLoader()
const sources = new Map<string, Promise<SourceClip>>()
const MAX_SOURCES = 200

const JOINT = /^(mixamorig\d*[:_]?)?(Hips|Spine\d?|Neck|Head(Top_End)?|(Left|Right)(Shoulder|Arm|ForeArm|Hand.*|UpLeg|Leg|Foot|ToeBase|Toe_End))$/

export function isMixamoJoint (o: THREE.Object3D): boolean {
  return JOINT.test(o.name) || (o as THREE.Bone).isBone === true
}

const files = new Map<string, Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }>>()

/** Load (and cache) a clip: its skeleton at rest and the animation. `file.glb#Name` picks a named clip. */
export async function loadSource (url: string): Promise<SourceClip> {
  let pending = sources.get(url)
  if (pending === undefined) {
    const [file, hash] = url.split('#')
    let gltfPending = files.get(file)
    if (gltfPending === undefined) {
      gltfPending = loader.loadAsync(file)
      files.set(file, gltfPending)
      gltfPending.catch(() => files.delete(file))
    }
    pending = gltfPending.then(gltf => {
      const name = hash === undefined ? undefined : decodeURIComponent(hash)
      const clip = name === undefined ? gltf.animations[0] : gltf.animations.find(a => a.name === name)
      if (clip === undefined) throw new Error(`No animation ${name ?? ''} in ${file}`)
      // Multi-clip files share one scene: give each clip its own copy to pose.
      const root = name === undefined ? gltf.scene : cloneSkinned(gltf.scene)
      let hasBones = false
      root.traverse(o => { if ((o as THREE.Bone).isBone) hasBones = true })
      const rest = captureRest(root, o => hasBones ? (o as THREE.Bone).isBone === true : JOINT.test(o.name))
      return { root, rest, clip }
    })
    sources.set(url, pending)
    if (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value!)
    pending.catch(() => sources.delete(url))
  }
  return await pending
}

/** Retargeted clips, cached per target skeleton and options. */
export class RetargetCache {
  private readonly cache = new Map<string, Promise<THREE.AnimationClip>>()
  constructor (readonly target: RestSkeleton) {}

  async get (url: string, options: RetargetOptions = {}): Promise<THREE.AnimationClip> {
    const key = `${url}|${options.inPlace === true ? 1 : 0}|${options.mirror === true ? 1 : 0}|${options.samples ?? options.fps ?? 30}`
    let pending = this.cache.get(key)
    if (pending === undefined) {
      pending = loadSource(url).then(source => retarget(source.root, source.rest, source.clip, this.target, options))
      this.cache.set(key, pending)
      pending.catch(() => this.cache.delete(key))
    }
    return await pending
  }
}

export { canonical }
