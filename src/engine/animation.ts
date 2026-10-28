// The slot bake shared by viewport playback and GLB export: speed, scripts, ground, bone keys, prop paths.
import * as THREE from 'three'
import type { AnimationEntry, Character, ClipKey } from '../../server/workspace.ts'
import type { CharacterView } from './CharacterView.ts'
import type { RetargetCache } from './clips.ts'
import { applyScripts, handScripts, retime } from './scripts.ts'
import { applyBoneKeys, applyLift, propTracks } from './keys.ts'
import { garmentMatrix } from './placement.ts'
import { restUpOf } from './retarget.ts'

export const propNode = (name: string): string => `${name.replace(/[^\w]+/g, '_')}_place`
export const clipUrl = (id: string): string => `/files/library/clips/${id}.glb`
export const entryUrl = (entry: AnimationEntry): string => entry.url ?? clipUrl(entry.clipId)

export function boneRest (view: CharacterView): (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null {
  return bone => {
    const b = view.rest?.bones.get(bone)
    return b === undefined ? null : { q: b.localQuaternion.clone(), p: b.localPosition.clone() }
  }
}

/** Every visible rigid garment gets placement tracks, so a preceding clip's keys never leak into this one. */
export function withPropTracks (clip: THREE.AnimationClip, props: Record<string, ClipKey[]> | undefined, loop: boolean,
  character: Pick<Character, 'garments'>, root: THREE.Object3D): THREE.AnimationClip {
  const tracks = [...clip.tracks]
  for (const g of character.garments ?? []) {
    if (g.mode !== 'rigid' || root.getObjectByName(propNode(g.name)) === undefined) continue
    const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
    garmentMatrix(g).decompose(position, quaternion, new THREE.Vector3())
    const names = new Set([`${propNode(g.name)}.position`, `${propNode(g.name)}.quaternion`])
    // Replace any prior placement tracks rather than binding the same property twice.
    for (let i = tracks.length - 1; i >= 0; i--) if (names.has(tracks[i].name)) tracks.splice(i, 1)
    tracks.push(...propTracks(propNode(g.name), clip.duration, props?.[g.name], loop, { position, quaternion }, g.scale))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

export async function bakeEntry (character: Pick<Character, 'animations' | 'scripts' | 'garments'>, view: CharacterView,
  cache: Pick<RetargetCache, 'get'>, posable: THREE.Object3D, entry: AnimationEntry,
  options: { mirror?: boolean, fps?: number, urlFor?: (entry: AnimationEntry) => string } = {}): Promise<{
    clip: THREE.AnimationClip, unkeyed: THREE.AnimationClip, report: Record<string, unknown>
  }> {
  if (view.rest === null) throw new Error('The character has no skeleton')
  // (its own scripts and its hands' poses round what they carry)
  const scripts = handScripts(character)
  const build = async (e: AnimationEntry): Promise<THREE.AnimationClip> => retime(await cache.get((options.urlFor ?? entryUrl)(e), {
    inPlace: e.inPlace, mirror: options.mirror, fps: options.fps,
  }), e.speed)
  const clips = new Map([[entry.name, await build(entry)]])
  for (const s of scripts) {
    if (!s.enabled || s.kind !== 'pace' || s.clip !== entry.name) continue
    const like = character.animations.find(a => a.name === s.like)
    if (like !== undefined) clips.set(like.name, await build(like))
  }
  const { clips: out, report } = await applyScripts(posable, clips, scripts, async id => await cache.get(clipUrl(id), { inPlace: true, fps: options.fps }))
  const hips = view.rest.bones.get('Hips') ?? view.rest.bones.get('hips')
  let clip = out.get(entry.name)!
  if (hips !== undefined) clip = applyLift(clip, hips.name, entry.lift ?? 0, hips.localPosition, restUpOf(view.rest, hips.name))
  const unkeyed = clip
  clip = applyBoneKeys(clip, entry.keys?.bones, entry.loop, boneRest(view))
  return { clip: withPropTracks(clip, entry.keys?.props, entry.loop, character, posable), unkeyed, report }
}
