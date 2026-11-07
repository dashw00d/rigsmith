# Area D: Look (clothes, skins, shorts) and Motion (stances)

Plan only, base 75f07d7.

## 1. Current state

- **Look step** (`LookPanel.svelte:40-64`): Layers, Holes, Projection painting. No skins or cloth layers.
- **Data and commands exist.** `look.cloth.add|update|remove|reorder`, `look.skin.bare` (`commands/look.ts:52-85`); `folk.stance.add|update|clip|remove` (`commands/folk.ts:465-500`). Types: `Skin.bare`, `ClothLayer`, `ClothCut` (`types.ts:461-471, 586-612`), `Stance` (`:576`: game clip → slot ids, `overlay`), `OutfitSet.stance`, `UnitKind.stance`.
- **Stage ignores cloth layers.** `gear.svelte.ts:324-335` and `folkview.ts:45-91` composite only legacy `look.clothes`. `dressing.ts:30` `DressField` has no layers or stance; Randomize still uses legacy `pickFolk` (`:115`), not `folkpick`.
- **The cut is data only.** `unit_export.ts:1170-1195` copies `cut.mask` and `trim`; `folk_export.ts:156-160` writes `cut` to the manifest. Nothing applies `below`/`drop` in viewer or export. Bare skins are copied (`:1183`), nothing makes one.
- **Skins**: only replaced wholesale (`look.skins.set`); no rename/tags/hair command or UI.
- **Stances** are read nowhere but the manifest (`folk_export.ts:178`). `MotionPanel.svelte:134-141` has no stance or dressed-as control.
- **Bake**: `animator.build` (`animator.svelte.ts:489-514`) and the export (`unit_export.ts:93-94`) bake on the document's gear. Hands close through `handLayers` → `carriedBy` (`hands.ts:55-68`; hidden gear skipped). Nothing bakes the character wearing a set.
- **No PNG decoder in Node.**

## 2. Architecture

### 2.1 Image core `src/engine/clothcut.ts` (pure typed arrays; viewer, sheet, Make bare and export all call it)
- `bodyField(geometry, regions, height, size)` → `{region: Int16Array, y: Float32Array}`: rasterises the body's UV triangles; `y` in body heights, soles 0 (the unit of `cut.below.y`). Cached by `bodyKey`.
- `cutAlpha(rgba, w, h, field, cut, maskRgba?)`: `below` = alpha × smoothstep over `y±feather` on those regions; `drop` = 0; `mask` = × luminance.
- `composeCloth({base, layers})`: draws bottom, top, over (a two-slot layer once, at its first slot, as the packing says).
- `limbGroups(regions.list)`: "left leg", "right sleeve"… by material class and centre-x. `skinTone` = median of face/neck/hand texels; `makeBare` fills shirt and trouser texels with it and dilates 2 px past seams.

### 2.2 Dress state (view only, never a command)
`Dress`/`Dressed` gain `layers: Partial<Record<ClothSlot, string|null>>` (null = the skin's painted look) and `bare` (preview on the bare skin). Randomize reads layers from `folkpick.pick`. Legacy `clothing` stays until A retires it.

### 2.3 Stances `src/model/stances.ts` (pure)
- `stanceOf(c, setId)` = set.stance ?? the first kind listing the set → kind.stance.
- `clipSlots(c, stanceId|null, clip)` = `stance.clips[clip]` else the base slot and its variants.
- `dressedCharacter(c, setId|null)` = copy with gear `hidden` following the set (its pieces shown, other sets' hidden, always-worn gear untouched).
- "Dressed as" is the Gear step's view-state outfit (`dress.wearOutfit`). The animator bakes `dressedCharacter(...)` and adds the set to its signature (`animator.svelte.ts:247`).
- Export: `<Clip>@<stance.id>` (variants `<Clip>_2@<id>`), baked on the first set naming the stance. Sets sharing a stance must hold the same bone-attached piece ids, else the export fails naming them. A clip a stance doesn't override isn't exported for it; the game falls back to `<Clip>`.
- `Stance.overlay`: its keyed bones' tracks replace the same bones' on each stance clip (v1). Events file gains `stances: {id: {Clip: [names]}}`.

### 2.4 Cut at export
Bake the cut alpha into the exported layer PNG (`clothes/<name>.png`), keep `cut` in the manifest with `baked: true`, ship `skins[].bare`. Today's game shader works unchanged. Node file IO needs `pngjs` (devDependency).

### 2.5 Contracts for other areas
- Pure `clothcut.ts`, `stances.ts` (A: crowd/thumbnails; B: Ship checks).
- Command `look.skin.update {name, patch:{name?,tags?,hair?}}`; a rename rewrites pool refs, `look.skin` and `bare` in one undo.
- Route `PUT /api/characters/:id/look/bare/:skin` (PNG → `skins/bare/<safeName>.png`, atomic; returns the path).
- `ThumbSpec.layers`; component `StanceSelect.svelte` (A's Sets section embeds it for `OutfitSet.stance`).

## 3. Plan

Waves: W1 D1, D2, D8 · W2 D3, D4, D9 · W3 D5, D7, D10 · W4 D6, D11. Each UI task ships `tests/e2e/<task>.ts` on E's harness: it clicks the real UI, asserts via `window.__rigsmith`, and samples texels of the stage body texture (`mesh.material.map.image` drawn to a canvas).

**D1 Image core** (new `clothcut.ts` + test). No deps. Test: synthetic two-region body, real v6 body if fixtures allow; feather monotonic; `makeBare` leaves face texels alone. Acceptance: `npx vitest run src/engine/clothcut`.

**D2 Skins section** (new `look/Skins.svelte`, `commands/look.ts`, `command-types.ts`, `LookPanel.svelte`). Rows: thumbnail, name input, tag chips (female, beardless, elderly, custom), hair colour input. Vitest: rename rewrites pool refs and `look.skin`, bad hair rejected, undo. E2E: rename skin 1, toggle `female`, set hair; assert `c.look.skins[0]`, the Gear swatch shows the new name, Ctrl+Z restores. Acceptance: `npx vitest run src/model/commands.folk` + scenario.

**D3 Make bare** (new `state/bare.svelte.ts`, `workers/bare.worker.ts`, `server/routes/look.ts`, button in `Skins.svelte`). Needs D1, D2. Per skin and "Make all" with progress; in a worker so no main-thread task passes 50 ms. Then `look.skin.bare`. Vitest: route atomic, rejects non-PNG; undo drops the reference, keeps the file. E2E: click Make bare on skin 1, wait for the Bare badge, fetch the file, trouser texel within ±8 of face tone, face texel unchanged. Acceptance: `npx vitest run server/routes/look` + scenario.

**D4 Stage composition** (`folkview.ts` → `showDressed`, `gear.svelte.ts dress()`, `dressing.ts`, `dress.svelte.ts`). Needs D1; A edits the same files, so sequence after A's merge or agree the `Dressed.layers` diff first. Base = bare skin when a worn layer has a cut (no bare: painted skin plus a warning); cache key includes the cut hash. Vitest: compose vs reference arrays; `resolve` keeps layers. E2E: wear "Shorts" through the dress API; thigh texel = layer colour, shin = bare tone. Acceptance: `npx vitest run src/state/dressing src/engine/clothcut`.

**D5 Clothes section** (new `look/Clothes.svelte`, `ClothCutEditor.svelte`, `state/clothdraft.svelte.ts`, `LookPanel.svelte`). Needs D1, D4. Per layer: name, slot chips (≥1 on), up/down (`look.cloth.reorder`), remove, "Duplicate as shorts / short sleeves" (`look.cloth.add`, same file, preset cut), per-limb height sliders from `limbGroups`, feather, dropped-region toggles, trim-mask view. A drag edits a draft; release commits one `look.cloth.update`. E2E: duplicate "Trousers" as shorts, legs 0.35; assert `cut.below[0].y≈0.35`, shin texel bare, Ctrl+Z removes the layer.

**D6 All-skins contact sheet** (new `look/SkinSheet.svelte` overlay, `OutfitThumbs.ts`). Needs D4. One tile per skin (24 on v6), rendered idle in sequence; click sets the browsing skin. E2E: tile count = skin count, ≥2 distinct tile hashes, click tile 5 → `dress.worn(c).skin` is skin 5. `npm run perf` stays at budget.

**D7 Export bake of the cut** (new `tools/lib/clothbake.ts`, `unit_export.ts folkManifest`, `folk_export.ts`, `package.json`). Needs D1. Byte-equal with the viewer's `cutAlpha`; unchanged files skipped. Vitest: exported alpha under the cut <5, above unchanged, `layers[].cut.baked`. Ship check (B's `checks.ts`): "layer has a cut but skin X has no bare version". E2E: Ship shows it for shorts, clears after Make bare. Gate: Emberhold FolkProgram golden test (picks unchanged).

**D8 Stance editing** (new `motion/StancePicker.svelte`, `StanceSelect.svelte`, `state/stance.svelte.ts`, `model/stances.ts`; `SlotList.svelte`, `MotionPanel.svelte`). No deps. Picker above Clips: Base | stances | New | rename | delete | overlay. With a stance active each game-clip row shows "plays: …" or "↩ base", an Override popover over slots and trials (`folk.stance.clip`), and clear; row Play uses `clipSlots`. Vitest: `clipSlots` fallback and variants. E2E: new stance "Shield", override Idle with a trial; assert `c.folk.stances[0].clips.Idle`, the row label, undo clears.

**D9 Dressed as** (new `motion/DressedAs.svelte`; `stances.ts`, `animator.svelte.ts` signature and `build`). Needs D8. Set select grouped by culture, plus "none"; a set with a stance selects that stance. Vitest: `dressedCharacter`; bake with the shield set has a left-hand `carry` layer, without it none. E2E: Dressed as "Shield set" → play Idle; `animator.playing.baked` hands report has `carry`; "none" removes it and re-bakes.

**D10 Stance export** (`unit_export.ts`, `folk_export.ts`, events file). Needs D8, D9. Per stance in scope: bake each override on `dressedCharacter`, name `<Clip>@<id>`, apply overlay, check the held-piece rule and name clashes, report clip count and size in the build record. Vitest: fixture export has `Idle` and `Idle@shield` with differing finger tracks; events list `stances`. E2E: Ship unit card lists "Stances: shield (n clips)". Gate: `npx vitest run tools/lib/unit_export tools/lib/folk_export`.

**D11 UV brush mask** (new `look/CutMask.svelte`; D3's route). Needs D5. 2D canvas in UV space, brush/erase/size; saves `cloth/<id>.mask.png`, then `look.cloth.update {cut:{mask}}`. E2E: one stroke lowers the texel alpha.

## 4. Files other areas also touch
- A: `dressing.ts`, `dress.svelte.ts`, `gear.svelte.ts`, `OutfitThumbs.ts`, `thumbs.svelte.ts`, Sets section (embeds `StanceSelect`).
- B: `ShipPanel.svelte`, `checks.ts`, `unit_export.ts`, `folk_export.ts`, `unit.ts`.
- C: `LibraryDrawer` (D8's popover picks slots/trials, not library clips), `server/routes/look.ts`.
- E: e2e harness; `types.ts`, `command-types.ts` (additive); `folkview.ts` load path.

## 5. Risks and open questions
1. **Flat bare tone** ignores shading/tattoos on painted skins and seams may show. Mitigate with a luminance pass from the original's low frequencies; the gear tool's repaint is the real fix. The designer should check the 24 results.
2. **Cut height** comes from rest-pose vertex heights; the female/sleeve morphs shift the hem slightly. Accept in v1.
3. **`pngjs`** needs the controller's OK (alternative: a Python/Blender export step).
4. **`dressing.ts` collisions with A**: land `Dressed.layers` in one agreed diff.
5. **Overlay v1** replaces whole-bone tracks; if a shield arm looks wrong, go additive.
6. **File size**: clips × stances; the build record reports it, the budget is the designer's.
7. **Game side, noted only (no change now)**:
   - `UnitView.Folk.cs` resolves the unit's set → `sets[].stance`, else `kinds[].stance`.
   - It plays `<Clip>@<id>` if present, else `<Clip>`, and picks variants through the events `stances` map.
   - It uses `skins[].bare` as base when a worn layer has `cut.baked`.
   - Weapons attach per unit kind.
   - `folk_maps.py` should pack `bare` as a second skin array.
