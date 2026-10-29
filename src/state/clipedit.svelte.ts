// The animation editor (Motion step, src/app/editor/EditPanel.svelte): a clip edited on the character. It opens on
// what plays: one of the character's slots "as it plays" (src/engine/bake.ts bakeSlot: its speed, timing, hands,
// ground and keys in it) or "the clip alone" (none of them), a library clip as it previews, or a new clip held from one
// frame. Scrub, drag or turn a joint (src/engine/PoseEditor.ts): letting go keys every bone the drag moved, at that
// frame, as a turn from where the clip had it (src/engine/clipedit.ts). On a clip with motion of its own a bone's first
// key also pins it at the clip's ends, so a change eases in and back out. Keys tween smoothly; every joint stays in
// its range (src/engine/limits.ts); no foot goes under the floor. Bone-attached gear (by gear id) is clicked to select
// it: moving or turning it keys its path and makes it lead (the hands on its handles follow it by IK), or, moving in the
// hand, moves it there. Hands take hold of its grip handles (letting a free hand go on it makes one). The body is solved
// only when asked (solveBody: an arm in the body pushed straight out first, then the body fitted to the hands on gear),
// never while a drag lasts, and what the solve moved is keyed on that frame.
//
// The edit itself (keys, paths, which hand is on which handle, the root holds) lives here until it is saved, with an
// undo and redo stack. What it changes on the character on the way (handles made or moved, hand poses, windows) are
// commands, journaled as they are made; the session remembers their journal entries, and discarding the edit offers
// to undo them. Leaving with unsaved edits (Finish, another clip, another step or character) asks first. Saving (one
// way: saveAs) writes a new library clip (a person's: the library's build; a creature's: a clip file of its own) and
// points the slot chosen at it, whatever it played before (clipedit.ts saveIntoSlotCommands).
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { Command } from '../model/command-types.ts'
import { newId } from '../model/ids.ts'
import { carryHandle, gearById, gearKeysFromPaths, gearTracksOf, handSide, slotById, slotByName } from '../model/select.ts'
import type { Adjustment, Character, ClipKey, ClipRef, Gear, Handle, HandPose, HandPoseRef, Placement, Quat, Side, Slot, Vec3, Window } from '../model/types.ts'
import { IDENTITY as AS_STORED, windowsToPlayed, windowsToSource, type TimeMap } from '../model/timemap.ts'
import { api, type LibraryClip } from './api.ts'
import { app } from './app.svelte.ts'
import { viewer } from './viewer.svelte.ts'
import { animator } from './animator.svelte.ts'
import { library } from './library.svelte.ts'
import { boneRest, type PullPlan } from '../engine/bake.ts'
import { freezeClip } from '../engine/mount.ts'
import { loadSource, refUrl, type SourceClip } from '../engine/clips.ts'
import {
  armOf, bonesOf, buildEdit, carrierGrip, fistGrip, frameAt, frameSolve, frameTimes, gearObstacles, GRIP_CLEAR, gripName, handGrip, handleMisses,
  handOn, handPoseSource, holdAt, keyFor, legsOf, nodePath, onPath, reachGoals, ROOT_HOLD, rootPath, saveIntoSlotCommands, unretarget, withoutGearKeys,
  type Attachment, type EditMode, type GearPath, type GearRig, type Grip, type HandPoseSource, type PlacedHandle, type RootHold,
} from '../engine/clipedit.ts'
import { clipGlb, framesClip } from '../engine/clipexport.ts'
import { restFrame } from '../engine/garments.ts'
import { gearNode, principalAxis } from '../engine/geom.ts'
import { handLayers, handleRef, poseOfRef } from '../engine/hands.ts'
import { applyBoneKeys, KEY_FPS, propKeysOf, sampleKeys } from '../engine/keys.ts'
import { garmentMatrix, placementFromMatrix } from '../engine/placement.ts'
import { JointLimits, type Rom } from '../engine/limits.ts'
import { HORSE_RIG, HUMAN_RIG, PoseEditor, type PoseRig } from '../engine/PoseEditor.ts'
import { retargetOffsets } from '../engine/retarget.ts'
import { reach, setWorldQuaternion } from '../engine/ik.ts'
import { colliderFor, type CharacterCollider } from '../engine/bodycollide.ts'
import {
  createBodySolver, loadPoseModel, naturalizeClipAsync, NaturalRig, poseTargets, SLIDE, type BodySolver,
  type NaturalGoal, type PoseModel, type PoseModelData,
} from '../engine/posespace.ts'
import { FIT, fitProp, type FitResult } from '../engine/propfit.ts'
import { correctHandContactsAsync } from '../engine/handcontacts.ts'
import { pushClear } from '../engine/pushclear.ts'

const IDENTITY: Quat = [0, 0, 0, 1]
const SIDES = ['Left', 'Right'] as const
/** Naturalize: how hard a keyed bone is pulled to the edit at its key, and over how many frames that fades out. */
const PULL_WEIGHT = 4
const PULL_FRAMES = 3
/** Naturalize, each press: the pull toward the library's poses (per whitened unit squared: the whole, and the part of a
 * pose outside what people do together), and the pull of each pose to the middle of its neighbours' (per radian squared). */
const NATURALIZE = { pull: 0.05, outside: 0.5, motion: 15 }
/** How near (a share of the body's height) a free hand's fist must be let go to a piece's shaft to snap onto it. */
const SNAP_REACH = 0.1
/** The gap left between two hands on one shaft, beyond their widths (a share of the body's height). */
const HAND_GAP = 0.005
/** Edits the undo stack keeps. */
const UNDO_DEPTH = 100
/** A shaft's radius, as a share of the body's height, when the piece's own isn't measured. */
const SHAFT_RADIUS = 0.011
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4
const isAnchor = (k: ClipKey): boolean => k.p === undefined && Math.abs(k.q[3]) > 1 - 1e-9
const r5 = (v: number[]): number[] => v.map(x => Math.round(x * 1e5) / 1e5)
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const cm = (metres: number): string => `${(metres * 100).toFixed(1)} cm`

/** The range-of-motion and pose model files, fetched once a page (a failure is asked again next time). */
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

/** What an edit saved here was made of (server/clipedits.ts editRecord): what reopen opens. */
export type EditRecord = Awaited<ReturnType<typeof api.editRecord>>

/** A bone-attached piece of gear the editor can move and put hands on (ready, shown, placed in rest space). */
export interface Piece { id: string, name: string, bone: string, gear: Gear, place: Placement }

/** What the edit was opened on. */
export interface EditBase {
  /** As shown: the slot's name, the library clip's. */
  label: string
  /** The library clip it plays (its skeleton is what the edit is saved on). */
  clip: ClipRef
  loop: boolean
  inPlace: boolean
  /** A library clip previewed (its gear paths play with it). */
  library: LibraryClip | null
  /** A rig test (played alone, stood on the floor). */
  test: boolean
  /** The gear paths a library clip previews with (by gear name: its own); none for a slot's clip. */
  paths: Record<string, ClipKey[]>
  /** A clip made here before, opened again as the edit it was made from (reopen): the slot's save goes over it when only
   * that slot plays it; `gear`: the pieces whose recorded paths make their motion again (the slot's keys on them are
   * left out of the clip baked). */
  made?: { ref: ClipRef, gear: string[] }
}

/** The edit as it stands, for undo. */
interface Snapshot {
  keys: Record<string, ClipKey[]>
  paths: Record<string, GearPath>
  attachments: Attachment[]
  holds: RootHold[]
  groups: Array<{ u: number, bones: string[] }>
}

/** A command the editor sent during the session, by its journal entry. */
export interface Issued { seq: number, changes: string[] }

class ClipEdit {
  active = $state(false)
  private busyText = $state<string | null>(null)
  /** What it is doing (the viewport's busy pill too); null when idle. */
  get busy (): string | null { return this.busyText }
  set busy (text: string | null) {
    this.busyText = text
    app.setBusy('clipedit', text)
  }

  /** The character edited on (the one on stage when it opened). */
  characterId = $state<string | null>(null)
  character = $derived(this.characterId === null ? null : app.byId(this.characterId))
  /** How it was opened: the slot's clip as it plays, the slot's clip alone, or a new clip held from one frame. */
  mode = $state<EditMode>('plays')
  base = $state.raw<EditBase | null>(null)
  /** The slot this edits (by id); null for a library clip, a rig test or a new clip. */
  slotId = $state<string | null>(null)
  slot = $derived(this.slotId === null || this.character === null ? null : slotById(this.character, this.slotId) ?? null)
  /** The slot playing when it opened (a new clip held from one of its frames too): what the save offers first. */
  fromSlotId = $state<string | null>(null)
  /** A new clip made from a held pose (no motion of its own: keys hold until the next, no pins at the ends). */
  held = $derived(this.mode === 'held')
  /** Its windows (a hand opening, a pull held) are the slot's, edited here only on the clip as it plays. */
  windowsEditable = $derived(this.slot !== null && this.mode === 'plays')

  keys = $state.raw<Record<string, ClipKey[]>>({})
  /** The gear on stage the editor can move: bone gear, ready and shown. */
  pieces = $derived.by((): Piece[] => (this.character?.gear ?? []).flatMap(g => {
    const a = g.attach
    if (g.status !== 'ready' || g.hidden === true || a.kind !== 'bone' || a.legacyFrame !== undefined) return []
    return [{ id: g.id, name: g.name, bone: a.bone, gear: g, place: a.place }]
  }))
  /** The piece selected (clicked, by gear id), or none. */
  gear = $state<string | null>(null)
  /** What the gizmo on a piece moves: this frame only (a key on its path) or every frame (the whole path, by the move). */
  moves = $state<'frame' | 'every'>('frame')
  /** Dragging a piece moves it in the hand (whatever holds it stays; this frame keys it, tweened; every frame changes
   * how it sits on its bone, in every clip) instead of leading (the hands following it). */
  inHand = $state(false)
  /** Each piece's path: locked (it leads), and its keys. */
  paths = $state.raw<Record<string, GearPath>>({})
  /** The hands on handles. */
  attachments = $state.raw<Attachment[]>([])
  selected = $state<string | null>(null)
  limitsOn = $state(true)
  /** What the gizmo on the joint selected does: moves it (the limb follows) or turns its bone. */
  gizmo = $state<'move' | 'rotate'>('move')
  /** A turn about the bone's own axes or the world's. */
  space = $state<'local' | 'world'>('local')
  naturalizing = $state(false)
  /** The library's pose model is loaded (a person): the body follows the hands, gear can lead, Naturalize. Without it
   * (a creature, or the model not loaded) the hands reach their handles by IK alone and gear moves in the hand. */
  natural = $state(false)
  /** The edit as it was last naturalized (shown and saved until the next change). */
  naturalized = $state(false)
  /** A held clip's length (seconds). */
  length = $state(1)

  /** Taken back and put again: whole states of the edit. */
  private undoStack = $state.raw<Snapshot[]>([])
  private redoStack = $state.raw<Snapshot[]>([])
  canUndo = $derived(this.undoStack.length > 0)
  canRedo = $derived(this.redoStack.length > 0)
  /** Bumped by every change to the edit; what was saved is the one at savedAt. */
  private revision = $state(0)
  private savedAt = $state(0)
  /** The commands sent while editing (their journal entries), offered for undoing when the edit is discarded. */
  issued = $state.raw<Issued[]>([])

  /** The frames keyed (phases), for the timeline. */
  phases = $derived([...new Set([...Object.values(this.keys), ...Object.values(this.paths).map(p => p.keys)].flat().filter(k => this.held || !isAnchor(k) || (k.u > 0 && k.u < 1)).map(k => Math.round(k.u * 1e4) / 1e4))].sort((a, b) => a - b))
  /** The selected bone's (or piece's) keyed frames. */
  selectedPhases = $derived(this.gear !== null ? (this.paths[this.gear]?.keys ?? []).map(k => k.u) : this.selected === null ? [] : (this.keys[this.selected] ?? []).map(k => k.u))
  hasKeys = $derived(Object.values(this.keys).some(ks => ks.length > 0) || Object.values(this.paths).some(p => p.keys.length > 0))
  canSave = $derived(this.held || this.naturalized || this.hasKeys || this.attachments.length > 0 || Object.values(this.paths).some(p => p.locked))
  /** Something was changed since it opened or was last saved. */
  unsaved = $derived(this.active && this.canSave && this.revision !== this.savedAt)

  /** The holds of gear drags let go: the body's root held near where it was seen on the frames each moved its piece. */
  private holds: RootHold[] = []
  /** The bones each drag keyed together, at its frame: Delete with one of them selected takes the others' keys there too. */
  private groups: Array<{ u: number, bones: string[] }> = []
  /** Each hand's fingers closed round a shaft (as its pose in the clip has it). */
  private fists: Partial<Record<Side, Record<string, Quat>>> = {}
  private gripCache: Partial<Record<Side, { fingers: Record<string, Quat>, radius: number, root: THREE.Object3D, grip: Grip }>> = {}
  /** Each piece's long axis in its own node's frame (measured once: its mesh doesn't change while editing). */
  private shafts = new Map<string, { from: THREE.Vector3, to: THREE.Vector3, radius: number }>()
  /** Each piece's node (its placed frame on its bone) as a drag began. */
  private dragFrom = new Map<string, THREE.Matrix4>()
  /** While a joint is dragged: each leading piece's place (world) when the drag began, where it is kept. */
  private dragPlaces = new Map<string, THREE.Matrix4>()
  /** Grip handles this session made (`gear/handle`): only these are taken off again when no hand is on them. */
  private made = new Set<string>()
  private pending: Array<Promise<unknown>> = []

  private naturalizeCancelled = false
  private naturalizeRun = 0
  /** Counts openings and stops: an opening whose count is no longer this one is stale. */
  private opening = 0
  private rebuilds = 0
  private saving = false
  private baseClip: THREE.AnimationClip | null = null
  /** How the slot opened plays (its baked time map): its windows are source time, shown and set where this clip has
   * them. */
  private played: TimeMap = AS_STORED
  private edited: THREE.AnimationClip | null = null
  /** The pulls held in the clip as it plays (drawn while it shows). */
  private pulls: PullPlan[] | null = null
  private editor: PoseEditor | null = null
  private limits: JointLimits | null = null
  private rig: PoseRig = HUMAN_RIG
  private source: SourceClip | null = null
  /** The ground lift in the clip opened (taken out of the saved frames: a slot's ground adjustment stays). */
  private lift = 0
  /** The body solve (the natural-pose solver), or none: no pose model. */
  private solver: BodySolver | null = null
  /** The character on stage's collider (the one collision model: bodycollide.ts). */
  private collider: CharacterCollider | null = null
  /** Edit records asked for (by clip id; null: none), for EditPanel's "Open the edit it was made from". */
  private records = new Map<string, Promise<EditRecord | null>>()
  /** The library's pose model, and the retarget's turns (for Naturalize). */
  private model: PoseModel | null = null
  private offsets: Map<string, THREE.Quaternion> | null = null
  private offGuard: (() => void) | null = null
  private readonly animatorGuard = async (): Promise<boolean> => await this.mayLeave()
  private readonly leaveHook = (): void => { this.stop() }
  private readonly refreshHook = (): void => { void this.rebuild() }

  // ---- opening and leaving -------------------------------------------------------------------------------------

  /** Edit what plays: a slot as it plays or its clip alone, a library clip as it previews. */
  async start (mode: 'plays' | 'alone' = 'plays'): Promise<void> {
    await this.open(mode)
  }

  /** Make a new clip from the frame playing now: that pose held for `seconds`. */
  async startFromPose (seconds: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 20) { app.toast('error', 'Choose a clip length from 0.2 to 20 seconds'); return }
    await this.open('held', seconds)
  }

  /**
   * Open again the edit a clip made here was made from (its record, server/clipedits.ts: the clip it was made on, its
   * keys, its gear's paths), on what plays it: the slot playing it (as it plays or alone, as it was made) or its library
   * preview. Saving to the slot goes over it as before. A clip made from a held frame can't be: its frame isn't recorded.
   */
  async reopen (): Promise<void> {
    if (this.busy !== null) return
    const now = animator.playing
    const c = now === null ? null : app.byId(now.characterId)
    const slot = now?.kind === 'slot' && c !== null ? slotById(c, now.slotId ?? '') ?? null : null
    const made = slot?.clip ?? now?.ref ?? null
    if (now === null || c === null || made === null || !made.id.startsWith('custom-')) { app.toast('error', 'Play a clip made here, then open its edit'); return }
    const record = await this.recordOf(made.id)
    if (record === null) { app.toast('error', `${made.id} has no edit record to open`); return }
    if (record.making?.mode === 'held') { app.toast('error', 'A clip made from a held frame can’t be opened as its edit (its frame isn’t recorded): edit the clip itself'); return }
    await this.open(slot !== null && record.making?.mode === 'alone' ? 'alone' : 'plays', 1, { record, made })
  }

  /** A clip's edit record (it was made here), or null: asked once a page, again after a save. */
  async recordOf (clipId: string): Promise<EditRecord | null> {
    if (!clipId.startsWith('custom-')) return null
    let p = this.records.get(clipId)
    if (p === undefined) {
      p = api.editRecord(clipId).catch(() => null)
      this.records.set(clipId, p)
    }
    return await p
  }

  /** The keys and gear paths an edit record was made of, as this edit's (gear by name: a piece this character hasn't
   * goes; without the pose model a piece can't lead, so a leading path goes too). */
  private restoreMaking (record: EditRecord): void {
    const making = record.making ?? {}
    const bones = animator.view?.bones
    this.keys = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(making.keys ?? {}).filter(([b]) => bones?.has(b) === true)))) as Record<string, ClipKey[]>
    const paths: Record<string, GearPath> = {}
    for (const [name, path] of Object.entries(making.gear ?? {})) {
      const p = this.pieces.find(x => x.name === name)
      if (p === undefined || (path.locked && !this.natural)) continue
      paths[p.id] = { locked: path.locked, keys: JSON.parse(JSON.stringify(path.keys)) as ClipKey[] }
    }
    this.paths = paths
  }

  private async open (mode: EditMode, seconds = 1, reopen: { record: EditRecord, made: ClipRef } | null = null): Promise<void> {
    const now = animator.playing; const view = animator.view; const shown = animator.clip
    const c = now === null ? null : app.byId(now.characterId)
    if (now === null || c === null || view === null || view.rest === null || shown === null || animator.stage === null) { app.toast('error', 'Play a clip first, then edit it'); return }
    if (this.active && !await this.mayLeave()) return
    // (what plays: a slot, a library clip, a rig test; an edit left showing or a hand pose's frame isn't a clip to open)
    const slot = now.kind === 'slot' ? slotById(c, now.slotId ?? '') ?? null : null
    const playing = slot?.clip ?? now.ref
    if (playing === null || (now.kind === 'slot' && slot === null) || now.kind === 'clip') { app.toast('error', 'Play one of the clips, then edit it'); return }
    if (reopen !== null && playing.id !== reopen.made.id) { app.toast('error', `${reopen.made.id} no longer plays`); return }
    // (opened again from its record: on the clip it was made from)
    const ref: ClipRef = reopen === null ? playing : { id: reopen.record.base }
    if (mode === 'alone' && slot === null) mode = 'plays'
    const time = animator.time
    // (where it is, as a phase: the clip alone is at speed 1, so its own length)
    const at = animator.duration > 0 ? Math.min(1, time / animator.duration) : 0
    this.stop()
    // (this opening's turn: a later start or a stop, another character, or something else played meanwhile, makes it
    // stale, and it stops at its next await)
    const turn = this.opening
    const stale = (): boolean => turn !== this.opening || animator.view !== view || animator.playing !== now
    this.busy = 'Opening the clip'
    try {
      this.characterId = c.id
      this.mode = mode
      this.slotId = mode === 'held' ? null : slot?.id ?? null
      this.fromSlotId = slot?.id ?? null
      this.base = {
        // (a slot loops as it is saved; a preview as the timeline has it, one opened again as it was saved)
        label: mode === 'held' ? 'New clip' : slot?.name ?? reopen?.record.name ?? now.label, clip: ref,
        loop: mode === 'held' ? false : slot?.loop ?? reopen?.record.loop ?? animator.loop,
        inPlace: slot?.inPlace ?? now.inPlace, library: slot === null ? now.library : null, test: now.kind === 'test',
        // (a library preview plays its own gear paths; a clip opened again is the one it was made from, whose aren't known)
        paths: slot !== null || reopen !== null ? {} : now.library?.propPaths ?? {},
      }
      const template = c.skeleton.template
      const rigName = template === 'human' ? 'human' : template
      this.rig = rigName === 'horse' ? HORSE_RIG : HUMAN_RIG
      const source = await loadSource(refUrl(ref))
      if (stale()) return
      this.source = source
      // (the joints' ranges, mapped onto this character through the retarget's turns)
      const rom = await fetchJson<Rom>(`/templates/rom/${rigName}.json`)
      if (stale()) return
      const rest = view.rest
      const offsets = retargetOffsets(source.rest, rest).offsets
      this.limits = rom === null ? null : new JointLimits(rom, offsets, name => rest.bones.get(name)?.parent ?? null, rigName === 'human' ? 1 : 3, rigName === 'human' ? 5 : 15)
      const poses = rigName === 'human' ? await fetchJson<PoseModelData>('/templates/rom/human-pose.json') : null
      if (stale()) return
      this.model = poses === null ? null : loadPoseModel(poses)
      this.offsets = offsets
      // (the body as solids, fitted to this character's mesh when first needed: no part of it ends up inside another)
      this.collider = colliderFor(view.root, view.bones, view.height)
      this.solver = this.model === null ? null : createBodySolver(this.model, offsets, { hipsMove: true, collide: this.collider })
      this.natural = this.model !== null
      // (the edit afresh, or as its record has it: before the bake, which leaves out what the record's paths make again)
      this.keys = {}; this.paths = {}
      if (reopen !== null) {
        this.restoreMaking(reopen.record)
        this.base = { ...this.base, made: { ref: reopen.made, gear: Object.keys(this.paths) } }
      }
      if (mode === 'held') {
        this.baseClip = holdOf(shown, time, seconds)
        this.length = seconds
        this.lift = animator.lift
        this.pulls = null
      } else {
        const baked = await this.bakeBase(c)
        if (stale()) return
        if (baked === null) { app.toast('error', 'That clip could not be opened'); this.stop(); return }
        this.baseClip = baked.clip
        this.lift = baked.lift
        this.pulls = baked.pulls
      }
      this.edited = this.baseClip
      this.attachments = []; this.holds = []; this.groups = []
      this.undoStack = []; this.redoStack = []; this.issued = []; this.pending = []; this.made.clear()
      this.selected = null; this.gear = null; this.inHand = false; this.moves = 'frame'
      this.revision = 0; this.savedAt = 0
      animator.setPlaying(false)
      // (the player loops as the edit does: a new clip from a frame plays once)
      animator.setLoop(this.base.loop)
      // (a rider is edited in his own space, as the working copy is: off the moving horse, it shown under him)
      viewer.setEditingRider(true)
      this.makeEditor(this.limitsOn)
      this.active = true
      this.offGuard = app.guard(async () => {
        if (!this.active) return true
        if (!await this.mayLeave()) return false
        // (another step or character: the editor ends, and the edit shown with it)
        this.stop()
        void animator.stop()
        return true
      })
      animator.guard = this.animatorGuard
      animator.leaveEditor = this.leaveHook
      animator.editorRefresh = this.refreshHook
      this.show(mode === 'held' ? 0 : at * this.baseClip.duration)
    } catch (error) {
      if (!stale()) { app.toast('error', `The clip didn't open: ${reason(error)}`); this.stop() }
    } finally {
      if (turn === this.opening) this.busy = null
    }
  }

  /** The clip the edit is made on, as it plays (or alone): baked as Motion plays it. Null when it is gone. */
  private async bakeBase (c: Character): Promise<{ clip: THREE.AnimationClip, lift: number, pulls: PullPlan[] | null } | null> {
    const b = this.base
    if (b === null || this.mode === 'held') return null
    if (this.slotId !== null) {
      const had = slotById(c, this.slotId)
      if (had === undefined) return null
      // (opened again from its record: the slot on the clip the edit was made from, without the keys on gear its save
      // gave the slot for the pieces whose paths the edit has: those paths make that motion again)
      const slot = b.made === undefined ? had : withoutGearKeys({ ...had, clip: b.clip }, b.made.gear)
      const baked = await animator.bake(c, slot, this.mode === 'alone' ? { skip: 'all' } : {})
      // (the slot's windows are source time; the editor shows and sets them where this clip plays them)
      this.played = baked === null || this.mode === 'alone' ? AS_STORED : baked.time
      return baked === null ? null : { clip: baked.clip, lift: baked.lift, pulls: this.mode === 'alone' ? null : baked.pulls }
    }
    // (a library clip or a rig test, as it previews: a slot made of it, its gear paths played, stood on the floor)
    const gear = gearKeysFromPaths(c, b.paths)
    const preview: Slot = {
      id: 'preview', name: b.label, clip: b.clip, speed: 1, loop: b.loop, inPlace: b.inPlace,
      adjustments: [], gear: gearTracksOf(gear),
    }
    const baked = await animator.bake(c, preview, { autoGround: c.mount === undefined, ...(b.test ? { skip: 'all' as const } : {}) })
    return baked === null ? null : { clip: baked.clip, lift: baked.lift, pulls: baked.pulls }
  }

  /** The clip the edit is made on baked again (its hands, windows or gear changed), the edit kept on it. */
  private async rebuild (): Promise<void> {
    this.fists = {}
    this.gripCache = {}
    const c = this.character
    if (!this.active || c === null) return
    const turn = this.opening; const run = ++this.rebuilds
    const t = animator.time
    if (this.mode === 'held') {
      const fists = await this.closeHands()
      if (turn === this.opening && run === this.rebuilds) { this.fists = { ...fists, ...this.fists }; this.show(t) }
      return
    }
    this.busy = 'Building the clip again'
    try {
      const baked = await this.bakeBase(c)
      // (the hands on handles closed again, as their poses now say: a hand made on meanwhile keeps its own)
      const fists = await this.closeHands()
      if (turn !== this.opening || run !== this.rebuilds) return
      if (baked === null) { app.toast('error', 'The clip edited is gone'); return }
      this.fists = { ...fists, ...this.fists }
      this.baseClip = baked.clip
      this.lift = baked.lift
      this.pulls = baked.pulls
      this.show(Math.min(t, baked.clip.duration))
    } catch (error) {
      if (turn === this.opening) app.toast('error', `The clip didn't build: ${reason(error)}`)
    } finally {
      if (turn === this.opening && run === this.rebuilds) this.busy = null
    }
  }

  /** Leave the editor at once, nothing asked (the edit shown stays until something else plays). */
  stop (): void {
    // (an opening still loading, a fit still running, are dropped; a save runs on)
    this.opening++
    if (!this.saving) this.busy = null
    this.editor?.dispose()
    this.editor = null
    this.active = false
    viewer.setEditingRider(false)
    this.offGuard?.()
    this.offGuard = null
    if (animator.guard === this.animatorGuard) animator.guard = null
    if (animator.leaveEditor === this.leaveHook) animator.leaveEditor = null
    if (animator.editorRefresh === this.refreshHook) animator.editorRefresh = null
    // (the gear back where it is placed)
    const view = animator.view
    for (const p of this.pieces) {
      const n = view?.root.getObjectByName(gearNode(p.gear))
      if (n === undefined) continue
      garmentMatrix(p.place).decompose(n.position, n.quaternion, n.scale)
      n.updateMatrixWorld(true)
    }
    // (the fists and grips were this character's: another character's edit takes its own)
    this.fists = {}
    this.gripCache = {}
    this.shafts.clear()
    this.made.clear()
    this.undoStack = []
    this.redoStack = []
    this.issued = []
    this.pending = []
    animator.holding = false
  }

  /** Finish editing (asked first when there are unsaved edits): the clip it was opened on plays again. */
  async finish (): Promise<void> {
    if (!this.active || this.busy !== null) return
    if (this.unsaved && !await this.discard()) return
    await this.leave()
  }

  /** Stop, and play again what was edited (a slot, the library clip), or nothing. */
  private async leave (): Promise<void> {
    const c = this.character; const slotId = this.slotId; const lib = this.base?.library ?? null
    this.stop()
    if (c !== null && slotId !== null && slotById(c, slotId) !== undefined) await animator.playSlot(c, slotId, { keepTime: false })
    else if (lib !== null) await animator.playLibrary(lib)
    else await animator.stop()
  }

  /** Whether the edit may go (nothing unsaved, or the user lets it). */
  private async mayLeave (): Promise<boolean> {
    if (!this.active || !this.unsaved) return true
    return await this.discard()
  }

  /** Ask before the unsaved edit goes; then offer to undo what it changed on the character on the way. */
  private async discard (): Promise<boolean> {
    const what = this.mode === 'held' ? 'the new clip' : this.base?.label ?? 'the clip'
    const ok = await app.confirm({
      title: 'Discard the unsaved edit?', body: `Your changes to ${what} are not saved; they will be lost.`,
      confirm: 'Discard', cancel: 'Keep editing', danger: true,
    })
    if (!ok) return false
    await Promise.allSettled(this.pending)
    const issued = this.issued
    const id = this.characterId
    this.issued = []
    if (issued.length > 0 && id !== null) {
      const lines = issued.flatMap(x => x.changes)
      const shown = lines.slice(0, 6).join('; ') + (lines.length > 6 ? `; and ${lines.length - 6} more` : '')
      const undo = await app.confirm({
        title: `Undo what the editor changed on ${this.character?.name ?? 'the character'} too?`,
        body: `While editing: ${shown || 'changes to its gear and hands'}.`, confirm: 'Undo them', cancel: 'Keep them',
      })
      if (undo) for (const x of [...issued].reverse()) await app.undo(id, x.seq)
    }
    this.savedAt = this.revision
    return true
  }

  setLimits (on: boolean): void {
    this.limitsOn = on
    if (!this.active) return
    // (the editor is made again with or without them)
    const selected = this.selected; const gear = this.gear
    this.makeEditor(on)
    if (gear !== null) this.editor?.selectGear(gear); else this.editor?.select(selected)
  }

  /** The pose editor on stage (with the limits or without). */
  private makeEditor (limits: boolean): void {
    const stage = animator.stage; const view = animator.view
    if (stage === null || view === null) return
    this.editor?.dispose()
    this.editor = new PoseEditor(stage, view, this.rig, limits ? this.limits : null, {
      select: b => { this.selected = b },
      selectGear: g => { this.gear = g },
      begin: () => {
        animator.setPlaying(false); animator.holding = true; this.dragPlaces = this.leadingPlaces()
        this.dragFrom = new Map([...this.pieceNodes()].map(([n, node]) => { node.updateMatrix(); return [n, node.matrix.clone()] }))
      },
      commit: bones => { void this.commit(bones) },
      // (a drag is IK alone: the body is solved only when asked, solveBody)
      constrain: moving => { this.keepLeading(); this.handsLive(moving) },
      moveGear: (g, place, done) => { if (done) this.commitGear(g, place); else this.gearLive(g, place) },
    }, 0, () => this.pieceNodes())
    this.editor.setMode(this.gizmo)
    this.editor.setSpace(this.space)
    this.editor.setGripLock(b => this.gripHold(b))
  }

  selectGear (id: string | null): void { this.editor?.selectGear(id) }
  select (bone: string | null): void { this.editor?.select(bone) }
  setGizmo (mode: 'move' | 'rotate'): void { this.gizmo = mode; this.editor?.setMode(mode) }
  setSpace (space: 'local' | 'world'): void { this.space = space; this.editor?.setSpace(space) }

  private get loop (): boolean { return this.base?.loop ?? true }

  /** A held clip's length changed: its keys keep their place in it. */
  setLength (seconds: number): void {
    if (!this.held || this.baseClip === null || !Number.isFinite(seconds) || seconds < 0.2 || seconds > 20) return
    const u = animator.time / Math.max(this.baseClip.duration, 1e-6)
    this.baseClip = holdOf(this.baseClip, 0, seconds)
    this.length = seconds
    this.revision++
    this.show(u * seconds)
  }

  /** Loops or plays once (its keys tween round from the last to the first when it loops). */
  setLoop (loop: boolean): void {
    if (this.base === null) return
    this.base = { ...this.base, loop }
    animator.setLoop(loop)
    this.revision++
    this.show(animator.time)
  }

  // ---- time ------------------------------------------------------------------------------------------------------

  /** The playhead as a phase of the clip, snapped to a frame (a loop's last frame is its first: a key there is the first's). */
  phase (): number {
    const d = this.baseClip?.duration ?? 0
    if (d <= 0) return 0
    const frames = Math.max(1, Math.round(d * KEY_FPS))
    const u = Math.round(Math.min(1, Math.max(0, animator.time / d)) * frames) / frames
    return this.loop && near(u, 1) ? 0 : u
  }

  /** A time snapped to the nearest frame of the clip edited (the playhead, while editing: a key is made on a frame, of
   * the pose seen there). */
  snapTime (time: number): number {
    const d = this.baseClip?.duration ?? 0
    if (!this.active || d <= 0) return time
    const frames = Math.max(1, Math.round(d * KEY_FPS))
    return Math.round(Math.min(1, Math.max(0, time / d)) * frames) / frames * d
  }

  // ---- undo --------------------------------------------------------------------------------------------------------

  private snapshot (): Snapshot {
    return { keys: this.keys, paths: this.paths, attachments: this.attachments, holds: this.holds, groups: this.groups }
  }

  private restore (s: Snapshot): void {
    this.keys = s.keys; this.paths = s.paths; this.attachments = s.attachments; this.holds = s.holds; this.groups = s.groups
  }

  /** Remember the edit as it is, before a change. */
  private record (): void {
    this.undoStack = [...this.undoStack.slice(-(UNDO_DEPTH - 1)), this.snapshot()]
    this.redoStack = []
    this.revision++
  }

  undo (): void {
    const last = this.undoStack.at(-1)
    if (!this.active || this.busy !== null || last === undefined) return
    this.undoStack = this.undoStack.slice(0, -1)
    this.redoStack = [...this.redoStack, this.snapshot()]
    this.restore(last)
    this.revision++
    this.show(animator.time)
  }

  redo (): void {
    const next = this.redoStack.at(-1)
    if (!this.active || this.busy !== null || next === undefined) return
    this.redoStack = this.redoStack.slice(0, -1)
    this.undoStack = [...this.undoStack, this.snapshot()]
    this.restore(next)
    this.revision++
    this.show(animator.time)
  }

  // ---- commands on the character -----------------------------------------------------------------------------------

  /** Send commands for the character edited, remembering the journal entry they make (offered for undo on discard). */
  private issue (commands: Command[]): void {
    const id = this.characterId
    if (id === null || commands.length === 0) return
    const turn = this.opening
    const p = app.do(id, commands).then(entry => {
      if (entry !== null && entry.undo !== undefined && turn === this.opening) this.issued = [...this.issued, { seq: entry.seq, changes: entry.changes }]
    })
    this.pending = [...this.pending, p]
  }

  // ---- keys ----------------------------------------------------------------------------------------------------------

  /** Key the bones a drag moved, at the playhead (only those: the solve does the rest). */
  private async commit (moved: string[]): Promise<void> {
    const view = animator.view; const base = this.baseClip
    if (view === null || base === null || moved.length === 0) { animator.holding = false; return }
    // (a free hand let go near a piece's shaft snaps onto it there: its fingers close as the clip has them first,
    // the drag's pose held meanwhile, so nothing below waits on anything)
    const turn = this.opening
    let snap = this.snapTarget(moved)
    if (snap !== null && this.fists[snap.hand] === undefined) {
      const fist = await this.fistOf(snap.hand, snap.gear)
      if (turn !== this.opening) return
      this.fists[snap.hand] ??= fist
    }
    if (snap !== null) snap = this.snapTarget(moved)
    const u = this.phase()
    const t = u * base.duration
    // (an arm on a handle is the handle's, not keyed)
    const attached = this.heldBones()
    if (snap !== null) for (const b of [...Object.values(armOf(snap.hand)), ...Object.keys(this.fists[snap.hand] ?? {})]) attached.add(b)
    // (keyed now, as seen, before anything else can move a bone)
    const next = { ...this.keys }
    const bones = moved.filter(b => !attached.has(b))
    this.keyBones(next, bones, u)
    const commands: Command[] = []
    let attachments = this.attachments
    // (a hand on a handle moved or turned: its handle goes exactly where the hand is now)
    for (const a of attachments) {
      if (!moved.includes(armOf(a.hand).end)) continue
      const place = this.placeAt(a.hand, a.gear, false, true)
      if (place !== null) commands.push({ type: 'gear.handle.update', gear: a.gear, id: a.handle, patch: { place, exact: true } })
    }
    // (the hand carrying a leading piece moved or turned: its carry handle takes where it holds it now; the piece stays
    // on its path)
    for (const [gid, path] of Object.entries(this.paths)) {
      const p = this.pieceOf(gid)
      const side = p === undefined ? null : handSide(p.bone)
      const carry = p === undefined ? undefined : carryHandle(p.gear)
      if (!path.locked || side === null || carry === undefined || !moved.includes(`${side}Hand`) || attachments.some(a => a.hand === side)) continue
      const place = this.placeAt(side, gid, false, true)
      if (place === null) continue
      commands.push({ type: 'gear.handle.update', gear: gid, id: carry.id, patch: { place, exact: true } })
      attachments = [...attachments, { hand: side, gear: gid, handle: carry.id }]
    }
    if (snap !== null) {
      const place = this.placeAt(snap.hand, snap.gear, true)
      if (place !== null) {
        const { command, id } = this.gripHandle(snap.hand, snap.gear, this.clearOfOthers(snap.hand, snap.gear, place, attachments))
        commands.push(command)
        attachments = [...attachments.filter(a => a.hand !== snap.hand), { hand: snap.hand, gear: snap.gear, handle: id }]
      }
    }
    commands.push(...this.prune(attachments))
    // (a press that changed nothing (an arm on a handle let go where it was) leaves no undo step)
    if (bones.length > 0 || attachments !== this.attachments || commands.length > 0) {
      this.record()
      if (bones.length > 0) this.groups = [...this.groups.filter(g => !(near(g.u, u) && g.bones.some(b => bones.includes(b)))), { u, bones }]
      this.keys = next
      this.attachments = attachments
      this.issue(commands)
    }
    this.show(t)
  }

  /** The bones held by a hand on gear (an arm on a handle with the fingers closed on it, an arm carrying a piece that
   * leads): a drag doesn't key them; letting go moves their handles instead. */
  private heldBones (): Set<string> {
    const carriers = Object.entries(this.paths).filter(([, x]) => x.locked).map(([g]) => this.carrierOf(g)?.hand).filter((h): h is Side => h !== undefined)
    return new Set([...this.attachments.flatMap(a => [...Object.values(armOf(a.hand)), ...Object.keys(this.fists[a.hand] ?? {})]), ...carriers.flatMap(h => Object.values(armOf(h)))])
  }

  /** A hand on no handle, let go (in `moved`) with its fist near a piece's shaft (not the piece it carries): that hand
   * and piece, the nearest; else null. */
  private snapTarget (moved: string[]): { hand: Side, gear: string } | null {
    const view = animator.view
    if (view === null) return null
    let best: { hand: Side, gear: string, d: number } | null = null
    for (const hand of SIDES) {
      const bone = view.bones.get(`${hand}Hand`)
      if (!moved.includes(`${hand}Hand`) || bone === undefined || this.attachments.some(a => a.hand === hand)) continue
      for (const p of this.pieces) {
        if (p.bone === `${hand}Hand`) continue
        const shaft = this.shaftOf(p.id); const grip = this.gripOf(hand, p.id)
        if (shaft === null || grip === null) continue
        const fist = grip.fist.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())).add(bone.getWorldPosition(new THREE.Vector3()))
        const length = shaft.from.distanceTo(shaft.to)
        const k = Math.max(0, Math.min(length, fist.clone().sub(shaft.from).dot(shaft.dir)))
        const d = shaft.from.clone().addScaledVector(shaft.dir, k).distanceTo(fist)
        if (d < SNAP_REACH * view.height && (best === null || d < best.d)) best = { hand, gear: p.id, d }
      }
    }
    return best === null ? null : { hand: best.hand, gear: best.gear }
  }

  /** Key `names` into `next` as they stand on the character, at `u`: the turn from where the clip has them at the time
   * shown (the playhead's, so no motion between it and the frame is baked in); a bone's first key on a clip with motion
   * of its own also pins it at the clip's ends, so the change eases in and back out. */
  private keyBones (next: Record<string, ClipKey[]>, names: Iterable<string>, u: number): void {
    const view = animator.view; const base = this.baseClip
    if (view === null || view.rest === null || base === null) return
    const rest = boneRest(view.rest)
    const shown = Math.min(Math.max(animator.time, 0), base.duration)
    for (const name of names) {
      const bone = view.bones.get(name); const r = rest(name)
      if (bone === undefined || r === null) continue
      const key = keyFor(base, bone, u, shown, r, name === this.rig.hips)
      const ks = (next[name] ?? []).filter(k => !near(k.u, u))
      if (ks.length === 0 && !this.held) {
        if (!near(u, 0)) ks.push({ u: 0, q: [...IDENTITY] })
        if (!this.loop && !near(u, 1)) ks.push({ u: 1, q: [...IDENTITY] })
      }
      next[name] = [...ks, key].sort((a, b) => a.u - b.u)
    }
  }

  /** Whether there are keys at the playhead for what is selected (a bone, a piece, or anything). */
  keysHere (): number {
    const u = this.phase()
    const bones = Object.entries(this.keys).filter(([b, ks]) => this.gear === null && (this.selected === null || this.selected === b) && ks.some(k => near(k.u, u))).length
    const gear = Object.entries(this.paths).filter(([g, x]) => this.selected === null && (this.gear === null || this.gear === g) && x.keys.some(k => near(k.u, u))).length
    return bones + gear
  }

  /** Take the keys at the playhead off: the selected bone's (and the bones keyed with it by the same drag), the selected
   * piece's, or every one's. */
  deleteHere (): void {
    if (!this.active || this.busy !== null || this.keysHere() === 0) return
    const u = this.phase()
    const all = this.selected === null && this.gear === null
    const sel = this.selected
    const with_ = new Set(sel === null ? [] : [sel, ...this.groups.filter(g => near(g.u, u) && g.bones.includes(sel)).flatMap(g => g.bones)])
    this.record()
    this.groups = this.groups.filter(g => !(near(g.u, u) && (all || g.bones.some(b => with_.has(b)))))
    const next: Record<string, ClipKey[]> = {}
    for (const [bone, ks] of Object.entries(this.keys)) {
      const keep = all || with_.has(bone) ? ks.filter(k => !near(k.u, u)) : ks
      // (only its pins left: nothing changed on this bone)
      if (keep.length > 0 && (this.held || !keep.every(isAnchor))) next[bone] = keep
    }
    this.keys = next
    const paths: Record<string, GearPath> = {}
    for (const [g, path] of Object.entries(this.paths)) {
      const keep = all || this.gear === g ? path.keys.filter(k => !near(k.u, u)) : path.keys
      paths[g] = { ...path, keys: keep.length > 0 && (this.held || !keep.every(isAnchor)) ? keep : [] }
    }
    this.paths = paths
    // (a gear drag's key gone: its hold too)
    this.holds = this.holds.filter(h => paths[h.gear]?.keys.some(k => near(k.u, h.u)) === true)
    this.show(u * (this.baseClip?.duration ?? 0))
  }

  /** Take every key off (asked first). */
  async clearAll (): Promise<void> {
    if (!this.active || !this.hasKeys) return
    const ok = await app.confirm({ title: 'Clear every key?', body: 'Every joint key and gear path key of this edit goes (Undo brings them back).', confirm: 'Clear all', danger: true })
    if (!ok || !this.active) return
    this.record()
    this.keys = {}
    this.paths = Object.fromEntries(Object.entries(this.paths).map(([g, path]) => [g, { ...path, keys: [] }]))
    this.holds = []
    this.groups = []
    this.show(animator.time)
  }

  // ---- gear: what is on stage --------------------------------------------------------------------------------------

  pieceOf (id: string): Piece | undefined { return this.pieces.find(p => p.id === id) }

  private nodeName (id: string): string {
    const p = this.pieceOf(id)
    return p === undefined ? `${id}_place` : gearNode(p.gear)
  }

  /** The pieces on stage: by gear id, their placed nodes. */
  private pieceNodes (): Map<string, THREE.Object3D> {
    const view = animator.view
    const out = new Map<string, THREE.Object3D>()
    if (view === null) return out
    for (const p of this.pieces) { const n = view.root.getObjectByName(gearNode(p.gear)); if (n !== undefined) out.set(p.id, n) }
    return out
  }

  /** Each piece's node as Gear places it on its bone (local position, turn). */
  private gearRest (): NonNullable<GearRig['rest']> {
    return Object.fromEntries(this.pieces.map(p => {
      const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
      garmentMatrix(p.place).decompose(position, quaternion, new THREE.Vector3())
      return [p.id, { position: position.toArray(), quaternion: quaternion.toArray() as Quat }]
    }))
  }

  /** A piece's handles a hand can be on: its grip handles and its carry handle once placed. */
  handlesOf (id: string): PlacedHandle[] {
    return (this.pieceOf(id)?.gear.handles ?? []).flatMap(h => (h.kind === 'pull' || h.place === undefined ? [] : [{ id: h.id, name: h.name, exact: h.exact, place: h.place }]))
  }

  /** The handles `hand` can take on a piece (one the other hand is on is taken). */
  handleChoices (hand: Side, id: string): Array<Handle & { taken: boolean }> {
    const p = this.pieceOf(id)
    if (p === undefined) return []
    return p.gear.handles.filter(h => h.place !== undefined && ((h.kind === 'grip' && (h.hand === undefined || h.hand === hand)) || (h.kind === 'carry' && h.hand === hand)))
      .map(h => ({ ...h, taken: this.attachments.some(a => a.hand !== hand && a.gear === id && a.handle === h.id) }))
  }

  /** The hand carrying a piece and its carry handle, placed: where the editor placed it, else where the piece's placement
   * on the hand puts it (from Gear's placement, so never stale). Null when no hand carries it. */
  private carrierOf (id: string): { hand: Side, handle: PlacedHandle } | null {
    const view = animator.view; const p = this.pieceOf(id)
    const side = p === undefined ? null : handSide(p.bone)
    const carry = p === undefined ? undefined : carryHandle(p.gear)
    if (view === null || p === undefined || side === null || carry === undefined) return null
    if (carry.place !== undefined) return { hand: side, handle: { id: carry.id, name: carry.name, exact: carry.exact, place: carry.place } }
    const handRest = restFrame(view, `${side}Hand`)
    return handRest === null ? null : { hand: side, handle: { id: carry.id, name: carry.name, place: carrierGrip(garmentMatrix(p.place), handRest) } }
  }

  /** Whether a hand holds a piece by its carry handle where the placement puts it (the handle not placed yet): its turn
   * is the piece's, exactly, with no grip on it. */
  private byPlacement (a: Attachment): boolean {
    const h = this.pieceOf(a.gear)?.gear.handles.find(x => x.id === a.handle)
    return h?.kind === 'carry' && h.place === undefined
  }

  /** A piece's length (its longest side through its middle) as it stands: from the end nearer the bone carrying it to
   * the far end (a spear's head), in the world. */
  private shaftOf (id: string): { from: THREE.Vector3, to: THREE.Vector3, dir: THREE.Vector3 } | null {
    const view = animator.view; const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    if (view === null || node === undefined || p === undefined) return null
    node.updateMatrixWorld(true)
    // (its long axis: the main direction of its mesh's vertices (a box round it would only find its node's axes, and a
    // piece may lie across them), from end to end of them along it, through their middle; in the node's frame)
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

  /** A piece's long axis in its own node's frame (its ends: the one by the bone carrying it first), and its radius. */
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

  /** Where `hand` holds a piece now, as a handle's place in its placed frame. `snap`: its fist put on the piece's length,
   * the hand turned so the shaft runs through the fist (across the palm, thumb towards the far end), its roll kept.
   * `exact`: where the hand is, as it is. */
  private placeAt (hand: Side, id: string, snap: boolean, exact = false): NonNullable<Handle['place']> | null {
    const view = animator.view
    const end = view?.bones.get(armOf(hand).end)
    const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    if (view === null || view.rest === null || end === undefined || node === undefined) return null
    let turn = end.getWorldQuaternion(new THREE.Quaternion())
    let wrist = end.getWorldPosition(new THREE.Vector3())
    // (exactly where the hand is: the shaft isn't measured, a drag asks this on every move)
    const shaft = exact ? null : this.shaftOf(id)
    const grip = exact ? null : this.gripOf(hand, id)
    if (shaft !== null && grip !== null) {
      // (always on the shaft: a snap turns the hand onto it; a move keeps the turn and slides the fist along it)
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

  /** A grip handle for `hand` on a piece at `place`: the one this session made for that hand there moved, else a new one. */
  private gripHandle (hand: Side, id: string, place: NonNullable<Handle['place']>): { command: Command, id: string } {
    const g = this.pieceOf(id)?.gear
    const mine = g?.handles.find(h => h.kind === 'grip' && h.hand === hand && this.made.has(`${id}/${h.id}`))
    if (mine !== undefined) return { command: { type: 'gear.handle.update', gear: id, id: mine.id, patch: { place, exact: null } }, id: mine.id }
    const hid = newId()
    this.made.add(`${id}/${hid}`)
    return { command: { type: 'gear.handle.add', gear: id, handle: { id: hid, name: gripName(hand, (g?.handles ?? []).map(h => h.name)), kind: 'grip', hand, place } }, id: hid }
  }

  /** The grip handles this session made that no hand is on any more, taken off (one a hand: no pile of old ones).
   * Handles it didn't make stay. */
  private prune (attachments: Attachment[]): Command[] {
    const out: Command[] = []
    for (const key of [...this.made]) {
      const [gid, hid] = key.split('/')
      if (attachments.some(a => a.gear === gid && a.handle === hid)) continue
      this.made.delete(key)
      if (this.pieceOf(gid)?.gear.handles.some(h => h.id === hid) === true) out.push({ type: 'gear.handle.remove', gear: gid, id: hid })
    }
    return out
  }

  /** A hand's grip (the line a shaft runs along and the point it holds it at, in the hand's own frame): from its fist
   * closed round a shaft of the piece's radius when it has one (fistGrip: the shaft across the middle of the palm), else
   * the rest hand's estimate (handGrip). Kept until the character's fist or the radius changes. */
  private gripOf (hand: Side, id?: string): Grip | null {
    const fingers = this.fists[hand]; const root = this.posable()
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

  /** A hand's width (the collider's, fitted to the mesh; else a fist's share of the height). */
  private widthOf (hand: Side): number {
    const view = animator.view
    if (view === null) return 0
    return this.collider?.handWidth(hand) ?? FIT.fist * view.height
  }

  /** How near two hands' holds may come along a shaft (metres): half of each hand's width, and a little. */
  private handGap (): number {
    const view = animator.view
    return view === null ? 0 : (this.widthOf('Left') + this.widthOf('Right')) / 2 + HAND_GAP * view.height
  }

  /** `place` (for `hand` on a piece) slid along the shaft, its turn kept, until its fist is a fist's width at least from
   * every other hand's on the piece (the one carrying it, any on a handle): to whichever side is nearer and still on it. */
  private clearOfOthers (hand: Side, id: string, place: NonNullable<Handle['place']>, attachments = this.attachments): NonNullable<Handle['place']> {
    const view = animator.view; const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    const shaft = this.shaftLocal(id); const grip = this.gripOf(hand, id)
    if (view === null || view.rest === null || node === undefined || shaft === null || grip === null) return place
    node.updateMatrixWorld(true)
    // (in the piece's node frame, its scale included; a grip's fist is in world units, in the hand's turn)
    const scale = node.matrixWorld.getMaxScaleOnAxis() || 1
    const dir = shaft.to.clone().sub(shaft.from); const length = dir.length(); dir.normalize()
    const along = (x: NonNullable<Handle['place']>, g: { fist: THREE.Vector3 }): number => new THREE.Vector3(...x.position).add(g.fist.clone().applyQuaternion(new THREE.Quaternion(...x.rotation)).divideScalar(scale)).sub(shaft.from).dot(dir)
    const rest = view.rest
    const gripFor = (h: Side): { fist: THREE.Vector3 } => this.gripOf(h, id) ?? handGrip(rest, h) ?? { fist: new THREE.Vector3() }
    const others: Array<{ hand: Side, at: number }> = []
    const carrier = this.carrierOf(id)
    if (carrier !== null && carrier.hand !== hand) others.push({ hand: carrier.hand, at: along(carrier.handle.place, gripFor(carrier.hand)) })
    const handles = this.handlesOf(id)
    for (const a of attachments) {
      if (a.gear !== id || a.hand === hand || a.handle === carrier?.handle.id) continue
      const o = handles.find(x => x.id === a.handle)
      if (o !== undefined) others.push({ hand: a.hand, at: along(o.place, gripFor(a.hand)) })
    }
    // (how far apart two fists must be along the shaft: half of each hand's width, and a little)
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

  // ---- gear: hands on handles ----------------------------------------------------------------------------------------

  /** The hands on a piece: on a handle, and the hand carrying it (it holds it as it is placed, or by its carry handle). */
  handsOn (id: string): Array<{ hand: Side, handle: string | null, carries: boolean }> {
    const bone = this.pieceOf(id)?.bone
    const out: Array<{ hand: Side, handle: string | null, carries: boolean }> = this.attachments.filter(a => a.gear === id).map(a => ({ hand: a.hand, handle: a.handle, carries: bone === `${a.hand}Hand` }))
    const side = handSide(bone ?? '')
    if (side !== null && !out.some(h => h.hand === side)) out.push({ hand: side, handle: null, carries: true })
    return out.sort((x, y) => x.hand.localeCompare(y.hand))
  }

  /** Put `hand` on a handle (its fingers closed round the piece); one handle a hand. A grip handle is slid just clear of
   * any other hand on the piece (else kept where it is); then, if the piece leads, it is fitted again (fitPath). */
  async attach (hand: Side, id: string, handle: string): Promise<void> {
    if (!this.active || this.busy !== null) return
    const turn = this.opening
    // (the fingers as that handle closes them)
    const fist = await this.fistOf(hand, id, handle)
    if (turn !== this.opening) return
    this.fists[hand] = fist
    const h = this.handlesOf(id).find(x => x.id === handle)
    const p = this.pieceOf(id)
    if (h === undefined || p === undefined) return
    this.record()
    const attachments = [...this.attachments.filter(a => a.hand !== hand), { hand, gear: id, handle }]
    if (p.bone !== `${hand}Hand`) {
      const clear = this.clearOfOthers(hand, id, h.place, attachments)
      if (clear !== h.place) this.issue([{ type: 'gear.handle.update', gear: id, id: handle, patch: { place: clear } }])
    }
    this.attachments = attachments
    this.issue(this.prune(attachments))
    if (this.paths[id]?.locked === true && this.natural) { await this.fitPath(id); return }
    this.show(animator.time)
  }

  /** Take a hand off whatever it holds (the hand carrying a piece holds it as placed again). */
  detach (hand: Side): void {
    if (!this.active || !this.attachments.some(a => a.hand === hand)) return
    this.record()
    this.attachments = this.attachments.filter(a => a.hand !== hand)
    this.issue(this.prune(this.attachments))
    this.show(animator.time)
  }

  /** Take a grip handle off the piece (and any hand off it). */
  removeHandle (id: string, handle: string): void {
    const h = this.pieceOf(id)?.gear.handles.find(x => x.id === handle)
    if (!this.active || h === undefined || h.kind !== 'grip') return
    if (this.attachments.some(a => a.gear === id && a.handle === handle)) {
      this.record()
      this.attachments = this.attachments.filter(a => !(a.gear === id && a.handle === handle))
    }
    this.made.delete(`${id}/${handle}`)
    this.issue([{ type: 'gear.handle.remove', gear: id, id: handle }])
    this.show(animator.time)
  }

  /** Hold a hand at its handle exactly (no give or slide on the shaft), or let it give. */
  setExact (id: string, handle: string, on: boolean): void {
    if (!this.active) return
    this.issue([{ type: 'gear.handle.update', gear: id, id: handle, patch: { exact: on ? true : null } }])
    this.revision++
    this.show(animator.time)
  }

  // ---- hands: poses and windows ----------------------------------------------------------------------------------

  /** The handle `hand` holds piece `id` by in the edit: the one it is on, else (carrying it) its carry handle. */
  private handleOn (hand: Side, id: string): string | undefined {
    const on = this.attachments.find(a => a.hand === hand && a.gear === id)
    if (on !== undefined) return on.handle
    const p = this.pieceOf(id)
    return p !== undefined && p.bone === `${hand}Hand` ? carryHandle(p.gear)?.id : undefined
  }

  /** Which setting decides the pose a hand closes to on piece `id` (clipedit.ts handPoseSource, by the one resolver):
   * one of the slot's own hand poses, the handle it holds the piece by, or hands.hold; null: none is set. */
  private poseSource (hand: Side, id: string): HandPoseSource | null {
    const c = this.character
    return c === null ? null : handPoseSource(c, this.slot, hand, id, this.handleOn(hand, id) ?? '')
  }

  /** What a hand's pose picker shows on piece `id`: the pose the hand closes to on it (fistRef), so the two agree. */
  handPoseOf (hand: Side, id: string): HandPoseRef | undefined {
    if (this.character === null || this.pieceOf(id) === undefined) return undefined
    return this.fistRef(hand, id)
  }

  /** Whether a setting decides a hand's pose on piece `id` (its picker can then clear it, and the one under it decides). */
  handPoseSet (hand: Side, id: string): boolean { return this.poseSource(hand, id) !== null }

  /** Where a hand's pose on piece `id` is set from its picker (poseSource; nothing set yet: where setHandPose puts it),
   * in words. */
  handPoseHint (hand: Side, id: string): string {
    const src = this.poseSource(hand, id); const slot = this.slot
    if (src?.kind === 'slot') return `Its pose in ${slot?.name ?? 'this slot'} (the slot’s own)`
    if (src?.kind === 'hold') return 'Its pose in every clip, whatever it holds'
    const handle = src?.kind === 'handle' ? src.handle : this.pieceOf(id)?.gear.handles.find(h => h.id === this.handleOn(hand, id))
    if (handle?.kind === 'carry') return 'Its pose carrying it, in every clip (the carry handle’s)'
    if (src?.kind === 'handle') return 'Its pose on this grip, in every clip (the grip handle’s)'
    return slot !== null ? `Its pose in ${slot.name}` : 'Its pose in every clip'
  }

  /** Whether the hand carries the piece. */
  carries (hand: Side, id: string): boolean { return this.pieceOf(id)?.bone === `${hand}Hand` }

  /** Set a hand's pose on piece `id` where it is decided now (poseSource), so the hand closes to it; unset clears that
   * setting. Nothing set yet: the carry handle when the hand holds the piece by it, else the slot's own pose for the hand
   * over the whole clip, else the hand's hold in every clip. The clip is built again with it. */
  setHandPose (hand: Side, id: string, ref: HandPoseRef | undefined): void {
    const p = this.pieceOf(id); const slot = this.slot
    if (!this.active || p === undefined) return
    const src = this.poseSource(hand, id)
    const commands: Command[] = []
    if (src?.kind === 'slot' && slot !== null) {
      commands.push(ref === undefined ? { type: 'slot.adjust.remove', slot: slot.id, id: src.adjustment } : { type: 'slot.adjust.update', slot: slot.id, id: src.adjustment, patch: { pose: ref } })
    } else if (src?.kind === 'handle') {
      commands.push({ type: 'gear.handle.update', gear: id, id: src.handle.id, patch: { pose: ref ?? null } })
    } else if (src?.kind === 'hold') {
      commands.push({ type: 'hands.hold', side: hand, pose: ref ?? null })
    } else if (ref !== undefined) {
      const carry = carryHandle(p.gear)
      if (carry !== undefined && carry.id === this.handleOn(hand, id)) commands.push({ type: 'gear.handle.update', gear: id, id: carry.id, patch: { pose: ref } })
      else if (slot !== null) commands.push({ type: 'slot.adjust.add', slot: slot.id, adjustment: { id: newId(), kind: 'handPose', enabled: true, hand, pose: ref } })
      else commands.push({ type: 'hands.hold', side: hand, pose: ref })
    }
    if (commands.length === 0) return
    this.issue(commands)
    void this.rebuild()
  }

  /** Where in this slot the hand carrying piece `id` opens (its handPose 'clip' adjustment for that gear). */
  openWindows (id: string): Window[] {
    return windowsToPlayed(this.played, this.openOf(id)?.windows ?? [])
  }

  private openOf (id: string): Extract<Adjustment, { kind: 'handPose' }> | undefined {
    return this.slot?.adjustments.find((a): a is Extract<Adjustment, { kind: 'handPose' }> => a.kind === 'handPose' && a.gear === id && a.pose === 'clip')
  }

  setOpen (id: string, windows: Window[]): void {
    const slot = this.slot; const p = this.pieceOf(id)
    const hand = p === undefined ? null : handSide(p.bone)
    if (!this.active || !this.windowsEditable || slot === null || hand === null) return
    windows = windowsToSource(this.played, windows)
    const was = this.openOf(id)
    if (windows.length === 0) { if (was !== undefined) this.issue([{ type: 'slot.adjust.remove', slot: slot.id, id: was.id }]) }
    else if (was !== undefined) this.issue([{ type: 'slot.adjust.update', slot: slot.id, id: was.id, patch: { windows } }])
    else this.issue([{ type: 'slot.adjust.add', slot: slot.id, adjustment: { id: newId(), kind: 'handPose', enabled: true, hand, pose: 'clip', windows, gear: id } }])
    void this.rebuild()
  }

  /** A piece's pull handles (a bowstring's Draw). */
  pullsOn (id: string): Handle[] {
    return (this.pieceOf(id)?.gear.handles ?? []).filter(h => h.kind === 'pull')
  }

  /** Where in this slot a pull is held (its handleHold adjustment). */
  pullHolds (id: string, handle: string): Window[] {
    return windowsToPlayed(this.played, this.holdOf(id, handle)?.windows ?? [])
  }

  private holdOf (id: string, handle: string): Extract<Adjustment, { kind: 'handleHold' }> | undefined {
    return this.slot?.adjustments.find((a): a is Extract<Adjustment, { kind: 'handleHold' }> => a.kind === 'handleHold' && a.gear === id && a.handle === handle)
  }

  setPullHolds (id: string, handle: string, windows: Window[]): void {
    const slot = this.slot
    if (!this.active || !this.windowsEditable || slot === null) return
    windows = windowsToSource(this.played, windows)
    const was = this.holdOf(id, handle)
    if (windows.length === 0) { if (was !== undefined) this.issue([{ type: 'slot.adjust.remove', slot: slot.id, id: was.id }]) }
    else if (was !== undefined) this.issue([{ type: 'slot.adjust.update', slot: slot.id, id: was.id, patch: { windows } }])
    else this.issue([{ type: 'slot.adjust.add', slot: slot.id, adjustment: { id: newId(), kind: 'handleHold', enabled: true, gear: id, handle, windows } }])
    void this.rebuild()
  }

  /** A pull's hand pose while it is held (every clip). */
  setPullPose (id: string, handle: string, ref: HandPoseRef | undefined): void {
    if (!this.active) return
    this.issue([{ type: 'gear.handle.update', gear: id, id: handle, patch: { pose: ref ?? null } }])
    void this.rebuild()
  }

  /** The pose a hand on piece `id` closes to in the edit: the one hand resolver's for the handle it holds the piece by
   * (hands.ts handleRef: the slot's own pose for the hand over the whole clip, a grip's pose, hands.hold, the carry
   * handle's pose, else the default fist). `handle` unset: the one it is on, or carrying the piece its carry handle; a
   * grip not made yet has no pose of its own. 'clip' leaves the hand as the clip has it (no fist laid on). */
  private fistRef (hand: Side, id: string, handle?: string): HandPoseRef {
    const c = this.character
    if (c === null) return 'default'
    return handleRef(c, this.slot, hand, id, handle ?? this.handleOn(hand, id) ?? '')
  }

  /** Each hand on a handle's fingers as fistRef closes them now. */
  private async closeHands (): Promise<Partial<Record<Side, Record<string, Quat>>>> {
    const out: Partial<Record<Side, Record<string, Quat>>> = {}
    for (const a of this.attachments) out[a.hand] = await this.fistOf(a.hand, a.gear, a.handle)
    return out
  }

  /** A hand's fingers as fistRef closes them, on the posable copy (local turns by bone); none when it can't be had. */
  private async fistOf (hand: Side, id: string, handle?: string): Promise<Record<string, Quat>> {
    const c = this.character; const root = this.posable(); const clips = animator.clipSource
    if (c === null || root === null || clips === null) return {}
    try {
      const shared = $state.snapshot(app.settings?.handPoses ?? []) as HandPose[]
      const turns = await poseOfRef(root, hand, this.fistRef(hand, id, handle), c, clips, shared)
      return turns === 'clip' ? {} : Object.fromEntries([...turns].map(([n, q]) => [n, q.toArray() as Quat]))
    } catch {
      return {}
    }
  }

  // ---- gear: leading, moving ---------------------------------------------------------------------------------------

  /** Make a piece lead (the hands on it follow its path, the body the hands), or ride its bone again. Switched on, it
   * is fitted to the body once over the whole clip (fitPath: it moves, as little as it needs, to where the body holds it
   * with room to spare). */
  async setLocked (id: string, on: boolean): Promise<void> {
    const p = this.pieceOf(id)
    if (!this.active || this.busy !== null || p === undefined || (on && !this.natural)) return
    const was = this.paths[id]
    // (a path's keys mean moves in the world while it leads and moves in the hand while it doesn't: they don't carry
    // over (Undo brings them back))
    const keys = was === undefined || was.locked === on ? was?.keys ?? [] : []
    if (was !== undefined && was.keys.length > 0 && keys.length === 0) app.toast('info', `${p.name}'s path keys were made ${was.locked ? 'leading' : 'in the hand'}: they go (Undo brings them back)`)
    this.record()
    this.paths = { ...this.paths, [id]: { locked: on, keys } }
    if (on && this.natural) { await this.fitPath(id); return }
    this.show(animator.time)
  }

  /** What the fit reads: the edit as it stands with the piece leading (the hand carrying it on a handle). */
  private fitInput (id: string): Parameters<typeof fitProp>[0] | null {
    const view = animator.view; const base = this.baseClip; const root = this.posable()
    if (view === null || view.rest === null || base === null || root === null || this.base === null || this.solver === null) return null
    return {
      base, keys: this.keys, loop: this.loop, rest: boneRest(view.rest), posable: root, rig: this.rig, limits: this.limitsOn ? this.limits : null,
      gearRig: this.gearRig({ ...this.paths, [id]: { locked: true, keys: this.paths[id]?.keys ?? [] } }), gear: id, height: view.height, solver: this.solver,
      collider: colliderFor(root, bonesOf(root), view.height),
    }
  }

  /** The range limiter: one pass over the whole clip that moves the piece (a smooth offset on its path, as little as it
   * needs, its motion kept) to where every hand on it holds it within the joints' ranges, naturally, with the body clear
   * of itself and the piece, and room to spare in the arms: the spear held farther out, say. Writes the piece's path
   * keys (locked: the user can edit them after, a drag let go is the authority). Callers record the edit first. */
  private async fitPath (id: string): Promise<FitResult | null> {
    const p = this.pieceOf(id)
    if (p === undefined) return null
    const mark = { locked: true, keys: this.paths[id]?.keys ?? [] }
    this.paths = { ...this.paths, [id]: mark }
    // (the fit is dropped if, by the time it's done, this edit was left or the piece's path changed under it)
    const turn = this.opening
    const stale = (): boolean => turn !== this.opening || this.paths[id] !== mark
    this.busy = `Fitting ${p.name} to the body`
    await new Promise(resolve => setTimeout(resolve, 30))
    let result: FitResult | null = null
    try {
      const input = stale() ? null : this.fitInput(id)
      if (input !== null) {
        result = await fitProp(input, label => { if (!stale()) this.busy = label })
        if (stale()) result = null
        else this.paths = { ...this.paths, [id]: { locked: true, keys: result.keys } }
      }
    } catch (error) {
      if (!stale()) app.toast('error', `The fit of ${p.name} failed: ${reason(error)}`)
    } finally {
      if (turn === this.opening) this.busy = null
    }
    if (turn !== this.opening) return null
    this.show(animator.time)
    if (result !== null) app.toast('ok', `Fitted ${p.name}: moved up to ${(result.maxMove * 100).toFixed(1)} cm on ${result.moved} frames, ${result.keys.length} keys, ${(result.ms / 1000).toFixed(1)} s`)
    return result
  }

  /** Where a piece rode at time `t` in the clip as it was (before the edit). */
  private rodeAt (id: string, t: number): THREE.Matrix4 | null {
    const root = this.posable(); const base = this.baseClip
    if (root === null || base === null) return null
    const node = root.getObjectByName(this.nodeName(id))
    if (node === undefined) return null
    const mixer = new THREE.AnimationMixer(root)
    const action = mixer.clipAction(base)
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true
    action.play()
    mixer.setTime(Math.min(t, base.duration))
    root.updateMatrixWorld(true)
    const m = node.matrixWorld.clone()
    mixer.stopAllAction(); mixer.uncacheRoot(root)
    return m
  }

  /** A piece moved or turned by the gizmo, let go at `place` (world): a key on its path at the playhead (and it leads;
   * without the pose model it moves in the hand). */
  private commitGear (id: string, place: THREE.Matrix4): void {
    if (this.inHand || !this.natural) { this.commitInHand(id, place); return }
    if (this.moves === 'every') { this.offsetGear(id, place); return }
    const base = this.baseClip
    if (base === null) return
    const u = this.phase(); const t = u * base.duration
    const was = this.rodeAt(id, t)
    if (was === null) return
    const a = new THREE.Vector3(); const qa = new THREE.Quaternion(); const b = new THREE.Vector3(); const qb = new THREE.Quaternion(); const sc = new THREE.Vector3()
    was.decompose(a, qa, sc); place.decompose(b, qb, sc)
    const key: ClipKey = { u, q: qb.multiply(qa.invert()).normalize().toArray().map(r6) as Quat, p: r5(b.sub(a).toArray()) as Vec3 }
    // (keys of a move in the hand mean something else: leading starts its path afresh)
    const before = this.paths[id]?.locked === true ? this.paths[id] : undefined
    let ks = (before?.keys ?? []).filter(k => !near(k.u, u))
    if (ks.length === 0 && !this.held) {
      if (!near(u, 0)) ks.push({ u: 0, q: [...IDENTITY], p: [0, 0, 0] })
      if (!this.loop && !near(u, 1)) ks.push({ u: 1, q: [...IDENTITY], p: [0, 0, 0] })
    }
    ks = [...ks, key].sort((x, y) => x.u - y.u)
    const after: GearPath = { locked: true, keys: ks }
    this.record()
    // (the body's root held where it was seen, on the frames the drag moved the piece: moving it away doesn't bring the body in)
    this.holdRoot(id, u, before, after)
    // (moving a piece makes it lead)
    this.paths = { ...this.paths, [id]: after }
    this.show(t)
  }

  /** A piece moved in the hand by its gizmo (let go at `place`, world): the move and turn in its own placed frame from
   * where it sat as the drag began. This frame: a key of its move in the hand in this clip (tweened between keys: a bow
   * let go of on a death). Every frame: how it sits on its bone, its placement, in every clip (a command). */
  private commitInHand (id: string, place: THREE.Matrix4): void {
    const view = animator.view; const base = this.baseClip; const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    const from = this.dragFrom.get(id)
    if (view === null || base === null || p === undefined || node === undefined || node.parent === null || from === undefined) return
    const u = this.phase(); const t = u * base.duration
    const path = this.paths[id]
    if (path?.locked === true) {
      app.toast('info', `${p.name} leads in this clip: turn off “Leads the body” to move it in the hand`)
      this.show(t)
      return
    }
    node.parent.updateMatrixWorld(true)
    const target = node.parent.matrixWorld.clone().invert().multiply(place)
    // (the move, in the piece's own frame: from where it sat to where it was let go)
    const delta = from.clone().invert().multiply(target)
    const dp = new THREE.Vector3(); const dq = new THREE.Quaternion(); delta.decompose(dp, dq, new THREE.Vector3())
    if (this.moves === 'every') {
      // its placement P such that, here, it sits where it was let go (P' = M Δ M⁻¹ P, M where it sat)
      const change = from.clone().multiply(new THREE.Matrix4().compose(dp, dq, new THREE.Vector3(1, 1, 1))).multiply(from.clone().invert())
      const next = placementFromMatrix(change.clone().multiply(garmentMatrix(p.place)))
      const commands: Command[] = [{ type: 'gear.place', id, place: { ...next, scale: p.place.scale } }]
      // (a carry handle placed for leading was where the hand held it on the old placement: it follows the placement again)
      const carry = carryHandle(p.gear)
      if (carry?.place !== undefined) commands.push({ type: 'gear.handle.update', gear: id, id: carry.id, patch: { place: null, exact: null } })
      this.issue(commands)
      this.revision++
      app.toast('ok', `${p.name} now sits this way on ${p.bone} in every clip`)
      if (this.held) { this.baseClip = rebaseNode(base, gearNode(p.gear), change); this.show(t) } else void this.rebuild()
      return
    }
    // this frame: its move in the hand keyed here (on top of what this clip already moves it), tweened between keys
    const keys = path?.keys ?? []
    const now = keys.length > 0 ? sampleKeys(keys, u, this.loop) : { q: new THREE.Quaternion(), p: new THREE.Vector3() }
    const total = new THREE.Matrix4().compose(now.p, now.q, new THREE.Vector3(1, 1, 1)).multiply(new THREE.Matrix4().compose(dp, dq, new THREE.Vector3(1, 1, 1)))
    const kp = new THREE.Vector3(); const kq = new THREE.Quaternion(); total.decompose(kp, kq, new THREE.Vector3())
    const key: ClipKey = { u, q: kq.toArray().map(r6) as Quat, p: kp.toArray().map(r6) as Vec3 }
    let ks = keys.filter(k => !near(k.u, u))
    if (ks.length === 0 && !this.held) {
      if (!near(u, 0)) ks.push({ u: 0, q: [...IDENTITY], p: [0, 0, 0] })
      if (!this.loop && !near(u, 1)) ks.push({ u: 1, q: [...IDENTITY], p: [0, 0, 0] })
    }
    ks = [...ks, key].sort((x, y) => x.u - y.u)
    this.record()
    this.paths = { ...this.paths, [id]: { locked: false, keys: ks } }
    this.show(t)
  }

  /** A piece moved or turned by its gizmo with "every frame" on, let go at `place`: its whole path moved and turned by
   * that, on every frame (about the piece's own place there), and it leads. */
  private offsetGear (id: string, place: THREE.Matrix4): void {
    const base = this.baseClip
    if (base === null) return
    const u = this.phase(); const t = u * base.duration
    const was = this.rodeAt(id, t)
    if (was === null) return
    const path = this.paths[id] ?? { locked: true, keys: [] }
    // (a path that moved it in the hand keyed another way: it starts again from where it rides)
    const keys = path.locked ? path.keys : []
    const now = onPath(was, { locked: true, keys }, u, this.loop)
    const a = new THREE.Vector3(); const qa = new THREE.Quaternion(); const b = new THREE.Vector3(); const qb = new THREE.Quaternion(); const sc = new THREE.Vector3()
    now.decompose(a, qa, sc); place.decompose(b, qb, sc)
    const dp = b.sub(a); const dq = qb.multiply(qa.invert()).normalize()
    // (no path yet: one key, which a path holds on every frame)
    const ks: ClipKey[] = keys.length > 0 ? keys : [{ u: 0, q: [...IDENTITY], p: [0, 0, 0] }]
    const moved = ks.map(k => ({
      ...k,
      q: dq.clone().multiply(new THREE.Quaternion(...k.q)).normalize().toArray().map(r6) as Quat,
      p: r5(new THREE.Vector3(...(k.p ?? [0, 0, 0])).add(dp).toArray()) as Vec3,
    }))
    this.record()
    this.paths = { ...this.paths, [id]: { locked: true, keys: moved } }
    this.show(t)
  }

  /** A gear drag let go at `u` (its path `before` and `after`): on each frame the drag moved the piece, how much of it
   * the frame carries, and the solve's correction to the body's root there as it was (before the drag): the build
   * holds the root to it softly (src/engine/clipedit.ts RootHold). A second drag of the same key keeps the first's. */
  private holdRoot (id: string, u: number, before: GearPath | undefined, after: GearPath): void {
    const view = animator.view; const base = this.baseClip; const root = this.posable(); const edited = this.edited
    const shaft = this.shaftLocal(id)
    if (view === null || view.rest === null || base === null || root === null || edited === null || shaft === null) return
    const rode = nodePath(base, root, this.nodeName(id))
    const times = frameTimes(base.duration)
    if (rode.length !== times.length) return
    const ends = [shaft.from, shaft.to]
    const moveAt = (i: number): number => {
      const ui = base.duration > 0 ? times[i] / base.duration : 0
      const a = onPath(rode[i], before ?? { locked: true, keys: [] }, ui, this.loop); const b = onPath(rode[i], after, ui, this.loop)
      return Math.max(...ends.map(e => e.clone().applyMatrix4(a).distanceTo(e.clone().applyMatrix4(b))))
    }
    const at = Math.round(u * (times.length - 1))
    const full = moveAt(at)
    if (!(full > 1e-3)) return
    const had = this.holds.find(h => h.gear === id && near(h.u, u))
    const keyed = rootPath(applyBoneKeys(base, this.keys, this.loop, boneRest(view.rest)), root, this.rig.hips)
    const solved = rootPath(edited, root, this.rig.hips)
    const frames: RootHold['frames'] = {}
    for (let i = 0; i < times.length; i++) {
      const w = Math.min(1, moveAt(i) / full)
      const was = had?.frames[i]
      if (was !== undefined) { frames[i] = { ...was, w: Math.max(was.w, w) }; continue }
      if (w < 0.05 || keyed[i] === undefined || solved[i] === undefined) continue
      frames[i] = {
        w: Math.round(w * 1000) / 1000,
        hips: solved[i].hips.clone().sub(keyed[i].hips).toArray().map(r6) as Vec3,
        chest: solved[i].chest.clone().multiply(keyed[i].chest.clone().invert()).normalize().toArray().map(r6) as Quat,
      }
    }
    this.holds = [...this.holds.filter(h => h !== had), { gear: id, u, frames }]
  }

  /** While a piece is dragged: the hands on it follow it by IK (the hand carrying it first, so it goes where it's
   * dragged); the body stays as it is until it is solved (solveBody). */
  private gearLive (id: string, place: THREE.Matrix4): void {
    const view = animator.view; const p = this.pieceOf(id)
    const node = p === undefined ? undefined : view?.root.getObjectByName(gearNode(p.gear))
    if (view === null || p === undefined || node === undefined) return
    const side = handSide(p.bone)
    if (this.inHand || !this.natural) {
      // (in the hand: it moves, whatever holds it stays; other hands on it follow)
      if (node.parent === null) return
      node.parent.updateMatrixWorld(true)
      node.parent.matrixWorld.clone().invert().multiply(place).decompose(node.position, node.quaternion, node.scale)
      node.updateMatrixWorld(true)
      this.handsLive(null)
      return
    }
    const nameOf = (b: THREE.Bone): string => b.name
    const limits = this.limitsOn ? this.limits ?? undefined : undefined
    // the carrying hand moved so that the piece lands on `place` (it rides the hand rigidly)
    if (side !== null) {
      const hand = view.bones.get(`${side}Hand`); const upper = view.bones.get(`${side}Arm`); const lower = view.bones.get(`${side}ForeArm`)
      if (hand !== undefined && upper !== undefined && lower !== undefined) {
        node.updateMatrixWorld(true)
        const rel = hand.matrixWorld.clone().invert().multiply(node.matrixWorld)
        const want = place.clone().multiply(rel.invert())
        const at = new THREE.Vector3(); const q = new THREE.Quaternion(); want.decompose(at, q, new THREE.Vector3())
        reach({ upper, lower, end: hand }, at, { limits, nameOf, keepEnd: false })
        setWorldQuaternion(hand, q)
      }
    }
    this.handsLive(side === null ? null : `${side}Hand`)
  }

  /** Each leading piece's place (world) as it stands now. */
  private leadingPlaces (): Map<string, THREE.Matrix4> {
    const view = animator.view
    const out = new Map<string, THREE.Matrix4>()
    for (const [id, path] of Object.entries(this.paths)) {
      const node = path.locked ? view?.root.getObjectByName(this.nodeName(id)) : undefined
      if (node !== undefined) { node.updateMatrixWorld(true); out.set(id, node.matrixWorld.clone()) }
    }
    return out
  }

  /** While a joint is dragged: each leading piece kept where it was when the drag began (it leads: the hand carrying it
   * moves on it, not it with the hand). */
  private keepLeading (): void {
    const view = animator.view
    for (const [id, place] of this.dragPlaces) {
      const node = view?.root.getObjectByName(this.nodeName(id))
      if (node === undefined || node.parent === null) continue
      node.parent.updateMatrixWorld(true)
      const local = node.parent.matrixWorld.clone().invert().multiply(place)
      local.decompose(node.position, node.quaternion, new THREE.Vector3())
      node.updateMatrixWorld(true)
    }
  }

  /** The hands on handles put back on their pieces by IK, as the body stands (while a joint or a piece is dragged): but
   * the one being moved. In turn: a piece may ride a hand put back before it. */
  private handsLive (moving: string | null): void {
    const view = animator.view
    if (view === null) return
    const opts = { limits: this.limitsOn ? this.limits : null, nameOf: (b: THREE.Bone): string => b.name }
    for (const a of this.attachments) {
      if (armOf(a.hand).end === moving) continue
      const node = view.root.getObjectByName(this.nodeName(a.gear))
      const h = this.handlesOf(a.gear).find(x => x.id === a.handle)
      if (node === undefined || h === undefined) continue
      node.updateMatrixWorld(true)
      reachGoals(view.bones, [{ hand: a.hand, ...handOn(node.matrixWorld, h), fingers: this.fists[a.hand] }], opts)
    }
  }

  // ---- the body solved, when asked -----------------------------------------------------------------------------------

  /**
   * Solve the body on the frame shown, when asked (never while a drag lasts: the designer, 2026-10-28, "the solver needs
   * to run when you ask it to"). Each arm inside another body part is first pushed straight out of it, a little at a
   * time (src/engine/pushclear.ts); then, where hands hold gear, the body is solved to them from there (the natural-pose
   * solver, with the goals the frame's hands and gear give: clipedit.ts frameSolve), unless that leaves a body part
   * deeper in another than the push did; whatever is still in is pushed out again. Every bone it moved is keyed on this
   * frame (an arm on a handle too: the build's IK starts from it, so its elbow stays where the solve put it).
   */
  async solveBody (): Promise<void> {
    if (!this.active || this.busy !== null || this.collider === null) return
    const turn = this.opening
    this.busy = 'Solving the body'
    try {
      // (the spinner shown before the solve holds the page)
      await new Promise(resolve => setTimeout(resolve, 0))
      const view = animator.view; const base = this.baseClip; const collider = this.collider
      if (turn !== this.opening || view === null || view.rest === null || base === null || collider === null) return
      if (collider.body === null) { app.toast('error', `The body can't be solved: ${collider.problem ?? 'its mesh has no body to fit'}`); return }
      const u = this.phase(); const t = u * base.duration
      // (the frame as shown)
      animator.seek(animator.time)
      const all = [...view.bones.keys()]
      const before = this.poseOf(all)
      const nameOf = (b: THREE.Bone): string => b.name
      const limits = this.limitsOn ? this.limits : null
      const heldBones = this.heldBones()
      const held = new Set(SIDES.filter(h => heldBones.has(`${h}Hand`)))
      const push = (): number => pushClear(view.bones, collider, { height: view.height, limits, nameOf, held }).worst
      const deep = (): number => collider.selfPenetration().worst
      const was = deep()
      let left = push()
      if (this.solver !== null && this.attachments.length + held.size > 0) {
        const pushed = this.poseOf(all)
        const rest = view.rest
        const legs = legsOf(view.bones, this.rig)
        const soles = legs.map(l => [l.end, l.ball, l.tip].map(b => (b === null ? -Infinity : rest.bones.get(b.name)?.worldPosition.y ?? -Infinity)))
        const frames = frameTimes(base.duration).length
        // (the leading pieces stay where they are shown: the hands go to them)
        this.dragPlaces = this.leadingPlaces()
        const { goals, opts } = frameSolve(view.root, view.bones, this.gearRig(), { u, i: frameAt(u, frames), loop: this.loop, places: this.dragPlaces, letGo: true },
          { hips: this.rig.hips, legs, soles, floor: 0, height: view.height, limits })
        if (goals.length > 0) {
          this.solver(view.bones, goals, opts, null)
          this.keepLeading()
          // (the solve put a body part deeper in another than the push left it: the push's pose, the hands back on their handles)
          if (deep() > left + 1e-3) { this.putPose(pushed, all); this.keepLeading(); this.handsLive(null) }
          left = push()
        }
      }
      // (a held hand's fingers are its handle's fist in every build: not keyed)
      const changed = all.filter(n => !(heldBones.has(n) && !/^(Left|Right)(Arm|ForeArm|Hand)$/.test(n))).filter(n => {
        const b = view.bones.get(n); const w = before.get(n)
        // (over a tenth of a degree: angleTo of two turns the same reads ~1e-4 from rounding alone)
        return b !== undefined && w !== undefined && (b.quaternion.angleTo(w.q) > 2e-3 || (n === this.rig.hips && b.position.distanceTo(w.p) > 1e-4))
      })
      if (changed.length === 0) {
        this.show(t)
        app.toast('info', was > 1e-4 ? `Nothing could be moved out: ${cm(was)} still inside` : 'Nothing to solve: no part of the body is in another')
        return
      }
      const next = { ...this.keys }
      this.keyBones(next, changed, u)
      this.record()
      this.groups = [...this.groups.filter(g => !(near(g.u, u) && g.bones.some(b => changed.includes(b)))), { u, bones: changed }]
      this.keys = next
      this.show(t)
      app.toast(left > 1e-4 ? 'info' : 'ok', `Solved: ${changed.length} ${changed.length === 1 ? 'joint' : 'joints'} keyed on this frame${left > 1e-4 ? `, ${cm(left)} still inside` : ''}`)
    } finally {
      if (turn === this.opening) this.busy = null
    }
  }

  /** The bones `names` on stage as they stand (local turns; the hips' place too). */
  private poseOf (names: readonly string[]): Map<string, { q: THREE.Quaternion, p: THREE.Vector3 }> {
    const out = new Map<string, { q: THREE.Quaternion, p: THREE.Vector3 }>()
    const bones = animator.view?.bones
    for (const n of names) { const b = bones?.get(n); if (b !== undefined) out.set(n, { q: b.quaternion.clone(), p: b.position.clone() }) }
    return out
  }

  /** The bones `names` on stage put to `pose` (local turns; the hips' place too). */
  private putPose (pose: Map<string, { q: THREE.Quaternion, p: THREE.Vector3 }>, names: readonly string[]): void {
    const view = animator.view
    if (view === null) return
    for (const n of names) { const b = view.bones.get(n); const v = pose.get(n); if (b !== undefined && v !== undefined) b.quaternion.copy(v.q) }
    const hips = view.bones.get(this.rig.hips); const h = pose.get(this.rig.hips)
    if (hips !== undefined && h !== undefined) hips.position.copy(h.p)
    view.root.updateMatrixWorld(true)
  }

  /** A hand on a handle (not the hand a piece rides), or the hand carrying a leading piece: where its fist holds the piece
   * and the piece's long axis there (world): its gizmo slides it along the piece and rolls it round it, and letting go
   * moves its handle (every frame). */
  private gripHold (bone: string): { at: THREE.Vector3, axis: THREE.Vector3, turn: THREE.Quaternion } | null {
    const hand = /^(Left|Right)Hand$/.exec(bone)?.[1] as Side | undefined
    const a = hand === undefined ? undefined : this.attachments.find(x => x.hand === hand)
    const id = a?.gear ?? this.pieces.find(x => x.bone === bone && this.paths[x.id]?.locked === true)?.id
    const view = animator.view; const b = view?.bones.get(bone)
    if (hand === undefined || id === undefined || b === undefined) return null
    const node = view?.root.getObjectByName(this.nodeName(id))
    const local = this.shaftLocal(id)
    const grip = this.gripOf(hand, id)
    if (node === undefined || local === null || grip === null) return null
    node.updateMatrixWorld(true)
    const axis = local.to.clone().applyMatrix4(node.matrixWorld).sub(local.from.clone().applyMatrix4(node.matrixWorld)).normalize()
    const at = grip.fist.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion())).add(b.getWorldPosition(new THREE.Vector3()))
    // (the gizmo's axes: red along the piece, green up across it, blue sideways: dragging red slides the hand along it)
    const up = new THREE.Vector3(0, 1, 0)
    const across = up.clone().addScaledVector(axis, -up.dot(axis))
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0).addScaledVector(axis, -axis.x)
    across.normalize()
    const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(axis, across, new THREE.Vector3().crossVectors(axis, across)))
    return { at, axis, turn }
  }

  /** What the gear does in the edit (for the clip's build). */
  private gearRig (paths: Record<string, GearPath> = this.paths): GearRig {
    const handles: Record<string, PlacedHandle[]> = Object.fromEntries(this.pieces.map(p => [p.id, this.handlesOf(p.id)]))
    const attachments = [...this.attachments]
    // (a piece that leads: the hand carrying it holds it by its carry handle, unless that hand is on another handle)
    for (const [id, path] of Object.entries(paths)) {
      if (!path.locked) continue
      const c = this.carrierOf(id)
      if (c === null || attachments.some(a => a.hand === c.hand)) continue
      if (!(handles[id] ?? []).some(h => h.id === c.handle.id)) handles[id] = [...(handles[id] ?? []), c.handle]
      attachments.push({ hand: c.hand, gear: id, handle: c.handle.id })
    }
    // (each leading piece's shaft: the body is kept clear of it, but where the hands hold it)
    const shafts: NonNullable<GearRig['shafts']> = {}
    for (const [id, path] of Object.entries(paths)) {
      const shaft = path.locked ? this.shaftLocal(id) : null
      if (shaft !== null) shafts[id] = { from: shaft.from.toArray(), to: shaft.to.toArray(), radius: shaft.radius, gap: this.handGap(), most: SLIDE.most * (animator.view?.height ?? 1) }
    }
    // (where each hand on a handle holds the shaft: the carrying hand held by its placement has none, its turn is exact)
    const grips: NonNullable<GearRig['grips']> = {}
    for (const a of attachments) {
      if (this.byPlacement(a)) continue
      const grip = this.gripOf(a.hand, a.gear)
      if (grip !== null) grips[a.hand] = grip
    }
    return {
      node: id => this.nodeName(id), paths, attachments, handles, carriers: Object.fromEntries(this.pieces.map(p => [p.id, p.bone])), fingers: this.fists,
      shafts, grips, holds: this.holds, rest: this.gearRest(),
    }
  }

  // ---- naturalize ------------------------------------------------------------------------------------------------------

  /** Naturalize the edit: every frame edged toward how people's bodies move (the part of each pose people don't make
   * pulled out, the whole a little toward the library's poses) and the motion smoothed (jerks pulled to the middle of
   * their neighbours), the hands kept on their handles, keyed bones held near their keys, the feet free to pivot or
   * slide (never under the floor). Shown and saved until the next change; each press goes a little further. */
  async naturalize (amount: { pull: number, outside: number, motion: number } = NATURALIZE): Promise<void> {
    if (this.busy !== null || !this.active) return
    const view = animator.view; const posable = this.posable(); const root = posable === null ? null : cloneSkinned(posable)
    const c = this.character
    if (view === null || view.rest === null || root === null || c === null || this.model === null || this.edited === null) { app.toast('error', 'Naturalize works on a person (the library\'s pose model)'); return }
    this.busy = 'Naturalizing every frame'
    this.naturalizing = true
    this.naturalizeCancelled = false
    const run = ++this.naturalizeRun
    const turn = this.opening; const was = this.edited
    await new Promise(resolve => setTimeout(resolve, 30))
    // (left, or rebuilt, in the moment before it starts: nothing to naturalize)
    if (turn !== this.opening || was !== this.edited) { if (run === this.naturalizeRun) this.naturalizing = false; if (turn === this.opening) this.busy = null; return }
    try {
      const bones = bonesOf(root)
      const rig = new NaturalRig(this.model, bones, { offsets: this.offsets, limits: this.limitsOn ? this.limits : null, nameOf: b => b.name })
      // (the hands on gear: on a handle, or carrying a piece that leads; a piece rides the hand carrying it, so it is held too)
      const gearRig = this.gearRig()
      const hands = new Set(gearRig.attachments.map(a => a.hand))
      // (a piece that doesn't lead rides its carrier: holding only the other hand in the world would let it move out of it)
      for (const a of gearRig.attachments) {
        if (gearRig.paths[a.gear]?.locked === true) continue
        const carrier = handSide(gearRig.carriers[a.gear] ?? '')
        if (carrier !== null) hands.add(carrier)
      }
      const attachedHands = [...hands].map(h => `${h}Hand`)
      const held = new Set([...hands].flatMap(h => Object.values(armOf(h))))
      const keyed = Object.keys(this.keys).filter(b => !held.has(b) && bones.has(b))
      // (a keyed bone is pulled to where the edit has it at its keys, fading out over PULL_FRAMES frames: between keys the pass is free)
      const duration = this.edited.duration
      const pullAt = (t: number): Map<number, string[]> => {
        const byWeight = new Map<number, string[]>()
        for (const b of keyed) {
          // (the pins at the clip's ends are not edits: only what the user moved is pulled)
          const ks = this.keys[b].filter(k => !isAnchor(k))
          if (ks.length === 0) continue
          const d = Math.min(...ks.map(k => Math.abs(t - k.u * duration) * KEY_FPS))
          const w = Math.round(PULL_WEIGHT * Math.max(0, 1 - d / PULL_FRAMES) * 100) / 100
          if (w > 0) byWeight.set(w, [...(byWeight.get(w) ?? []), b])
        }
        return byWeight
      }
      // (the body's root where the edit has it (held there by the build) on the frames a gear drag moved the piece, as much)
      const rootHeld = (i: number): NaturalGoal[] => {
        const h = holdAt(gearRig.holds, gearRig.paths, i)
        if (h === null) return []
        const weight = ROOT_HOLD.weight * Math.min(1, h.w)
        return [...poseTargets(rig, [this.rig.hips], { weight, turn: false }), ...poseTargets(rig, [ROOT_HOLD.chest], { weight, position: false })]
      }
      const rest = view.rest
      const soles: Record<string, number> = {}
      for (const side of SIDES) for (const n of ['Foot', 'ToeBase', 'Toe_End']) { const b = rest.bones.get(`${side}${n}`); if (b !== undefined) soles[`${side}${n}`] = b.worldPosition.y }
      const t0 = performance.now()
      const previousMiss = Math.max(0, ...handleMisses(was, root, gearRig))
      const out = await naturalizeClipAsync(rig, this.edited, {
        root, fps: KEY_FPS, loop: this.loop,
        // (a captured stretch or crossed-arm contact is intentional: correct only the elbow bow edits added; a new held
        // pose has no motion of its own to keep, so it takes the anatomical default)
        referenceClip: this.held ? undefined : this.baseClip ?? undefined,
        cancelled: () => this.naturalizeCancelled || turn !== this.opening || was !== this.edited,
        progress: (done, total) => { if (turn === this.opening) this.busy = `Naturalizing ${Math.round(done / total * 100)}%` },
        goals: (i, t) => [
          // the body's root held where it was seen when a piece was let go, on the frames the drag moved it
          ...rootHeld(i),
          // the hands where the edit put them (on their handles): met exactly
          ...attachedHands.map(n => { const b = bones.get(n)!; return { bone: n, position: b.getWorldPosition(new THREE.Vector3()), turn: b.getWorldQuaternion(new THREE.Quaternion()), exact: true } as NaturalGoal }),
          // the keyed bones near their keys pulled to where the edit has them
          ...[...pullAt(t)].flatMap(([w, names]) => poseTargets(rig, names, { weight: w })),
        ],
        feet: ['LeftFoot', 'RightFoot'].filter(n => bones.has(n)),
        floor: { y: 0, soles },
        hipsMove: true,
        collide: this.collider ?? undefined,
        pull: amount.pull, pullOutside: amount.outside, smoothMotion: amount.motion, sweeps: 3,
        // (the leading pieces' shafts where the edit has them on each frame: the body kept clear of them but where the hands hold them)
        obstacles: () => gearObstacles(gearRig, id => root.getObjectByName(this.nodeName(id))?.matrixWorld.clone() ?? null, GRIP_CLEAR * view.height),
      })
      if (turn !== this.opening || was !== this.edited) return
      const worst = Math.max(0, ...handleMisses(out.clip, root, gearRig))
      if (!out.frames.every(f => [...f.q, ...f.hips, f.miss, f.floorMiss].every(Number.isFinite))) throw new Error('The solve produced an invalid pose; your edit is unchanged')
      if (Math.max(...out.misses) > 0.01 * view.height || worst > Math.max(0.01 * view.height, previousMiss + 0.001 * view.height)) throw new Error('The solve could not keep the hands on their handles; your edit is unchanged')
      if (Math.max(...out.frames.map(f => f.floorMiss)) > 0.002 * view.height) throw new Error('The solve could not keep the feet off the floor; your edit is unchanged')
      // (fingers posed on purpose stay as they are: a hand on gear, carrying it, posed by its layers or keyed)
      const keep = new Set<Side>(hands)
      for (const carrier of Object.values(gearRig.carriers)) { const side = handSide(carrier); if (side !== null) keep.add(side) }
      for (const side of SIDES) {
        if (this.fists[side] !== undefined || handLayers(c, this.slot, side).length > 0) keep.add(side)
        if (Object.entries(this.keys).some(([name, ks]) => name.startsWith(`${side}Hand`) && name !== `${side}Hand` && ks.some(k => !isAnchor(k)))) keep.add(side)
      }
      // (the fingers kept off the hand's own surface (the collider's, on this copy) and in their ranges)
      const fingers = await correctHandContactsAsync(root, out.clip, {
        height: view.height, fps: KEY_FPS, loop: this.loop, protect: [...keep], tipTolerance: view.height * 0.004,
        limits: this.limitsOn ? this.limits : null, nameOf: b => b.name, collider: colliderFor(root, bones, view.height),
        cancelled: () => this.naturalizeCancelled || turn !== this.opening || was !== this.edited,
        progress: (done, total, phase) => {
          if (turn !== this.opening) return
          const label = phase === 'clearance' ? 'Checking finger clearance' : phase === 'relaxation' ? 'Relaxing free fingers' : phase === 'trajectory' ? 'Checking finger paths' : 'Refining fingers'
          this.busy = `${label} ${Math.round(done / total * 100)}%`
        },
      })
      if (this.naturalizeCancelled) throw new DOMException('Naturalization cancelled', 'AbortError')
      if (turn !== this.opening || was !== this.edited) return
      this.record()
      this.edited = fingers.clip
      this.naturalized = true
      this.display(animator.time, `${this.base?.label ?? 'Clip'} (naturalized)`)
      app.toast('ok', `Naturalized ${out.times.length} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s${attachedHands.length > 0 ? `; hands off their handles by ${(worst * 100).toFixed(1)} cm at worst` : ''}`)
    } catch (error) {
      const cancelled = (error as Error).name === 'AbortError'
      if (turn === this.opening) app.toast(cancelled ? 'ok' : 'error', cancelled ? 'Naturalization cancelled; your edit is unchanged' : `Naturalize failed: ${reason(error)}`)
    } finally {
      if (run === this.naturalizeRun) this.naturalizing = false
      if (turn === this.opening) this.busy = null
    }
  }

  cancelNaturalize (): void { this.naturalizeCancelled = true }

  // ---- building and showing ----------------------------------------------------------------------------------------

  /** The copy of the character the clip is built on, with every piece on stage (copied again when one is missing: a
   * piece put on after it was made). */
  private posable (): THREE.Object3D | null {
    let root = animator.posableCopy()
    const view = animator.view
    if (root !== null && this.pieces.some(p => root!.getObjectByName(gearNode(p.gear)) === undefined && view?.root.getObjectByName(gearNode(p.gear)) !== undefined)) root = animator.posableCopy(true)
    return root
  }

  /** The edited clip, built again and shown at `time`: the keys, the hands put on their handles by IK (the body is
   * solved only when asked: solveBody keys what it moves). */
  private show (time: number): void {
    this.naturalized = false
    const view = animator.view; const base = this.baseClip; const root = this.posable()
    if (!this.active || view === null || view.rest === null || base === null || root === null || this.base === null) return
    this.edited = buildEdit(base, this.keys, this.loop, boneRest(view.rest), root, this.rig, 0, this.limitsOn ? this.limits : null, this.gearRig(), view.height)
    this.display(time, this.held ? 'New clip (editing)' : `${this.base.label} (editing)`)
  }

  /** A rider's clip as his slot plays it: his held bones (hips and legs) in the seat (bake.ts bakeRide freezes them the
   * same), so what the editor shows and saves is what plays (the designer, 2026-10-28: "what I preview and what plays
   * after save need to be identical"). Anyone else's as it is. */
  private seated (clip: THREE.AnimationClip): THREE.AnimationClip {
    const m = this.character?.mount; const rest = animator.view?.rest
    return m === undefined || rest == null ? clip : freezeClip(clip, m, boneRest(rest))
  }

  private display (time: number, label: string): void {
    if (this.edited === null) return
    animator.showClip(this.seated(this.edited), { label, pulls: this.pulls, time, slotId: this.slotId, editing: true })
    // (a hand just put on a piece, or let go of one: its gizmo locks to the piece, or is free again)
    this.editor?.setGripLock(b => this.gripHold(b))
  }

  // ---- saving ------------------------------------------------------------------------------------------------------

  /** Each piece `clip` moves off where it is placed: its path, frame by frame, as keys from that placement (by gear id). */
  private gearKeysOf (clip: THREE.AnimationClip): Record<string, ClipKey[]> {
    const out: Record<string, ClipKey[]> = {}
    for (const p of this.pieces) {
      const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
      garmentMatrix(p.place).decompose(position, quaternion, new THREE.Vector3())
      const keys = propKeysOf(clip, gearNode(p.gear), { position, quaternion }, p.place.scale)
      if (keys !== null) out[p.id] = keys
    }
    return out
  }

  /**
   * The editor's one save (the designer, 2026-10-28: "I super just need to be able to save animations with the character
   * as a replacement to attack or run"): the edit written as a new library clip, and the slot `target` names plays it
   * (one of the character's, by id while it is there, else by name; none of that name: a new one), as
   * saveIntoSlotCommands puts it there, in one batch. What the slot played before is replaced, nothing asked ("we also
   * do not need to care about losing a player animation, just make a new one"): its old clip stays in the library, and
   * Undo in Activity puts it back.
   */
  async saveAs (target: { slotId: string | null, name: string }): Promise<void> {
    const c = this.character; const b = this.base
    if (!this.active || this.busy !== null || c === null || b === null) return
    const name = target.name.trim()
    if (name === '') { app.toast('error', 'Choose the clip to save it as'); return }
    const into = (x: Character): Slot | null => (target.slotId === null ? undefined : slotById(x, target.slotId)) ?? slotByName(x, name) ?? null
    const saved = await this.save(`${c.name} ${name}`, { slot: into(c) })
    const now = this.character
    if (saved === null || now === null || !this.active) return
    const slot = into(now)
    // (how the slot it was opened on played: what it stored against its source moves to where it played in the clip saved)
    const shown = this.slot !== null && this.mode === 'plays' ? await animator.bake(now, this.slot) : null
    const commands = saveIntoSlotCommands({ slot, name: slot?.name ?? name }, { slot: this.slot, mode: this.mode }, saved.ref, {
      loop: this.loop, inPlace: b.inPlace, lift: now.mount === undefined ? this.lift : 0, gearKeys: saved.gearKeys, newId,
      played: shown === null ? undefined : { time: shown.time, events: shown.events },
    })
    const entry = await app.do(now.id, commands, `save as ${name}`)
    // (refused: the reason is toasted; the clip is in the library, the edit still open)
    if (entry === null) return
    this.savedAt = this.revision
    this.issued = []
    const after = app.byId(now.id)
    const played = after === null ? null : into(after)
    this.stop()
    if (after !== null && played !== null) await animator.playSlot(after, played.id)
    app.toast('ok', `${name} now plays the edit (${saved.ref.id})`)
  }

  /** Write the edited clip as a new one: a person's into the library (the library's build makes it), a creature's (its
   * template's skeleton) as a clip file beside its bundled ones. `slot`: the slot it is saved for (its record says so). */
  private async save (name: string, o: { slot: Slot | null }): Promise<{ ref: ClipRef, gearKeys: Record<string, ClipKey[]> } | null> {
    const view = animator.view; const root = this.posable(); const b = this.base; const source = this.source; const c = this.character
    // (saved as it was shown: a rider's held bones in the seat)
    const edited = this.edited === null ? null : this.seated(this.edited)
    if (view === null || view.rest === null || root === null || b === null || source === null || c === null || edited === null) return null
    this.busy = 'Saving the clip'
    this.saving = true
    try {
      const frames = unretarget(edited, root, view.rest, source.rest, source.clip, this.lift)
      // (the gear the edit moves off its placement: its keys for the slot (by gear id), and its paths for the library
      // clip (by name: a library clip is shared across characters))
      const gearKeys = this.gearKeysOf(edited)
      const nameOf = (id: string): string => gearById(c, id)?.name ?? id
      const propPaths = Object.fromEntries(Object.entries(gearKeys).map(([id, ks]) => [nameOf(id), ks]))
      const making = {
        mode: this.mode, ...(o.slot !== null ? { slot: o.slot.name } : {}), character: c.id, keys: this.keys,
        gear: Object.fromEntries(Object.entries(this.paths).filter(([, p]) => p.locked || p.keys.length > 0).map(([id, p]) => [nameOf(id), p])),
        ...(this.held ? { length: this.length } : {}),
      }
      const write = async (): Promise<ClipRef> => {
        if (c.skeleton.template === 'human') {
          const loop = o.slot?.loop ?? this.loop
          const r = await api.saveEdit({ name, base: b.clip.id, loop, propPaths, frames, making, characterId: c.id, slot: o.slot?.id })
          this.busy = `Writing ${name} into the library`
          const job = await app.jobDone(r.job)
          if (job.status !== 'done') throw new Error(job.error ?? (job.status === 'cancelled' ? 'the save was cancelled' : 'the save failed'))
          return { id: r.id }
        }
        const glb = await clipGlb(source.root, source.rest, framesClip(frames, source.rest, name))
        const r = await api.saveCreatureClip({
          rig: c.skeleton.template, name, base: b.clip.id, loop: o.slot?.loop ?? this.loop, inPlace: b.inPlace, duration: edited.duration, characterId: c.id,
          ...(o.slot !== null ? { slot: o.slot.id } : {}),
        }, new Uint8Array(glb), propPaths)
        return { id: r.id, url: r.url }
      }
      const ref = await write()
      library.reload()
      // (its record is this edit's now)
      this.records.delete(ref.id)
      return { ref, gearKeys }
    } catch (error) {
      app.toast('error', `The clip didn't save: ${reason(error)}`)
      return null
    } finally {
      this.busy = null
      this.saving = false
    }
  }
}

/** A clip of `seconds` holding the pose `clip` has at `t` (every track's value there, at both ends). */
function holdOf (clip: THREE.AnimationClip, t: number, seconds: number): THREE.AnimationClip {
  const tracks = clip.tracks.map(track => {
    const i = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
    const v = Array.from(i.evaluate(Math.min(t, clip.duration)) as ArrayLike<number>)
    const Track = track.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack
    return new Track(track.name, [0, seconds], [...v, ...v])
  })
  return new THREE.AnimationClip(`${clip.name} pose`, seconds, tracks)
}

/** `clip` with `node`'s position and turn tracks moved by `change` (on its parent's side): a piece's frames as its new
 * placement places it. */
function rebaseNode (clip: THREE.AnimationClip, node: string, change: THREE.Matrix4): THREE.AnimationClip {
  const pt = clip.tracks.find(t => t.name === `${node}.position`); const qt = clip.tracks.find(t => t.name === `${node}.quaternion`)
  if (pt === undefined || qt === undefined || pt.times.length !== qt.times.length) return clip
  const ps: number[] = []; const qs: number[] = []
  const m = new THREE.Matrix4(); const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const sc = new THREE.Vector3()
  for (let i = 0; i < pt.times.length; i++) {
    m.compose(p.fromArray(pt.values, i * 3), q.fromArray(qt.values, i * 4), new THREE.Vector3(1, 1, 1))
    change.clone().multiply(m).decompose(p, q, sc)
    ps.push(...p.toArray()); qs.push(...q.toArray())
  }
  const tracks = clip.tracks.filter(t => t !== pt && t !== qt)
  tracks.push(new THREE.VectorKeyframeTrack(pt.name, Array.from(pt.times), ps), new THREE.QuaternionKeyframeTrack(qt.name, Array.from(qt.times), qs))
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

export const clipEdit = new ClipEdit()
