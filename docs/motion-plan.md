# Motion: one timeline (the binding plan)

The designer, 2026-10-29: "okay do all of that, hammer it out". This file says exactly how the Motion step becomes one
editable timeline over a non-destructive slot, so that several agents can build it at once. It extends
`docs/rebuild/DESIGN.md` (whose rules in §1 still hold: never write the user's checkout or the game, never touch
weights, comment in the code's own voice); where they disagree about slots, this file wins.

Foundation (this file's §1-§8) is built: the model, the time map, the migration, the commands, the one bake and the
export's events file. §9 says who builds the rest and which files each owns.

Schema 4 (§11) builds a slot's source from **pieces** (ranges of clips or of other slots, held poses) and drops
schema 3's holds (§2.2's `holds`, their timemap stage and UI): where §1-§8 speak of holds, read hold pieces.

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
  /** Who holds it, from `u` on (segments sorted by u; before the first, its Gear attach bone). Where it sits there,
   * the first given of: `place` (rest space, as Gear's placement: where it would be at rest, carried by that bone);
   * `handle` (one of its carry or grip handles, on the hand it is for); `placed` (its Gear placement, on its attach
   * bone); none: wherever it was at `u`, so it changes hands without a pop (Back -> Right hand at frame 12). */
  heldBy?: Array<{ u: SourceU, bone: string, place?: Placement, handle?: string, placed?: true }>
  /** Shown or hidden from `u` on (sorted; before the first, as Gear has it). */
  shown?: Array<{ u: SourceU, shown: boolean }>
}
```

The bake plays them (`src/engine/geartracks.ts`, §10 C2); the commands keep them valid (a handle one of the piece's carry
or grip handles on the hand it is for, `placed` only on its attach bone, one of place, handle, placed).

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
  duration: number                 // seconds of the played clip
  uncut: number                    // seconds after speed (and markers and holds), before the fit: `kept` is in these
  kept: [number, number]           // the fit's kept range ([0, uncut] without one)
  toPlayed (u: SourceU): number    // a played phase (outside 0..1: played before or after)
  toSource (v: number): SourceU    // inside an interior hold: its u; in the held end: past 1
  range: [SourceU, SourceU]        // toSource(0), toSource(1)
}
export interface TimeInput { seconds: number, speed: number, time?: SlotTime, kept?: [number, number], pace?: number }
export function resolveTime (s: TimeInput): TimeMap
export const IDENTITY: TimeMap                                  // as stored (a slot not playing)
export function windowsToPlayed (map, w), windowsToSource (map, w), keysToPlayed (map, keys), eventToPlayed (map, e), sourceAt (map, v)
export function fitRange (blow, duration, fit): [start, end]    // blowCut's range, shared
export function fitBlow (phase, duration): number               // blowCut's clamp of a picked blow, shared
export function phaseBeforeFit (u, s): number                   // a hit's phase of the clip before the fit (u itself when plain)
```

The engine does the measuring (the blow, when the slot has no hit; the pace's stride ratio) in `bake.ts timeSlot`,
then resolves the map from the kept range blowCut returned, so the map is exactly what was played. With neither
markers nor holds the map is schema 2's arithmetic (and with no fit, `v = S` bit for bit). The UI only ever uses
`baked.time` (or `IDENTITY` when the slot isn't playing).

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
  of the server) when `needsClipTimes(raw)`: an enabled blow fit and keys or windows on that slot.
- `tools/migrate.ts` measures in its own process (`tools/lib/node3d.ts measureCharacter`).
- Without it, `readCharacter` (strict: every tool, node3d's `character()`) throws "run node tools/migrate.ts (or open
  Rigsmith)"; `migrate` without strict keeps that slot's phases unconverted with a note only where the clip doesn't
  exist (it can't play either). A measure that failed otherwise (the child crashed or timed out, its output unread, the
  clip not loading) writes nothing: the character stays at v2, the error said, and the next read measures again
  (`migrate.ts unmeasured`, server/store.ts migrationContext, tools/migrate.ts).
- A v1 file goes straight to 3: v1 laid hand windows on before its blow cut, so its windows are source time already
  (only its keys move); schema 2 had kept them as they were with a "check them" note.
- A schema 2 build record (restore, `tools/game_import.py`) is moved the same way, through the cut it records (its
  clips' `blow`) and the library clip's length from the manifest; without the length, unconverted with a note.

The measured blow is used for the conversion only; the fit stays "measured" (no hit event), so the bake measures it
again, the same way, and a migrated slot bakes to the same frames (the test: §8).

Files: `character.v2.json` keeps the schema 2 file (once), as `character.v1.json` kept v1 (a v1 file goes straight to
3 and keeps only its v1 copy). One journal entry `what: 'migrate'` with the notes. `tools/migrate.ts --check` also
checks, for each character with a `character.v2.json`: migrating it again gives the current slots; every converted
key, window and hit maps back (`toPlayed`) to its v2 phase within 1e-9. Python readers of character files require
schema 3 (`tools/verify_autorig.py`, `tools/game_import.py`); `game_import.py` sends build records of schema 2 or 3 to
restore, which reads either. The `x-rigsmith-schema` header takes 2 or 3 (the document either way; the app and tools
send 3).

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

- `t` is a phase 0-1 of the FINAL clip (as exported: a rider's after the ride fit; a loop's repeated per cycle; a
  clip a companion beside the unit repeated or lengthened, placed in the whole), `to` a span's end, `sound` 'mix:<id>'
  (a sound of the game's mix.json) or 'file:sounds/<file>' (a file dropped in Rigsmith: copied to
  `<work dir>/<unit>/sounds/<file>`, which the game's `build.sh` installs as a mix sound of its own and renames the
  event's sound to), `bone` the game bone (Mixamo names; `root` above Hips), `volume` a gain on the sound's level and
  `pitch` its playback rate (each only when not 1). Sorted by `t`.
- Every clip the unit exports is listed (`tools/lib/unit_export.ts eventsFile`, times rounded to 1e-4). A companion's
  events (a ridden horse's, as `bakeRide` fitted its clip: `horseEvents`; a pony's, as its fit placed it) go under
  `"companion": {"prefix": "Horse_", "clips": {"Walk": {"events": [...]}}}` (same clip names, phases of the same
  clip, bones prefixed), only when it has any.

```json
{ "unit": "knight", "schema": 1,
  "clips": { "Attack": { "loop": false, "seconds": 0.556, "events": [
    { "t": 0.2, "name": "swing", "to": 0.4, "sound": "mix:sword_blow" },
    { "t": 0.45, "name": "hit" },
    { "t": 0.5, "name": "release", "sound": "file:sounds/twang.wav", "bone": "LeftHand", "volume": 0.8, "pitch": 1.1 } ] } },
  "walkStride": 1.677, "runStride": null,
  "companion": { "prefix": "Horse_", "clips": { "Walk": { "events": [
    { "t": 0.25, "name": "step.FL", "bone": "Horse_front_leg_foot_l", "sound": "file:sounds/horse_hoof.wav" } ] } } } }
```
- The record (`rigsmith.json`) gets `schema: 3`, `slots` as stored (v3, gear by name), and `events` (this object).
- Gear events (C2, `geartracks.ts gearEvents`), among each clip's own: `hide:<mesh>` / `show:<mesh>` where a piece hides
  and shows again (a hide at 0 when it starts hidden), `detach:<mesh>` (`bone`: who let go) and `attach:<mesh>` (`bone`:
  who took it) where it changes bones. `<mesh>` is the piece's mesh name in the GLB (`contract.ts meshNameOf`).
- Variants (C2, `src/model/variants.ts`): a slot named `<Clip> <n>` (n from 2) of a game clip exports as `<Clip>_<n>`
  (its horse or companion playing `<Clip>`'s), and the file gets `"variants": {"Attack": ["Attack", "Attack_2"]}` (each
  clip that has any, itself first; the key is left out when none has any). The game picks one at random.

The GLB itself does not change (§8 checks it byte for byte for the workspace units).

---

## 7. Module map (foundation)

| file | what |
|---|---|
| `src/model/types.ts` | Slot, SlotTime, ClipKey (ease), ClipEvent, GearTrack, Adjustment (3 kinds), SCHEMA 3, MAX_U |
| `src/model/v2.ts` | the schema 2 slot shapes (what migration and the v2 build records read) |
| `src/model/migrate.ts` also | `slotToV2` (a slot in schema 2's shape, times as they are: the v1 view, `rig.ts show`, the Motion stack's rows) |
| `src/app/motion/rules.ts rowsOf`, `src/state/adjust.svelte.ts` | the transitional Motion stack: fit, pace and keys as rows (ids 'fit', 'pace', 'keys'), every edit routed to the schema 3 commands, windows shown and written through `baked.time` (B replaces them) |
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

- Foundation (this branch): schema 3 as above. Built as planned, except: the pure `TimeInput` takes the fit's kept
  range rather than the hit (§3.3); `ik` (§2.6) is a design for B, not in `types.ts`; the events file has no
  companion clips yet (§6); v1 windows count as source time (§5); `readCharacter` is strict. Proven on the workspace:
  every slot of the six characters bakes to the same tracks (largest difference 0, `tests/equivalence/bake.test.ts`),
  riders ridden too, and the five units' GLBs export byte for byte the same as before the change (checked by hand
  against a build of b281970); the build records differ only in the last digit of a few converted keyData phases.
- B (the timeline, key editing, the editor merged into Motion; branch motion-timeline). Built as §9 B says, except:
  - **slot.ik** is §2.6's shape (`SlotIk`, command `slot.ik {slot, patch: {hands?, lead?, floor?}}`, each part replaced
    whole, null removes it, the whole ik gone when no hand and no lead is left). A hand with windows is on or off frame
    by frame (no blend in or out). The bake leaves the shafts and grips out of the build's rig (only the body solver
    reads them: `ikRig(..., {measure: true})`), and the shaft gap is a fixed fist width, so the export, whose body has
    no gear meshes when it bakes, builds the same. A body lacking a piece's node gets an empty one hung as the viewer
    wears a piece (garments.ts boneFrame: the bone's rest frame undone, then the placement); hanging it straight on the
    bone had put a held hand's goal elsewhere than the viewer's (fixed; `ikbuild.test.ts` now builds its viewer copy
    with boneFrame). The build's height is `heightOf(c)` (the editor used the view's). `BakeContext.rom` gives the
    joints' ranges (browser: fetched; tools: `node3d.ts nodeRom`) and `ClipSource.sourceRest` the clip's own skeleton
    they are mapped through. RootHolds stay in the engine's types (inert: nothing makes them).
  - Checked: the spearman's Attack with his left hand on a grip by ik, baked in the browser (the animator's context)
    and by the export's context in node (a script sampling `bakeSlot(..., {gearNodes: false})`): every arm, spine and
    hips track equal within 1.1e-6 on every frame. Slots without ik bake as before (tests/equivalence).
  - **Posing** is `src/state/pose.svelte.ts` (clipedit.svelte.ts and src/app/editor/** are gone): keys are relative
    to `baked.unkeyed` at the player's time, on the frame shown snapped to a frame of one cycle; the pose dragged is
    held on stage (`animator.holding`) until the slot baked with its keys plays. A grip made by letting a hand go on a
    shaft is `gear.handle.add` + `slot.ik` in one batch. Naturalize keys every frame of every bone it moved (but the
    arms held on gear). Not kept: "New clip from this frame", opening a library preview or "the clip alone" to edit,
    reopening a custom clip's edit record (fill a slot from the library, then pose it), the editor's unsaved/discard
    flow. The server's edit routes (`server/routes/edits.ts`) and `api.saveEdit` are left for now, unused by the app.
  - **The timeline** (`Timeline.svelte`, `tracks.ts`, state in `timeline.svelte.ts`): area lanes are mounted in a
    row whose label column (172 px) is the timeline's; an area's lane gets the lane's own pixels (`view.toX` from 0 at
    the lane's left edge), so its row labels belong in the timeline's column, not over the lane (C1: the Events row's
    label is "Events" with the events' mute eye; sub-rows of your own should keep their labels inside your lane's
    height or say what you need). Positions are one cycle of a ridden loop (`baked.time` is the slot's own map;
    `animator.playing.phase` the phase in that cycle). The preview's loop is `animator.loop`.
  - Delete acts across tracks for keys, events (`slot.event.remove`), hand bars (`slot.adjust.remove`, `slot.ik`),
    markers and holds; Ctrl+D, Ctrl+C/V and moves are keys only (events' duplicate/nudge are C1's helpers to call at
    merge). Arrow keys step frames (↑ ↓ jump keys), not nudge.
  - The settings stack (ground, blow fit, pace, hand poses, holds: `AdjustmentStack`) stays under the inspector,
    without its keys row; a hand bar or a Time item selected opens its setting there.
  - Variants: listed under their game clip (`rules.ts variantOf`, to be replaced by C2's `src/model/variants.ts`),
    `AddVariant.svelte` mounted on each filled game clip row (a placeholder here).
  - The preview into Idle isn't offered for a rider (the horse's clip would need the same blend).

- C2 (branch `motion-gear`): gear held by / shown and variants, as §9, except:
  - `heldBy` segments gained `handle` (a carry or grip handle of the piece: the hand's wrist on it as the handle says)
    and `placed` (its Gear placement on its attach bone: sheathed again); `place` is rest space, like Gear's placement
    (§2.5). `slot.gear.update` checks them; `clips.replace` maps handles by name (a handle not found here: where it is).
  - The stage is one call in `bake.ts` after the gear keys (`holdGear`), skipped with 'keys'; a muted `gear:<id>` mutes
    the piece's holds and hidden spans too. What it resolved is `BakedSlot.gearHolds` (played phases, every holder's
    place found; `bakeRide` repeats it per cycle), so the export plays the same places. A switch that jumps (a handle, a
    placement) is a step a ten-thousandth of a second wide; a no-pop switch keeps the world pose (7e-8 on the workspace
    spearman). A piece hidden in any clip of the character gets a size track in every clip (constant elsewhere), so a
    clip that hid it never leaves it hidden; characters that hide nothing get no new tracks.
  - The export's Prop_ bones are for gearKeys ∪ gearHolds; their moves come from the bake's holds sampled on the clip
    as baked (`holdTracks`, the character's own units, moves times the game scale). Gear events reach the events file
    through `eventsFile`'s new optional `more.gear` (and `more.variants`): C1's writer should keep passing them through.
  - A rider's holds are resolved before the ride freezes his hips and legs: a piece handed to or from a frozen bone
    (Hips, a leg) may sit off in the ride (none of the workspace riders do that).
  - Mount points for B: `GearLanes`/`GearInspector` as lanes.ts says (selection tracks `held:<id>` with the entry's
    index as id, -1 the first segment, and `shown:<id>` with the hidden span's index); `src/app/motion/variants/
    AddVariant.svelte {character, name, names}` on each filled game clip row of the slot list (`names` the game's clip
    names). Variant slots are trials to `rules.ts isTrial` today: show them under their clip (`variantOf`).
  - Unverified in the live app: the components ran against a harness (commands applied locally), not inside B's
    timeline.

- C3 (pose tools, branch motion-pose): built as §9 says. `src/model/posetools.ts` (pure: no three; poses, rest frames
  and a key sampler handed in): `copyPose`, `mirrorName` (Left/Right with or without `mixamorig:`, `_l`/`.L`),
  `mirrorPose` (a bone's turn from rest in the character's axes, its parent at rest, G = P·L·R⁻¹·P⁻¹, reflected
  (x, -y, -z, w) and put on the other side's bone; mirrored down a chain, world turns are mirrored whatever the bones'
  own axes), `pastePose` (key = unkeyed⁻¹ · pose at the moment; the Hips' height only by default; an unkeyed bone already
  there gets no key; a first key pins the clip's ends, the editor's rule), `tween` / `pushRelax` (between the
  neighbouring keys, round a loop), `spreadChange` + `falloff` / `rangeWeight` (range edit: key' = key · change^w over
  the range, keyed at its ends, the moment, its keys and up to four frames a side; the spans out of it that join equal
  keys eased, so a Catmull-Rom tangent doesn't leak the change past the ends), `seamJump` / `jumping` (SEAM_EPS 1e-4 rad)
  / `matchEnds` / `blendSeam`, `setEase` / `easeOf`, `putKey` (a key put over one at its moment keeps its ease; between
  keys it takes the span's ease, so it holds in a held span). `src/engine/onion.ts`: `poseAt` (a clip's local pose by
  rest names, no mixer), `restFrames`, `keySampler`, `framePhase`, `onionTimes`, `OnionSkins` (`show(view, clip, at,
  {before, after, step, keys?, loop})`, `hide`, `dispose`; one group under `stage.scene`, worked out only when the moment
  or clip changes: 0.23 ms a playhead move for six ghosts). The toolbar: `src/app/motion/pose/{PoseToolbar.svelte,
  tools.ts, pose.svelte.ts}`. Range edit is a button, not a live mode: the range keeps the Body track as it was when
  set, and **Spread change** spreads what changed at the playhead since then. A spread done automatically after each
  drag would come back after Undo.
  - **Shortcuts taken (B: leave these):** Ctrl+Shift+C and Ctrl+Alt+C (copy pose), Ctrl+Shift+V (paste), Ctrl+Alt+V
    (paste mirrored), Alt+O (onion skins), Esc while the tween slider drags (cancel). They are window keydown handlers
    that skip text fields and events already `defaultPrevented`. Browsers may keep Ctrl+Shift+C for DevTools' inspector;
    Ctrl+Alt+C is the fallback.
  - **What the toolbar needs from B:** the TimelineView as lanes.ts has it, reactive (playhead, selection, baked and slot
    read in `$derived`/`$effect`); `selection` items on `body:<bone>` / `gear:<id>` tracks with `u` the key's source
    phase; `frames` the clip's frame count as `rules.ts framesOf` gives it; `snap` to frames. It also reads
    `animator.view` (the rest skeleton, the bones it previews on), `animator.stage` (onion skins), `animator.time`,
    `animator.seek`, `animator.setPlaying` and `animator.holding` (set while the slider drags, so the player doesn't
    write over the preview); keep them, or hand them through the view. The toolbar needs about 520 px; it doesn't wrap.


- C1 (events, sounds, the events file; branch motion-events): additive to the contract: `ClipEvent.volume` (a gain,
  above 0, at most 4) and `.pitch` (a rate, 0.25-4) with their checks in `slot.event.add/update` and `EventPatch`;
  `BakedEvent` carries both; `bakeRide` also returns `horseEvents` (the horse's events as its fitted clip plays them).
  The events file gained `companion`, `volume`/`pitch`, and the sound files (§6); with no events the GLBs and events
  files of the five workspace units are byte for byte what they were (`tools/lib/unit_events.test.ts` checks the GLBs
  with events added too). The Events track: `src/app/motion/events/` (vocabulary, edits as commands, footsteps from
  the feet, the lane, the inspector, the flash over the character; `harness/` mounts the lane and inspector against a
  TimelineView of its own: `npx vitest run --config src/app/motion/events/harness/vitest.config.ts`),
  `src/state/events.svelte.ts` (sounds, the preview on `animator.onTick`, footsteps), `server/routes/sounds.ts`
  (`GET /api/game/sounds`, `/api/game/sounds/file/<file>`, `GET|POST /api/characters/<id>/sounds`). A preview mute is
  the lane's only (the game gets every event); `muted: ['events']` still switches the slot's events off for the game.

- Integration QA (branch motion-timeline, after the C merge): driven in the app on the archer, spearman and knight.
  Found and fixed: the Events lane's effect wrote the viewer's overlays it read (effect_update_depth_exceeded: every
  control dead once a slot played); the Events row cut to one 15 px lane (its events hidden), its Add menu inside the
  scrolling tracks; the gear strips' labels inside the lane (strips 72 px right of the ruler); the ruler 10 px wider than
  the lanes (the tracks' scrollbar); the pose tools' menus cut by their row; the forearms in the Head group ("ear");
  `F` taken by both the viewport (frame the character) and the timeline (now: over the timeline only). The areas' items
  in the selection go through `lanes.ts AreaItems` (src/app/motion/areas.ts: events move, duplicate, copy, paste and
  delete with keys; the gear strips' items delete), with a nudge (Ctrl+← →); the pose tools' ease is the timeline's
  `easeKeys`. A hand bar dragged writes only its own window (`windowedit.ts editWindows`). The review's fixes:
  v1 PATCHes keep what schema 3 adds (legacy.ts), restore keeps variants and converts v1 records' times, a failed measure
  writes nothing, keys never merge in a hold or a squeeze, keying in a hold replaces the key there, window edits touch
  their window only, a retime stretch lands where dragged with holds inside, redo is cleared by any edit, a gesture is
  dropped when the slot changed under it, ridden repeats drop what lies outside the clip (keys, events, holds),
  resize scales heldBy places, copied sounds and variant names never collide, holders follow their handles, the pony
  paces a Walk variant, uploads keep a name. GLBs of the five workspace units byte for byte as b281970's.

- Pieces (schema 4, branch motion-pieces): built as §11 says, except or in detail:
  - **One command**, `slot.pieces.set` (with `seconds` and `split`), not set/add/update/remove: every gesture is a pure
    helper of `src/model/pieces.ts` (`endAt`, `startAt`, `insertAt`, `appended`, `trimmed`, `blended`, `moved`,
    `removed`, `patched`), sent with the hit pin and the fit by `src/state/pieces.svelte.ts` as one batch.
  - **Lengthening holds the last pose as it plays**: with the blow fit cutting the clip's end (most Attacks), dragging
    the end out first trims the clip piece to the played end (what the fit cut off, never played, goes), then holds; the
    piece's own end grip lets that tail out again. The same for the start. Insert time at the very start or end is the
    same gesture; elsewhere it splits the piece there (`split`). Insert time puts in 0.5 s (drag the hold's ends after).
  - A moment exactly on a seam (blend 0) belongs to the later piece, but goes with the earlier when the later one goes
    or loses it (a key on the clip's last frame survives removing a hold appended after it).
  - **Root continuation** turns each moving piece by the twist about up of the Hips' turn (composed, at its blend's
    start, times its own first turn's inverse): a clip whose Hips sway or lean also turns the next piece by that sway's
    yaw (a few degrees on Mixamo idles), and a cross-fade blends the rest of the Hips' turn (lean) over the blend.
  - **A slot piece** is that slot's bake (its timing, keys, hands, ground, ik), bone tracks only: its gear keys, held-by
    and shown strips are not carried into the composite (the slot's own gear tracks play). It is resampled on the
    composite's frames: about 0.01 rad off the slot's own clip on a fast attack's arm between frames.
  - Composites of library clips only are cached per ClipSource (forgotten with a clip file written again:
    `animator.forgetClip`); the viewer bakes a slot again when a slot it plays as a piece (or paces like) changes
    (`animator.inputs` reads `slotsUnder`).
  - After review: **a bake that would read itself** is refused through pace as well as pieces (`pieces.ts bakeCycle`:
    a slot's bake reads its slot pieces' bakes and the source of the clip it paces like; the commands refuse such a
    pace or piece, `slot.copy` and `clips.replace` too, and the bake carries the pacing slot in `via`, so a file that
    holds one fails to play rather than hangs). **Retime markers** are rebuilt on every pieces edit (`rewarp`): each part
    of the old composite plays at the speed it did, what is new unwarped; only when a warped part is cut away is what is
    left scaled as one to keep the warp's length. **Stored times** move only when their piece moved (an edit elsewhere
    leaves the very same numbers) and are no longer rounded; `fit.at` is exact. A window or span crossing a seam whose
    pieces are reordered keeps the part on its start's piece. `clips.replace` drops a lost slot piece as `removed` does
    (blends fitted, the rest remapped on the list as it was), or, when only holds would be left, plays the slot's own clip
    in its place for as long. The gestures are `src/model/pieceplan.ts` (pure, tested): the playhead read through the time
    map (markers), a late blow's held end kept when lengthening, the slot's own clip length sent with every edit so a list
    that is that clip whole again is stored as none, another slot's length measured again when it changes.
  - The build record is `schema: 4` (`tools/game_import.py` and restore read 2, 3 or 4; a v3 record's holds become
    pieces through the library clip's length). The Python readers take character files of schema 3 or 4 (what they read
    is the same in both).
  - Proven: every slot of the 30 workspace characters bakes the same before and after (largest difference 0, 169 slots,
    riders ridden; `tests/equivalence/pieces.test.ts` against `tests/equivalence/v3/bake.ts`); the archer's Walk and
    Attack with holds put in bake the same as hold pieces (largest difference 0); the 26 workspace units' GLBs and events
    files byte for byte as 26e8069's (the build records differ in `schema` only). In the app (port 5184): the spearman's
    Attack lengthened 0.5 s by its end grip (the hit kept at 0.817 s, fit.at 0.45 -> 0.352) and a Spine pose keyed in
    the held time; Box Walk Arc appended after Idle with a 0.3 s blend (the Hips' largest step per frame through the
    blend 7.2 mm, the walk's own 5.3 mm); time inserted in Idle and keyed; the edited Attack appended as a slot piece;
    a hold removed with its key, a piece reordered, every step undone; the combined Idle baked in node as the export
    bakes it equal to the viewer's within 5.8e-6 on every track, and exported (Idle 5.581 s).

---

## 11. Pieces: a clip built from several (schema 4)

The designer, 2026-10-29: "i dont see any way to make a clip longer except the hold, which doesnt let me do anything.
There is also no way to combine clips", and "The existing hold thing is useless, I place it and then there is no way to
animate or extend things into it". Everything keyed is pinned to the source's own time; a hold froze the source, so
every frame of it was the same source moment and nothing could be keyed there; and a slot had one source clip.

A slot's source can now be **pieces played one after another**: a range of a library clip, a range of another slot of
the character as that slot plays (its bake: its timing, keys and hands: "so you can combine with an edited Attack"), or
a held pose (seconds of the pose where the piece before ends: real time, keyable). Neighbours cross-fade over a blend;
each piece's root motion carries on from where the one before left off. The pieces are composed into the source clip
the time map then plays, so **source time is the composite's**: everything else (§1-§6) is unchanged.

### 11.1 The model

```ts
export interface Slot {
  ...
  clip: ClipRef            // the clip it was filled with: its name in the lists; with `pieces` set, not what plays
  /** The source built from pieces played one after another (unset: `clip` whole, as every slot before schema 4). */
  pieces?: Piece[]
}
export type Piece = { id: string, from: number, to: number, blend?: number } & (
  | { kind: 'clip', clip: ClipRef }      // seconds `from`..`to` of a library clip (as the clip source retargets it)
  | { kind: 'slot', slot: string }       // seconds of another slot's played clip (its bake)
  | { kind: 'hold' }                     // the pose where the piece before ends (the first: where the next starts)
)
```

- `from`/`to` are seconds of the piece's own content: the clip at speed 1, the other slot as it plays, or a hold's own
  clock (any numbers, `from < to`: lengthening a hold at its start lowers `from`, so what is keyed in it stays put).
  A piece lasts `to - from` whatever its content does later: a content shorter than that (the other slot was made
  shorter) holds its last pose. So the layout, and every stored time, depends on the slot alone.
- `blend` (seconds, unset 0): the piece starts that much before the one before it ends and cross-fades in over it. Rules
  (the reducer): ids unique; `from < to`; the first piece has no blend; a blend is at most either neighbour's length,
  and a piece's two blends don't overlap (`blend_i + blend_i+1 <= length_i`); at least one piece is a clip or a slot; a
  slot piece names another slot of the character, and no chain of slot pieces leads back to this slot.
- **Why `clip` stays, with `pieces` beside it** (and not one representation): every slot made so far is one clip
  whole, and every reader of `slot.clip` (the lists, the library's "used by", variants, the build record, rig.ts) keeps
  working; a one-piece slot stays the same bytes in its file and bakes down the very same path (§11.6 proves it
  unchanged, value for value). The cost, two places a source can be named, is held by one rule: with `pieces` set they
  are the source. A list that is just `clip` whole again (one clip piece of `clip`, 0 to its length, no blend) is
  stored as no list.

### 11.2 Source time over pieces

The layout (`src/model/pieces.ts layoutOf`, pure): piece i lasts `d_i = to - from` and starts at `s_0 = 0`,
`s_i = s_i-1 + d_i-1 - blend_i`; the composite lasts `D = s_last + d_last`. A `SourceU` is `t / D` of the composite
(what the clip source layer hands the bake: a clip `D` seconds long). Markers, the fit, pace, keys, windows, events
and gear tracks all stay as §2-§3 say, on the composite. A slot without pieces is the layout of one piece, its clip
whole (`D` the clip's length): identical to schema 3.

**Which piece a moment belongs to:** the piece it falls in; inside a blend, the one before up to the blend's middle,
the next from there; past the end (a late blow held, §2.2), the last piece, at its distance from that piece's start.

### 11.3 Piece edits remap what is stored

Every stored time is attached to its piece by where it falls (§11.2): to the piece's id and the moment of the piece's
content (`from` + its offset into the piece). An edit gives the new list; each item goes to the piece of the same id
whose range still holds its moment (or, for a split, `split[newId] = oldId`: either part), at that piece's new start.
So trimming, extending, reordering, blending or removing a piece never slides what is keyed on the others, and a key
trimmed off its piece goes with it, as do a removed piece's items (undo brings them back). Exactly:

- points (keys, events' `u`, a span's ends, holders and shown switches: each `u`): moved; one whose piece went or whose
  moment was trimmed off is dropped (a span keeps what is left of it; a holder or a shown switch is put at the seam of
  where its piece was, so the piece is held or hidden from there as before);
- windows (hand poses, handle holds, ik hands): each end clamped into what is left of its piece; a window left empty
  goes (a hand pose's whole-clip `windows` unset stays unset);
- retime markers: `u` as a point; `to` shifted by the seconds its `u` moved (`to' = (to·D + Δ) / D'`); markers that no
  longer run forward in both times are dropped;
- past the end (u > 1): at the same distance from the last piece's start, so a late-held end that a hold is appended over
  plays inside that hold.

### 11.4 Composing (src/engine/pieces.ts, the bake's source)

`sourceClip(c, slot, ctx, o)` is the bake's first stage (`bakeSlot`, a pace's `like`, `bakeRide`'s horse and the
measures call it): without pieces it is `ctx.clips.get(slot.clip, ...)`, the call it always was; with pieces it is the
composite, made from the ClipSource (the browser's RetargetCache, node's nodeClipSource) and, for slot pieces,
`bakeSlot` of that slot (gear nodes off: its bone tracks only), so the viewer, the timeline and the export compose the
same way, in three.js, with nothing written. Per frame of `frameTimes(D)` (KEY_FPS):

- a clip or slot piece reads its content at `from + offset`, clamped to the content (past its end, its last pose);
  a hold repeats the composed pose at the end of the piece before (a hold first: the first moving piece's first pose);
- **root continuation**: each moving piece but the first is turned about the up axis (the twist, about up in the
  Hips' parent frame, of the composed Hips' turn at the start of its blend times its own first turn's inverse) and moved
  over the ground (the horizontal part of the difference), so its first frame stands and faces where the composed clip
  is when it comes in; heights are its own. In place slots compose in-place pieces (the slot's `inPlace`);
- **cross-fade**: inside a blend, the two pieces mixed by smoothstep of the way through it: turns slerped, moves lerped;
- tracks: every bone track any piece has; a piece lacking one plays the bone's rest.

The bake refuses a slot whose pieces lead back to it ("plays itself") as the commands do. A composite of library
clips only is cached per ClipSource (by its pieces, in place, mirror, fps); a slot piece bakes that slot each time (its
own clip comes from the source's cache).

### 11.5 Commands, migration, schema 4

| command | does | rules |
|---|---|---|
| `slot.pieces.set {slot, pieces \| null, seconds?, split?}` | the pieces replaced (null: back to `clip` whole), every stored time remapped (§11.3) in the same command | §11.1; `seconds` (the length of `clip` at speed 1) whenever the slot was or becomes `clip` whole (that layout needs it); `split`: new piece id -> the old piece it continues |

One command, as `slot.keys.set` is for keys: each gesture (extend the end or start, type a length, insert time, append,
trim, blend, reorder, remove) is a pure helper in `src/model/pieces.ts` giving the next list, and the remap is in one
place. Journal lines say it in words ("clip Attack: held 0.50 s at the end", "clip Idle: Walk appended, blend 0.20 s",
"clip Run: Walk removed (3 keys with it)"). With the blow fit on, the timeline's gestures that change the played
length keep its start and the blow where they are (a measured blow is pinned as the hit event first, so a longer clip
can't find another fastest moment) and set `fit.at` (and a `window`) so the played end follows the edit: one batch,
one undo. Other slot commands: `slot.fill` drops the pieces (another clip); `slot.copy` copies them and refuses a copy
whose pieces would play the slot itself; `slot.remove` refuses a slot another plays as a piece (409: remove that piece
first); `clips.replace` drops slot pieces naming a slot not in the set (remapped as a removal); `freshSet` re-ids
pieces and maps their slots. `slot.time` takes no `holds` (400: "holds are pieces now").

**Holds go.** `SlotTime.holds`, its timemap stage and its UI are removed; "Insert time" at the playhead (splitting the
piece there and putting a hold between: real time to key) replaces it. Schema 4 (`SCHEMA = 4`) is schema 3 with
`pieces` and without holds. `migrate`: v1 -> v2 -> v3 -> v4; per v3 slot with holds (D its clip's length, measured: a
schema 3 file with holds `needsClipTimes`, `measureCharacter` measures those clips' lengths), the holds `u_1 < ... <
u_k` (seconds `s_j`) become `clip [0, u_1·D], hold [0, s_1], clip [u_1·D, u_2·D], ..., clip [u_k·D, D]` (empty
clip pieces left out) and every stored time `u` becomes `(u·D + Σ s_j for u_j < u) / (D + Σ s_j)` (an item at a hold's
`u` at its start, as it played); markers move so the warp plays the same (their `u` and `to` through the same seconds,
plus knots at each hold piece's ends). The same seconds play the same poses (the hold the pose at `u_j`, which is
where its piece before ends). Without the length (the clip doesn't exist) the holds are dropped with a note; strict
readers throw as for v2. Every other v3 slot is unchanged: a schema 3 file becomes schema 4 by its number and
`character.v3.json` keeps the old file (once). `tools/migrate.ts --check` also checks each `character.v3.json`:
migrating it again gives the current slots, and each converted time plays at the same second. The server, the tools'
headers (`x-rigsmith-schema` 2, 3 or 4), the Python readers and the build record (`schema: 4`, restore reads 2, 3 or 4;
a v3 record's holds become pieces the same way) follow.

### 11.6 Proof

- `src/model/pieces.test.ts`: layout, ownership, remapping (keys on piece B keep their pose when piece A is trimmed;
  trimmed-off and removed items go; splits), every helper; `commands.pieces.test.ts`: the command, its rules, cycles,
  undo; `migrate.test.ts`: holds become pieces and every time plays at the same second; `src/engine/pieces.test.ts`:
  composition (a cross-fade's halfway pose, no jump in the Hips' position or facing at a seam, a hold holds, a slot
  piece is that slot's bake, a cycle refused) and a migrated hold baking as it did.
- `tests/equivalence/pieces.test.ts`: every slot of every workspace character baked by `bake_v3.ts` (bake.ts as it was
  before pieces, frozen with the timing it called) on its schema 3 record and by `bakeSlot` on it migrated to schema 4:
  the largest difference 0; riders ridden too.
- The export: the workspace units' GLBs byte for byte as before (run by hand, reported).
