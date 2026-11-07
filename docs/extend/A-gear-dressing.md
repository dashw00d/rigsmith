# Area A: Gear and dressing (plan, 2026-11-06)

Read-only analysis at 75f07d7. Nothing was run; findings are from reading the code, and the text says where reading can't prove the cause.

## 1. Current state

**Layout.** `GearPanel.svelte`: Gear (`GearList`), Dynamic character (`FolkPanel`), Pose, the piece's section, Handles, Weights. The Wardrobe drawer's Pieces tab holds `PiecesList`. `CrowdView` mounts at `App.svelte:120` on `wardrobe.crowdOpen`. Keys: `gear/keys.ts`. No context-menu component in `src/ui`.

**Dress versus document.** For a folk piece (member of a set, or hair/beard) the stage follows `dress.worn(c)` (view state, `dress.svelte.ts`) and `shows()` (`dressing.ts:86`). Only other pieces follow `hidden`. `gear.svelte.ts` `shownOnStage` (:163) and `showsOn` (:243) implement this.

### Regression 1: selecting pieces

- **Viewport click: no code exists.** In the Gear step nothing raycasts worn gear. Only Motion's `PoseEditor.pickGear` (`PoseEditor.ts:353`) does. `gear.svelte.ts` raycasts only for `startPicking` (spot/pull), and only on request. Fix: add a pick. Do not look for a break.
- **List rows (`GearList.svelte:54`, `PiecesList.svelte:40-50`): the click handlers read correctly.** `select()` (`gear.svelte.ts:563`) sets `selected`, and nothing visibly resets it. Suspects, in order:
  1. `load()` (`gear.svelte.ts:177`) clears `selected` whenever the loaded id differs from `lastId`; a viewer reload after the click would clear it.
  2. The restore effect (`GearList.svelte:20-33`) re-selects the stored piece for 4 s after mount, which also blocks deselecting.
  3. `listed` (`GearList.svelte:36`) drops off-stage folk pieces, so the clicked row may be gone.
  4. The Forge board (`App.svelte:128`) or `inert` panels (`App.svelte:115,125`) covering the list.

  **First task: write the failing e2e, then instrument `select`/`load` to find which. Do not guess a fix.**

### Regression 2: Shown does nothing

`GearList.svelte:67-70` and `GearPanel.svelte:147-148` call `setShown` (`gear.svelte.ts:817`), which writes `gear.update {hidden}` to the document. For a folk piece the stage ignores `hidden` (`shows()`, `dressing.ts:86-88`: membership in the worn outfit decides; `hidden` counts only for the document's own set). The command lands and the stage doesn't change. The toggle reads `piece.hidden`, not `shownOnStage`. And `GearList.svelte:36` drops off-stage folk rows, so a hidden piece can't be shown again from the list.

### Regression 3: Bind without Cancel

`GearPanel.svelte:165` (`gearState.fit(null)`) is the only exit besides leaving the step (`gear.svelte.ts:125-132`). Each edit while fitting is its own `gear.place`/`gear.origin` command; nothing remembers the start.

### Sets, coverage, hidden features

- Sets data and commands exist: `OutfitSet {id,name,pieces,tags,grants,weight,stance}` and `folk.set.add/update/pieces/duplicate/remove/reorder` (`command-types.ts:137-145`). Readers: `setsOf`, `setsWith`, `kindSets` (`model/folk.ts:85,96,111`). The UI is read-only: `PiecesList` "Move into…" calls `moveCommands`, and nothing renames or tags a set.
- Coverage is computed, not shown. `derive()` returns per-region `hits` (`workers/fit.ts:326`, `derive.ts:146`) but `garments.ts:579` keeps only `hiddenAt(...)` as `Worn.hidden`. Shares print only from `tools/dev/folk_regions.ts`. 28 regions on v6; `HIDE_SHARE` 0.97, `FACE_SHARE` 0.6.
- A Wardrobe button exists (`FolkPanel.svelte:104`); Crowd has none (`C` only). No key hints on buttons, search in the Wardrobe only, no right-click menus.

## 2. Architecture

**Dress gets a per-piece off list.** `Dress.off?: string[]` (gear ids hidden on stage). `shows()` returns false for an id in `off`. API: `dress.setShown(c, gearId, on)`. `wearOutfit` and `reset` clear `off`. Browsing stays view state (not a command, not undoable), as DESIGN says. `gearState.toggleShown(c, g)` routes: a folk piece to `dress.setShown`; any other piece to `gear.update hidden` (the export meaning). The Toggle and the eye both read `shownOnStage`. `GearList.listed` becomes "worn set's pieces + shown hair/beard + pieces in `off`", hidden ones dimmed, so a row never vanishes.

**Pick in the viewport.** `src/engine/gearpick.ts`: `pickGear(ray, wearer) -> gearId | null` over each shown piece's `worn.meshes`. `gearState.pickAt(event)` takes a click that moved under 4 px and missed the gizmo; an empty click deselects. Off during `picking`, `paint.active`, `placingOrigin`.

**Fit with Cancel.** `gearState.fitStart: {id, place, origin}` is recorded in `fit(id)`. `cancelFit()` writes one batch (`gear.place` + `gear.origin`, only if changed) and clears `fitting`. `Esc` is registered while fitting. Bind keeps the edits.

**Sets (src/app/gear/sets.ts, pure, tested).**
- `setsByCulture(c)`: groups by tag `culture:*`, then "no culture".
- `wornBy(c, set)`: the kinds whose `kindSets()` contains it (`UnitKind[]`).
- `grantChips`: `covers-hair`, `covers-face`, `bracers`, `heavy`.
- `addPiecesCommands(c, set, ids)`: `folk.set.pieces`, deduped, which regrants.

**Coverage.**
- `Worn.hits?: Int32Array` (per-region vertex counts), filled where `derived.hits` exists, and from `hiddenBy`'s cached counts (`garments.ts:355`) otherwise.
- `src/engine/coverage.ts`, `regionStates(pieces[{id, hits, share}], regionVertices) -> {region, state: 'hidden'|'partial'|'bare', pct, by: id[]}[]`. `pct` is the largest single piece's share. Two pieces covering half each read 50 %, not 100 % (stated in the legend).
- `src/state/coverage.svelte.ts`: `{on, hover}`, key `H`. The overlay is a body-clone skinned mesh with vertex colours (bare green, partial amber by %, hidden red) on the full index, so hidden regions stay visible.
- Region names: use the manifest's region classes (`docs/folk.md:63`) if present; otherwise the nearest bone to the region's centroid.

**Contracts other areas may use** (delivered in this order):
1. `src/ui/ContextMenu.svelte` + action `use:contextMenu={() => MenuItem[]}`, `MenuItem {label, keys?, danger?, disabled?, run, children?}`. B and C reuse it for sets, classes, library.
2. `Button`/`IconButton` prop `keys="dress.wardrobe"` (a registry id) renders the key chip (`keyLabel`, `shortcuts.ts:93`).
3. `wornBy(c, set)` and `classRef` (a kind id): B turns the chips into links to its Class section.
4. `dress.setShown`, `Dress.off`.
5. Test ids (e2e): `gear-row-<id>`, `gear-eye-<id>`, `fit-bind`, `fit-cancel`, `sets-row-<id>`, `set-grant-<name>`, `coverage-toggle`, `coverage-region-<n>`. A debug hook `window.__rs = {gear.selected, isWorn(id), dress.worn()}` comes from E, who owns the harness.

## 3. Plan

Four lanes: **A1 and A2 in wave 1**, A3 and A4 in wave 2 (they need A2's contracts).

**A1. Regressions (all three).**
- Files: `state/gear.svelte.ts`, `state/dressing.ts`, `state/dress.svelte.ts`, `engine/gearpick.ts`, `engine/Stage.ts`, `app/gear/GearList.svelte`, `app/steps/GearPanel.svelte`, `app/gear/keys.ts`.
- Steps:
  1. Failing e2e first. Find the list-row cause (see suspects above) and fix it.
  2. Viewport pick.
  3. `Dress.off` plus `toggleShown`.
  4. `fitStart` plus Cancel button plus Esc.
- Tests (vitest): `shows()` honours `off`, and `wearOutfit` clears it; `fitStart` restore produces exactly one batch; `pickGear` picks the nearest of two overlapping pieces.
- E2E `gear-regressions`:
  1. Click `gear-row-<id>`; assert `gear.selected` is the id and the panel title is its name.
  2. Click the same piece in the canvas (coordinates from `window.__rs`); assert the selection.
  3. Click `gear-eye-<id>`; assert `isWorn(id)` is false and the row stays (dimmed); click again; assert true.
  4. On a skin piece: "Place it", edit a field, click `fit-cancel`; assert the placement equals the start and `fitting` is null. Repeat with `fit-bind`; assert the edit is kept.
- Accept: `npm run e2e -- gear-regressions` green. The designer's three repros work on the real workspace.

**A2. Make hidden things visible.**
- Files: `ui/ContextMenu.svelte` (new), `ui/contextmenu.ts`, `ui/Button.svelte`, `ui/IconButton.svelte`, `app/gear/GearList.svelte`, `app/gear/PiecesList.svelte`, `app/steps/GearPanel.svelte`, `app/gear/FolkPanel.svelte`, `app/Viewport.svelte`, `app/gear/keys.ts`.
- Steps:
  1. A Wardrobe button in the Gear header (beside Catalog); the Dynamic character one stays.
  2. A Crowd toggle on the viewport toolbar (Gear, folk characters).
  3. Key chips on those buttons and on Frame (F) and Randomize.
  4. A `GearList` search (name, set, tag), shown above 6 pieces.
  5. Row menus: Select, Show/Hide, Rename, Add to set ▸, Tag…, Remove. Esc closes; Shift+F10 opens.
- Tests: vitest for the menu builder and list filter. E2E `gear-visible`: click `wardrobe-button`, assert the drawer; click `crowd-toggle`, assert the crowd canvas and chip "C"; type in search, assert the row count; right-click a row, choose "Hide", assert `isWorn` false.
- Accept: every button that has a key shows it; `npm run e2e -- gear-visible`.

**A3. Sets section.**
- Files: `app/gear/SetsPanel.svelte` (new), `app/gear/sets.ts` (new), `app/steps/GearPanel.svelte`, `GearList`/`PiecesList` (drag source).
- Steps: a Sets Section (folk characters) lists sets by culture. Each row: inline rename (`folk.set.update`), tag chips, grant toggles, piece count, "worn by" chips, a context menu (Duplicate, Delete with confirm), and a drop target that appends the piece (`folk.set.pieces`). Piece rows are draggable (`application/x-rigsmith-gear`); "Add to set ▸" in the row menu is the keyboard and e2e path.
- Tests: `sets.ts` units (grouping, `wornBy` for list and query kinds, add dedupes and regrants). E2E `gear-sets`: rename a set; tag `culture:gael` and assert the regroup; drop a piece (synthetic drag events) and assert `set.pieces`; toggle `covers-hair` and assert Randomize leaves hair null; assert the "worn by" chips equal the kinds.
- Accept: every edit undoes with Ctrl+Z.

**A4. Coverage view.**
- Files: `engine/garments.ts` (`Worn.hits`), `engine/coverage.ts` (new), `state/coverage.svelte.ts` (new), `app/gear/CoveragePanel.svelte` (new), `app/Viewport.svelte`, `app/steps/GearPanel.svelte`, `app/gear/keys.ts`.
- Steps: toolbar toggle "Coverage" (key H) paints the regions; a legend lists the 28 with %; the piece inspector gains a "Body hidden" list (per-region %, hidden marked); hovering a row highlights the region.
- Tests: `regionStates` units (thresholds, `FACE_SHARE`, max-not-union); `Worn.hits` against `folk_regions.ts` output for a fixture piece. E2E `gear-coverage`: click `coverage-toggle`; assert 28 `coverage-region-<n>` rows and that a helmet makes the head `hidden`; select boots and assert the foot row ≥ 97 %.
- Accept: percentages in the UI match the CLI for the same piece to ±1 %.

## 4. Files other areas will also touch

- `GearPanel.svelte`: B (Class section), D (pose/stances). Keep new sections as their own components, one line each, to limit conflicts.
- `FolkPanel.svelte`, `model/folk.ts`, `dressing.ts`: B (culture input, classes); I add only `off`.
- `Viewport.svelte`, `ui/Button`, `ui/IconButton`: E (cleanup); D (viewport tools).
- `gear.svelte.ts`: B/E (load speed).
- `garments.ts`, `workers/derive.ts`: E (load speed); I only add `Worn.hits`.
- `PiecesList.svelte`, `WardrobeDrawer.svelte`: C (Incoming "accept into a set").
- `keys.ts`: B (class keys).

## 5. Risks and open questions

- **List-row cause is unproven** (above). A1 may find it is one of the load-hook paths shared with E's load-speed work.
- **Shown semantics.** Hiding a folk piece through the dress is a preview and doesn't survive "Make default". Should "Make default" write `off` to the document? I'd say no (the document has no per-piece override in a set). Ask the designer.
- **Coverage is max-not-union.** Exact union needs the covered vertices (the 28-bit mask per piece is not enough). The cost is a second worker output; defer unless the numbers look wrong on boots + trousers.
- **Drag in headless Chrome** is unreliable; the menu path is the main e2e route.
- **Overlay cost:** one extra skinned draw; check `npm run perf`.
