// The character document, schema 4: one record per character (workspace/characters/<id>/character.json), split into
// sections that each have exactly one owning module. The server, the app and the tools all read and write it through
// this file's types and src/model/commands.ts. See docs/rebuild/DESIGN.md.
//
//   section    owner (the only writer)                          what it holds
//   source     Import (server import job, /fit)                 the uploaded file, what it contained, its size
//   skeleton   Skeleton (src/model/commands/skeleton.ts,        the generator's joints, the user's overrides, markers,
//              server skeleton routes)                          template and finger level
//   skin       Skin (server rig job, weights routes)            the rig report, the weight lock, painted count
//   hands      Hands (src/model/commands/hands.ts)              named hand poses, hands held in every clip
//   gear       Gear (src/model/commands/gear.ts, gear routes)   everything worn or carried, with its handles
//   clips      Motion (src/model/commands/clips.ts)             the slots: game clip names and trials, each its source
//                                                               clip, time map and tracks (docs/motion-plan.md)
//   look       Look (look routes and compose job)               texture layers (hole fill, repaints)
//   mount      Ship (src/model/commands/mount.ts)               the horse a rider sits on
//
// Unit specs (height, budget, LODs, companion) stay in workspace/game/units.json (server/game.ts), the file that is
// spliced into the game's own units.json; they are owned by Ship too.

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]
/** Joint positions in glTF space (Y up, +Z forward, metres of the model as imported and sized). */
export type Joints = Record<string, Vec3>
/** A moment of a slot's SOURCE clip (docs/motion-plan.md §1): 0 its first frame, 1 its last, as the clip source
 * retargets it (in place or not, mirrored or not; a slot built from pieces: their composite, §11), before any timing. Past 1 is the source's last pose held, running on
 * at the rate the clip played (a late blow held: SlotTime fit.late 'hold'). At most MAX_U. Every time a slot stores is
 * one of these, so changing the slot's timing never moves a key, a window or an event; what the timeline shows is the
 * played clip's phase, converted by the baked slot's time map (src/model/timemap.ts). */
export type SourceU = number
export const MAX_U = 16
/** A part of a slot's source clip [from, to] (source time; schema 2's were phases of the clip as it played). */
export type Window = [SourceU, SourceU]
export type Side = 'Left' | 'Right'
export type FingerLevel = 'none' | 'one' | 'two' | 'three' | 'full'

export const SCHEMA = 4

export interface Character {
  schema: 4
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** Bumped by every write (commands and jobs). A client ignores a copy older than the one it holds. */
  version: number
  /** Cache-bust counter for the model files (model.glb, rigged.glb); bumped when their bytes change. */
  revision: number
  thumbVersion?: number
  /** Files relative to the character folder. */
  files: { model?: string, rigged?: string, thumbnail?: string }
  /** Lifecycle of the background work on it. What the UI shows is src/model/select.ts phaseOf(), never this alone. */
  status: 'importing' | 'ready' | 'rigging' | 'rigged' | 'error'
  /** The last failure, cleared on the next success. */
  error?: string

  source: SourceSection
  skeleton: SkeletonSection
  skin: SkinSection
  hands: HandsSection
  gear: Gear[]
  clips: Slot[]
  look: LookSection
  mount?: Mount
}

// ---- source (Import) --------------------------------------------------------------------------------------------

export interface SourceSection {
  /** The upload, kept at source/original.<ext>, never deleted. */
  file: string
  originalName: string
  bytes: number
  /** What the import contained. */
  kind: 'mesh' | 'rigged' | 'animation'
  /** Skeleton family of a rigged import: mixamo, tripo, rigify, unreal, unknown. */
  rigPreset?: string
  /** Size against the uploaded file (Import -> Size): every import and rig scales the model by it, then stands it on
   * the floor. 1 = as uploaded. */
  scale: number
  stats?: Stats
  /** What the import noticed: stood on the floor, hidden legs, arm traces that failed, detection failures. */
  warnings: string[]
}

export interface Stats { vertices: number, triangles: number, height: number, meshes: number, bones: number }

// ---- skeleton (Skeleton) ----------------------------------------------------------------------------------------

export interface SkeletonSection {
  /** 'human' (the Mixamo humanoid) or a creature template id (static/templates/<id>.json). */
  template: string
  fingerLevel: FingerLevel
  /** Generator output: import detection, a template fit, a conversion from a foreign rig, a finger trace, joints a
   * rig completed. Never edited by hand. Each generator's policy toward `overrides` is in DESIGN.md §2.2. */
  detected?: Joints
  /** The import's own human detection (written only by import), what switching back to the human template restores. */
  imported?: Joints
  /** A rigged import converted onto the Rigsmith rig (its joints read from the foreign skeleton). `source.kind` stays
   * 'rigged' (what the file contained); select.phaseOf uses this. */
  converted?: true
  /** The user's placements (3D drags, the marker board's solve): only joints that differ from `detected`
   * (skeleton.place drops the rest). The effective skeleton is select.jointsOf(): detected, then these on top,
   * restricted to src/model/skeletons.ts hierarchyOf (the template's joints; for the human, at this finger level). */
  overrides: Joints
  /** Overrides that no longer apply after a generator re-ran (a finger level change re-meant the index chain):
   * kept and shown, never dropped silently. The user restores or discards them. */
  stale?: StaleOverride[]
  /** The marker board: the skeleton its markers were seeded from and where they are now. */
  markers?: MarkerBoardState
  /** A rigged import's foreign skeleton: Mixamo bone -> its bone, for playing clips on it before conversion. */
  boneMap?: Record<string, string>
}

/** An override set aside by a generator, with the template and finger level it was made at (it can be restored only
 * there). */
export interface StaleOverride { joint: string, at: Vec3, reason: string, template: string, level: FingerLevel }

export interface MarkerBoardState {
  set: string
  base: Record<string, Vec3>
  positions: Record<string, Vec3>
}

// ---- skin (Skin) ------------------------------------------------------------------------------------------------

export interface SkinSection {
  /** The last rig: how its weights were chosen. */
  report?: RigReport
  /** Hand-fixed weights. While locked the server refuses anything that would change the body's weights (a re-rig,
   * painting, the optimizer, tools/dev/coat_weights.ts --apply) until skin.lock {locked: false} is given. */
  locked: boolean
  lockReason?: string
  /** Body points painted by hand (weight_edits.json), re-applied after every re-rig. */
  painted?: number
  /** The joints of the current rigged.glb (its bind pose: what the rig job returned), so the UI can say the skeleton
   * moved since (compared at 1e-4) and select.phaseOf can tell a rig that no longer fits the hierarchy. */
  rigJoints?: Joints
  /** Bones in rigged.glb. */
  bones?: number
}

export interface RigReport {
  /** Short code of what won, e.g. 'regions+retained-weights+pose-optimized' (kept for the game's build record). */
  method: string
  seconds: number
  warnings: string[]
  /** The same as readable decisions: each stage, what it chose and why. */
  decisions?: RigDecision[]
}

export interface RigDecision { stage: string, choice: string, why: string }

// ---- hands (Hands) ----------------------------------------------------------------------------------------------

/** How a hand is posed: 'default' the default fist (DEFAULT_FIST), 'clip' the clip's own hand (open, as animated),
 * { pose } one of the character's (or the shared) hand poses, { fist } the most closed moment of a library clip. */
export type HandPoseRef = 'default' | 'clip' | { pose: string } | { fist: string }

export interface HandsSection {
  poses: HandPose[]
  /** A hand posed in every clip regardless of gear (what grip scripts did): wins over a carry handle, loses to a
   * slot's own handPose adjustment and to a pull being held. */
  hold?: Partial<Record<Side, HandPoseRef>>
}

/** A finger pose: each finger joint's turn from rest in its own frame, keyed by joint without the side (`Index1`),
 * as made on `side`'s hand (the other hand takes it mirrored). */
export interface HandPose {
  id: string
  name: string
  side: Side
  joints: Record<string, Quat>
  /** Where it was taken from: a clip's frame (library clip id or slot id, time in seconds), or rest. */
  from?: { clip: string, at: number }
}

// ---- gear (Gear) ------------------------------------------------------------------------------------------------

/** Placement in the character's rest space: position, XYZ rotation in degrees, uniform scale. */
export interface Placement { position: Vec3, rotation: Vec3, scale: number }

export type SkinPolicy = 'body' | 'cape' | 'skirt' | 'upper' | 'lower' | 'head'

/** How a piece of gear follows the body. One model replaces catalog props and the three garment kinds.
 *  bone  rigid on one bone (a weapon, a tool, a shield, a helmet): every unit's gear today
 *  skin  skinned to the body, each vertex weighted like the skin under it (clothing): extension
 *  spot  pinned to one spot of the skin (a pouch, a buckle; with its own animation, a mechanism): extension */
//  legacyFrame 'grip': `place` is still in the old catalog props' grip-frame units (src/engine/props.ts gripFrame);
//  the gear area converts it to rest space the first time the rig is loaded (gear.place clears it).
export type GearAttach =
  | { kind: 'bone', bone: string, place: Placement, legacyFrame?: 'grip' }
  | { kind: 'skin', policy: SkinPolicy, place: Placement, hideBody?: boolean }
  | { kind: 'spot', place: Placement, anchor?: Vec3, animation?: string }

export interface Gear {
  /** Stable; also the folder garments/<id>/. */
  id: string
  /** Unique among the character's gear by its bone-safe form (geom.safeName; commands enforce it). The game export
   * names meshes and bones after it (Prop_<name>, Prop_<name>_<handle>; Gear*, Head*, Wear*, Weapons_<bone> are the
   * game's contract), so gear whose `from` is 'emberhold:...' can't be renamed. */
  name: string
  /** The model file relative to the character folder; unset while importing or for catalog gear. */
  model?: string
  /** A bundled catalog model (static/props/<file>) instead of an uploaded one. */
  catalog?: string
  /** The point of its model's own space that is the piece's origin (unset: the file's own, [0, 0, 0]). Wherever the
   * model is loaded (the viewer, the export) it is moved by minus this, so its placement, its handles' places, its
   * pulls' rest points and its gear keys are all about this point: what the gizmo sits on and turns it round. Set by
   * gear.origin, which carries all of those over so nothing moves (src/model/origin.ts). A new model forgets it. */
  origin?: Vec3
  status: 'importing' | 'ready' | 'error'
  error?: string
  attach: GearAttach
  /** Where hands take hold of it. A bone-attached piece on a hand bone always has exactly one carry handle. */
  handles: Handle[]
  /** Switched off: not shown, not exported (except the game's swapped pieces). */
  hidden?: boolean
  /** Of the gear sharing a swap set, showing one hides the others (one tool in hand of several). */
  swapSet?: string
  /** Brought in by a tool: 'emberhold:<unit>/<part>' (tools/game_import.py; the only gear the game export takes),
   * 'catalog:<file>'. */
  from?: string
  /** Vertices of it painted by hand (garments/<id>/weights.json, keyed by bone name for skin gear and by 'PropRoot' /
   * 'pull:<handle id>' for pulled gear): skin gear weights, or which parts follow a pull. */
  painted?: number
}

/** Where a hand holds a piece of gear. One concept for the carry socket, the other hand's grips and pull points.
 *  carry  the hand the gear rides on (attach.bone is that hand); its placement is the gear's own
 *  grip   another hand's hold: the wrist at `place` (in the gear's placed frame); made in the editor or Gear
 *  pull   a point of the gear a bone draws while it holds it (a bowstring); `pull` says where */
export interface Handle {
  id: string
  name: string
  kind: 'carry' | 'grip' | 'pull'
  /** carry: the hand that bears it; grip: the hand it is for (unset: either); pull: the pulling hand, if a hand. */
  hand?: Side
  /** grip: where the wrist goes and how the hand turns, in the gear's placed frame. carry: where the carrying hand
   * holds it when the gear leads in the editor (unset: from the gear's placement). */
  place?: { position: Vec3, rotation: Quat }
  /** The hand is held at `place` exactly (no give or slide along the shaft in the editor's solve). */
  exact?: boolean
  /** The hand's pose while it holds this handle.
   *  carry: unset = 'default' (the default fist); 'clip' leaves the clip's own hand.
   *  grip: what the editor closes the hand to on it; unset = the hand's hands.hold, else 'default'.
   *  pull: the hand's pose while the pull is held; unset = no change (the hand as the layers below have it). */
  pose?: HandPoseRef
  /** pull: the pulling bone, where on it the point is held (that bone's rest frame, character units), and where the
   * point rests on the gear (the gear model's own space; its strand is split there). When it is held is per slot
   * (a handleHold adjustment). */
  pull?: { bone: string, grip: Vec3, rest: Vec3 }
}

// ---- clips (Motion) ---------------------------------------------------------------------------------------------

/** A library clip: its id, and where it loads from when it is not a converted library clip (clips/<id>.glb):
 * '/animations/<file>#<name>' (bundled) or '/files/library/creatures/<rig>/<id>.glb' (a creature clip). */
export interface ClipRef { id: string, url?: string }

/** One clip of the character's set. A slot whose name is one of its unit's clip names is what the game plays under
 * that name; any other is a trial, kept here. Names are unique (commands enforce it), ids are stable.
 *
 * Non-destructive: its source (its clip, or the pieces it is built from), its time map (speed, then `time`) and its
 * tracks (adjustments, bones, gear, events), every time in them source time (SourceU). The one bake
 * (src/engine/bake.ts) plays it, the same in the viewer, the timeline and the game export (docs/motion-plan.md §3):
 *   source (pieces composed) -> time (markers, speed, blow fit, pace) -> hands -> ground -> keys on bones -> gear
 *   tracks -> events */
export interface Slot {
  id: string
  name: string
  /** The clip it was filled with (its name in the lists). With `pieces` set, those are what plays. */
  clip: ClipRef
  /** The source built from pieces played one after another (docs/motion-plan.md §11): ranges of library clips or of
   * the character's other slots as they play, and held poses, cross-faded into each other, each one's root motion
   * carrying on from the one before. Unset: `clip` whole (every slot made before schema 4, and most since). Source
   * time is then the composite's: piece i starts at the sum of the lengths (to - from) before it less their blends. */
  pieces?: Piece[]
  /** The time map's first stage: the source played `speed` times as fast. */
  speed: number
  loop: boolean
  inPlace: boolean
  /** Why this clip. */
  note?: string
  /** The rest of the time map (src/model/timemap.ts): the blow fit, pace, retime markers, holds. */
  time?: SlotTime
  /** Settings over source windows (the inspector's): the ground, a hand's pose, a pull held. At most one ground; one
   * handleHold per (gear, handle); a hand's handPose windows don't overlap (commands enforce it). */
  adjustments: Adjustment[]
  /** The Body track: keyed turns (and the Hips' moves) per bone. */
  bones?: Record<string, ClipKey[]>
  /** The Gear tracks, by gear id. */
  gear?: Record<string, GearTrack>
  /** The Events track: named moments, points or spans, exported to the game with the unit. */
  events?: ClipEvent[]
  /** Tracks switched off (kept, not played): 'bones' (every bone's keys), 'gear' (every piece's keys), 'bone:<name>',
   * 'gear:<id>', 'events'. */
  muted?: string[]
  /** The build (src/engine/ikbuild.ts, the bake's stage in place of keys on bones): hands kept on handles by IK,
   * leading gear, the floor kept. */
  ik?: SlotIk
}

/** A slot's build (docs/motion-plan.md §2.6). */
export interface SlotIk {
  /** A hand kept on a handle of a piece (bone gear; not a pull) over `windows` (source time; unset: the whole clip).
   * One entry a hand. */
  hands: Array<{ hand: Side, gear: string, handle: string, windows?: Window[] }>
  /** Pieces that lead: their keys (slot.gear[id].keys) are world moves and turns from where the piece rode in the
   * clip, about its own origin; the hands on them follow. */
  lead?: string[]
  /** A foot the build sank lifted back to the floor (unset: on). */
  floor?: boolean
}

/** A piece of a slot's source (Slot.pieces): `from` to `to` seconds of its content, cross-faded in over `blend`
 * seconds (unset 0; the first piece has none) with the end of the piece before. A piece lasts `to - from` whatever its
 * content does later (a content shorter than that holds its last pose), so the layout depends on the slot alone. */
export type Piece = PieceBase & (
  /** A library clip, seconds of it at speed 1 as the clip source retargets it (the slot's in place, mirror). */
  | { kind: 'clip', clip: ClipRef }
  /** Another slot of the character as it plays (its bake: its time, keys and hands), seconds of its played clip. */
  | { kind: 'slot', slot: string }
  /** The pose where the piece before ends (the first piece: where the next one starts), held: real time to key. Its
   * seconds are its own clock (any numbers, from < to): lengthening it at its start lowers `from`, so what is keyed
   * in it stays where it is. */
  | { kind: 'hold' }
)
export interface PieceBase { id: string, from: number, to: number, blend?: number }
export type PieceKind = Piece['kind']

/** How the source's time becomes the played clip's, after the slot's speed (src/model/timemap.ts has the stages). */
export interface SlotTime {
  /** The blow fit: an attack cut so its blow (the slot's `hit` event; none: the `hand`'s fastest moment, measured)
   * lands at `at` of the played clip (the game times hits at 0.45), or `window` seconds round it. A blow later than
   * `at` cuts the start ('cut', default) or holds the end ('hold': the source's last pose held past 1). */
  fit?: BlowFit
  /** Retimed (uniformly) so its planted foot covers ground as fast as another slot's (by its id). */
  pace?: { enabled: boolean, like: string }
  /** Retime markers: source `u` plays at `to` (a phase of the source's length); piecewise linear between them, 0 -> 0
   * and 1 -> 1 implied. Strictly increasing in both, inside (0, 1). (Schema 3's holds are hold pieces now.) */
  markers?: RetimeMarker[]
}

export interface BlowFit { enabled: boolean, at: number, late?: 'cut' | 'hold', window?: number, hand?: string }
export interface RetimeMarker { id: string, u: SourceU, to: number }

interface AdjustmentBase { id: string, enabled: boolean, note?: string }

/** A setting a slot makes over its clip that stays a setting (the inspector's; the timeline shows the hands' as bars). */
export type Adjustment = AdjustmentBase & (
  /** The whole body raised (+) or lowered (-) by `lift`, character units (its height about 1). */
  | { kind: 'ground', lift: number }
  /** A hand posed in this slot (in `windows`; unset: the whole clip, whatever its timing). 'clip' opens it to the
   * clip's own hand. `gear`: it belongs to that gear's carry handle (a bow let go of): the hand is the carry handle's,
   * and it goes when the gear leaves the hand or is removed. */
  | { kind: 'handPose', hand: Side, pose: HandPoseRef, windows?: Window[], gear?: string }
  /** A handle held in this slot during `windows` (a bowstring drawn). */
  | { kind: 'handleHold', gear: string, handle: string, windows: Window[] }
)

export type AdjustmentKind = Adjustment['kind']

/** How a key's span (from it to the next key) tweens. 'smooth' (unset): a cubic through the keys (Catmull-Rom: a
 * motion passes through a key without stopping); 'linear'; 'ease': out of this key and into the next, stopping at
 * both; 'step': this key's value until the next, then a jump; 'hold': the bone held entirely, the clip's own motion on it
 * stopped where this key is (the key on top) until the next key. On gear, 'hold' is 'step'. */
export type Ease = 'smooth' | 'linear' | 'ease' | 'step' | 'hold'
export const EASES: readonly Ease[] = ['smooth', 'linear', 'ease', 'step', 'hold']

export interface ClipKey {
  /** The moment of the source (SourceU; a looping clip's keys wrap round). Within a track keys are sorted and no two
   * share a moment. */
  u: SourceU
  /** The turn, a quaternion [x, y, z, w]. */
  q: Quat
  /** The move (the Hips: in its parent's frame; gear: in its own placed frame). */
  p?: Vec3
  /** The span from this key to the next; unset: 'smooth'. */
  ease?: Ease
}

/** A gear piece's track in a slot. */
export interface GearTrack {
  /** Moves and turns from where it is placed, in its placed frame. */
  keys?: ClipKey[]
  /** Who holds it from `u` on (sorted by u, distinct; before the first, its Gear attach bone at its Gear placement).
   * Where it sits on that bone, the first given of: `place` (a placement in rest space, as Gear's: where it would sit
   * at rest, carried by that bone); `handle`, one of its carry or grip handles (the hand on it as the handle says,
   * held as Gear has the handle now); `placed`, its Gear placement (the bone is then its Gear attach bone: sheathed
   * again); none: wherever it was at `u`, so it changes hands without a pop (Back -> Right hand at frame 12). Played by
   * the gear tracks stage (src/engine/geartracks.ts). */
  heldBy?: HeldBy[]
  /** Shown or hidden from `u` on (sorted, distinct; before the first, as Gear has it). */
  shown?: Array<{ u: SourceU, shown: boolean }>
}

/** One holder of a gear piece from `u` on (GearTrack.heldBy). */
export interface HeldBy { u: SourceU, bone: string, place?: Placement, handle?: string, placed?: true }

/** The built-in event names (any other is the user's own). The game reads them by name (docs/motion-plan.md §6). */
export const EVENT_NAMES = ['hit', 'release', 'swing', 'step.L', 'step.R', 'draw'] as const

/** A named moment of a slot's clip (a point) or a part of it (a span). */
export interface ClipEvent {
  id: string
  /** A built-in (EVENT_NAMES) or the user's own: a letter, then letters, digits, '.', '_' or '-' (32 at most). The
   * slot's point `hit` is its blow: the fit lands it. */
  name: string
  u: SourceU
  /** A span's end (after `u`); unset: a point. */
  to?: SourceU
  /** A sound played on it: an Emberhold mix.json sound id ('mix:<id>') or a file kept under the character's folder
   * ('file:sounds/<name>.<ext>'). */
  sound?: string
  /** Where it happens (an arrow leaves the hand): a bone of the skeleton. */
  bone?: string
  /** The sound's loudness, a gain on top of its own level (1 as it is; 0.5 about 6 dB down). Above 0, at most 4. */
  volume?: number
  /** The sound's playback rate (1 as it is; 2 an octave up). 0.25 to 4. */
  pitch?: number
}

// ---- look (Look) ------------------------------------------------------------------------------------------------

export interface LookSection {
  /** Bottom to top. The texture the model wears is the source's own image with every enabled layer laid over it in
   * order (server compose job), written to textures/<clean image name>.png and swapped into the GLBs. */
  layers: TextureLayer[]
  /** The last hole scan: per image, how much of it was unpainted (magenta). */
  scan?: { images: TextureImage[], at: number }
  /** Bumped when the composite changes (cache-bust for textures/ URLs). */
  at?: number
  /** Other colour maps on its own UVs (a horse's coats), by name; a rider's mount picks one. */
  skins?: Array<{ name: string, file: string }>
}

export interface TextureLayer {
  id: string
  /** fill: holes repainted from the surface around them; repaint: a projection painting kept;
   * snapshot: a texture made before layers existed, kept whole. */
  kind: 'fill' | 'repaint' | 'snapshot'
  /** The model image it paints, by its clean name (bpy.path.clean_name of the Blender image name: what
   * textures/<image>.png, Blender's texture overrides and server/glbimages.ts swapImages key on). */
  image: string
  /** RGBA in the image's own layout, relative to the character folder (textures/layers/<id>.png): colour, and alpha
   * how strongly it covers what is under it. */
  file: string
  enabled: boolean
  at: number
  /** repaint: the capture (projections/<id>) it came from and the notes it was asked with. */
  capture?: string
  note?: string
  /** fill: the share of the image that was unpainted. */
  coverage?: number
}

export interface TextureImage {
  /** Clean image name (as TextureLayer.image). */
  image: string
  /** Fraction of the texture detected as unpainted (magenta). */
  coverage: number
}

// ---- mount (Ship) -----------------------------------------------------------------------------------------------

/** Riding: the horse (a creature character), the bone the rider sits on and where, his lower body held in a seated
 * pose while the rest of him plays his clips. */
export interface Mount {
  character: string
  bone: string
  /** His rest space placed in the horse bone's rest space, turned (XYZ degrees). His size against the horse is the
   * game's (the two units' heights), else `scale`. */
  position: Vec3
  rotation: Vec3
  scale?: number
  /** Held bones and their seated pose (local rotations), and the Hips' local position. */
  freeze: string[]
  pose: Record<string, Quat>
  hips?: Vec3
  /** The horse's look for this rider: one of its skins (by name; unset: its own) and which of its gear it wears
   * (gear ids of the horse). */
  skin?: string
  gear?: string[]
}

// ---- settings and journal ---------------------------------------------------------------------------------------

export interface Settings {
  /** The game's repo (Emberhold): Ship writes its units there. */
  gameRepo: string
  /** Hand poses shared by every character. */
  handPoses?: HandPose[]
}

/** A line of a character's journal (characters/<id>/journal.jsonl): a command (or a batch of them), a job's
 * result, or a note. The file is append-only. */
export interface JournalEntry {
  /** Increasing per character; how an entry is named for undo. Lines from before schema 2 read as -(line + 1). */
  seq: number
  at: string
  /** 'app', or the tool that made it (x-rigsmith-by header): 'agent', 'game_import'... */
  by: string
  /** In plain words. */
  changes: string[]
  /** The command type, or the job kind ('import', 'rig', 'texture', 'export'...), or 'note'. */
  what: string
  note?: true
  /** The entity keys it changed (every write, undoable or not), so undo can see later changes. */
  touched?: string[]
  /** How to take it back: the entities as they were before. Absent: it can't be undone (a rig, an import). */
  undo?: UndoRecord
  /** An entry that takes another back names it. */
  undoes?: number
  /** Derived when the journal is read (never written): taken back by the entry with this seq. */
  undoneBy?: number
  /** The client's id for the command(s), so the app can match its pending optimistic copy to the server's. */
  cid?: string
}

/** Entity keys (src/model/entities.ts): 'name', 'skeleton', 'skinLock' ({locked, lockReason}), 'hands', 'mount',
 * 'gear:<id>' (without the job-owned status, error, painted, model), 'slot:<id>', 'layer:<id>' (look layers),
 * 'gearOrder', 'slotOrder', 'layerOrder'. Job-owned fields (source, files, status, skin report, look.scan/at...) are
 * not entities. `before` null: it did not exist. `after`: a stable hash of the entity right after the write, so a
 * later change to it is seen as a conflict (order entities never conflict: they merge). */
export interface UndoRecord {
  entities: Array<{ key: string, before: unknown, after: string }>
}

// ---- jobs ---------------------------------------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  /** inspect, rig, fingers, template, fit, garment, texture, compose, codex, clip, export, paint... */
  kind: string
  label: string
  characterId?: string
  status: JobStatus
  progress: number
  message: string
  createdAt: number
  finishedAt?: number
  error?: string
  /** What the job is about and what it made, for whoever shows it (the game export: `units`, and when done each
   * unit's `builds`: server/game.ts UnitBuild). */
  result?: Record<string, unknown>
}
