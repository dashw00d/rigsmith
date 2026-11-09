// Footsteps found on the feet: "Add footsteps" lays a step event where each foot comes down in the clip as it plays.
// Each foot's lowest point (its foot or toe bone, whichever is lower) is followed through the clip; a foot comes down
// when it drops into the lowest fifth of its own range after it was lifted past the middle of it (two bands, so a foot
// that trembles on the ground isn't a step), as the ground fit reads flat feet off the clip's lowest contacts
// (src/engine/ground.ts). A foot that hardly lifts (an idle's shuffle) takes no steps. A loop is read round its seam.
import type * as THREE from 'three'
import { sample, saveBones } from '../../../engine/timing.ts'

/** The feet steps are found on, by skeleton: a person's two, a horse's four (the horse template's names). */
export const FEET: Array<{ name: string, bones: string[] }> = [
  { name: 'step.L', bones: ['LeftFoot', 'LeftToeBase'] },
  { name: 'step.R', bones: ['RightFoot', 'RightToeBase'] },
]
export const HOOVES: Array<{ name: string, bones: string[] }> = [
  { name: 'step.FL', bones: ['front_leg_foot_l'] },
  { name: 'step.FR', bones: ['front_leg_foot_r'] },
  { name: 'step.BL', bones: ['back_leg_foot_l'] },
  { name: 'step.BR', bones: ['back_leg_foot_r'] },
]

/** The frames (indices into `heights`) where a foot comes down. `lift`: the least rise that counts as a step. */
export function footfalls (heights: number[], loop: boolean, lift: number): number[] {
  if (heights.length < 3) return []
  const lo = Math.min(...heights); const hi = Math.max(...heights)
  if (hi - lo < lift) return []
  const down = lo + 0.2 * (hi - lo)
  const up = lo + 0.5 * (hi - lo)
  // (up: lifted past the middle; it comes down on the first frame back in the lowest band)
  const next = (raised: boolean, h: number): boolean => (h > up ? true : h <= down ? false : raised)
  let raised = heights[0] > up
  if (loop) for (const h of heights) raised = next(raised, h)
  const out: number[] = []
  heights.forEach((h, i) => {
    const was = raised
    raised = next(raised, h)
    if (was && !raised) out.push(i)
  })
  // (a loop's last frame is its first: a step there is the one at 0)
  if (loop && out.at(-1) === heights.length - 1) {
    out.pop()
    if (out[0] !== 0) out.unshift(0)
  }
  return out
}

export interface Footstep { name: string, bone: string, t: number }

/** Each foot's steps as played phases of `clip` (played on `root`, a posable copy, left as it was), for the feet of
 * `feet` the skeleton has. `height`: the character's, for the least lift (1.5 % of it). */
export function footsteps (root: THREE.Object3D, clip: THREE.AnimationClip, loop: boolean, height: number, feet = FEET): Footstep[] {
  const has = (n: string): boolean => root.getObjectByName(n) !== undefined
  const present = feet.map(f => ({ ...f, bones: f.bones.filter(has) })).filter(f => f.bones.length > 0)
  if (present.length === 0 || clip.duration <= 0) return []
  const restore = saveBones(root)
  const { times, at } = sample(root, clip, present.flatMap(f => f.bones), 60)
  restore()
  const out: Footstep[] = []
  for (const f of present) {
    const heights = times.map((_, i) => Math.min(...f.bones.map(b => at.get(b)![i].y)))
    for (const i of footfalls(heights, loop, 0.015 * height)) out.push({ name: f.name, bone: f.bones[0], t: Math.min(1, times[i] / clip.duration) })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Whether a clip's feet end where they began, as the hips carry them (within 3 % of `height`): a cycle that loops
 * round (a library walk or run is one stride of each foot), so its falls repeat every `clip.duration`. */
export function loopsRound (root: THREE.Object3D, clip: THREE.AnimationClip, height: number, feet = FEET): boolean {
  const bones = feet.map(f => f.bones[0]).filter(n => root.getObjectByName(n) !== undefined)
  if (bones.length === 0 || root.getObjectByName('Hips') === undefined || clip.duration <= 0) return false
  const restore = saveBones(root)
  const { at } = sample(root, clip, ['Hips', ...bones], 30)
  restore()
  const hips = at.get('Hips')!
  const last = hips.length - 1
  return bones.every(b => {
    const p = at.get(b)!
    return p[0].clone().sub(hips[0]).distanceTo(p[last].clone().sub(hips[last])) < 0.03 * height
  })
}

/** The steps not already there: none within `near` (played) of an event of the same name. */
export function newSteps (steps: Footstep[], have: Array<{ name: string, t: number }>, near: number): Footstep[] {
  return steps.filter(s => !have.some(e => e.name === s.name && Math.abs(e.t - s.t) < near))
}
