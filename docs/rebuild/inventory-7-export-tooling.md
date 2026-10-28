# Inventory 7: Export step, game integration, developer tooling, tests, docs, workspace

Audit date 2026-10-28, repo HEAD `36f9295`. Read-only audit; nothing was run (no tests, Blender jobs or exports).
Paths are relative to `/home/ryan/dev/games/rigsmith` unless prefixed `emberhold:` (= `/home/ryan/dev/games/emberhold`, read only).

---

## 1. Purpose of the area

The last step of the pipeline: get a rigged, dressed, animated character out of Rigsmith. There are TWO unrelated export paths:
(a) a generic browser-built GLB written to a user-chosen folder (the original "Export to Godot" feature), and
(b) the game integration for Emberhold, which treats a character as a named *unit* in Rigsmith's own `workspace/game/units.json`, builds its game GLB headlessly in Node (`tools/game_export.ts`), and writes into the game repo only on "Export <unit> to the game".
Around it sits the dev tooling (`tools/`, `tools/dev/`), the tests, the docs, and the on-disk `workspace/` layout.

---

## 2. UI surface of the Export step

The Export step is `app.step === 'export'` (`src/state/app.svelte.ts:4-12`, hint "Ship to Godot"). `src/app/Inspector.svelte:25-27` renders `ExportPanel` for it, followed by `HistoryPanel` (journal) under every step (`Inspector.svelte:29-31`). The viewport shows the `Timeline` on the export step (`src/app/Viewport.svelte:102`) so the clip set can be previewed. The scale room overlays the viewport (`Viewport.svelte:104-108`).

### 2.1 `src/app/steps/ExportPanel.svelte` (165 lines)

Gate: `character.status !== 'rigged'` shows only "Rig X and pick animations before exporting" (`:77-79`). The text mentions animations but the gate only checks `status`; a rigged character with zero animations passes and exports "the rigged character only" (`:94`).

| Control / element | file:line | What it does |
| --- | --- | --- |
| `<GameUnitPanel>` (first section) | `:80` | The game integration lives ABOVE the generic export (see 2.2). |
| Section "Package": summary (file name, bones, animation count, tris) | `:81-88` | File name from `fileName()` (`:31`): character name sanitized to `[\w .-]`, spaces to `_`, `.glb`. Two characters with the same name get the same file name and overwrite each other. |
| Clip list (read-only, mono) | `:89-95` | Each animation's exported name via `clipName()` (`exporter.ts:28`), i.e. with `-loop` suffix when on. |
| Segmented "Bone names": `Hips` / `mixamorig:Hips` | `:99-102` | `options.boneNames`; `mixamorig` renames GLB JSON nodes after export (`exporter.ts:104`, `renameNodes` `:112`). |
| Segmented "Texture size": Original / 2K / 1K / 512 | `:103-107` | `options.textureSize` (null = original); passed to `GLTFExporter` `maxTextureSize` (`exporter.ts:102`). Local `textureChoice` string mirrors `options.textureSize` (duplicate state). |
| Segmented "Image format": PNG / JPEG | `:108-111` | Sets `texture.userData.mimeType` on cloned maps (`exporter.ts:75`). |
| Segmented "Distance LODs": Off / 1 / 2 / 3 | `:112-116` | `options.lods`; local `lodChoice` string duplicates it. DEFAULT is 3 (`exporter.ts:26`), so a first-time export always makes LODs. |
| LOD help text (percent + switch distances scaled by `viewer.character.height`) | `:117-119` | Says to set `rigsmith_lods.gd` as the Godot scene import script (Project Settings, Import Defaults, Scene). Hard-codes `[50,25,12]` and `[12,25,50]` (duplicates `LOD_RATIOS`/`LOD_DISTANCES` in `export/lods.ts:8-11`; the shown 50/25/12 and the code's 0.5/0.25/0.12 agree only by coincidence of two literals). |
| Toggle "Godot looping" | `:120` | `options.loopSuffix`: appends `-loop` to clips with `entry.loop` so Godot imports them looping. |
| Toggle "Include props" (only when `character.props.length > 0`) | `:121-123` | Local `includeProps` (NOT persisted, default true); catalog props exported as bone attachments (`attachProps`, `exporter.ts:39`). |
| Section "Destination": mono path of `app.settings.exportDir` | `:126-129` | Read-only; "Change it in Settings (top right)". No "open folder" button even though `api.openFolder` and `/api/open` exist (`api.ts:65`, `server/api.ts:691-697`; only TexturePanel uses it). |
| Primary button "Export <name>" (busy text "Exporting" / "Exporting i of n: name") | `:132-134` | `run(false)`: builds the GLB in the browser, `POST /api/exports?name=` (`api.ts:77`), shows toast, sets `last`. |
| Ghost button "Download instead" | `:136` | `download()` (`:60-74`): same build, saved via a blob `<a download>`; does not touch the server and does not write `rigsmith_lods.gd`. |
| Ghost button "Export all N" (only when more than 1 character is `rigged` with animations) | `:137-139` | `run(true)` over `ready` (`:30`): sequential, loads each character's view; first failure aborts the batch. |
| Result card (name, MB, saved path) | `:141-146` | Last export only. |

Persistence: `options` live in `localStorage['rigsmith.export']` (`:18-22`), i.e. per-browser, NOT in `workspace/settings.json`. The server-side `Settings.boneNames` and `Settings.exportFormat` (`server/workspace.ts:226-227`) are never read (see section 7).

Build path used by both buttons (`:33-37`): `loadExportView` (`exporter.ts:34`: loads `rigged.glb`, applies `boneMap` renamer, attaches catalog props and garments) then `exportCharacter` (`exporter.ts:44`: clone with real materials, reset to bind pose, strip non-source vertex colours, clone materials/textures, `addLods`, bake every `AnimationEntry` with `bakeEntry`, `GLTFExporter`).

### 2.2 `src/app/steps/GameUnitPanel.svelte` (124 lines), Section "In the game"

Reads `GET /api/game` on mount and on every `app.gameBeat` bump (SSE `game` event, `app.svelte.ts:73`) (`:18`).

| Control | file:line | What it does |
| --- | --- | --- |
| "Reading the units..." placeholder | `:48-49` | Until the status loads. |
| Not-a-unit state: text input "unit name, e.g. knight" + button "Make it a unit" (Enter also submits) | `:51-55`, `create()` `:35-40` | Name is lower-cased and non-`[a-z0-9_]` become `_`. Creates a **draft** unit `{character, height 2.0, budget 8000, tex 1024, draft true, clips [Idle, Walk, Run, Attack, Die]}` via `PUT /api/game/units/<name>`. Refuses empty or duplicate name. |
| Per-unit card: gamepad icon, unit name, "its pony/horse" suffix when this character is a companion, state label ("not in the game yet" / "changed here" / "as in the game") | `:57-66` | `u.differs` = `JSON.stringify(ours) !== JSON.stringify(game)` (`server/game.ts:100`), key-order sensitive. |
| Number input "Height" (m, step 0.05) | `:69` | Saved immediately on change (`patch` -> `PUT`). Tooltip: soles to top of head. |
| Number input "Budget" (triangles, step 100) | `:70` | Triangle budget for LOD0 (the export simplifies past it). |
| "Plays" chips of clip names, each with an X, plus "+ clip" text input (Enter adds) | `:72-78` | Edits `clips`, the game's clip-name list. Free text: nothing checks a name is in the character's animation set until export fails. |
| Toggle "Draft" | `:79` | `draft` true/undefined. A draft is skipped by a no-name build. |
| Companion row (only if the unit has `companion`): select "Rides / leads" (non-human template characters) and number "Its height" | `:80-89` | Edits `companion.character` / `companion.height`. Companion `prefix`, `at`, `yaw`, `budget`, `material`, `feet`, `ridden` have no UI (JSON only, or `tools/rig.ts unit`). |
| Button "Scale it with the game" | `:91` | `scaleRoom.show(name, ours, !asUnit)` opens the scale room. |
| Button "Export <name> to the game" (shows job message while running) | `:92-94`, `exportUnit` `:41-43` | `POST /api/game/export {units:[name]}`; spinner is driven by ANY running `export` job (`:22`), not this unit's. |
| Help paragraph | `:97` | "Changes here stay in Rigsmith. Export writes ... units.json, model and maps, holds check. Then open Godot to re-import." |
| Last job result line (green/red) | `:98-100` | Latest finished `export` job of any unit (`:23`). |

Missing from the UI: the game repo path (`Settings.gameRepo`, default `~/dev/games/emberhold`, `server/workspace.ts:239`) has no input anywhere; units with `head`, `lods`, `tex`, `clan`, `thrown`, `models_dir`, `props`, `villager_parts` keys are preserved but not editable; no way to delete a unit from the UI (the API accepts `null`, `api.ts:45`); no walk/run stride result shown (only in the job message); no holds-failed list.

### 2.3 `src/app/export/ScaleRoom.svelte` (238 lines) + `src/state/scaleroom.svelte.ts`

Full-viewport overlay (z-index 6) with its own WebGL renderer, scene, OrbitControls. Loads the game's models read-only through `/api/game/models` and `/api/game/models/<kind>/<name>.glb` (`server/api.ts:374-390`), in clay colours; hides `_LOD\d` meshes and `Gear*/Wear*/Head*` (except `HeadBald`) (`:46`).

| Control | file:line | What it does |
| --- | --- | --- |
| Canvas, orbit camera, ground plane + grid | `:138-157,192-193` | Renders on change, not per frame (`:123`). |
| Name+height labels over each model | `:128-136,194-196` | Projected from each model's visible box. |
| Panel title `<unit> (its mount)` | `:198` | |
| Range slider 0.5-4 m + number input 0.3-10 m "Height" | `:199` | Rescales a clone of the viewport character: `height / view.height * visualScale` (`:91-97`). |
| Button "Save height" (disabled when unchanged) | `:201`, `save()` `:185-189` | `PUT /api/game/units/<unit>` with rounded height (companion: `companion.height`). Toast: "the game gets it on Export". |
| Button "Back to X m" | `:202` | Resets to the saved height. |
| Help text "Units as the game draws them (xN)" | `:204` | `N` = `data/visual.json -> units.visual_scale` (`server/api.ts:381`). |
| Unit chips (toggle): default shown = warrior, spearman, archer, villager, raider, caravan, bearguard | `:166,206-208` | Loads other units' GLBs on demand; excludes `siege_*` from the list (`:37`). |
| Select "+ a building or prop..." (grouped Buildings / Props) | `:209-213` | Adds scenery (placed behind, `layout()` `:73-89`). |
| Close X | `:216` | `scaleRoom.open = false`. |

State holder `src/state/scaleroom.svelte.ts` (17 lines): `open, unit, entry, companion, busy, show()`.

### 2.4 Settings popover (the only place export settings are edited)

`src/app/SettingsPopover.svelte` (29 lines): one field, "Export folder" (`:17-19`), saved on Enter/blur via `PATCH /api/settings` (`app.saveSettings`). `~` expansion server-side (`workspace.ts:334-338`). Nothing else (not `gameRepo`, not `boneNames`, not `exportFormat`).

### 2.5 Other places the game integration shows up outside this step

* Animate step "In the game" slots (`src/app/steps/AnimatePanel.svelte:17`, `src/state/slots.svelte.ts`): reads `GET /api/characters/:id/game` (`server/api.ts:348`, `gameSlots`, `server/game.ts:147`) to list the unit's clip names; filling a slot writes the character's `animations`, not the unit.
* Viewer/outfit height scaling reads the same endpoint (`src/state/viewer.svelte.ts:227`, `src/state/outfit.svelte.ts:160`) for the game height of a character.
* Job UI: `JobsPopover.svelte` lists `export` jobs; the viewport busy ring shows `job.message` (`Viewport.svelte:117`).
* CLI mirror: `tools/rig.ts units | unit NAME JSON|null | export UNIT... | check | render` (section 5).

---

## 3. User workflows

### 3.1 Generic GLB export (browser path)
1. Rig the character, optionally pick animations; open Export. 2. Pick bone names / texture size / format / LODs / looping / props. 3. "Export <name>": the browser builds the GLB (can take seconds-minutes: retarget + bake + simplify + GLTFExporter), POSTs the blob to `/api/exports` which writes `<exportDir>/<Name>.glb` and refreshes `<exportDir>/rigsmith_lods.gd` (`server/api.ts:861-871`). 4. In Godot, once per project, set `rigsmith_lods.gd` as the Scene import script. Alternative: "Download instead" (no server write, no `.gd`). "Export all N" repeats for every rigged character with animations.
Evidence this path is rarely used now: `workspace/exports/` holds 3 GLBs + 1 PNG all dated 2026-10-14/15 (Archer, Huntress, Warrior), vs game exports dated 10-28.

### 3.2 Game export (unit path, the live workflow)
1. Make the character a unit (Export step "Make it a unit", or the Animate step's slots if the game's `units.json` was seeded). `units()` seeds `workspace/game/units.json` from the game's `tools/rigsmith/units.json` the first time (`server/game.ts:34-41`).
2. Fill the unit's clip names with library clips in Animate; place gear in Outfit (only parts imported from the game, see section 4).
3. Edit height/budget/clips/draft/companion in the "In the game" card; every edit is saved at once to `workspace/game/units.json` (formatted json.dumps-style to match the game's file, `game.ts:43-63`), journaled on the character(s) (`server/api.ts:394-409`), and broadcast over SSE (`events.emit('game')`).
4. Optional "Scale it with the game" to set height by eye against the game's own models.
5. "Export <unit> to the game": `POST /api/game/export` enqueues an `export` job (`api.ts:412-428`) -> `exportUnits()` (`game.ts:109`): splices ONLY that unit's block into `<gameRepo>/tools/rigsmith/units.json` (`spliceUnit` `:71`, draft flag dropped), validates the JSON parses, writes it, saves Rigsmith's copy, then runs `sh <gameRepo>/tools/rigsmith/build.sh <unit...>` with `RIGSMITH=<this repo>` and streams stdout/stderr lines as job progress.
   `build.sh` (`emberhold:tools/rigsmith/build.sh`) = (1) `node tools/game_export.ts <game units.json> <game>/assets/models/units <game>/.work/rigsmith <unit>` in this repo, (2) Blender `tools/blender/emb_rigsmith.py` builds the maps (albedo with clan colour neutralised, mask, orm, normal) + provenance `assets/textures/models/<unit>/<unit>.json`, (3) Blender `check_holds.py` reports HOLDS failures (report only). It then prints "copy walkStride/runStride into UnitView.Stride/RunStride; re-import in Godot".
6. After the job: journal line "exported to the game as <unit> (walk X, run Y; N holds failed)" on the character; the user manually (a) copies stride numbers into the game's `UnitView.cs`, (b) runs `godot --headless --path . --import`, (c) looks at it.

### 3.3 Re-export after changes
* Nothing tracks staleness inside the UI: the card says "changed here" only when the *unit spec* differs from the game's, not when the *character* (clips, gear, weights, rig) changed after the last export.
* `node tools/rig.ts check [UNIT...]` is the staleness check: it re-exports to `workspace/renders/_check/`, SHA-256-compares each `<unit>.glb` to `<gameRepo>/assets/models/units/<unit>.glb` and prints current/differs (`tools/rig.ts:337-350`). It relies on byte-deterministic output.
* The reverse direction: `python3 tools/game_import.py <game repo> [unit...] [--replace] [--repivot] [--dry-run]` restores a character's clips, scripts and gear from the unit's last build record (`assets/textures/models/<unit>/<unit>.json` -> `sources.rigsmith`); backs up `character.json` to `workspace/backups/game-import/<time>/`; writes through the running app's API.
* Drafts: a unit with `draft:true` is skipped by a no-argument build and built when named (`game_export.ts:897-900`); the first export through the UI clears the flag (`game.ts:118`).

### 3.4 Settings that affect export
| Setting | Where stored | Edited where | Used by |
| --- | --- | --- | --- |
| `exportDir` | `workspace/settings.json` | Settings popover | `/api/exports`, ExportPanel destination, `/api/open` allow-list |
| `gameRepo` | `workspace/settings.json` | **nowhere in UI** (edit JSON, or `PATCH /api/settings`) | `game.ts`, `/api/game/models`, `rig.ts check` |
| `boneNames`, `exportFormat` | `workspace/settings.json` | nowhere | **nothing reads them** (vestigial) |
| `handPoses` | `workspace/settings.json` | Rig step | not export (shared hand poses stored in settings) |
| export options (boneNames, textureSize, imageFormat, loopSuffix, lods, fps) | browser `localStorage['rigsmith.export']` | Export panel | `exporter.ts` only |
| `includeProps` | component state | Export panel | not persisted |
| env `RIGSMITH_WORKSPACE`, `RIGSMITH_URL`, `RIGSMITH_BY`, `RIGSMITH_PORT`, `RIGSMITH_JOBS`, `BLENDER`, `CODEX`, `RIGSMITH_TORCH_PYTHON` | process env | shell | server / tools |
* The browser export's bone naming (`Hips` vs `mixamorig:Hips`) is NOT applicable to the game path: the game export always keeps the rig's bare Mixamo-style names and adds a `root` bone.

---

## 4. The game contract

Sources: `tools/game_export.ts` header (`:1-27`), `emberhold:tools/rigsmith/README.md`, `emberhold:tools/rigsmith/build.sh`, `emberhold:tools/rigsmith/units.json`, `emberhold:game/view/ModelLib.cs:6,173` (LOD naming), `emberhold:tools/blender/check_holds.py:130`.

### 4.1 Where units are described
* Rigsmith's own list: `workspace/game/units.json` (8.7 KB). Game's list: `emberhold:tools/rigsmith/units.json` (the game's copy; `defaults` block, e.g. `lods [0.45,0.15]`, `clan`).
* Per unit keys Rigsmith knows (`server/game.ts:11-19`): `character` (Rigsmith id), `height`, `budget`, `clips[]`, `draft`, `companion{character,height,prefix,budget,material,ridden,at,yaw,feet}`. Keys the game adds and Rigsmith preserves via `[k:string]:unknown`: `tex`, `clan`, `glow`, `head{name,above}`, `clan_trim`, `thrown`, `props`, `parts_tex`, `villager_parts`, `models_dir`, `lods`, `_note/_doc` comment keys.
* The game's file is only ever edited by splicing one `"name": {...}` block (`spliceUnit`), preserving all other bytes. `unitBlock` formats like Python json.dumps(indent=1) with values on one line (`game.ts:43-48`). Test: `server/game.test.ts` (3 tests, one reads the real game file if present).

### 4.2 Mesh / surface / naming rules (what the game expects) and where each is enforced
| Rule | Enforced at |
| --- | --- |
| Exactly one skinned mesh in the character's `rigged.glb` (and in a companion's) | `game_export.ts:234`, `:148` (throws) |
| A bone named `Hips` exists; its parent is untransformed | `:236-240` |
| Unit at game height: soles at y = 0 (`floor` removed), scale `height / bbox height`, facing +Z, glTF Y-up metres | `:241-246`, `skeleton.json` header `:672` |
| Scene = Group `Armature`, new bone `root` above Hips, skeleton = rig bones + `root` (+ `Prop_*`, pull bones, companion bones) | `:289-291`, `:41`, `new THREE.Skeleton(bones)` |
| Body mesh named exactly the unit name; LODs `<mesh>_LOD1`, `_LOD2` (the game's `ModelLib` finds them by that name) | `addLevels` `:235-252`; meshes with <= 60 tris get no LODs `:542` |
| LOD ratios: unit's `lods` or `[0.45, 0.15]` of LOD0 | `:542` (compare browser path: 0.5/0.25/0.12 in `lods.ts:8`) |
| LOD0 within `budget` triangles: body gets `budget - sum(parts that count)`, simplified to 0.99 of that | `:228-231` (budget excludes parts matching `SWAPPED`) |
| Only attributes position/normal/uv/skinIndex/skinWeight survive; tangents computed on every indexed mesh with UVs | `:297-298` (delete others), `:544,573,631` |
| ONE body material named `Main`; the game binds its maps itself by material name (`Main`, `Atlas_<set>`, `Trim_<sheet>`, companion `Atlas_<material>`) | `:352`, `gearModel` `:82`, companion `:297,320` |
| Swapped pieces: parts named `Gear*`, `Head*`, `Wear*` are exported even when hidden and are outside the body budget (game picks one by job/look: `UnitView.JobTools/JobLoads/LookWear`) | `SWAPPED` `:106`, used `:391`, `:118,196` |
| Optional `head` spec splits the body's own head off as its own mesh (e.g. `HeadBald`) above `Neck + above*height` by face centre | `:253-267` |
| Gear must come from the game's own Blender build: garment `from` must start with `emberhold:`; anything else (incl. every Rigsmith catalog prop) is dropped with a console warning. Hidden garments dropped except `SWAPPED`. Not-ready garments dropped. | `:386-396`, `:207` |
| Rigid prop rides the bone named in `g.bone`; throws if bone absent | `:128-129` |
| A prop keyed in any clip gets its own bone `Prop_<name>` (non-word chars -> `_`) under the bone it rides, moved by every clip (at rest where unkeyed) | `:347-349,431-446`, tracks `:703` |
| Pulls (bowstring): bone `Prop_<prop>_<pull>` per pull via `pullBoneName`; second same-name bone throws; every LOD keeps pulled vertices fixed (`simplifyKeeping`) | `:160-195,235-243`, tracks `:733-762` |
| Clothing/parts = skinned meshes weighted as the viewer weights them (`tools/lib/gearskin.ts`); `hideBody` NOT applied; a part's own animation NOT exported (rides lead bone still) | `:98-126` |
| Colour texture: the rig's embedded base-colour image extracted to `<work>/<unit>/base.png|jpg` (companion `base_<material>.*`); the game builds its own maps from it | `embeddedImage` `:78`, `:865-866`, `:628-629` |
| `skeleton.json` (every joint in game space + `grip.L/R`) and `rigsmith.json` (build record: clips, scripts, gear, mesh hashes, strides, LODs, sha256 of rigged.glb and texture, git commit) | `:662-672`, `:868-885` |
| Clip names are the game's (`clips[]`), each must exist in the character's `animations` by NAME; speed -> scripts -> ground (lift) -> bone keys -> prop tracks | missing-name throw `:251-252`; order `:658-720` |
| Walk/Carry/Run must really step (foot swing >= 0.12 x height); Idle/Trade/Hunt must stand (hips median >= 0.8 x rest) | `STEPS/STANDS` `:97,103`, `checkClip` `:110-120`, `:779-781` (throw). Skipped when ridden. |
| Library audit: a clip whose motion contradicts its library name gets a console warning + `audit` in the build record | `AUDIT` `:98-102`, `:266-271` |
| An `Attack` without an enabled "blow" script warns: the game lands each hit at 45 % of the clip | `:274-277` |
| Scripts: enabled clip scripts (hold fist `hold`, `blow`, `pace`) applied as the viewer applies them | `applyScripts` `:662-669` (from `src/engine/scripts.ts`) |
| `walkStride` / `runStride` (planted-foot speed) computed per unit and printed; the human must copy them into `UnitView.Stride/RunStride` by hand | `:769-771,876-877`, `emberhold build.sh` echo |
| Companion (pony/horse): own skeleton under the unit's `root`, bones prefixed by `companion.prefix`, own mesh named by `companion.material` surface `Atlas_<material>`, own clips (unit's names; missing name plays its Idle) retimed to the unit's pace / loop by whole cycles (m:n up to 6) / attack fit; `ridden:true` seats the rider on the horse's seat bone from `character.mount`, rider's held bones frozen, horse leads | `loadCompanion` `:139`, `:301-316,640-660`, `:796-857` |
| Draft units are skipped unless named | `:897-900` |
| `models_dir` redirects a unit's GLB to another path in the game repo (e.g. siege engineer crew, `assets/src3d/...`) | `:901-903` |
| Maps / provenance / holds are NOT made here: Blender scripts in the game repo (`emb_rigsmith.py`, `check_holds.py`) | `emberhold:tools/rigsmith/build.sh` |
| `rigsmith_lods.gd` + glTF `extras {lod, lodBegin, lodEnd}` | **Browser export only** (`export/lods.ts:75-94`). The game does NOT use it: its `ModelLib.cs` reads LOD meshes by `_LOD<n>` name and no file in `emberhold` references `rigsmith_lods`. |

### 4.3 What each side checks after export
* Rigsmith: nothing structural on the produced GLB (no re-import/validate step in the app); the `tests/godot/check_export.gd` headless check targets the *browser* GLB (skeleton + AnimationPlayer present, all tracks resolve, bones move at mid-clip; prints `GODOT_RESULT`), not the unit file and not the game contract; it is not part of `npm test` (`npm run test:godot -- file.glb` needs Godot on PATH).
* Game: `check_holds.py` (weapons/shields against the body for every clip), `verify_models.gd`, and the manual stride copy.

---

## 5. Tooling inventory

Status key: **LIVE** = referenced by docs/other code and consistent with current architecture; **MANUAL** = documented diagnostic run by hand; **ONE-OFF** = written for a particular investigation; **STALE?** = looks unused or contradicted by code.

### 5.1 Game integration / export
| File | Purpose, inputs | Status |
| --- | --- | --- |
| `tools/game_export.ts` (903 lines) | Headless game-unit builder: `node tools/game_export.ts <spec.json> <models dir> <work dir> [unit...]`. Re-implements, in Node, the viewer's clip bake, scripts, keys, gear skinning, pulls, mount/companion and LOD logic (section 7.1). Invoked by `emberhold/tools/rigsmith/build.sh`, `tools/rig.ts check|render`, `npm run export:game`. | LIVE |
| `tools/game_import.py` (640) | Inverse of the above: fills a character from a unit's last game build (clips, scripts, garments, repivot). Needs numpy+PIL; talks to the app API (`RIGSMITH_URL`). | LIVE |
| `tools/rig.ts` (357) | Agent/CLI front for the same HTTP API: `list show history note get set slot clips ride render units unit export check`. Also reads `workspace/` JSON directly (`spec()`, `characters()`) in parallel to the server. Writes journal as `x-rigsmith-by` (default "agent"). | LIVE |
| `tools/render.py` (163) | Blender contact sheets of a game GLB (`blender -b -P tools/render.py -- unit.glb out`); used by `rig.ts render`. | LIVE |
| `server/game.ts` (162), `server/api.ts:347-430` | Units store, splice, export job, `gameSlots`, status. | LIVE |
| `godot/rigsmith_lods.gd` (42) | Godot EditorScenePostImport mapping `_LOD<n>`/extras to visibility ranges. Copied to the export dir on every browser export. | LIVE for browser path only |
| `tests/godot/check_export.gd` (79) | Headless Godot import check of a browser GLB; `npm run test:godot`. | MANUAL |

### 5.2 `tools/dev/` (13 files; every one)
| File | What it is for | Used by / evidence | Status |
| --- | --- | --- | --- |
| `backup_workspace.sh` (38) | rsync the irreplaceable parts of `workspace/` (characters, `library/sources`, `game`, `exports`, `rigdev/gt*`, `rigdev/joints.json`, two named audit dirs, all audits' top-level `*.md`/`*.json`) to `/run/media/ryan/Large Storage/Backups/rigsmith-workspace` (default), writing `BACKED_UP_AT`, `SOURCE_COMMIT`. | Not mentioned in README/HANDOFF. Omits `backups/`, `trash/`, `library/clips`(rebuildable) and `settings.json` (!). Hard-coded audit dir names. | LIVE but undocumented, partial |
| `bench.ts` (417) | Rig-vs-rig deformation benchmark (stretch, rigid, volume, bleed, centre) with the same retargeter. | README "Rig quality vs Mixamo"; needs `blender/autorig/dev/bench/rig_all.sh` outputs in `workspace/rigdev/bench/` | MANUAL (not in tools tsconfig) |
| `bleed_where.ts` (48) | Where rig B puts weight A gives to another bone. | companion of bench; no doc mention | ONE-OFF |
| `weights_at.ts` (43) | Which of B's bones drive vertices A gives to one bone. | companion of bench | ONE-OFF |
| `hand_eval.ts` (120) | Per-region vertex error of two rigs of one mesh under the same clip. | no doc mention; older than `verify_hands` | STALE? |
| `palm_eval.ts` (50) | Palm/finger orientation error after retarget. | no doc mention | STALE? |
| `coat_weights.ts` (299) | Fix coat/cloak weights for characters whose cloth is in the body mesh; `--apply` PUTs painted weights through the live API (`:295-298`). Env switches `GAPS WHERE DUMP DUMP_* PAIRS`. | Not in README; was used for Scout/Villager (`workspace/backups/scout-coat-report.json`, `villager-before-coat-fix-*`). **Writes live weights**: conflicts with the project rule that only Scout/Villager may be re-rigged. | ONE-OFF, risky |
| `ground.ts` (46) | How far each clip's feet sit off the ground in a built unit GLB. | README "Game units" | LIVE diagnostic |
| `tune_parity.ts` (105) | Viewer vs exported unit: compares every bone and prop point for named clips. The ONLY automated check that the Node export equals the browser bake. | README + emberhold README | LIVE, manual, needs a built unit |
| `verify_rigs.ts` (92) | Validates isolated auto-rig outputs (`tools/verify_autorig.py`) vs placements and deformation tests. | README Checks | LIVE |
| `verify_naturalize.ts` (100) | Real-library naturalization acceptance (body sizes, contacts, hands); `--dense`. | README + HANDOFF | LIVE |
| `verify_hands.ts` (57) | Dense read-only finger contact verification; one char+clip per run. | HANDOFF (resume list) | LIVE (paused work) |
| `verify_surfaces.ts` (61) | Actual surface crossings in source vs naturalized motion. | README + HANDOFF | LIVE |
| `_end.ts` (16) | Prints a bone's position at the end of a unit's `Die` clip (underscore = scratch). | no references | STALE (scratch) |

### 5.3 Other `tools/`
| File | Purpose | Status |
| --- | --- | --- |
| `library_verify.ts` (101) | Load + retarget every named clip on Y Bot and a local character; writes `named-library-export.glb`/`-runtime.json` under a workspace dir (README, `npm`-less). | LIVE |
| `library_audit.py` (98) | Flags library clips whose motion contradicts the name -> `workspace/library/audit.json`; run by `npm run library`; read by `server/library.ts:175` and `game_export.ts:98`. | LIVE |
| `posespace.ts` (251) | Builds `static/templates/rom/human-pose.json` PCA from 131k library frames; `--cache` writes `workspace/cache/posespace-frames.f32`. | LIVE build tool |
| `rom.ts` (137) | Builds `static/templates/rom/<rig>.json` joint ranges of motion. | LIVE build tool |
| `twohand_poses.ts` (225) | Builds the two-handed-grip pose table used by `src/engine/twohandpose.ts`. | LIVE build tool |
| `creature_fit.py` (293) | Fit a quadruped template to a mesh along its skeleton (venv, sparse-cubes); called by `server/api.ts` fit-template. | LIVE |
| `extract_templates.py` (96) | `static/rigs/rig-*.glb` -> `static/templates/<rig>.json` (Mesh2Motion origin). | STALE? one-time import tool |
| `verify_autorig.py` (64) | Re-rig the character library into an isolated dir. | LIVE (README) |
| `lib/node3d.ts` (75) | Headless three loaders + workspace + `body()`, `entrySource()`; shared by most tools. | LIVE |
| `lib/gearskin.ts` (81) / `.test.ts` (110) | Clothing/part/pull skinning for game export, reusing `src/engine/garments.ts`. | LIVE, tested |
| `lib/skintransfer.ts` (188) / `.test.ts` (88) | Bind-space skin and paint transfer across rebuilds. | LIVE, tested |
| `lib/surface.ts` (72), `lib/deformation.ts` (22) | Posed-surface reader; rig stress-test clip lists. | LIVE |
| `skin_opt/{optimize.py, apply.ts, validate.ts, painting.ts, pose_set.ts, selection.ts, holdout.json, test_quality.py, selection.test.ts}` | Pose-optimized weights (PyTorch), validation and selection. Covered by the rigging-area inventory; HANDOFF warns `validate.ts` can modify candidates. | LIVE |
| `volume/build.py`, `retopo/{retopo.py,cleanup.py}` | Watertight proxy and retopology (`npm run volume`, `npm run retopo`). Neither is referenced from any step in the app. | MANUAL, optional |
| `requirements.txt`, `requirements-torch.txt`, `tsconfig.json` | Python deps; tools type-check config (`npx tsc -p tools`, NOT an npm script). `tools/tsconfig.json` `include` lists only 7 of the 13 dev files, so `bench, bleed_where, coat_weights, hand_eval, palm_eval, weights_at, _end` are never type-checked. | |
| `tools/__pycache__/` | untracked cache dir (gitignored). | |

### 5.4 Tests (all files; no test run was performed)
Vitest, jsdom environment for everything (`vitest.config.ts`), default include pattern. 34 TS test files + 3 Python files.

| File | Covers |
| --- | --- |
| `server/game.test.ts` (3) | `spliceUnit`: replace one block byte-exact, add/remove, round-trip against the real game file if present (environment-dependent: skips silently when the game repo is absent) |
| `server/clipedits.test.ts` (1) | edited-clip validation |
| `server/glbimages.test.ts` (2) | texture put into GLB in place |
| `server/glbtransform.test.ts` (2) | rig resized/moved in place |
| `server/library.test.ts` (4) | `queryLibrary` (sets `RIGSMITH_WORKSPACE` to a temp dir) |
| `server/weights.test.ts` (3) | rig + paint publication/rollback |
| `src/engine/animation.test.ts` (3) | shared `bakeEntry`, prop tracks swap, `exportCharacter`/`loadExportView` smoke (omits hidden garments) |
| `src/engine/export/lods.test.ts` (1) | `simplify`/`addLods` |
| `src/engine/export/ExportAnimationCleanupService.test.ts` (4), `ExportHierarchyService.test.ts` (5), `GlbSkinCleanupService.test.ts` (4) | **Services nothing imports** (section 7.4) |
| `src/engine/garments.test.ts` (3), `pulls.test.ts` (5), `propfit.test.ts` (2), `scripts.test.ts` (1), `keys.test.ts` (8), `ik.test.ts` (4), `limits.test.ts` (5), `retarget.test.ts` (3), `clipedit.test.ts` (5), `markers.test.ts` (11), `weightpaint.test.ts` (11), `handposes.test.ts` (5), `twohandpose.test.ts` (6) | the corresponding engine modules |
| `src/engine/posespace.test.ts` (35), `bodycollide.test.ts` (8), `surfacecontact.test.ts` (12), `handcontacts.test.ts` (16; imports `tools/lib/node3d.ts` from `src/`, a layering inversion) | naturalization stack |
| `src/engine/presets/automap/{BoneAutoMapping(19), BoneCategoryMapper(6), BoneNameTokenizer(9)}.test.ts` | skeleton auto-mapping (Mesh2Motion heritage) |
| `tools/lib/gearskin.test.ts` (6), `tools/lib/skintransfer.test.ts` (9), `tools/skin_opt/selection.test.ts` (4) | game-export skinning, skin transfer, candidate selection |
| `blender/autorig/test_heat.py` (6), `blender/library/test_catalog.py` (4), `tools/skin_opt/test_quality.py` (5) | `python3 -m unittest` (not in `npm test`; commands only in README/HANDOFF) |
| `tests/godot/check_export.gd` | see 4.3 |

**Test gaps** (nothing covers): `tools/game_export.ts` (903 lines, the most consequential file, only `gearskin` pieces tested); `tools/game_import.py`; `tools/rig.ts`; `server/api.ts` (915 lines, no route tests), `workspace.ts`, `jobs.ts`, `journal.ts`, `skinopt.ts`; `exporter.ts` `renameNodes` / mixamorig rename / texture-size / PNG-JPEG; `mount.ts`, `placement.ts`, `props.ts`, `ground.ts`, `clips.ts`, `CharacterView.ts`; every Svelte component and every `src/state/*.svelte.ts` (zero UI tests); the game contract itself (no test asserts mesh names `<unit>`/`_LOD1`, `Main` material, `root` bone, `Prop_*` bones); browser-vs-Node parity (only manual `tune_parity.ts`); Godot import of a *game* unit.

### 5.5 Docs
| File | Content | Status |
| --- | --- | --- |
| `README.md` (333 lines) | Intro + flow table + layout + checks + ~70 lines of rigging/naturalization implementation notes under "Checks" + "Game units" (the real game-integration doc) + journal/CLI + named library + bench + volume + retopo + pose-optimized weights. One file mixing user guide, design notes, ops runbook and changelog prose. Its "Export" row (line ~25) describes only the generic GLB export; the unit path is a 120-line sub-section far below. Layout list omits `tools/`, `godot/` is not listed, `docs/` not listed. | Partly stale: Export row; "201 tests" style counts are in HANDOFF |
| `HANDOFF.md` (143) | 2026-10-27 pause note for the hand/surface naturalization work. States HEAD `b371ef9` and "all implementation changes are uncommitted... untracked modules"; HEAD is now `36f9295` and the work is committed (two commits since). "No applicable AGENTS.md was found": Rigsmith has none. Contains reproduction commands, a resume list, and references into `workspace/audits/2026-10-27-hand-search/`. | **Stale** on repo state; evidence references still valid |
| `docs/animating.md` (120) | How to put a prop on a character and key a clip with both hands. Says catalog props under "Attached" are "for the export only", which is true of the browser export but the game export drops them (`game_export.ts:207`). | Current except that nuance |
| `workspace/library/README.md` (generated by `blender/library/build.py`) | Library layout, rest-skeleton decisions, categories; "Do not edit by hand". Regenerated each build, so its stats ("Last conversion: 10 converted...", "0 pack clips") describe the last run and leak legacy "pack" terminology. | Generated; lives in a gitignored dir so it is not versioned |
| `LICENSE-CC0.MD`, `LICENSE-MIT.MD` | Mesh2Motion heritage licences | |
| `emberhold:tools/rigsmith/README.md` | The game-side half of the contract (loop, `units.json` keys, where gear comes from). Duplicates part of README "Game units" with different wording. | Current; second source of truth |
| No `AGENTS.md`/`CLAUDE.md` in this repo; `.claude/` is empty; `.vscode/settings.json` auto-approves a vitest path `src/lib/processes/animations-listing/props/Props.test.ts` that does not exist (Mesh2Motion leftover). | | Stale |

### 5.6 Config and scripts
`package.json` scripts: `dev` (vite on 127.0.0.1:5180, server plugin mounted), `start` (build + preview on 5181), `build`, `check` (svelte-check), `test` (vitest run), `test:watch`, `test:godot`, `library`, `library:sync`, `library:verify`, `library:audit`, `lint` (`eslint .`), `volume`, `setup:python`, `retopo`, `export:game`. Missing as scripts but required by docs: tools type-check (`npx tsc -p tools`), Python unittests, `verify_*`, `rig.ts`, `game_import.py`, backup. `package.json` also has dependency `@comfyorg/fbx-exporter-three` and `jszip` that no source file imports.

* `vite.config.ts`: root `src/`, publicDir `../static/`, `rigsmithServer()` plugin mounting `server/api.ts` as middleware; both dev and preview use it; no separate server process or port.
* `vitest.config.ts`: jsdom, globals, coverage v8; alias `@` -> `src` (apparently unused: sources use relative imports).
* `svelte.config.js`: `vitePreprocess` only. `tsconfig.json`: strict, bundler resolution, includes `src`, `server`, `vite.config.ts` (excludes `tools/`, `vendor/ViewHelper.ts`); `tools/tsconfig.json` extends it for node.
* `eslint.config.js`: flat config, `typescript-eslint` recommended; ignores `**/*.svelte`, `blender/**`, `workspace/**`; HANDOFF states repo-wide lint is NOT clean. `svelte-check` is the only check on `.svelte` files.
* `.nvmrc` 24.11.0 (README "Node 24+"; Node's native TS stripping runs `node tools/*.ts` directly).

---

## 6. Workspace layout (`workspace/`, gitignored; sizes at audit time)

| Path | Size | Contents / why |
| --- | --- | --- |
| `settings.json` | 852 B | `exportDir, exportFormat, boneNames, gameRepo, handPoses[]`. Only file at top level. Not covered by `backup_workspace.sh`. |
| `characters/<slug>-<6hex>/` (33 dirs) | 1.8 G | One folder per character: `character.json` (record: animations, scripts, garments, props, mount, joints, skins...), `model.glb` (normalized import), `rigged.glb` (live rig), `joints.json`, `weight_edits.json` (painted weights re-applied on every re-rig), `journal.jsonl`, `thumbnail.webp`, `source/` (original upload), `textures/` (+`projections/` for AI repainting), `garments/<id>/{model, weights.json}`. Some are not people (horses, `caravan-pony`, `source-2ebaa2`, `longbowman-ff4808`). |
| `library/` | 1.8 G | Generated animation library: `clips/<id>.glb` (2460), `manifest.json` (5 MB), `meta/`, `cache/*.npz`, `sources/mixamo-named` (downloaded FBX + hashes, irreplaceable offline) and `sources/custom` (made clips `*.edit.json`), `creatures/<rig>/` (saved creature clips + `index.json`), `mannequin/ybot.glb`, `audit.json`, `catalog-verification.json`, `failures*`, `backups/before-named-catalog`, `verify/`, `work/`, `README.md` (generated). |
| `game/units.json` | 8.7 KB | Rigsmith's own unit list (the "In the game" source of truth); seeded once from the game repo. Edited only through the API. |
| `exports/` | 35 MB | Browser-export output dir (default `exportDir`): 3 GLBs, a PNG, `rigsmith_lods.gd`; all 10-14/15. The game export does NOT write here (it writes into `<gameRepo>/assets/models/units`, work files in `<gameRepo>/.work/rigsmith`). |
| `renders/<id>/` (3 dirs) | 75 MB | `rig.ts render` contact sheets; `rig.ts check` also writes its re-export scratch to `renders/_check/` (absent now). |
| `backups/` | 77 MB | Hand-made safety copies: `game-import/<timestamp>/` (auto, from `game_import.py`: `character.json` copies), `scout-before-ground-*`, `scout-before-skeleton-fix-*`, `villager-before-coat-fix-*`, `scout-coat-report.json`. Naming is ad hoc; no restore tool. |
| `trash/<slug>-<id>-<ISO time>/` (15) | 343 MB | Soft-deleted characters (DELETE route moves them here). No UI to restore or purge. |
| `cache/` | 34 MB | `posespace-frames.f32(+.json)` from `tools/posespace.ts --cache` (rebuildable). Not to be confused with `library/cache`. |
| `audits/<date>-<topic>/` (11) | 9.3 G | Evidence from the 2026-10-26..27 rigging/naturalization campaign (reports, JSON results, images, one-off `apply.ts` records, `aggregate.py`/`batch.py`). Referenced by HANDOFF. Largest directory on disk; only `*.md/*.json` top-levels + two dirs are backed up. |
| `rigdev/` | 7.7 G | Rig R&D: `bench/` (Mixamo vs ours), `gt/` (ground truth), `markers.json`, `joints.json`, `out*` experiment outputs, weight sheets, `fit_stats.py`, `loo.py`, `confusion.py`, `rig_all.sh`. Contains hand-made ground truth (backed up: `gt`, `gtjoints`, `joints.json`). |
| `scratch/` | 45 MB | Throwaway scripts (`*.ts`: `scout_coat.ts`, `rigid.ts`, `healtest.ts`, ...), `rom*` experiments. Dated work files from investigations; no policy. |
| `.probe/` | 108 MB | Hidden: skin-optimizer probes (`band_*.glb`, `opt_abs.glb`, `old.bin`...). |

Why the shape is awkward: `workspace/` mixes (1) user data that must be backed up (`characters`, `game`, `settings.json`, `library/sources`, `rigdev/gt`), (2) rebuildable caches (`library/clips|cache|meta`, `cache`), (3) generated outputs (`exports`, `renders`), (4) soft-delete (`trash`), (5) hand-made safety copies (`backups`, `library/backups`), and (6) 17+ GB of experiment/evidence (`audits`, `rigdev`, `scratch`, `.probe`). There is no manifest of which is which; `backup_workspace.sh` encodes it by hand.

---

## 7. Redundancy and overlap

### 7.1 Two implementations of "bake a character with its clips, scripts, keys, gear"
* **Browser** (`src/engine/exporter.ts` -> `bakeEntry` `src/engine/animation.ts:38-62`, shared with the live viewer `animator.svelte.ts:255`): retarget (via `RetargetCache`), speed, scripts, lift, bone keys, prop tracks; gear via `attachProps` (`props.ts`) + `attachGarments` (`garments.ts`) on a live `CharacterView`; exports with `GLTFExporter`.
* **Node** (`tools/game_export.ts`): hand-rolled copies of the same pipeline: retarget+retime+`scalePositions` (`:122-137,264-268`), scripts (`:662-669`), lift/keys/prop tracks (`:699-705`), garment placement `garmentMatrix`, clothing/parts skinning via `tools/lib/gearskin.ts`, pulls re-solved per frame with an `AnimationMixer` (`:733-762` mirroring `pulls.ts tickPulls`), mount/companion (`:210-226,796-857` mirroring `mount.ts`), duplicated for the *companion's* clips (`loadCompanion` `:139-198` repeats scripts+lift+keys a second time). Order of operations is duplicated by convention ("the viewer's order") and guarded only by the manual `tools/dev/tune_parity.ts`.
* Consequence: a change to scripts/keys/ground/pulls must be made in `bakeEntry` AND `game_export.ts` (twice there, unit and companion). `bakeEntry` already has the `urlFor` indirection to run headless; `game_export.ts` could call it if `CharacterView`/`RetargetCache` ran in Node (they do: `tools/lib/node3d.ts body()`).

### 7.2 Two LOD systems
* `src/engine/export/lods.ts` `addLods` (ratios 0.5/0.25/0.12 of each skinned mesh, `LOD_DISTANCES` 12/25/50 character-heights in glTF `extras`, consumed by `godot/rigsmith_lods.gd`) vs `game_export.ts addLevels` (`:235-252`; `lods` default `[0.45,0.15]`, `budget` pre-simplification, named `_LOD1/_LOD2`, no extras, consumed by the game's `ModelLib.cs` by name). Both call `simplify()`/`compact()`; `simplifyKeeping()` (`game_export.ts:200-221`) is a copy of `simplify()` (`lods.ts:49-83`) with a vertex `lock`, including a duplicate of the flatten helper (`flat` vs `attributeArray`). Weights differ in no way, so `simplify` could just take an optional lock.
* The UI help text and `LOD_*` constants are a third copy of the numbers (`ExportPanel.svelte:118`).
* `godot/rigsmith_lods.gd` is unused by the game (grep of `emberhold` finds no reference).

### 7.3 Two export paths, three "settings" homes
Generic GLB (browser, `localStorage` options, `exportDir`) vs game unit (server job, `workspace/game/units.json`, `gameRepo`). They differ in: bone naming option vs fixed; texture (embedded, resized) vs extracted `base.png` for the game's own maps; catalog props included vs dropped; hidden garments omitted vs kept for `Gear*/Head*/Wear*`; one material per mesh vs forced `Main`; clip names from entries (+`-loop`) vs game slot names. `Settings.exportFormat` ('glb'|'fbx') and `Settings.boneNames` (server) duplicate `ExportOptions.boneNames` (client) and are never read. The `/api/exports` regex accepts `.fbx` names although no FBX export exists.

### 7.4 Dead / vestigial code (cited)
* `src/engine/export/ExportAnimationCleanupService.ts` (78), `ExportHierarchyService.ts` (86), `FbxTextureCompatibilityService.ts` (105), `GlbSkinCleanupService.ts` (90): Mesh2Motion classes, imported by nothing but their own tests (grep: only `*.test.ts` under `src/engine/export/`). ~360 lines + ~320 lines of tests, plus `GlbSkinCleanupService` duplicates the GLB chunk-rewrite that `renameNodes` (`exporter.ts:112-131`) does. `FbxTextureCompatibilityService` has no tests and no caller.
* Dependencies `@comfyorg/fbx-exporter-three` and `jszip` (`package.json`): no importer in `src`, `server` or `tools`.
* `Settings.exportFormat`, `Settings.boneNames` (`server/workspace.ts:226-227,237-238`).
* `ExportOptions.fps` (`exporter.ts:21`): no UI, always 30.
* `src/state/slots.svelte.ts:1` comment refers to `settings.gameSpec` (no such setting); `GameSide.spec` field is carried but unused by the panel (`game.ts:147` returns `spec: UNITS_FILE`).
* `src/engine/presets/automap/{Mesh2MotionMapper,RigifyMapper,rig-fixtures}.ts`, `tools/extract_templates.py`, `LICENSE-*.MD`: upstream Mesh2Motion heritage (verify use before keeping).
* `.vscode/settings.json` points at a non-existent test path.
* `tools/dev/_end.ts`, `hand_eval.ts`, `palm_eval.ts`, `bleed_where.ts`, `weights_at.ts`: standalone scripts each re-declaring the same headless GLTFLoader shim (`g.self ??= globalThis; g.createImageBitmap ??= ...; load()`) that `tools/lib/node3d.ts` already provides (also repeated in `ground.ts`, `tune_parity.ts`, `bench.ts`, `tools/library_verify.ts`, `tools/skin_opt/pose_set.ts`).
* `ExportPanel`: `textureChoice`/`lodChoice` strings duplicating `options.textureSize`/`options.lods` (`:24-25`).
* `api.openFolder` is defined but the Export step never offers "open folder".

### 7.5 Repeated GLB-chunk parsing (`readUInt32LE(12)` ... JSON ... BIN)
At least seven hand-written copies: `server/glbimages.ts:26,93`, `server/weights.ts:35`, `server/library.ts:116`, `server/glbtransform.ts:29-31`, `src/engine/exporter.ts:112`, `src/engine/export/GlbSkinCleanupService.ts`, `tools/game_export.ts:78` (`embeddedImage`), plus `tools/game_import.py class Glb` and two copies inside tests. One shared GLB read/write module would cover all.

### 7.6 Other overlap
* `tools/rig.ts` re-reads `workspace/` JSON itself (`spec()`, `characters()`, `settings()`) while also calling the HTTP API; `tools/game_import.py` has its own copies of the workspace path rules (`WORKSPACE`, `RIGSMITH_URL`) and of `SWAPPED = ('Gear','Head','Wear')` (`:51`) which is `SWAPPED` in `game_export.ts:106`; the game README and `README.md` "Game units" explain the same flow twice.
* `server/game.ts exportUnits` and `tools/rig.ts check` both invoke `game_export.ts` with different spec sources (the game's file vs `workspace/game/units.json`); `check` hashes against the game's `.glb` but the game's pipeline post-processes only maps, so equal bytes are expected.
* Docs: README Checks section (rigging prose) vs HANDOFF "Latest hand solver behavior" vs `workspace/audits/*/REPORT.md` restate the same finger/surface algorithm in three places.
* Backups: `workspace/backups/*`, `workspace/library/backups`, `workspace/trash`, `tools/dev/backup_workspace.sh` (external drive) are four independent safety mechanisms with no shared convention.

---

## 8. Rough edges

**Risky behaviour**
1. `exportUnits` (`server/game.ts:109-143`) writes the game's `units.json` BEFORE running the build and never rolls back; a failed build leaves the game repo edited. The sequence also mutates the loaded spec (`delete entry.draft`, `:118`), so Rigsmith's draft flag is cleared even if the build later fails.
2. Concurrency: `enqueue` runs up to 3 jobs at once (`server/jobs.ts:10`) with no per-kind lock; two simultaneous game exports each read-modify-write the same `units.json` (`game.ts:114-122`) and can lose each other's block. The panel's spinner is global to any `export` job, which hides the race rather than preventing it.
3. `emberhold:tools/rigsmith/build.sh` pipes the Node export through `grep -v GLTFLoader` under `set -e`: the pipeline's status is grep's, so a crash of `game_export.ts` (which prints errors, so grep exits 0) does not stop the script; Blender then builds maps from a stale GLB and the job still reports success unless later steps fail. (Game repo script, noted because Rigsmith's job status depends on it.)
4. The game build is a shell subprocess with no timeout or cancel (`game.ts:125-138`); progress is faked as `lines/40` (`api.ts:418`).
5. `game_export.ts` runs `git rev-parse` at the end and depends on `workspace/library/audit.json` existing at import time (`:98-102`) at module load.
6. `tools/dev/coat_weights.ts --apply` and any `apply.ts` in audits can PUT live weights; the memory rule "only Scout/Villager may be re-rigged" is enforced nowhere in code.
7. Destructive-looking defaults: "Make it a unit" creates `budget 8000, tex 1024` regardless of character class; `update` of `units.json` has no schema validation beyond `character,height,clips` (`api.ts:397`); clip names are free text.
8. Browser export of big characters blocks the page (all work in the main thread; no progress, no cancel); `Export all` aborts on first error and leaves partial files.
9. `fileName()` collisions overwrite silently; export folder is created on demand but not validated (typo = a new folder).
10. `/api/exports` copies `rigsmith_lods.gd` into the user's folder (possibly a Godot project) on every export, overwriting a customized copy.

**Inconsistent naming**: "unit" vs "character" vs "slot" vs "clip"; `exportDir` / "Export folder" / "Destination"; Settings key `boneNames` vs options `boneNames`; "Distance LODs" (UI) vs "levels"/`lods` ratios (units.json, array of ratios) vs `lods` count (ExportOptions); `character.animations[].name` doubles as the game's clip name; `UnitSpec` is declared in `server/game.ts:11` (re-exported by `src/state/api.ts:8`) and again as a separate `UnitSpec` in `game_export.ts:45` with different fields (`lods`, `head`, `models_dir` there, `draft`, `tex` elsewhere).

**Missing tests**: see 5.4; especially the game contract (mesh/material/bone naming), `exportUnits` ordering/rollback, `renameNodes`, and any Svelte component.

**Discoverability**
* Export step is a single tall column: the game integration (the live workflow) is first but the generic GLB export and its settings follow without a divider explaining they are a different path; `Settings` popover holds only `exportDir`.
* `gameRepo`, `boneNames` defaults, game-side build requirements (Blender, `build.sh`, `RIGSMITH` env) are discoverable only by reading README/emberhold README or JSON.
* Dev commands live in README prose, HANDOFF and file headers; `package.json` exposes 16 scripts but none for the 13 `tools/dev` scripts, tools type-check, Python tests, `rig.ts`, backup.
* No in-app indication that a character changed since its last game export (needs `rig.ts check`); no in-app display of stride values, holds failures, or warnings emitted by the export (e.g. "gear left out: not a part the game built" appears only in the job log lines the panel truncates to 120 chars, `api.ts:419`).
* Gear built outside the game's Blender pipeline silently never reaches the game (only a console warning), while the Outfit step and the browser export happily include it.
* `HANDOFF.md` and the generated `workspace/library/README.md` are the first docs a newcomer meets and both describe states that no longer hold.
