// The contract between the timeline (src/app/motion/Timeline.svelte, Phase B) and what the other areas add to it
// (docs/motion-plan.md §9): C1's Events lane and inspector, C2's Gear lanes and inspector, C3's pose tools. The timeline
// owns the ruler, the playhead, zoom, the loop region and the selection, and hands each area a TimelineView; an area
// draws its rows inside `width` pixels with `toX` / `fromX`, writes through its own commands, and selects through
// `select` (so box select, delete and the inspector work across tracks). Every position on screen is a PLAYED phase
// (0-1 of the clip as it finally plays); every stored time is a SOURCE phase: convert with `toPlayed` / `toSource`.
//
// The mounted components (fixed paths; each area owns its file, Phase B mounts them and passes these props):
//   src/app/motion/events/EventsLane.svelte       { view: TimelineView }            the Events track's row(s)
//   src/app/motion/events/EventsInspector.svelte  { view: TimelineView }            shown when the selection is events
//   src/app/motion/gear/GearLanes.svelte          { view: TimelineView, gear: string }  per piece: Held by and Shown strips
//   src/app/motion/gear/GearInspector.svelte      { view: TimelineView, gear: string }  shown when a piece is selected
//   src/app/motion/pose/PoseToolbar.svelte        { view: TimelineView }            the pose tools, in the timeline's toolbar
import type { BakedSlot } from '../../engine/bake.ts'
import type { Command } from '../../model/command-types.ts'
import type { Character, Slot } from '../../model/types.ts'

/** One selected item: its track (`body:<bone>`, `gear:<id>`, `held:<id>`, `shown:<id>`, `events`, `hands:<adj id>`,
 * `time`), the item's id within it (a key's source phase as a string for keys, an event's id...), and its source phase. */
export interface SelectedItem { track: string, id: string, u: number }

export interface TimelineView {
  character: Character
  slot: Slot
  /** The slot as it bakes now (null while it bakes). */
  baked: BakedSlot | null
  /** Played phase <-> x in the lane's own pixels, and the lanes' width. */
  toX: (played: number) => number
  fromX: (x: number) => number
  width: number
  /** The clip's played length (seconds) and its frames (keys.ts KEY_FPS). */
  duration: number
  frames: number
  /** Source phase <-> played phase (baked.time; identity while it bakes). */
  toPlayed: (source: number) => number
  toSource: (played: number) => number
  /** A played phase snapped to the nearest frame (free: as it is, e.g. with Alt held). */
  snap: (played: number, free?: boolean) => number
  /** The playhead (a played phase), and moving it. */
  playhead: number
  seek: (played: number) => void
  /** The selection across tracks. */
  selection: readonly SelectedItem[]
  select: (items: SelectedItem[], mode: 'set' | 'add' | 'toggle') => void
}

/** The part of a TimelineView an area's items need (the timeline's state has no pixels). */
export type AreaView = Pick<TimelineView, 'character' | 'slot' | 'baked' | 'frames' | 'toPlayed' | 'toSource' | 'snap'>

/** Commands an area's items make (sent with the keys' as one undo) and its items to select after. */
export interface AreaEdit { commands: Command[], selection: SelectedItem[] }

/** An area's items copied: the played phase of the earliest, and what the area pastes from. */
export interface AreaClip { first: number, data: unknown }

/**
 * What an area does with its own items in the cross-track selection when the timeline acts on all of it (src/state/
 * timeline.svelte.ts: Delete, Ctrl+D, the nudge and a drag of selected keys, Ctrl+C / Ctrl+V), so keys, events and
 * the rest go together. Positions are played phases; each part is optional (an area without `move` stays put). The
 * areas are listed in src/app/motion/areas.ts.
 */
export interface AreaItems {
  /** Whether a selected item's track is this area's. */
  owns: (track: string) => boolean
  /** The played extent of its selected items (for where a duplicate goes and how far the selection can move). */
  span?: (view: AreaView, items: readonly SelectedItem[]) => [number, number] | null
  remove?: (view: AreaView, items: readonly SelectedItem[]) => Command[]
  /** Moved by `dv` of the played clip (already snapped and kept inside the clip by the timeline). */
  move?: (view: AreaView, items: readonly SelectedItem[], dv: number) => AreaEdit | null
  copy?: (view: AreaView, items: readonly SelectedItem[]) => AreaClip | null
  /** Put down with the earliest at played phase `at` (on a frame), in this clip or another. */
  paste?: (view: AreaView, clip: AreaClip, at: number) => AreaEdit | null
}
