# Rigsmith extend: the plan (binding for the lanes)

2026-11-06, base 75f07d7. Area docs (task detail: files, tests, e2e, acceptance): A-gear-dressing.md,
B-characters-classes.md, C-library-incoming.md, D-look-motion.md, E-foundation-cleanup.md in this folder. Board:
/hq/projects/dev/games/rigsmith-extend-agents/BLACKBOARD.md. Where this file and an area doc disagree, this file wins.

## Waves and lanes (3 lanes per wave; GPT-6.1 Terra; effort per lane)

| Wave | Lane | Tasks | Effort | Owns (beyond the task files in its area doc) |
|---|---|---|---|---|
| 1 | harness | E1 e2e harness, E2 list kit (SearchBox, Chips, Note), E3 dead-code purge; adds `classes`, `ship`, `wardrobe`, `pick` to `window.__rigsmith` (B's ask) | **max** (src/ui kit + main.ts used by all) | `src/ui/*` (testid props, new kit), `src/main.ts`, `tools/e2e.ts`, `tools/lib/chrome.ts`, `tools/lib/e2e_workspace.ts`, `tests/e2e/ui.ts`, `package.json` scripts, `CharacterList.svelte` testids only, `TopBar.svelte` testids only |
| 1 | gear | A1 the three regressions (failing e2e first), A2 visible features (Wardrobe/Crowd buttons, key chips, Gear-list search, ContextMenu), E4 one Randomize | **max** (gear/dress core) | `src/state/gear.svelte.ts`, `dressing.ts`, `dress.svelte.ts`, `src/engine/gearpick.ts`, `src/app/gear/*` (except CatalogDrawer), `GearPanel.svelte`, `Viewport.svelte`, `src/ui/ContextMenu.svelte` + `contextmenu.ts`, `ui/Button`/`IconButton` keys prop, `tests/perf/scenarios.ts` |
| 1 | library | C1 Forge UI out, C2 library index + uses API, C3 library state/view, C7 Incoming read side | xhigh | `server/library.ts`, `routes/library.ts`, `clipedits.ts`, `state/library.svelte.ts`, `app/motion/libraryView.ts`, `server/incoming/*`, `routes/incoming.ts`, `tools/incoming.ts`, `docs/incoming.md`; removes `src/app/forge/*`, `state/forge.svelte.ts`, the Forge chip in `TopBar`, its mount in `App.svelte`, the `forge.open` lines in `gear/keys.ts` (only those lines) |
| 2 | classes | B1 helpers + class state, B2 class edits, B3 Ship Class select, B4 sidebar tabs/search/sort/group, B5 Dynamic classes tab, B6 Class section | xhigh | `src/app/list.ts`, `src/model/classes.ts`, `state/classes.svelte.ts`, `app/classes/*`, `CharacterList.svelte`, `ClassList/ClassRow`, `app/gear/ClassSection.svelte` (one mount line in `GearPanel`), `UnitCard.svelte`, `ship/text.ts` |
| 2 | look | D1 image core, D2 Skins section, D3 Make bare, D8 stance editing | xhigh | `src/engine/clothcut.ts`, `look/Skins.svelte`, `state/bare.svelte.ts`, `workers/bare.worker.ts`, `server/routes/look.ts` (bare route), `commands/look.ts` (+types, additive), `LookPanel.svelte`, `model/stances.ts`, `motion/StancePicker`, `StanceSelect`, `state/stance.svelte.ts`, `SlotList`, `MotionPanel` |
| 2 | library-ui | C4 library UI (VirtualList, list view), C6 Catalog into the Wardrobe (Props tab), C8 Incoming accept | xhigh | `ui/VirtualList.svelte`, `LibraryDrawer`, `LibraryCard`, `LibraryRow`, `gear/PropsTab.svelte`, delete `CatalogDrawer`, `wardrobe.ts TABS`, `WardrobeDrawer`, `server/incoming/ingest.ts`, `uploadPiece` out of `routes/gear.ts`, `app.svelte.ts` Drawer type |
| 3 | sets | E6 panel splits first (GearPanel, FolkPanel: pure moves), A3 Sets section, A4 coverage view | **max** (restructures shared panels) | `GearPanel.svelte` → sections, `FolkPanel.svelte` → parts, `gear/SetsPanel`, `sets.ts`, `engine/coverage.ts`, `state/coverage.svelte.ts`, `CoveragePanel`, `garments.ts` (`Worn.hits` only) |
| 3 | clothes | D4 stage composition, D5 Clothes section, D6 all-skins sheet, D9 Dressed as | **max** (dress core + animator) | `folkview.ts`, `gear.svelte.ts dress()`, `dressing.ts`/`dress.svelte.ts` (`layers`, `bare`), `look/Clothes`, `ClothCutEditor`, `clothdraft`, `look/SkinSheet`, `OutfitThumbs.ts`, `motion/DressedAs`, `animator.svelte.ts` (signature, build) |
| 3 | incoming-ui | C9 Incoming UI, B7 class pools, E8 load stalls | xhigh | `state/incoming.svelte.ts`, `app/incoming/*`, `TopBar`/`App` mounts, `gear/keys.ts` (`I` only), `gear/ClassPools.svelte`, `Stage.ts`, `lighting.ts`, `viewer.svelte.ts` |
| 4 | export | D7 cut baked at export, D10 stance export, D11 UV brush mask | **max** (export) | `tools/lib/clothbake.ts`, `unit_export.ts`, `folk_export.ts`, events file, `look/CutMask.svelte`, `package.json` (`pngjs`) |
| 4 | preview | B8 class and culture in the preview (+ "Tag sets from names") | xhigh | `FolkPanel` parts, `wardrobe.svelte.ts`, `wardrobe.ts choicesFor` |
| 5 | legacy | E5 legacy-field retirement (a-d, schema 6), alone | **max** (migration) | everything that reads `Gear.outfit/role`, `look.clothes`; `types.ts`, `migrate.ts`, `engine/folk.ts`, `shot.ts` |

## Contracts (first owner posts them to the board as soon as they exist)

- **e2e (harness, W1):** `npm run e2e [-- --only=<name>]`; scenarios `tests/e2e/<area>.<feature>.scenario.ts`; the `ui` API
  and selector rules in E-foundation-cleanup.md §2.1-2.2 (role+name first, then `data-testid="<area>-<thing>"`, rows
  with `data-id`, state in aria/data attributes). Lanes in the same wave write scenarios against this contract; the
  controller runs them at integration.
- **Dress (gear, W1):** `Dress.off`, `dress.setShown`, `gearState.toggleShown`, `fitStart`/`cancelFit`, `pickGear`.
- **Kit (gear W1, harness W1):** `ContextMenu` + `use:contextMenu`, `Button keys=`, `SearchBox`, `Chips`, `Note`.
- **Library (library W1):** `GET /api/library/index?rig=`, `GET /api/library/uses`, `viewOf()`.
- **Incoming (library W1):** the manifest and folder contract in C-library-incoming.md §2.3, `docs/incoming.md`.
- **Classes (W2):** `kindsWearing(c, setId)`, `wardrobe.ctx(c)`, `classes.openClass`.
- **Look (W2):** `clothcut.ts`, `look.skin.update`, `PUT /api/characters/:id/look/bare/:skin`, `stances.ts`,
  `StanceSelect`.
- **Dressed layers (clothes W3):** `Dress.layers`, `Dress.bare` (the clothes lane owns the diff to dressing.ts in W3).

## Done per task

Each task's acceptance check and tests in its area doc, plus: tsc (app and tools), svelte-check, eslint on touched
files, and its e2e scenario file. The controller runs at integration: full vitest vs baseline, `npm run e2e`, `npm run
perf` vs baseline, screenshots of changed screens, migrate dry-run (schema touched), FolkProgram goldens (manifest
touched).

## Controller review (changes from the area docs)

- Claims checked against the code: GearList's restore effect and `listed` filter (`GearList.svelte:18-36`), `load()`
  clearing the selection (`gear.svelte.ts:177`), `setShown` writing the document (`:817`), legacy pick functions still
  used by `dressing.ts:11,99-115`, the three unreferenced engine files, the stage composing only `look.clothes`
  (`gear.svelte.ts:327`), the game picking a kind by def id (`UnitView.Folk.cs`). All hold.
- E7 and C1 were the same task: the library lane owns it. E4 (one Randomize) moved into the gear lane (it edits
  `dressing.ts`, which the gear lane owns in W1). B1's `window.__rigsmith` entries are added by the harness lane (it
  owns `main.ts`). The Viewport testid goes to the gear lane (it owns `Viewport.svelte` in W1).
- C5 (clip culture tags sidecar) is cut to a follow-up: no data yet, and the designer didn't ask.
- The handoff doc lives at /hq/projects/dev/games/emberhold/docs/GEAR_TOOL_HANDOFF.md (moved there).
- Decisions taken (board §4): `pngjs` as a devDependency; e2e workspace hard-links `library/` with an mtime guard, and
  any code writing into the library writes atomically (temp + rename, a new inode); hiding a folk piece is preview only
  and "Make default" doesn't save it; coverage % is the largest single piece's share in v1; a class id should be the
  game's unit id (Ship warns otherwise); E8 keeps only changes that measurably cut the worst task, and a smaller
  reflection map only if before/after screenshots match.
