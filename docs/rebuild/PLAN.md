# Rigsmith: what it is, what's redundant, and how it would be built again

The detailed feature catalogue lives in the seven inventories beside this file (every control, workflow, data
field and algorithm, with file:line references):

| # | Area | File |
|---|---|---|
| 1 | App shell, Import, data model, jobs, journal | [inventory-1-shell-import.md](inventory-1-shell-import.md) |
| 2 | Rig: joints, markers, auto-rig, weights, hand poses | [inventory-2-rig.md](inventory-2-rig.md) |
| 3 | Animate: library, slots, playback, scripts, tune | [inventory-3-animate.md](inventory-3-animate.md) |
| 4 | Animation editor: posing, solvers, props leading, saving | [inventory-4-editor.md](inventory-4-editor.md) |
| 5 | Outfit: props, clothes, parts, sockets, pulls, mounts | [inventory-5-outfit.md](inventory-5-outfit.md) |
| 6 | Texture: hole fill, projection painting, Codex | [inventory-6-texture.md](inventory-6-texture.md) |
| 7 | Export, the game contract, tooling, tests, workspace | [inventory-7-export-tooling.md](inventory-7-export-tooling.md) |

This document is the synthesis: what the tool really is, the redundancy that cuts across areas, what is actually
used, and a from-scratch design with a path to get there from today's code.

---

## 1. What Rigsmith actually is

Stated in one line: **an asset compiler that turns a raw AI-generated model into an Emberhold game unit.**

Everything else serves that. The real output is `tools/game_export.ts` writing a unit GLB plus `skeleton.json` and
`rigsmith.json` into the game repo. The browser GLB export, the generic LODs and `rigsmith_lods.gd` are leftovers:
the game reads none of them (inventory 7, §4.2).

The pipeline, as the user experiences it:

1. **Import** a model (Tripo zip / GLB / FBX); it is measured, cleaned, stood on the floor, sized.
2. **Skeleton**: joints placed (detected, then markers / 3D drag / finger tools), the model rigged (Blender heat
   weights, optimized, validated), weights fixed by painting.
3. **Gear**: weapons and tools placed on bones (in practice all of it comes from the game's own Blender pipeline).
4. **Look**: holes in the texture filled, regions repainted by Codex through projection.
5. **Motion**: clips picked from a 2,400-clip library into the game's named slots, adjusted (speed, ground, fists,
   blow timing, keys), edited with a full-body pose editor, saved back.
6. **Ship**: the unit exported to the game with its gear, LODs, strides and a build record.

Rigsmith is two weeks old (92 commits since 2026-10-14, on top of the Mesh2Motion fork). The churn is concentrated
in the animation editor (`clipedit.svelte.ts` 31 commits, `posespace.ts` 17, `clipedit.ts` 16) and the server API (22).

---

## 2. What is actually used (workspace evidence)

Feature breadth is far ahead of use. Counts are from the inventories' scans of `workspace/characters/*`:

| Feature | Use |
|---|---|
| Accessories | 85 garments, **all** `mode: rigid`, **all** `from: emberhold:` (made by the game's Blender build). 0 clothing, 0 parts, 0 mechanisms, 0 switch sets, 0 painted garment weights, 0 hide-body |
| Catalog props (`Character.props`) | 2, on 2 characters; dropped by the game export |
| Pull sockets / editor grip sockets | 2 pulls, 3 grip sockets |
| Tune keys / ground lift | 1 of 168 slot entries has keys, 1 has a lift |
| Grip scripts | 8 characters, with no UI left to see them (filtered out of Scripts) |
| Mounts | 3, all with `skin` / `gear` fields nothing applies |
| `Character.skins` | 0 |
| Legacy single-view texture captures | 2 (Seer) |
| Creature templates (fox, bird, dragon, kaiju, spider, snake, fish) | no deformation tests, no marker sets |
| Generic browser GLB export | last written 2026-10-14/15; game exports are current |

The design below cuts scope to what is used, and keeps the rest only where the game will plausibly need it soon.

---

## 3. The redundancy, across areas

These are the patterns that make the tool feel like "competing, disorganized features". Each one shows up in
several inventories.

### 3.1 No single owner for a piece of character state
- **Joints have about eight writers**: import detection, the marker board, the 3D joint editor, finger-level
  switching, "Detect fingers again", Reset / Refit template, the rig job (it rewrites `joints`), template/convert,
  plus the CLI (inv. 2 §7.1). `joints`, `autoJoints`, `jointsEdited`, `markers.base/positions` and `fingers` drift
  apart; `fitMarkers` carries migration code to patch it up.
- **`garments` is a whole-array field** edited by Outfit, the animation editor (six separate rebuilds of the array),
  the weight routes and `game_import.py`. PATCH replaces whole fields; concurrent writers clobber each other
  (inv. 5 §7.16). Every edit is applied two or three times (optimistic write, PATCH reply, SSE echo; inv. 1 §7.11).
- **Character status** ("needs rig", "rigged", "importing") is derived in six places by different rules (inv. 1 §7.16).

### 3.2 One hand, seven ways to close it
A hand's fist can come from a grip script, a garment's `carryPose`/`carryOpen`, a pull's `pose`/`holds`, a named
hand pose, one of five canned fist clips, per-finger keys, or the "Rest, fists closed" preview. Which one wins is
decided in two separate places (`scripts.ts handScripts` and `clipedit.svelte.ts handPoseOf/setFist`), stored in
four homes, and shown nowhere (inv. 3 §7.1, inv. 4 §7.3, inv. 5 §7.6). `GRIP_CLIP` and `DEFAULT_FIST` are the same
constant under two names.

### 3.3 "Socket" and "prop" mean too many things
- "Socket": the 9 body sockets of catalog props, `GarmentSocket` grips for the other hand, `PullSocket` points a
  hand draws, the synthetic `carrier:` socket, and "(carries it)" sockets made and then filtered out again.
- "Props": catalog props, rigid garments, the left panel on Outfit, the export option, and prop keys.
- Two accessory systems for one job (`Character.props` vs rigid `garments`) with different placement math, panels,
  loaders and gizmos. The game export only knows garments.
- Carry pose, pull pose and pull holds are editable both in Outfit and in Animate → Edit; the hold-window text
  parsing is pasted four times.
- The editor's `pruneSockets` can delete sockets made in Outfit.

### 3.4 Two bake pipelines and two exports
`bakeEntry` (viewer + browser export) and `tools/game_export.ts` each implement speed → scripts → ground → keys →
prop tracks → pulls → riding, and the game export does it twice (unit and companion). Only a manual parity script
guards the drift (inv. 3 §7.3, inv. 7 §7.1). Two LOD systems (0.5/0.25/0.12 with glTF extras vs `[0.45, 0.15]` with
`_LODn` names), `simplifyKeeping` a copy of `simplify`.

### 3.5 Three ways to change a clip
Tune keys (sparse, per slot, on top of the clip), editor keys (solved per frame, saved as a new library clip) and
prop paths (whose `keys` mean a world delta when the prop leads and a socket adjustment when it doesn't). Saving an
edit to a slot drops its Tune keys; filling a slot from a card keeps them. The editor's saved keys are never read
back (inv. 4 §7.2, §7.7).

### 3.6 The same thing in Python and TypeScript
Mixamo hierarchy and finger levels (`mixamo.ts` / `mixamo.py`), finger placement (`fingers.py` / `markers.ts
layHands` with a copied `ANATOMY` table), hand and palm frames (three: `hands.py`, `MarkerBoard.handView`,
`handposes.handRest`), mirror logic (four implementations, four Mirror toggles).

### 3.7 Copy-pasted infrastructure
GLB chunk parsing written at least eight times; the headless GLTFLoader shim re-declared in about ten dev scripts
though `tools/lib/node3d.ts` provides it; three WebGL contexts and three lighting rigs (stage, previews, thumbnails)
with slightly different values; "first skinned mesh", `propNode`, PCA-of-points, `widthOf(hand)` copied around.

### 3.8 Several solvers and pose-quality models
Three whole-body solvers (`NaturalRig` live, `bodysolve` as a fallback, `twohand` dead), IK while dragging vs a full
natural solve on release (the pose jumps), four "is this pose human" models (ROM grids as hard clamp and soft
penalty, PCA pose space, hand-written elbow/wrist/balance costs, `bodysolve` strain), two collision models
(capsules and finger surface triangles) (inv. 4 §7.1).

### 3.9 Size has six meanings
Character `scale` (Import → Size), `stats.height` (measured at import), the live view box, game `UnitSpec.height`
(edited in two panels: Game unit and Scale room), `Mount.scale`, `Garment.scale`. Rider-on-horse size is derived from
the two game heights.

### 3.10 Generations of the same feature left side by side
- Texture: single-view capture (`camera.json`, `result.png`, `bakeProjection`) next to multi-view (`views.json`,
  `result-N.png`, `bakeViews`); seven mask representations.
- Accessories: catalog props next to garments.
- Export: Mesh2Motion export services (`*CleanupService`, `FbxTextureCompatibilityService`), unused `fbx-exporter`
  and `jszip` dependencies, `Settings.exportFormat` / `boneNames` (never read).
- Animation: `twohand.ts`, `twohandpose.ts` + a 635 KB `human-twohand.json` shipped in `static/`, `bodysolve.ts`,
  unused grip placement in `propfit.ts`, a forked `TransformControls` nothing imports.
- Rig: per-joint curl/spread functions with no UI, the old forearm finger frame.

### 3.11 Settings and feedback, split
Export options in `localStorage`, export dir in server settings, game repo in server settings with no UI. Four
"what happened" surfaces (toasts, Jobs popover, per-character History, status line), none linked; the journal does
not record import, rig completion or re-import.

---

## 4. Bugs and risks the audit surfaced (fix regardless of any rebuild)

Highest first. Items marked † were introduced in this session's work.

1. † **Save to slot over a `custom-` clip rewrites that library clip for every character that uses it.**
   Should fork (new id) unless the clip is used only by this slot.
2. † **Save to slot may apply scripts twice**: the edit is made on the scripted (blow-cut, paced) clip, and the slot
   applies its scripts again on play and export. Needs verification; save the unscripted motion or mark the clip.
3. **The editor discards edits silently** (Finish, leaving the step, playing another clip; no undo), while the
   persistent changes it made on the way (sockets, placement, windows) stay.
4. **Re-import resets joints** with no confirm, no busy guard, no error handling; on a rigged import it also undoes
   Resize (`--scale` / `--ground` apply to meshes only).
5. **Painter goes stale after Keep** (the model reloads on the revision bump; brushing silently stops until Done /
   Start). Same after changing character mid-paint. The mask overlay stays hidden after stacking.
6. **Game export**: edits the game's `units.json` before building and never rolls back; no lock between two exports;
   the game's `build.sh` likely hides a `game_export.ts` crash behind a pipe.
7. **Weight pipeline trains on its own benchmark**: `trainedClips` always includes every test clip, contradicting
   `holdout.json`, so validation scores clips the optimizer trained on.
8. **Template switch clears animations and markers** with no warning; a re-rig with paint that can't be mapped
   aborts with no warning first.
9. **Kind change on a garment keeps inapplicable fields** (clothing → prop keeps `bone: 'Head'`).
10. **Slots are identified by name**: a trial with a slot's name takes it over; per-clip windows (`carryOpen`,
    `holds`) keyed by slot name are orphaned by a rename; the card checkmark removes every entry with that clip id.
11. `/files/*` serves the whole workspace and no route has auth (fine on localhost, worth knowing).
12. `viewer.loadError` is never shown: a model that fails to load shows a blank viewport.
13. The "only Scout/Villager may be re-rigged" rule lives in a memory note; nothing in code enforces it
    (`coat_weights.ts --apply` writes live weights).

---

## 5. The vision, if starting over

### 5.1 Principles

1. **The game unit is the product.** There is one bake library; the viewer is a live preview of exactly what the
   export writes. No second pipeline, no generic export.
2. **Generated, then overridden.** Every derived thing (joints, weights, fists, ground, texture) is computed from
   inputs and then adjusted by explicit user overrides stored as layers. Re-running a generator never destroys an
   override; overrides that no longer apply are reported, not dropped silently.
3. **One owner per concept.** Each piece of character data has exactly one module that writes it, through named
   commands (not whole-field PATCH). Commands are the journal and the undo stack.
4. **One concept, one name.** A hand has one pose resolver. Gear has one attachment model. A slot has a stable id.
5. **Geometry kernel in one language.** TypeScript runs in the browser and headless in Node (the same code for
   viewer, CLI and export). Blender is used only where it is uniquely good (import of odd formats, heat weights),
   and exchanges data through files with a schema, never through re-implemented logic.
6. **Scope to use.** Build what units use today (rigid gear, humans + horse, slots, Codex repaints) well. Keep
   clothing, parts, mechanisms and other creatures behind a clear extension point, not half-built in the main path.

### 5.2 Data model (one character document, sections with one owner each)

```
Character
  id, name, created
  source        { file, originalName, scale, groundOffset }             owner: Import
  skeleton      { template, fingerLevel,
                  detected: Joints,                                      (generator output, never edited)
                  overrides: Record<joint, Vec3>,                        (user moves; markers solve INTO this)
                  markers?: MarkerBoardState }                           owner: Skeleton
  skin          { generated: rig file + report,
                  paint: WeightLayer[] }                                 owner: Skin
  hands         { poses: HandPose[] }  (library shared via settings)     owner: Hands
  gear          Gear[]   (stable ids)                                    owner: Gear
  clips         Slot[]   (stable ids; slot name = the game's)            owner: Motion
  look          { layers: TextureLayer[] }  (fill, each repaint)         owner: Look
  unit          { height, budget, lods, companion, mount }               owner: Ship
  journal       Command[]                                                owner: core
```

Key shapes:

- **Gear** (replaces `props` + `garments`):
  `{ id, name, model, attach: { kind: 'bone', bone, place } | { kind: 'skin', policy } | { kind: 'spot', anchor },
     handles: Handle[], visibility: { swapSet?, hidden? }, from }`.
  A **Handle** replaces carry socket, grip socket and pull socket:
  `{ id, kind: 'carry' | 'grip' | 'pull', hand?, place, pose?: HandPoseRef, pull?: { rest, strand } }`.
- **Slot**: `{ id, name (game slot), clip: ClipRef, speed, loop, inPlace, adjustments: Adjustment[] }`.
  An **Adjustment** is one ordered stack replacing Tune keys, scripts and per-clip windows:
  `ground | blowTiming | pace | handPose(hand, pose, window) | handleHold(handle, window) | keys(bones/gear)`.
  Clip edits saved from the editor become a new **ClipRef** (a library clip) with the adjustments either baked in or
  kept, explicitly, never both.
- **HandPoseRef**: `'default' | 'clip' | { pose: id }`. One resolver turns (slot, frame, hand) into a pose with its
  reason ("held by Bow · carry handle · Bow Grip"), and the UI shows that reason.

### 5.3 Architecture

```
packages/
  kernel/        three.js geometry and animation, no DOM: GLB read/write (one module), retarget, bake(slot),
                 hand pose resolver, pulls, gear placement, ground, LODs (one simplify with locks), ROM/limits,
                 pose solver (one: natural solve, with a fast mode for dragging), collisions (one model)
  model/         the Character schema (zod), commands (one per user action), migrations
  server/        workspace store (characters as files), command endpoint + journal + undo, job queue
                 (jobs = commands that take time, with progress and cancel), file serving
  blender/       import/inspect, joint detection + finger tracing, heat weights (outputs: schema'd JSON/GLB)
  optimize/      the PyTorch weight optimizer (train set and holdout set as data)
  app/           Svelte UI on the kernel (same bake as export), one renderer (offscreen previews share it)
  cli/           rig.ts and game export on the same kernel and commands
```

The game export becomes `kernel.bakeUnit(character) → files`, run by the CLI (the game's `build.sh`) and by the
app's Ship step; the viewer's playback is `kernel.bake(slot)` on the same code. The parity script disappears.

### 5.4 UI (steps match the pipeline; one consistent frame)

- **Frame**: left = Characters, always (import, rename, delete, size, status from one selector). Center = viewport
  + timeline. Right = the current step's inspector. Library / gear catalog open as drawers, not by replacing the
  character list. One feedback surface: a job/activity drawer that is also the journal (with undo).
- **1 · Import**: source, size, floor, cleanup report (holes found, welds), re-import with diff preview.
- **2 · Skeleton**: one joint view (markers board and 3D joints are two cameras on the same overrides layer), finger
  level and "detect again" as generator buttons, a template picker. "Rig" is the button that builds the skin.
- **3 · Skin**: deformation tests, weight view and painting (body only), rig report as readable decisions
  (which candidate won and why) instead of a method string.
- **4 · Gear**: gear list (from the game or added), placement gizmo, handles (carry / grip / pull) in one list per
  item, swap sets. A "hands" panel shows, for the clip playing, what each hand does and why.
- **5 · Look**: texture layers (fill, repaints) with per-layer undo; mask, capture views, Codex or an image, preview.
- **6 · Motion**: slots (the game's list), library drawer, per-slot adjustments stack (ground, timing, hands, holds,
  keys) on the timeline as lanes; Edit opens the pose editor on the slot and saves as a new clip or into the slot,
  explicitly forked when shared.
- **7 · Ship**: unit settings (height, budget, LODs, companion, mount, scale room), checks (contract rules shown as
  pass/fail before export), export and the build record.
- **Hand poses** live with Hands (reachable from Gear and Motion where they are used), not under Rig.

---

## 6. Getting there from today (incremental, not a rewrite)

A ground-up rewrite would throw away two weeks of hard-won algorithms (ARAP marker solve, finger tracing, regional
heat + optimizer, natural pose solver, projection bake, in-place GLB transforms). Most of the redundancy is in the
layers around them. The path below rebuilds the frame around the algorithms that work.

### Phase 0: delete and fix (days)
- Delete dead code listed in the inventories: `twohand*.ts` + `human-twohand.json` + `tools/twohand_poses.ts`,
  unused `propfit` grip code, `vendor/TransformControls.ts`, Mesh2Motion export services, `fbx-exporter` and `jszip`,
  `captureView` / `analyzeView` / dead `selection.ts` parts, `Settings.exportFormat` / `boneNames`, `AnimationEntry.trim`,
  `lowestPoints`, unused hand-pose curl/spread functions, `Stage.snapshot`, the unreachable grip branch in Scripts.
- Fix §4 items 1–5, 7, 9 and show `viewer.loadError`.
- Stop rendering unused texture passes (depth, normal); drop the legacy single-view capture path (convert or drop
  the two Seer captures).
- One `GRIP_CLIP`; one `propNode`; one GLB read/write module; `node3d.ts` used by every dev script.

### Phase 1: one owner per concept (1–2 weeks)
- Joints: `skeleton.detected` + `skeleton.overrides`; every writer goes through the Skeleton module; markers solve
  into overrides; the rig job stops rewriting joints.
- Commands instead of whole-field PATCH for gear, slots and skeleton; journal = command log; undo for the editor
  and Outfit.
- Stable ids for slots and gear; per-clip windows keyed by slot id.
- Fold catalog props into gear (the catalog becomes a source of gear); unify the three socket kinds into handles.
- One hand pose resolver (`scripts.ts` becomes it); the editor and Outfit call it; a "why this hand" readout.

### Phase 2: one bake (1–2 weeks)
- Move `bakeEntry` and its helpers into a kernel that runs headless; make `game_export.ts` call it for the unit and
  the companion; one LOD path with locks; remove the browser generic export (or make it the unit export).
- Adjustments stack per slot replacing Tune keys + scripts + per-clip windows; the editor saves explicitly with or
  without them.

### Phase 3: one solver, one frame (2–3 weeks)
- Retire `bodysolve` (natural solver with a fast mode while dragging), one pose-quality model, one collision model.
- Restructure the UI to the seven steps above with the always-present character list, the activity drawer, the
  adjustments timeline lanes and the hands panel.

### Phase 4: tests on the contract
- A contract test that exports a fixture unit and checks the game's rules (mesh/material/bone/LOD names, budget,
  soles at 0, Prop_ bones, strides) in Node; run it in `npm test`.
- Keep the creature templates behind the extension point; add deformation tests only for the ones the game uses.

---

## 7. Open questions for the owner

1. Is the generic browser GLB export needed at all, or is Emberhold the only consumer?
2. Clothing / parts / mechanisms / swap sets are unused: keep behind an extension point, or remove until needed?
3. Which creature templates matter beyond the horse?
4. Should Codex texture repaint stay in Rigsmith, or move to the game's art pipeline?
5. Is the animation editor's save meant to produce reusable library clips (shared across characters) or
   per-character slot clips? The answer decides whether "save to slot" forks by default.
