// Clip scripts: switchable changes a character's clips get on top of the library motion, the same in the viewer and
// in the game export (tools/game_export.ts), so what plays here is what the game gets.
//
//   grip  a hand holds something in every clip: its fingers keep the most closed fist of a chosen clip
//   blow  an attack is cut so its blow (the hand's fastest moment) lands at `at` of its length (the game times its
//         hits by that), or to a `window` of seconds around the blow
//   pace  a clip is retimed so its planted foot covers ground as fast as another clip's (the villager's Carry walks
//         at his Walk's pace)
//
// Order, everywhere: each clip at its entry's speed, then every grip, then every blow, then every pace.
import * as THREE from 'three'

export type ClipScript = GripScript | BlowScript | PaceScript
interface ScriptBase { id: string, enabled: boolean, /** why it is there */ note?: string }
export interface GripScript extends ScriptBase { kind: 'grip', side: 'Left' | 'Right', /** library clip id */ clip: string }
export interface BlowScript extends ScriptBase {
  kind: 'blow', /** entry name */ clip: string, /** where in the cut clip the blow lands (the game's 0.45) */ at: number
  /** The blow you picked, as a phase of the clip before it is cut (0 its start, 1 its end); unset: found (`hand`'s
   * fastest moment). */
  blowU?: number
  /** A blow later than `at`: cut the start (the wind-up goes) or hold the end (the last pose held after the blow, the
   * clip lengthened, so a bow's whole draw stays). Default cut. */
  late?: 'cut' | 'hold'
  hand?: string, window?: number
}
export interface PaceScript extends ScriptBase { kind: 'pace', /** entry name */ clip: string, /** entry name */ like: string }

export const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky']

export function describe (s: ClipScript): string {
  if (s.kind === 'grip') return `${s.side} fist closed in every clip`
  if (s.kind === 'blow') return `${s.clip}: the blow lands at ${Math.round(s.at * 100)}%${s.window !== undefined ? ` of ${s.window} s around it` : ''}`
  return `${s.clip}: paced like ${s.like}`
}

/** World positions of named bones while `clip` plays on `root`, sampled at `rate` Hz (the bones are left posed). */
export function sample (root: THREE.Object3D, clip: THREE.AnimationClip, names: string[], rate = 60): { times: number[], at: Map<string, THREE.Vector3[]> } {
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip)
  action.play()
  const bones = names.map(n => {
    const b = root.getObjectByName(n)
    if (b === undefined) throw new Error(`no bone ${n}`)
    return b
  })
  const at = new Map(names.map(n => [n, [] as THREE.Vector3[]]))
  const times: number[] = []
  for (let t = 0; t <= clip.duration + 1e-6; t += 1 / rate) {
    mixer.setTime(t)
    root.updateMatrixWorld(true)
    times.push(t)
    bones.forEach((b, i) => at.get(names[i])!.push(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)))
  }
  action.stop()
  mixer.uncacheRoot(root)
  return { times, at }
}

/** Every bone's local transform, to put back after sampling. */
export function saveBones (root: THREE.Object3D): () => void {
  const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = []
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]) })
  return () => {
    for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s) }
    root.updateMatrixWorld(true)
  }
}

/** The blow: when the hand moves fastest, away from the clip's ends (wind-up and recovery) and ignoring one-frame
 * jumps (clips that end on a copy of their first frame snap back on the last step). */
export function blowTime (root: THREE.Object3D, clip: THREE.AnimationClip, hand: string): number {
  const { times, at } = sample(root, clip, [hand])
  const p = at.get(hand)!
  const steps = p.slice(1).map((x, i) => x.distanceTo(p[i]))
  const typical = [...steps].sort((a, b) => a - b)[Math.floor(steps.length * 0.9)]
  let best = clip.duration * 0.45
  let speed = -1
  for (let i = 1; i < p.length - 1; i++) {
    if (times[i] < clip.duration * 0.05 || times[i] > clip.duration * 0.88) continue
    if (steps[i - 1] > 4 * typical || steps[i] > 4 * typical) continue
    const v = p[i + 1].distanceTo(p[i - 1]) / (times[i + 1] - times[i - 1])
    if (v > speed) { speed = v; best = times[i] }
  }
  return best
}

/** Ground covered per second: the planted (lower) foot's speed, the median over the clip. */
export function stride (root: THREE.Object3D, clip: THREE.AnimationClip, feet = ['LeftFoot', 'RightFoot']): number {
  const { times, at } = sample(root, clip, feet)
  const speeds: number[] = []
  for (let i = 1; i < times.length - 1; i++) {
    const foot = feet.reduce((low, f) => at.get(f)![i].y < at.get(low)![i].y ? f : low)
    const p = at.get(foot)!
    const dt = times[i + 1] - times[i - 1]
    speeds.push(Math.hypot(p[i + 1].x - p[i - 1].x, p[i + 1].z - p[i - 1].z) / dt)
  }
  speeds.sort((a, b) => a - b)
  return speeds[Math.floor(speeds.length / 2)]
}

/** The clip from `start` to `end`, with keys at both ends (the motion there, interpolated), so a file of it lasts
 * exactly end - start (a glTF clip lasts until its last key). */
export function cut (clip: THREE.AnimationClip, start: number, end: number, name = clip.name): THREE.AnimationClip {
  const tracks = clip.tracks.map(t => {
    const size = t.getValueSize()
    // (the track's own interpolant: a quaternion's slerps)
    const interpolant = (t as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
    const at = (time: number): number[] => Array.from(interpolant.evaluate(time) as ArrayLike<number>).slice(0, size)
    const times: number[] = [0]; const values: number[] = [...at(start)]
    for (let i = 0; i < t.times.length; i++) {
      if (t.times[i] <= start + 1e-6 || t.times[i] >= end - 1e-6) continue
      times.push(t.times[i] - start)
      for (let j = 0; j < size; j++) values.push(t.values[i * size + j])
    }
    times.push(end - start)
    values.push(...at(end))
    const Track = t.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack
    return new Track(t.name, times, values)
  })
  return new THREE.AnimationClip(name, end - start, tracks)
}

export function retime (clip: THREE.AnimationClip, speed: number): THREE.AnimationClip {
  if (speed === 1) return clip
  const tracks = clip.tracks.map(t => { const c = t.clone(); c.times = c.times.map(x => x / speed); return c })
  return new THREE.AnimationClip(clip.name, clip.duration / speed, tracks)
}

/** The fist of `side` at its most closed moment in `gripClip` (retargeted onto `root`): each finger bone's local
 * rotation then. Leaves the bones as they were. */
export function fistPose (root: THREE.Object3D, gripClip: THREE.AnimationClip, side: 'Left' | 'Right'): { pose: Map<string, THREE.Quaternion>, at: number, curl: number } {
  const restore = saveBones(root)
  const fingers: string[] = []
  root.traverse(o => { if ((o as THREE.Bone).isBone === true && new RegExp(`^${side}Hand(Thumb|Index|Middle|Ring|Pinky)\\d$`).test(o.name)) fingers.push(o.name) })
  const chains = FINGERS.map(f => [1, 2, 3, 4].map(i => `${side}Hand${f}${i}`).filter(n => fingers.includes(n))).filter(c => c.length > 1)
  if (chains.length === 0) { restore(); return { pose: new Map(), at: 0, curl: 0 } }
  const { times, at } = sample(root, gripClip, chains.flat(), 30)
  let best = 0; let curl = -1
  times.forEach((_, i) => {
    const c = chains.reduce((sum, ch) => {
      const pts = ch.map(n => at.get(n)![i])
      const len = pts.slice(1).reduce((d, x, k) => d + x.distanceTo(pts[k]), 0)
      return sum + 1 - pts[0].distanceTo(pts[pts.length - 1]) / Math.max(len, 1e-6)
    }, 0) / chains.length
    if (c > curl) { curl = c; best = times[i] }
  })
  const mixer = new THREE.AnimationMixer(root)
  mixer.clipAction(gripClip).play()
  mixer.setTime(best)
  const pose = new Map(fingers.map(n => [n, root.getObjectByName(n)!.quaternion.clone()]))
  mixer.stopAllAction()
  mixer.uncacheRoot(root)
  restore()
  return { pose, at: best, curl: curl / 0.45 }
}

/** `clip` with those fingers held still in `pose`. */
export function holdFist (clip: THREE.AnimationClip, pose: Map<string, THREE.Quaternion>): THREE.AnimationClip {
  const tracks = clip.tracks.filter(t => !pose.has(t.name.replace(/\.quaternion$/, '')))
  for (const [n, q] of pose) tracks.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, clip.duration], [...q.toArray(), ...q.toArray()]))
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** The attack cut so its blow lands at `at` of it (or `window` seconds around the blow). Leaves the bones as they were. */
export function blowCut (root: THREE.Object3D, clip: THREE.AnimationClip, s: Pick<BlowScript, 'at' | 'hand' | 'window' | 'blowU' | 'late'>): { clip: THREE.AnimationClip, blow: number, kept: [number, number] } {
  let blow: number
  if (s.blowU !== undefined) {
    blow = Math.min(1, Math.max(0, s.blowU)) * clip.duration
  } else {
    const restore = saveBones(root)
    blow = blowTime(root, clip, s.hand ?? 'RightHand')
    restore()
  }
  let start = 0; let end = clip.duration
  if (s.window !== undefined) {
    start = Math.max(0, blow - s.at * s.window)
    end = Math.min(clip.duration, start + s.window)
  } else if (blow / clip.duration < s.at) end = Math.min(clip.duration, blow / s.at)
  else if (s.late === 'hold') end = blow / s.at    // (past its end: the last pose held there)
  else start = Math.max(0, (blow - s.at * end) / (1 - s.at))
  return { clip: cut(clip, start, end), blow, kept: [start, end] }
}

/** `clip` retimed so its stride is `like`'s. Leaves the bones as they were. */
export function paceTo (root: THREE.Object3D, clip: THREE.AnimationClip, like: THREE.AnimationClip): { clip: THREE.AnimationClip, factor: number } {
  const restore = saveBones(root)
  const factor = stride(root, like) / stride(root, clip)
  restore()
  const out = retime(clip, factor)
  out.name = clip.name
  return { clip: out, factor }
}

/**
 * Apply a character's enabled scripts to its clips (name -> clip, each already at its entry's speed), in the order
 * above. `root` is a posable copy of the character (its bones are put back after); `gripClip` gives a grip's clip
 * retargeted onto it (in place). Returns the new clips and what each script did.
 */
export async function applyScripts (root: THREE.Object3D, clips: Map<string, THREE.AnimationClip>, scripts: ClipScript[],
  gripClip: (id: string) => Promise<THREE.AnimationClip>): Promise<{ clips: Map<string, THREE.AnimationClip>, report: Record<string, unknown> }> {
  const out = new Map(clips)
  const report: Record<string, unknown> = {}
  const on = scripts.filter(s => s.enabled)
  for (const s of on.filter((x): x is GripScript => x.kind === 'grip')) {
    const { pose, at, curl } = fistPose(root, await gripClip(s.clip), s.side)
    for (const [name, clip] of out) out.set(name, holdFist(clip, pose))
    report[s.id] = { kind: 'grip', side: s.side, clip: s.clip, at: +at.toFixed(3), curl: +curl.toFixed(2) }
  }
  for (const s of on.filter((x): x is BlowScript => x.kind === 'blow')) {
    const clip = out.get(s.clip)
    if (clip === undefined) continue
    const r = blowCut(root, clip, s)
    out.set(s.clip, r.clip)
    report[s.id] = { kind: 'blow', clip: s.clip, at: s.at, window: s.window, blowU: s.blowU, blow: +r.blow.toFixed(3), kept: r.kept.map(x => +x.toFixed(3)), uncut: +clip.duration.toFixed(4) }
  }
  for (const s of on.filter((x): x is PaceScript => x.kind === 'pace')) {
    const clip = out.get(s.clip); const like = out.get(s.like)
    if (clip === undefined || like === undefined) continue
    const r = paceTo(root, clip, like)
    out.set(s.clip, r.clip)
    report[s.id] = { kind: 'pace', clip: s.clip, like: s.like, retimed: +r.factor.toFixed(3) }
  }
  return { clips: out, report }
}
