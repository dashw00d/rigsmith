# Rigsmith rebuild: the binding design

PLAN.md says what and why. This file says exactly how, so that many people (or agents) can build it at once without
stepping on each other. Where this file and PLAN.md disagree, this file wins; where this file is silent, follow
PLAN.md §5–§6.

The contract in code: `src/model/types.ts` (the character document, schema 3 since the Motion timeline: a slot's
times are source time, its blow timing, pace and keys its time map and tracks; `docs/motion-plan.md` wins for slots), `src/model/command-types.ts` (every
user action), `src/model/unit.ts` (a game unit). They are the interface between all areas; change them only
additively, noting the change in §11.

Revision 2 (after a design review against the code; see §11 for what it changed).

---

## 0. Decisions on PLAN.md §7 (open questions), taken as defaults

1. **The generic browser GLB export goes.** Emberhold is the only consumer. `ExportPanel`'s generic path,
   `src/engine/exporter.ts`, `src/engine/export/lods.ts`'s glTF-extras LODs, `godot/rigsmith_lods.gd`,
   `POST /api/exports`, `Settings.exportDir` and the localStorage export options are removed. The Ship step builds the
   unit with the same kernel the viewer plays (`tests/godot/check_export.gd` stays, pointed at unit GLBs).
2. **Clothing, parts, mechanisms stay behind an extension point**: the Gear model's `attach.kind` `'skin'` and
   `'spot'`. The main Gear flow adds bone-attached gear; "wear it on the skin" / "pin it to a spot" sit under an
   "Other ways to wear it" disclosure. Swap sets stay first-class (the game swaps Gear*/Head*/Wear*).
3. **Creature templates**: human and horse are supported. Fox, bird, dragon, kaiju, spider, snake and shark stay as
   data behind `templates.ts`'s registry with `status: 'experimental'`, offered under "Other creatures".
4. **Codex texture repaint stays** in the Look step.
5. **The editor has one save: "Save as <clip>".** It writes a new library clip and points the slot chosen (one the
   game plays, a trial, or a new one by name) at it, whatever it played before (`clipedit.ts saveIntoSlotCommands`;
   the designer, 2026-10-28: "I super just need to be able to save animations with the character as a replacement to
   attack or run ... just make a new one"). Nothing is saved over in place; the old clip stays in the library and Undo
   puts the slot back. The separate "Save as a library clip" is gone (every save is in the library anyway).
6. **The game export's output does not change on purpose.** In particular a rider's `mount.gear` (horse tack and
   barding) has never shipped (v1 matched ids against names); it still doesn't, and the Ship checks say so. Whether
   to ship it is a question for the owner (§10).

Other decisions:
- **Directory layout maps PLAN.md §5.3 onto the existing tree** instead of moving everything into `packages/`:
  `src/model/` = model (schema, commands, migrations, selectors); `src/engine/` = kernel (three.js, no DOM, runs in
  the browser and headless in Node); `server/` = server; `src/state/` + `src/app/` + `src/ui/` = app; `tools/` = cli
  and offline builders; `blender/` = Blender jobs. No zod (no new dependencies): runtime checks are hand-written in
  the reducers.
- **Unit specs stay in `workspace/game/units.json`** (it is what gets spliced into the game's file); the character
  carries `mount` only.
- Steps: **Import, Skeleton, Skin, Gear, Look, Motion, Ship** (ids `import skeleton skin gear look motion ship`;
  old persisted ids map `rig->skeleton, outfit->gear, texture->look, animate->motion, export->ship`).
- **External clients keep working.** The game repo's own scripts (`tools/rigsmith/import_new_units.py`,
  `import_gear.py`, `stage_new_units.sh`) and `tools/game_import.py` speak the v1 HTTP API and CLI, and the game repo
  may not be edited. The server keeps a deprecated v1 compatibility layer (§4.2) until the owner ports them.

---

## 1. Rules for everyone working on this

- Never write to `/home/ryan/dev/games/rigsmith` or `/home/ryan/dev/games/emberhold`. `workspace/` here is a private
  copy and may be changed.
- **Never change any character's weights** as a side effect: no code path in this rebuild may rewrite `rigged.glb`
  skin data or `weight_edits.json` except the explicit, user-triggered rig/paint routes, and those refuse while
  `skin.locked`. Migrations never touch GLBs or `weight_edits.json`.
- Do not run the test suite, the dev server, Blender jobs or Codex while implementing: testing happens once
  everything is implemented. Type-checking files you own (`npx tsc -p tools --noEmit`, `npx svelte-check
  --threshold error`) is allowed but expect noise from areas still in progress; only fix errors in your own files.
- Stay inside the files your area owns (§3). If you need a change in another area's file, do the smallest possible
  edit and say so in your final report; never restructure someone else's file.
- Write code comments the way the existing code does (plain words, why not what), and keep UI copy short and plain.
- Write or update unit tests for new pure modules you create (they will be run at the end).
- Every non-GET request from `src/` goes through `src/state/api.ts`. Don't commit. Don't push.

---

## 2. The character document (schema 2)

See `src/model/types.ts` for every field and its owner. Key points:

- **Skeleton = detected + overrides.** Generators write `skeleton.detected` (import detection also keeps a copy in
  `skeleton.imported`). Users write `skeleton.overrides` only (3D drags and the marker board's solve both go there, and
  only joints that differ from detected are kept). `select.jointsOf(c)` is the effective skeleton everywhere (rig job
  input, joint editor, marker seeding, journal).
- **Gear** replaces `props` + `garments`. **Handles** replace carry sockets, grip sockets and pull sockets.
- **Slots** have stable ids; names are unique. **Adjustments** replace Tune keys, lift, clip scripts and per-clip
  windows (`carryOpen`, pull `holds`). Character-wide grip scripts became `hands.hold`.
- **Look layers** replace the single overwritten texture override; each is an RGBA decal in texture space.
- `status` is lifecycle only; the UI uses `select.phaseOf()`. `source.kind` is what the file contained and never
  changes after import (a conversion sets `skeleton.converted`).

### 2.1 Hierarchies (`src/model/skeletons.ts`)

Synchronous, shared by server, app and tools: the Mixamo hierarchy by finger level (from
`static/templates/human-skeleton.json`, which `src/engine/mixamo.ts` and `blender/autorig/mixamo.py` also read) and
`TEMPLATE_PARENTS: Record<templateId, Record<joint, string | null>>` generated from `static/templates/*.json`
(`order`/`parents`; a test checks it matches). `hierarchyOf(c)`: human -> Mixamo at `fingerLevel`; a known creature ->
its joints (finger level ignored); an unknown template -> the keys of detected ∪ overrides. `jointsOf(c)` =
`{...detected, ...overrides}` restricted to `hierarchyOf(c)`; at level `full`, a hand's Index chain with no Middle1 on
that hand is dropped (v1's mitten cleanup), so the rig job and the finger trace never get a mitten Index.

### 2.2 Generators and overrides (who writes what)

| Writer | detected | overrides | stale | markers | other |
|---|---|---|---|---|---|
| `skeleton.place` (3D drag, marker solve) | — | set the given joints that differ from detected (>1e-6); remove given joints that don't | — | set if given | — |
| `skeleton.unplace` / `skeleton.reset` | — | remove given / all | reset: cleared | reset: cleared | — |
| Import / re-import (human template, detection succeeded) | replaced; `imported` too | kept; journal reports how many hide the new detection | — | — | detection failed or creature: detected kept, a `source.warnings` line |
| Finger level change (`/skeleton/fingers`) | the trace replaces every finger joint of both hands | overrides outside the new level's hierarchy, and the Index chain when crossing full↔mitten, move to `stale` (with `template`, `level`) | added to | Index entries of `base` and `index_tip_*` positions removed | — |
| Detect fingers again | trace replaces finger joints | both hands' finger overrides move to `stale` | added to | as above | one undoable entry |
| Template switch (`/skeleton/template`) | to human: `imported` (re-traced at the level); to a creature: the fit | cleared | cleared | cleared | slots cleared (they are another family's); one undoable entry; 409 while `skin.locked` |
| Convert a rigged import | the foreign joints; `converted: true` | cleared | — | — | 409 while `skin.locked`; status/files untouched |
| Refit template | the fit | kept, reported | — | — | — |
| Rig job | joints Blender completed that were missing from the input are added | never touched | — | — | `skin.rigJoints = r.joints`, `skin.bones`; a shift of supplied joints is a warning |
| Resize (`/fit`) | `select.rescale` (§2.4) | rescaled | rescaled | rescaled | everything with a length |

`select.phaseOf` returns `needs-rig` when `skin.rigJoints`' keys differ from `hierarchyOf(c)`, so undoing a template
switch is complete without touching files; the viewer picks `rigged.glb` only in phase `rigged`.

### 2.3 Migration v1 -> v2 (`src/model/migrate.ts`)

`migrate(raw, ctx?) -> { character, migrated, notes, fileOps }`. Pure and deterministic: new ids are
`hex8(fnv1a(characterId + ':' + what + ':' + index))` so every process migrating the same file gets the same ids.
Idempotent (v2 in, v2 out). `readCharacter(raw) = migrate(raw).character` is how every TS reader that bypasses the
server reads a character (`tools/lib/node3d.ts character()`, the unit export, `tools/rig.ts`, library_verify, dev
scripts). Python readers check `schema == 2` and otherwise exit with "run node tools/migrate.ts".

```ts
interface MigrateContext {
  textureFiles?: string[]        // existing textures/*.png except *.mask.png (file names)
  paintedCount?: number          // key count of weight_edits.json
  bindJoints?: Joints            // rest bone heads of rigged.glb (inverse bind matrices via glb.ts)
}
```
The server store fills the context, then (inside the per-id lock): copies `character.json` to `character.v1.json`
(once), runs `fileOps` (copies, never moves), writes `character.json`, and appends one non-undoable journal entry
`what: 'migrate'` whose `changes` are the notes. `tools/migrate.ts` does the same for the whole workspace; `--check`
asserts, per character: `jointsOf(v2)` equals the old `joints`; `jointsOf` with overrides cleared covers the full
hierarchy; the hand layers (`hands.ts handLayers`) of every slot resolve to the same fist or none that v1
`handScripts` gave (a copy of v1's rule inside the check); no GLB or `weight_edits.json` hash changed.

| v1 | v2 |
|---|---|
| `kind ?? 'mesh'`, `rigPreset`, `stats`, `scale ?? 1` | `source.kind`, `source.rigPreset`, `source.stats`, `source.scale` |
| `rigReport` with `method: 'import'` | `source.warnings = rigReport.warnings` (and no `skin.report`); otherwise `source.warnings = []` |
| `rigReport` otherwise | `skin.report` (decisions absent) |
| `stats.bones` when rigged | also `skin.bones` |
| `template ?? 'human'`, `fingers ?? 'full'` | `skeleton.template`, `skeleton.fingerLevel` |
| skeleton, case 1: `autoJoints` undefined or `jointsEdited !== true` | `detected = joints`, `overrides = {}` |
| skeleton, case 2: otherwise | infer autoJoints' finger level (Middle1 present -> full, Thumb1 -> two, Index1 -> one, else none); `detected` = autoJoints' non-finger joints + finger joints from autoJoints if that level equals `fingers`, else from `joints` (they came from the trace) + every joint of `joints` absent from autoJoints; `overrides` = joints of `joints` differing from that `detected` by more than 1e-7 |
| `autoJoints` (human template) | `skeleton.imported` |
| `markers`, `boneMap` | `skeleton.markers`, `skeleton.boneMap` |
| `source.kind === 'mesh'` but `rigPreset` set (a converted import) | `source.kind = 'rigged'`, `skeleton.converted = true` |
| — | `skin.rigJoints = ctx.bindJoints ?? joints` (only when status `rigged`); `skin.painted = ctx.paintedCount` |
| — | `skin.locked = true` for every character with status `rigged` except ids starting `scout-` or `villager-` (the hand-fixed rule), `lockReason: 'hand-fixed weights'` |
| `handPoses` | `hands.poses` |
| enabled `grip` scripts (`kind: 'grip'`) | `hands.hold[side] = ref(clip)`; their `open[name]` windows -> `handPose {hand: side, pose: 'clip', windows}` on that slot; their `note` -> the journal note; disabled ones dropped with a note |
| `garments[]` | `gear[]`: `mode rigid -> attach {kind:'bone', bone, place}`, `clothing -> {kind:'skin', policy, place, hideBody}`, `part -> {kind:'spot', place, anchor, animation}`; `place = {position, rotation, scale}`; `file -> model`; `group -> swapSet`; `hidden, from, painted, status, error, id, name` kept |
| rigid garment on `LeftHand`/`RightHand` | a carry handle `{id:'carry', name:'Carried', kind:'carry', hand, pose: ref(carryPose)}` (`ref(undefined) = 'default'`) |
| `garments[].sockets[]` | names ending `(carries it)` dropped; a socket whose hand (from its name `Left …`/`Right …` or id `left-hand`/`right-hand`) is the carry hand -> the carry handle's `place` and `exact: placed`; others -> grip handles `{kind:'grip', id, name, place:{position, rotation}, hand, exact: placed}` |
| `garments[].pulls[]` | pull handles `{kind:'pull', id, name, hand: side of bone if a hand, pull:{bone, grip, rest}, pose: p.pose === undefined || p.pose === 'open' ? undefined : ref(p.pose)}` |
| `props[]` (catalog) | gear `{id, name, catalog: file, from: 'catalog:<file>', status:'ready', attach:{kind:'bone', bone: socket, place: {position, rotation, scale} as stored, legacyFrame:'grip'}}`, not hidden; on a hand bone also a carry handle with `pose: 'clip'` (v1 never closed a hand for a catalog prop); note it |
| `animations[]` | `clips[]`: `{id, name, clip:{id: clipId, url}, speed, loop, inPlace, note, adjustments}` (`trim` dropped); duplicate names: the first keeps it, others become `<name> 2`, … (name-keyed rules apply to the first; noted) |
| entry `lift` (non-zero) | adjustment `ground {lift}` |
| entry `keys` | adjustment `keys {bones, gear}` (gear keyed by garment name -> gear id; unknown names dropped with a note) |
| `blow` scripts (by entry name) | adjustment `blowTiming` on that slot (enabled flag kept) |
| `pace` scripts | adjustment `pace {like: slot id of 'like'}` (dropped with a note if either is missing) |
| `carryOpen[name]` of a carried garment | adjustment `handPose {hand: carry hand, pose: 'clip', windows, gear: id}` on that slot |
| pull `holds[name]` | adjustment `handleHold {gear, handle, windows}` on that slot |
| windows on a slot with an enabled blow script | kept as they are, with a note (v1 applied them before the cut; none exist in the real data) |
| `texture` | `look.scan = {images: [{image: clean name (from images[].file when present), coverage}], at}` when images exist; `look.at = texture.at`; for each `ctx.textureFiles` a `snapshot` layer `{id, image: file stem, file: 'textures/layers/<id>.png', enabled: true}` plus a fileOp copying the file there |
| `skins` | `look.skins` |
| `mount` | `mount` (its `gear` already holds garment ids); a note when it disagrees with the unit's companion |
| `pose:<id>` naming a missing pose | `'default'` and a note |
| `revision ?? 0`, `version` | `revision`, `version: 1`, `schema: 2` |

`ref(x)`: `undefined -> 'default'`, `'open' -> 'clip'`, `'pose:<id>' -> {pose: id}`, `DEFAULT_FIST -> 'default'`,
any other string -> `{fist: x}`.

Settings v1 -> v2: keep `gameRepo` and `handPoses`; drop `exportDir`, `exportFormat`, `boneNames`.

Also exported from `migrate.ts` for the v1 compatibility layer and game builds: `slotsFromV1(animations, scripts,
gearIdByName)`, `holdsFromV1(scripts)`, `gearFromV1(garment)`.

### 2.4 Resize (`src/model/rescale.ts`)

`rescale(c, s, d: Vec3): Character`, pure, unit-tested; the one list of every length in the document. Positions get
`p·s + d`: skeleton.detected/imported/overrides/stale[].at/markers.base and positions, skin.rigJoints, gear
attach.place.position (not for `legacyFrame: 'grip'` catalog places, which are in grip-frame units), spot anchor.
Lengths get `×s`: attach.place.scale, handle `pull.grip`, ground lift, the `p` of every bone's keys (a horse moves
'hips' or 'root', not 'Hips'), mount.hips, source.scale, source.stats.height. Unchanged: grip handle places and gear
key `p` (in the gear's placed, scaled frame), a gear's `origin` (its model's own space), mount.position (horse space: resizing a horse updates its riders'
`mount.position` through a server effect journaled on each rider). Whoever adds a length field extends this file.

## 3. Areas and file ownership

Each area owns the files listed; nobody else edits them except as §1 allows. New files go in the area's folders.

| Area | Owns |
|---|---|
| **model** | `src/model/**` (types, command-types and unit are the shared contract): `commands.ts`, `commands/<section>.ts`, `entities.ts`, `select.ts`, `skeletons.ts`, `rescale.ts`, `migrate.ts`, `legacy.ts` (v1 view + v1 patch conversion), `ids.ts`, `static/templates/human-skeleton.json` |
| **server-core** | `server/store.ts` (was workspace.ts; `server/workspace.ts` stays as a re-export shim), `server/commands.ts`, `server/journal.ts`, `server/jobs.ts`, `server/plugin.ts`, `server/http.ts`, `server/compat.ts` (v1 layer), `server/rest.ts`, `server/routes/characters.ts` (list/get/create/delete/thumbnail/journal/notes/settings/events/files/open/jobs) |
| **client-core** | `src/state/api.ts`, `src/state/app.svelte.ts`, `src/ui/**` |
| **kernel** | `src/engine/glb.ts`, `lods.ts`, `bake.ts`, `hands.ts`, `timing.ts`, `keys.ts`, `geom.ts`, `headless.ts`, `contract.ts`, `clips.ts` (ClipSource), `retarget.ts`; deletes `scripts.ts`, `animation.ts`, `export/**`; `tools/lib/node3d.ts`, `tools/lib/unit_export.ts`, `tools/game_export.ts`, `tools/lib/gearskin.ts` |
| **shell** | `src/app/App.svelte`, `TopBar.svelte`, `Inspector.svelte`, `CharacterList.svelte`, `Viewport.svelte`, `Toasts.svelte`, `ActivityDrawer.svelte` (new; replaces JobsPopover + HistoryPanel), `SettingsPopover.svelte`, `DropOverlay.svelte`, `src/app/steps/ImportPanel.svelte`, `src/state/viewer.svelte.ts`, `src/state/thumbnails.svelte.ts`, `src/engine/{Stage,CharacterView,lighting,offscreen,ThumbnailRenderer,PreviewRenderer}.ts`, `src/styles/**`, `server/inspect.ts` (runInspect), `server/routes/import.ts` (reimport, fit), `server/glbtransform.ts`, `blender/jobs/inspect.py`, `blender/common/**` |
| **skeleton** | `src/app/steps/SkeletonPanel.svelte` (from RigPanel's placement branch), `src/app/skeleton/**` (MarkerBoard, SkeletonMapping, JointChips…), `src/state/skeleton.svelte.ts` (merges markers.svelte.ts + the joint editor out of viewer), `src/engine/{JointEditor,markers,mixamo,templates}.ts`, `server/routes/skeleton.ts` (fingers, template, fit-template, convert, skeleton-presets), `blender/autorig/{mixamo,skeleton,landmarks,hands,fingers,raster}.py`, `tools/creature_fit.py` |
| **skin** | `src/app/steps/SkinPanel.svelte`, `src/app/skin/**` (WeightPaintPanel, RigReport, DeformationTests), `src/state/paint.svelte.ts`, `src/engine/weightpaint.ts`, `server/routes/skin.ts` (rig job, weights routes, lock), `server/skinopt.ts`, `server/weights.ts`, `tools/skin_opt/**`, `tools/lib/{skintransfer,deformation}.ts`, `blender/autorig/{rig,weights,regions,heat}.py`, `tools/dev/coat_weights.ts`, `tools/verify_autorig.py` |
| **gear** | `src/app/steps/GearPanel.svelte`, `src/app/gear/**` (CatalogDrawer, GearList, HandleList, PlacementFields, gizmo helper), `src/state/gear.svelte.ts` (from outfit.svelte.ts minus mount), `src/engine/{garments,props,placement,pulls}.ts`, `server/routes/gear.ts` (upload, gear weights) |
| **hands** | `src/app/hands/**` (HandsPanel "what each hand does and why", HandPoseSelect, HandPoseEditor, HandPosesList), `src/state/hands.svelte.ts` (from handposes.svelte.ts), `src/engine/{handposes,handdots}.ts` |
| **look** | `src/app/steps/LookPanel.svelte`, `src/app/look/**` (MaskPainter, Layers, Capture), `src/state/painter.svelte.ts`, `src/engine/{projection,surfacemask,selection}.ts`, `server/routes/look.ts` (fill, layers, compose, projections, codex, qwen), `tools/paint_capture.py`, `server/glbimages.ts`, `blender/jobs/texture_fill.py`, `blender/jobs/texture_compose.py` (new) |
| **motion** | `src/app/steps/MotionPanel.svelte`, `src/app/motion/**` (LibraryDrawer, LibraryCard, Timeline with lanes, SlotList, AdjustmentStack, adjustment editors), `src/state/{animator,slots,library,adjust}.svelte.ts` (adjust replaces tune), `src/engine/{Player,ground}.ts`, `server/library.ts`, `server/routes/library.ts` |
| **editor** | `src/app/editor/**` (EditPanel), `src/state/clipedit.svelte.ts`, `src/engine/{clipedit,PoseEditor,ik,propfit,clipexport,bodysolve,posespace,limits,bodycollide,handcontacts,surfacecontact}.ts`, `server/clipedits.ts`, `server/routes/edits.ts` (library edits, creature clips, `GET /api/library/usage/:clipId`), `blender/clips/**`, `tools/{posespace,rom}.ts`, `static/templates/rom/**` |
| **ship** | `src/app/steps/ShipPanel.svelte`, `src/app/ship/**` (UnitCard, MountEditor, ScaleRoom, Checks, BuildRecord), `src/state/{ship,mount,scaleroom}.svelte.ts`, `src/engine/{mount,checks}.ts`, `server/game.ts`, `server/routes/ship.ts` (units, export, game models, `/:id/game`) |
| **forge** | `server/forge/**` (types, config, store, runner, queue, publish; tests with `fixture.ts`), `server/routes/forge.ts`, the GPU lane in `server/jobs.ts` (`gpuTurn`, `withGpu`, `gpuState`, `reorderGpu`, `freeVram`, `freeComfy`, `comfyUrl`), `src/state/forge.svelte.ts`, `src/app/forge/**`; in the game repo `forge.json` and `tools/forge/**` |
| **tools** | `tools/rig.ts`, `tools/game_import.py`, `tools/migrate.ts`, `tools/apply.ts`, `server/routes/restore.ts` (`POST /api/characters/:id/restore`), `tools/dev/**` except coat_weights, `tools/library_verify.ts`, `tools/tsconfig.json`, `package.json` scripts, `README.md`, `HANDOFF.md`, `docs/animating.md` |

---

## 4. Module APIs (the seams between areas)

### 4.1 Model (`src/model/`)

```ts
// commands.ts — pure; never creates ids; never bumps version (the store does)
export class CommandError extends Error { status: 400 | 404 | 409 }
export interface Applied { character: Character, changes: string[] }
export function applyCommand (c: Character, cmd: Command): Applied
export function applyCommands (c: Character, cmds: Command[]): Applied          // all or nothing
// commands/<section>.ts — one reducer file per section (character, skeleton, skin, hands, gear, clips, look, mount)
// Cardinality (clips): one ground, blowTiming, pace, keys per slot; one handleHold per (gear, handle); a hand's
// handPose windows don't overlap; adding a keys adjustment merges per bone/gear. Gear: safe-name uniqueness;
// 'emberhold:' names immutable; gear.attach maintains the carry handle (adds one when attached to a hand bone,
// removes it and the gear's handPose adjustments when it leaves); handPose adjustments with `gear` follow it.
// entities.ts — generic undo (entity keys: types.ts UndoRecord)
export function entitiesOf (c: Character): Map<string, unknown>
export function touchedBy (before: Character, after: Character): string[]
export function undoRecord (before: Character, after: Character): UndoRecord      // before values + after hashes
export function restoreEntities (c: Character, undo: UndoRecord): Character       // order entities merge
export function undoConflicts (current: Character, undo: UndoRecord): string[]     // entities whose hash moved on
// select.ts — the one place each derived fact is computed
export function jointsOf (c): Joints;  export function hierarchyOf (c): Array<[string, string | null]>   // (skeletons.ts)
export type Phase = 'importing' | 'error' | 'animation-only' | 'needs-conversion' | 'needs-rig' | 'rigging' | 'rigged'
export function phaseOf (c, job?: Job | null): { phase: Phase, label: string, tone: 'muted' | 'busy' | 'ok' | 'warn' | 'error' }
export function slotByName (c, name); slotById (c, id); gearById (c, id); gearByName (c, name); carryHandle (g)
export function carriedBy (c, side): Gear | undefined   // first ready, shown, bone gear on that hand with a carry handle
export function heightOf (c): number                     // source.stats.height: the one measured size
export function freshSet (slots: Slot[], newId: () => string): Slot[]   // re-id slots + adjustments, remap pace.like
export function gearKeysFromPaths (c, paths: Record<string /*gear name*/, ClipKey[]>): Record<string /*gear id*/, ClipKey[]>
export function safeName (name: string): string           // the bone-safe form (also geom.ts re-exports it)
export const DEFAULT_FIST = 'mixamo-Great_Sword_Crouching_6'
// ids.ts
export function newId (): string                          // 8 lowercase hex, random (callers only)
export function stableId (seed: string): string           // fnv1a hex8 (migration)
// legacy.ts — the deprecated v1 layer (server/compat.ts uses it)
export function toV1 (c: Character, units?: GameSpec): V1Character                  // read-only v1 view
export function v1PatchToCommands (c: Character, patch: { animations?, scripts?, garments?, props? }, newId): Command[]
```

### 4.2 Server core

- `server/store.ts`: `getCharacter, listCharacters, createCharacter, deleteCharacter, characterDir, paths(id) {dir,
  textures, layers, garment(gid), projection(pid)}, getSettings, saveSettings, readJson, writeJson`, always v2.
  Migration happens inside the per-id lock (§2.3); `getCharacter` of a v1 file migrates through
  `updateCharacter(..., { journal: false })`.
  `updateCharacter(id, fn, meta?: { by?: string, what: string, changes?: string[], undoable?: boolean,
  journal?: boolean })`: per-id lock; bumps `version`, `updatedAt`; computes `touched` (and `undo` when undoable);
  journals unless `journal: false` (housekeeping: thumbnail, status-only, gear status, migration write-back);
  fires `afterChange` hooks; emits SSE `character` `{ character, entry? }`.
  `withFiles(id, fn)`: a per-character mutex every writer of `model.glb`, `rigged.glb`, `weight_edits.json` and
  `garments/*/weights.json` takes (writeWeights, swapImages, transformGlb, publishRig, compose).
  `failCharacter(id, err)`. Orphan sweep at startup: `garments/<id>/` folders no gear references and no undoable
  entry could restore move to `trash/`.
- `server/commands.ts`: `POST /api/characters/:id/commands` `{ command | commands, cid?, what? }` -> `{ character,
  entry }` (a batch is one entry, all or nothing); `POST /api/characters/:id/undo` `{ seq? }` (default: the newest
  entry that has `undo`, has no `undoes`, and isn't undone; a redo needs an explicit `seq`) -> `{ character, entry }`,
  409 `{ conflicts }` when later writes changed those entities. `afterChange(entityPrefix, fn)` hooks fire for
  commands, undo and job writes (look recomposes when a `layer:` entity changed). Cross-character effects after a
  commit: `gear.remove` on a horse updates every rider whose mount wears it (`mount.update`, journaled on the rider).
- `server/journal.ts`: append/read `JournalEntry` lines; seq assigned under the store lock; `undoneBy` derived on
  read; v1 lines read with `seq = -(line + 1)`, `what: 'legacy'`.
- `server/jobs.ts`: `enqueue(kind, label, characterId, run: (job, update, signal) => Promise<void>, { lock?:
  'files' | 'none', exclusive?: string })`. `lock: 'files'` jobs (inspect, reimport, rig, fit, fingers, template fit,
  convert, compose, fill, garment import, paint save) run one at a time per character; Codex and library saves use
  `'none'`; `exclusive` keys (`'game-export'`) serialize across characters. `cancel(id)` aborts the signal;
  `runBlender`, `runCodex`, the torch runs and the build spawn with `detached: true` and kill the process group;
  cancel takes the failure path (status and files rolled back, the game's units.json restored). `busy(id)` for
  routes (DELETE, reimport, rig, fit). Any route that spawns Blender/Python or rewrites character files is a
  `lock: 'files'` job. `POST /api/jobs/:id/cancel`.
- `server/http.ts`: router, `HttpError, send, readBody, readJsonBody, by(req)`. Every non-GET request must carry
  `x-rigsmith: 1` **or** `x-rigsmith-by` (both force a CORS preflight; 403 otherwise). `/files/*` serves only
  `characters/**` (not `journal.jsonl`, `character.json`, `character.v1.json`, `weight_edits.json`) and `library/**`.
- `server/compat.ts` (deprecated v1 layer, for the game repo's scripts and `tools/game_import.py` until ported):
  `GET /api/characters` and `GET /api/characters/:id` answer the v1 view (`legacy.toV1`) unless the request carries
  `x-rigsmith-schema: 2` (the app, `tools/rig.ts` and the other new clients always send it); `PATCH
  /api/characters/:id` accepts only `{animations?, scripts?, garments?, props?}` in v1 shape, converted by
  `legacy.v1PatchToCommands` into one batch (journaled by the caller's `x-rigsmith-by`), 410 for any other key. The
  upload routes keep their paths and query params (`POST /api/characters?name=`, `POST
  /api/characters/:id/garments?name=&kind=` plus optional `bone=`, `from=`, `name=`), `/rig` and `/reimport` too.
- Restart recovery (dev and preview): `importing` re-inspected; `rigging` -> `rigged` when `files.rigged` exists
  (else `ready`) with `error` "the rig was interrupted" and a journal line; gear left `importing` re-queued from
  `garments/<id>/source.*`; stray `rigging-*.glb`, `finger-joints-*.json` deleted.
- `DELETE /api/characters/:id`: 409 `{ riders, units, busy }` while referenced or busy unless `?force=1` (which also
  clears the riders' mounts).

### 4.3 Client core

- `api.ts`: typed calls; every request sends `x-rigsmith: 1` and `x-rigsmith-schema: 2`. `api.command(id, commands,
  cid)`, `api.undo(id, seq?)`, `api.cancelJob(id)`, `api.journal(id, last)`.
- `app.svelte.ts`: `characters, selectedId, step (7 ids, old ids mapped) — both read-only outside app, jobs, toasts,
  settings, connected, journalBeat, gameBeat, drawer: 'library' | 'catalog' | 'activity' | null`.
  - `do(id, command | command[]): Promise<JournalEntry | null>`: optimistic `applyCommands($state.snapshot(c), …)`,
    kept in `pending` by `cid`; every server copy (reply or SSE `{character, entry}`) is accepted if its version isn't
    older, drops pending commands whose cid it contains, and re-applies the rest on top. On failure: error toast,
    the pending command dropped.
  - `undo(id, seq?)`; on SSE reconnect every character is refetched.
  - Navigation: `go(step): Promise<boolean>`, `select(id): Promise<boolean>` await every `guard(fn)` registered
    (`guard(fn: (next: { step?, characterId? }) => boolean | Promise<boolean>): () => void`) before changing.
  - `confirm({ title, body, confirm, danger }): Promise<boolean>` (rendered by `src/ui/ConfirmDialog.svelte`,
    mounted once by App); `setBusy(key, text | null)` and derived `busy` (the viewport's one busy pill).
- `src/ui/`: existing Button, Popover, Section, Segmented, Toggle, tooltip, shortcuts plus new `Field`,
  `NumberField`, `Select`, `TextField`, `IconButton`, `Badge`, `ConfirmDialog`, `Drawer`, `Tabs`, `EmptyState`
  (tooltips also show on keyboard focus).

### 4.4 Kernel

- `glb.ts`: `readGlb(bytes: Uint8Array) -> { json, bin: Uint8Array | null }`, `writeGlb(json, bin) -> Uint8Array`,
  `accessor(glb, index)` (typed view), `imageBytes`, `setImageBytes`, `bindJoints(glb)` (rest heads from inverse
  binds). The only GLB chunk parser: `server/glbimages.ts`, `server/weights.ts`, `server/library.ts`,
  `server/glbtransform.ts`, `tools/skin_opt/apply.ts`, the unit export use it.
- `lods.ts`: `simplify(geometry, ratio, lock?: Uint8Array)`, `compact`, `triangles`.
- `headless.ts`: the Node shims (self, createImageBitmap, FileReader, GLTFLoader warning filter) and `loadGlbFile`;
  `tools/lib/node3d.ts` and `server/rest.ts` use it; no script declares its own.
- `contract.ts`: the game's rules as constants and small functions, shared by the unit export, `checks.ts` and the
  scale room: `SWAPPED = /^(Gear|Head|Wear)/`, `STEPS`, `STANDS` and their thresholds (0.12 swing, 0.8 hips),
  `NO_LOD_BELOW = 60`, `DEFAULT_LODS = [0.45, 0.15]`, `gearExported(g)`, `meshNameOf(g)`, `budgetOf(parts)`.
- `clips.ts`: `interface ClipSource { get(ref: ClipRef | string, o: { inPlace: boolean, mirror?: boolean, fps?:
  number }): Promise<THREE.AnimationClip> }`; `RetargetCache` implements it in the browser (fetch),
  `nodeClipSource(rest, workspace)` in `tools/lib/node3d.ts` (files). Both call the same `retarget()`.
- `geom.ts`: `firstSkinned(root)`, `safeName(name)`, `gearNode(gear) = '<safeName>_place'`, `principalAxis(points)`,
  `handWidth(...)`, `wp/wq` helpers — the copies elsewhere are deleted.
- `hands.ts` (replaces `scripts.ts handScripts`): **the one hand pose resolver**. `DEFAULT_FIST` (re-exported from
  select) and `FISTS` (the five fist clips offered in pickers) live here; `animator.fistOf` goes.
  ```ts
  export interface HandLayer { source: 'carry' | 'hold' | 'pull' | 'slot'; ref: HandPoseRef; windows?: Window[]
    reason: string /* "carries GearAxe", "drawing GearBow · Draw", "held in every clip", "this slot: open" */
    gear?: string; handle?: string; adjustment?: string }
  /** Bottom to top. carry: at most one per hand, from select.carriedBy (ready, shown, bone gear on that hand), unless
   * its pose is 'clip'. hold: hands.hold[side]. pull: a pull handle of shown ready gear drawn by that hand with a
   * pose set, in its handleHold windows. slot: the slot's handPose adjustments (windows; none = whole clip; with
   * `gear`, only while that gear is carried by that hand). At a phase the topmost active layer wins; edges ease
   * over 0.06 of the clip. Windows are phases of the clip after timing. */
  export function handLayers (c: Character, slot: Slot | null, side: Side): HandLayer[]
  export function handAt (layers: HandLayer[], u: number): { layer: HandLayer | null, weight: number }
  export async function poseOfRef (root, side, ref: HandPoseRef, c: Character, clips: ClipSource, shared?: HandPose[]): Promise<Map<string, THREE.Quaternion> | 'clip'>
  export async function applyHands (root, clip, c, slot, clips: ClipSource, shared?): Promise<{ clip, report }>
  ```
- `timing.ts`: `blowCut`, `blowTime`, `paceTo`, `stride`, `cut`, `retime`, `sample`, `saveBones`, `fistPose`,
  `holdFist` (moved from scripts.ts, behaviour unchanged).
- `bake.ts` (replaces `animation.ts bakeEntry` and game_export's copies): **the one bake**.
  ```ts
  export interface BakeContext { rest: RestSkeleton; posable: THREE.Object3D; clips: ClipSource; fps?: number
    sharedPoses?: HandPose[] }
  export interface BakedSlot {
    clip: THREE.AnimationClip        // everything
    raw: THREE.AnimationClip         // retargeted with slot.inPlace, speed 1, no hands, no adjustments
    unkeyed: THREE.AnimationClip     // before keys
    cut?: { start: number, end: number, uncut: number, blow: number }
    lift: number                     // the total ground lift applied (ground adjustment + autoGround)
    gearKeys: Record<string, ClipKey[]>   // enabled keys.gear (gear id -> keys), phases of the final clip
    pulls: PullPlan[]                // windows are phases of the final clip
    hands: Record<Side, HandLayer[]>
    report: Record<string, unknown> }
  export interface PullPlan { gear: string; handle: string; bone: string; windows: Window[] }
  /** speed -> blowTiming -> pace -> hands -> ground -> keys(bones) -> gear tracks.
   * skip: kinds to leave out, plus 'speed' and 'hands' (every hand layer); 'all' = the clip alone (speed 1, no
   * hands, no adjustments). autoGround: a ground fit by the feet added on top (library previews). */
  export async function bakeSlot (c: Character, slot: Slot, ctx: BakeContext, o?: { mirror?: boolean;
    skip?: Array<AdjustmentKind | 'speed' | 'hands'> | 'all'; autoGround?: boolean; gearNodes?: boolean }): Promise<BakedSlot>
  export function pullPlans (c: Character, slot: Slot): PullPlan[]
  export async function bakeRide (rider: BakedSlot, horse: { c: Character; ctx: BakeContext; slotName: string },
    mount: Mount, o: { loop: boolean; attack: boolean; rest: RestSkeleton /* the rider's */; mirror?: boolean }):
    Promise<{ rider: BakedSlot /* clip and unkeyed frozen and fitted; pull windows and gearKeys repeated over the
    cycles */; horse: THREE.AnimationClip | null /* no such slot and no Idle */; cycles: number; report }>
  export interface GearTrackTarget { gear: Gear; node: string; rest: { position: THREE.Vector3; quaternion: THREE.Quaternion }
    placeScale: number; moveScale: number }
  export function gearTracks (duration: number, keys: Record<string, ClipKey[]>, loop: boolean, targets: GearTrackTarget[]): THREE.KeyframeTrack[]
  ```
  A library preview is `bakeSlot` of an ephemeral slot `{id: 'preview', clip, speed: 1, loop, inPlace, adjustments:
  [keys {gear: gearKeysFromPaths(c, clip.propPaths)}]}` with `autoGround`. `LibraryClip.propPaths` stay keyed by gear
  name (they are shared across characters).
- **The unit export** (`tools/lib/unit_export.ts`): `exportUnit(unit, spec, { workspace, modelsDir, workDir,
  runToken? }): Promise<BuildRecord>`; `tools/game_export.ts` is a thin CLI with the same command line as before
  (`node tools/game_export.ts <spec.json> <models dir> <work dir> [unit ...]`), reading `RIGSMITH_RUN` from env.
  Characters (unit and companion) are read through `readCharacter`; settings through `migrateSettings` (shared
  poses). The audit file is read lazily from the workspace. It calls `bakeSlot` (and `bakeRide` when ridden) on the
  character as the viewer does, then: scales and grounds positions into game units; adds `root` above Hips; names the
  mesh after the unit and its LODs `_LOD1/_LOD2` (lock-aware `simplify`); one material `Main`; gear: the set of keyed
  gear is the union of `gearKeys` over the exported slots, each keyed gear gets a `Prop_<safeName>` bone under its
  bone (tracks from `gearTracks` with bone-local game rest, `place.scale`, `moveScale = s`; a gear model is loaded with
  its `origin` at zero, as the viewer loads it, so the bone sits on the piece's origin), pull bones
  `Prop_<gear>_<handle>` under the riding bone (or under the Prop_ bone when keyed) with tracks from `pulls`; strips
  `_place` tracks; companions the same way with their prefix. Mesh names of game gear come from its `from` part.
- **Build record** (`<work>/<unit>/rigsmith.json`), read by the game (`emb_rigsmith.py`: `texture.file`,
  `texture.sha256`, the keys of `clips`, `companion`) and by `tools/game_import.py`. Keep every v1 key (unit,
  generator, rigsmith, height, scale, bones, triangles, clips{name: {clip, url, loop, inPlace, speed, seconds, lift,
  blow, kept, hit, pacedLike, retimed, footSwing, hipsMedian, audit}}, gear{meshName: {...}}, companion, walkStride,
  runStride, mount, texture{file, sha256}, rigged) and add `schema: 2`, `run` (the run token), `slots` (as baked,
  adjustments included, gear references by gear name), `hands` (hands.hold), `gearIds` (gear id -> {name, from}).
  `scripts` is no longer written.

### 4.5 Viewer seam (shell owns `src/state/viewer.svelte.ts`)

The viewer loads the character's GLB (and its horse) into the stage and knows nothing about areas. Areas subscribe:

```ts
viewer.onLoad(fn: (view: CharacterView, c: Character) => void | (() => void), order = 30): () => void
  // fires at once if a view is loaded; the returned cleanup runs on unload. order: gear 10, motion 20,
  // skeleton/skin/look/hands 30, ship 40 (gear nodes exist before the animator bakes gear tracks)
viewer.onSync(fn: (view: CharacterView, c: Character, step: Step) => void): () => void
  // after load and whenever the step or the selected character's version changes
viewer.mount   // { view: CharacterView, seat: THREE.Group, character: Character } | null: the horse
viewer.onMountLoad(fn) / onMountUnload(fn)   // the horse; gear's rig hook also runs on it (wearing mount.gear)
viewer.setOverlay(key, o: { component, props, covers?: boolean, blocksInput?: boolean } | null)
  // Viewport renders registered overlays; stage.covered = any covers; canvas input blocked while any blocksInput
viewer.character / stage / mode / setMode / loading / loadError / reload()
```
Stopping playback when the step changes is the animator's rule (§4.6), not the viewer's. Horse heights for the seat come from a getter Ship registers (`viewer.setHeights(fn)`). On unload:
mount hooks, then the rider's root back to `stage.content`, then the main view's cleanups. CharacterView exposes
`bodySkinned`: the skinned primitives of the character's own file in glTF scene order (depth first); weight edits
address `mesh` by that list and `PUT /weights` rejects (400) any edit out of range.

### 4.6 Motion seam (motion owns `src/state/animator.svelte.ts`)

```ts
animator.playing: { slotId: string | null; baked: BakedSlot | null; phase: number; time: number; editing: boolean } | null
animator.onTick(fn: (phase: number, time: number) => void): () => void
animator.guard: (() => Promise<boolean>) | null   // awaited by play/playEntry/stop/refresh/detach; false = don't
animator.showClip(clip, { pulls?, label }) / leaveEditor   // for the editor
```
Gear's `pulls.ts tickPulls(plans: PullPlan[] | null, u)` (rigs keyed by gear and handle id) is called by the animator
each frame with the playing `baked.pulls` (or the editor's). The hands panel reads `animator.playing` for the
playhead's layer. Mechanisms are ticked by gear through `stage.onFrame`. The "stop playback when leaving
gear/motion/ship (and skeleton/skin without a deformation test)" rule is the animator's own, through `viewer.onSync`
(the viewer doesn't import the animator).

### 4.7 Cross-area components and state APIs (built at the same time; code against these names)

| Owner | What | Signature |
|---|---|---|
| hands | `src/app/hands/HandsPanel.svelte` | props `{ character: Character }`; embedded by GearPanel and MotionPanel |
| hands | `src/app/hands/HandPoseSelect.svelte` | props `{ character: Character, value: HandPoseRef \| undefined, onchange: (v: HandPoseRef \| undefined) => void, unsetLabel?: string, side?: Side }` (options: unset (if unsetLabel), Default fist, Open (the clip's own hand), the character's poses, shared poses, the fists in `hands.ts FISTS`; picking a shared pose copies it onto the character first) |
| hands | `src/state/hands.svelte.ts` | `hands.capture(character, side)` (the playing frame's hand as a new pose, via `animator.playing` + `animator.posableCopy()`), `hands.preview(character, side, pose \| null)` (shows a one-frame clip through `animator.showClip`) |
| skin | `src/app/skin/WeightPaintPanel.svelte` | props `{ character: Character, gear?: Gear }` (body when no gear); embedded by SkinPanel and GearPanel |
| skin | `src/state/paint.svelte.ts` | `paint.active`, `paint.stop()` |
| editor | `src/app/editor/EditPanel.svelte` | props `{ character: Character }`; embedded by MotionPanel |
| editor | `src/state/clipedit.svelte.ts` | `clipEdit.active, busy, phases, selectedPhases, snapTime(t), setLoop(on)` (read by the Timeline) |
| motion | `src/app/motion/LibraryDrawer.svelte`, gear `src/app/gear/CatalogDrawer.svelte` | no props; App renders them when `app.drawer` is `'library'` / `'catalog'` |
| motion | `src/app/motion/Timeline.svelte` | registered by motion with `viewer.setOverlay('timeline', { component, props: {}, dock: 'bottom' })` whenever something plays |
| motion | `src/state/animator.svelte.ts` | §4.6 plus `playSlot(character, slotId)`, `playLibrary(clip)`, `playTest(test)`, `stop()`, `seek(t)`, `setPlaying(on)`, `refresh()`, `time`, `duration`, `clipSource: ClipSource` (the shared RetargetCache), `posableCopy()` |
| gear | `src/state/gizmo.svelte.ts` | `gizmo.attach(target: THREE.Object3D, { mode: 'translate' \| 'rotate' \| 'scale', space: 'local' \| 'world', onChange?, onCommit: () => void })`, `gizmo.detach()`, `gizmo.mode`; the ship seat editor uses it |
| ship | `src/state/mount.svelte.ts` | registers `viewer.setHeights` (game heights of rider and horse) |
| shell | `src/state/viewer.svelte.ts` | §4.5; `setOverlay` options also take `dock?: 'bottom'` (docked under the viewport instead of over it) |

---

## 5. The UI frame

- **Top bar**: brand, the seven steps (each with a done/needs tick from `select`), the activity button (running jobs
  count; opens the Activity drawer), settings.
- **Left**: the character list, always (import, rename, delete with confirm and busy/reference check, status from
  `phaseOf`, search box, Auto-rig all). Drawers open over the viewport's left edge: the clip **Library** (Motion) and
  the gear **Catalog** (Gear), toggled from their step.
- **Center**: viewport + timeline dock.
- **Right**: the step's inspector only (no History under it).
- **Activity drawer** (right overlay): this character's journal (newest first, who/when/what; Undo on undoable
  entries; notes box) and all jobs (progress, cancel, error text, link to their character).
- **Hands panel** (`src/app/hands/HandsPanel.svelte`): shown in Gear and Motion: for the slot playing (or rest),
  each hand's layers from `handLayers` with the winning one at the playhead highlighted and its reason; the named
  hand poses list with editor.

Step panels (`src/app/steps/<Name>Panel.svelte`, prop `character: Character`):

1. **Import**: source, kind, stats, size (height + floor), warnings, re-import (confirm, busy guard, errors shown;
   keeps overrides), delete.
2. **Skeleton**: template picker (human, horse; "Other creatures"), one joint view: marker board and 3D joints are
   two cameras on the same overrides (one Mirror toggle), joint chips, finger level and "Detect again" as generator
   buttons, stale overrides list (restore/discard), Reset (confirm), template switch (confirm: it clears slots,
   markers and overrides), **Rig** (warns when painted weights exist; refuses with the reason while the skin is
   locked).
3. **Skin**: rig report as decisions, lock (with reason; unlock confirm), deformation tests, weight view chips,
   weight painting (body).
4. **Gear**: gear list (game gear, catalog, uploads; swap sets; show/hide), selected item: name (locked for game
   gear), attach (bone list from the hierarchy; "Other ways to wear it"), placement gizmo + numbers, handles list
   (carry / grip / pull, each with its hand pose), gear weight painting (skin gear, pulled gear). Hands panel.
5. **Look**: layers list (fill, repaints, snapshots: toggle, remove, reorder; each undoable), Find and fill holes,
   projection painting (mask tools, notes, capture, Codex or an image, preview, Keep as a new layer, Discard).
   **Qwen** (2026-10-31): "Paint with Qwen (local, seconds)" beside Codex, `POST .../projections/<id>/qwen` (`runQwenPaint`,
   `tools/paint_capture.py`): each view's masked area cropped (its box and a quarter round it, square, at least 128 px),
   edited at 512 px by Qwen Image 2.1 in the local ComfyUI (:8188, `tools/comfy/qwen_edit.json`) from the capture's notes,
   sized back and laid over the view inside the feathered mask only; `result-N.png` as Codex writes it. ~11 s a view
   (Codex: minutes). Qwen gets no mask (`--mode edit`): as a latent noise mask, hard or blurred with Differential
   Diffusion, it left an olive ring along the mask's edge. It shares the Codex job's slot per capture.
6. **Motion**: the unit's slots + trials (stable ids; arm a slot then pick a card; "Use" when previewing), per-slot
   controls (speed, loop, in place), the adjustments stack (add/enable/remove/edit: ground with Auto, blow timing,
   pace, hand pose, handle hold, keys), the timeline with lanes for the playing slot's adjustments (windows, keys,
   blow mark), the clip editor (Edit), Hands panel, copy set to other characters (confirm; uses `freshSet` and
   `gearNames`).
7. **Ship**: unit (make a unit, height with the scale room, budget, LODs, clips list, draft), companion, mount
   ("Rides" writes the mount and the unit's companion together; seat editor moved here from Outfit; skin and gear of
   the horse), checks (contract rules pass/fail before export, from `checks.ts`), Export to the game (cancel), last
   build record (strides, holds failed, warnings), the game repo path setting.

---

## 6. Behaviour fixes (PLAN.md §4) and where they land

| # | Fix | Area |
|---|---|---|
| 1 | Save to slot over a `custom-` clip forks unless only this slot uses it (`GET /api/library/usage/:clipId`, checked again server-side on save) | editor |
| 2 | No double adjustments. The editor opens "as it plays" (`bakeSlot`) or "the clip alone" (`skip: 'all'`). Saving "as it plays" is one batch `slot.fill {id, clip: saved, keepAdjustments: false, speed: 1, adjustments: kept}` with, per kind: speed baked (slot speed 1); blowTiming, pace, keys.bones baked and removed; ground kept (its lift taken out of the saved frames); keys.gear re-extracted from the edited clip as the new keys {gear}; handPose and handleHold kept (their windows are phases of the final clip, which is the saved clip). Saving "the clip alone" keeps the slot's speed and adjustments; its window editors are disabled in that mode | editor |
| 3 | Editor: confirm before discarding unsaved edits (Finish, step change, another clip, another character: via `app.guard` and `animator.guard`); an undo/redo stack for edits; the commands it issued during the session (their journal seqs) are listed on discard and undone if the user chooses | editor |
| 4 | Re-import: confirm, 409 while busy, errors shown; writes `skeleton.detected` only per §2.2; rigged imports keep their resize (`inspect.py` applies `--scale`/`--ground` to rigged imports too); a converted import stays converted | shell |
| 5 | Painter re-attaches after a reload (viewer onLoad cleanup + re-attach), stops on character change (app.guard), mask overlay shown again after stacking | look |
| 6 | Game export: back up the game's `units.json` before splicing and restore it if the build fails or is cancelled; one export at a time (`exclusive: 'game-export'`); `RIGSMITH_RUN` passed through build.sh's environment, then the record at the GLB's path (respecting `models_dir`) must carry that run token and the GLB's mtime must be after the start, else the job fails | ship |
| 7 | `trainedClips` excludes `holdout.json` clips | skin |
| 8 | Template switch confirms (it clears slots, markers, overrides); Rig warns first when painted weights exist, and the server pre-checks the paint mapping (`checkPainting(modelGlb, edits, bones)` against model.glb's meshes and hierarchyOf names) before enqueueing (409) | skeleton, skin |
| 9 | Kind change keeps nothing inapplicable: `gear.attach` replaces the attach whole | model, gear |
| 10 | Slots by stable id; card checkmark removes only trials of that clip (asks first); windows keyed by slot via adjustments | model, motion |
| 11 | `/files` restricted; mutating routes need `x-rigsmith: 1` or `x-rigsmith-by` | server-core |
| 12 | `viewer.loadError` shown | shell |
| 13 | One `assertUnlocked(c)` in `server/routes/skin.ts`, called by: POST /rig; runRig at start and again under the store lock just before publishRig; PUT/DELETE /weights; /template, convert and /fingers at a new level (not a same-level "Detect again") whenever `files.rigged` exists, before enqueueing and again inside the job. `tools/skin_opt/apply.ts` needs an explicit output path and refuses `characters/*/rigged.glb`; `tools/dev/coat_weights.ts --apply` checks the lock | skin, skeleton |

PUT/DELETE `/weights` (body and gear) run as `lock: 'files'` jobs (or answer 409 while one runs) and write through
`withFiles`.

---

## 7. Look (texture layers)

- Every layer is an RGBA decal in its image's own layout: colour, and alpha how strongly it covers what is under it.
- `blender/jobs/texture_compose.py` (a `lock: 'files'` job, coalesced to one pending per character) imports the
  source model **without** overrides, then per image: with enabled layers, writes `textures/<image>.png` = the
  source image with each enabled layer laid over in order (resampled to the image size); without, deletes
  `textures/<image>.png` and writes the source image to a temp dir used as `swapImages`' restore source. Then
  `swapImages` into `model.glb` and `rigged.glb` (under `withFiles`), bumps `look.at` and `revision`, clears the
  thumbnail. It never runs inspect (inspect re-detects joints). The job fails when a layer's image matched no image.
- Fill (`texture_fill.py`) writes `textures/layers/<id>.png` with alpha = its composite alpha (not forced to 1) and
  the route inserts the fill layer at index 0, replacing that image's previous fill layer; then compose.
- Keep (projection painting) uploads the bake as a decal (`bakeViews` in decal mode: rgb = painted colour, alpha =
  the composite weight) to a new `repaint` layer on top; the upload route rejects (400) an image name not among
  model.glb's images; then compose.
- `look.layer.remove` never deletes the file (undo can bring it back); files go with the character or a clean-up.
- The legacy single-view capture path goes; the two old Seer captures are left on disk, unlisted.

---

## 8. Phase 3 (solvers) for the editor area

- Delete `bodysolve.ts`. Without a pose model (non-human templates) the editor builds edits from keys and IK only;
  prop leading and Naturalize are offered only where the natural rig exists (as now).
- **The body is solved only when asked** (the designer, 2026-10-28: the solve on every gizmo move "freaks out" when
  it takes two moves to get an arm away from the body). A drag is IK alone (hands on gear follow by IK), and so is the
  build. **Solve body** (`clipEdit.solveBody`) works on the frame shown: each arm inside another body part is first
  pushed straight out of it in small steps (`pushclear.ts`: a free hand carried out along the contact's normal, an
  elbow swung round the shoulder-to-wrist line; the first step that clears is kept), then, where hands hold gear, the
  natural-pose solver fits the body to them (`frameSolve`'s goals), its result dropped if it leaves a part deeper in
  another; what it moved is keyed on that frame.
- **One pose-quality model**: `JointLimits` (ROM) is the only joint-range model (hard clamp in IK, soft penalty in
  the solver, and the bounds handcontacts uses come from it instead of its own 35°/10° constants where the tests
  allow); the PCA model and the hand-written costs stay inside `posespace.ts` as the one "is this pose human" score;
  shared constants (`Y_BOT_LEG`, …) defined once.
- **One collision model**: `bodycollide.ts` owns a `CharacterCollider` (capsules for the body, lazily built hand
  surfaces from `surfacecontact.ts` for fingers, prop shaft obstacles) used by the solver, propfit, handcontacts and
  the editor; `propfit`'s `BodyColliderLike`/`NO_COLLIDER` and clipedit's ad-hoc obstacle conversion go.
- Keep numerical behaviour where `posespace.test.ts`, `handcontacts.test.ts`, `bodycollide.test.ts` pin it.

## 9. Phase 4 (tests on the contract)

- `tests/contract/unit.test.ts` (`// @vitest-environment node`, in `npm test`): builds a fixture character in a temp
  workspace (a procedural Mixamo-named skeleton with a skinned mesh, a clip GLB, a bone gear piece with a pull, slots
  with adjustments), runs `exportUnit`, and checks the game's rules: mesh named `<unit>` and `_LOD1/_LOD2`, one `Main`
  material, `root` above `Hips`, `Prop_*` bones for keyed gear and pulls, LOD0 within budget, soles at y = 0, clip
  names, strides and the run token in the record; and that the viewer's `bakeSlot` and the export agree (parity by
  construction, checked on a bone and a gear point).
- `src/engine/checks.ts` runs the same rules (those checkable without exporting, from `contract.ts`) for the Ship
  step's Checks list, plus: game gear name equals its from-part, `Weapons_<X>` rides bone X, no two Prop_/pull bone
  names collide, mount horse equals the unit's companion, mount gear not exported (info).
- Templates: `templates.ts` has the registry (`status`); creature deformation tests only for the horse.

## 10. Open questions left for the owner

- Should a rider's horse gear (`mount.gear`) ship in the game export? (It never has.)
- The game repo's scripts use the deprecated v1 layer (§4.2); port them to `/commands` when convenient.

## 11. Change log of the contract

- Forge (docs/dressing-plan.md Phase 4): **one GPU lane** in `server/jobs.ts`: `gpuTurn(job | {label}, need: {vram MiB,
  family}, signal?, {onWait?}) -> {id, release()}` and `withGpu(...)`: strictly first come first served (`reorderGpu`),
  ComfyUI told `POST /free {"unload_models":true,"free_memory":true}` before a job of another family when ComfyUI had the
  GPU last (and once when the VRAM is short and it may hold models from before), the head waits, without a timeout, until
  nvidia-smi ($NVIDIA_SMI) shows its `vram` free; why it waits goes to its job's message, `onWait` and the `gpu` event
  (`gpuState()`). skinopt's private queue is gone (its optimize.py takes a turn, 'torch' 3 GB); `runQwenPaint` takes one
  ('comfy' 10 GB, `o.job`). ComfyUI's address: $COMFY_URL, else `gpuConfig.settingsComfy`, else forge.json's `comfy`.
  `server/forge/*`: the game's `forge.json` (pipelines of stages: cmd with {work} {out} {spec} {seed} {item} {set}
  {attempt} {repo} {in.X}, gpu, variants, gate pick/approve/align/mask, inputs {stage}|{file, as}, outputs, code,
  scratch, mutates, resumable, timeout, generative, cache, env, splits; publish {into, from, stages, roster, character});
  the store `<store>/<set>/<item>/<stage>/<attempt>/{work,out,manifest.json,job.json,log.txt,spec.json}` +
  `selected.json`, attempts a001.. never overwritten (`.partial` after a restart), key = hash of version, cmd, params,
  seed, item spec, input hashes and code hashes, staleness worked out from it; `queue.json` with lanes gpu (one) and cpu
  (two). Routes: `GET /api/forge`, `GET /api/forge/events` (SSE `forge` {job, progress, eta, logTail} at ~4/s and
  `gpu`), `POST /api/forge/sets`, `.../sets/:set/items`, `.../sets/:set/run` (a batch), `.../items/:item/run|pick|approve`,
  `.../sets/:set/publish` (a jobs.ts job 'forge-publish'), `POST /api/forge/queue/reorder`, `.../queue/:id/cancel`;
  `/files/forge/<set>/<item>/<stage>/<attempt>/(out/…|log.txt|manifest.json|spec.json)` read-only (registered before
  `/files/*`: server/api.ts imports routes/forge.ts first). `resumeInterrupted` ends with `resumeForge()`.

- Schema 3 (docs/motion-plan.md): slots are source clip + time map + tracks, every time stored against the source
  clip; `blowTiming`, `pace` and `keys` adjustments became `slot.time.fit` (its picked blow the `hit` event),
  `slot.time.pace`, `slot.bones` and `slot.gear[id].keys`; events, retime markers, holds, per-span eases, gear held-by
  and shown segments, muted tracks; `slot.time`, `slot.keys.set`, `slot.event.*`, `slot.gear.update`, `slot.copy`;
  `BakedSlot.time`, `boneKeys`, `events`; v2 files migrate to 3 (character.v2.json kept), their phases moved through
  the measured blow cut; the export writes `<unit>.events.json` and a schema 3 build record.

- Rev 2 (design review): skeleton migration by `jointsEdited`; generator/override policies (§2.2); `imported`,
  `converted`, stale `template`/`level`; hierarchies made synchronous (`skeletons.ts`); hand layer rules (carry from
  shown ready gear only, pulls without a pose add no layer, catalog props don't close hands); bake order puts hands
  after timing and windows in final-clip phases; `skip` covers speed and hands; `BakedSlot.lift`, `gearKeys`;
  `gearTracks` targets; Handle `exact` and carry `place`; handPose `gear`; deterministic reducers (ids in commands),
  batches, `freshSet`/`gearNames`; undo with after-hashes and job-free entities; pending-by-cid client; navigation and
  animator guards; viewer `onSync`, mount, overlays; jobs locks/cancel/signal; `withFiles`; v1 compatibility layer;
  `rescale.ts`; build record spec; `unit_export.ts`; `contract.ts`; texture compose spec; lock call sites; mount gear
  decision.
- Kernel (bake): `bakeRide`'s options take the rider's `rest` (frozen bones the clip doesn't move start from it) and
  `mirror`; its `horse` is null when the horse has neither the slot nor an Idle; `gearKeys` are repeated over the
  cycles like the pull windows. Also exported: `bake.boneRest(rest)` (was `animation.boneRest(view)`),
  `clips.clipUrl`/`refUrl(ref)` (was `animation.clipUrl`/`entryUrl`), `hands.refLabel`, `hands.EASE`.
- Model (commands): `gear.handle.update`'s patch (`HandlePatch`) and `mount.update`'s (`MountPatch`) take null to
  unset an optional field (a grip for either hand, a pull's pose back to none, a rider's horse skin back to its own);
  `clips.replace` takes `handleNames` ('<source gear id>/<source handle id>' -> handle name) since a handle reference
  can't be mapped by name otherwise. Patches with undefined values treat them as not given (JSON drops them).
  Undo: a `gear:<id>` entity's `before` is the whole piece (model and status too) so a removed piece comes back with
  its files; a piece still there keeps its job-owned fields. `skeletons.ts` also exports `humanHierarchy(level)`,
  `FINGERS`, `FINGER_LEVELS`; `select.ts` also `handSide(bone)`; `entities.ts` also `stableJson`, `hashOf`; `ids.ts`
  also `fnv1a`, `hex8`; test fixtures in `src/model/fixtures.ts` (`makeCharacter`, `makeRigged`, `makeGear`,
  `makeSlot`, `humanJoints`).
- Kernel (unit export): `src/model/unit.ts` also declares the build record (`BuildRecord`, `BuiltClip`, `BuiltGear`,
  `BuiltCompanion`). Beyond §4.4 it adds `warnings` (the lines the build printed, for Ship's last-build view),
  `gearIds[id].handles` (handle id -> name, so a restore can map handleHold references), and `id` on each
  `gear[mesh].pulls[]` entry; `clips[name].keys`/`keyData` (v1 keys game_import reads) stay, keyed by gear name.
  `exportUnit(unit, spec, { workspace, modelsDir, workDir, runToken? })` lives in `tools/lib/unit_export.ts`; its
  pure helpers `scalePositions`, `seatClip`, `placeCompanionClip`, `wholeCycles`, `recordSlots` are exported for tests.
  `tools/lib/node3d.ts`: every reader takes an optional `workspace`; also `clipFile(url, workspace)` and
  `settings(workspace)`. Pulled gear's painted weights are keyed `PropRoot` / `pull:<handle id>`
  (`gearskin.pullWeightName`); pull bones are named `Prop_<safeName(gear)>_<safeName(handle)>` by the export itself.
- Gap fixes (completeness critics): `legacy.toV1(c, units?, job?)` lays a queued/running job over the v1 status
  ('importing' for inspect/reimport, 'rigging' for a rig, 'error' when the character holds one) so the game repo's
  scripts can wait on it; `hands.handleRef(c, slot, side, gear, handle)` is the editor's hand on a handle (a slot's
  whole-clip handPose, then the handle's own pose, then hands.hold (which also wins over a carry handle's pose, as the
  bake has it), then 'default'); `gear.attach` leaving 'bone' takes the piece's grip and pull handles, their
  handleHold adjustments and its keys.gear with it, and `gear.handle.add` refuses grip/pull handles off a bone; the
  look compose keeps a record in `textures/.composed.json` (layers null while one runs) and restart recovery
  recomposes when `look.composeStale(c)`; `/fingers` level changes call `assertUnlocked`; paint saves write
  `rigged.glb` through a temp file; one window formatter ('50–80%', frames when known) everywhere.
- Verification (first test run): the body solver pulls toward a seed (a live drag's pose) at the follow weight, not
  only starting there, so a full solve can't swap it for a cold search's lower total and the body doesn't jump on
  release (§8); the hand carrying a piece that doesn't lead is held as a carrier (its turn exact) so the other hand's
  handle doesn't drift with it; `tsconfig.json` sets `erasableSyntaxOnly` (Node runs `tools/*.ts` by stripping types,
  so parameter properties and enums are not allowed: the automap enums became const objects); `jobs.busy()` names the
  running job before a queued one; Stage uses THREE.Timer and PCFShadowMap (the deprecated Clock and soft shadow map
  are gone).
- Foundation (docs/dressing-plan.md Phase 0, 2026-11-06): **files by content.** `server/files.ts` indexes the
  characters' folders and library/{clips,creatures} (path -> size, mtime, inode, 16-hex SHA-1; hashed only when the
  stat changes; kept in `workspace/.cache/files.json`), watches them recursively and emits SSE `files` `{ character:
  id | null (the library), changed: { path: hash | null } }`. `GET /api/characters/:id/files`, `GET /api/library/files`
  and `GET /api/thumbnails` answer manifests; `/files/...?h=<hash>` is served `immutable` only while the file holds
  that hash (`no-store` otherwise; no `h`: `no-cache` with an etag). `store.onWritten(fn)` is called before every
  `character` event (a write that isn't a command rescans the folder; wired in server/plugin.ts), `store.adopt(id)`
  re-reads a character.json changed on disk (its version moved past the last handed out), and `commit` never hands out
  a version below the last one. Client: `src/state/assets.svelte.ts` `asset(c, path)` replaces `api.fileUrl` (removed:
  no `revision`, `look.at`, `thumbVersion` or `?v=` tokens in URLs); `src/engine/assetUrls.ts` `versioned(url)` for
  loaders of plain `/files/` URLs (clip refs stay plain); every client cache is `src/engine/lru.ts` `Lru` (byte budget,
  disposes three.js objects); `clips.forgetClip`, `RetargetCache.forget` and `animator.forgetClip` are gone; the library
  page's clips carry `hash`. A change in src/state, src/engine or src/model reloads the page in dev. **Dress state:**
  `src/state/dressing.ts` (`Dress`, `resolve`, `shows`, `setsOf`/`setsWith`: the one place set membership is read,
  `defaultCommands`) and `src/state/dress.svelte.ts` (per character, localStorage); browsing a dynamic character never
  sends commands, "Make default" sends `gear.outfit.show`, `look.skin.show`, `look.clothing.show`, `gear.update
  {hidden}` as one entry; `gear.shownOnStage(c, g)`. **Perf:** `src/engine/perf.ts` dev marks and long-task logger,
  `window.__rigsmith` in dev, `npm run perf` (tools/perf.ts, tools/lib/profile.ts, tools/lib/chrome.ts `withChrome`,
  tests/perf/{scenarios.ts,budget.json}). The unit export writes through `tools/lib/atomic.ts` (temp + rename, skipped
  when the bytes are the same).
- Schema 5 (docs/dressing-plan.md Phase 1, the model lane): `Character.folk?: FolkSection {sets: OutfitSet[], pools:
  Pool[], kinds: UnitKind[], stances: Stance[]}`, `look.cloth?: ClothLayer[]` (slots bottom/top/over, cut, trim,
  shapes, tags, coverage), `Skin.bare?`; `PoolKind`, `ClothSlot`, `CLOTH_SLOTS`, `ClothCut`. v4 files migrate to 5
  (character.v4.json kept): each Gear.outfit a set (stableId '<id>:set:<outfit>', grants from its pieces), the hair
  and beard roles pools with the old rules as requires/excludes (fem requires female, masc excludes it; hair excludes
  covers-hair; beards chance 0.5, exclude beardless and covers-face), the skins the skin pool, each look.clothes a
  cloth layer (top and bottom; long-sleeves the long_sleeve shape, excluding bracers) in the cloth pool, kinds from the
  game's units' folk.outfits else one kind 'folk' with `{query: []}`. Gear.outfit/role and look.clothes stay (the UI
  reads them until ported) and the old commands keep the folk data in step (src/model/folk.ts syncLegacy*). Every
  reader of outfit membership goes through src/model/folk.ts (`folkOf`, `setsOf`, `setsWith`, `piecesOf`, `poolsOf`,
  `kindsOf`, `clothOf`, `grantsOf`, `regrant`, `isFolkCharacter`). One pick engine, src/engine/folkpick.ts (`PROGRAM`,
  `pick`, `candidates`, `tagsAfter`, `worldOf`, `goldens`, `draw`: fmix32(fnv1a32('<uid>|<salt>|<k>')) / 2^32);
  folk.ts's fits/coversHair/coversFace/hasBracers/clothesFor/pickFolk are deprecated. Commands `folk.set.add/update/
  pieces/duplicate/remove/reorder`, `folk.pool.add/update/items/remove`, `folk.kind.add/update/sets/remove`,
  `folk.stance.add/update/clip/remove`, `look.cloth.add/update/remove/reorder`, `look.skin.bare`; entities `set:`,
  `pool:`, `kind:`, `stance:`, `cloth:` and `setOrder`, `poolOrder`, `kindOrder`, `stanceOrder`, `clothOrder` (an
  empty folk section or cloth list restores as none); gear.remove takes the piece out of sets and pools, slot.remove
  and clips.replace take gone slots out of stances; look.skins.set keeps a skin's bare version. `UnitSpec.folk` gains
  `kind` and `pools` (outfits, hair still read). The folk manifest is schema 2 (tools/lib/folk_export.ts
  folkManifestData: rng, program, regions, bodies, packing, skins, layers, sets, kinds, pools, pieces, stances,
  golden, plus schema 1's outfits/clothes/hair/beard/rules). The store, compat (`x-rigsmith-schema: 5`) and the private
  file list know schema 5 and character.v4.json.
