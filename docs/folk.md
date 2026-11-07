# Dynamic characters (folk)

One rigged body that every unit of a kind shares, dressed per unit: a face and skin, clothes, hair and a beard picked
per unit, and the kind's outfit (boots, bracers, helmet, armour...). Emberhold's `folk-v6-*` character is the first:
the shared v6 body (`assets/src3d/shared_character_base/v6`), copied from `base-v6` with its rig, hands and clips.

## What a character holds

Schema 5 keeps the dressing as data (`src/model/types.ts`, `src/model/folk.ts`):

| Part | Where | Use |
|---|---|---|
| Sets | `folk.sets`: piece ids, tags and grants | Gear worn together; sets are per character |
| Pools | `folk.pools`: weighted items with requirements and exclusions | Skins, cloth layers, hair, beards and accessories |
| Classes | `folk.kinds`: sets and pools, by list or query | A game unit's class; culture is a runtime input |
| Stances | `folk.stances`: clip overrides and an optional overlay | A set or class selects a baked stance |
| Skins | `look.skins`: painted albedo, optional `bare`, tags and hair colour | One per unit |
| Cloth | `look.cloth`: layers, bottom/top/over slots, optional cuts, masks and trim | Up to one layer per slot |

The schema 4 `Gear.outfit`, `Gear.role` and `look.clothes` fields remain synchronized for compatibility until legacy
retirement. Migrated pools carry the old hair, beard and bracer restrictions. The deterministic picker
`src/engine/folkpick.ts` runs set → skin → bottom → top → over → hair → beard → accessory, using independent salts for
stable choices. Class and culture context also reaches Crowd and Wardrobe. Browsing is preview state; Make default
journals the chosen defaults, while per-piece visibility stays a preview.

## Cloth, cuts and bare skin

Look edits ordered layers and their slots, per-limb height and feather, region drops, and a painted UV mask. Make bare
fills the clothes zones on the full body; Make all records the resulting references in one undoable change. The skin
sheet previews the same dressing. Mask saves publish immutable `cloth/<layer>.mask.<hash8>.png` files and journal the
reference; undo and redo retain their bytes. An unsaved mask draft survives unrelated edits and closing/reopening the
editor in the same page. A conflicting mask save is refused with the draft retained. Old mask versions are not swept:
an upload and its reference are separate requests, so collection needs a transaction or lease to avoid racing a save.

The stage composes only the selected layer's slot zones. An empty slot keeps the painted skin; a cut worn layer uses
bare skin only in its cut-away zone. Shirt and trouser regions and their adjoining Skin forearms and ankles are
included, while unrelated Skin islands such as the face are not. Raster coordinates match the image layout, and cuts
use the same field and seam gutter during export as on the stage. With no cut, the bare image and cut padding are not
computed; the appearance of uncut seams still needs visual acceptance. Ship warns when a cut could be used with a
skin that has no bare image. Bare-leg appearance also still needs a close visual review.

## Hiding the body under gear (src/engine/regions.ts)

The body's material and UV seams form regions: v6 has 28. A piece hides a region only when it covers at least
`HIDE_SHARE` (97 %) of that region's vertices. Hair hides nothing. This stops the body at a seam rather than along a
ragged edge. The Coverage view reports the largest single piece's share per region, not the union of pieces;
`node tools/dev/folk_regions.ts CHARACTER [FILTER]` prints the per-piece values.

## Export (tools/lib/unit_export.ts)

- The body carries region and material class in `TEXCOORD_1`; region borders stay locked while the levels simplify.
  Sets and pool pieces in scope are exported as swapped meshes, including hidden pieces needed by a stance.
- The schema 2 `<unit>.folk.json` carries the picker program, data and golden picks, scoped sets and pools, skins,
  layers, pieces, body regions and a schema 1 compatibility view. A unit may scope its class with `folk.kind`, its
  pools with `folk.pools`, or legacy outfits by name. `skins[].bare` names the copied bare image when present;
  `layers[].cut.baked` identifies a layer whose cut was applied to its PNG. Cut and mask baking uses the actual shipped
  rig's UVs even if a separate physics rig has a different layout.
- Only stances reachable in the unit's scope are baked. A set's own held pieces are present when its stance is baked;
  sets sharing a stance must agree on bone-held pieces. Clips are named `<Clip>@<stance>` and
  `<Clip>_2@<stance>` for subsequent variants; the GLB, events and manifest use those names, and an overlay is already
  baked into them. Ship uses the same planner and reports conflicting stances.
- The Look server and export use `pngjs`, a devDependency: development dependencies must be installed wherever those
  tools run. Output writes are atomic and skip unchanged bytes.

The game still needs per-slot bare-base composition below cut layers, and the game-side FolkProgram golden and stance
playback need verification. The export contract and browser screenshots alone do not establish game parity.

## Making the parts (Emberhold)

- Outfits and hair: the Emberhold gear pipeline creates and finishes them before import.
- Clothes: `tools/comfy/folk_clothes/` paints and bakes onto the body's UVs.
- `tools/rigsmith/import_folk.py CHARACTER [--replace]` imports the resulting parts into a character.

## The female shape

A smooth field over the body (`folk.ts femaleOffset`; Emberhold's `tools/rigsmith/folk_female.py` is the same, pinned
by a test): a bust, a narrower waist, wider hips and seat, narrower shoulders with the arms moved in whole, a slimmer
neck and jaw. The body carries it as the morph `female` (folk_female.py adds it to the character's `rigged.glb` and
`model.glb`: run it again after a re-import or re-rig); every skinned piece takes the same field where it sits (the
viewer adds it when shown, the export as a morph on the piece), so armour follows a woman's chest and nothing clips. A
skin tagged `female` plays it at 1 (Rigsmith, the game).

## In the game (Emberhold)

The existing game pipeline consumes exported models and folk data through `tools/rigsmith/folk_maps.py`, the folk
shader and `game/view/UnitView.Folk.cs`. The new cut/bare and stance contracts above still require the game-side work
and validation noted under Export; do not assume the current game renderer handles an empty slot or a baked stance.
The female and long-sleeve body variants and female piece variants avoid per-frame blend-shape cost in the game.

## Open

- Game-side bare-slot composition, stance playback and FolkProgram golden verification.
- Bare-leg and uncut seam visual acceptance; trims and per-culture outfit art remain design questions.
