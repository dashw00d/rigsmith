// Where clips come from, retargeted onto one character. The bake (src/engine/bake.ts) asks a ClipSource; in the browser
// that is RetargetCache below (clips fetched), in the tools nodeClipSource (tools/lib/node3d.ts, files read). Both run
// the same retarget().
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { ClipRef } from '../model/types.ts'
import { captureRest, canonical, retarget, type RestSkeleton, type RetargetOptions } from './retarget.ts'

/** Clips retargeted onto one character. A string ref is a url. */
export interface ClipSource {
  get (ref: ClipRef | string, o: { inPlace: boolean, mirror?: boolean, fps?: number }): Promise<THREE.AnimationClip>
  /** The clip's own skeleton at rest (before the retarget): what joint limits are mapped through (src/engine/ikbuild.ts). */
  sourceRest?: (ref: ClipRef | string) => Promise<RestSkeleton>
}

/** A converted library clip's file. */
export const clipUrl = (id: string): string => `/files/library/clips/${id}.glb`

/** Where a clip loads from: its own url (a bundled clip, a creature's), else its converted library file. */
export const refUrl = (ref: ClipRef | string): string => typeof ref === 'string' ? ref : ref.url ?? clipUrl(ref.id)

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

/** A clip file written again (an edit saved over it): loaded afresh next time. */
export function forgetClip (file: string): void {
  files.delete(file)
  for (const url of [...sources.keys()]) if (url.split('#')[0] === file) sources.delete(url)
}

/** Retargeted clips, cached per target skeleton and options. */
export class RetargetCache implements ClipSource {
  private readonly cache = new Map<string, Promise<THREE.AnimationClip>>()
  readonly target: RestSkeleton

  constructor (target: RestSkeleton) { this.target = target }

  async sourceRest (ref: ClipRef | string): Promise<RestSkeleton> {
    return (await loadSource(refUrl(ref))).rest
  }

  /** Drop a clip's retargets (its file written again). */
  forget (url: string): void {
    for (const key of [...this.cache.keys()]) if (key.split('|')[0].split('#')[0] === url) this.cache.delete(key)
  }

  async get (ref: ClipRef | string, options: RetargetOptions = {}): Promise<THREE.AnimationClip> {
    const url = refUrl(ref)
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
