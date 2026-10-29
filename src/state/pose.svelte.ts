// Posing in Motion (docs/motion-plan.md §9 B): the slot playing is posed in the viewport directly, with no editor to
// open and nothing to save. A dot on every joint (src/engine/PoseEditor.ts): drag a hand or a foot and its limb reaches,
// drag any other joint and its bone turns, the gizmo moves or turns the joint selected. Letting go keys every bone the
// drag moved on the frame shown (a turn on top of the clip as it plays before keys: the bake's `unkeyed`), sent as one
// `slot.keys.set` (one undo, the journal's); the slot is baked again and plays the keys as the game will. The body is
// never solved while dragging (the designer, 2026-10-28: "the solver needs to run when you ask it to"): Solve body
// (pushclear.ts, then the natural-pose solver) and Naturalize key what they move, as ordinary keys.
//
// Gear: a piece clicked is moved or turned by its gizmo. Leading (slot.ik.lead) its keys are its path in the world, the
// hands on it following; otherwise its keys move it in the hand (or, every frame, its placement in Gear). Hands go on
// handles: a free hand let go on a piece's shaft takes a grip handle made there (the character's, every clip) and is
// kept on it in this slot by the build (slot.ik.hands, src/engine/ikbuild.ts: the one bake's stage, so the viewer and
// the game export play it alike); a hand on a handle moved moves its handle. "Save as <clip>" copies the slot over one
// the game plays (slot.copy), or into a new one.
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { Command } from '../model/command-types.ts'
import { newId } from '../model/ids.ts'
import { carryHandle, handSide, slotById, slotByName } from '../model/select.ts'
import type { Character, ClipKey, Gear, Handle, HandPose, HandPoseRef, Placement, Quat, Side, Slot, SlotIk, Vec3 } from '../model/types.ts'
import { keysToPlayed, sourceAt, windowsToPlayed, type TimeMap } from '../model/timemap.ts'
import { app } from './app.svelte.ts'
import { animator, type NowPlaying } from './animator.svelte.ts'
import { boneRest, type BakedSlot } from '../engine/bake.ts'
import type { CharacterView } from '../engine/CharacterView.ts'
import {
  armOf, bonesOf, carrierGrip, fistGrip, frameAt, frameSolve, frameTimes, gearObstacles, GRIP_CLEAR, gripName, handGrip, handleMisses, handOn,
  handPoseSource, holdsAt, keyFor, legsOf, onPath, reachGoals, type GearRig, type Grip, type HandPoseSource, type PlacedHandle,
} from '../engine/clipedit.ts'
import { restFrame } from '../engine/garments.ts'
import { gearNode, principalAxis } from '../engine/geom.ts'
import { handLayers, handleRef, poseOfRef } from '../engine/hands.ts'
import { ikRig, poseRigOf, withGearNodes } from '../engine/ikbuild.ts'
import { KEY_FPS, sampleKeys } from '../engine/keys.ts'
import { garmentMatrix, placementFromMatrix } from '../engine/placement.ts'
import { JointLimits, type Rom } from '../engine/limits.ts'
import { PoseEditor, type PoseRig } from '../engine/PoseEditor.ts'
import { retargetOffsets } from '../engine/retarget.ts'
import { reach, setWorldQuaternion } from '../engine/ik.ts'
import { colliderFor, type CharacterCollider } from '../engine/bodycollide.ts'
import {
  createBodySolver, loadPoseModel, naturalizeClipAsync, NaturalRig, poseTargets, type BodySolver, type NaturalGoal, type PoseModel, type PoseModelData,
} from '../engine/posespace.ts'
import { FIT, fitProp } from '../engine/propfit.ts'
import { correctHandContactsAsync } from '../engine/handcontacts.ts'
import { pushClear } from '../engine/pushclear.ts'
import { framesOf } from '../app/motion/rules.ts'

const IDENTITY: Quat = [0, 0, 0, 1]
const SIDES = ['Left', 'Right'] as const
/** Naturalize: how hard a keyed bone is pulled to its key, and over how many frames that fades out. */
const PULL_WEIGHT = 4
const PULL_FRAMES = 3
/** Naturalize, each press: the pull toward the library's poses (whole, outside what people do together) and of each
 * pose to the middle of its neighbours. */
const NATURALIZE = { pull: 0.05, outside: 0.5, motion: 15 }
/** How near (a share of the body's height) a free hand's fist must be let go to a piece's shaft to snap onto it. */
const SNAP_REACH = 0.1
/** The gap left between two hands on one shaft, beyond their widths (a share of the body's height). */
const HAND_GAP = 0.005
/** A shaft's radius, as a share of the body's height, when the piece's own isn't measured. */
const SHAFT_RADIUS = 0.011
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4
const r5 = (v: number[]): number[] => v.map(x => Math.round(x * 1e5) / 1e5)
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const cm = (metres: number): string => `${(metres * 100).toFixed(1)} cm`

/** The rom and pose model files, fetched once a page (a failure is asked again next time). */
const fetched = new Map<string, Promise<unknown>>()
async function fetchJson<T> (url: string): Promise<T | null> {
  let p = fetched.get(url)
  if (p === undefined) {
    p = fetch(url).then(async r => (r.ok ? await r.json() as unknown : null)).catch(() => null)
    fetched.set(url, p)
  }
  const v = await p
  if (v === null) fetched.delete(url)
  return v as T | null
}

/** A bone-attached piece that can be moved and held (ready, shown, placed). */
export interface Piece { id: string, name: string, bone: string, gear: Gear, place: Placement }

/** The slot playing on stage, as it bakes now: what every pose edit reads. */
interface Here {
  c: Character
  slot: Slot
  now: NowPlaying
  baked: BakedSlot
  view: CharacterView
  map: TimeMap
  /** Frames of one cycle of the slot's clip, and that cycle's seconds. */
  frames: number
  loop: boolean
}

class Pose {
  private busyText = $state<string | null>(null)
  /** What it is doing (the viewport's busy pill too); null when idle. */
  get busy (): string | null { return this.busyText }
  set busy (text: string | null) { this.busyText = text; app.setBusy('pose', text) }

  /** The joints shown and posable (the timeline's toggle). */
  shown = $state(true)
  /** The joint selected (its gizmo), or none. */
  selected = $state<string | null>(null)
  /** The joint under the pointer. */
  hovered = $state<string | null>(null)
  /** The piece selected (by gear id), or none. */
  gear = $state<string | null>(null)
  gizmo = $state<'move' | 'rotate'>('move')
  space = $state<'local' | 'world'>('local')
  limitsOn = $state(true)
  /** What the gizmo on a piece moves: this frame only (a key) or every frame (the whole path, or its placement). */
  moves = $state<'frame' | 'every'>('frame')
  /** Dragging a piece moves it in the hand (whatever holds it stays) instead of leading. */
  inHand = $state(false)
  /** The library's pose model is there (a person): the body can be solved, gear can lead, Naturalize. */
  natural = $state(false)
  naturalizing = $state(false)
  /** A drag is on (or its keys are on their way). */
  dragging = $state(false)

  /** The character on stage and its pieces. */
  characterId = $state<string | null>(null)
  character = $derived(this.characterId === null ? null : app.byId(this.characterId))
  pieces = $derived.by((): Piece[] => (this.character?.gear ?? []).flatMap(g => {
    const a = g.attach
    if (g.status !== 'ready' || g.hidden === true || a.kind !== 'bone' || a.legacyFrame !== undefined) return []
    return [{ id: g.id, name: g.name, bone: a.bone, gear: g, place: a.place }]
  }))

  private editor: PoseEditor | null = null
  private editorKey = ''
  private limits: JointLimits | null = null
  private limitsKey = ''
  private rig: PoseRig = poseRigOf('human')
  private model: PoseModel | null = null
  private solver: BodySolver | null = null
  private collider: CharacterCollider | null = null
  private offsets: Map<string, THREE.Quaternion> | null = null
  private modelFor: CharacterView | null = null
  /** The build's rig for the slot as it bakes now (ikbuild.ts ikRig): the hands on handles, their fists; null: none. */
  private live: GearRig | null = null
  private liveFor: BakedSlot | null = null
  /** Each free hand's fingers closed round a shaft (asked when it is let go near one). */
  private fists: Partial<Record<Side, Record<string, Quat>>> = {}
  private gripCache: Partial<Record<Side, { fingers: Record<string, Quat>, radius: number, root: THREE.Object3D, grip: Grip }>> = {}
  private shafts = new Map<string, { from: THREE.Vector3, to: THREE.Vector3, radius: number }>()
  private dragFrom = new Map<string, THREE.Matrix4>()
  private dragPlaces = new Map<string, THREE.Matrix4>()
  private naturalizeCancelled = false
  private turn = 0

  // ---- on stage ------------------------------------------------------------------------------------------------

  /** Called by the Motion step whenever what plays changes: the joints on stage for the slot playing (and only then:
   * a library preview, a test, nothing playing, another step: none). */
  sync (c: Character | null, active: boolean): void {
    const now = animator.playing; const view = animator.view; const stage = animator.stage
    const on = active && this.shown && c !== null && view !== null && view.rest !== null && stage !== null && now?.kind === 'slot' && now.characterId === c.id
    if (!on || c === null) { this.drop(); return }
    if (this.characterId !== c.id) { this.drop(); this.characterId = c.id }
    this.rig = poseRigOf(c.skeleton.template)
    const slot = slotById(c, now.slotId ?? '')
    const key = `${c.id}|${view.root.uuid}|${slot?.clip.id ?? ''}|${this.limitsOn}`
    if (key !== this.editorKey || this.editor === null) {
      this.editorKey = key
      this.make(view)
      if (slot !== undefined) void this.loadLimits(c, slot, view)
    }
    void this.prepare()
  }

  /** The joints taken off the stage. */
  drop (): void {
    this.editor?.dispose()
    this.editor = null
    this.editorKey = ''
    this.turn++
    this.dragging = false
    this.live = null
    this.liveFor = null
    this.fists = {}
    this.gripCache = {}
    this.shafts.clear()
    if (this.characterId !== null) this.putGearBack()
  }

  setShown (on: boolean): void { this.shown = on; if (!on) this.drop() }
  select (bone: string | null): void { this.editor?.select(bone); if (this.editor === null) this.selected = bone }
  selectGear (id: string | null): void { this.editor?.selectGear(id); if (this.editor === null) this.gear = id }
  setGizmo (mode: 'move' | 'rotate'): void { this.gizmo = mode; this.editor?.setMode(mode) }
  setSpace (space: 'local' | 'world'): void { this.space = space; this.editor?.setSpace(space) }
  setLimits (on: boolean): void { this.limitsOn = on; this.editorKey = '' }

  private make (view: CharacterView): void {
    const stage = animator.stage
    if (stage === null) return
    const selected = this.selected; const gear = this.gear
    this.editor?.dispose()
    this.editor = new PoseEditor(stage, view, this.rig, this.limitsOn ? this.limits : null, {
      select: b => { this.selected = b },
      selectGear: g => { this.gear = g },
      hover: b => { this.hovered = b },
      begin: () => {
        animator.setPlaying(false); animator.holding = true; this.dragging = true
        this.dragPlaces = this.leadingPlaces()
        this.dragFrom = new Map([...this.pieceNodes()].map(([n, node]) => { node.updateMatrix(); return [n, node.matrix.clone()] }))
      },
      commit: bones => { void this.commit(bones) },
      // (a drag is IK alone: the body is solved only when asked, solveBody)
      constrain: moving => { this.keepLeading(); this.handsLive(moving) },
      moveGear: (g, place, done) => { if (done) void this.commitGear(g, place); else this.gearLive(g, place) },
    }, 0, () => this.pieceNodes())
    this.editor.setMode(this.gizmo)
    this.editor.setSpace(this.space)
    this.editor.setGripLock(b => this.gripHold(b))
    if (gear !== null) this.editor.selectGear(gear); else if (selected !== null && view.bones.has(selected)) this.editor.select(selected)
  }

  /** The joints' ranges for the slot's clip (mapped onto the character through its retarget), as the build has them. */
  private async loadLimits (c: Character, slot: Slot, view: CharacterView): Promise<void> {
    const rigName = c.skeleton.template === 'human' ? 'human' : c.skeleton.template
    const key = `${rigName}|${slot.clip.id}|${view.root.uuid}`
    if (key === this.limitsKey) return
    const rom = await fetchJson<Rom>(`/templates/rom/${rigName}.json`)
    const source = rom === null ? null : await animator.clipSource?.sourceRest?.(slot.clip).catch(() => null) ?? null
    const rest = view.rest
    if (rom === null || source === null || rest === null || animator.view !== view) return
    this.limits = new JointLimits(rom, retargetOffsets(source, rest).offsets, name => rest.bones.get(name)?.parent ?? null, rigName === 'human' ? 1 : 3, rigName === 'human' ? 5 : 15)
    this.offsets = retargetOffsets(source, rest).offsets
    this.limitsKey = key
    // (the editor made again with them)
    if (this.limitsOn && this.editor !== null) this.make(view)
  }

  /** The pose model and the body's solids for the character on stage (a person), loaded once a view. */
  private async loadModel (): Promise<boolean> {
    const view = animator.view
    if (view === null) return false
    if (this.modelFor === view) return this.model !== null
    const poses = this.rig.hips === 'Hips' ? await fetchJson<PoseModelData>('/templates/rom/human-pose.json') : null
    if (animator.view !== view) return false
    this.model = poses === null ? null : loadPoseModel(poses)
    this.collider = colliderFor(view.root, view.bones, view.height)
    this.solver = this.model === null ? null : createBodySolver(this.model, this.offsets, { hipsMove: true, collide: this.collider })
    this.natural = this.model !== null
    this.modelFor = view
    return this.model !== null
  }

  /** The build's rig for the slot as it bakes now, for the live IK while a joint is dragged (the same hands and fists
   * the bake builds with). */
  private async prepare (): Promise<void> {
    void this.loadModel()
    const h = this.here()
    if (h === null || h.baked === this.liveFor) return
    this.liveFor = h.baked
    this.fists = {}
    this.gripCache = {}
    const made = await this.rigOf(h, h.slot)
    if (this.liveFor === h.baked) this.live = made
  }

  /** The build's rig for `slot` (played through `h`'s map); `measure`: with the shafts and grips the solver needs. */
  private async rigOf (h: Here, slot: Slot, measure = false): Promise<GearRig | null> {
    const ctx = animator.bakeContext(); const posable = this.posable()
    if (ctx === null || posable === null || slot.ik === undefined) return null
    const played: Slot = { ...slot, ik: { ...slot.ik, hands: slot.ik.hands.map(a => (a.windows === undefined ? a : { ...a, windows: windowsToPlayed(h.map, a.windows) })) } }
    const gearKeys = Object.fromEntries(Object.entries(slot.gear ?? {}).filter(([, t]) => (t.keys?.length ?? 0) > 0).map(([g, t]) => [g, keysToPlayed(h.map, t.keys!)]))
    try {
      return (await withGearNodes(h.c, posable, async () => await ikRig(h.c, played, { ...ctx, posable }, gearKeys, { measure })))?.rig ?? null
    } catch (error) {
      console.error('pose: the build rig', error)
      return null
    }
  }

  /** The slot playing on stage as it bakes now, or null (nothing, something else, or still baking). */
  private here (): Here | null {
    const now = animator.playing; const view = animator.view
    if (now === null || now.kind !== 'slot' || now.baked === null || view === null || view.rest === null) return null
    const c = app.byId(now.characterId)
    const slot = c === null ? undefined : slotById(c, now.slotId ?? '')
    if (c === null || slot === undefined) return null
    return { c, slot, now, baked: now.baked, view, map: now.baked.time, frames: framesOf(animator.duration, now.cycles), loop: slot.loop }
  }

  /** The frame shown, as a played phase of one cycle on the nearest frame (a loop's last frame is its first). */
  private playedAt (h: Here): number {
    const v = Math.round(Math.min(1, Math.max(0, h.now.phase)) * h.frames) / h.frames
    return h.loop && near(v, 1) ? 0 : v
  }

  private posable (): THREE.Object3D | null {
    let root = animator.posableCopy()
    const view = animator.view
    if (root !== null && this.pieces.some(p => root!.getObjectByName(gearNode(p.gear)) === undefined && view?.root.getObjectByName(gearNode(p.gear)) !== undefined)) root = animator.posableCopy(true)
    return root
  }

  /** Send a pose edit (one batch, one undo), the pose dragged kept on stage until the slot is baked again with it. */
  private async send (c: Character, commands: Command[], what?: string): Promise<boolean> {
    if (commands.length === 0) { this.release(); return false }
    animator.holding = true
    const entry = await app.do(c.id, commands, what)
    this.release()
    return entry !== null
  }

  /** The clip drives the bones again (unless a bake is on its way, which lets go itself once it plays). */
  private release (): void {
    this.dragging = false
    queueMicrotask(() => { if (!animator.loading) animator.holding = false })
  }

  // ---- keys ----------------------------------------------------------------------------------------------------

  /** `names` keyed into `tracks` (by bone, source keys) as they stand on stage now, on the frame shown: the turn (and the
   * Hips' move) from where the clip has them before keys; a bone's first key also pins it at the clip's ends (played 0
   * and, playing once, 1), so a change eases in and back out. */
  private keyBones (h: Here, tracks: Record<string, ClipKey[]>, names: Iterable<string>, v: number): void {
    const rest = boneRest(h.view.rest!)
    const u = sourceAt(h.map, v)
    const t = Math.min(Math.max(animator.time, 0), h.baked.unkeyed.duration)
    for (const name of names) {
      const bone = h.view.bones.get(name); const r = rest(name)
      if (bone === undefined || r === null) continue
      const key = keyFor(h.baked.unkeyed, bone, u, t, r, name === this.rig.hips)
      const had = tracks[name] ?? h.slot.bones?.[name] ?? []
      const ks = had.filter(k => Math.abs(h.map.toPlayed(k.u) - v) > 0.5 / h.frames).map(k => ({ ...k }))
      if (ks.length === 0) {
        const start = sourceAt(h.map, 0); const end = sourceAt(h.map, 1)
        if (!near(v, 0)) ks.push({ u: start, q: [...IDENTITY] })
        if (!h.loop && !near(v, 1) && end - start > 1e-6) ks.push({ u: end, q: [...IDENTITY] })
      }
      // (a key keeps its span's easing when it is keyed again)
      const was = had.find(k => Math.abs(h.map.toPlayed(k.u) - v) <= 0.5 / h.frames)
      tracks[name] = [...ks, { ...key, ...(was?.ease !== undefined ? { ease: was.ease } : {}) }].sort((a, b) => a.u - b.u)
    }
  }

  private boneCommand (h: Here, tracks: Record<string, ClipKey[]>): Command[] {
    const names = Object.keys(tracks)
    return names.length === 0 ? [] : [{ type: 'slot.keys.set', slot: h.slot.id, tracks: names.map(bone => ({ bone, keys: tracks[bone] })) }]
  }

  /** Key the selected joint (or the given ones) as it stands on the frame shown (K). */
  async keyHere (names?: string[]): Promise<void> {
    const h = this.here()
    const which = names ?? (this.selected !== null ? [this.selected] : [])
    if (h === null || which.length === 0 || this.busy !== null) return
    const tracks: Record<string, ClipKey[]> = {}
    this.keyBones(h, tracks, which, this.playedAt(h))
    await this.send(h.c, this.boneCommand(h, tracks))
  }

  /** The hands on handles at the frame shown (slot.ik), and the hand carrying each leading piece. */
  private attachedNow (h: Here): Array<{ hand: Side, gear: string, handle: string }> {
    const v = this.playedAt(h)
    return (h.slot.ik?.hands ?? []).filter(a => holdsAt({ windows: a.windows === undefined ? undefined : windowsToPlayed(h.map, a.windows) }, v))
  }

  private leads (slot: Slot, id: string): boolean { return slot.ik?.lead?.includes(id) === true }

  /** The bones a hand on gear holds (an arm on a handle with its fingers, an arm carrying a leading piece): a drag
   * doesn't key them; letting go moves their handles instead. */
  private heldBones (h: Here): Set<string> {
    const carriers = (h.slot.ik?.lead ?? []).map(g => this.carrierOf(g)?.hand).filter((x): x is Side => x !== undefined)
    const fingers = (hand: Side): string[] => Object.keys(this.live?.fingers[hand] ?? this.fists[hand] ?? {})
    return new Set([...this.attachedNow(h).flatMap(a => [...Object.values(armOf(a.hand)), ...fingers(a.hand)]), ...carriers.flatMap(x => Object.values(armOf(x)))])
  }

  /** A drag let go: the bones it moved keyed on the frame shown (but those held on gear); a hand on a handle moves its
   * handle there; a free hand let go on a piece's shaft takes hold of it (a grip handle made there, slot.ik). One undo. */
  private async commit (moved: string[]): Promise<void> {
    const h = this.here()
    if (h === null || moved.length === 0) { this.release(); return }
    const turn = this.turn
    let snap = this.snapTarget(h, moved)
    if (snap !== null && this.fists[snap.hand] === undefined) {
      const fist = await this.fistOf(h, snap.hand, snap.gear)
      if (turn !== this.turn) return
      this.fists[snap.hand] ??= fist
      snap = this.snapTarget(h, moved)
    }
    const v = this.playedAt(h)
    const held = this.heldBones(h)
    if (snap !== null) for (const b of [...Object.values(armOf(snap.hand)), ...Object.keys(this.fists[snap.hand] ?? {})]) held.add(b)
    const tracks: Record<string, ClipKey[]> = {}
    this.keyBones(h, tracks, moved.filter(b => !held.has(b)), v)
    const commands = this.boneCommand(h, tracks)
    const attached = h.slot.ik?.hands ?? []
    // (a hand on a handle moved or turned: its handle goes exactly where the hand is now)
    for (const a of this.attachedNow(h)) {
      if (!moved.includes(armOf(a.hand).end)) continue
      const place = this.placeAt(a.hand, a.gear, false, true)
      if (place !== null) commands.push({ type: 'gear.handle.update', gear: a.gear, id: a.handle, patch: { place, exact: true } })
    }
    let hands = attached
    // (the hand carrying a leading piece moved: its carry handle takes where it holds it now; the piece stays on its path)
    for (const gid of h.slot.ik?.lead ?? []) {
      const p = this.pieceOf(gid); const side = p === undefined ? null : handSide(p.bone); const carry = p === undefined ? undefined : carryHandle(p.gear)
      if (side === null || carry === undefined || !moved.includes(`${side}Hand`) || hands.some(a => a.hand === side)) continue
      const place = this.placeAt(side, gid, false, true)
      if (place !== null) commands.push({ type: 'gear.handle.update', gear: gid, id: carry.id, patch: { place, exact: true } })
    }
    if (snap !== null) {
      const place = this.placeAt(snap.hand, snap.gear, true)
      if (place !== null) {
        const id = newId()
        const g = this.pieceOf(snap.gear)?.gear
        const clear = this.clearOfOthers(h, snap.hand, snap.gear, place)
        commands.push({ type: 'gear.handle.add', gear: snap.gear, handle: { id, name: gripName(snap.hand, (g?.handles ?? []).map(x => x.name)), kind: 'grip', hand: snap.hand, place: clear } })
        hands = [...hands.filter(a => a.hand !== snap.hand), { hand: snap.hand, gear: snap.gear, handle: id }]
        commands.push(this.ikCommand(h.slot, { hands }))
      }
    }
    await this.send(h.c, commands, snap !== null ? `${snap.hand} hand on ${this.pieceOf(snap.gear)?.name ?? 'gear'}` : undefined)
  }

  /** slot.ik with `patch` laid on (hands and lead each replaced whole). */
  private ikCommand (slot: Slot, patch: { hands?: SlotIk['hands'], lead?: string[] }): Command {
    return {
      type: 'slot.ik', slot: slot.id,
      patch: {
        ...(patch.hands !== undefined ? { hands: patch.hands.length > 0 ? patch.hands : null } : {}),
        ...(patch.lead !== undefined ? { lead: patch.lead.length > 0 ? patch.lead : null } : {}),
      },
    }
  }

  /** A hand on no handle, let go with its fist near a piece's shaft (not the piece it carries): that hand and piece. */
  private snapTarget (h: Here, moved: string[]): { hand: Side, gear: string } | null {
    let best: { hand: Side, gear: string, d: number } | null = null
    for (const hand of SIDES) {
      const bone = h.view.bones.get(`${hand}Hand`)
      if (!moved.includes(`${hand}Hand`) || bone === undefined || this.attachedNow(h).some(a => a.hand === hand)) continue
      for (const p of this.pieces) {
        if (p.bone === `${hand}Hand`) continue
        const shaft = this.shaftOf(p.id); const grip = this.gripOf(hand, p.id)
        if (shaft === null || grip === null) continue
        const fist = grip.fist.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())).add(bone.getWorldPosition(new THREE.Vector3()))
        const length = shaft.from.distanceTo(shaft.to)
        const k = Math.max(0, Math.min(length, fist.clone().sub(shaft.from).dot(shaft.dir)))
        const d = shaft.from.clone().addScaledVector(shaft.dir, k).distanceTo(fist)
        if (d < SNAP_REACH * h.view.height && (best === null || d < best.d)) best = { hand, gear: p.id, d }
      }
    }
    return best === null ? null : { hand: best.hand, gear: best.gear }
  }

  // ---- gear on stage ---------------------------------------------------------------------------------------------

  pieceOf (id: string): Piece | undefined { return this.pieces.find(p => p.id === id) }

  private nodeName (id: string): string {
    const p = this.pieceOf(id)
    return p === undefined ? `${id}_place` : gearNode(p.gear)
  }

  private pieceNodes (): Map<string, THREE.Object3D> {
    const view = animator.view
    const out = new Map<string, THREE.Object3D>()
    if (view === null) return out
    for (const p of this.pieces) { const n = view.root.getObjectByName(gearNode(p.gear)); if (n !== undefined) out.set(p.id, n) }
    return out
  }

  /** The gear back where Gear places it (the joints taken off, a drag left half way). */
  private putGearBack (): void {
    const view = animator.view
    for (const p of this.pieces) {
      const n = view?.root.getObjectByName(gearNode(p.gear))
      if (n === undefined) continue
      garmentMatrix(p.place).decompose(n.position, n.quaternion, n.scale)
      n.updateMatrixWorld(true)
    }
  }

  /** A piece's handles a hand can be on: its grips and its carry handle once placed. */
  handlesOf (id: string): PlacedHandle[] {
    return (this.pieceOf(id)?.gear.handles ?? []).flatMap(h => (h.kind === 'pull' || h.place === undefined ? [] : [{ id: h.id, name: h.name, exact: h.exact, place: h.place }]))
  }

  /** The handles `hand` can take on a piece (one the other hand is on in this slot is taken). */
  handleChoices (slot: Slot | undefined, hand: Side, id: string): Array<Handle & { taken: boolean }> {
    const p = this.pieceOf(id)
    if (p === undefined) return []
    return p.gear.handles.filter(h => h.place !== undefined && ((h.kind === 'grip' && (h.hand === undefined || h.hand === hand)) || (h.kind === 'carry' && h.hand === hand)))
      .map(h => ({ ...h, taken: (slot?.ik?.hands ?? []).some(a => a.hand !== hand && a.gear === id && a.handle === h.id) }))
  }

  /** The hand carrying a piece and its carry handle, placed (or where Gear's placement puts the hand). */
  private carrierOf (id: string): { hand: Side, handle: PlacedHandle } | null {
    const view = animator.view; const p = this.pieceOf(id)
    const side = p === undefined ? null : handSide(p.bone)
    const carry = p === undefined ? undefined : carryHandle(p.gear)
    if (view === null || p === undefined || side === null || carry === undefined) return null
    if (carry.place !== undefined) return { hand: side, handle: { id: carry.id, name: carry.name, exact: carry.exact, place: carry.place } }
    const handRest = restFrame(view, `${side}Hand`)
    return handRest === null ? null : { hand: side, handle: { id: carry.id, name: carry.name, place: carrierGrip(garmentMatrix(p.place), handRest) } }
  }

  /** A piece's length as it stands (from the end by the bone carrying it to the far end), in the world. */
  private shaftOf (id: string): { from: THREE.Vector3, to: THREE.Vector3, dir: THREE.Vector3 } | null {
    const view = animator.view; const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    if (view === null || node === undefined || p === undefined) return null
    node.updateMatrixWorld(true)
    const inv = node.matrixWorld.clone().invert()
    const pts: THREE.Vector3[] = []
    node.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true) return
      const pos = m.geometry.attributes.position as THREE.BufferAttribute
      const to = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)
      const step = Math.max(1, Math.floor(pos.count / 3000))
      for (let i = 0; i < pos.count; i += step) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(to))
    })
    if (pts.length < 2) return null
    const { center, axis, lo, hi } = principalAxis(pts)
    const a = center.clone().addScaledVector(axis, lo).applyMatrix4(node.matrixWorld)
    const b = center.clone().addScaledVector(axis, hi).applyMatrix4(node.matrixWorld)
    const c = view.bones.get(p.bone)?.getWorldPosition(new THREE.Vector3()) ?? center.clone().applyMatrix4(node.matrixWorld)
    const [from, to] = a.distanceTo(c) < b.distanceTo(c) ? [a, b] : [b, a]
    return { from, to, dir: to.clone().sub(from).normalize() }
  }

  private shaftLocal (id: string): { from: THREE.Vector3, to: THREE.Vector3, radius: number } | null {
    const had = this.shafts.get(id)
    if (had !== undefined) return had
    const view = animator.view; const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    const shaft = this.shaftOf(id)
    if (view === null || node === undefined || shaft === null) return null
    const inv = node.matrixWorld.clone().invert()
    const out = { from: shaft.from.clone().applyMatrix4(inv), to: shaft.to.clone().applyMatrix4(inv), radius: SHAFT_RADIUS * view.height }
    this.shafts.set(id, out)
    return out
  }

  /** Where `hand` holds a piece now, as a handle's place in its placed frame (`snap`: the fist put on the shaft, the hand
   * turned so it runs through it; `exact`: where the hand is). */
  private placeAt (hand: Side, id: string, snap: boolean, exact = false): NonNullable<Handle['place']> | null {
    const view = animator.view
    const end = view?.bones.get(armOf(hand).end)
    const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    if (view === null || view.rest === null || end === undefined || node === undefined) return null
    let turn = end.getWorldQuaternion(new THREE.Quaternion())
    let wrist = end.getWorldPosition(new THREE.Vector3())
    const shaft = exact ? null : this.shaftOf(id)
    const grip = exact ? null : this.gripOf(hand, id)
    if (shaft !== null && grip !== null) {
      if (snap) turn = new THREE.Quaternion().setFromUnitVectors(grip.axis.clone().applyQuaternion(turn).normalize(), shaft.dir).multiply(turn)
      const fistNow = grip.fist.clone().applyQuaternion(turn).add(wrist)
      const s = Math.max(0, Math.min(shaft.from.distanceTo(shaft.to), fistNow.clone().sub(shaft.from).dot(shaft.dir)))
      const onShaft = shaft.from.clone().addScaledVector(shaft.dir, s)
      if (snap || onShaft.distanceTo(fistNow) < 0.15 * view.height) wrist = onShaft.sub(grip.fist.clone().applyQuaternion(turn))
    }
    node.updateMatrixWorld(true)
    const inv = node.matrixWorld.clone().invert()
    const nq = new THREE.Quaternion(); node.matrixWorld.decompose(new THREE.Vector3(), nq, new THREE.Vector3())
    return { position: r5(wrist.applyMatrix4(inv).toArray()) as Vec3, rotation: r5(nq.invert().multiply(turn).toArray()) as Quat }
  }

  /** A hand's grip (the line a shaft runs along, the point it holds it at, in the hand's frame). */
  private gripOf (hand: Side, id?: string): Grip | null {
    const fingers = this.live?.fingers[hand] ?? this.fists[hand]; const root = this.posable()
    const view = animator.view
    const radius = (id === undefined ? undefined : this.shaftLocal(id)?.radius) ?? SHAFT_RADIUS * (view?.height ?? 1)
    if (fingers !== undefined && Object.keys(fingers).length > 0 && root !== null) {
      const held = this.gripCache[hand]
      if (held !== undefined && held.fingers === fingers && held.radius === radius && held.root === root) return held.grip
      const g = fistGrip(root, hand, fingers, radius)
      if (g !== null) { this.gripCache[hand] = { fingers, radius, root, grip: g }; return g }
    }
    const rest = view?.rest
    return rest === null || rest === undefined ? null : handGrip(rest, hand)
  }

  private widthOf (hand: Side): number {
    const view = animator.view
    if (view === null) return 0
    return this.collider?.handWidth(hand) ?? FIT.fist * view.height
  }

  /** `place` (for `hand` on a piece) slid along the shaft until its fist is a fist's width from every other hand on it. */
  private clearOfOthers (h: Here, hand: Side, id: string, place: NonNullable<Handle['place']>): NonNullable<Handle['place']> {
    const view = animator.view; const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    const shaft = this.shaftLocal(id); const grip = this.gripOf(hand, id)
    if (view === null || view.rest === null || node === undefined || shaft === null || grip === null) return place
    node.updateMatrixWorld(true)
    const scale = node.matrixWorld.getMaxScaleOnAxis() || 1
    const dir = shaft.to.clone().sub(shaft.from); const length = dir.length(); dir.normalize()
    const along = (x: NonNullable<Handle['place']>, g: { fist: THREE.Vector3 }): number => new THREE.Vector3(...x.position).add(g.fist.clone().applyQuaternion(new THREE.Quaternion(...x.rotation)).divideScalar(scale)).sub(shaft.from).dot(dir)
    const rest = view.rest
    const gripFor = (x: Side): { fist: THREE.Vector3 } => this.gripOf(x, id) ?? handGrip(rest, x) ?? { fist: new THREE.Vector3() }
    const others: Array<{ hand: Side, at: number }> = []
    const carrier = this.carrierOf(id)
    if (carrier !== null && carrier.hand !== hand) others.push({ hand: carrier.hand, at: along(carrier.handle.place, gripFor(carrier.hand)) })
    const handles = this.handlesOf(id)
    for (const a of h.slot.ik?.hands ?? []) {
      if (a.gear !== id || a.hand === hand || a.handle === carrier?.handle.id) continue
      const o = handles.find(x => x.id === a.handle)
      if (o !== undefined) others.push({ hand: a.hand, at: along(o.place, gripFor(a.hand)) })
    }
    const fist = (Math.max(...others.map(o => (this.widthOf(hand) + this.widthOf(o.hand)) / 2), FIT.fist * view.height) + HAND_GAP * view.height) / scale
    const was = along(place, grip)
    let at = was
    for (let round = 0; round < 3; round++) {
      for (const o of others) {
        if (Math.abs(at - o.at) >= fist) continue
        const before = o.at - fist; const after = o.at + fist
        at = (Math.abs(at - before) <= Math.abs(at - after) && before >= 0) || after > length ? before : after
      }
    }
    if (Math.abs(at - was) < 1e-6) return place
    return { ...place, position: r5(new THREE.Vector3(...place.position).addScaledVector(dir, at - was).toArray()) as Vec3 }
  }

  // ---- hands on handles (slot.ik), hand poses --------------------------------------------------------------------

  /** The hands on a piece in a slot: on a handle (slot.ik), and the hand carrying it. */
  handsOn (slot: Slot | undefined, id: string): Array<{ hand: Side, handle: string | null, carries: boolean }> {
    const bone = this.pieceOf(id)?.bone
    const out = (slot?.ik?.hands ?? []).filter(a => a.gear === id).map(a => ({ hand: a.hand, handle: a.handle as string | null, carries: bone === `${a.hand}Hand` }))
    const side = handSide(bone ?? '')
    if (side !== null && !out.some(x => x.hand === side)) out.push({ hand: side, handle: null, carries: true })
    return out.sort((x, y) => x.hand.localeCompare(y.hand))
  }

  /** Whether `slot`'s build leads with the piece. */
  leading (slot: Slot | undefined, id: string): boolean { return slot !== undefined && this.leads(slot, id) }

  carries (hand: Side, id: string): boolean { return this.pieceOf(id)?.bone === `${hand}Hand` }

  /** Put `hand` on a handle of a piece in the slot playing (slid clear of any other hand on it); a leading piece is
   * fitted to the body again with it (fitPath), in the same undo. */
  async attach (hand: Side, id: string, handle: string): Promise<void> {
    const h = this.here(); const p = this.pieceOf(id); const handlePlace = this.handlesOf(id).find(x => x.id === handle)
    if (h === null || p === undefined || handlePlace === undefined || this.busy !== null) return
    const commands: Command[] = []
    if (p.bone !== `${hand}Hand`) {
      const clear = this.clearOfOthers(h, hand, id, handlePlace.place)
      if (clear !== handlePlace.place) commands.push({ type: 'gear.handle.update', gear: id, id: handle, patch: { place: clear } })
    }
    const hands = [...(h.slot.ik?.hands ?? []).filter(a => a.hand !== hand), { hand, gear: id, handle }]
    commands.push(this.ikCommand(h.slot, { hands }))
    if (this.leads(h.slot, id) && this.natural) {
      const fit = await this.fitPath(h, { ...h.slot, ik: { ...h.slot.ik!, hands } }, id)
      if (fit !== null) commands.push(fit)
    }
    await this.send(h.c, commands, `${hand} hand on ${p.name}`)
  }

  /** Take a hand off whatever it holds in the slot playing. */
  async detach (hand: Side): Promise<void> {
    const h = this.here()
    if (h === null || !(h.slot.ik?.hands ?? []).some(a => a.hand === hand)) return
    await this.send(h.c, [this.ikCommand(h.slot, { hands: (h.slot.ik?.hands ?? []).filter(a => a.hand !== hand) })], `${hand} hand let go`)
  }

  /** Take a grip handle off the piece (the character's: every slot holding it lets go). */
  async removeHandle (id: string, handle: string): Promise<void> {
    const c = this.character
    const g = this.pieceOf(id)?.gear.handles.find(x => x.id === handle)
    if (c === null || g === undefined || g.kind !== 'grip') return
    await this.send(c, [{ type: 'gear.handle.remove', gear: id, id: handle }])
  }

  /** Hold a hand at its handle exactly (no give or slide on the shaft), or let it give. */
  async setExact (id: string, handle: string, on: boolean): Promise<void> {
    const c = this.character
    if (c !== null) await this.send(c, [{ type: 'gear.handle.update', gear: id, id: handle, patch: { exact: on ? true : null } }])
  }

  /** The handle `hand` holds piece `id` by in the slot: the one it is on, else (carrying it) its carry handle. */
  private handleOn (slot: Slot, hand: Side, id: string): string | undefined {
    const on = slot.ik?.hands.find(a => a.hand === hand && a.gear === id)
    if (on !== undefined) return on.handle
    const p = this.pieceOf(id)
    return p !== undefined && p.bone === `${hand}Hand` ? carryHandle(p.gear)?.id : undefined
  }

  private poseSource (slot: Slot, hand: Side, id: string): HandPoseSource | null {
    const c = this.character
    return c === null ? null : handPoseSource(c, slot, hand, id, this.handleOn(slot, hand, id) ?? '')
  }

  /** The pose a hand closes to on piece `id` in the slot (the one hand resolver's). */
  handPoseOf (slot: Slot, hand: Side, id: string): HandPoseRef | undefined {
    const c = this.character
    return c === null || this.pieceOf(id) === undefined ? undefined : handleRef(c, slot, hand, id, this.handleOn(slot, hand, id) ?? '')
  }

  handPoseSet (slot: Slot, hand: Side, id: string): boolean { return this.poseSource(slot, hand, id) !== null }

  handPoseHint (slot: Slot, hand: Side, id: string): string {
    const src = this.poseSource(slot, hand, id)
    if (src?.kind === 'slot') return `Its pose in ${slot.name} (the slot’s own)`
    if (src?.kind === 'hold') return 'Its pose in every clip, whatever it holds'
    const handle = src?.kind === 'handle' ? src.handle : this.pieceOf(id)?.gear.handles.find(x => x.id === this.handleOn(slot, hand, id))
    if (handle?.kind === 'carry') return 'Its pose carrying it, in every clip (the carry handle’s)'
    if (src?.kind === 'handle') return 'Its pose on this grip, in every clip (the grip handle’s)'
    return `Its pose in ${slot.name}`
  }

  /** Set a hand's pose on piece `id` where it is decided now (unset clears that setting); nothing set yet: the carry
   * handle when the hand holds it by that, else the slot's own pose for the hand over the whole clip. */
  async setHandPose (slot: Slot, hand: Side, id: string, ref: HandPoseRef | undefined): Promise<void> {
    const p = this.pieceOf(id); const c = this.character
    if (p === undefined || c === null) return
    const src = this.poseSource(slot, hand, id)
    const commands: Command[] = []
    if (src?.kind === 'slot') {
      commands.push(ref === undefined ? { type: 'slot.adjust.remove', slot: slot.id, id: src.adjustment } : { type: 'slot.adjust.update', slot: slot.id, id: src.adjustment, patch: { pose: ref } })
    } else if (src?.kind === 'handle') {
      commands.push({ type: 'gear.handle.update', gear: id, id: src.handle.id, patch: { pose: ref ?? null } })
    } else if (src?.kind === 'hold') {
      commands.push({ type: 'hands.hold', side: hand, pose: ref ?? null })
    } else if (ref !== undefined) {
      const carry = carryHandle(p.gear)
      if (carry !== undefined && carry.id === this.handleOn(slot, hand, id)) commands.push({ type: 'gear.handle.update', gear: id, id: carry.id, patch: { pose: ref } })
      else commands.push({ type: 'slot.adjust.add', slot: slot.id, adjustment: { id: newId(), kind: 'handPose', enabled: true, hand, pose: ref } })
    }
    await this.send(c, commands)
  }

  /** A pull's hand pose while it is held (every clip). */
  async setPullPose (id: string, handle: string, ref: HandPoseRef | undefined): Promise<void> {
    const c = this.character
    if (c !== null) await this.send(c, [{ type: 'gear.handle.update', gear: id, id: handle, patch: { pose: ref ?? null } }])
  }

  pullsOn (id: string): Handle[] { return (this.pieceOf(id)?.gear.handles ?? []).filter(h => h.kind === 'pull') }

  /** A hand's fingers as the resolver closes them on a piece (on the posable copy), or none. */
  private async fistOf (h: Here, hand: Side, id: string, handle?: string): Promise<Record<string, Quat>> {
    const root = this.posable(); const clips = animator.clipSource
    if (root === null || clips === null) return {}
    try {
      const shared = $state.snapshot(app.settings?.handPoses ?? []) as HandPose[]
      const turns = await poseOfRef(root, hand, handleRef(h.c, h.slot, hand, id, handle ?? this.handleOn(h.slot, hand, id) ?? ''), h.c, clips, shared)
      return turns === 'clip' ? {} : Object.fromEntries([...turns].map(([n, q]) => [n, q.toArray() as Quat]))
    } catch {
      return {}
    }
  }

  // ---- gear: leading, moving -------------------------------------------------------------------------------------

  /** Make a piece lead in the slot playing (the hands on it follow its path, the body the hands), or ride its bone
   * again. Switched on, it is fitted to the body once over the whole clip (its path moved as little as it needs, so the
   * hands hold it with room to spare). Its keys mean another thing either way: they go (Undo brings them back). */
  async setLeading (id: string, on: boolean): Promise<void> {
    const h = this.here(); const p = this.pieceOf(id)
    if (h === null || p === undefined || this.busy !== null || this.leads(h.slot, id) === on) return
    if (on && !await this.loadModel()) { app.toast('error', 'Gear leads the body only on a person (the library’s pose model)'); return }
    const lead = on ? [...(h.slot.ik?.lead ?? []), id] : (h.slot.ik?.lead ?? []).filter(x => x !== id)
    const commands: Command[] = []
    const had = h.slot.gear?.[id]?.keys ?? []
    if (had.length > 0) commands.push({ type: 'slot.keys.set', slot: h.slot.id, tracks: [{ gear: id, keys: [] }] })
    commands.push(this.ikCommand(h.slot, { hands: h.slot.ik?.hands ?? [], lead }))
    if (on) {
      const slot: Slot = { ...h.slot, gear: { ...h.slot.gear, [id]: { ...h.slot.gear?.[id], keys: [] } }, ik: { hands: h.slot.ik?.hands ?? [], ...h.slot.ik, lead } }
      const fit = await this.fitPath(h, slot, id)
      if (fit !== null) commands.push(fit)
    }
    if (had.length > 0) app.toast('info', `${p.name}'s keys were ${on ? 'moves in the hand' : 'its leading path'}: they go (Ctrl+Z brings them back)`)
    await this.send(h.c, commands, `${p.name} ${on ? 'leads' : 'rides its bone'}`)
  }

  /** The whole-clip fit of a leading piece (propfit.ts) for `slot`: its path keys, as a command (null: it failed). */
  private async fitPath (h: Here, slot: Slot, id: string): Promise<Command | null> {
    const p = this.pieceOf(id); const posable = this.posable(); const view = animator.view
    if (p === undefined || posable === null || view === null || view.rest === null || !await this.loadModel() || this.solver === null) return null
    const turn = this.turn
    this.busy = `Fitting ${p.name} to the body`
    await new Promise(resolve => setTimeout(resolve, 30))
    try {
      const rig = await this.rigOf(h, slot, true)
      if (rig === null || turn !== this.turn) return null
      const boneKeys = Object.fromEntries(Object.entries(slot.bones ?? {}).map(([b, ks]) => [b, keysToPlayed(h.map, ks)]))
      const result = await withGearNodes(h.c, posable, async () => await fitProp({
        base: h.baked.unkeyed, keys: boneKeys, loop: h.loop, rest: boneRest(view.rest!), posable, rig: this.rig, limits: this.limitsOn ? this.limits : null,
        gearRig: rig, gear: id, height: view.height, solver: this.solver!, collider: colliderFor(posable, bonesOf(posable), view.height),
      }, label => { if (turn === this.turn) this.busy = label }))
      if (turn !== this.turn) return null
      app.toast('ok', `Fitted ${p.name}: moved up to ${(result.maxMove * 100).toFixed(1)} cm on ${result.moved} frames`)
      return { type: 'slot.keys.set', slot: h.slot.id, tracks: [{ gear: id, keys: this.toSourceKeys(h, result.keys) }] }
    } catch (error) {
      app.toast('error', `The fit of ${p.name} failed: ${reason(error)}`)
      return null
    } finally {
      if (turn === this.turn) this.busy = null
    }
  }

  /** Keys at played phases as source keys (distinct moments kept: two that fall on one, the later wins). */
  private toSourceKeys (h: Here, keys: ClipKey[]): ClipKey[] {
    const out: ClipKey[] = []
    for (const k of keys) {
      const u = sourceAt(h.map, k.u)
      const at = out.findIndex(x => Math.abs(x.u - u) < 1e-6)
      if (at >= 0) out[at] = { ...k, u }
      else out.push({ ...k, u })
    }
    return out.sort((a, b) => a.u - b.u)
  }

  /** The slot's keys on a piece, at played phases. */
  private gearKeysPlayed (h: Here, id: string): ClipKey[] {
    return keysToPlayed(h.map, h.slot.gear?.[id]?.keys ?? [])
  }

  /** Where a piece rode at time `t` of the clip before keys. */
  private rodeAt (h: Here, id: string, t: number): THREE.Matrix4 | null {
    const root = this.posable()
    if (root === null) return null
    const node = root.getObjectByName(this.nodeName(id))
    if (node === undefined) return null
    const mixer = new THREE.AnimationMixer(root)
    const action = mixer.clipAction(h.baked.unkeyed)
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true
    action.play()
    mixer.setTime(Math.min(t, h.baked.unkeyed.duration))
    root.updateMatrixWorld(true)
    const m = node.matrixWorld.clone()
    mixer.stopAllAction(); mixer.uncacheRoot(root)
    return m
  }

  /** A piece let go by its gizmo at `place` (world). Leading: a key on its path at the frame shown, or (every frame)
   * its whole path moved by it. Not leading (or moving in the hand): a key of its move in the hand, or its placement. */
  private async commitGear (id: string, place: THREE.Matrix4): Promise<void> {
    const h = this.here()
    if (h === null) { this.release(); return }
    const leading = this.leads(h.slot, id)
    if (this.inHand || !leading) { await this.commitInHand(h, id, place); return }
    const v = this.playedAt(h); const t = animator.time
    const was = this.rodeAt(h, id, t)
    if (was === null) { this.release(); return }
    const keys = this.gearKeysPlayed(h, id)
    let next: ClipKey[]
    if (this.moves === 'every') {
      const now = onPath(was, { locked: true, keys }, v, h.loop)
      const a = new THREE.Vector3(); const qa = new THREE.Quaternion(); const b = new THREE.Vector3(); const qb = new THREE.Quaternion(); const sc = new THREE.Vector3()
      now.decompose(a, qa, sc); place.decompose(b, qb, sc)
      const dp = b.sub(a); const dq = qb.multiply(qa.invert()).normalize()
      const ks: ClipKey[] = keys.length > 0 ? keys : [{ u: 0, q: [...IDENTITY], p: [0, 0, 0] }]
      next = ks.map(k => ({ ...k, q: dq.clone().multiply(new THREE.Quaternion(...k.q)).normalize().toArray().map(r6) as Quat, p: r5(new THREE.Vector3(...(k.p ?? [0, 0, 0])).add(dp).toArray()) as Vec3 }))
    } else {
      const a = new THREE.Vector3(); const qa = new THREE.Quaternion(); const b = new THREE.Vector3(); const qb = new THREE.Quaternion(); const sc = new THREE.Vector3()
      was.decompose(a, qa, sc); place.decompose(b, qb, sc)
      const key: ClipKey = { u: v, q: qb.multiply(qa.invert()).normalize().toArray().map(r6) as Quat, p: r5(b.sub(a).toArray()) as Vec3 }
      next = keys.filter(k => !near(k.u, v))
      if (next.length === 0) {
        if (!near(v, 0)) next.push({ u: 0, q: [...IDENTITY], p: [0, 0, 0] })
        if (!h.loop && !near(v, 1)) next.push({ u: 1, q: [...IDENTITY], p: [0, 0, 0] })
      }
      next = [...next, key].sort((x, y) => x.u - y.u)
    }
    await this.send(h.c, [{ type: 'slot.keys.set', slot: h.slot.id, tracks: [{ gear: id, keys: this.toSourceKeys(h, next) }] }])
  }

  /** A piece moved in the hand (let go at `place`): this frame, a key of its move in its placed frame (on top of what the
   * slot's keys move it there); every frame, how it sits on its bone in every clip (Gear's placement). */
  private async commitInHand (h: Here, id: string, place: THREE.Matrix4): Promise<void> {
    const view = animator.view; const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    const from = this.dragFrom.get(id)
    if (view === null || p === undefined || node === undefined || node.parent === null || from === undefined) { this.release(); return }
    if (this.leads(h.slot, id)) { app.toast('info', `${p.name} leads in this clip: turn off “Leads the body” to move it in the hand`); this.release(); return }
    node.parent.updateMatrixWorld(true)
    const target = node.parent.matrixWorld.clone().invert().multiply(place)
    const delta = from.clone().invert().multiply(target)
    const dp = new THREE.Vector3(); const dq = new THREE.Quaternion(); delta.decompose(dp, dq, new THREE.Vector3())
    if (this.moves === 'every') {
      const change = from.clone().multiply(new THREE.Matrix4().compose(dp, dq, new THREE.Vector3(1, 1, 1))).multiply(from.clone().invert())
      const next = placementFromMatrix(change.clone().multiply(garmentMatrix(p.place)))
      const commands: Command[] = [{ type: 'gear.place', id, place: { ...next, scale: p.place.scale } }]
      const carry = carryHandle(p.gear)
      if (carry?.place !== undefined) commands.push({ type: 'gear.handle.update', gear: id, id: carry.id, patch: { place: null, exact: null } })
      if (await this.send(h.c, commands)) app.toast('ok', `${p.name} now sits this way on ${p.bone} in every clip`)
      return
    }
    const v = this.playedAt(h)
    const keys = this.gearKeysPlayed(h, id)
    const now = keys.length > 0 ? sampleKeys(keys, v, h.loop) : { q: new THREE.Quaternion(), p: new THREE.Vector3() }
    const total = new THREE.Matrix4().compose(now.p, now.q, new THREE.Vector3(1, 1, 1)).multiply(new THREE.Matrix4().compose(dp, dq, new THREE.Vector3(1, 1, 1)))
    const kp = new THREE.Vector3(); const kq = new THREE.Quaternion(); total.decompose(kp, kq, new THREE.Vector3())
    const key: ClipKey = { u: v, q: kq.toArray().map(r6) as Quat, p: kp.toArray().map(r6) as Vec3 }
    let ks = keys.filter(k => !near(k.u, v))
    if (ks.length === 0) {
      if (!near(v, 0)) ks.push({ u: 0, q: [...IDENTITY], p: [0, 0, 0] })
      if (!h.loop && !near(v, 1)) ks.push({ u: 1, q: [...IDENTITY], p: [0, 0, 0] })
    }
    ks = [...ks, key].sort((a, b) => a.u - b.u)
    await this.send(h.c, [{ type: 'slot.keys.set', slot: h.slot.id, tracks: [{ gear: id, keys: this.toSourceKeys(h, ks) }] }])
  }

  /** While a piece is dragged: the hands on it follow by IK (the hand carrying it first); the body stays. */
  private gearLive (id: string, place: THREE.Matrix4): void {
    const view = animator.view; const p = this.pieceOf(id); const h = this.here()
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    if (view === null || p === undefined || node === undefined || h === null) return
    const side = handSide(p.bone)
    if (this.inHand || !this.leads(h.slot, id)) {
      if (node.parent === null) return
      node.parent.updateMatrixWorld(true)
      node.parent.matrixWorld.clone().invert().multiply(place).decompose(node.position, node.quaternion, node.scale)
      node.updateMatrixWorld(true)
      this.handsLive(null)
      return
    }
    const limits = this.limitsOn ? this.limits ?? undefined : undefined
    if (side !== null) {
      const hand = view.bones.get(`${side}Hand`); const upper = view.bones.get(`${side}Arm`); const lower = view.bones.get(`${side}ForeArm`)
      if (hand !== undefined && upper !== undefined && lower !== undefined) {
        node.updateMatrixWorld(true)
        const rel = hand.matrixWorld.clone().invert().multiply(node.matrixWorld)
        const want = place.clone().multiply(rel.invert())
        const at = new THREE.Vector3(); const q = new THREE.Quaternion(); want.decompose(at, q, new THREE.Vector3())
        reach({ upper, lower, end: hand }, at, { limits, nameOf: b => b.name, keepEnd: false })
        setWorldQuaternion(hand, q)
      }
    }
    this.handsLive(side === null ? null : `${side}Hand`)
  }

  private leadingPlaces (): Map<string, THREE.Matrix4> {
    const view = animator.view; const h = this.here()
    const out = new Map<string, THREE.Matrix4>()
    for (const id of h?.slot.ik?.lead ?? []) {
      const node = view?.root.getObjectByName(this.nodeName(id))
      if (node !== undefined) { node.updateMatrixWorld(true); out.set(id, node.matrixWorld.clone()) }
    }
    return out
  }

  private keepLeading (): void {
    const view = animator.view
    for (const [id, place] of this.dragPlaces) {
      const node = view?.root.getObjectByName(this.nodeName(id))
      if (node === undefined || node.parent === null) continue
      node.parent.updateMatrixWorld(true)
      node.parent.matrixWorld.clone().invert().multiply(place).decompose(node.position, node.quaternion, new THREE.Vector3())
      node.updateMatrixWorld(true)
    }
  }

  /** The hands on handles put back on their pieces by IK as the body stands (a drag), but the one being moved. */
  private handsLive (moving: string | null): void {
    const view = animator.view; const h = this.here()
    if (view === null || h === null) return
    const opts = { limits: this.limitsOn ? this.limits : null, nameOf: (b: THREE.Bone): string => b.name }
    for (const a of this.attachedNow(h)) {
      if (armOf(a.hand).end === moving) continue
      const node = view.root.getObjectByName(this.nodeName(a.gear))
      const handle = this.live?.handles[a.gear]?.find(x => x.id === a.handle) ?? this.handlesOf(a.gear).find(x => x.id === a.handle)
      if (node === undefined || handle === undefined) continue
      node.updateMatrixWorld(true)
      reachGoals(view.bones, [{ hand: a.hand, ...handOn(node.matrixWorld, handle), fingers: this.live?.fingers[a.hand] }], opts)
    }
  }

  /** A hand on a handle (or carrying a leading piece): where it holds the piece and the piece's axis there; its gizmo
   * slides it along the piece and rolls it round it. */
  private gripHold (bone: string): { at: THREE.Vector3, axis: THREE.Vector3, turn: THREE.Quaternion } | null {
    const hand = /^(Left|Right)Hand$/.exec(bone)?.[1] as Side | undefined
    const h = this.here()
    if (hand === undefined || h === null) return null
    const a = this.attachedNow(h).find(x => x.hand === hand)
    const id = a?.gear ?? this.pieces.find(x => x.bone === bone && this.leads(h.slot, x.id))?.id
    const view = animator.view; const b = view?.bones.get(bone)
    if (id === undefined || b === undefined) return null
    const node = view?.root.getObjectByName(this.nodeName(id))
    const local = this.shaftLocal(id)
    const grip = this.gripOf(hand, id)
    if (node === undefined || local === null || grip === null) return null
    node.updateMatrixWorld(true)
    const axis = local.to.clone().applyMatrix4(node.matrixWorld).sub(local.from.clone().applyMatrix4(node.matrixWorld)).normalize()
    const at = grip.fist.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion())).add(b.getWorldPosition(new THREE.Vector3()))
    const up = new THREE.Vector3(0, 1, 0)
    const across = up.clone().addScaledVector(axis, -up.dot(axis))
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0).addScaledVector(axis, -axis.x)
    across.normalize()
    const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(axis, across, new THREE.Vector3().crossVectors(axis, across)))
    return { at, axis, turn }
  }

  // ---- the body solved, when asked -------------------------------------------------------------------------------

  /**
   * Solve the body on the frame shown, when asked (never while a drag lasts: the designer, 2026-10-28, "the solver needs
   * to run when you ask it to"). Each arm inside another body part is pushed straight out of it, a little at a time
   * (src/engine/pushclear.ts); then, where hands hold gear, the body is solved to them (the natural-pose solver, the
   * goals the frame's hands and gear give: clipedit.ts frameSolve), unless that leaves a part deeper in another; what is
   * still in is pushed out again. Every bone it moved is keyed on this frame (one undo).
   */
  async solveBody (): Promise<void> {
    const h = this.here()
    if (h === null || this.busy !== null) return
    const turn = this.turn
    this.busy = 'Solving the body'
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      await this.loadModel()
      const collider = this.collider; const view = h.view
      if (turn !== this.turn || collider === null || view.rest === null) return
      if (collider.body === null) { app.toast('error', `The body can't be solved: ${collider.problem ?? 'its mesh has no body to fit'}`); return }
      const v = this.playedAt(h)
      animator.setPlaying(false)
      animator.seek(animator.time)
      animator.holding = true
      const all = [...view.bones.keys()]
      const before = this.poseOf(all)
      const nameOf = (b: THREE.Bone): string => b.name
      const limits = this.limitsOn ? this.limits : null
      const heldBones = this.heldBones(h)
      const held = new Set(SIDES.filter(x => heldBones.has(`${x}Hand`)))
      const push = (): number => pushClear(view.bones, collider, { height: view.height, limits, nameOf, held }).worst
      const deep = (): number => collider.selfPenetration().worst
      const was = deep()
      let left = push()
      const rig = this.solver !== null && h.slot.ik !== undefined ? await this.rigOf(h, h.slot, true) : null
      if (turn !== this.turn) return
      if (this.solver !== null && rig !== null && rig.attachments.length > 0) {
        const pushed = this.poseOf(all)
        const rest = view.rest
        const legs = legsOf(view.bones, this.rig)
        const soles = legs.map(l => [l.end, l.ball, l.tip].map(b => (b === null ? -Infinity : rest.bones.get(b.name)?.worldPosition.y ?? -Infinity)))
        const frames = frameTimes(h.baked.clip.duration).length
        this.dragPlaces = this.leadingPlaces()
        const { goals, opts } = frameSolve(view.root, view.bones, rig, { u: v, i: frameAt(v, frames), loop: h.loop, places: this.dragPlaces, letGo: true },
          { hips: this.rig.hips, legs, soles, floor: 0, height: view.height, limits })
        if (goals.length > 0) {
          this.solver(view.bones, goals, opts, null)
          this.keepLeading()
          if (deep() > left + 1e-3) { this.putPose(pushed, all); this.keepLeading(); this.handsLive(null) }
          left = push()
        }
      }
      // (a held hand's fingers are its handle's fist in every build: not keyed)
      const changed = all.filter(n => !(heldBones.has(n) && !/^(Left|Right)(Arm|ForeArm|Hand)$/.test(n))).filter(n => {
        const b = view.bones.get(n); const w = before.get(n)
        return b !== undefined && w !== undefined && (b.quaternion.angleTo(w.q) > 2e-3 || (n === this.rig.hips && b.position.distanceTo(w.p) > 1e-4))
      })
      if (changed.length === 0) {
        this.release()
        app.toast('info', was > 1e-4 ? `Nothing could be moved out: ${cm(was)} still inside` : 'Nothing to solve: no part of the body is in another')
        return
      }
      const tracks: Record<string, ClipKey[]> = {}
      this.keyBones(h, tracks, changed, v)
      if (await this.send(h.c, this.boneCommand(h, tracks), 'solve body')) {
        app.toast(left > 1e-4 ? 'info' : 'ok', `Solved: ${changed.length} ${changed.length === 1 ? 'joint' : 'joints'} keyed on this frame${left > 1e-4 ? `, ${cm(left)} still inside` : ''}`)
      }
    } finally {
      if (turn === this.turn) this.busy = null
    }
  }

  private poseOf (names: readonly string[]): Map<string, { q: THREE.Quaternion, p: THREE.Vector3 }> {
    const out = new Map<string, { q: THREE.Quaternion, p: THREE.Vector3 }>()
    const bones = animator.view?.bones
    for (const n of names) { const b = bones?.get(n); if (b !== undefined) out.set(n, { q: b.quaternion.clone(), p: b.position.clone() }) }
    return out
  }

  private putPose (pose: Map<string, { q: THREE.Quaternion, p: THREE.Vector3 }>, names: readonly string[]): void {
    const view = animator.view
    if (view === null) return
    for (const n of names) { const b = view.bones.get(n); const v = pose.get(n); if (b !== undefined && v !== undefined) b.quaternion.copy(v.q) }
    const hips = view.bones.get(this.rig.hips); const p = pose.get(this.rig.hips)
    if (hips !== undefined && p !== undefined) hips.position.copy(p.p)
    view.root.updateMatrixWorld(true)
  }

  // ---- naturalize --------------------------------------------------------------------------------------------------

  /** Naturalize the slot: every frame edged toward how people move and the motion smoothed, the hands kept on their
   * handles, keyed bones held near their keys; then keyed, every frame of every bone it moved (one undo). Each press
   * goes a little further. */
  async naturalize (amount: { pull: number, outside: number, motion: number } = NATURALIZE): Promise<void> {
    const h = this.here()
    if (h === null || this.busy !== null) return
    if (!await this.loadModel() || this.model === null) { app.toast('error', 'Naturalize works on a person (the library’s pose model)'); return }
    const view = h.view; const posable = this.posable(); const root = posable === null ? null : cloneSkinned(posable)
    if (view.rest === null || root === null) return
    this.busy = 'Naturalizing every frame'
    this.naturalizing = true
    this.naturalizeCancelled = false
    const turn = this.turn
    await new Promise(resolve => setTimeout(resolve, 30))
    try {
      const bones = bonesOf(root)
      const natural = new NaturalRig(this.model, bones, { offsets: this.offsets, limits: this.limitsOn ? this.limits : null, nameOf: b => b.name })
      const rig = await withGearNodes(h.c, root, async () => await this.rigOf(h, h.slot, true))
      const gearRig: GearRig = rig ?? { node: id => this.nodeName(id), paths: {}, attachments: [], handles: {}, carriers: Object.fromEntries(this.pieces.map(p => [p.id, p.bone])), fingers: {} }
      const hands = new Set(gearRig.attachments.map(a => a.hand))
      for (const a of gearRig.attachments) {
        if (gearRig.paths[a.gear]?.locked === true) continue
        const carrier = handSide(gearRig.carriers[a.gear] ?? '')
        if (carrier !== null) hands.add(carrier)
      }
      const attachedHands = [...hands].map(x => `${x}Hand`)
      const held = new Set([...hands].flatMap(x => Object.values(armOf(x))))
      const played = Object.fromEntries(Object.entries(h.slot.bones ?? {}).map(([b, ks]) => [b, keysToPlayed(h.map, ks)]))
      const keyed = Object.keys(played).filter(b => !held.has(b) && bones.has(b))
      const clip = h.baked.clip
      const duration = clip.duration
      const isPin = (k: ClipKey): boolean => k.p === undefined && Math.abs(k.q[3]) > 1 - 1e-9
      const pullAt = (t: number): Map<number, string[]> => {
        const byWeight = new Map<number, string[]>()
        for (const b of keyed) {
          const ks = played[b].filter(k => !isPin(k))
          if (ks.length === 0) continue
          const d = Math.min(...ks.map(k => Math.abs(t - k.u * duration) * KEY_FPS))
          const w = Math.round(PULL_WEIGHT * Math.max(0, 1 - d / PULL_FRAMES) * 100) / 100
          if (w > 0) byWeight.set(w, [...(byWeight.get(w) ?? []), b])
        }
        return byWeight
      }
      const rest = view.rest
      const soles: Record<string, number> = {}
      for (const side of SIDES) for (const n of ['Foot', 'ToeBase', 'Toe_End']) { const b = rest.bones.get(`${side}${n}`); if (b !== undefined) soles[`${side}${n}`] = b.worldPosition.y }
      const t0 = performance.now()
      const previousMiss = Math.max(0, ...handleMisses(clip, root, gearRig))
      const stale = (): boolean => this.naturalizeCancelled || turn !== this.turn || animator.playing?.baked !== h.baked
      const out = await naturalizeClipAsync(natural, clip, {
        root, fps: KEY_FPS, loop: h.loop,
        referenceClip: h.baked.unkeyed,
        cancelled: stale,
        progress: (done, total) => { if (turn === this.turn) this.busy = `Naturalizing ${Math.round(done / total * 100)}%` },
        goals: (_i, t) => [
          ...attachedHands.map(n => { const b = bones.get(n)!; return { bone: n, position: b.getWorldPosition(new THREE.Vector3()), turn: b.getWorldQuaternion(new THREE.Quaternion()), exact: true } as NaturalGoal }),
          ...[...pullAt(t)].flatMap(([w, names]) => poseTargets(natural, names, { weight: w })),
        ],
        feet: ['LeftFoot', 'RightFoot'].filter(n => bones.has(n)),
        floor: { y: 0, soles },
        hipsMove: true,
        collide: this.collider ?? undefined,
        pull: amount.pull, pullOutside: amount.outside, smoothMotion: amount.motion, sweeps: 3,
        obstacles: () => gearObstacles(gearRig, id => root.getObjectByName(this.nodeName(id))?.matrixWorld.clone() ?? null, GRIP_CLEAR * view.height),
      })
      if (stale()) throw new DOMException('Naturalization cancelled', 'AbortError')
      const worst = Math.max(0, ...handleMisses(out.clip, root, gearRig))
      if (!out.frames.every(f => [...f.q, ...f.hips, f.miss, f.floorMiss].every(Number.isFinite))) throw new Error('The solve produced an invalid pose; nothing was keyed')
      if (Math.max(...out.misses) > 0.01 * view.height || worst > Math.max(0.01 * view.height, previousMiss + 0.001 * view.height)) throw new Error('The solve could not keep the hands on their handles; nothing was keyed')
      if (Math.max(...out.frames.map(f => f.floorMiss)) > 0.002 * view.height) throw new Error('The solve could not keep the feet off the floor; nothing was keyed')
      const keep = new Set<Side>(hands)
      for (const carrier of Object.values(gearRig.carriers)) { const side = handSide(carrier); if (side !== null) keep.add(side) }
      for (const side of SIDES) {
        if (handLayers(h.c, h.slot, side).length > 0) keep.add(side)
        if (Object.entries(h.slot.bones ?? {}).some(([name, ks]) => name.startsWith(`${side}Hand`) && name !== `${side}Hand` && ks.some(k => !isPin(k)))) keep.add(side)
      }
      const fingers = await correctHandContactsAsync(root, out.clip, {
        height: view.height, fps: KEY_FPS, loop: h.loop, protect: [...keep], tipTolerance: view.height * 0.004,
        limits: this.limitsOn ? this.limits : null, nameOf: b => b.name, collider: colliderFor(root, bones, view.height),
        cancelled: stale,
        progress: (done, total) => { if (turn === this.turn) this.busy = `Refining fingers ${Math.round(done / total * 100)}%` },
      })
      if (stale()) throw new DOMException('Naturalization cancelled', 'AbortError')
      const tracks = naturalKeys(h, fingers.clip, held)
      if (Object.keys(tracks).length === 0) { app.toast('info', 'Naturalize changed nothing'); return }
      if (await this.send(h.c, [{ type: 'slot.keys.set', slot: h.slot.id, tracks: Object.entries(tracks).map(([bone, keys]) => ({ bone, keys })) }], 'naturalize')) {
        app.toast('ok', `Naturalized ${out.times.length} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${Object.keys(tracks).length} joints keyed${attachedHands.length > 0 ? `; hands off their handles by ${(worst * 100).toFixed(1)} cm at worst` : ''}`)
      }
    } catch (error) {
      const cancelled = (error as Error).name === 'AbortError'
      if (turn === this.turn) app.toast(cancelled ? 'ok' : 'error', cancelled ? 'Naturalization cancelled; nothing was keyed' : `Naturalize failed: ${reason(error)}`)
    } finally {
      this.naturalizing = false
      if (turn === this.turn) this.busy = null
    }
  }

  cancelNaturalize (): void { this.naturalizeCancelled = true }

  // ---- save as -------------------------------------------------------------------------------------------------------

  /** "Save as <clip>" (the designer, 2026-10-28: "I super just need to be able to save animations with the character as
   * a replacement to attack or run"): the slot playing copied over the slot `to` names (one the game plays, a trial),
   * replacing what it had (Ctrl+Z puts it back), or into a new slot of that name. It then plays the copy. */
  async saveAs (c: Character, fromId: string, target: { slotId: string | null, name: string }): Promise<boolean> {
    const name = target.name.trim()
    const from = slotById(c, fromId)
    if (from === undefined || name === '') return false
    const into = (target.slotId === null ? undefined : slotById(c, target.slotId)) ?? slotByName(c, name)
    if (into?.id === from.id) { app.toast('info', `${name} is the clip playing`); return false }
    const id = into?.id ?? newId()
    const entry = await app.do(c.id, into !== undefined ? { type: 'slot.copy', from: from.id, to: into.id } : { type: 'slot.copy', from: from.id, name, newId: id }, `save ${from.name} as ${name}`)
    if (entry === null) return false
    const after = app.byId(c.id)
    if (after !== null) await animator.playSlot(after, id, { keepTime: false })
    app.toast('ok', `${name} now plays ${from.name} as it is here`)
    return true
  }
}

/** A naturalized clip as keys: every bone (but the held arms) on every frame where it differs from the clip before
 * keys, as source keys (a bone the pass left as it was gets none). */
function naturalKeys (h: Here, clip: THREE.AnimationClip, held: ReadonlySet<string>): Record<string, ClipKey[]> {
  const base = h.baked.unkeyed
  const times = frameTimes(base.duration)
  const rest = boneRest(h.view.rest!)
  const out: Record<string, ClipKey[]> = {}
  const value = (c: THREE.AnimationClip, name: string, t: number, fallback: number[]): number[] => {
    const track = c.tracks.find(x => x.name === name)
    if (track === undefined) return fallback
    const i = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
    return Array.from(i.evaluate(Math.min(Math.max(t, 0), c.duration)) as ArrayLike<number>)
  }
  for (const [name] of h.view.bones) {
    const r = rest(name)
    if (r === null || held.has(name) || clip.tracks.every(t => t.name !== `${name}.quaternion`)) continue
    const hips = name === poseRigOf(h.c.skeleton.template).hips
    const keys: ClipKey[] = []
    let moved = false
    for (const t of times) {
      const q0 = new THREE.Quaternion().fromArray(value(base, `${name}.quaternion`, t, r.q.toArray()))
      const q1 = new THREE.Quaternion().fromArray(value(clip, `${name}.quaternion`, t, r.q.toArray()))
      const q = q0.invert().multiply(q1).normalize()
      const key: ClipKey = { u: sourceAt(h.map, base.duration > 0 ? t / base.duration : 0), q: q.toArray().map(r6) as ClipKey['q'] }
      if (q.angleTo(new THREE.Quaternion()) > 2e-3) moved = true
      if (hips) {
        const p0 = new THREE.Vector3().fromArray(value(base, `${name}.position`, t, r.p.toArray()))
        const p1 = new THREE.Vector3().fromArray(value(clip, `${name}.position`, t, r.p.toArray()))
        const p = p1.sub(p0)
        if (p.length() > 1e-4) moved = true
        key.p = p.toArray().map(r6) as Vec3
      }
      if (keys.length === 0 || key.u - keys[keys.length - 1].u > 1e-6) keys.push(key)
    }
    if (moved) out[name] = keys
  }
  return out
}

export const pose = new Pose()
