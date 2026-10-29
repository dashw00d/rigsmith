// Every user action on a character is one of these commands. The same pure reducer (src/model/commands.ts
// applyCommand) runs on the server (the truth: it journals and broadcasts) and in the app (optimistically, before the
// server answers). applyCommand is a pure function of (character, command): every id it creates is in the command,
// so the app's optimistic copy and the server's agree. Several commands can go as one batch (one journal entry, one
// undo, all or nothing). A command names what it changes by id; it never replaces a whole array, so two writers editing
// different gear or slots never clobber each other. Undo is generic (src/model/entities.ts): the journal keeps the
// entities a command touched as they were before.
//
// Long work (import, rig, finger trace, template fit, texture compose, export) runs as server jobs, which write the
// document through the same journal (server/store.ts updateCharacter) without being commands.
import type {
  Adjustment, BlowFit, ClipEvent, ClipKey, ClipRef, Gear, GearAttach, GearTrack, Handle, HandPose, HandPoseRef, Joints,
  MarkerBoardState, Mount, Placement, RetimeMarker, Side, Slot, SlotIk, SlotTime, TimeHold, Vec3,
} from './types.ts'

export type Command =
  // character
  | { type: 'character.rename', name: string }
  // skeleton (owner: Skeleton)
  /** Put joints where the user placed them (3D drag, marker solve): each given joint that differs from `detected` by
   * more than 1e-6 becomes an override; each given joint that doesn't is taken out of the overrides. `markers` given:
   * the board's state saved with it (null: cleared). */
  | { type: 'skeleton.place', joints: Joints, markers?: MarkerBoardState | null }
  /** Back to the detected position for these joints. */
  | { type: 'skeleton.unplace', joints: string[] }
  /** Back to detected entirely: overrides, markers and stale overrides cleared. */
  | { type: 'skeleton.reset' }
  | { type: 'skeleton.markers', markers: MarkerBoardState | null }
  /** Stale overrides (src/model/types.ts StaleOverride) restored as overrides or discarded; unset joints: all. */
  | { type: 'skeleton.stale', action: 'restore' | 'discard', joints?: string[] }
  | { type: 'skeleton.boneMap', boneMap: Record<string, string> | null }
  // skin (owner: Skin)
  | { type: 'skin.lock', locked: boolean, reason?: string }
  // hands (owner: Hands)
  | { type: 'hands.pose.add', pose: HandPose }
  | { type: 'hands.pose.update', id: string, patch: Partial<Omit<HandPose, 'id'>> }
  /** References to it (handles, adjustments, holds) fall back to 'default' and are reported. */
  | { type: 'hands.pose.remove', id: string }
  | { type: 'hands.hold', side: Side, pose: HandPoseRef | null }
  // gear (owner: Gear)
  /** A new piece (from the catalog, or a tool restoring one). Keeps `gear.id` (409 if taken); `model` must lie under
   * garments/<id>/. A name taken (by its safe form) is made unique, except for 'emberhold:' gear (409). */
  | { type: 'gear.add', gear: Gear }
  /** Showing a piece of a swap set hides the others in it. `model` must lie under garments/<id>/ (a re-pivoted or
   * replaced mesh). Renaming 'emberhold:' gear is refused (the game names it). */
  | { type: 'gear.update', id: string, patch: { name?: string, hidden?: boolean, swapSet?: string | null, model?: string, from?: string | null } }
  /** How it follows the body, replaced whole (a kind change leaves nothing of the old kind behind). Moving it onto
   * or off a hand adds or removes its carry handle. */
  | { type: 'gear.attach', id: string, attach: GearAttach }
  | { type: 'gear.place', id: string, place: Placement }
  /** Also takes out what pointed at it in this character (adjustments) and reports it. Never deletes files. (Riders
   * whose mount wears it are updated by the server, journaled on them.) */
  | { type: 'gear.remove', id: string }
  | { type: 'gear.handle.add', gear: string, handle: Handle }
  /** null unsets an optional field (a grip for either hand, a pull's pose back to leaving the hand as it is). */
  | { type: 'gear.handle.update', gear: string, id: string, patch: HandlePatch }
  /** Also takes out handleHold adjustments on it. A carry handle can't be removed (move the gear off the hand). */
  | { type: 'gear.handle.remove', gear: string, id: string }
  // clips (owner: Motion; docs/motion-plan.md §4). Every time given is source time (types.ts SourceU).
  /** A new slot (a trial, or a game clip name not yet filled). Its name must be free. */
  | { type: 'slot.add', slot: Slot, index?: number }
  /** `muted`: the tracks switched off (types.ts Slot.muted); null: none. */
  | { type: 'slot.update', id: string, patch: { name?: string, speed?: number, loop?: boolean, inPlace?: boolean, note?: string | null, muted?: string[] | null } }
  /** Put a clip in a slot (by `id`), or in a new slot named `name` with id `newId`. Speed (default 1), loop and in
   * place are the given ones; what was tuned for the old clip (adjustments, time, keys, gear tracks, events) goes
   * unless `keepAdjustments`; the parts given are added (adjustments by the cardinality rules, time parts replaced,
   * tracks merged per bone and gear, events added). */
  | { type: 'slot.fill', id?: string, name?: string, newId?: string, clip: ClipRef, speed?: number, loop?: boolean, inPlace?: boolean, keepAdjustments?: boolean, adjustments?: Adjustment[], time?: SlotTime, bones?: Record<string, ClipKey[]>, gear?: Record<string, GearTrack>, events?: ClipEvent[], note?: string | null }
  /** "Save as <clip>": `from`'s setup (its clip, speed, time, adjustments, tracks, events, muted) copied over slot `to`,
   * which keeps its id, name, loop and in place, or into a new slot `name` with id `newId` (taking `from`'s loop and
   * in place). A pace following the slot itself goes. */
  | { type: 'slot.copy', from: string, to?: string, name?: string, newId?: string }
  /** Also takes out pace of other slots that followed it. */
  | { type: 'slot.remove', id: string }
  | { type: 'slot.reorder', ids: string[] }
  /** Adjustments are ground, handPose and handleHold (the blow fit and pace are slot.time, keys slot.keys.set). */
  | { type: 'slot.adjust.add', slot: string, adjustment: Adjustment }
  | { type: 'slot.adjust.update', slot: string, id: string, patch: Record<string, unknown> }
  | { type: 'slot.adjust.remove', slot: string, id: string }
  /** The slot's adjustments replaced. */
  | { type: 'slot.adjust.set', slot: string, adjustments: Adjustment[] }
  /** The slot's time map: each part given replaced whole, null removes it. */
  | { type: 'slot.time', slot: string, patch: { fit?: BlowFit | null, pace?: { enabled: boolean, like: string } | null, markers?: RetimeMarker[] | null, holds?: TimeHold[] | null } }
  /** Keys: each track named (a bone, or a gear piece by id) replaced by these keys (none: the track goes). Every key
   * operation of the timeline (insert, delete, drag, stretch, duplicate, paste, mirror, tween, easing) is one of these. */
  | { type: 'slot.keys.set', slot: string, tracks: KeyTrack[] }
  | { type: 'slot.event.add', slot: string, event: ClipEvent }
  /** null unsets an optional field (a span back to a point, the sound, the bone). */
  | { type: 'slot.event.update', slot: string, id: string, patch: EventPatch }
  | { type: 'slot.event.remove', slot: string, id: string }
  /** Who holds a piece over the clip and when it shows (null clears). */
  | { type: 'slot.gear.update', slot: string, gear: string, patch: { heldBy?: GearTrack['heldBy'] | null, shown?: GearTrack['shown'] | null } }
  /** The slot's build (types.ts SlotIk): each part given replaced whole, null removes it; nothing left, the build goes. */
  | { type: 'slot.ik', slot: string, patch: { hands?: SlotIk['hands'] | null, lead?: string[] | null, floor?: boolean | null } }
  /** The whole set replaced (another character's set copied here, or a game build restored). The caller gives the
   * slots fresh ids (select.freshSet, which also remaps time.pace.like). `gearNames` (source gear id -> name): gear
   * references (gear tracks, handleHold, handPose.gear, muted 'gear:<id>') are mapped onto this character's gear of the
   * same name and handles of the same name (`handleNames`: '<source gear id>/<source handle id>' -> handle name; a
   * handle not named there keeps its id if the gear here has it); what doesn't resolve is dropped and reported. */
  | { type: 'clips.replace', slots: Slot[], gearNames?: Record<string, string>, handleNames?: Record<string, string> }
  // look (owner: Look; the server recomposes the texture after these)
  | { type: 'look.layer.update', id: string, patch: { enabled?: boolean, note?: string } }
  | { type: 'look.layer.remove', id: string }
  | { type: 'look.layer.reorder', ids: string[] }
  // mount (owner: Ship)
  | { type: 'mount.set', mount: Mount | null }
  /** null unsets an optional field (scale, hips, skin, gear). */
  | { type: 'mount.update', patch: MountPatch }

export type CommandType = Command['type']

export type HandlePatch = Partial<Pick<Handle, 'name' | 'pull'>> &
  { hand?: Side | null, place?: Handle['place'] | null, exact?: boolean | null, pose?: HandPoseRef | null }
/** One track's keys: `bone` (the Body track's row) or `gear` (a piece's keys, by gear id). */
export type KeyTrack = { bone: string, keys: ClipKey[] } | { gear: string, keys: ClipKey[] }
export type EventPatch = Partial<Pick<ClipEvent, 'name' | 'u'>> & { to?: number | null, sound?: string | null, bone?: string | null }
export type MountPatch = Partial<Omit<Mount, 'scale' | 'hips' | 'skin' | 'gear'>> &
  { scale?: number | null, hips?: Vec3 | null, skin?: string | null, gear?: string[] | null }
