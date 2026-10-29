// Onion skins and the poses the pose tools read (src/model/posetools.ts), from a slot's baked clip.
//
// Ghosts: the skeleton as the clip has it a few frames before and after the playhead (or at the keys round it), drawn
// as faint bone lines with a dot at each joint over the character, earlier ones warm, later ones cool, fading with
// distance. They are worked out only when what they show changes (the clip, the moment, the counts), straight from the
// clip's tracks and the rest skeleton (no mixer, the character's own bones untouched), so a frame costs nothing and a
// playhead move a few hundred matrix products.
import * as THREE from 'three'
import type { ClipKey, Quat, Vec3 } from '../model/types.ts'
import type { Frames, KeySampler, Pose } from '../model/posetools.ts'
import { frameTimes, KEY_FPS, sampleKeys } from './keys.ts'
import type { RestSkeleton } from './retarget.ts'
import type { CharacterView } from './CharacterView.ts'
import type { Stage } from './Stage.ts'

/** keys.ts sampleKeys for the pose tools (plain numbers). */
export const keySampler: KeySampler = (keys: ClipKey[], v: number, loop: boolean) => {
  const s = sampleKeys(keys, v, loop)
  return { q: s.q.toArray() as Quat, p: s.p.toArray() as Vec3 }
}

/** Each bone's rest local turn and its parent's rest world turn (posetools Frames), by the rest skeleton's names. */
export function restFrames (rest: RestSkeleton): Frames {
  const out: Frames = {}
  for (const [name, b] of rest.bones) {
    const parent = b.parent === null
      ? new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(rest.parentWorld.get(name) ?? new THREE.Matrix4()))
      : rest.bones.get(b.parent)!.worldQuaternion.clone()
    out[name] = { rest: b.localQuaternion.toArray() as Quat, parent: parent.normalize().toArray() as Quat }
  }
  return out
}

/** Reads a clip's tracks at any time, its interpolants made once. */
export class ClipSampler {
  private readonly tracks = new Map<string, THREE.KeyframeTrack>()
  private readonly interpolants = new Map<string, THREE.Interpolant>()
  readonly clip: THREE.AnimationClip
  constructor (clip: THREE.AnimationClip) {
    this.clip = clip
    for (const t of clip.tracks) this.tracks.set(t.name, t)
  }

  has (name: string): boolean { return this.tracks.has(name) }

  /** Track `name` at `t` seconds (clamped to the clip), into `out`; false (out as it was) without such a track. */
  read (name: string, t: number, out: number[]): boolean {
    const track = this.tracks.get(name)
    if (track === undefined) return false
    let i = this.interpolants.get(name)
    if (i === undefined) {
      i = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
      this.interpolants.set(name, i)
    }
    const v = i.evaluate(Math.min(Math.max(t, 0), this.clip.duration)) as ArrayLike<number>
    for (let k = 0; k < out.length; k++) out[k] = v[k]
    return true
  }
}

/** The pose `clip` shows at `t` seconds: each bone's local turn (the rest's where the clip has no track), and the
 * places of `moves` (the Hips). `bones`: by the rest skeleton's names (all of them when not given). */
export function poseAt (clip: THREE.AnimationClip | ClipSampler, t: number, rest: RestSkeleton, o: { bones?: Iterable<string>, moves?: Iterable<string> } = {}): Pose {
  const s = clip instanceof ClipSampler ? clip : new ClipSampler(clip)
  const moves = new Set(o.moves ?? [])
  const out: Pose = {}
  for (const name of o.bones ?? rest.bones.keys()) {
    const b = rest.bones.get(name)
    if (b === undefined) continue
    const q = b.localQuaternion.toArray() as Quat
    s.read(`${b.node.name}.quaternion`, t, q)
    out[name] = { q: new THREE.Quaternion(...q).normalize().toArray() as Quat }
    if (moves.has(name)) {
      const p = b.localPosition.toArray() as Vec3
      s.read(`${b.node.name}.position`, t, p)
      out[name].p = p
    }
  }
  return out
}

/** One frame of a clip `duration` seconds long, as a phase (keys.ts frameTimes). */
export function framePhase (duration: number): number {
  return 1 / Math.max(1, frameTimes(duration).length - 1)
}

// ---- onion skins ------------------------------------------------------------------------------------------------------

export interface OnionOptions {
  /** Ghosts before and after the moment. */
  before: number
  after: number
  /** Frames between ghosts (frames mode). */
  step: number
  /** Ghosts at these moments (seconds of the clip) instead: the keys round the playhead, the nearest `before` before
   * and `after` after it. */
  keys?: readonly number[]
  /** Round the loop at the clip's ends (else ghosts past them are left out). */
  loop: boolean
}

export interface Ghost { t: number, side: -1 | 1, rank: number }

/** The moments to ghost round `at` (seconds) in a clip `duration` long, nearest first on each side. */
export function onionTimes (at: number, duration: number, o: OnionOptions): Ghost[] {
  const out: Ghost[] = []
  if (duration <= 0) return out
  const eps = 0.25 / KEY_FPS
  if (o.keys !== undefined) {
    const ks = [...new Set(o.keys)].sort((a, b) => a - b)
    const before = ks.filter(t => t < at - eps).reverse()
    const after = ks.filter(t => t > at + eps)
    if (o.loop) {
      // (round the loop: the keys a cycle away count too, nearest first)
      before.push(...ks.filter(t => t >= at - eps).reverse())
      after.push(...ks.filter(t => t <= at + eps))
    }
    before.slice(0, o.before).forEach((t, i) => out.push({ t, side: -1, rank: i + 1 }))
    after.slice(0, o.after).forEach((t, i) => out.push({ t, side: 1, rank: i + 1 }))
    return out.filter((g, i) => out.findIndex(x => Math.abs(x.t - g.t) < eps) === i)
  }
  const step = Math.max(1, Math.round(o.step)) / KEY_FPS
  for (const [side, n] of [[-1, o.before], [1, o.after]] as const) {
    for (let i = 1; i <= n; i++) {
      let t = at + side * i * step
      if (o.loop) t = ((t % duration) + duration) % duration
      else if (t < -eps || t > duration + eps) break
      out.push({ t: Math.min(Math.max(t, 0), duration), side, rank: i })
    }
  }
  return out
}

const BEFORE = new THREE.Color(0xff9466)
const AFTER = new THREE.Color(0x5cc4ff)

interface GhostDraw { lines: THREE.LineSegments, dots: THREE.Points }

/** The onion skins on a stage: `show` draws the ghosts of a clip round a moment on a character, `hide` takes them off.
 * One per stage; dispose it with the stage. */
export class OnionSkins {
  private readonly group = new THREE.Group()
  private readonly ghosts: GhostDraw[] = []
  private sampler: ClipSampler | null = null
  private shown = ''

  constructor (stage: Stage) {
    this.group.name = 'onion-skins'
    this.group.renderOrder = 9
    stage.scene.add(this.group)
  }

  /** Ghosts of `clip` (as it plays on `view`) round `at` seconds. Worked out again only when something changed. */
  show (view: CharacterView, clip: THREE.AnimationClip, at: number, o: OnionOptions): void {
    const times = onionTimes(at, clip.duration, o)
    const sig = `${view.root.uuid}|${clip.uuid}|${times.map(g => `${g.t.toFixed(5)}${g.side}${g.rank}`).join(',')}`
    this.group.visible = times.length > 0
    if (sig === this.shown) return
    this.shown = sig
    if (this.sampler?.clip !== clip) this.sampler = new ClipSampler(clip)
    const rig = rigOf(view)
    if (rig === null) { this.group.visible = false; return }
    while (this.ghosts.length < times.length) this.ghosts.push(this.make(rig))
    const most = Math.max(o.before, o.after, 1)
    this.ghosts.forEach((g, i) => {
      const ghost = times[i]
      g.lines.visible = g.dots.visible = ghost !== undefined
      if (ghost === undefined) return
      const color = ghost.side < 0 ? BEFORE : AFTER
      const fade = 0.75 - 0.5 * (ghost.rank - 1) / most
      for (const m of [g.lines.material, g.dots.material] as Array<THREE.LineBasicMaterial | THREE.PointsMaterial>) {
        m.color.copy(color); m.opacity = fade
      }
      this.draw(rig, ghost.t, g)
    })
  }

  hide (): void {
    this.group.visible = false
    this.shown = ''
  }

  dispose (): void {
    this.group.removeFromParent()
    for (const g of this.ghosts) {
      g.lines.geometry.dispose(); (g.lines.material as THREE.Material).dispose()
      g.dots.geometry.dispose(); (g.dots.material as THREE.Material).dispose()
    }
    this.ghosts.length = 0
  }

  private make (rig: Rig): GhostDraw {
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false }))
    lines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rig.pairs.length * 6), 3))
    const dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }))
    dots.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rig.bones.length * 3), 3))
    for (const o of [lines, dots]) { o.frustumCulled = false; o.renderOrder = 9; this.group.add(o) }
    return { lines, dots }
  }

  /** The ghost at `t`: each bone's world place from its parent's, the clip's turn and place (or the rest's). */
  private draw (rig: Rig, t: number, g: GhostDraw): void {
    const s = this.sampler!
    const q = [0, 0, 0, 1]; const p = [0, 0, 0]
    const quat = new THREE.Quaternion(); const pos = new THREE.Vector3(); const local = new THREE.Matrix4()
    const world = rig.world
    rig.bones.forEach((b, i) => {
      b.rest.q.toArray(q); b.rest.p.toArray(p)
      s.read(b.qName, t, q); s.read(b.pName, t, p)
      local.compose(pos.fromArray(p), quat.fromArray(q).normalize(), b.rest.s)
      world[i].multiplyMatrices(b.parent < 0 ? b.node.parent!.matrixWorld : world[b.parent], local)
    })
    const dots = g.dots.geometry.attributes.position as THREE.BufferAttribute
    const lines = g.lines.geometry.attributes.position as THREE.BufferAttribute
    rig.bones.forEach((_, i) => { pos.setFromMatrixPosition(world[i]); dots.setXYZ(i, pos.x, pos.y, pos.z) })
    rig.pairs.forEach(([a, b], i) => {
      pos.setFromMatrixPosition(world[a]); lines.setXYZ(2 * i, pos.x, pos.y, pos.z)
      pos.setFromMatrixPosition(world[b]); lines.setXYZ(2 * i + 1, pos.x, pos.y, pos.z)
    })
    dots.needsUpdate = true; lines.needsUpdate = true
  }
}

interface Rig {
  bones: Array<{ node: THREE.Bone, parent: number, qName: string, pName: string, rest: { q: THREE.Quaternion, p: THREE.Vector3, s: THREE.Vector3 } }>
  /** Bone index pairs (parent, child) drawn as lines. */
  pairs: Array<[number, number]>
  world: THREE.Matrix4[]
}

const rigs = new WeakMap<CharacterView, Rig>()

/** A view's bones parent first, with their rest transforms (from its rest skeleton: the bones may be posed now). */
function rigOf (view: CharacterView): Rig | null {
  const known = rigs.get(view)
  if (known !== undefined) return known
  if (view.rest === null) return null
  const byNode = new Map([...view.rest.bones.values()].map(b => [b.node, b]))
  const bones: Rig['bones'] = []
  const index = new Map<THREE.Object3D, number>()
  view.root.traverse(o => {
    if ((o as THREE.Bone).isBone !== true) return
    const r = byNode.get(o)
    const rest = r === undefined
      ? { q: o.quaternion.clone(), p: o.position.clone(), s: o.scale.clone() }
      : { q: r.localQuaternion.clone(), p: r.localPosition.clone(), s: r.localScale.clone() }
    index.set(o, bones.length)
    bones.push({ node: o as THREE.Bone, parent: index.get(o.parent!) ?? -1, qName: `${o.name}.quaternion`, pName: `${o.name}.position`, rest })
  })
  const pairs = bones.flatMap((b, i) => (b.parent >= 0 ? [[b.parent, i] as [number, number]] : []))
  const rig = { bones, pairs, world: bones.map(() => new THREE.Matrix4()) }
  rigs.set(view, rig)
  return rig
}
