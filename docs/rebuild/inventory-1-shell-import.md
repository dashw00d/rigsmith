# Inventory 1: App shell and Import step

Scope: `src/app/{App,TopBar,CharacterList,Inspector,Viewport,Toasts,JobsPopover,SettingsPopover,HistoryPanel,DropOverlay}.svelte`, `src/app/steps/ImportPanel.svelte`, `src/ui/*`, `src/state/{app,api,viewer,thumbnails}`, `src/engine/{Stage,CharacterView,ThumbnailRenderer,PreviewRenderer}.ts`, `server/{workspace,api,jobs,journal,plugin,glbtransform}.ts`, `blender/jobs/inspect.py`, `blender/common/*`. Read-only audit; line numbers are as of HEAD `36f9295`.

---

## 1. Purpose of the area

The shell is the one-page frame (top bar with the six-step nav, left list/library, centre 3D viewport, right inspector) plus everything global: the character list, background-job queue, toasts, settings, per-character history journal, drag-and-drop import and the local HTTP/SSE server that persists everything to `workspace/`. The Import step turns a dropped FBX/GLB/OBJ/DAE/ZIP into a normalized `model.glb` plus a classification (unrigged mesh, rigged elsewhere, animation only), stats, auto-detected joints, and lets the user rename, resize/stand on floor, re-import or delete the character.

---

## 2. UI surface

### 2.1 Page layout (App.svelte)
| Element | What it does | Where |
|---|---|---|
| Fatal screen "Can't reach the local server" | Shown when `app.start()` fails; hint `npm run dev`. No retry button. | App.svelte:52-57 |
| Workspace-tools strip (38 px) | Always visible under the top bar. Holds left-panel toggle, character `<select>`, inspector toggle. | App.svelte:59-67 |
| Left panel toggle (button, label changes `Characters`/`Library`/`Props` by step) | Docks/undocks left panel (>=1100 px), or opens it as a drawer with scrim (<1100 px). `aria-expanded`/`aria-controls` set. | App.svelte:28-31, 60 |
| Character `<select>` | Second way to change the selected character (value bound to `app.selectedId`). Disabled until ready or when the list is empty ("No characters"). | App.svelte:61-65 |
| Inspector toggle | Docks/undocks the right panel (>=760 px) or drawer (<760 px). | App.svelte:33-36, 66 |
| Left `<aside>` content swap | `CharacterList` on import/rig/texture/export, `Library` (animate step), `PropCatalog` (outfit step); an empty placeholder until `ready`. Width widens (`clamp(300px,28vw,440px)`) for animate/outfit. | App.svelte:45, 72-82, 102 |
| Centre `<main>` | `Viewport`. | App.svelte:83 |
| Right `<aside>` | `Inspector` (step panel + History). | App.svelte:84 |
| Scrim button "Close panel" | Closes any open drawer. | App.svelte:69-71 |
| Responsive state | `compact` <1100 (left = drawer), `narrow` <760 (right = drawer); dock/drawer booleans are plain `$state`, not persisted; CSS media queries repeat the same breakpoints. | App.svelte:17-24, 121-122 |
| Keyboard: `Escape` | Closes both drawers (does not touch popovers; those have their own Esc listener). | App.svelte:48 |
| Thumbnail pump | `$effect` calls `thumbnails.ensure(app.characters)` on every character-list change. | App.svelte:39 |

### 2.2 Top bar (TopBar.svelte)
| Element | Behavior | Where |
|---|---|---|
| Brand logo + "Rigsmith" | Static SVG; text hidden <1100 px. | TopBar.svelte:38-47 |
| Step nav (6 pill buttons, `aria-current="step"`) | Sets `app.step` (persisted to localStorage `rigsmith.step`). Not gated: any step is reachable for any character. Tooltip = step hint. Auto-scrolls active step to centre (ResizeObserver + tick). | TopBar.svelte:49-57, 13-23 |
| "Done" tick on a step | `done()` is defined for only 3 steps: import (not importing/error), rig (`status==='rigged'`), animate (`animations.length>0`); outfit/texture/export never show done. | TopBar.svelte:25-34 |
| Jobs chip | Shows `N running` with spinner, else `Idle` / `Offline` (green/red dot = SSE `connected`). Click toggles JobsPopover (closes SettingsPopover). Tooltip "Background jobs". | TopBar.svelte:60-71 |
| Settings icon button | Toggles SettingsPopover (closes jobs). | TopBar.svelte:72-77 |

### 2.3 Jobs popover (JobsPopover.svelte)
- Title "Background jobs"; empty text "Nothing yet. Imports and rigs run here in Blender, in the background." (:18).
- List of the 12 newest jobs (`app.jobs.slice(0,12)`), each: status icon (spinner/clock/check/alert), `label`, `message` (or `error` if failed) + "Ns/m/h ago", progress bar if running (:20-36). `ago()` is computed at render and never ticks (:9-12).
- No cancel, retry, clear, or link-to-character actions. Width 320, right-aligned (:15).

### 2.4 Settings popover (SettingsPopover.svelte)
- One field: "Export folder" text input (`exportDir`); saved on Enter and on blur, each firing a toast "Export folder saved" (:9-12, :19). No validation, no browse button, no "open folder".
- Other server settings (`exportFormat`, `boneNames`, `gameRepo`, `handPoses`) have no UI here (see 8).

### 2.5 Character list (CharacterList.svelte) — left panel on import/rig/texture/export
| Element | Behavior | Where |
|---|---|---|
| Header "Characters" + count chip | Count of all characters. | :57-58 |
| `+` icon button (aria "Import models") + hidden `<input type=file multiple accept=.fbx,.glb,.gltf,.obj,.dae,.zip>` | File-picker import; resets input. | :59-63 |
| Empty-state dashed button "Drop models anywhere" | Same file picker; copy claims "they import in parallel". | :66-71 |
| Row (button) | Selects character (`app.selectedId`, persisted `rigsmith.selected`). Shows 40 px thumbnail (or user icon), name, status line, progress bar when job running. | :77-90 |
| Status text/tone | Derived: job message if a job is live; else Importing / Rigging / error text (tooltip carries the error) / `Rigged · <preset>` (imported rigs) / `Rigged · N verts` (auto-rigged) / "Animation file" / "Needs rig". | :12-22 |
| Rename: double-click name, or pencil icon (hover-revealed) | Inline input over the row; Enter saves, Escape cancels, blur saves; `app.update(id,{name})` with error toast. | :24-37, 83, 91-97 |
| Delete (trash icon, hover-revealed) | Blocked with toast if the character has a running job; native `confirm()`; `DELETE /api/characters/:id`; toast "deleted (in workspace/trash)". | :38-48, 98 |
| Footer "Auto-rig all N" (shown when >1 unrigged) | For each `kind==='mesh' && status==='ready'` call `app.rig()`; toast "Rigging N characters in the background". | :10, 50-53, 104-108 |

### 2.6 Inspector (Inspector.svelte)
- No character: "Import a character to see its details here." (:12-15).
- Otherwise renders exactly one of ImportPanel / RigPanel / OutfitPanel / TexturePanel / AnimatePanel / ExportPanel by `app.step` (:16-28), then `HistoryPanel` under every one (:29-31).

### 2.7 Import panel (steps/ImportPanel.svelte)
| Element | Behavior | Where |
|---|---|---|
| Title input (18 px, borderless) | Rename; saves on blur/Enter (no error handling). | :16-22, 48 |
| Badges | "Importing…" while importing, else kind label (Auto-rigged / Unrigged mesh / Rigged character / Animation only) + rig-preset badge (Mixamo / Tripo auto-rig / Rigify / Unreal mannequin / Unknown skeleton). | :12-15, 49-55 |
| Source file line | `source.originalName` (mono). | :56 |
| "Model" section | Triangles, Vertices, Height (measured from the live view box, falling back to `stats.height`), Meshes, Bones (if >0). | :59-69 |
| "Size" section (non-animation, once model is loaded) | Height number input (min .05, step .01) + "Resize" button -> `POST /fit {height}`; disabled unless valid and different (>0.5 mm). If lowest point is off the floor by >2 mm: warning "Its lowest point is X cm below/above the floor" + "Put it on the floor" -> `POST /fit {}`. Explanatory paragraph. | :24-39, 71-85 |
| "Problem" section | Shows `character.error` in red. | :87-91 |
| "Notes" section | `rigReport.warnings[]` (import warnings: stood-on-floor, hidden legs, arm trace failures, joint detection failed). | :93-97 |
| Primary CTA | `rigged` -> "Pick animations" (goes to Animate); unrigged mesh (not importing) -> "Rig this character" (goes to Rig). Nothing for `kind==='animation'` or errors. | :99-104 |
| "Re-import" ghost button | `POST /reimport` (re-run inspect; no confirm, no toast, no error handling). | :106 |
| "Delete" danger button | `confirm()` then `app.remove` (no busy check, no toast, no error handling). | :41-44, 107 |

### 2.8 Viewport (Viewport.svelte)
| Element | Behavior | Where |
|---|---|---|
| Canvas container + vignette | Stage mounts on `onMount`; radial gradient background. | :27, 77-78 |
| Display-mode segmented (icons only): Shaded / Clay / Weights / X-ray | `viewer.setMode`; local `mode` mirrors `viewer.mode`. | :55-62, 82 |
| "Show bones" toggle (only if the loaded model has a skeleton) | `viewer.setSkeleton`. | :83-85 |
| "Frame character" button / key `F` | `viewer.focus()` (animated re-frame). `F` is ignored in inputs/buttons/selects (`allowsShortcut`). | :86, 133 |
| Caption | Name + `tris · height m` from `stats` (not the live measurement used by ImportPanel). Hidden if container <380 px tall. | :88-93, 207 |
| Joint label | Floating label of hovered/selected joint of the 3D joint editor (`prettyBone`, side colour). | :64-72, 96-100 |
| Hosted overlays | `Timeline` (animate/export/outfit, or rig while a rig test plays), `MaskPainter` (texture step with painter active), `ScaleRoom`, `MarkerBoard` (rig step) all mounted here. | :102-113 |
| Busy pill | Shows animator error, or a spinner + message for: job, model load, animator load, clip edit, outfit fitting, painter, marker board, scale room, paint. Fallback text "Retargeting animation". | :115-123 |
| Empty hero | "Drop a character to begin." | :125-130 |
| Side effects | Re-sync effect on selected character revision/status/props/garments/mount + `outfit.fitting` (:36-46); stage `covered` flag when marker board/scale room is open (:29-34); joint editor follows saved joints (:49-53). | |

### 2.9 Toasts, drop overlay, history
- **Toasts** (Toasts.svelte): bottom-right stack (raised by `--playback-dock-height`), 3 kinds (info/ok/error) with icon, `aria-live=polite`, manual dismiss X; auto-dismiss 5 s (app.svelte.ts:133-137). Dismiss mutates `app.toasts` directly (:11).
- **DropOverlay** (DropOverlay.svelte): window-level dragenter/leave/over/drop for `Files`; full-screen blurred card "Drop to import / Meshes, rigged characters, or a stack of Tripo ZIPs"; drop -> `app.importFiles`. Drop works on every step and over any panel (including over a rig/outfit-specific drop target? no step-specific drop targets exist in this area).
- **HistoryPanel** (HistoryPanel.svelte): collapsible section "History" (state in localStorage `rigsmith.history`); when open: note input + send button (`POST /journal {note}`), list of entries (who = "you" for `app`, else the tool name; time; one or more change lines), first 25 shown, "Show all N" link; reloads on `character.updatedAt` or SSE `journal` beat; fetches last 300 (:12-63).

### 2.10 Shared UI kit (`src/ui`)
| Component | Role | Used by (this area) |
|---|---|---|
| Button.svelte | variants primary/secondary/ghost/danger, sizes sm/md/lg, `icon`, `block`, `loading` (spinner + disabled). | CharacterList, ImportPanel (and every step) |
| Section.svelte | Panel section with optional uppercase title + action snippet, bottom divider, `flush`. | Inspector panels, HistoryPanel |
| Segmented.svelte | Radiogroup of buttons with arrow/Home/End keys, optional icons, `iconsOnly`, per-option hint tooltips, `bind:value` + `onchange`. | Viewport (display mode), Export/Rig panels |
| Toggle.svelte | Switch with label + hint, `bind:checked` + `onchange`. | other steps |
| Popover.svelte | Absolute dropdown under its anchor, closes on outside pointerdown/Escape, width + left/right align. | Jobs, Settings popovers only |
| tooltip.ts | `use:tooltip` action; one shared fixed-position div, 380 ms hover delay, hides on pointerdown. Not shown on keyboard focus. | TopBar, CharacterList, Viewport, Segmented |
| shortcuts.ts | `allowsShortcut(e)`: window shortcuts ignore modified keys and focus in input/select/textarea/button/a/summary/role=button/slider/contenteditable. | Viewport `F`, Timeline, Library, EditPanel |
| (CSS) `src/styles/{tokens,base}.css` | Dark tokens (`--bg-0..4`, `--accent`, side colours L/R/centre), fonts Inter + JetBrains Mono, focus ring. | all |
There is no shared Input, Select, IconButton, Badge, Field, Dialog/Confirm or Tabs component; every panel hand-rolls them (see 7).

### 2.11 Keyboard shortcuts owned by this area
| Key | Effect | Where |
|---|---|---|
| `Esc` | close drawers | App.svelte:48 |
| `Esc` | close open Jobs/Settings popover | Popover.svelte:13 |
| `F` | frame character | Viewport.svelte:133 |
| Enter / Esc | commit / cancel list rename; Enter commits title rename and settings export dir | CharacterList.svelte:93, ImportPanel.svelte:48, SettingsPopover.svelte:19 |
| Arrows/Home/End | move within a Segmented group | Segmented.svelte:10-22 |
| Mouse | Orbit/zoom/pan via OrbitControls (damped, screen-space pan); left-drag on canvas blurs focused controls and clears text selection | Stage.ts:52-69 |
Other shortcuts (space/comma/period, PageUp/Down, Delete) are owned by Timeline/Library/EditPanel (other inventories). Several window `Escape` listeners coexist (App, Popover, MarkerBoard, EditPanel) with no priority order.

### 2.12 Persistence of UI state (client)
`localStorage`: `rigsmith.selected`, `rigsmith.step` (app.svelte.ts:17-36), `rigsmith.history` (HistoryPanel:12), `rigsmith.export` (ExportPanel:19-22; other area). Panel dock state, display mode, show-bones, mirror are not persisted.

---

## 3. User workflows

1. **Import by drop**: drag file(s) anywhere -> overlay -> `importFiles` filters extensions (toast if skipped, app.svelte.ts:89-90) -> files uploaded **sequentially** (`POST /api/characters?name=`, raw body, <=512 MB) -> server hashes bytes, creates `characters/<slug>-<sha6>/` with `source/original.<ext>` and `character.json` `status:'importing'` (workspace.ts:294-318) -> response upserted; selection set only if nothing was selected -> `inspect` job queued -> Blender `inspect.py` -> character updated -> SSE `character` event refreshes the row -> client auto-generates a thumbnail and PUTs it.
2. **Import by picker**: `+` in the list header or the empty-state button, same path.
3. **Check the import**: Import step shows kind, preset, stats, warnings, errors. For an unrigged mesh the CTA goes to Rig; for a rigged import to Animate (even though a non-Mixamo rig usually needs mapping first).
4. **Resize / stand on floor**: type height -> Resize -> `POST /fit` rescales and shifts the GLBs in place (no Blender), also rescales joints/markers/garments/clip lift; "Put it on the floor" does the move only.
5. **Re-import**: Re-import button re-runs inspect on the original source (joints reset unless edited; model file regenerated).
6. **Rename**: double-click/pencil in list, or the title field in Import panel.
7. **Delete**: trash icon or Import-panel Delete; folder moves to `workspace/trash/<id>-<timestamp>` (recovery is manual file move).
8. **Batch rig**: "Auto-rig all N" when more than one unrigged mesh is ready.
9. **Switch character**: click row, or the `<select>` in the workspace strip (the only way on Animate/Outfit steps where the list is replaced).
10. **Background work awareness**: Jobs chip -> popover; failed jobs also raise an error toast (app.svelte.ts:69).
11. **History/notes**: open History at the bottom of any inspector; leave a note that a CLI agent (`tools/rig.ts note`) can read; agent edits appear signed with their name.
12. **Settings**: set the export folder.
13. **View**: switch Shaded/Clay/Weights/X-ray, toggle bones, press F.
14. **Restart recovery**: on dev-server start, `importing` characters are re-inspected and `rigging` ones reset to `ready` (api.ts:909-915).

---

## 4. Data model

### 4.1 `Character` (server/workspace.ts:18-67) — persisted as `workspace/characters/<id>/character.json`
Fields marked **[import]** are owned/written by this area; others are listed with purpose because the shell reads or preserves them. Count = how many of the 31 live characters have the field set.

| Field | Purpose | Written by |
|---|---|---|
| `id` | `<slug(<=40)>-<sha256(bytes)[0:6]>`; folder name; regex `[a-z0-9-]+` guards path traversal (workspace.ts:262). | [import] createCharacter |
| `name` | Display name; initial = file stem de-underscored and Title-Cased, `_rigged` stripped. PATCH-able. | [import] |
| `createdAt`, `updatedAt` | List order (`createdAt`), history refresh trigger (`updatedAt`, bumped on every write). | [import] |
| `source {file, originalName, bytes}` | Original upload kept at `source/original.<ext>` (never deleted); `bytes` is informational. | [import] |
| `status` `importing / ready / rigging / rigged / error` | Lifecycle. `error` + `error` text on failure. A rigging job crash leaves `error`; restart resets `rigging`->`ready`. | [import]/rig |
| `kind` `mesh / rigged / animation` (31/31) | What the import contained (set by inspect.py). Drives which steps apply. | [import] |
| `rigPreset` (1/31) | Detected skeleton family: mixamo/tripo/rigify/unreal/unknown; cleared when converting. | [import] |
| `stats {vertices, triangles, height, meshes, bones}` | From inspect; `bones` overwritten after rig; `height` rescaled by fit. | [import] |
| `files {model, rigged, thumbnail}` | Relative names: `model.glb` (normalized import preview), `rigged.glb` (published rig, or the model for imported rigs), `thumbnail.webp`. Viewer shows `rigged ?? model` (viewer.svelte.ts:67). | [import] |
| `revision` | Cache-bust counter for model files (appended as `?v=` in `fileUrl`); bumped by inspect, rig, fit, weights, texture. | shared |
| `thumbVersion` | Cache-bust for the thumbnail (timestamp). | [import] |
| `scale` (3/31) | Cumulative Import->Size factor passed to Blender as `--scale` on every import/rig (api.ts:78,126); product of all `fit` ratios. | [import] fit |
| `joints` / `autoJoints` / `jointsEdited` | Detected (then user-edited) joint positions in glTF space; `autoJoints` = "Reset" target; flag stops re-import overwriting edits when `keepEdits`. Owned by Rig but seeded here by inspect (api.ts:85-87). | [import] seed |
| `fingers` | `none/one/two/full`, defaulted to `'full'` by inspect (api.ts:87). | seed |
| `rigReport {method, seconds, warnings}` | Import stores `method:'import'` with its warnings; rig overwrites. | [import]/rig |
| `error` | Last failure text, cleared on success. | [import] |
| `template`, `boneMap`, `markers`, `texture`, `animations`, `scripts`, `handPoses`, `props`, `garments`, `mount`, `skins` | Owned by Rig/Outfit/Texture/Animate/Export areas; this area only persists them via PATCH (allow-list at api.ts:317), journals them (journal.ts), and rescales a subset in `/fit`. `skins` is allow-listed and shown by the CLI but nothing in `src/` ever writes or applies it (0/31). | other areas |

Related types in the same file (owned elsewhere, documented in other inventories): `Mount` (character, bone, position, rotation, scale, freeze, pose, hips, skin, gear), `Garment` (id, name, file, status, mode clothing/rigid/part, policy, bone, position, rotation, scale, hideBody, hidden, from, sockets, group, anchor, painted, animation, pulls, carryPose, carryOpen), `HandPose`, `PullSocket`, `GarmentSocket`, `PropAttachment`, `TextureImage`, `AnimationEntry` (clipId, url, name, inPlace, loop, speed, trim, note, keys, lift), `ClipKeys/ClipKey`.

### 4.2 `Settings` (workspace.ts:224-233, file `workspace/settings.json`)
| Field | Purpose | Reality |
|---|---|---|
| `exportDir` | Where `POST /exports` writes GLBs; default `workspace/exports`; `~` expanded | Only field with UI (SettingsPopover) |
| `exportFormat` `glb/fbx` | Intended export format | **Unused** anywhere (grep finds only the type/default/settings.json) |
| `boneNames` `mixamo/mixamorig` | Intended bone-name default | **Unused**; ExportPanel keeps its own `options.boneNames` in localStorage |
| `gameRepo` | Emberhold repo path (default `~/dev/games/emberhold`) | Used by game.ts / `/api/game/*`; **no UI**; edited only in the JSON |
| `handPoses?` | Hand poses shared by all characters | Written by handposes.svelte.ts |

### 4.3 `Job` (server/jobs.ts:372-383)
`id`, `kind` (inspect/rig/texture/codex/garment/clip/export), `label`, `characterId?`, `status` queued/running/done/failed, `progress` 0-1, `message`, `createdAt`, `finishedAt?`, `error?`. In-memory only (lost on restart), newest 100 listed (:394-396). Concurrency `RIGSMITH_JOBS` (default 3) (:368). Timeout 10 min per Blender run (:433).

### 4.4 `JournalEntry` (server/journal.ts:9) and storage
`{at: ISO string, by: 'app' | tool name, changes: string[], note?: true}`, appended to `characters/<id>/journal.jsonl`. `by` comes from request header `x-rigsmith-by` (api.ts:37-41). Journal covers name, hand poses, clips, scripts, gear, props, mount, skins, markers, joints, fingers, boneMap, status (journal.ts:74-119).

### 4.5 Client state
- `AppState` (app.svelte.ts:28-138): `characters[]`, `selectedId` (persisted), `step` (persisted), `jobs[]`, `toasts[]`, `settings`, `connected`, `journalBeat`, `gameBeat`; derived `selected`, `activeJobs`.
- `Viewer` (viewer.svelte.ts:16-263): `stage`, `character` (CharacterView), `editor` (JointEditor), `mode`, `skeleton`, `loading`, `loadError`, `hoveredJoint`, `selectedJoint`, `mirror`, `adjusting`, `frame` tick; mount state `horse`, `seat`, `seatBone`, `heights` cache.
- `Thumbnails` (thumbnails.svelte.ts): pending/failed sets, single renderer.
- Other workspace layout (not typed): `characters/<id>/{source/, model.glb, rigged.glb, thumbnail.webp, joints.json, weight_edits.json, journal.jsonl, textures/, garments/<gid>/, projections/<pid>/}`, `workspace/{library,exports,trash,presets/skeletons,game/units.json,settings.json}`.

---

## 5. Engine / algorithms and server / Blender jobs

### 5.1 HTTP API (server/api.ts) — routes owned or touched here
| Route | Purpose |
|---|---|
| `GET /api/characters`, `GET /api/characters/:id` | list (sorted by `createdAt`) / one |
| `POST /api/characters?name=` | upload raw body; `createCharacter`; if `importing`/`error` enqueue `inspect`. Same bytes + same slug -> returns the existing character (no message to the user). 201. (:300-307) |
| `PATCH /api/characters/:id` | allow-listed field merge (`name, joints, jointsEdited, markers, fingers, animations, scripts, props, garments, mount, skins, boneMap, handPoses`; `null` deletes), journals diff under `by(req)`, emits SSE `character`. (:315-333) |
| `DELETE /api/characters/:id` | move folder to `workspace/trash/<id>-<ISO>`; emit `removed`. No job/reference checks. (:431-436) |
| `POST /:id/reimport` | enqueue `inspect` (202) (:538-543) |
| `POST /:id/fit {height?}` | Resize + floor in place (below) (:548-588) |
| `POST /:id/rig`, `/fingers`, `/template`, `/fit-template`, texture/projection/garment/weights routes | Other areas |
| `GET/POST /:id/journal` | read last N / add note (emits `journal`) (:336-345) |
| `GET /api/jobs`, `GET /api/events` (SSE) | job list; stream: `hello` (job list), `job`, `character`, `removed`, `journal`, `game`; 25 s ping; on job `done/failed` with a characterId also pushes the fresh character (:792-814) |
| `PUT /:id/thumbnail` | store client-rendered `thumbnail.webp` (<=4 MB), set `files.thumbnail`, `thumbVersion` (:783-788) |
| `GET/PATCH /api/settings` | read/merge settings (`~` expansion) (:858-859) |
| `POST /api/open` | `xdg-open` a path inside the workspace or exportDir (Linux only) (:691-697) |
| `POST /api/exports?name=` | write a client-built GLB to exportDir and copy `godot/rigsmith_lods.gd` beside it (:861-871) |
| `GET /files/<rel>` | serve any file under `WORKSPACE`, `no-cache`, `last-modified` (:874-885) |
| Library, game, skeleton-preset, library-edit routes | other areas |
`handle()` routes by `[method, regex, handler]` array scan; errors -> `{error}` JSON with `HttpError.status` else 500 (:887-907).

### 5.2 Job queue (server/jobs.ts)
FIFO queue, CONCURRENCY=3, `enqueue(kind,label,characterId,run)` emits `job` events; status flows queued->running->done/failed. `runBlender(script,args,onProgress,timeout)` spawns `blender -b --factory-startup --python <script> -- args`, parses `@@PROGRESS {json}` and `@@RESULT {json}` stdout lines, collects the rest as log, rejects with the last line matching /error|exception/ (:433-473). `runCodex` spawns the Codex CLI with images on stdin prompt (texture area). There is no cancel and no per-character serialization (only writes to `character.json` are serialized by `updateCharacter`).

### 5.3 Inspect job (`runInspect`, api.ts:74-95 + blender/jobs/inspect.py)
Inputs: source file, out dir, `--overrides textures/`, `--ground`, `--fingers <character.fingers ?? full>`, `--scale <character.scale ?? 1>`, `keepEdits` flag. Blender steps (inspect.py): import any format (zip extracted, first model by extension priority fbx<glb<gltf<obj<dae) -> `clean_materials` (drops alpha links, resets specular, removes unlinked image nodes, dithered blend) -> `apply_texture_overrides` (swap in `textures/<name>.png`) -> `close_small_holes` (weld slits at 0.2 % of height, cap loops <3 % of height; no new vertices) -> classify: armature without meshes = `animation`, armature + skinned meshes = `rigged`, else `mesh` -> `detect_preset` by bone names -> Mixamo prefix stripping -> for meshes: `scale_model` and `ground` (lowest point to z=0) -> stats (verts/tris/meshes/bones/height) -> for meshes `landmarks.detect_markers` + `skeleton.build_joints` (humanoid joints in glTF space) with warnings (hidden legs, un-traceable arms, detection failure) -> export `model.glb` (rigged: arm + meshes after `apply_rig_scale`; mesh: existing rigs stripped via `strip_existing_rigs` unless `--animations`). Result JSON: kind, rigPreset, stats, joints, model, animated, warnings.
Server then writes kind/preset/stats/autoJoints; keeps `joints` if `keepEdits && jointsEdited`; sets `fingers='full'` default; clears thumbnail; bumps revision; if `rigged` kind sets `status:'rigged'` and `files.rigged = model.glb`, else `status:'ready'` (unless keepEdits and already rigged); stores warnings in `rigReport` unless keepEdits.
`refreshOutputs` (texture area) reuses `runInspect(id, ..., true)` (api.ts:232-260). The garment importer reuses the same script with `--animations` (api.ts:729).

### 5.4 Fit/size (`POST /fit`, api.ts:548-588; server/glbtransform.ts)
Measures Y extents from accessor min/max of mesh POSITIONs (`extentY`, glbtransform.ts:191-215; throws on turned/matrix nodes), computes `s = height/current`, `d = [0, -min*s, 0]` per file, and rewrites the GLB(s) in place (`transformGlb`): unskinned = move scene root nodes; skinned = scale+move vertices and morph targets, root joints' translation, scale child joint offsets, rewrite inverse-bind matrices `W' = S·W·s^-1`, refuse if bones are animated in translation/scale, nodes use matrices, or bones are scaled (:218-303). Then updates `scale`, `joints`, `autoJoints`, `markers`, garment `position/scale/anchor/pulls.grip`, clip `lift`, `stats.height`, bumps `revision`, clears thumbnail, journals, emits `character`. Blocked (409) while the character has a queued/running job. Writes are not atomic across the two GLBs and there is no backup.

### 5.5 Workspace helpers (server/workspace.ts)
`readJson/writeJson` (atomic temp+rename; `JSON.stringify(...,null,1)`), `listCharacters` (reads every `character.json`), `updateCharacter` (per-id promise-chain lock, stamps `updatedAt`), `createCharacter`, `deleteCharacter` (rename to trash), `getSettings/saveSettings`, `characterDir` (id validation). `ensureWorkspace` makes `characters/ library/ exports/`.

### 5.6 Journal (server/journal.ts)
`describe(before, after)` produces plain-language diffs (clips, hand poses, scripts, gear incl. pulls/sockets, props, mount, skins, markers, joints, fingers, boneMap, status); `record` appends if non-empty; `note` appends a free line; `journal(id,last)` tails the file.

### 5.7 Plugin (server/plugin.ts)
Vite plugin: `ensureWorkspace()`, `resumeInterrupted()` (dev server only), then mounts `handle` as middleware; preview server mounts it without `resumeInterrupted`.

### 5.8 Client engine in this area
- **Stage** (Stage.ts): WebGL renderer (AgX tone map, exposure 1.1, PCF soft shadows, preserveDrawingBuffer), RoomEnvironment PMREM at 0.55, hemisphere + key (shadow-casting) + rim light, shader-drawn fading circular grid + shadow plane, `OrbitControls` (damping), `frame(box, instant)` three-quarter framing with eased camera move and re-frame on resize until the user orbits, `setSubjectSize(height)` rescales grid/shadow/near-far, frame callbacks with per-callback error isolation, `covered` flag to pause rendering, `project()` world->screen, `snapshot()` (unused).
- **CharacterView** (CharacterView.ts): GLTFLoader wrapper; collects meshes/skinned/bones, box and height, `RestSkeleton` capture (retarget.ts), rename map for custom skeletons; display modes: shaded (original materials), clay (grey standard), weights (per-vertex bone colour or single-bone heat map + paint-mask tint written into a `color` attribute), x-ray (0.32 opacity basic material keeping the albedo map); bone-line overlay updated per frame; full dispose of geometry/textures.
- **ThumbnailRenderer** (ThumbnailRenderer.ts): separate offscreen 256x256 renderer, same lights (copied), 3/4 view, WebP blob.
- **PreviewRenderer** (PreviewRenderer.ts): offscreen 144 px renderer that bakes 16-frame sprite sheets of library clips on a clone of the current character (retarget cache); used by the Animate library cards (area 3), not by this area.
- **Viewer** (viewer.svelte.ts): `sync(character, step)` reloads the GLB when `fileUrl` changes (token guard against races), re-attaches animator/outfit, builds/destroys the JointEditor for rig step (mesh with joints and not rigged, or `adjusting`), follows saved joints, handles mount (loads the horse GLB, seats the rider's root on a horse bone group, scales via game heights from `/api/characters/:id/game`), ticks mechanisms and pulls each frame, stops animator when leaving animation-related steps.
- **Thumbnails** (thumbnails.svelte.ts): serial queue; for each character lacking `files.thumbnail`, loads its model in the offscreen renderer and PUTs the WebP; failures remembered per `id:revision`.
- **API client** (api.ts): thin typed `fetch` wrapper `call()`; raw `Blob/ArrayBuffer/Uint8Array` bodies are sent as-is, everything else as JSON; `fileUrl(character, file)` chooses the cache-bust token by file kind.

---

## 6. Cross-area dependencies (what other steps rely on from here)

- **Selected character & step**: every step panel receives `app.selected` and reacts to `app.step`; the Viewport hosts Timeline, MarkerBoard, ScaleRoom, MaskPainter overlays and the Rig step's `JointEditor` via `viewer`.
- **`app.update(id, patch)`** is the single write path for Rig (joints/markers/boneMap/fingers), Outfit (garments/props/mount), Animate (animations/scripts/handPoses), and Export; server PATCH allow-list and journal are shared.
- **SSE channels**: `job` (progress UI, toasts), `character` (cross-tab/CLI sync), `journal` beat, `game` beat (`app.gameBeat` consumed by GameUnitPanel, slots, viewer mount heights, AnimatePanel).
- **`viewer.sync`/`CharacterView`**: Rig (weights mode, highlight, paintMasks, `refreshWeights`), Animate (`animator.attach/attachMount`), Outfit (`outfit.bind`), Export (`exporter.ts` re-reads `view.rest`, `hadVertexColors`), Weight paint, ScaleRoom all use the loaded `CharacterView`.
- **`Stage`**: JointEditor, outfit gizmos, painter, markers use `stage.scene/camera/onFrame/project/covered`.
- **Job queue and `runBlender`**: rig, texture fill, garment import, library, export-to-game all enqueue through jobs.ts.
- **`runInspect` (keepEdits)** is the "rebuild model with textures" step for the Texture area; `inspect.py` is the garment importer for Outfit.
- **`character.scale` / `/fit`**: Rig (`--scale`), Outfit/Animate (positions, clip lift) and Export/Scale room (units) rely on the resize bookkeeping; `glbtransform.ts` is the only in-place GLB editor.
- **`character.files.rigged ?? model`** is the contract for what is displayed and exported.
- **Thumbnails**: CharacterList only (and the CLI).
- **`PreviewRenderer`**: Animate library.
- **Settings**: `exportDir` (Export), `gameRepo` (Export/Scale room/GameUnitPanel), `handPoses` (Rig hand poses).
- **Journal**: written by every PATCH, plus `note_` calls in weights/garments/game routes; CLI `tools/rig.ts` (`history`, `note`, `get`, `set`, `list`) is a second client of the same API using `x-rigsmith-by: agent`.
- **`kind`/`rigPreset`**: Rig panel branches (animation-only message, "Rigged elsewhere" convert flow, skeleton mapping).

---

## 7. Redundancy and overlap

1. **Two delete implementations**. `CharacterList.remove` (CharacterList.svelte:39-48: busy check, toast, error handling) vs `ImportPanel.remove` (ImportPanel.svelte:41-44: none of those; unhandled rejection on failure). The confirm text is copy-pasted.
2. **Two rename UIs / implementations**. List inline rename with escape/blur semantics and error toast (CharacterList.svelte:24-37) vs always-editable title input in ImportPanel (ImportPanel.svelte:16-22, 48) with no error handling and a `$effect` that resets `name` from `character.name`.
3. **Two character pickers** at once: the list rows (CharacterList) and the `<select>` in the workspace strip (App.svelte:61-65). The select is the only picker on Outfit/Animate (list is swapped for Props/Library) but is redundant noise on the other four steps.
4. **Left-panel identity crisis**: one `<aside>` that is Characters, Library or Props depending on step (App.svelte:72-82). Import/delete/rename/Auto-rig-all and drag-targets exist only when the step happens to show the list.
5. **Import entry points**: header `+`, empty-state button, global drop (DropOverlay), and (CLI) none; all converge on `app.importFiles`, but the file extension regex is repeated in four places: app.svelte.ts:89, CharacterList accept attr :62, api.ts:302, and the garment route api.ts:708 (plus MODEL_EXTENSIONS in scene_io.py:10, and the DropOverlay hint text).
6. **"Size" is implemented twice** and measured four ways: Blender `scene_io.scale_model` + `ground` at import time (scene_io.py:233-265) vs JS `transformGlb` in place (glbtransform.ts) for post-hoc changes; heights shown come from `stats.height` (Blender, set at import), the live `CharacterView.box` (ImportPanel/`viewer`), `extentY` accessor extents (server fit), and Viewport caption (`stats.height`). They can disagree (e.g. Viewport caption vs Model section during a fit race). Plus separate size notions elsewhere: game `UnitSpec.height` (Scale room), `Mount.scale`, `Garment.scale`.
7. **Three copies of the lighting rig / offscreen renderer setup**: Stage.ts:22-46, ThumbnailRenderer.ts:14-31, PreviewRenderer.ts:88-101 (slightly different exposure and light strengths, so thumbnails don't match the viewport exactly). Disposal logic is duplicated between `ThumbnailRenderer.render` (:53-64) and `CharacterView.dispose` (CharacterView.ts:432-453).
8. **Server thumbnail state duplicated on client/server**: `files.thumbnail`, `thumbVersion`, `thumbnails.failed/pending`, and "clear thumbnail" scattered across inspect (api.ts:89), refreshOutputs (:248), fit (:582) and PUT thumbnail (:786). The thumbnail is rendered by the browser and uploaded, so the server cannot make one itself (CLI/agent-only workflows leave blanks until a browser opens).
9. **Mirror flag in three places**: `viewer.mirror` (viewer.svelte.ts:26), `RigPanel`'s local `mirror` toggle (RigPanel.svelte:221), `paint.mirror` (WeightPaintPanel.svelte:76).
10. **Display mode mirrored**: `Viewport.mode` local state duplicates `viewer.mode` via an effect (Viewport.svelte:61-62) and also pushes through `bind:value` + `onchange` (:82).
11. **Dual-write / echo for character updates**: `app.update` mutates the local object, PATCHes, `upsert`s the response, and the server also pushes an SSE `character` event for the same write (app.svelte.ts:102-106, api.ts:331), so every edit is applied 2-3 times; job completion pushes the character again (api.ts:797-799). Whole-object replacement means any in-flight local edit on the same character can be overwritten by an older server copy ("a page holding an older copy would otherwise save that back over it" comment at api.ts:330 acknowledges the root problem; PATCH is whole-field replace, not a merge).
12. **Errors surface twice**: failed job -> toast (app.svelte.ts:69) and `character.error` -> "Problem" section and list status text (ImportPanel :87, CharacterList :18).
13. **Settings split-brain**: `exportFormat` and `boneNames` live in `settings.json` (dead), while Export options (bone names, texture size, image format, LODs, loop suffix) live in browser `localStorage` (`rigsmith.export`). Only `exportDir` is real server state. `gameRepo` is real but unreachable from the UI.
14. **Journal vs jobs vs toasts vs History**: four overlapping "what happened" surfaces (toasts, jobs popover, per-character History, status line), none cross-linked. Journal misses the long-running operations (import completion, rig completion, reimport, texture fill), see 8.
15. **Rig-job progress shown three times**: list row progress bar (CharacterList:88), Viewport busy pill with its own bar (Viewport.svelte:117-123), Jobs popover entry.
16. **Status derived in several places with different rules**: `CharacterList.status()` (:12-22), `ImportPanel.kindLabel` (:12-15), TopBar `done()` (:25-34), `Viewer.fileFor`, `thumbnails` file choice (thumbnails.svelte.ts:16,30), `unrigged` filter (CharacterList:10), RigPanel conditions. There is no single "character phase" selector.
17. **Hand-rolled controls instead of shared components**: only 5 UI components exist; text inputs, number inputs, selects, icon buttons, badges, chips, dialogs/confirm are re-styled per file (`.num`, `.title`, `.rename`, `.icon`, `.tool`, `.icon-btn`, `.chip`, `.badge`, `.bone-chip`, ...); `<select>` appears in 14 files; native `confirm()` used in 3 places.
18. **Dead or vestigial**:
    - `Settings.exportFormat`, `Settings.boneNames` (workspace.ts:226-227,238-239).
    - `Stage.snapshot()` (Stage.ts:213-222) — no callers.
    - `viewer.loadError` (viewer.svelte.ts:23,82,94,193): written, never read, so a model that fails to load shows nothing.
    - `Character.skins`, `Mount.skin`, `Mount.gear`: in the data model, PATCH allow-list (api.ts:317), journal (journal.ts:109), and `tools/rig.ts` display, but no UI/engine code creates or applies them (0 of 31 characters).
    - `journal.record(..., extra)` param never used; `describe(null, ...)` -> 'created' never reached (`createCharacter` doesn't journal).
    - `job.kind` is never used by the UI; `JobsPopover` shows no per-kind affordances.
    - `inspect.py` returns `animated` (has_action) that the server ignores (api.ts:80).
    - `inspect.py --fingers` default `'two'` (inspect.py:27) vs app default `'full'` (api.ts:87) vs `Character.fingers` doc.
    - `kind === 'animation'` characters: Rig panel promises "Add it to the library from the Animate step" (RigPanel.svelte:135) but no such feature exists; the file has no `model.glb`, so the viewport is blank and the character is a dead end.
    - Legacy naming: `tempfile.mkdtemp(prefix='rigtool-')` (scene_io.py:37, extracted zips are never cleaned up); `README` calls the Rig step "Rig", etc.
    - `HistoryPanel` copy "for the agent, or yourself" bakes the CLI agent workflow into the UI.
19. **Two job-spawning paths for Blender inside api.ts** besides `enqueue` (the `fingers` route and `fit-template` call `runBlender`/`spawn` directly in the request handler, not as jobs, so they have no progress, can't be seen in the Jobs popover and aren't covered by the `/fit` busy guard).
20. **Resumption inconsistency**: `resumeInterrupted` re-inspects `importing` but silently demotes `rigging`->`ready` (no re-queue, no message) and runs only on the dev server (plugin.ts:9-13 vs 14-17).

---

## 8. Rough edges

### Bugs / risky behavior seen in code
1. **SSE reconnect does not resync characters** (app.svelte.ts:58-76). On reconnect only `hello` (jobs) is processed; any character changes while offline (server restart, laptop sleep) are lost until reload. `Offline` is shown, but nothing refetches.
2. **Re-import is dangerous and unguarded** (ImportPanel.svelte:106, api.ts:538-543): no confirm; runs `runInspect` without keepEdits, so joints and `rigReport` reset; sets `status='ready'` while `files.rigged` may still exist (viewer keeps showing the old rig because `fileFor` prefers `rigged`); for a rigged character this makes list/CTA say "Needs rig" while the rig file and animations remain; works while a rig job is running (no 409 as `/fit` has); failures are swallowed (`await api.reimport` with no catch, no toast, button never shows loading).
3. **Size is lost on re-import of rigged imports**: `inspect.py` applies `--scale`/`--ground` only for `kind=='mesh'` (inspect.py:60-64), so for imported rigs (`kind=='rigged'`) any later re-import or texture fill (which reruns inspect) reverts the model to its source size while `character.scale` and the scaled `joints/garments/lift` stay changed. The Import help text ("Later imports and rigs keep the size", ImportPanel.svelte:82-83) is therefore false for rigged imports.
4. **`/fit` rescales garment `position` with the floor offset `d` for every garment** (api.ts:566-575, `at()` adds `d`), though rigid garments' positions are relative to a bone socket; it also does not rescale `Mount.position`, `props[].position`, or `skins`. Worth verifying against engine/garments.ts semantics. The two GLBs are rewritten one after the other with no rollback; failures (e.g. "A scaled bone: not resized in place") occur only after the first has been written (api.ts:564 loop).
5. **Delete has no reference check**: deleting a horse another character mounts (`Mount.character`) or that a game unit references (`workspace/game/units.json`) leaves dangling references; deleting while a job is queued/running (server does not check; only the list checks `running`, and ImportPanel not at all) lets Blender write into a moved folder and then `failed()` -> `updateCharacter` throws "No character".
6. **Trash is write-only**: no UI to browse/restore/empty trash; recovery instructions in the confirm text require hand-moving a folder.
7. **`/files/*` serves the whole workspace** (api.ts:874-885) including `settings.json`, journals, sources, trash; only mitigated by binding 127.0.0.1. `/api/open` shells `xdg-open` (Linux-only) and accepts any path under the workspace. No auth/CSRF on any mutating route (a malicious web page can `fetch` `http://127.0.0.1:5180/api/...` with simple requests, e.g. DELETE/POST).
8. **Uploads are fully buffered** (`readBody`, up to 512 MB) and sent sequentially from the client with no progress UI; the id is the file's SHA-256 prefix, so re-dropping the same file silently returns the existing character with no "already imported" message, while the same bytes under a different file name create a duplicate.
9. **Duplicate-key crash potential** in HistoryPanel keyed `e.at + e.by + e.changes[0]` (HistoryPanel.svelte:53): two identical entries in one millisecond throw `each_key_duplicate`. It also refetches 300 entries on every `updatedAt` change (thumbnail uploads, weight painting) when open, and `showAll` isn't reset on character change.
10. **Settings popover saves on blur and Enter** (SettingsPopover.svelte:19): two toasts per Enter; saving fires even with no change; clicking outside to close can race the blur save. No path validation; `exportDir` is created lazily on first export.
11. **Rig error/status mismatch**: `app.rig` optimistically sets `status='rigging'` after the POST (app.svelte.ts:119-127) but the server sets it only when the queued job starts (api.ts:227); `Auto-rig all` toasts success count regardless of failures and runs POSTs serially.
12. **`resumeInterrupted`** only in dev (plugin.ts) and drops `rigging` state silently (see 7.20).
13. **`inspect` side effects hidden from the user**: `clean_materials` strips alpha links from every material (breaks hair cards, banners, wings, glass), `close_small_holes` welds/caps geometry on every import (alters vertex counts, which the painted-weight transfer later has to survive), and Tripo ZIPs are extracted into `/tmp/rigtool-*` and never deleted. None of this is surfaced or optional; warnings only mention floor/legs/arms.
14. **Garment import runs humanoid joint detection** because `inspect.py` treats any unrigged mesh as a character (api.ts:729 passes no flag to skip), wasting time and adding irrelevant warnings (inspect.py:73-88).
15. **Journal gaps**: Fit/resize journals only "joints moved" (no height, `scale` isn't described), import/reimport/rig-completion/texture jobs write nothing, and `status:` only appears if a PATCH happened to include a status change (it can't; `status` is not in the allow-list).
16. **`updateCharacter` read-modify-write per write** reads and rewrites the whole `character.json` (including all garments/clip keys) for each PATCH and each thumbnail; `listCharacters` reads all folders on each `GET /api/characters` (fine now at 31, linear later).
17. **Thumbnails are generated in the user's browser, serially, even for characters never opened**, loading each GLB into a second WebGL context + PMREM; a character whose GLB fails to load is retried only after `revision` changes; thumbnails for a character whose rig step changes appearance (rig, outfit, texture painting via `swapImages`) are not refreshed except where the server clears them.
18. **`Stage` uses `preserveDrawingBuffer: true`** and a 2048 shadow map for every frame (cost) while only snapshot (unused) needs the buffer.
19. **`Viewport` effect lists dependencies by hand** (`c.revision, status, props, garments, mount, outfit.fitting`, Viewport.svelte:36-46): any new field that should trigger `viewer.sync` must be remembered, and `viewer.sync` itself is async and re-entrant (guarded only by `loadedKey`/tokens).
20. **Model load failures are silent** (`viewer.loadError` unused), and `kind==='animation'` shows an empty stage with the "Drop a character to begin" hero hidden (because a character is selected).

### Confusing UI / naming / discoverability
- "Import" step panel mixes unrelated concerns: identity (name), classification, stats, size, errors, navigation and destructive actions; "Re-import" and "Delete" sit side by side with the main CTA.
- Terms drift: *Character*, *model*, *unit* (game), *mesh*, *rig*, *Rigsmith rig*; "Rigged" badge means both "imported with a rig" and "auto-rigged here"; list says `Rigged · custom` / `Rigged · N verts` and Import says `Auto-rigged` / `Rigged character`.
- The Import CTA for a rigged import says "Pick animations" even for non-Mixamo rigs that need mapping/conversion first (ImportPanel.svelte:100-101 vs RigPanel "Rigged elsewhere").
- Steps are all always clickable with no gating or prerequisite explanation (e.g. Animate on an unrigged mesh); only three steps ever show "done".
- Jobs chip conflates connection state ("Idle"/"Offline") with job activity; "Background jobs" tooltip but no way to cancel or retry; `ago` timestamps never update.
- Delete/rename affordances in the list are hover-only (invisible on touch/keyboard until focus); rename discoverable only by double-click or hover pencil.
- Settings popover looks like a settings page but holds one field; `gameRepo` (needed for Scale room/game export) is only configurable by hand-editing `workspace/settings.json`.
- Tooltips never appear for keyboard focus; many icon buttons rely solely on them.
- Left drawer/right drawer states are per-breakpoint and unpersisted; Escape closes drawers but not the marker board or edits at the same time (several independent window listeners).
- Toast kind `info` only used once; success toasts for routine saves (export folder) add noise.
- Empty-state copy: "Drop a dozen at once; they import in parallel" (CharacterList.svelte:70) — uploads are serial; only the Blender jobs run concurrently (3).
- Docs/README claim "Auto-rig all does a whole batch"; the button only appears when more than one is ready and has no progress summary.
- No global search/sort/filter in the character list (31 characters already); order is creation time only; no multi-select for batch actions other than Rig-all.
- No undo anywhere in this area (rename, resize in place, delete).

### TODO / legacy comments
No explicit TODO/FIXME in this scope. Legacy markers: `rigtool-` temp prefix (scene_io.py:37), `Character.rigReport.method:'import'` sentinel, `HANDOFF.md` notes that all rigging work was uncommitted at the time (now committed as `36f9295`), and the comment at api.ts:232-233 which is a leftover doubled doc-comment ("Rebuild the preview ..." followed by a different block comment) on `refreshOutputs`.

---

## Appendix: file index (line counts)
src/app: App 123, TopBar 151, CharacterList 181, Inspector 35, Viewport 208, Toasts 38, JobsPopover 55, SettingsPopover 29, HistoryPanel 81, DropOverlay 60, steps/ImportPanel 140. src/ui: Button 68, Popover 38, Section 25, Segmented 68, Toggle 44, tooltip 53, shortcuts 5. src/state: app 140, api 84, viewer 265, thumbnails 49. src/engine: Stage 231, CharacterView 223, ThumbnailRenderer 67, PreviewRenderer 123. server: workspace 340, api 915, jobs 148, journal 142, plugin 19, glbtransform 161. blender: jobs/inspect.py 103, common/{report 24, rigs 35, scene_io 313}.
