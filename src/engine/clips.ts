// Where clips come from, retargeted onto one character. The bake (src/engine/bake.ts) asks a ClipSource; in the browser
// that is RetargetCache below (clips fetched), in the tools nodeClipSource (tools/lib/node3d.ts, files read). Both run
// the same retarget().
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { ClipRef } from '../model/types.ts'
import { versioned } from './assetUrls.ts'
import { disposeObject, Lru, MB, objectBytes } from './lru.ts'
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

/** A clip's tracks' bytes. */
export function clipBytes (clip: THREE.AnimationClip): number {
  let n = 0
  for (const t of clip.tracks) n += t.times.byteLength + t.values.byteLength
  return n
}

type ClipFile = { scene: THREE.Group, animations: THREE.AnimationClip[] }
// (by versioned URL, so a clip file written again is a new entry: src/engine/assetUrls.ts)
const files = new Lru<ClipFile>({
  budget: 256 * MB, max: 400,
  size: f => objectBytes(f.scene) + f.animations.reduce((n, a) => n + clipBytes(a), 0),
  dispose: f => { disposeObject(f.scene) },
})
// (each clip of a file: its own posable copy of a file of several; the file's own scene for one)
const sources = new Lru<SourceClip>({ budget: Infinity, max: 400 })

const JOINT = /^(mixamorig\d*[:_]?)?(Hips|Spine\d?|Neck|Head(Top_End)?|(Left|Right)(Shoulder|Arm|ForeArm|Hand.*|UpLeg|Leg|Foot|ToeBase|Toe_End))$/

export function isMixamoJoint (o: THREE.Object3D): boolean {
  return JOINT.test(o.name) || (o as THREE.Bone).isBone === true
}

/** Load (and cache) a clip: its skeleton at rest and the animation. `file.glb#Name` picks a named clip. The file loads
 * by what it holds (its versioned URL), so one written again loads afresh. */
export async function loadSource (url: string): Promise<SourceClip> {
  const [plain, hash] = url.split('#')
  const file = versioned(plain)
  const key = hash === undefined ? file : `${file}#${hash}`
  return await sources.load(key, async () => {
    const gltf = await files.load(file, async () => await loader.loadAsync(file))
    const name = hash === undefined ? undefined : decodeURIComponent(hash)
    const clip = name === undefined ? gltf.animations[0] : gltf.animations.find(a => a.name === name)
    if (clip === undefined) throw new Error(`No animation ${name ?? ''} in ${plain}`)
    // Multi-clip files share one scene: give each clip its own copy to pose.
    const root = name === undefined ? gltf.scene : cloneSkinned(gltf.scene)
    let hasBones = false
    root.traverse(o => { if ((o as THREE.Bone).isBone) hasBones = true })
    const rest = captureRest(root, o => hasBones ? (o as THREE.Bone).isBone === true : JOINT.test(o.name))
    return { root, rest, clip }
  })
}

/** Retargeted clips, cached per target skeleton and options (by the clip file's versioned URL: one written again is
 * retargeted afresh). */
export class RetargetCache implements ClipSource {
  private readonly cache = new Lru<THREE.AnimationClip>({ budget: 128 * MB, max: 600, size: clipBytes })
  readonly target: RestSkeleton

  constructor (target: RestSkeleton) { this.target = target }

  async sourceRest (ref: ClipRef | string): Promise<RestSkeleton> {
    return (await loadSource(refUrl(ref))).rest
  }

  async get (ref: ClipRef | string, options: RetargetOptions = {}): Promise<THREE.AnimationClip> {
    const url = refUrl(ref)
    const [plain, name] = url.split('#')
    const file = versioned(plain)
    const key = `${name === undefined ? file : `${file}#${name}`}|${options.inPlace === true ? 1 : 0}|${options.mirror === true ? 1 : 0}|${options.samples ?? options.fps ?? 30}`
    return await this.cache.load(key, async () => {
      const source = await loadSource(url)
      return retarget(source.root, source.rest, source.clip, this.target, options)
    })
  }
}

export { canonical }
