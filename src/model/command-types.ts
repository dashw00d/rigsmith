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
  Adjustment, ClipRef, Gear, GearAttach, Handle, HandPose, HandPoseRef, Joints, MarkerBoardState, Mount, Placement,
  Side, Slot, Vec3,
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
  // clips (owner: Motion)
  /** A new slot (a trial, or a game clip name not yet filled). Its name must be free. */
  | { type: 'slot.add', slot: Slot, index?: number }
  | { type: 'slot.update', id: string, patch: { name?: string, speed?: number, loop?: boolean, inPlace?: boolean, note?: string | null } }
  /** Put a clip in a slot (by `id`), or in a new slot named `name` with id `newId`. Speed (default 1), loop and in
   * place are the given ones; the old clip's adjustments go (they were tuned for other motion) unless
   * `keepAdjustments`; `adjustments` are added (merged by the cardinality rules: a keys adjustment merges into the
   * existing one per bone/gear). */
  | { type: 'slot.fill', id?: string, name?: string, newId?: string, clip: ClipRef, speed?: number, loop?: boolean, inPlace?: boolean, keepAdjustments?: boolean, adjustments?: Adjustment[], note?: string | null }
  /** Also takes out pace adjustments of other slots that followed it. */
  | { type: 'slot.remove', id: string }
  | { type: 'slot.reorder', ids: string[] }
  | { type: 'slot.adjust.add', slot: string, adjustment: Adjustment }
  | { type: 'slot.adjust.update', slot: string, id: string, patch: Record<string, unknown> }
  | { type: 'slot.adjust.remove', slot: string, id: string }
  /** The slot's adjustments replaced (the editor baking them into a new clip). */
  | { type: 'slot.adjust.set', slot: string, adjustments: Adjustment[] }
  /** The whole set replaced (another character's set copied here, or a game build restored). The caller gives the
   * slots fresh ids (select.freshSet, which also remaps pace.like). `gearNames` (source gear id -> name): gear
   * references (keys.gear, handleHold, handPose.gear) are mapped onto this character's gear of the same name and
   * handles of the same name (`handleNames`: '<source gear id>/<source handle id>' -> handle name; a handle not named
   * there keeps its id if the gear here has it); what doesn't resolve is dropped and reported. */
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
export type MountPatch = Partial<Omit<Mount, 'scale' | 'hips' | 'skin' | 'gear'>> &
  { scale?: number | null, hips?: Vec3 | null, skin?: string | null, gear?: string[] | null }
