# Dressing, sets and the Forge: the plan

2026-11-06. Four read-only studies of the code (data model, speed and caches, UI, the Forge), merged. Builds on
docs/rebuild/DESIGN.md (binding) and docs/folk.md (the first dynamic character, `folk-v6-*`). The designer's ask: sets,
randomized pieces and characters organized; set-based animations; clothes texture swapping (shorts too); a visual
pipeline that pumps out gear; extremely snappy, QoL heavy, never a stale cache.

## What the studies found

- **Stale caches have one cause:** nothing knows when a file changed on disk. Each cache guesses from a document counter
  (`revision`, `look.at`, `thumbVersion`) or a constant: skins and clothes load at `?v=0` (gear.svelte.ts dress) and
  `folkview.ts` keeps them for the session, so a re-imported skin never shows; gear model URLs carry `revision`, so every
  rig or look change re-downloads every piece and leaks the old scenes; clip URLs carry no version at all; after a hot
  update the old `GearState` hooks stay registered (gear dressed twice: "only works after F5"); the export rewrites
  files in place (Godot can import half a file) even when unchanged.
- **Browsing is stored as edits.** Every outfit/skin flip and Randomize is a server command (`gear.outfit.show` rewrites
  `hidden` on up to 160 pieces), a journal entry and an undo step, and taking a set off and on re-skins its pieces.
- **The pick rules exist twice and disagree:** `folk.ts` (mulberry32) vs `UnitView.Folk.cs` (GodotHashInt, rules
  hand-coded): Rigsmith can't show the villager the game draws.
- **Shorts are impossible today:** each skin's albedo has clothes painted into the shirt and trouser areas, so a layer
  covering less shows painted trousers. Skins need bare versions.
- **Hot paths:** the coverage test (fixed: per-piece cache, Randomize 1.2 s -> 0.2 s), `computeWeights` per piece on
  the main thread, `syncAll` on any character's change (twice), whole-document copies and 178 KB SSE documents per
  command, a 2.2 MB character list on every reconnect, rendering every frame while idle.
- **The GPU has three gatekeepers that don't know each other:** skinopt's private queue, the Qwen paint route (no lock),
  gen_gear's nvidia-smi wait.

## Phase 0: the foundation (snappy, never stale)

1. **Content-addressed files.** `server/files.ts`: an index path -> {size, mtime, hash}, a recursive watcher on the
   workspace, an SSE `files` event; `/files/...?h=<hash>` served immutable. Client `state/assets.svelte.ts`: `asset(c,
   path)` replaces `fileUrl` and every `revision`/`look.at`/`?v=0` token. An LRU with a byte budget (`engine/lru.ts`)
   that disposes three.js objects replaces every cache Map; every manual `forget*` goes. A skin repainted in GIMP shows
   by itself.
2. **HMR:** a full reload for changes in src/state, src/engine, src/model (components keep hot updates).
3. **Dress state is view state.** `state/dress.svelte.ts`: per character {kind, set, skin, layers, hair, beard, locks,
   seed, unit #}, in localStorage; browsing and Randomize never touch the document, the journal or undo. "Make default"
   saves (the thumbnail and the game's unset look). Recent sets stay fitted (hidden, not taken off); the next sets and
   all skin images preload when idle.
4. **Derived data on disk:** each piece's skin weights and hidden regions computed once in a Web Worker, stored under
   `garments/<gid>/derived/<modelHash>-<bodyHash>-...`, read by the viewer and the export alike.
5. **Traffic and reactivity:** syncs narrowed to the character on stage; unchanged sections keep object identity across
   copies; SSE sends what changed, not the document; render on demand.
6. **Budgets kept by a harness:** `engine/perf.ts` timing marks + a long-task logger in dev; `npm run perf` (headless
   Chrome scenarios per step on a small fixture) failing on any task over 50 ms for a click, 150 ms for a first load;
   `vitest bench` on the hot functions. Export writes atomic and skips unchanged bytes.

## Phase 1: the model (schema 5)

`Character.folk = { sets, pools, kinds, stances }`, `look.clothes` -> cloth layers:
- **OutfitSet** {pieces, tags (culture:, period:, role:), grants (covers-hair, covers-face, bracers...), stance, weight}
  replaces `Gear.outfit`.
- **Pool** {kind: skin|cloth|hair|beard|accessory, slot, chance, requires/excludes, items with weights} replaces roles and
  swap sets.
- **UnitKind** {tags, sets (list or tag query), pools, stance}: villager, spearman, archer on the one body.
- **ClothLayer** {slots: bottom|top|over, file (alpha = coverage), cut (per-limb cut heights, dropped regions, a painted
  mask), trim (where the clan colour goes), shapes (long_sleeve...), tags}. Shorts = a bottoms layer cut above the knee.
- **One pick engine:** `engine/folkpick.ts`, an interpreter over data (`set -> skin -> bottom -> top -> over -> hair ->
  beard -> accessory`, tags accumulating, requires/excludes, weights, a salt per step so a villager who becomes a
  spearman keeps his face). The manifest carries the program and ~32 golden picks; the game's C# `FolkProgram` (~80
  lines) interprets the same data, and a test on each side reproduces the goldens. Rigsmith's "unit #1234" shows exactly
  what the game draws.
- Migration v4 -> v5 (pure, `character.v4.json` kept), commands `folk.set.*`, `folk.pool.*`, `folk.kind.*`,
  `folk.stance.*`, `look.cloth.*`, all undoable.

## Phase 2: the Wardrobe (UI)

- A Wardrobe drawer (the CatalogDrawer pattern): tabs Sets / Skins / Clothes / Hair / Beards / Pieces, search, filter
  chips (culture, category, body part, tag), thumbnails (rendered offscreen, cached in IndexedDB by content hash), hover
  to preview, click to pin, badges ("covers hair", "new" from the Forge).
- Swatch pickers instead of dropdowns, with the reason a choice is ruled out and a lock per slot through Randomize.
- **Crowd view:** 8/12/24 units dressed by the pick engine, the current clip playing out of phase; R re-rolls; A/B.
- **Coverage overlay** (H): each of the 28 regions hidden / partly covered (%) / bare; per-piece shares in the inspector.
- Pieces list: every piece by set, search, multi-select with bulk tags/move/hide-body (one undo), inline rename, drag
  into sets.
- Keys (`[ ]` set, `Shift+[ ]` skin, `, .` clothes, R, H, B, C, W, `?`), global Ctrl+Z, undo toasts, remembered view
  state per character, resizable panels.
- Sidebar tree: Characters -> Kinds / Sets (by culture) / Pools.

## Phase 3: clothes as swappable slots

Bare skins (a Look job: each skin's shirt and trouser zones repainted bare), the cut tools in Look -> Wardrobe (region
toggles, cut-height sliders, brush), "split into top + bottoms" for today's layers, coverage per region as data. Clothes
never hide body regions (only gear does), so a bare leg is never hidden. A set and a layer conflict automatically when
the layer's shape would poke through a piece (generalises "no long sleeves under bracers"). Body shape variants baked
only for combinations the rules can produce. Game: `folk.y` = top | bottom<<8 | over<<16, three samples, a per-layer
trim array for the clan colour (`folk_maps.py`, `unit_folk.gdshader`).

## Phase 4: the Forge

A top-bar mode beside the steps (it is about a set, not a character). Generic in Rigsmith; each game supplies
`forge.json` (stages, commands, VRAM, gates) and thin adapters (Emberhold `tools/forge/gear.py` etc. calling gen_gear's
functions with a work dir).
- **One GPU lane** (`jobs.ts gpuTurn`): Forge stages, skinopt and the Qwen paint all wait their turn; it frees ComfyUI's
  models before a non-ComfyUI job and shows why it waits. CPU jobs in parallel. Queue and attempts on disk; resumes after
  a restart; cancel kills the process group.
- **Attempts, never overwritten:** `<store>/<set>/<item>/<stage>/<attempt>/` with a manifest (input hashes, params, code
  hashes, outputs); a key from those hashes, so a stale stage is known (its input or its script changed), never guessed.
- **The board:** columns = stages, cards = items (an outfit splits into pieces at cut), thumbnails, attempts strip, live
  log. Gates: pick (N sheets), approve (pieces over the body), align (the Gear step), mask (paint where shorts end),
  spot-fix (the projection painter generalised to any GLB, repainting through local ComfyUI, Codex only behind a
  warning). Batch: "10 Gael hats" runs overnight to the first gate.
- **Publish:** into the game's paths and roster, `assets.sha256` refreshed (never committed), into the character as one
  undoable batch; replacing a piece keeps its placement.
- Stages: sheet (Qwen, N variants) -> prepare -> build (Hunyuan) -> cut -> fit -> finish -> align -> publish; accessories
  add clean (meshclean, which also bakes AO; solids only: it closes open shells); clothes: mask -> generate (MV-Adapter)
  -> cut -> publish; hair: split.

## Phase 5: set-based animations (stances)

A set names a stance; a stance maps the game's clips to slots (`Idle -> Idle@shield`, variants). Stance clips are
ordinary slots built on the base clip (schema 4 has it); the bake works on the character dressed in the set, so hands
close on the shield or spear; an optional overlay stage (e.g. the shield arm up). Exported as `<Clip>@<stance>`; the game
plays through a per-unit clip map. Motion gets a "dressed as" picker.

## Order

Phase 0 first (it is what makes it fast and ends stale caches, and the dress state is what the UI stands on), then 1,
then 2 and 4 side by side (different areas), then 3 (needs the game side), then 5.

## Open questions for the designer

1. Culture: a runtime input from the game, or fixed per unit kind?
2. Bare skins: a repainted bare albedo per skin, or one shared skin-tone fill?
3. Stances: baked into clips (more clips, no runtime cost) or a runtime layer?
4. Weapons and shields: part of a set or of the unit kind?
5. Sets shared across characters as a library now, or later?
6. The clan colour on each clothes layer's trims?
