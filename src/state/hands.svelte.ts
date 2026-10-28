// The Hands panel's state (src/app/hands): the character's named hand poses (src/engine/handposes.ts), made from rest,
// from a fist clip or from the frame shown of what plays, shaped finger by finger and shown on either hand; the hands
// held in every clip (hands.hold); poses shared with every character (the settings). Every change to a character is a
// command (hands.pose.*, hands.hold): a pose being shaped shows at once and is saved a moment after its last change.
// What closes a hand when is src/engine/hands.ts's to say; this only makes and shows the poses it names.
import * as THREE from 'three'
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'
import { clipEdit } from './clipedit.svelte.ts'
import { viewer } from './viewer.svelte.ts'
import type { Character, HandPose, HandPoseRef, Side } from './api.ts'
import { newId } from '../model/ids.ts'
import { slotById } from '../model/select.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import { boneRest } from '../engine/bake.ts'
import { clipUrl, loadSource, type ClipSource } from '../engine/clips.ts'
import {
  bindRest, capturePose, closedness, closeFinger, FINGERS, handRest, poseAt, poseClip, poseFrom, poseLocals, withinReach, withJoint,
  type Finger,
} from '../engine/handposes.ts'
import { applyHands, DEFAULT_FIST, FISTS, poseOfRef } from '../engine/hands.ts'
import { JointLimits, type Rom } from '../engine/limits.ts'
import { freezeClip } from '../engine/mount.ts'
import { retargetOffsets } from '../engine/retarget.ts'
import { fistPose } from '../engine/timing.ts'
import { listText, nextName, poseUses, type HandFocus } from '../app/hands/text.ts'

export type { HandFocus }

/** How long after the last change to a pose being shaped it is saved. */
const SAVE_AFTER = 400

const round2 = (x: number): number => Math.round(x * 100) / 100
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function sameJoints (a: HandPose['joints'], b: HandPose['joints']): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => b[k] !== undefined && a[k].every((v, i) => v === b[k][i]))
}

class Hands {
  /** The character on stage (its rig): what poses are measured on and shown on. */
  view = $state.raw<CharacterView | null>(null)
  /** The pose open to shape, and whose. */
  editing = $state.raw<{ character: string, pose: string } | null>(null)
  /** The hand the pose open is shown (and shaped) on. */
  side = $state<Side>('Right')
  /** Shaping held to the ranges a person's fingers reach (measured on the library's captures: rom/human.json). */
  natural = $state(true)
  /** The default fist as a pose on this rig: what each slider's Open ↔ Fist closes toward. */
  ref = $state.raw<HandPose | null>(null)
  /** A "change it there" link's request to the Gear or Motion step; that step shows what it names, then clears it. */
  focus = $state.raw<HandFocus | null>(null)
  /** A pose being shaped, shown before it is saved. */
  private draft = $state.raw<{ character: string, pose: HandPose } | null>(null)
  private limits: JointLimits | null = null
  private preparing: CharacterView | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The label of the clip this put on stage (a hand pose, the rest pose with hands closed), to take off again. */
  private showing: string | null = null

  constructor () {
    viewer.onLoad(view => {
      // (a model without a skeleton has no fingers to pose)
      this.view = view.rest === null ? null : view
      return () => {
        this.flush()
        if (this.view === view) this.view = null
        this.preparing = null
        this.ref = null
        this.limits = null
        this.showing = null
      }
    }, 30)
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  /** The character's poses, the one being shaped as it is now. */
  poses (c: Character): HandPose[] {
    const d = this.draft
    return d === null || d.character !== c.id ? c.hands.poses : c.hands.poses.map(p => (p.id === d.pose.id ? d.pose : p))
  }

  poseOf (c: Character, id: string): HandPose | undefined {
    return this.poses(c).find(p => p.id === id)
  }

  /** The pose of `c` open to shape, as it is now. */
  opened (c: Character): HandPose | null {
    const e = this.editing
    return e === null || e.character !== c.id ? null : this.poseOf(c, e.pose) ?? null
  }

  /** Hand poses shared with every character. */
  get shared (): HandPose[] { return app.settings?.handPoses ?? [] }
  isShared (id: string): boolean { return this.shared.some(p => p.id === id) }

  /** How closed a finger (or, 'all', the hand) of `pose` is against the reference grip: 0 straight, 1 as the grip. */
  closed (pose: HandPose, finger: Finger | 'all'): number {
    const ref = this.ref
    if (ref === null) return 0
    const fs = finger === 'all' ? [...FINGERS] : [finger]
    return fs.reduce((sum, f) => sum + closedness(pose, ref, f), 0) / fs.length
  }

  // ---- changes (commands) ------------------------------------------------------------------------------------------

  /** Hold `side`'s hand in `ref` in every clip, whatever it carries (undefined: not held). */
  async hold (c: Character, side: Side, ref: HandPoseRef | undefined): Promise<void> {
    await app.do(c.id, { type: 'hands.hold', side, pose: ref ?? null })
  }

  /** A new pose, the fingers straight as at rest, opened to shape. */
  async addBlank (c: Character): Promise<void> {
    await this.add(c, { id: newId(), name: nextName(this.poses(this.now(c)), 'Pose'), side: this.side, joints: {} }, true)
  }

  /** A new pose: the fist a library clip closes at its most closed moment (the default fist unless said), on the hand
   * shown, opened to shape. */
  async addFist (c: Character, clipId: string = DEFAULT_FIST, name?: string): Promise<void> {
    const root = this.root(); const clips = this.clips()
    if (root === null || clips === null) { app.toast('error', 'The rigged character isn\'t on stage yet'); return }
    const side = this.side
    const rest = handRest(bindRest(root), side)
    if (rest === null) { this.noFingers(c, side); return }
    app.setBusy('hands', 'Measuring the fist…')
    try {
      const fist = fistPose(root, await clips.get({ id: clipId }, { inPlace: true }), side)
      const label = name ?? FISTS.find(([id]) => id === clipId)?.[1] ?? clipId.replace(/^mixamo-/, '')
      await this.add(c, poseFrom(rest, side, fist.pose, nextName(this.poses(this.now(c)), label), { clip: clipId, at: round2(fist.at) }), true)
    } catch (error) {
      app.toast('error', `The fist didn't load: ${reason(error)}`)
    } finally {
      app.setBusy('hands', null)
    }
  }

  /** `side`'s hand on the frame shown of what plays (paused there, say), kept as a new pose. Null when nothing plays,
   * the hand has no fingers or the pose was refused. */
  async capture (c: Character, side: Side): Promise<HandPose | null> {
    const playing = animator.playing
    const root = this.root()
    if (playing === null || playing.characterId !== c.id || root === null) { app.toast('error', 'Play a clip and stop on the frame to take'); return null }
    // (a slot, a library clip or a test is read off its bake: not there yet while it bakes)
    if (playing.kind !== 'clip' && playing.baked === null) { app.toast('error', 'Wait for the clip to load, then take the hand'); return null }
    const slot = playing.slotId === null ? undefined : slotById(this.now(c), playing.slotId)
    const label = (slot?.name ?? playing.label.replace(/^Hand pose: /, '')) || 'Frame'
    const at = round2(playing.time)
    const name = nextName(this.poses(this.now(c)), `${label} ${side.toLowerCase()} ${at.toFixed(2)} s`)
    // (where it came from: the slot, else the library clip's id, else what was shown)
    const from = { clip: slot?.id ?? playing.ref?.id ?? label, at }
    // (a baked clip is read at the playhead; the editor's pose, or a clip shown as it is, off the bones on stage)
    const pose = playing.baked !== null && !playing.editing ? poseAt(root, side, playing.baked.clip, playing.time, name, from)
      : this.view === null ? null : capturePose(this.view.root, side, name, from)
    if (pose === null) { this.noFingers(c, side); return null }
    if (!await this.add(c, pose, false)) return null
    app.toast('ok', `${pose.name}: kept in Hand poses`)
    return pose
  }

  async rename (c: Character, id: string, name: string): Promise<void> {
    const next = name.trim()
    const pose = this.poseOf(c, id)
    if (next === '' || pose === undefined || next === pose.name) return
    this.flush()
    const done = await app.do(c.id, { type: 'hands.pose.update', id, patch: { name: next } })
    // (a shared pose renamed here is renamed for everyone)
    if (done !== null && this.isShared(id)) await this.reshare({ ...pose, name: next })
  }

  /** Delete a pose. What closed a hand into it goes back to the default fist, so that is asked first. */
  async remove (c: Character, id: string): Promise<void> {
    const pose = this.poseOf(c, id)
    if (pose === undefined) return
    const uses = poseUses(c, id)
    if (uses.length > 0 && !await app.confirm({
      title: `Delete ${pose.name}?`,
      body: `Used by ${listText(uses)}, which will close into the default fist instead.`,
      confirm: 'Delete',
      danger: true,
    })) return
    this.flush()
    if (this.editing?.character === c.id && this.editing.pose === id) this.editing = null
    await app.do(c.id, { type: 'hands.pose.remove', id })
  }

  /** Share a pose with every character (or stop): it shows in their lists and pickers, and picking it there copies it
   * onto them. */
  async share (c: Character, id: string, on: boolean): Promise<void> {
    const pose = this.poseOf(c, id) ?? this.shared.find(p => p.id === id)
    if (pose === undefined) return
    const others = this.shared.filter(p => p.id !== id)
    await this.saveShared(on ? [...others, $state.snapshot(pose) as HandPose] : others)
  }

  /** A shared pose put on this character (a picker choosing it does this first). */
  async useShared (c: Character, id: string): Promise<void> {
    if (this.now(c).hands.poses.some(p => p.id === id)) return
    const pose = this.shared.find(p => p.id === id)
    if (pose !== undefined) await this.add(c, $state.snapshot(pose) as HandPose, false)
  }

  // ---- shaping the pose open ---------------------------------------------------------------------------------------

  /** Open a pose of `c` to shape, or close the one open (null). */
  open (c: Character, id: string | null): void {
    this.flush()
    this.editing = id === null ? null : { character: c.id, pose: id }
  }

  setSide (side: Side): void { this.side = side }

  /** Close a finger (or the whole hand) toward the reference grip, its joints together as a hand closes: shown at once,
   * saved a moment after. */
  setClosed (c: Character, id: string, finger: Finger | 'all', t: number): void {
    const pose = this.poseOf(this.now(c), id); const ref = this.ref
    if (pose === undefined || ref === null) return
    let next = pose
    for (const f of finger === 'all' ? FINGERS : [finger]) next = closeFinger(next, ref, f, t)
    this.shape(c, this.reach(next))
  }

  /** A finger joint of the hand shown turned by a ring dragged past it (src/engine/handdots.ts): the pose open takes the
   * turn, within reach when Natural limits is on; shown at once, saved a moment after. */
  turnJoint (c: Character, bone: string, local: THREE.Quaternion): void {
    const view = this.view; const e = this.editing
    const pose = e === null || e.character !== c.id ? undefined : this.poseOf(this.now(c), e.pose)
    if (view === null || pose === undefined) return
    const rest = handRest(bindRest(view.root), this.side)
    if (rest === null || !rest.has(bone)) return
    const next = this.reach(withJoint(rest, this.side, pose, bone, local))
    this.shape(c, next)
    // (the bones posed now as the preview will pose them, so the drag goes on from where the finger is)
    const shown = poseLocals(rest, this.side, next)
    view.root.traverse(o => { const q = shown.get(o.name); if (q !== undefined && (o as THREE.Bone).isBone) o.quaternion.copy(q) })
    view.root.updateMatrixWorld(true)
  }

  /** Save the pose being shaped now, rather than a moment after its last change (a drag let go, the editor closed). */
  flush (): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    const d = this.draft
    if (d === null) return
    const c = app.byId(d.character)
    const saved = c?.hands.poses.find(p => p.id === d.pose.id)
    const patch: { joints?: HandPose['joints'], side?: Side } = {}
    if (saved !== undefined && !sameJoints(saved.joints, d.pose.joints)) patch.joints = d.pose.joints
    if (saved !== undefined && saved.side !== d.pose.side) patch.side = d.pose.side
    // (do() shows the change at once, so the draft can go in the same breath)
    if (c !== null && saved !== undefined && Object.keys(patch).length > 0) {
      void app.do(c.id, { type: 'hands.pose.update', id: saved.id, patch })
      // (a shared pose shaped here is shaped in the shared list too; the characters that took a copy keep theirs)
      if (this.isShared(saved.id)) void this.reshare(d.pose)
    }
    this.draft = null
  }

  /** The reference grip and the natural ranges for the rig on stage, measured once per rig loaded. */
  async prepare (c: Character): Promise<void> {
    const view = this.view; const root = this.root(); const clips = this.clips()
    if (view === null || root === null || clips === null || this.preparing === view) return
    this.preparing = view
    this.ref = null
    this.limits = null
    try {
      const rest = handRest(bindRest(root), 'Right')
      if (rest !== null) {
        const turns = await poseOfRef(root, 'Right', 'default', c, clips)
        if (this.preparing !== view) return
        if (turns !== 'clip') this.ref = poseFrom(rest, 'Right', turns, 'Grip', { clip: DEFAULT_FIST, at: 0 })
      }
    } catch (error) {
      // (tried again next time it's asked for)
      if (this.preparing === view) this.preparing = null
      app.toast('error', `The reference grip didn't load: ${reason(error)}`)
      return
    }
    try {
      const rom = await fetch('/templates/rom/human.json').then(async r => (r.ok ? await r.json() as Rom : null))
      // (the measured skeleton's rest: any library clip's, all are on the Y Bot)
      const source = await loadSource(clipUrl(DEFAULT_FIST))
      const target = view.rest
      if (this.preparing === view && rom !== null && target !== null) {
        this.limits = new JointLimits(rom, retargetOffsets(source.rest, target).offsets, name => target.bones.get(name)?.parent ?? null, 1, 5)
      }
    } catch { /* no ranges: shaped freely */ }
  }

  // ---- on stage ----------------------------------------------------------------------------------------------------

  /** Show `pose` on `side`'s hand, the rest of the character at rest (seated when it rides), as a one-frame clip; null
   * takes it off again. Not while the clip editor is open: its clip is on stage. */
  preview (c: Character, side: Side, pose: HandPose | null): void {
    if (pose === null) { this.unshow(); return }
    const root = this.root()
    if (root === null || clipEdit.active) return
    const label = `Hand pose: ${pose.name}`
    animator.showClip(this.seated(c, poseClip(root, side, pose)), { label })
    this.showing = label
  }

  /** The character at rest with each hand closed as every clip closes it (what it carries, hands.hold): a grip seen
   * without playing anything. */
  async showRest (c: Character): Promise<void> {
    const root = this.root(); const clips = this.clips()
    if (root === null || clips === null || clipEdit.active) return
    app.setBusy('hands', 'Closing the hands…')
    try {
      const label = 'Rest, hands closed'
      const { clip } = await applyHands(root, new THREE.AnimationClip(label, 1, []), c, null, clips, $state.snapshot(this.shared) as HandPose[])
      // (the clip editor may have opened while the fists were measured)
      if (clipEdit.active) return
      animator.showClip(this.seated(c, clip), { label })
      this.showing = label
    } catch (error) {
      app.toast('error', `The hands didn't close: ${reason(error)}`)
    } finally {
      app.setBusy('hands', null)
    }
  }

  /** Go where a hand layer is changed: its step, which then shows the gear handle or the adjustment named. */
  async reveal (to: HandFocus): Promise<void> {
    if (!await app.go(to.step)) return
    this.focus = to
  }

  // ---- inside ------------------------------------------------------------------------------------------------------

  /** Add a pose (opened to shape if `open`); false when refused (the reason is toasted). */
  private async add (c: Character, pose: HandPose, open: boolean): Promise<boolean> {
    const done = app.do(c.id, { type: 'hands.pose.add', pose })
    // (do() shows the new pose at once, so it can open before the server answers)
    if (open) this.open(c, pose.id)
    if (await done !== null) return true
    if (this.editing?.pose === pose.id) this.editing = null
    return false
  }

  private shape (c: Character, next: HandPose): void {
    this.draft = { character: c.id, pose: next }
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, SAVE_AFTER)
  }

  /** `pose` within what a person's fingers reach, when Natural limits is on and the ranges have loaded. */
  private reach (pose: HandPose): HandPose {
    const view = this.view; const limits = this.limits
    if (!this.natural || view === null || limits === null) return pose
    const rest = handRest(bindRest(view.root), pose.side)
    return rest === null ? pose : withinReach(rest, pose, limits)
  }

  /** Takes off the stage what this put there, unless something else has played since. */
  private unshow (): void {
    const p = animator.playing
    if (this.showing !== null && p !== null && p.kind === 'clip' && !p.editing && p.label === this.showing && !clipEdit.active) void animator.stop()
    this.showing = null
  }

  /** A rider's clip with his held bones in their seated pose, so a pose shown on him keeps him on his horse. */
  private seated (c: Character, clip: THREE.AnimationClip): THREE.AnimationClip {
    const rest = this.view?.rest ?? null
    return c.mount === undefined || viewer.mount === null || rest === null ? clip : freezeClip(clip, c.mount, boneRest(rest))
  }

  private async saveShared (list: HandPose[]): Promise<void> {
    try {
      await app.saveSettings({ handPoses: list })
    } catch (error) {
      app.toast('error', `The shared hand poses weren't saved: ${reason(error)}`)
    }
  }

  private async reshare (pose: HandPose): Promise<void> {
    await this.saveShared(this.shared.map(p => (p.id === pose.id ? $state.snapshot(pose) as HandPose : p)))
  }

  /** A posable copy of the character on stage: fists are measured on it, the one on stage left as it is. */
  private root (): THREE.Object3D | null { return animator.posableCopy() ?? null }
  private clips (): ClipSource | null { return (animator.clipSource as ClipSource | null | undefined) ?? null }
  /** The character as it is now (a caller's copy may be from before a change). */
  private now (c: Character): Character { return app.byId(c.id) ?? c }
  private noFingers (c: Character, side: Side): void {
    app.toast('error', `${c.name}'s ${side.toLowerCase()} hand has no finger joints`)
  }
}

export const hands = new Hands()
