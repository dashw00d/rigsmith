# Area E: foundation (e2e harness, app cleanup, load speed)

2026-11-06. Plan only; read-only study at 75f07d7. Perf baseline was not yet in `baseline/` when written, so load numbers are from the brief.

## 1. Current state

**E2E.** Only `npm run perf` drives the UI (`tools/perf.ts` starts Vite in-process on 5190; `tools/lib/profile.ts` runs `tests/perf/scenarios.ts` through `window.__rigsmith`, `src/main.ts:11-19`: app, gear, animator, viewer, dress, assets, perf). `tools/lib/chrome.ts:withChrome` gives `navigate/value/until/console` over CDP; no click, type, screenshot, viewport or uncaught-exception capture. `perf` copies no workspace. **Zero `data-testid`**; ~180 `aria-label`/`role` uses. `src/ui/{Select,Toggle,TextField,NumberField,Segmented,Tabs,Field,Section,Drawer}.svelte` do not forward rest props (only `Button`/`IconButton` do). `tests/perf/scenarios.ts:23` calls `r.dress.randomize`, which is the *old* path (see 2.2), not what the R key runs.

**Workspace size.** `ws-base` is 2.2 GB (characters 66 + 349 MB; `library/sources` 1.4 GB, `clips` 242 MB); ext4, no reflink.

**Duplicates and dead code (evidence):**
- `src/engine/folk.ts:39-80` deprecated `fits/coversHair/coversFace/hasBracers/clothesFor/pickFolk` are **still live**: `src/state/dressing.ts:11,100-112` (`wearOutfit`, `randomize`) and `tools/lib/migrate_check.ts:302` use them. Tests `folk.test.ts`, `folkpick.test.ts:116-118` pin them as the old oracle.
- Two Randomize paths: `dress.svelte.ts:108` → `dressing.randomize` (old `pickFolk`, reads `look.clothes`); `wardrobe.svelte.ts:140` → `folkpick.pick` (the R key, the button). Only the second is the game's.
- Legacy fields `Gear.outfit/role`, `look.clothes`: ~106 uses in 31 files, kept in step by `syncLegacyPiece/Clothes/Skins` (`src/model/folk.ts:183,252,266`, called from `commands/gear.ts:274,351`, `commands/look.ts:49,100`). Readers still on legacy: `dressing.ts:69-112`, `dress.svelte.ts:165`, `GearList`, `GearPanel.svelte:120`, `gear.svelte.ts:327`, `thumbs.svelte.ts:114`, `crowd.ts:182`, `OutfitThumbs.ts:72`, `shot.ts` (sends `x-rigsmith-schema: 4`), `ship.svelte.ts`, `UnitCard`, `tools/rig.ts`.
- Unreferenced: `src/engine/surface-contacts.ts` (202 lines; only `contact-bvh.ts`'s test uses `contact-bvh`), `src/engine/vendor/ViewHelper.ts` (tsconfig-excluded), `presets/automap/Mesh2MotionMapper.ts` (11 lines). `src/engine/workers/fit.reference.ts` (300 lines, test-only oracle for `fit.test.ts`) lives in `src`.
- Four drawers share `ui/Drawer` but each re-implements search (`WardrobeDrawer:64`, `LibraryDrawer:82`, `PiecesList`, `CharacterList`) and chips; `app.drawer`/`DRAWER_STEP` (`app.svelte.ts:33-35`) is a fixed union.
- Panels: `Section` is used 50 times, but `<details>` and `.note`/`.error` CSS (6 copies each) diverge. `GearPanel` (205) mixes adding, list, pose, piece, handles, weights; `FolkPanel` (225) mixes swatch rows, unit #, locks. Areas A/B/D all grow these next. Big: `gear.svelte.ts` 1117, `pose.svelte.ts` 1278, `Timeline.svelte` 808.
- Forge UI: `src/app/forge/*` (7 comps, 2 ts), `state/forge.svelte.ts`, `App.svelte:11,32,128`, `TopBar.svelte` button. Server `server/forge/*` (2540 lines with tests) stays.

**Load stalls.** `Stage` constructor (`Stage.ts:24-36`): `new WebGLRenderer({antialias})`, then `light()` → `environment()` (`lighting.ts:36-45`): PMREM `fromScene(RoomEnvironment, 0.04)` at default size 256, synchronously, shadow-casting key light (`lighting.ts:57-62`, 2048² map). `resize()` → first `setSize` (`Stage.ts:149`) allocates the MSAA drawing buffer. Viewer already `compileAsync`s the character (`viewer.svelte.ts:307`, `gear.svelte.ts:1064`), but three's `compile` does not build shadow-depth programs (chosen at render time in `WebGLShadowMap`), so the first frame with a skinned/morph caster compiles depth variants on the main thread. Every extra renderer (`offscreen`, `Crowd`, MarkerBoard, ScaleRoom) repeats PMREM. three 0.185 has no `fromSceneAsync`; `fromScene(..., {size})` exists.

## 2. Architecture

### 2.1 E2E harness (contract for all areas)

`npm run e2e [-- --only=<name> --keep]` → `node tools/e2e.ts`.
- **Own server.** Starts Vite in-process (as perf does) on a free port (`net.listen(0)`, never 5180/5181/5190), against a **throwaway workspace**: `tools/lib/e2e_workspace.ts` copies `$RIGSMITH_WORKSPACE` selectively into `os.tmpdir()`: `settings.json`, `game/`, the characters named by `E2E_CHARACTERS` (default: the first folk character and one non-folk), and `library/` with only `clips/`, `creatures/`, `manifest.json`, `meta/` hard-linked (`cp -al`), never `sources/`, `cache/`. The harness fails if a hard-linked library file's mtime changed. Removed on exit unless `--keep`.
- **Chrome.** Additive changes to `tools/lib/chrome.ts` (owned by E): `Page.click(x,y)`, `type`, `key`, `screenshot(path)`, `setViewport(w,h)`, `Runtime.exceptionThrown` + `console.error` capture. A scenario fails on any uncaught exception or console error unless it sets `allowErrors`.
- **Scenarios** are files `tests/e2e/<area>.<name>.scenario.ts`, default export `{ name, character?, step?, run(ui) }`. Each runs in a fresh page (localStorage cleared, selected character and step set), 1280×800.
- **`ui` API** (`tests/e2e/ui.ts`): `ui.click(sel)`, `ui.fill(sel, text)`, `ui.key('Escape')`, `ui.press('ctrl+z')`, `ui.exists/text/count(sel)`, `ui.waitFor(sel|fn, ms)`, `ui.app()` / `ui.eval(fn)` (the `window.__rigsmith` hook: `app`, `gear`, `dress`, `viewer`, …), `ui.shot('label')`. `sel` is `{testid}` | `{role, name}` | `{testid, within}`; role/name resolve through CDP `Accessibility.queryAXTree`.
- **Output.** `ok/FAIL <scenario> (ms)` with the failing assertion and the console log; PNGs in `.work/e2e/<run>/<scenario>-<label>.png`; exit 0 only if all pass; 90 s per scenario, 10 min total.
- **State assertions** read the hook, never CSS: `gear.selected`, `app.selected.gear[i].hidden`, `dress.worn(c)`, a mesh's visibility in `viewer.character`. New hook entries go only in `src/main.ts` (dev-only).

### 2.2 Selector convention (areas must follow)

1. Prefer role + accessible name for ordinary controls (buttons, inputs, tabs).
2. `data-testid="<area>-<thing>"`, lowercase kebab, for anything repeated, icon-only, canvas-adjacent or likely to be renamed. Areas: `bar`, `chars`, `viewport`, `gear`, `sets`, `class`, `look`, `clothes`, `motion`, `ship`, `lib`, `wardrobe`, `incoming`, `activity`, `dlg`, `toast`.
3. Repeated rows: same testid on every row plus `data-id="<stable id>"` (`gear-row`, `chars-row`, `sets-row`). State in attributes (`aria-pressed`, `aria-selected`, `aria-current`, `aria-expanded`, `data-hidden="true"`), never class names.
4. Kit components take a `testid` prop and render `data-testid` on the *interactive element* (`Select`, `Toggle`, `TextField`, `NumberField`, `Segmented`, `Tabs`, `Drawer` root, `Section` root as `section-<slug of title>`); `Button`/`IconButton` already spread.
5. Every drawer root: `<area>-drawer`; every dialog: `dlg-<name>` with `dlg-confirm`/`dlg-cancel`.
6. Each UI task adds its testids in the same commit and ships `tests/e2e/<area>.<feature>.scenario.ts`.

### 2.3 Cleanup targets

Delete: Forge UI client, 3 unreferenced engine files; move `fit.reference.ts` to `tests/support/`. Merge: both Randomize paths into `wardrobe.randomize`. Port legacy readers to `model/folk.ts` (`setsOf`, `poolsOf`, `clothOf`): readers, writers, fields, migration kept. Split GearPanel and FolkPanel. Consolidate `ui/SearchBox`, `Chips`, `Note`.

## 3. Plan

Each task is one lane, one wave; leaves `tsc`, `svelte-check`, eslint and the touched tests green.

**E1: e2e harness (wave 1, first; others' acceptance depends on it).**
Files: `tools/e2e.ts`, `tools/lib/e2e_workspace.ts`, `tools/lib/chrome.ts` (additive), `tests/e2e/{ui.ts,README.md,smoke.*.scenario.ts}`, `package.json`, `tools/tsconfig.json`, `src/ui/*.svelte` (`testid` prop only), `TopBar` (`bar-step-<id>`, `bar-activity`), `CharacterList` (`chars-row`+`data-id`, `chars-search`), `Viewport` (`viewport-canvas`). Depends: none. Contract: 2.1/2.2, posted to the board once the API compiles. Tests: vitest for the selector helper and workspace copier; scenarios `smoke.steps` (click each of 7 steps, `app.step` matches, no console error), `smoke.select` (pick the other character, `viewer.shownId` matches), `smoke.gear-select` (click a gear row → `gear.selected`). Acceptance: `RIGSMITH_WORKSPACE=<ws-base> npm run e2e` prints 3 ok, exit 0, 3+ PNGs, < 3 min, never port 5180/5181/5190, source `characters/` unchanged; a deliberately wrong selector exits 1 and names near candidates.

**E2: shared list kit (wave 1, parallel with E1's end).** Files: `src/ui/SearchBox.svelte`, `Chips.svelte`, `Note.svelte` (+ vitest-less; used by A/C). Depends E1 testid rule. Tests: e2e `ui.searchbox` (`chars-search` filters by name). Acceptance: `npm run e2e -- --only=ui.searchbox`. Collision: C, A (their searches use it).

**E3: dead-code purge, low risk (wave 1).** Delete `surface-contacts.ts` + `contact-bvh.*` (grep `tools/`, Python first), `vendor/ViewHelper.ts` + its tsconfig exclude, `Mesh2MotionMapper.ts`; move `fit.reference.ts` to `tests/support/`. Acceptance: `tsc`, `tsc -p tools`, `vitest run src/engine/workers`. No collisions.

**E4: one Randomize, one pick (wave 1, after E1).** Files: `dress.svelte.ts`, `dressing.ts` (+ tests), `scenarios.ts`. Make `dressing.wearOutfit` take grants from `model/folk.ts` (`grantsOf`) instead of `coversHair/Face`; repoint perf's Randomize to `wardrobe.randomize`. Tests: `dressing.test.ts`, `wardrobe.test.ts`; e2e `dress.randomize` (R changes unit #, a locked slot stays). Acceptance: both vitest files + `npm run perf -- --only=Randomize` in budget. **Collides with A**: land A's wave 1 first, or run E4 in wave 2.

**E5: legacy-field retirement (wave 2/3; needs A and D stable).** Steps, each separate commit: (a) every reader to `folk.ts` accessors (list above); (b) UI writers stop using `Gear.outfit/role`/`look.clothes` commands; (c) delete `engine/folk.ts` deprecated functions and `folk.test.ts` oracle (keep `folkpick.test.ts` goldens from `migrate_check`'s v4 data); (d) schema 6 drops the fields in `migrate.ts` (v5 file kept as `character.v5.json`), `syncLegacy*` removed. Acceptance each step: `npx vitest run src/model src/engine/folk*`, migrate dry-run equals baseline, FolkProgram golden passes. Collides with A, B, D and `types.ts`: last, alone in its wave.

**E6: panel splits (first Gear-panel commit of wave 2).** GearPanel → `GearSection`, `PieceSection`, `PoseSection` (pure moves); FolkPanel → `SwatchRow`, `UnitBar`; `Section` gets `testid`. Acceptance: svelte-check + e2e `smoke.gear-select` + perf Gear scenarios unchanged. **Collides with A/B/D.**

**E7: Forge client removal (wave 1, owned by C; listed for order).** Remove `src/app/forge/*`, `forge.svelte.ts`, the `TopBar` button, `App.svelte` mounts; keep `server/forge`. Acceptance: `smoke.steps` green; no `forge` import in `src/`.

**E8: load stalls (wave 1, after E1; touches `lighting.ts`, `Stage.ts`, `viewer.svelte.ts`).** Measure first: `mark()` spans `stage.renderer`, `stage.env`, `stage.setSize`, `view.compile`, `frame.first`, run with `--cpu`. Then, by expected win, each kept only if the worst task drops: (1) PMREM at `{size:128}` and `sigma` unchanged, compare screenshots; (2) `Stage.create()` async: renderer, yield, environment, yield, then ready; the viewer's first `request` awaits it, so `scene.environment` is set before any compile (setting it later would recompile every material); (3) warm shadow-depth programs: render a tiny dummy skinned+morph caster to a 1×1 target with the key light before the first character, so depth variants exist; (4) defer `thumbnails.ensure` to idle; (5) character switch (0.2-0.4 s): compile the *next* character's view when idle, so its programs are cached. Acceptance: `RIGSMITH_WORKSPACE=<ws> npm run perf` — `first load` worst task < 150 ms or at least 40 % under baseline, `another character and back` no worse; dressing scenarios unchanged; before/after screenshots look the same.

## 4. Risks and open questions

- SwiftShader is slow and noisy: e2e asserts state, screenshots are for review; perf is judged against baseline.
- Hard-linked `library/` is safe only if the app never writes in place; C's library metadata and Incoming write there. Alternative: full copy (+1.4 GB). Controller decision.
- Collisions: `dressing.ts`/`folk.ts` (A, E4, E5); Gear/Folk panels (A, B, D, E6); `App.svelte`/`TopBar` (C, E1, E7); `types.ts`/`migrate.ts` (B, D, E5); `viewer.svelte.ts` (D, E8); `ui/*` (all).
- `src/shot/shot.ts` uses legacy fields and schema 4; `tools/rig.ts shot` needs it: port to `dress` state with E5.
- Open: SwiftShader may overstate shadow-compile cost (skip E8 step 3 if a real GPU shows none?); is a smaller reflection map visually acceptable to the designer?
