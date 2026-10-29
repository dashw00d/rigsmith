// The schema 2 bake frozen as it was at b281970 (src/engine/bake.ts, with the timing and keys functions it called from
// timing.ts and keys.ts copied in), for tests/equivalence/bake.test.ts: a schema 2 character's slots baked the old way,
// to compare with schema 3's bake of the same character migrated. Its other imports (hands, mount, ground, geom,
// placement, retarget, select) are modules schema 3 left as they were. Never change it: it is the "before".
import * as THREE from 'three'
import type { Character, Gear, HandPose, Mount, Side } from '../../src/model/types.ts'
import type { V2Adjustment as Adjustment, V2AdjustmentKind as AdjustmentKind, V2Character, V2ClipKey as ClipKey, V2Slot as Slot, V2Window as Window } from '../../src/model/v2.ts'
import { gearById, heightOf } from '../../src/model/select.ts'
import type { ClipSource } from '../../src/engine/clips.ts'
import { firstSkinned, gearNode } from '../../src/engine/geom.ts'
import { groundFit } from '../../src/engine/ground.ts'
import { applyHands as applyHandsV3, handLayers as handLayersV3, type HandLayer } from '../../src/engine/hands.ts'
import { fitRide, freezeClip } from '../../src/engine/mount.ts'
import { garmentMatrix } from '../../src/engine/placement.ts'
import { pelvisName, restUpOf, type RestSkeleton } from '../../src/engine/retarget.ts'

type BlowTiming = Pick<Extract<Adjustment, { kind: 'blowTiming' }>, 'at' | 'blowU' | 'late' | 'hand' | 'window'>
const KEY_FPS = 30
// (hands.ts reads only a slot's handPose and handleHold adjustments, whose shape schema 3 kept)
const handLayers = (c: V2Character, s: Slot, side: Side): HandLayer[] => handLayersV3(c as unknown as Character, s as never, side)
const applyHands = async (root: THREE.Object3D, clip: THREE.AnimationClip, c: V2Character, s: Slot, clips: ClipSource, shared?: HandPose[]) =>
  await applyHandsV3(root, clip, c as unknown as Character, s as never, clips, shared)
const slotById = (c: V2Character, id: string): Slot | undefined => c.clips.find(s => s.id === id)
const slotByName = (c: V2Character, name: string): Slot | undefined => c.clips.find(s => s.name === name)

/** World positions of named bones while `clip` plays on `root`, sampled at `rate` Hz (the bones are left posed). */
function sample (root: THREE.Object3D, clip: THREE.AnimationClip, names: string[], rate = 60): { times: number[], at: Map<string, THREE.Vector3[]> } {
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
function saveBones (root: THREE.Object3D): () => void {
  const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = []
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]) })
  return () => {
    for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s) }
    root.updateMatrixWorld(true)
  }
}

/** The blow: when the hand moves fastest, away from the clip's ends (wind-up and recovery) and ignoring one-frame
 * jumps (clips that end on a copy of their first frame snap back on the last step). */
function blowTime (root: THREE.Object3D, clip: THREE.AnimationClip, hand: string): number {
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
function stride (root: THREE.Object3D, clip: THREE.AnimationClip, feet = ['LeftFoot', 'RightFoot']): number {
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
function cut (clip: THREE.AnimationClip, start: number, end: number, name = clip.name): THREE.AnimationClip {
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

/** The clip played `speed` times as fast (the same clip at 1). */
function retime (clip: THREE.AnimationClip, speed: number): THREE.AnimationClip {
  if (speed === 1) return clip
  const tracks = clip.tracks.map(t => { const c = t.clone(); c.times = c.times.map(x => x / speed); return c })
  return new THREE.AnimationClip(clip.name, clip.duration / speed, tracks)
}

/** The attack cut so its blow lands at `at` of it (or `window` seconds around the blow). Leaves the bones as they were. */
function blowCut (root: THREE.Object3D, clip: THREE.AnimationClip, s: BlowTiming): { clip: THREE.AnimationClip, blow: number, kept: [number, number] } {
  let blow: number
  if (s.blowU !== undefined) {
    // (kept a frame inside the clip: a blow on its first or last frame would cut it down to nothing)
    const edge = Math.min(1 / 30, clip.duration / 4)
    blow = Math.min(clip.duration - edge, Math.max(edge, Math.min(1, Math.max(0, s.blowU)) * clip.duration))
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
function paceTo (root: THREE.Object3D, clip: THREE.AnimationClip, like: THREE.AnimationClip): { clip: THREE.AnimationClip, factor: number } {
  const restore = saveBones(root)
  const factor = stride(root, like) / stride(root, clip)
  restore()
  const out = retime(clip, factor)
  out.name = clip.name
  return { clip: out, factor }
}

/** The tweak at phase `u`: keys tweened smoothly (a cubic through them, Catmull-Rom tangents: a motion passes through
 * a key without stopping), wrapping round on a loop; a one-shot eases out of its first key and into its last, and holds
 * them beyond. */
function sampleKeys (keys: ClipKey[], u: number, loop: boolean): { q: THREE.Quaternion, p: THREE.Vector3 } {
  if (keys.length === 0) return { q: new THREE.Quaternion(), p: new THREE.Vector3() }
  const ks = [...keys].sort((a, b) => a.u - b.u)
  const n = ks.length
  const val = (k: ClipKey): { q: number[], p: number[] } => ({ q: [...k.q], p: [...(k.p ?? [0, 0, 0])] })
  const out = (v: { q: number[], p: number[] }): { q: THREE.Quaternion, p: THREE.Vector3 } => ({ q: new THREE.Quaternion(...v.q as [number, number, number, number]).normalize(), p: new THREE.Vector3(...v.p as [number, number, number]) })
  if (n === 1) return out(val(ks[0]))
  // the segment: keys i and i+1 (indices past the ends wrap round a loop, a cycle on)
  const at = (i: number): { u: number, v: { q: number[], p: number[] } } => {
    const cycle = Math.floor(i / n)
    const k = ks[((i % n) + n) % n]
    return { u: k.u + cycle, v: val(k) }
  }
  let i: number
  let x = u
  if (u < ks[0].u || u >= ks[n - 1].u) {
    if (!loop) return out(val(u < ks[0].u ? ks[0] : ks[n - 1]))
    i = n - 1
    if (x < ks[0].u) x += 1
  } else {
    i = ks.findIndex(k => k.u > u) - 1
  }
  const k0 = at(i - 1); const k1 = at(i); const k2 = at(i + 1); const k3 = at(i + 2)
  const span = Math.max(k2.u - k1.u, 1e-9)
  const f = Math.min(1, Math.max(0, (x - k1.u) / span))
  // tangents (per unit of the segment): Catmull-Rom over uneven spacing; none at a one-shot's ends (it eases)
  const ends = !loop
  const first = ends && i === 0; const last = ends && i + 1 === n - 1
  // (quaternions on one side of the sphere, as the segment's first)
  const align = (q: number[]): number[] => (q[0] * k1.v.q[0] + q[1] * k1.v.q[1] + q[2] * k1.v.q[2] + q[3] * k1.v.q[3] < 0 ? q.map(c => -c) : q)
  const q0 = align(k0.v.q); const q1 = k1.v.q; const q2 = align(k2.v.q); const q3 = align(k3.v.q)
  const tangent = (a: number[], b: number[], ua: number, ub: number, none: boolean): number[] => none ? a.map(() => 0) : a.map((c, j) => (b[j] - c) / Math.max(ub - ua, 1e-9) * span)
  const h00 = 2 * f ** 3 - 3 * f ** 2 + 1; const h10 = f ** 3 - 2 * f ** 2 + f; const h01 = -2 * f ** 3 + 3 * f ** 2; const h11 = f ** 3 - f ** 2
  const hermite = (p0: number[], p1: number[], p2: number[], p3: number[]): number[] => {
    const m1 = tangent(p0, p2, k0.u, k2.u, first)
    const m2 = tangent(p1, p3, k1.u, k3.u, last)
    return p1.map((c, j) => h00 * c + h10 * m1[j] + h01 * p2[j] + h11 * m2[j])
  }
  return out({ q: hermite(q0, q1, q2, q3), p: hermite(k0.v.p, k1.v.p, k2.v.p, k3.v.p) })
}

/** A clip's frames as times: as many as KEY_FPS gives it, spread evenly from its start to its very end (a clip whose
 * length isn't a whole number of frames keeps its last pose, its frames a touch apart from 1/30 s). */
function frameTimes (duration: number): number[] {
  const n = Math.max(1, Math.round(duration * KEY_FPS))
  return Array.from({ length: n + 1 }, (_, i) => (i === n ? duration : i * duration / n))
}

/** The clip with its lift: the Hips raised `dy` straight up throughout (its position track, or a constant one at rest).
 * `up`: one world unit up in the hips' parent's frame (retarget.ts restUpOf): a tilted parent (a horse's root) isn't
 * raised along its own Y. */
function applyLift (clip: THREE.AnimationClip, hips: string, dy: number, restPosition: THREE.Vector3, up: THREE.Vector3 = new THREE.Vector3(0, 1, 0)): THREE.AnimationClip {
  if (dy === 0) return clip
  const name = `${hips}.position`
  const tracks = clip.tracks.filter(t => t.name !== name)
  const was = clip.tracks.find(t => t.name === name)
  if (was !== undefined) {
    const copy = was.clone()
    for (let i = 0; i < copy.values.length; i += 3) { copy.values[i] += dy * up.x; copy.values[i + 1] += dy * up.y; copy.values[i + 2] += dy * up.z }
    tracks.push(copy)
  } else {
    const v = [restPosition.x + dy * up.x, restPosition.y + dy * up.y, restPosition.z + dy * up.z]
    tracks.push(new THREE.VectorKeyframeTrack(name, [0, clip.duration], [...v, ...v]))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** The clip with its bone keys: each keyed bone's turn is the clip's then the key's, in the bone's own frame
 * (q_clip * q_key), and a key's move adds to its position (the Hips; scaled by `moveScale`: the export's game units).
 * `rest` gives a bone's rest local transform where the clip has no track for it. */
function applyBoneKeys (clip: THREE.AnimationClip, bones: Record<string, ClipKey[]> | undefined, loop: boolean,
  rest: (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null, moveScale = 1): THREE.AnimationClip {
  const keyed = Object.entries(bones ?? {}).filter(([, ks]) => ks.length > 0)
  if (keyed.length === 0) return clip
  let tracks = [...clip.tracks]
  const times = frameTimes(clip.duration)
  for (const [bone, keys] of keyed) {
    const r = rest(bone)
    if (r === null) continue
    const qTrack = tracks.find(t => t.name === `${bone}.quaternion`)
    const pTrack = tracks.find(t => t.name === `${bone}.position`)
    const qs: number[] = []; const ps: number[] = []
    const moves = keys.some(k => k.p !== undefined)
    for (const t of times) {
      const u = clip.duration > 0 ? t / clip.duration : 0
      const { q, p } = sampleKeys(keys, u, loop)
      const base = new THREE.Quaternion().fromArray(trackValue(qTrack, t, 4, r.q.toArray()))
      qs.push(...base.multiply(q).toArray())
      if (moves) {
        const bp = new THREE.Vector3().fromArray(trackValue(pTrack, t, 3, r.p.toArray()))
        ps.push(...bp.addScaledVector(p, moveScale).toArray())
      }
    }
    tracks = tracks.filter(t => t !== qTrack && (!moves || t !== pTrack))
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, qs))
    if (moves) tracks.push(new THREE.VectorKeyframeTrack(`${bone}.position`, times, ps))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** A gear piece's local transform over a clip: its placement (or rest) then its key's move and turn about its own origin,
 * `place` · [p_key·moveScale, q_key]. Tracks named `${node}.position` / `.quaternion`, baked on the frames. */
function propTracks (node: string, duration: number, keys: ClipKey[] | undefined, loop: boolean,
  place: { position: THREE.Vector3, quaternion: THREE.Quaternion }, placeScale: number, moveScale = 1): THREE.KeyframeTrack[] {
  const times = keys !== undefined && keys.length > 0 ? frameTimes(duration) : [0, duration]
  const ps: number[] = []; const qs: number[] = []
  for (const t of times) {
    const { q, p } = sampleKeys(keys ?? [], duration > 0 ? t / duration : 0, loop)
    // place · offset: the offset's move is in the gear's placed frame (turned by its placement, sized by its scale)
    const pos = p.clone().multiplyScalar(placeScale * moveScale).applyQuaternion(place.quaternion).add(place.position)
    ps.push(...pos.toArray())
    qs.push(...place.quaternion.clone().multiply(q).toArray())
  }
  return [new THREE.VectorKeyframeTrack(`${node}.position`, times, ps), new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, times, qs)]
}

function trackValue (track: THREE.KeyframeTrack | undefined, t: number, size: number, fallback: number[]): number[] {
  if (track === undefined) return fallback
  const interpolant = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
  return Array.from(interpolant.evaluate(t) as ArrayLike<number>).slice(0, size)
}

interface BakeContext {
  /** The character's rest skeleton (CharacterView.rest): bone keys and the ground lift start from it. */
  rest: RestSkeleton
  /** A posable copy of the character (with its gear nodes): clips are measured on it, gear tracks bound to it. */
  posable: THREE.Object3D
  clips: ClipSource
  fps?: number
  /** Hand poses shared by every character (settings), for {pose} refs the character doesn't have. */
  sharedPoses?: HandPose[]
}

interface BakedSlot {
  /** Everything. */
  clip: THREE.AnimationClip
  /** Retargeted with slot.inPlace: speed 1, no hands, no adjustments (the clip source's own copy: read only). */
  raw: THREE.AnimationClip
  /** Before keys. */
  unkeyed: THREE.AnimationClip
  /** How its blow timing cut it: seconds of the clip at its speed, before the cut. */
  cut?: { start: number, end: number, uncut: number, blow: number }
  /** The total ground lift applied (the ground adjustment, plus autoGround's fit). */
  lift: number
  /** The enabled keys on gear (gear id -> keys), phases of the final clip. */
  gearKeys: Record<string, ClipKey[]>
  /** Windows are phases of the final clip. */
  pulls: PullPlan[]
  hands: Record<Side, HandLayer[]>
  /** What each stage did, by adjustment id (blow, pace, ground, keys), plus `hands` and `autoGround`. */
  report: Record<string, unknown>
}

/** A pull handle held in the slot: gear's pulls.ts tickPulls draws it toward `bone` in these windows. */
interface PullPlan { gear: string, handle: string, bone: string, windows: Window[] }

/** Where a gear piece's tracks go: its node, its placement there (bone-local), its placement's scale (a key's move is
 * in its placed, scaled frame) and the units a move is in (1; the export's game scale). */
interface GearTrackTarget {
  gear: Gear
  node: string
  rest: { position: THREE.Vector3, quaternion: THREE.Quaternion }
  placeScale: number
  moveScale: number
}

type BakeSkip = Array<AdjustmentKind | 'speed' | 'hands'> | 'all'

/** A slot's clip baked as the game plays it. `skip`: adjustment kinds to leave out, plus 'speed' and 'hands' (every
 * hand layer); 'all' = the clip alone (speed 1, no hands, no adjustments). `autoGround`: a ground fit by the feet added
 * on top (library previews). `gearNodes: false`: no gear tracks (the export keys its own gear bones). */
async function bakeSlot (c: V2Character, slot: Slot, ctx: BakeContext, o: { mirror?: boolean, skip?: BakeSkip, autoGround?: boolean, gearNodes?: boolean } = {}): Promise<BakedSlot> {
  const all = o.skip === 'all'
  const skip = new Set<string>(all ? ['speed', 'hands'] : o.skip ?? [])
  // (the slot as it plays here: its enabled adjustments, less those left out)
  const on = all ? [] : slot.adjustments.filter(a => a.enabled && !skip.has(a.kind))
  const played: Slot = { ...slot, adjustments: on }
  const report: Record<string, unknown> = {}

  const raw = await ctx.clips.get(slot.clip, { inPlace: slot.inPlace, mirror: o.mirror, fps: ctx.fps })
  let clip = skip.has('speed') ? raw : retime(raw, slot.speed)

  let cut: BakedSlot['cut']
  const blow = find(on, 'blowTiming')
  if (blow !== undefined) {
    const uncut = clip.duration
    const r = blowCut(ctx.posable, clip, blow)
    clip = r.clip
    cut = { start: r.kept[0], end: r.kept[1], uncut, blow: r.blow }
    report[blow.id] = { kind: 'blow', clip: slot.name, at: blow.at, window: blow.window, blowU: blow.blowU, blow: +r.blow.toFixed(3), kept: r.kept.map(x => +x.toFixed(3)), uncut: +uncut.toFixed(4) }
  }

  const pace = find(on, 'pace')
  if (pace !== undefined) {
    const like = slotById(c, pace.like)
    if (like === undefined || like.id === slot.id) report[pace.id] = { kind: 'pace', clip: slot.name, like: pace.like, missing: true }
    else {
      const r = paceTo(ctx.posable, clip, await timed(like, ctx, o.mirror))
      clip = r.clip
      report[pace.id] = { kind: 'pace', clip: slot.name, like: like.name, retimed: +r.factor.toFixed(3) }
    }
  }

  const hands: Record<Side, HandLayer[]> = { Left: [], Right: [] }
  if (!skip.has('hands')) {
    hands.Left = handLayers(c, played, 'Left')
    hands.Right = handLayers(c, played, 'Right')
    const r = await applyHands(ctx.posable, clip, c, played, ctx.clips, ctx.sharedPoses)
    clip = r.clip
    if (Object.keys(r.report).length > 0) report.hands = r.report
  }

  // the ground: the Hips (the bone carrying the body's moves) raised straight up
  const pelvis = pelvisName(ctx.rest)
  const hips = ctx.rest.bones.get(pelvis)
  const lifted = (x: THREE.AnimationClip, dy: number): THREE.AnimationClip =>
    hips === undefined ? x : applyLift(x, hips.node.name, dy, hips.localPosition, restUpOf(ctx.rest, pelvis))
  const ground = find(on, 'ground')
  let lift = ground?.lift ?? 0
  if (ground !== undefined) report[ground.id] = { kind: 'ground', lift: ground.lift }
  const body = o.autoGround === true && hips !== undefined ? firstSkinned(ctx.posable) : null
  if (body !== null) {
    const fit = groundFit(ctx.posable, body, lifted(clip, lift), heightOf(c))
    lift += fit.lift
    report.autoGround = { lift: +fit.lift.toFixed(4), method: fit.method, flatFrames: fit.flatFrames }
  }
  if (hips === undefined) lift = 0
  clip = lifted(clip, lift)

  const unkeyed = clip
  const keys = find(on, 'keys')
  clip = applyBoneKeys(clip, keys?.bones, slot.loop, boneRest(ctx.rest))
  const gearKeys = Object.fromEntries(Object.entries(keys?.gear ?? {}).filter(([, k]) => k.length > 0))
  if (keys !== undefined) report[keys.id] = { kind: 'keys', bones: counts(keys.bones), gear: counts(keys.gear) }

  // every placed gear piece gets tracks, keyed or not, so a clip played before never leaves one moved
  if (o.gearNodes !== false) {
    const targets: GearTrackTarget[] = []
    for (const g of c.gear) {
      // (catalog gear still in the old grip frame is placed by the gear area, not by its placement here)
      if (g.attach.kind !== 'bone' || g.attach.legacyFrame !== undefined) continue
      const node = gearNode(g)
      if (ctx.posable.getObjectByName(node) === undefined) continue
      const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
      garmentMatrix(g.attach.place).decompose(position, quaternion, new THREE.Vector3())
      targets.push({ gear: g, node, rest: { position, quaternion }, placeScale: g.attach.place.scale, moveScale: 1 })
    }
    const extra = gearTracks(clip.duration, gearKeys, slot.loop, targets)
    const names = new Set(extra.map(t => t.name))
    clip = new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks.filter(t => !names.has(t.name)), ...extra])
  }

  return { clip: named(clip, slot.name), raw, unkeyed: named(unkeyed, slot.name), cut, lift, gearKeys, pulls: pullPlans(c, played), hands, report }
}

/** The pull handles a slot holds (its enabled handleHold adjustments on pull handles that exist on bone gear), with
 * their windows. */
function pullPlans (c: V2Character, slot: Slot): PullPlan[] {
  const out: PullPlan[] = []
  for (const a of slot.adjustments) {
    if (!a.enabled || a.kind !== 'handleHold' || a.windows.length === 0) continue
    const g = gearById(c, a.gear)
    // (a pull only exists on bone gear)
    if (g === undefined || g.attach.kind !== 'bone') continue
    const h = g.handles.find(x => x.id === a.handle)
    if (h?.kind !== 'pull' || h.pull === undefined) continue
    out.push({ gear: a.gear, handle: a.handle, bone: h.pull.bone, windows: a.windows.map(w => [w[0], w[1]]) })
  }
  return out
}

/** A rider's baked slot seated on his horse: his held bones in their seated pose, and the horse's slot of the same name
 * (else its Idle) baked and fitted to it as the game plays them (src/engine/mount.ts fitRide: a loop by whole cycles,
 * the horse's gait leading; an attack's horse stretched to his). His pull windows and gear keys are repeated over his
 * cycles (they stay phases of his clip); his hand layers keep the slot's (one cycle's) windows. `rest`: the rider's
 * rest skeleton. `horse` null: the horse has no such slot and no Idle. */
async function bakeRide (rider: BakedSlot, horse: { c: V2Character, ctx: BakeContext, slotName: string }, mount: Mount,
  o: { loop: boolean, attack: boolean, rest: RestSkeleton, mirror?: boolean }): Promise<{ rider: BakedSlot, horse: THREE.AnimationClip | null, cycles: number, report: Record<string, unknown> }> {
  const rest = boneRest(o.rest)
  const clip = freezeClip(rider.clip, mount, rest)
  const unkeyed = freezeClip(rider.unkeyed, mount, rest)
  const hs = slotByName(horse.c, horse.slotName) ?? slotByName(horse.c, 'Idle')
  if (hs === undefined) return { rider: { ...rider, clip, unkeyed }, horse: null, cycles: 1, report: { horse: null } }
  const hb = (await bakeSlot(horse.c, hs, horse.ctx, { mirror: o.mirror })).clip
  const fit = fitRide(clip, hb, o.loop, o.attack)
  const cycles = Array.isArray(fit.report.cycles) ? (fit.report.cycles as number[])[0] : 1
  const again = (w: Window[]): Window[] => Array.from({ length: cycles }, (_, k) => w.map(([a, b]): Window => [(a + k) / cycles, (b + k) / cycles])).flat()
  const keysAgain = (ks: ClipKey[]): ClipKey[] => Array.from({ length: cycles }, (_, k) => ks.map(x => ({ ...x, u: (x.u + k) / cycles }))).flat()
  return {
    rider: {
      ...rider,
      clip: fit.rider,
      unkeyed: fitRide(unkeyed, hb, o.loop, o.attack).rider,
      pulls: cycles === 1 ? rider.pulls : rider.pulls.map(p => ({ ...p, windows: again(p.windows) })),
      gearKeys: cycles === 1 ? rider.gearKeys : Object.fromEntries(Object.entries(rider.gearKeys).map(([id, ks]) => [id, keysAgain(ks)])),
    },
    horse: fit.horse,
    cycles,
    report: { horse: hs.name, ...fit.report },
  }
}

/** Each gear piece's place over a clip, its keys (by gear id) on top (keys.ts propTracks). */
function gearTracks (duration: number, keys: Record<string, ClipKey[]>, loop: boolean, targets: GearTrackTarget[]): THREE.KeyframeTrack[] {
  return targets.flatMap(t => propTracks(t.node, duration, keys[t.gear.id], loop, t.rest, t.placeScale, t.moveScale))
}

/** A bone's rest local transform, for keys and held bones on a bone the clip doesn't move (null: no such bone). */
function boneRest (rest: RestSkeleton): (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null {
  return bone => {
    const b = rest.bones.get(bone)
    return b === undefined ? null : { q: b.localQuaternion.clone(), p: b.localPosition.clone() }
  }
}

// ---- inside ---------------------------------------------------------------------------------------------------------

function find<K extends AdjustmentKind> (on: Adjustment[], kind: K): Extract<Adjustment, { kind: K }> | undefined {
  return on.find((a): a is Extract<Adjustment, { kind: K }> => a.kind === kind)
}

/** Another slot's clip as it plays (its speed and its blow timing), what a pace measures its stride on. */
async function timed (s: Slot, ctx: BakeContext, mirror?: boolean): Promise<THREE.AnimationClip> {
  const clip = retime(await ctx.clips.get(s.clip, { inPlace: s.inPlace, mirror, fps: ctx.fps }), s.speed)
  const blow = s.adjustments.find((a): a is Extract<Adjustment, { kind: 'blowTiming' }> => a.enabled && a.kind === 'blowTiming')
  return blow === undefined ? clip : blowCut(ctx.posable, clip, blow).clip
}

function named (clip: THREE.AnimationClip, name: string): THREE.AnimationClip {
  return clip.name === name ? clip : new THREE.AnimationClip(name, clip.duration, clip.tracks)
}

function counts (keys: Record<string, ClipKey[]> | undefined): Record<string, number> | undefined {
  const on = Object.entries(keys ?? {}).filter(([, k]) => k.length > 0)
  return on.length === 0 ? undefined : Object.fromEntries(on.map(([n, k]) => [n, k.length]))
}


export { bakeSlot as bakeSlotV2, bakeRide as bakeRideV2 }
export type { BakeContext, BakedSlot }
