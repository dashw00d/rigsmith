// A game unit as Rigsmith keeps it (workspace/game/units.json, spliced into the game's tools/rigsmith/units.json by
// Ship). One declaration for the server (server/game.ts), the export (tools/lib/unit_export.ts), the Ship step and
// Motion's slot list. Keys the game adds (tex, clan, glow, head, clan_trim, thrown, props, parts_tex, villager_parts,
// _note...) are kept as they are. Also what a unit export writes about its build (BuildRecord).
import type { ClipKey, HandPoseRef, Mount, Side, Slot } from './types.ts'

export interface UnitSpec {
  /** The Rigsmith character id. */
  character: string
  /** Game units, soles to the top of the head. */
  height: number
  /** LOD0 triangle budget (swapped parts not counted). */
  budget: number
  /** The clip names the game plays: each must be a slot name of the character. */
  clips: string[]
  /** LOD ratios of LOD0 (default [0.45, 0.15]). */
  lods?: number[]
  /** Split the body's own head off as its own mesh (a swappable head). */
  head?: { name: string, above?: number }
  /** Where this one's .glb goes instead of the models dir (relative to the game repo). */
  models_dir?: string
  /** Skipped by a build that names no units; cleared by the first export. */
  draft?: boolean
  companion?: CompanionSpec
  /** A dynamic character's unit (src/engine/folkpick.ts): the unit kind its file carries (Character.folk.kinds' id;
   * unset: every kind and set), and the pools it carries (pool ids or kinds: 'skin', 'cloth', 'hair', 'beard',
   * 'accessory'; unset: all; every unit in the game is a node per part, so a kind's file keeps to its own). Schema 4's
   * `outfits` (the sets it wears, by name) and `hair: false` (no hair or beard pools) are still read.
   * `sharedAtlasGroups`: authored groups whose pieces use identical embedded maps in one shared UV frame; preserve
   * those UVs instead of shrinking each piece into a cell. Export rejects unlike maps or material factors. */
  folk?: { kind?: string, pools?: string[], outfits?: string[], hair?: boolean, sharedAtlasGroups?: string[] }
  [k: string]: unknown
}

export interface CompanionSpec {
  character: string
  /** Its height in game units. */
  height: number
  /** Its bones' prefix (they share the unit's skeleton under root). */
  prefix: string
  budget: number
  /** Its surface, "Atlas_<material>". */
  material: string
  /** Where it stands from the unit's origin (game x, z) and which way it faces (degrees about +Y). */
  at?: [number, number]
  yaw?: number
  /** The feet whose planted one paces its walk (default: a horse's four). */
  feet?: string[]
  /** The unit rides it: the rider sits on its seat bone (the rider's mount), the horse's gait leads. */
  ridden?: boolean
  [k: string]: unknown
}

export interface GameSpec { units: Record<string, UnitSpec>, defaults?: Partial<UnitSpec>, [k: string]: unknown }

/** What a unit export built (<work dir>/<unit>/rigsmith.json, tools/lib/unit_export.ts). Read by the game
 * (emb_rigsmith.py: texture, the clip names, companion), by tools/game_import.py and by the Ship step. Every key a
 * schema 1 build wrote is kept except `scripts` (the slots and hands say it now). */
export interface BuildRecord {
  /** 4: `slots` are schema 4's (source time, pieces); 3: schema 3's (holds); 2: schema 2's. */
  schema: 4
  unit: string
  generator: string
  /** The run token the build was started with (RIGSMITH_RUN): the Ship job trusts a record only with its own. */
  run: string | null
  rigsmith: { commit: string, character: string, name: string, rig: string | null }
  /** Game units, and game units per character unit. */
  height: number
  scale: number
  bones: number
  triangles: { source: number, budget: number, lods: number[], head?: number[], parts: Record<string, number[]> }
  /** By the game's clip names. */
  clips: Record<string, BuiltClip>
  /** By mesh name: where each piece went, or why it was left out (`left`). */
  gear: Record<string, BuiltGear>
  companion?: BuiltCompanion
  /** The planted foot's speed in Walk and Run, game units a second (a rider's: his horse's). */
  walkStride: number | null
  runStride?: number | null
  mount?: Mount
  texture: { file: string, sha256: string } | null
  rigged: { file: string, sha256: string }
  /** The slots exported, as stored (schema 4: source time): everything, switched off or not, gear referred to by its
   * name. */
  slots: Slot[]
  /** The events file written beside the unit's GLB (<unit>.events.json; docs/motion-plan.md §6). */
  events: UnitEvents
  /** The character's hands.hold. */
  hands: Partial<Record<Side, HandPoseRef>>
  /** Every gear piece of the character by id (its handles' names by id, when it has any). */
  gearIds: Record<string, { name: string, from?: string, handles?: Record<string, string> }>
  /** What the build warned about, in words (also printed). */
  warnings: string[]
}

/** What the game reads beside a unit's GLB (<models dir>/<unit>.events.json, docs/motion-plan.md §6): per clip it
 * exports, whether it loops, how long it is and its events, `t` (and a span's `to`) phases 0-1 of the clip as exported
 * (a rider's after his horse's fit, a loop's repeated per cycle), sorted. The game falls back to a hit at 45 % without
 * it. */
export interface UnitEvents {
  unit: string
  schema: 1
  clips: Record<string, { loop: boolean, seconds: number, events: UnitEvent[] }>
  walkStride: number | null
  runStride: number | null
  /** The game clips that have variants (src/model/variants.ts: slots `Attack 2`... exported as `Attack_2`...), each with
   * every clip name it plays as, itself first: the game picks one at random. Unset when none has any. */
  variants?: Record<string, string[]>
  /** The companion's events (a pony beside it, the horse under it) on the same clips, by the unit's clip names: phases
   * of the clip as exported (the companion's tracks are in it), bones with its prefix. Only when it has any. */
  companion?: { prefix: string, clips: Record<string, { events: UnitEvent[] }> }
}

/** One event as the game reads it: the slot's own (docs/motion-plan.md §2.4), or its gear's (src/engine/geartracks.ts
 * gearEvents: `hide:<mesh>` / `show:<mesh>` where a piece hides and shows, `detach:<mesh>` / `attach:<mesh>` (`bone`:
 * who let go, who took it) where it changes bones). `sound`: 'mix:<id>' (a sound of the game's mix.json) or
 * 'file:sounds/<file>' (a file dropped in Rigsmith, copied to <work dir>/<unit>/sounds/<file>: the game's build installs
 * it as a mix sound); `volume` a gain on its level (1 as it is), `pitch` its playback rate (1 as it is). */
export interface UnitEvent { t: number, name: string, to?: number, sound?: string, bone?: string, volume?: number, pitch?: number }

export interface BuiltClip {
  /** The library clip and where it loads from. */
  clip: string
  url?: string
  loop: boolean
  inPlace: boolean
  speed: number
  /** Its length as baked (a rider's before it is fitted to his horse's). */
  seconds: number
  /** The library audit's complaints about the clip. */
  audit?: string[]
  /** Blow timing: the blow (seconds into the clip at its speed), the part kept, where in the clip the hit lands. */
  blow?: number
  kept?: [number, number]
  hit?: number
  /** Pace: the slot it follows and how much faster it plays for it. */
  pacedLike?: string
  retimed?: number
  /** The ground adjustment's lift, character units. */
  lift?: number
  /** Keys by bone and by gear name: their counts, and the keys themselves (game_import restores from them). */
  keys?: { bones?: Record<string, number>, props?: Record<string, number> }
  keyData?: { bones?: Record<string, ClipKey[]>, props?: Record<string, ClipKey[]> }
  /** The lesser foot's swing and the hips' median height, shares of the unit's height (src/engine/contract.ts). */
  footSwing?: number
  hipsMedian?: number
}

export interface BuiltGear {
  /** Why it was left out; nothing else is set then but its kind and swap set. */
  left?: string
  /** 'prop' (on a bone), 'clothing' (on the skin), 'part' (at a spot). */
  kind: 'prop' | 'clothing' | 'part'
  group?: string
  /** The bone it rides (skin and spot gear: the bone leading it). */
  bone?: string
  [k: string]: unknown
}

export interface BuiltCompanion {
  character: string
  triangles: { source: number, budget: number, lods: number[] }
  /** Its slots by the unit's clip names: what played and how it was fitted. */
  clips: Record<string, Record<string, unknown>>
  walkStride: number | null
  runStride?: number
  [k: string]: unknown
}
