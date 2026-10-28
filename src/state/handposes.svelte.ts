// The Rig step's Hand poses: the character's named finger poses (src/engine/handposes.ts), made from rest or taken from
// a clip's frame (the Animate step sends them), shaped finger by finger, previewed on either hand. Sockets close their
// hands into them (Outfit and Animate: a pose per socket).
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'
import * as THREE from 'three'
import { bendOf, bindRest, capturePose, closedness, closeFinger, FINGERS, handRest, poseFrom, poseLocals, setBend, type Finger, type HandPose, type Side } from '../engine/handposes.ts'
import { JointLimits, type Rom } from '../engine/limits.ts'
import { loadSource } from '../engine/clips.ts'
import { retargetOffsets } from '../engine/retarget.ts'
import { DEFAULT_FIST } from '../engine/scripts.ts'
import { FISTS } from './animator.svelte.ts'
import { clipUrl } from '../engine/animation.ts'
import type { CharacterView } from '../engine/CharacterView.ts'

class HandPoses {
  /** The pose open to shape (its sliders), and the hand it shows on. */
  editing = $state<string | null>(null)
  side = $state<Side>('Right')
  /** Shaping held to the ranges a person's fingers reach (measured on the library's captures: rom/human.json). */
  natural = $state(true)
  /** This character's reference grip (the default fist, as a pose), each finger's Open ↔ Fist slider closes toward. */
  ref = $state.raw<HandPose | null>(null)
  private limits: JointLimits | null = null
  private loadedFor: CharacterView | null = null

  /** The reference grip and the ranges, for the character on stage (once per model loaded: a new rig, a new one). */
  async prepare (): Promise<void> {
    const view = animator.character; const id = app.selected?.id
    if (view === null || id === undefined || this.loadedFor === view) return
    this.loadedFor = view
    this.ref = null; this.limits = null
    try {
      const rest = handRest(bindRest(view.root), 'Right')
      if (rest !== null) {
        const locals = new Map(Object.entries(await animator.fistOf('Right', DEFAULT_FIST)).map(([n, q]) => [n, new THREE.Quaternion(...q)]))
        if (this.loadedFor !== view) return
        this.ref = poseFrom(rest, 'Right', locals, 'Grip', { clip: DEFAULT_FIST, at: 0 })
      }
    } catch (error) {
      // (tried again next time it's asked for)
      if (this.loadedFor === view) this.loadedFor = null
      app.toast('error', `The reference grip didn't load: ${(error as Error).message}`)
      return
    }
    try {
      const rom = await fetch('/templates/rom/human.json').then(async r => (r.ok ? await r.json() as Rom : null))
      // (the measured skeleton's rest: any library clip's, all are on the Y Bot)
      const source = await loadSource(clipUrl(DEFAULT_FIST))
      const offsets = view.rest === null ? null : retargetOffsets(source.rest, view.rest).offsets
      if (this.loadedFor === view && rom !== null && offsets !== null) this.limits = new JointLimits(rom, offsets, name => view.rest?.bones.get(name)?.parent ?? null, 1, 5)
    } catch { /* no ranges: shaped freely */ }
  }

  /** A pose held to the natural ranges (each joint put back inside what a person's finger reaches). */
  private natural_ (pose: HandPose): HandPose {
    const view = animator.character; const limits = this.limits
    if (!this.natural || view === null || limits === null) return pose
    const rest = handRest(bindRest(view.root), pose.side)
    if (rest === null) return pose
    const locals = poseLocals(rest, pose.side, pose)
    for (const [bone, q] of locals) if (limits.has(bone)) locals.set(bone, limits.clamp(bone, q))
    const held = poseFrom(rest, pose.side, locals, pose.name, pose.from)
    // (only the joints the pose turns: the rest stay straight as unset)
    return { ...pose, joints: Object.fromEntries(Object.keys(pose.joints).map(k => [k, held.joints[k] ?? pose.joints[k]])) }
  }

  get poses (): HandPose[] { return app.selected?.handPoses ?? [] }

  private async save (poses: HandPose[]): Promise<void> {
    const c = app.selected
    if (c === null) return
    await app.update(c.id, { handPoses: poses })
  }

  /** A new pose, the fingers straight as at rest. */
  async addRest (): Promise<void> {
    const pose: HandPose = { id: Math.random().toString(36).slice(2, 10), name: `Pose ${this.poses.length + 1}`, side: this.side, joints: {} }
    await this.save([...this.poses, pose])
    this.open(pose.id)
  }

  /** A new pose: the fist a clip closes (a Mixamo grip; the default fist unless said), on the hand shown. */
  async addFist (clipId: string = DEFAULT_FIST, name?: string): Promise<void> {
    const view = animator.character
    if (view === null) return
    const rest = handRest(bindRest(view.root), this.side)
    if (rest === null) { app.toast('error', `${app.selected?.name ?? 'This character'} has no ${this.side.toLowerCase()} hand fingers`); return }
    const locals = new Map(Object.entries(await animator.fistOf(this.side, clipId)).map(([n, q]) => [n, new THREE.Quaternion(...q)]))
    const label = name ?? FISTS.find(([id]) => id === clipId)?.[1] ?? clipId.replace(/^mixamo-/, '')
    const pose = poseFrom(rest, this.side, locals, label, { clip: clipId, at: 0 })
    await this.save([...this.poses, pose])
    this.open(pose.id)
  }

  // ---- shared with every character -------------------------------------------------------------------------------

  get shared (): HandPose[] { return app.settings?.handPoses ?? [] }
  isShared (id: string): boolean { return this.shared.some(p => p.id === id) }

  /** Share a pose with every character (or stop sharing it): it shows in their pose lists. */
  async share (id: string, on: boolean): Promise<void> {
    const pose = this.poses.find(p => p.id === id) ?? this.shared.find(p => p.id === id)
    if (pose === undefined) return
    const rest = this.shared.filter(p => p.id !== id)
    await app.saveSettings({ handPoses: on ? [...rest, $state.snapshot(pose) as HandPose] : rest })
  }

  /** A shared pose put on this character (a socket picking it takes it along). */
  async useShared (id: string): Promise<void> {
    if (this.poses.some(p => p.id === id)) return
    const pose = this.shared.find(p => p.id === id)
    if (pose !== undefined) await this.save([...this.poses, $state.snapshot(pose) as HandPose])
  }

  /** `side`'s hand as the clip playing has it on the frame shown, kept as a new pose (the Animate step's Send). */
  async capture (side: Side): Promise<HandPose | null> {
    const view = animator.character
    const playing = animator.current
    if (view === null) return null
    const label = playing === null ? 'Rest' : playing.name.replace(/^Hand pose: /, '')
    const at = Math.round(animator.time * 100) / 100
    const pose = capturePose(view.root, side, `${label} ${side.toLowerCase()} ${at.toFixed(2)}s`, playing === null ? undefined : { clip: playing.name, at })
    if (pose === null) { app.toast('error', `${app.selected?.name ?? 'This character'} has no ${side.toLowerCase()} hand fingers to take`); return null }
    await this.save([...this.poses, pose])
    app.toast('ok', `${pose.name}: kept in Rig → Hand poses`)
    return pose
  }

  async rename (id: string, name: string): Promise<void> {
    await this.save(this.poses.map(p => (p.id === id ? { ...p, name } : p)))
  }

  async remove (id: string): Promise<void> {
    if (this.editing === id) this.editing = null
    await this.save(this.poses.filter(p => p.id !== id))
  }

  /** Open a pose to shape (shown on the hand picked), or close it. */
  open (id: string | null): void {
    this.editing = id
    this.preview()
  }

  setSide (side: Side): void { this.side = side; this.preview() }

  preview (): void {
    const pose = this.poses.find(p => p.id === this.editing)
    if (pose !== undefined) animator.playHandPose(this.side, pose)
  }

  /**
   * A finger joint turned by dragging the ring past it (on the hand shown): the pose takes the turn, held within what
   * a finger reaches when Natural limits is on, shown at once and saved a moment after.
   */
  turnJoint (bone: string, local: THREE.Quaternion): void {
    const view = animator.character
    const pose = this.poses.find(p => p.id === this.editing)
    if (view === null || pose === undefined) return
    const rest = handRest(bindRest(view.root), this.side)
    if (rest === null || !rest.has(bone)) return
    const locals = poseLocals(rest, this.side, pose)
    locals.set(bone, local)
    const made = poseFrom(rest, this.side, locals, pose.name, pose.from)
    const next = this.natural_({ ...pose, side: this.side, joints: made.joints })
    this.show(pose.id, next)
    // (the bones posed now, as the preview will pose them, so the drag goes on from where the finger is)
    const shown = poseLocals(rest, this.side, next)
    view.root.traverse(o => { const q = shown.get(o.name); if (q !== undefined && (o as THREE.Bone).isBone) o.quaternion.copy(q) })
    view.root.updateMatrixWorld(true)
  }

  /** A joint's curl or spread (degrees). */
  bend (id: string, joint: string, what: 'curl' | 'spread'): number {
    return bendOf(this.poses.find(p => p.id === id)?.joints[joint])[what]
  }

  private pending: ReturnType<typeof setTimeout> | null = null
  /** Set a joint's curl or spread: shown at once, saved a moment after the last change. */
  setBend (id: string, joint: string, what: 'curl' | 'spread', degrees: number): void {
    const c = app.selected
    const pose = this.poses.find(p => p.id === id)
    if (c === null || pose === undefined) return
    this.show(id, this.natural_({ ...pose, joints: { ...pose.joints, [joint]: setBend(pose.joints[joint], what, degrees) } }))
  }

  /** How closed a finger (or, 'all', the hand) is, against the reference grip (0 straight, 1 as the grip). */
  closed (id: string, finger: Finger | 'all'): number {
    const pose = this.poses.find(p => p.id === id); const ref = this.ref
    if (pose === undefined || ref === null) return 0
    const fs = finger === 'all' ? [...FINGERS] : [finger]
    return fs.reduce((sum, f) => sum + closedness(pose, ref, f), 0) / fs.length
  }

  /** Close a finger (or the whole hand) toward the reference grip: its joints together, as a hand closes. */
  setClosed (id: string, finger: Finger | 'all', t: number): void {
    const pose = this.poses.find(p => p.id === id); const ref = this.ref
    if (pose === undefined || ref === null) return
    let next = pose
    for (const f of finger === 'all' ? FINGERS : [finger]) next = closeFinger(next, ref, f, t)
    this.show(id, this.natural_(next))
  }

  /** A pose changed while shaping: shown at once, saved a moment after the last change. */
  private show (id: string, next: HandPose): void {
    const c = app.selected
    if (c === null) return
    // (shown at once: the character's record changed here, the save after)
    c.handPoses = this.poses.map(p => (p.id === id ? next : p))
    animator.playHandPose(this.side, next)
    if (this.pending !== null) clearTimeout(this.pending)
    this.pending = setTimeout(() => {
      this.pending = null
      void this.save(app.selected?.handPoses ?? [])
      // (a shared pose shaped here is shaped for everyone)
      if (this.isShared(id)) void app.saveSettings({ handPoses: this.shared.map(p => (p.id === id ? $state.snapshot(next) as HandPose : p)) })
    }, 400)
  }
}

export const handPoses = new HandPoses()
