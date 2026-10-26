// The animation editor (Animate step): a clip edited on the character as it plays. Start on any clip playing (a library
// clip plays as it is: the timeline starts empty); scrub, drag or turn a joint (src/engine/PoseEditor.ts): letting go
// keys every bone the drag moved, at that frame, as a turn from where the clip had it (src/engine/clipedit.ts). On a clip
// with motion of its own a bone's first key also pins it at the clip's ends, so a change eases in and back out. Keys
// tween smoothly; every joint stays in its range (src/engine/limits.ts); no foot goes under the floor. Delete takes the
// keys at the frame off (the selected bone's, or all). Save writes a new library clip (tagged custom, in the category
// of the clip it came from).
import * as THREE from 'three'
import type { ClipKey } from './api.ts'
import { app } from './app.svelte.ts'
import { animator, restOf, type NowPlaying } from './animator.svelte.ts'
import { loadSource } from '../engine/clips.ts'
import { applyHolds, armOf, buildEdit, handGrip, heldBy, keyFor, unretarget, type Hold } from '../engine/clipedit.ts'
import { propNode } from './tune.svelte.ts'
import { clipGlb, framesClip } from '../engine/clipexport.ts'
import { library } from './library.svelte.ts'
import { KEY_FPS } from '../engine/keys.ts'
import { JointLimits, type Rom } from '../engine/limits.ts'
import { HORSE_RIG, HUMAN_RIG, PoseEditor, type PoseRig } from '../engine/PoseEditor.ts'
import { retargetOffsets, type RestSkeleton } from '../engine/retarget.ts'

const IDENTITY: ClipKey['q'] = [0, 0, 0, 1]
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4
const isAnchor = (k: ClipKey): boolean => k.p === undefined && Math.abs(k.q[3]) > 1 - 1e-9

class ClipEdit {
  active = $state(false)
  /** The clip being edited, as it was started on. */
  base = $state<NowPlaying & { loop: boolean, inPlace: boolean } | null>(null)
  keys = $state.raw<Record<string, ClipKey[]>>({})
  /** Hands locked on props (both hands on a spear): held there on every frame. */
  holds = $state.raw<Hold[]>([])
  /** The props a hand can hold (rigid garments on stage) and the bones they ride. */
  props = $derived((app.selected?.garments ?? []).filter(g => g.mode === 'rigid' && g.hidden !== true).map(g => ({ name: g.name, bone: g.bone })))
  selected = $state<string | null>(null)
  hovered = $state<string | null>(null)
  limitsOn = $state(true)
  /** What the gizmo on the joint selected does: moves it (the limb follows) or turns its bone. */
  gizmo = $state<'move' | 'rotate'>('move')
  /** A turn about the bone's own axes or the world's. */
  space = $state<'local' | 'world'>('local')
  busy = $state<string | null>(null)
  /** The frames keyed (phases), for the timeline. */
  phases = $derived([...new Set(Object.values(this.keys).flat().filter(k => this.held || !isAnchor(k) || (k.u > 0 && k.u < 1)).map(k => Math.round(k.u * 1e4) / 1e4))].sort((a, b) => a - b))
  /** The selected bone's keyed frames. */
  selectedPhases = $derived(this.selected === null ? [] : (this.keys[this.selected] ?? []).map(k => k.u))

  private baseClip: THREE.AnimationClip | null = null
  private edited: THREE.AnimationClip | null = null
  private editor: PoseEditor | null = null
  private limits: JointLimits | null = null
  private rig: PoseRig = HUMAN_RIG
  private source: { rest: RestSkeleton, clip: THREE.AnimationClip } | null = null
  private lift = 0

  /** A new clip made from a held pose (no motion of its own: keys hold until the next, no pins at the ends). */
  held = $state(false)
  /** A held clip's length (seconds). */
  length = $state(1)

  /** A clip of `seconds` holding the pose `clip` has at `t` (every track's value there, at both ends). */
  private holdOf (clip: THREE.AnimationClip, t: number, seconds: number): THREE.AnimationClip {
    const tracks = clip.tracks.map(track => {
      const i = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
      const v = Array.from(i.evaluate(Math.min(t, clip.duration)) as ArrayLike<number>)
      const Track = track.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack
      return new Track(track.name, [0, seconds], [...v, ...v])
    })
    return new THREE.AnimationClip(`${clip.name} pose`, seconds, tracks)
  }

  /** Make a new clip from the frame playing now: that pose held for `seconds`. */
  async startFromPose (seconds: number): Promise<void> {
    const clip = animator.clip
    if (clip === null) { app.toast('error', 'Play a clip first: its frame is where the new one starts'); return }
    await this.start(this.holdOf(clip, animator.time, seconds))
    this.length = seconds
  }

  /** A held clip's length changed: its keys keep their place in it. */
  setLength (seconds: number): void {
    if (!this.held || this.baseClip === null || !(seconds > 0.05)) return
    const u = animator.time / Math.max(this.baseClip.duration, 1e-6)
    this.baseClip = this.holdOf(this.baseClip, 0, seconds)
    this.length = seconds
    this.show(u * seconds)
  }

  /** Loops or plays once (its keys tween round from the last to the first when it loops). */
  setLoop (loop: boolean): void {
    if (this.base === null) return
    this.base = { ...this.base, loop }
    animator.setLoop(loop)
    this.show(animator.time)
  }

  /** Edit the clip playing now (or `held`: a held pose to make a new clip from). */
  async start (held?: THREE.AnimationClip): Promise<void> {
    const now = animator.current; const clip = held ?? animator.clip; const view = animator.character; const stage = animator.stage
    if (now === null || clip === null || view === null || stage === null || view.rest === null || now.url === '') { app.toast('error', 'Play a clip first, then edit it'); return }
    this.busy = 'Opening the clip'
    try {
      this.stop()
      const template = app.selected?.template
      const rigName = template === undefined || template === 'human' ? 'human' : template
      this.rig = rigName === 'horse' ? HORSE_RIG : HUMAN_RIG
      const source = await loadSource(now.url)
      this.source = { rest: source.rest, clip: source.clip }
      // (the joints' ranges, mapped onto this character through the retarget's turns)
      const rom = await fetch(`/templates/rom/${rigName}.json`).then(async r => r.ok ? await r.json() as Rom : null).catch(() => null)
      const rest = view.rest
      this.limits = rom === null ? null : new JointLimits(rom, retargetOffsets(source.rest, rest).offsets, name => rest.bones.get(name)?.parent ?? null, rigName === 'human' ? 1 : 3, rigName === 'human' ? 5 : 15)
      this.held = held !== undefined
      this.base = { ...now, entry: null, loop: this.held ? false : animator.loop, inPlace: animator.inPlace }
      this.baseClip = clip
      this.edited = clip
      // (a library clip plays stood on the floor: its hips raised by this; a saved clip is the source's height again)
      this.lift = now.entry === null ? animator.lift : (app.selected?.animations[now.entry]?.lift ?? 0)
      this.keys = {}
      this.holds = []
      this.selected = null
      animator.setPlaying(false)
      this.editor = new PoseEditor(stage, view, this.rig, this.limitsOn ? this.limits : null, {
        select: b => { this.selected = b },
        hover: b => { this.hovered = b },
        begin: () => { animator.setPlaying(false); animator.holding = true },
        commit: bones => { void this.commit(bones) },
        constrain: moving => { this.holdLive(moving) },
      })
      this.editor.setMode(this.gizmo)
      this.editor.setSpace(this.space)
      this.active = true
      this.show(animator.time)
    } finally {
      this.busy = null
    }
  }

  /** Leave the editor (the clip edited plays on until another is played). */
  stop (): void {
    this.editor?.dispose()
    this.editor = null
    this.active = false
    animator.holding = false
  }

  setLimits (on: boolean): void {
    this.limitsOn = on
    if (!this.active) return
    // (the editor is made again with or without them)
    const stage = animator.stage; const view = animator.character
    if (stage === null || view === null) return
    const selected = this.selected
    this.editor?.dispose()
    this.editor = new PoseEditor(stage, view, this.rig, on ? this.limits : null, {
      select: b => { this.selected = b }, hover: b => { this.hovered = b },
      begin: () => { animator.setPlaying(false); animator.holding = true }, commit: bones => { void this.commit(bones) },
      constrain: moving => { this.holdLive(moving) },
    })
    this.editor.setMode(this.gizmo)
    this.editor.setSpace(this.space)
    this.editor.select(selected)
  }

  select (bone: string | null): void { this.editor?.select(bone) }

  setGizmo (mode: 'move' | 'rotate'): void { this.gizmo = mode; this.editor?.setMode(mode) }
  setSpace (space: 'local' | 'world'): void { this.space = space; this.editor?.setSpace(space) }

  private get loop (): boolean { return this.base?.loop ?? true }

  /** The playhead as a phase of the clip, snapped to a frame. */
  phase (): number {
    const d = this.baseClip?.duration ?? 0
    if (d <= 0) return 0
    const frames = Math.max(1, Math.round(d * KEY_FPS))
    return Math.round(Math.min(1, Math.max(0, animator.time / d)) * frames) / frames
  }

  /** Key the bones a drag moved, at the playhead. */
  private async commit (moved: string[]): Promise<void> {
    let bones = moved
    const view = animator.character; const base = this.baseClip
    if (view === null || base === null || bones.length === 0) { animator.holding = false; return }
    const u = this.phase()
    const t = u * base.duration
    const rest = restOf(view)
    // (a locked hand moved: its grip moves there, slid along the prop; a held arm is the hold's, not keyed)
    const ends = new Set(this.holds.map(h => armOf(h.hand).end))
    if (bones.some(b => ends.has(b))) {
      this.holds = this.holds.map(h => { if (!bones.includes(armOf(h.hand).end)) return h; const n = this.gripHere(h.hand, h.prop, h.bone); return n === null ? h : { ...n, fingers: h.fingers } })
    }
    const heldArms = new Set(this.holds.flatMap(h => heldBy(h)))
    bones = bones.filter(b => !heldArms.has(b))
    const next = { ...this.keys }
    for (const name of bones) {
      const bone = view.bones.get(name); const r = rest(name)
      if (bone === undefined || r === null) continue
      const key = keyFor(base, bone, u, t, r, name === this.rig.hips)
      let ks = (next[name] ?? []).filter(k => !near(k.u, u))
      // (a clip with motion of its own: a bone's first key pins it at the ends, so the change eases in and out)
      if (ks.length === 0 && !this.held) {
        if (!near(u, 0)) ks.push({ u: 0, q: [...IDENTITY] as ClipKey['q'] })
        if (!this.loop && !near(u, 1)) ks.push({ u: 1, q: [...IDENTITY] as ClipKey['q'] })
      }
      ks = [...ks, key].sort((a, b) => a.u - b.u)
      next[name] = ks
    }
    this.keys = next
    this.show(t)
  }

  /** Take the keys at the playhead off: the selected bone's, or every bone's. */
  deleteHere (): void {
    const u = this.phase()
    const next: Record<string, ClipKey[]> = {}
    for (const [bone, ks] of Object.entries(this.keys)) {
      const keep = this.selected === null || this.selected === bone ? ks.filter(k => !near(k.u, u)) : ks
      // (only its pins left: nothing changed on this bone)
      if (keep.length > 0 && (this.held || !keep.every(isAnchor))) next[bone] = keep
    }
    this.keys = next
    this.show(u * (this.baseClip?.duration ?? 0))
  }

  /** Lock `hand` on the prop `prop` where it is now (snapped onto the prop's length: a spear's shaft). */
  async lock (hand: 'Left' | 'Right', prop: string): Promise<void> {
    const p = this.props.find(x => x.name === prop)
    if (p === undefined) return
    const h = this.gripHere(hand, prop, p.bone)
    if (h === null) { app.toast('error', `No ${hand.toLowerCase()} hand to lock`); return }
    // (its fingers closed round the shaft)
    h.fingers = await animator.fistOf(hand).catch(() => ({}))
    this.holds = [...this.holds.filter(x => x.hand !== hand), h]
    this.show(animator.time)
  }

  unlock (hand: 'Left' | 'Right'): void {
    this.holds = this.holds.filter(h => h.hand !== hand)
    this.show(animator.time)
  }

  /** The hold `hand` would have on `prop` as it stands: the fist on the prop's length (its long side: a spear's
   * shaft) where it is nearest, the hand turned so the shaft runs through the fist (across the palm, thumb towards the
   * prop's far end: a spear's head), the hand's roll round it kept. */
  private gripHere (hand: 'Left' | 'Right', prop: string, bone: string): Hold | null {
    const view = animator.character
    if (view === null || view.rest === null) return null
    const end = view.bones.get(armOf(hand).end)
    const carrier = view.bones.get(bone)
    const node = view.root.getObjectByName(propNode(prop))
    if (end === undefined || carrier === undefined || node === undefined) return null
    const grip = handGrip(view.rest, hand) ?? { axis: new THREE.Vector3(1, 0, 0), fist: new THREE.Vector3() }
    // the prop's length: its longest side, through its middle (in its own frame)
    node.updateMatrixWorld(true)
    const inv = node.matrixWorld.clone().invert()
    const box = new THREE.Box3()
    node.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true) return
      const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld))
      g.computeBoundingBox(); box.union(g.boundingBox!)
    })
    if (box.isEmpty()) return null
    const size = box.getSize(new THREE.Vector3()); const mid = box.getCenter(new THREE.Vector3())
    const local = size.x >= size.y && size.x >= size.z ? new THREE.Vector3(1, 0, 0) : size.y >= size.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const half = Math.max(size.x, size.y, size.z) / 2
    const a = mid.clone().addScaledVector(local, -half).applyMatrix4(node.matrixWorld)
    const b = mid.clone().addScaledVector(local, half).applyMatrix4(node.matrixWorld)
    // (pointing to its far end from the hand carrying it: a spear's head)
    const c = carrier.getWorldPosition(new THREE.Vector3())
    const [from, to] = a.distanceTo(c) < b.distanceTo(c) ? [a, b] : [b, a]
    const dir = to.clone().sub(from).normalize()
    const turnNow = end.getWorldQuaternion(new THREE.Quaternion())
    // the hand turned so its grip line lies along the shaft (the smallest turn: its roll round the shaft kept), the fist
    // on the shaft where it is nearest now
    const turn = new THREE.Quaternion().setFromUnitVectors(grip.axis.clone().applyQuaternion(turnNow).normalize(), dir).multiply(turnNow)
    const fistNow = grip.fist.clone().applyQuaternion(turnNow).add(end.getWorldPosition(new THREE.Vector3()))
    const fist = from.clone().addScaledVector(dir, Math.max(0, Math.min(from.distanceTo(to), fistNow.clone().sub(from).dot(dir))))
    carrier.updateMatrixWorld(true)
    const cInv = carrier.matrixWorld.clone().invert()
    const cq = carrier.getWorldQuaternion(new THREE.Quaternion()).invert()
    const r5 = (v: number[]): number[] => v.map(x => Math.round(x * 1e5) / 1e5)
    return {
      hand, prop, bone,
      fist: r5(fist.applyMatrix4(cInv).toArray()) as Hold['fist'],
      shaft: r5(dir.clone().applyQuaternion(cq).toArray()) as Hold['shaft'],
      turn: r5(cq.clone().multiply(turn).toArray()) as Hold['turn'],
      fistOffset: r5(grip.fist.toArray()) as Hold['fistOffset'],
    }
  }

  /** The held hands put back on their props, on the character as it stands (while a joint is dragged). */
  private holdLive (moving: string | null): void {
    const view = animator.character
    if (view === null || this.holds.length === 0) return
    // (a locked hand being dragged goes where it's dragged: letting go locks it there)
    const holds = this.holds.filter(h => armOf(h.hand).end !== moving)
    applyHolds(view.bones, holds, this.limitsOn ? this.limits : null, [], [], true)
  }

  /** Clear every key. */
  clear (): void { this.keys = {}; this.show(animator.time) }

  /** The edited clip, built again and shown at `time`. */
  private show (time: number): void {
    const view = animator.character; const base = this.baseClip; const root = animator.posableCopy()
    if (view === null || base === null || root === null || this.base === null) return
    this.edited = buildEdit(base, this.keys, this.loop, restOf(view), root, this.rig, 0, this.limitsOn ? this.limits : null, this.holds)
    animator.showClip(this.edited, { ...this.base, name: this.held ? 'New clip (editing)' : `${this.base.name} (editing)` }, time)
  }

  /** Save the edited clip into the library as a new one: a person's (a library clip) through the library's build, a
   * creature's (its template's skeleton) as a clip file beside its bundled ones. */
  async save (name: string): Promise<void> {
    const view = animator.character; const root = animator.posableCopy(); const base = this.base; const source = this.source
    if (view === null || view.rest === null || root === null || base === null || source === null || this.edited === null) return
    this.busy = 'Saving the clip into the library'
    try {
      const frames = unretarget(this.edited, root, view.rest, source.rest, source.clip, this.lift)
      if (base.url.startsWith('/files/library/clips/')) {
        const r = await fetch('/api/library/edits', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, base: base.clipId, loop: base.loop, keys: this.keys, holds: this.holds, frames, characterId: app.selected?.id }),
        })
        const body = await r.json() as { id?: string, error?: string, job?: string }
        if (!r.ok || body.id === undefined) throw new Error(body.error ?? `HTTP ${r.status}`)
        this.busy = `Writing ${name} into the library`
        const done = await waitForJob(body.job ?? '')
        if (done !== null) throw new Error(done)
        app.toast('ok', `${name} is in the library (${body.id}): under Custom`)
      } else {
        const src = await loadSource(base.url)
        const glb = await clipGlb(src.root, source.rest, framesClip(frames, source.rest, name))
        const rig = app.selected?.template ?? 'human'
        const q = new URLSearchParams({ rig, name, base: base.clipId, loop: base.loop ? '1' : '0', inPlace: base.inPlace ? '1' : '0', duration: String(this.edited.duration) })
        const r = await fetch(`/api/library/creature-clips?${q.toString()}`, { method: 'POST', body: glb })
        const body = await r.json() as { id?: string, error?: string }
        if (!r.ok || body.id === undefined) throw new Error(body.error ?? `HTTP ${r.status}`)
        app.toast('ok', `${name} is in the ${rig}'s library (${body.id}): under Custom`)
      }
      library.reload()
    } catch (error) {
      app.toast('error', `The clip didn't save: ${(error as Error).message}`)
    } finally {
      this.busy = null
    }
  }
}

/** Wait for a job to finish: null when it did, else why it failed. */
async function waitForJob (id: string): Promise<string | null> {
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const jobs = await fetch('/api/jobs').then(async r => await r.json() as Array<{ id: string, status: string, message?: string, error?: string }>).catch(() => [])
    const job = jobs.find(j => j.id === id)
    if (job === undefined) continue
    if (job.status === 'done') return null
    if (job.status === 'failed' || job.status === 'error') return job.error ?? job.message ?? 'failed'
  }
  return 'it took too long (still running?)'
}

export const clipEdit = new ClipEdit()
