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
import { buildEdit, keyFor, unretarget } from '../engine/clipedit.ts'
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
  selected = $state<string | null>(null)
  hovered = $state<string | null>(null)
  limitsOn = $state(true)
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
      this.selected = null
      animator.setPlaying(false)
      this.editor = new PoseEditor(stage, view, this.rig, this.limitsOn ? this.limits : null, {
        select: b => { this.selected = b },
        hover: b => { this.hovered = b },
        begin: () => { animator.setPlaying(false); animator.holding = true },
        commit: bones => { void this.commit(bones) },
      })
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
    })
    this.editor.select(selected)
  }

  select (bone: string | null): void { this.editor?.select(bone) }

  private get loop (): boolean { return this.base?.loop ?? true }

  /** The playhead as a phase of the clip, snapped to a frame. */
  phase (): number {
    const d = this.baseClip?.duration ?? 0
    if (d <= 0) return 0
    const frames = Math.max(1, Math.round(d * KEY_FPS))
    return Math.round(Math.min(1, Math.max(0, animator.time / d)) * frames) / frames
  }

  /** Key the bones a drag moved, at the playhead. */
  private async commit (bones: string[]): Promise<void> {
    const view = animator.character; const base = this.baseClip
    if (view === null || base === null || bones.length === 0) { animator.holding = false; return }
    const u = this.phase()
    const t = u * base.duration
    const rest = restOf(view)
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

  /** Clear every key. */
  clear (): void { this.keys = {}; this.show(animator.time) }

  /** The edited clip, built again and shown at `time`. */
  private show (time: number): void {
    const view = animator.character; const base = this.baseClip; const root = animator.posableCopy()
    if (view === null || base === null || root === null || this.base === null) return
    this.edited = buildEdit(base, this.keys, this.loop, restOf(view), root, this.rig, 0, this.limitsOn ? this.limits : null)
    animator.showClip(this.edited, { ...this.base, name: this.held ? 'New clip (editing)' : `${this.base.name} (editing)` }, time)
  }

  /** Save the edited clip into the library as a new one. */
  async save (name: string): Promise<void> {
    const view = animator.character; const root = animator.posableCopy(); const base = this.base; const source = this.source
    if (view === null || view.rest === null || root === null || base === null || source === null || this.edited === null) return
    this.busy = 'Saving the clip into the library'
    try {
      const frames = unretarget(this.edited, root, view.rest, source.rest, source.clip, this.lift)
      const r = await fetch('/api/library/edits', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, base: base.clipId, loop: base.loop, keys: this.keys, frames, characterId: app.selected?.id }),
      })
      const body = await r.json() as { id?: string, error?: string, job?: string }
      if (!r.ok || body.id === undefined) throw new Error(body.error ?? `HTTP ${r.status}`)
      app.toast('ok', `Saving ${name} into the library (${body.id}): it shows there in a moment`)
    } catch (error) {
      app.toast('error', `The clip didn't save: ${(error as Error).message}`)
    } finally {
      this.busy = null
    }
  }
}

export const clipEdit = new ClipEdit()
