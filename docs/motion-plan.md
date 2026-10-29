# Motion: one timeline (the binding plan)

The designer, 2026-10-29: "okay do all of that, hammer it out". This file says exactly how the Motion step becomes one
editable timeline over a non-destructive slot, so that several agents can build it at once. It extends
`docs/rebuild/DESIGN.md` (whose rules in §1 still hold: never write the user's checkout or the game, never touch
weights, comment in the code's own voice); where they disagree about slots, this file wins.

Foundation (this file's §1-§8) is built: the model, the time map, the migration, the commands, the one bake and the
export's events file. §9 says who builds the rest and which files each owns.

---

## 0. What changes, in one paragraph

A slot is **source clip + time map + tracks**, all non-destructive and all stored against the **source** clip's own
time, so changing the timing never moves a key, a window or an event. The bake (`src/engine/bake.ts`) resolves the
slot's time map once, maps every source-time item to a phase of the clip as it finally plays, then runs the stages it
always ran (hands, ground, keys, gear tracks) on that, unchanged. The viewer, the timeline and the game export all bake
the one way, so what the timeline shows is what the game gets. There is no editor mode, no editor-private undo and no
baking of new library clips to save: every edit is a named command in the character's journal (undo is the journal's),
and "Save as <clip>" is `slot.copy` (the designer wants to replace Attack or Run with what they made; losing the old one
is fine).

---

## 1. Source time

```ts
// src/model/types.ts
/** A moment of the slot's SOURCE clip: 0 its first frame, 1 its last, as the clip source retargets it (in place or
 * not, mirrored or not), before any timing. Past 1 is the source's last pose held, running on at the rate the clip
 * played (a late blow held: `time.fit.late: 'hold'`). At most MAX_U. */
export type SourceU = number
export const MAX_U = 16
/** [from, to] in source time. (Schema 2's windows were phases of the played clip; schema 3's are source time.) */
export type Window = [number, number]
```

Every stored time in a slot is a `SourceU`: key `u`, adjustment `windows`, event `u`/`to`, gear segment `u`, retime
marker `u`, hold `u`. Nothing stored is a phase of the played clip any more. What the timeline shows is played time;
it converts with the baked slot's `time` (§3.3) both ways.

A **hold** (§2.2) has no time of its own: an item at its `u` sits at the hold's start. The fit's held end (past 1)
does have time, so keys inside a late-blow hold (the longbowman's bow, keyed every frame) keep their places.

---

## 2. The slot (schema 3)

```ts
export interface Slot {
  id: string
  name: string
  clip: ClipRef
  /** The time map's first stage: the source played `speed` times as fast. */
  speed: number
  loop: boolean
  inPlace: boolean
  note?: string
  /** The rest of the time map (src/model/timemap.ts): the blow fit, pace, retime markers, holds. */
  time?: SlotTime
  /** Settings over source windows that stay settings (the inspector's): the ground, a hand's pose, a pull held. */
  adjustments: Adjustment[]
  /** The Body track: keyed turns (and the Hips' moves) per bone, in source time. */
  bones?: Record<string, ClipKey[]>
  /** The Gear tracks, by gear id: keys, who holds it, when it shows. */
  gear?: Record<string, GearTrack>
  /** The Events track: named moments, points or spans, exported to the game. */
  events?: ClipEvent[]
  /** Tracks switched off (kept, not played): 'bones', 'gear' (every gear piece's keys), 'bone:<name>', 'gear:<id>',
   * 'events'. */
  muted?: string[]
}
```

New fields are optional so a slot literal stays short (`{ id, name, clip, speed, loop, inPlace, adjustments: [] }` is a
whole slot); readers use `select.ts` (`slotKeys`, `gearTrackOf`, `eventsOf`, `isMuted`).

### 2.1 Adjustments that survive

```ts
export type Adjustment = AdjustmentBase & (
  | { kind: 'ground', lift: number }
  | { kind: 'handPose', hand: Side, pose: HandPoseRef, windows?: Window[], gear?: string }
  | { kind: 'handleHold', gear: string, handle: string, windows: Window[] }
)
```

Ground stays an inspector setting. Hand poses and handle holds are the Hands/Pulls track's bars: same shape, windows
now source time. Their rules are as before (one ground per slot; one hold per (gear, handle); a hand's handPose windows
never overlap; `gear` on a handPose belongs to that gear's carry handle).

### 2.2 The time map

```ts
export interface SlotTime {
  /** The blow fit: the slot's `hit` event (§2.4; none: the hand's fastest moment, measured) landed at `at` of the
   * played clip, or `window` seconds round it. A blow later than `at` cuts the start ('cut', default) or holds the
   * end ('hold': the source's last pose held past 1). */
  fit?: { enabled: boolean, at: number, late?: 'cut' | 'hold', window?: number, hand?: string }
  /** Retimed (uniformly) so its planted foot covers ground as fast as another slot's (measured at bake). */
  pace?: { enabled: boolean, like: string }
  /** Retime markers: source `u` plays at `to` (a phase of the source's length); piecewise linear between, with 0 -> 0
   * and 1 -> 1 implied. Edge-stretching a selection of keys in the timeline writes these. */
  markers?: Array<{ id: string, u: number, to: number }>
  /** The pose at source `u` held `seconds` (source seconds: they play faster with the speed, as the clip does). */
  holds?: Array<{ id: string, u: number, seconds: number }>
}
```

The stages, in this order (D: the source's seconds; T: seconds):

| stage | maps | what it reproduces |
|---|---|---|
| warp | S -> W = piecewise linear through the markers (S past 1: W = S) | new |
| holds | W -> τ = W·D + Σ seconds of holds with u < S (past 1: D + Σ + (S-1)·D) | new |
| speed | T1 = τ / speed | `retime(raw, speed)` |
| fit | the hit's T1 (its event mapped, or measured on the clip after speed: `blowTime`), then the kept range [start, end] in T1 (end past the clip: the held end); T2 = T1 - start | `blowCut` (its range math moved into `timemap.fitRange`, the same expressions) |
| pace | T3 = T2 / factor (factor = stride(like as it plays, no pace) / stride(this after fit)) | `paceTo` |

The played phase is `v = T3 / duration = (T1 - start) / (end - start)`. Speed and pace are uniform, so only the warp,
holds and fit change phases. Migrated slots have no markers or holds, so their clip is built by exactly the old calls
(`retime`, `blowCut`, `paceTo`), byte for byte; markers or holds resample the source on KEY_FPS frames first
(`timing.ts warpClip`).

### 2.3 Keys and easing

```ts
export type Ease = 'smooth' | 'linear' | 'ease' | 'step' | 'hold'
export interface ClipKey {
  u: SourceU
  q: Quat
  p?: Vec3
  /** The span from this key to the next. Unset: 'smooth' (a cubic through the keys, Catmull-Rom: what every key
   * was before). 'linear'; 'ease' (eases out of this key and into the next, stopping at both); 'step' (this key's
   * value until the next, then a jump); 'hold' (the bone held entirely: the clip's own motion on it stopped where
   * this key is, the key on top, until the next key). On gear, 'hold' is 'step'. */
  ease?: Ease
}
```

Body keys are `slot.bones[bone]`, gear keys `slot.gear[id].keys` (moves and turns from where the piece is placed, in
its placed frame, as before). Within a track keys are sorted by `u` and no two share a moment (|Δu| < 1e-6 is the same
moment; the reducer refuses it). A key's turn is on top of the clip's (q_clip · q_key), its move adds to the Hips'
position, as before. Keys sit on moments of the source; between them the tween runs in played time (a retimed span
plays its tween at the new rate; inside an interior hold a tween keeps moving unless its span is 'hold' or 'step').

### 2.4 Events

```ts
export const EVENT_NAMES = ['hit', 'release', 'swing', 'step.L', 'step.R', 'draw'] as const
export interface ClipEvent {
  id: string
  /** A built-in (EVENT_NAMES) or the user's own: a letter, then letters, digits, '.', '_' or '-' (32 at most). */
  name: string
  u: SourceU
  /** A span's end (after `u`); unset: a point. */
  to?: SourceU
  /** A sound played on it: an Emberhold mix.json sound id ('mix:<id>'), or a file dropped on the event, kept under
   * the character's folder ('file:sounds/<name>.<ext>'). */
  sound?: string
  /** Where it happens (an arrow leaves the hand): a bone of the skeleton. */
  bone?: string
}
```

Rules: ids unique in the slot; at most one point `hit` (the fit lands it; a span named hit is refused). The blow is
the `hit` event: picking the blow by hand (old `blowU`) sets it; "Find it" removes it (measured again at bake). A
slot whose fit is on and has no hit event still exports a `hit`: the measured blow, where the fit put it.

### 2.5 Gear tracks

```ts
export interface GearTrack {
  keys?: ClipKey[]
  /** Who holds it, from `u` on (segments sorted by u; before the first, its Gear attach bone). `place`: where it sits
   * on that bone (the bone's rest frame, as Placement); unset: wherever it was at `u`, so it changes hands without a
   * pop (Back -> Right hand at frame 12). */
  heldBy?: Array<{ u: SourceU, bone: string, place?: Placement }>
  /** Shown or hidden from `u` on (sorted; before the first, as Gear has it). */
  shown?: Array<{ u: SourceU, shown: boolean }>
}
```

The bake ignores `heldBy` and `shown` until C2's stage lands (§9); the commands keep them valid now.

### 2.6 The editor's build in the one bake (Phase B adds `ik`)

The clip editor builds its clip (`clipedit.ts buildEdit`) from the slot as it plays: bone keys, then per frame the
hands it put on handles held there by IK, leading gear on its path with the hands following, and a foot the edit sank
lifted back to the floor. The body is never solved in the build (DESIGN.md §8: "Solve body" keys what it moved, and
those are ordinary keys). That makes it deterministic and free of the pose model, so it can run in the bake in node.

Phase B adds to `Slot`:

```ts
  /** The build (src/engine/ikbuild.ts): hands kept on handles by IK, leading gear, the floor kept. */
  ik?: {
    /** A hand kept on a handle of a piece over `windows` (unset: the whole clip). */
    hands: Array<{ hand: Side, gear: string, handle: string, windows?: Window[] }>
    /** Pieces that lead: their keys (slot.gear[id].keys) are world moves and turns from where the piece rode in the
     * clip, about its own origin (clipedit.ts GearPath locked); the hands on them follow. */
    lead?: string[]
    /** A foot the build sank lifted back (default on when anything is built). */
    floor?: boolean
  }
```

and to the bake one stage, in place of "keys on bones" when `slot.ik` is set: `ikBuild(c, played, unkeyed, ctx)` =
`buildEdit(unkeyed, boneKeys, loop, rest, ctx.posable, rig, floor, limits, gearRig, height, null)` with the GearRig
assembled from the character and `slot.ik` (what `clipedit.svelte.ts` assembles today: handles' places, carriers,
fingers from the hand layers, shafts, grips, rest places), and `BakedSlot.gearKeys[id]` for each leading piece =
`propKeysOf(built, node, place, scale)` (per frame, final phases), so the export's Prop_ bones get the path without
gear nodes. RootHolds go (they were a live drag's softening, keyed by frame index; a drag commits keys).

---

## 3. The bake (src/engine/bake.ts)

### 3.1 Order

```
raw (clip source: inPlace, mirror)
 -> time: warp + holds (only when the slot has them) -> speed -> fit -> pace       (timing.ts, timemap.ts)
 -> resolve the TimeMap; map every source-time item to played phases                (bake.ts played())
 -> hands (handLayers/applyHands on the played slot: windows are played phases)    (hands.ts, unchanged)
 -> ground (+ autoGround)                                                           (unchanged)
 -> keys on bones (eases)            [Phase B: ikBuild here when slot.ik]           (keys.ts)
 -> gear tracks (keys)               [C2: heldBy / shown here]                      (bake.ts gearTracks)
 -> events (played phases)                                                          (bake.ts)
```

`skip` takes 'speed', 'time' (fit, pace, markers, holds), 'fit', 'pace', 'hands', 'ground', 'keys' (bones and gear
keys), 'events', or 'all' (the clip alone: speed 1, no time, no hands, no adjustments, no tracks).

### 3.2 BakedSlot

```ts
export interface BakedSlot {
  clip: THREE.AnimationClip; raw: THREE.AnimationClip; unkeyed: THREE.AnimationClip
  cut?: { start: number, end: number, uncut: number, blow: number }   // as before (seconds at the slot's speed)
  lift: number
  /** The time map as resolved for this bake (the hit measured, the pace factor): source <-> played. */
  time: TimeMap
  /** Played phases (as before), the record's keyData. */
  boneKeys: Record<string, ClipKey[]>
  gearKeys: Record<string, ClipKey[]>
  pulls: PullPlan[]
  hands: Record<Side, HandLayer[]>
  /** Played phases of the final clip; the hit included when the fit measured it. */
  events: BakedEvent[]
  report: Record<string, unknown>   // keyed 'fit', 'pace', ground/adjustment ids, 'keys', 'hands', 'autoGround'
}
export interface BakedEvent { id: string, name: string, t: number, to?: number, sound?: string, bone?: string }
```

`bakeRide` repeats `events` over the rider's cycles as it repeats pulls and gear keys.

### 3.3 TimeMap (src/model/timemap.ts, pure: the model, the migration and the app use it)

```ts
export interface TimeMap {
  /** Seconds of the played clip. */
  duration: number
  /** Played phase of a source moment, and back (inside an interior hold: its u; in the held end: past 1). */
  toPlayed (u: SourceU): number
  toSource (v: number): SourceU
  /** The played part of the source: toSource(0), toSource(1). */
  range: [SourceU, SourceU]
}
export function resolveTime (s: TimeInput): TimeMap
export function windowsToPlayed (map, w: Window[]): Window[]   // clipped to [0, 1]; empty spans dropped
export function windowsToSource (map, w: Window[]): Window[]
export function keysToPlayed (map, keys: ClipKey[]): ClipKey[]
export function fitRange (blow, duration, fit): [start, end]    // blowCut's range, shared
export function fitBlow (u, duration): number                   // blowCut's clamp of a picked blow, shared
```

`TimeInput` = `{ seconds (D), speed, time?: SlotTime, hit?: SourceU, measuredHit?: number (T1 seconds), pace?: number
(factor) }`. The engine measures (hit, pace) and resolves once per bake; the UI only ever uses `baked.time`.

---

## 4. Commands (src/model/command-types.ts, src/model/commands/clips.ts)

Every edit is one named command (or one batch: one journal entry, one undo). Undo is the journal's (entity
`slot:<id>`); the app's optimistic copy runs the same reducer.

| command | does | rules |
|---|---|---|
| `slot.add {slot, index?}` | a new slot (v3 shape) | name free; every field checked as below |
| `slot.update {id, patch}` | name, speed, loop, inPlace, note, `muted` | muted entries well formed |
| `slot.fill {id \| name+newId, clip, speed?, loop?, inPlace?, keepAdjustments?, adjustments?, time?, bones?, gear?, events?, note?}` | a clip into a slot; without keepAdjustments everything tuned for the old clip goes (adjustments, time, tracks, events); the given parts are added | as slot.add |
| `slot.copy {from, to? \| name+newId}` | "Save as <clip>": `from`'s clip, speed, time, adjustments, tracks and events copied over `to` (which keeps its id, name, loop and in place) or into a new slot (taking `from`'s loop and in place). Pace on a copy of itself goes | to ≠ from |
| `slot.remove {id}` | also drops other slots' pace following it | |
| `slot.reorder {ids}` | | |
| `slot.adjust.add / update / remove / set` | ground, handPose, handleHold only (400 for blowTiming, pace, keys: "now slot.time / slot.keys.set") | as before, windows in source time |
| `slot.time {slot, patch: {fit?, pace?, markers?, holds?}}` | each given part replaced whole; null removes it | fit.at in 0..1, window > 0; pace.like another slot; markers strictly increasing in u and to, inside (0, 1); holds' u in 0..1 distinct, seconds > 0 |
| `slot.keys.set {slot, tracks: [{bone \| gear, keys}]}` | each named track replaced by these keys (empty: the track goes). Every key operation (insert, delete, drag, box move, stretch, duplicate, typed frame, paste, mirror, tween, easing, range falloff) is computed by a pure helper and sent as this | bone in the skeleton; gear exists; keys sorted, distinct moments, u in 0..MAX_U |
| `slot.event.add {slot, event}` / `.update {slot, id, patch}` / `.remove {slot, id}` | the Events track | §2.4 |
| `slot.gear.update {slot, gear, patch: {heldBy?, shown?}}` | who holds a piece, when it shows (null clears) | bones in the skeleton; segments sorted by u, distinct |
| `clips.replace {slots, gearNames?, handleNames?}` | as before; gear tracks and muted `gear:<id>` mapped by name too | |

Journal lines in plain words ("clip Attack: 3 keys on RightArm", "clip Attack: hit at 52%", "clip Attack: held by
RightHand from 40%"). Phases in journal lines are source percentages.

Gear and hands reducers follow references into the new fields: `gear.remove` drops the piece's gear track (and its
`gear:<id>` mute); `gear.attach` off a bone drops its track; `hands.pose.remove` as before (handPose stays an
adjustment). `select.freshSet` re-ids events and markers/holds and remaps `time.pace.like`.

---

## 5. Schema 3 migration (src/model/migrate.ts)

`migrate(raw, ctx)`: v1 -> v2 (DESIGN.md §2.3, unchanged) -> v3. Pure and deterministic (new ids are `stableId(<char>:
<what>:<i>)`), idempotent (v3 in, v3 out). Per slot:

| schema 2 | schema 3 |
|---|---|
| `blowTiming {enabled, at, blowU?, late?, hand?, window?}` | `time.fit {enabled, at, late?, window?, hand?}`; `blowU` -> event `{name: 'hit', u: blowU}` |
| `pace {enabled, like}` | `time.pace {enabled, like}` |
| `keys {enabled, bones, gear}` | `bones`, `gear[id].keys`; disabled: `muted: ['bones', 'gear']` |
| `ground`, `handPose`, `handleHold` | kept |
| every key `u` and window (played phases) | source time: through the v2 cut when the blow fit was enabled (`S = a + v·(b − a)`, [a, b] the kept range in source phases; b past 1 when the end was held); unchanged otherwise (speed and pace are uniform) |
| adjustment notes | kept on what they became (fit/pace notes: on the slot's journal note line) |

The cut needs the source's length (and, for a measured blow, the blow): `MigrateContext.clipTimes: Record<slotId,
{ seconds: number, blow?: SourceU }>`, filled by `src/engine/measure.ts measureClipTimes(c2, bakeContext)` for every
slot with a blowTiming. Who fills it:

- `server/store.ts migrationContext` runs `node tools/measure_clips.ts <id>` (a child: three's headless shims stay out
  of the server) for a rigged character with any enabled blow fit and keys or windows on that slot.
- `tools/migrate.ts` measures in its own process.
- Without it (a pure read of an old file: `readCharacter`), a slot that needs it throws ("run node tools/migrate.ts
  or open Rigsmith") under `{ strict: true }` (node3d's `character()`), and is kept unconverted with a note otherwise
  (the server when the measure failed: the clip is missing, so it can't play either).

The measured blow is used for the conversion only; the fit stays "measured" (no hit event), so the bake measures it
again, the same way, and a migrated slot bakes to the same frames (the test: §8).

Files: `character.v2.json` keeps the schema 2 file (once), as `character.v1.json` kept v1 (a v1 file goes straight to
3 and keeps only its v1 copy). One journal entry `what: 'migrate'` with the notes. `tools/migrate.ts --check` also
checks, for each character with a `character.v2.json`: migrating it again gives the current slots; every converted
key, window and hit maps back (`toPlayed`) to its v2 phase within 1e-9; Python readers accept schema 2 or 3
(`tools/verify_autorig.py`, `tools/game_import.py`).

Settings are unchanged (schema 2).

---

## 6. The game: events per unit

`exportUnit` writes, next to the unit's GLB, `<models dir>/<unit>.events.json` (and the same under the build record's
`events` key):

```json
{
  "unit": "archer",
  "schema": 1,
  "clips": {
    "Attack": { "loop": false, "seconds": 1.033, "events": [ { "t": 0.45, "name": "hit" } ] },
    "Walk":   { "loop": true,  "seconds": 1.1,   "events": [] }
  },
  "walkStride": 1.005,
  "runStride": 2.683
}
```

- `t` is a phase 0-1 of the FINAL clip (as exported: a rider's after the ride fit; a loop's repeated per cycle), `to`
  a span's end, `sound` as stored ('mix:<id>' or 'file:<path>'; C1 decides how a file reaches the game), `bone` the
  game bone (Mixamo names; `root` above Hips). Sorted by `t`.
- Every clip the unit exports is listed; a companion's clips are under `"companion": {"clips": {...}}` with its
  prefix's names.
- The record (`rigsmith.json`) gets `schema: 3`, `slots` as stored (v3, gear by name), and `events` (this object).

The GLB itself does not change (§8 checks it byte for byte for the workspace units).

---

## 7. Module map (foundation)

| file | what |
|---|---|
| `src/model/types.ts` | Slot, SlotTime, ClipKey (ease), ClipEvent, GearTrack, Adjustment (3 kinds), SCHEMA 3, MAX_U |
| `src/model/v2.ts` | the schema 2 slot shapes (what migration and the v2 build records read) |
| `src/model/timemap.ts` | resolveTime, TimeMap, fitRange/fitBlow, window/key/event conversions, warp and holds math |
| `src/model/migrate.ts` | v1 -> v2 -> v3, `slotFromV2`, MigrateContext.clipTimes, strict |
| `src/model/commands/clips.ts` | every slot command (§4) |
| `src/model/select.ts` | `slotKeys`, `gearTrackOf`, `eventsOf`, `isMuted`, `hitOf`, freshSet, gearKeysFromPaths (now `{id: {keys}}`) |
| `src/engine/timing.ts` | blowCut/paceTo (unchanged numbers, range math from timemap), `warpClip`, `timeSlot` |
| `src/engine/keys.ts` | sampleKeys with eases, applyBoneKeys ('hold') |
| `src/engine/bake.ts` | §3 |
| `src/engine/measure.ts` | measureClipTimes (migration) |
| `tools/measure_clips.ts` | the server's child for it |
| `tools/lib/unit_export.ts` | events JSON, record schema 3 |
| `tests/equivalence/*` | §8 |

---

## 8. Proof (tests/equivalence)

- `bake_v2.ts`: the schema 2 bake frozen as it was (bake.ts at b281970, its imports unchanged modules), on the v2
  documents (`character.v2.json`, or `character.json` while it is still 2).
- For each of the six workspace characters (archer, knight (rides), spearman, longbowman, horse, horse-archer
  (rides)), every slot baked by `bake_v2` on the v2 document and by `bakeSlot` on `migrate(v2, measured ctx)`: same
  duration (1e-9), same track names, every track's values at every frame within 1e-6 (quaternion components, metres);
  gear keys, pull windows and hand-layer windows in played phases within 1e-9; riders through `bakeRide` too.
- The export: the five workspace units' GLBs byte-identical to the baseline built before the change (run by hand,
  reported), and each `<unit>.events.json` has only the migrated `hit`s.
- Unit tests: `timemap.test.ts` (identity, speed, fit cut/hold/window, pace, markers, holds, round trips),
  `migrate.test.ts` (v2 -> v3 rows, the cut conversion, strict, backups), `commands.test.ts` (every new command and
  rule), `keys.test.ts` (eases).

---

## 9. The parallel build after the foundation

Shared contract files (`types.ts`, `command-types.ts`, `commands/clips.ts`, `bake.ts`, `timemap.ts`): change them
only additively, each change noted in §10; a new bake stage is one call in `bake.ts` to a function in the agent's own
module. Never edit another agent's files; if you must, the smallest edit, reported. Commit in logical commits on your
branch; the full suite at the end.

### B: the timeline, key editing, the editor merged into Motion

Owns `src/app/motion/**` (except the subfolders below), `src/app/steps/MotionPanel.svelte`, `src/state/{animator,
slots,library,adjust,timeline}.svelte.ts`, `src/state/clipedit.svelte.ts` and `src/app/editor/**` (to dissolve),
`src/engine/{clipedit,PoseEditor,ikbuild}.ts`, `src/model/keyedit.ts` (new: pure key operations).

- Motion = clip list -> one track timeline -> inspector of the selection. Tracks: Summary (every key), Body (rows by
  limb, expanding to bones), Gear per piece (keys; C2 adds Held by and Shown strips), Hands/Pulls (handPose and
  handleHold bars), Events (C1 fills), Time (speed, markers, holds, the hit). Ground and hand poses in the inspector.
- Key editing: click, shift/box select across tracks, drag (snaps to frames; Alt free), edge-stretch a selection
  (writes keys' u; with "retime the clip too" writes markers), duplicate (Ctrl+D), delete, a typed frame, all through
  `keyedit.ts` helpers -> `slot.keys.set`. Selection lives in `src/state/timeline.svelte.ts` (track refs + key u's).
- Loop region and zoom on the ruler; frames shown, played time; every displayed position from `baked.time.toPlayed`,
  every write through `toSource`.
- The editor's posing (gizmo, IK drag, Solve body, Naturalize) works on the selected slot directly: a drag ends in
  `slot.keys.set` (one undo), handles in `gear.handle.*`, hands on handles in `slot.ik` (add the field and its
  command `slot.ik {slot, patch}` per §2.6, and `ikBuild` as the bake's stage). No editor undo stack, no "Save":
  `slot.copy` is "Save as <clip>". Naturalize writes keys (every frame it moved) through `slot.keys.set`.
- Preview into Idle (the clip, then the character's Idle, as the game blends): the animator's.
- Attack/death variants are C2's; onion skins, tween and the pose tools C3's: leave them their hooks (a
  `timeline.selection` read API, an `animator.onTick`, the posable copy).

### C1: events, sounds, export, Emberhold's reader

Owns `src/app/motion/events/**`, `src/state/events.svelte.ts`, `server/routes/sounds.ts` (dropped files ->
`characters/<id>/sounds/`, `GET` mix ids from `<gameRepo>/.../mix.json`), the events part of `tools/lib/unit_export.ts`
(`eventsOf`/`writeEvents`: already writes §6; C1 adds sound files), and the Emberhold reader (in the game repo, by a
later agent: UnitView reads `<unit>.events.json`, schedules hits/sounds/spawns from `t`, falls back to 45 % without
it).

- The Events track: add (built-ins menu or a name), drag, span edges, delete, sound picker with live preview on
  playback (the animator's onTick crossing `t`), bone picker. Commands `slot.event.*`.
- Edit the `hit` from the Time track or the Events track: the same event.

### C2: gear held by / shown, attack and death variants

Owns `src/engine/geartracks.ts` (new: heldBy/shown -> tracks on the gear node in its attach bone's frame: a hand-off
is that bone's inverse times the new holder's pose times the place, so it needs no reparenting and the export's
`Prop_` bone under the attach bone plays it; shown is a stepped scale 1/0), its call in `bake.ts` (after gear keys),
the Prop_ bones for such gear in `unit_export.ts` (the keyed set is gearKeys ∪ gear with heldBy/shown),
`src/app/motion/gear/**`, `slot.gear.update` UI. Variants: slots named `<Clip> 2`, `<Clip> 3` export as
`<Clip>_2`...; the events file lists `"variants": {"Attack": ["Attack", "Attack_2"]}`; Emberhold picks one at random.

### C3: pose tools

Owns `src/model/posetools.ts` (copy/paste pose as keys at a moment; paste mirrored (Left<->Right, the turn mirrored
across the character's YZ plane); tween between neighbours (a slider 0-1 writing one key per bone); range edit with
falloff (a change at a moment spread over a range with a smooth falloff); loop seam: match the last frame to the
first (keys at both ends equal), blend across the seam), `src/engine/onion.ts` (ghost poses at ±N frames from the
baked clip), `src/app/motion/pose/**`, the easing UI (per span menu writing `ease` through `slot.keys.set`).

---

## 10. Change log

- Foundation (this branch): schema 3 as above.
