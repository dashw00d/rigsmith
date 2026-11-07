# Area C: Library, Incoming, the Forge's removal

2026-11-06, base 75f07d7. Plan only. Binding: docs/rebuild/DESIGN.md.

## 1. Current state

- **Clip library** (`src/app/motion/LibraryDrawer.svelte`, `LibraryCard.svelte`, `src/state/library.svelte.ts`, `server/library.ts`, `server/routes/library.ts`): 2,467 manifest clips plus bundled and creature clips. The server filters by one category, one source, a query and a rig, sorts by relevance then name (`library.ts:226-230`) and pages 24 at a time (`library.svelte.ts:6`). No sort, group, loop/used filter or list view. Grid cards only, each with a sprite sheet. `Clip` (`library.ts:13-56`) has no addedAt, use count or culture; tags are motion words. Per-character use is `usesOf` (`rules.ts:86`); all characters' use is `clipUsage(id)`, one clip per call (`routes/edits.ts:28`).
- **Catalog** (`CatalogDrawer.svelte`): bundled props (`CATALOG`), a click adds gear. Opened from `GearPanel.svelte:94`.
- **Wardrobe** (`WardrobeDrawer.svelte`, `wardrobe.ts TABS`): a folk character's sets, skins, clothes, hair, beards, Pieces. Opened by `W` (`gear/keys.ts:58`), `FolkPanel.svelte:104`.
- All three re-implement the shell, search, chips and tiles. `Drawer` type `app.svelte.ts:33`; mounts `App.svelte:121-123`.
- **Forge UI**: `src/app/forge/*` (9 files), `src/state/forge.svelte.ts`, TopBar chip (`TopBar.svelte:8,87-91`), `App.svelte:11,32,128`, `gear/keys.ts:7,16,47`. It is the only listener of the `forge`/`gpu` SSE events.
- **Forge server**: `server/forge/*`, `server/routes/forge.ts`, `resumeForge` (`server/api.ts:24,74`). `server/jobs.ts gpuTurn` also serves the skin optimizer and Qwen paint.
- **Ingest today**: `POST /api/characters/:id/garments` (`routes/gear.ts:78`) queues a Blender import. Replacing a model while keeping placement is `gear.update {model}` after an upload of a temp piece (`forge/publish.ts:203-250`). Emberhold's `import_folk.py` writes skin/clothes PNGs straight into the character folder.

## 2. Architecture

### 2.1 Clip library
- `GET /api/library/index?rig=`: every clip for the rig as compact rows `{id,name,description?,category,source,rig,duration,loop,inPlace,tags,url,hash,addedAt,nameSource,problems?}` (~400 KB, cached by catalog mtime). `addedAt` is the clip file's mtime. The paged `/api/library` stays for scripts.
- `GET /api/library/uses` → `{clipId: nSlots}` in one pass over the characters (`clipedits.clipUseCounts`). Refreshed when the drawer opens and on `journalBeat`.
- `src/app/motion/libraryView.ts` (pure): `viewOf(index, uses, state) -> Row[]`, a Row being `{group,key,label,n}` or `{clip}`. State: `query`; `sort` name | length | recent | used (asc/desc; "best" while a query is typed); `group` none | category | source; filters `category[]`, `source[]`, `rig`, `loop` any|loop|oneshot, `inPlace`, `used` any|used|unused, `tags[]`; `view` grid|list; `collapsed`. View, sort and group persist in localStorage `rigsmith.library.view` (try/catch).
- `src/ui/VirtualList.svelte`: fixed row height, windowed on scrollTop; grid mode packs N cards per row from the container width. About 30 nodes for 2,500 clips. List rows are 30 px: name, category, length, loop, uses, round button. Hover/click previews on the character (`animator.playLibrary`); only grid cards build sprites.
- Rig filter is a select, default the character's template. Other-rig clips show the round button disabled with a reason.
- Culture: a clip tag `culture:<x>` from a sidecar `workspace/library/tags.json`; the control is hidden until one exists.

### 2.2 What each drawer is for
| Drawer | For | Step |
|---|---|---|
| Library | motions, per rig | Motion |
| **Wardrobe** | everything worn or held: Sets, Skins, Clothes, Hair, Beards, Pieces, **Props** (the Catalog) | Gear |
| **Incoming** (new) | parts delivered by the gear tool, not yet in a character | any |
| Activity | jobs, history | any |

The Catalog drawer goes: its body becomes `gear/PropsTab.svelte`. A non-folk character's Wardrobe shows only Props and Pieces. `Drawer` = `'library'|'wardrobe'|'incoming'|'activity'`. GearPanel's Catalog button opens Wardrobe on Props. Accepted parts show in Pieces with a "new" badge.

### 2.3 Incoming contract (the gear tool writes, Rigsmith reads)
- **Folder** `Settings.incomingDir` (default `<workspace>/incoming/`). The tool writes `.<id>.partial/`, `manifest.json` last, then renames to `<id>/`. Rigsmith ignores dot-names and folders without a manifest and never writes there. Its state: `<workspace>/incoming-state.json` `{ "<pkg>/<part>": {status:'accepted'|'rejected', sha, at, character?, gear?} }`, keyed by sha so a re-delivery reappears as pending.
- **manifest.json**:
```json
{ "schema": 1, "id": "norse_a-20261107-1", "at": "ISO", "tool": "gear-tool x.y", "space": "v6",
  "parts": [{ "id": "Outfit_norse_a_torso", "type": "piece|hair|beard|clothes|skin",
    "file": "parts/x.glb", "sha256": "…", "name": "Outfit_norse_a_torso",
    "from": "emberhold:gear/Outfit_norse_a_torso", "preview": "previews/x.png",
    "set": "norse_a", "policy": "upper|lower|head", "hideBody": true, "tags": ["covers-hair"],
    "role": "hair|beard", "swapSet": "hair", "hair": "#9a4a24", "slots": ["top"] }],
  "sets": [{ "id": "norse_a", "name": "Norse A", "pieces": ["Outfit_norse_a_torso"], "tags": ["culture:norse"] }] }
```
  Pieces/hair/beards are GLB; clothes/skins are RGBA PNG on the body's UVs. `from` is identity: the same `from` again is an update. `space: "v6"` = v6 metres, placed by `placementOf` (`forge/publish.ts:186`). Unknown fields ignored.
- **Validation** (`server/incoming/read.ts`): the path stays inside the package (no `..`, no symlinks), the file exists, sha256 matches, ≤ 200 MB, known `type`/`policy`. A bad part lists as "damaged: why".
- **API**: `GET /api/incoming?character=` → `{packages:[{id,at,tool,parts:[{…,status,effect:'new'|'update'|'same',damaged?}]}],pending}`; `POST /api/incoming/accept {package,parts[],character,set?,replace?:{part:gearId}}` → Job; `POST /api/incoming/{reject,restore} {package,parts[]}`; `GET /files/incoming/<pkg>/<path>` (read-only). SSE `incoming {pending}` from a debounced `fs.watch`; add `'incoming'` to `routes/characters.ts:127`.
- **Accept** (`server/incoming/ingest.ts`): piece/hair → `uploadPiece` (extracted from `routes/gear.ts:78`), wait for the import; a piece with the same `from` (or the chosen `replace`) gets `gear.update {model}` and the temp goes, so placement is kept; otherwise `gear.attach` skin, `gear.update {outfit,tags,role,swapSet,from}`, set add via `folk.set.*`. Clothes/skin → copy the PNG to `characters/<id>/clothes|skins/`, then `look.clothes.set`/`look.skins.set`. One command batch (one undo); `accepted` is written only after success. Targets are folk characters, default the selected one.
- **Top bar**: an Incoming chip with the pending-part count beside Activity.
- For the gear tool: `node tools/incoming.ts validate DIR` and `docs/incoming.md` (this contract).

### 2.4 Forge removal
- **Goes**: `src/app/forge/*`, `src/state/forge.svelte.ts`, the TopBar chip/import, `App.svelte` import, mount and header comment, `forge.open` in `gear/keys.ts:16,47`, the docs/features row.
- **Stays**: `server/forge/*`, `server/routes/forge.ts` and tests, `resumeForge`, `jobs.ts gpuTurn`/`gpuConfig`, the `forge`/`gpu` events (a waiting job already shows why in `job.message`), `Settings.comfyUrl`. The gear tool decides later; then `comfyUrl()`'s forge.json fallback (`routes/forge.ts:29`) moves.

## 3. Plan

Every UI task ships its e2e scenario (area E's harness, `aria-label` selectors).

| # | Task | Files | Needs | Tests / acceptance |
|---|---|---|---|---|
| C1 | Forge UI out (w1) | delete per §2.4; edit `TopBar`, `App`, `gear/keys.ts`, `docs/features.md` | – | e2e `forge-gone`: no "Forge" button, "Activity" present, `W` opens Wardrobe. Accept: `grep -rni forge src \| grep -vi forget` empty; `npx vitest run server/forge server/routes/forge.test.ts` passes; tsc, svelte-check clean. |
| C2 | Index + uses API (w1) | `server/library.ts`, `routes/library.ts`, `clipedits.ts`, `api.ts` | – | vitest `library.test.ts`: row shape, uses over two characters, addedAt. Accept: `curl /api/library/index?rig=human \| jq length` ≥ 2467, < 300 ms warm. |
| C3 | Library state + view (w1, with C2) | `motion/libraryView.ts` + test, rewrite `state/library.svelte.ts` | C2 | vitest: 4 sorts, 2 groups, every filter, query relevance; 2,500 rows < 10 ms. |
| C4 | Library UI (w2) | `ui/VirtualList.svelte` + test, `LibraryDrawer`, `LibraryCard`, new `LibraryRow` | C3 | e2e `library-organize`: count ≥ 2,400, DOM clip nodes < 80; "walk" narrows, first row matches; Length ↑ orders; Group Category shows headers, one collapses; Loops → all rows loop-marked; Unused → no use counts; List view rows 30 px; reload keeps view/sort/group. |
| C5 | Clip tags sidecar (w2, optional) | `server/library.ts` merge, `PUT /api/library/tags/:id`, row menu "Tag…" | C2 | vitest merge; e2e: tag `culture:norse` → Culture chip appears and filters. |
| C6 | Catalog into Wardrobe (w2, after A's wardrobe work lands) | `gear/PropsTab.svelte`, delete `CatalogDrawer`, `wardrobe.ts TABS`, `WardrobeDrawer`, `GearPanel:94`, `app.svelte.ts`, `App:122` | A | vitest TABS folk/non-folk; e2e `props-tab`: non-folk rigged character → Catalog button opens Wardrobe on Props; click a prop → gear row appears. |
| C7 | Incoming read side (w1) | `server/incoming/{read,state,watch,fixture}.ts`, `routes/incoming.ts`, `server/api.ts`, `routes/characters.ts:127`, `tools/incoming.ts`, `docs/incoming.md` | – | vitest: valid package; `.partial`/no-manifest ignored; bad sha, `..`, unknown schema → damaged; reject/restore persist; SSE on new folder. Accept: `node tools/incoming.ts validate <fixture>` prints OK. |
| C8 | Incoming accept (w2) | `server/incoming/ingest.ts`, `uploadPiece` out of `routes/gear.ts`, routes, `api.ts` | C7 | vitest (fake import, as `forge/publish.test.ts`): add (attach, set, tags, one undo), update keeps `attach.place`, PNG copied, failed import stays pending. Accept: fixture accept on a copy workspace journals `gear.update`. |
| C9 | Incoming UI (w3) | `state/incoming.svelte.ts`, `app/incoming/{IncomingDrawer,PartCard}.svelte`, `TopBar`, `App`, `app.svelte.ts`, `gear/keys.ts` (`I`) | C6–C8 | e2e `incoming`: seed fixture (new, update, damaged) → badge 3; cards per package with New/Update/Damaged tags and previews; accept the update → toast, `attach.place` equal before/after, badge 2, Pieces shows it "new"; reject the new → badge 1; Restore brings it back. |

Waves: 1 = C1, C2+C3, C7; 2 = C4, C8, C6; 3 = C9.

## 4. Shared files
- `App.svelte`, `TopBar.svelte`, `app.svelte.ts`, `api.ts`: shared with A, B, E. C edits the Drawer type and one-line mounts only.
- A: `WardrobeDrawer`, `wardrobe.ts`, `GearPanel`, `FolkPanel`, `gear/keys.ts`, `routes/gear.ts`. E: `routes/characters.ts`, harness, `package.json`. D: `MotionPanel`, `LibraryCard`, `animator.svelte.ts`; stance clips `<Clip>@<stance>` must group under their base in the index.
- C offers: the index row shape, the manifest, `uploadPiece(id, bytes, name, from)`, the fixture. C needs: E's harness API and port handling; A's final `Gear` fields.

## 5. Risks and open questions
1. Culture on clips has no data. Sidecar tags (C5) or derive from classes (needs B)? Designer's call.
2. "Recent" is file mtime, identical for the Mixamo batch: useful only for made/bundled clips.
3. Placement needs the v6 body GLB via `Settings.gameRepo`; if missing, use the placement of worn pieces (`publish.ts:195`) or refuse clearly.
4. Accept is slow (Blender per piece, a job). A restart mid-accept leaves the part pending and a temp piece; retry cleans it by name.
5. C6 touches A's files; if A is mid-change, ship it last or keep `CatalogDrawer` and share only the tile component.
6. The `gpu` event loses its listener; the Activity owner adds one if lane position is wanted.
