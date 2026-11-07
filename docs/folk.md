# Dynamic characters (folk)

One rigged body that every unit of a kind shares, dressed per unit: a face and skin, clothes, hair and a beard picked
per unit, and the kind's outfit (boots, bracers, helmet, armour...). Emberhold's `folk-v6-*` character is the first:
the shared v6 body (`assets/src3d/shared_character_base/v6`), copied from `base-v6` with its rig, hands and clips.

## What a character holds (src/model/types.ts)

| Part | Where | Picked |
|---|---|---|
| skins | `look.skins`: albedos on the body's own UVs, each with `hair` (#rrggbb) and `tags` (`female`, `beardless`, `elderly`) | one per unit |
| clothes | `look.clothes`: RGBA layers over the skin's shirt and trouser areas; `long-sleeves` ones need the body's `long_sleeve` shape | one per unit |
| outfits | gear with `outfit`: pieces worn together, skinned to the body (`attach.kind: 'skin'`, `hideBody`) | one per unit kind |
| hair | gear with `role: 'hair'`, swap set `hair`: grey textures tinted to the skin's hair colour | one or none per unit |
| beards | gear with `role: 'beard'`, swap set `beard`: the same tint | one or none per unit |

Rigsmith shows one of each (`look.skin`, `look.clothing`, the outfit and hair and beard shown): the Gear step's
"Dynamic character" panel picks them and Randomize shows one pick as the game would make it. Commands:
`gear.outfit.show`, `gear.update` (`outfit`, `role`, `tags`), `look.skins.set`, `look.skin.show`,
`look.clothes.set`, `look.clothing.show`; undo covers them (entity `skins`).

## Schema 5: the dressing as data (src/model/folk.ts, src/engine/folkpick.ts)

`Character.folk` holds **sets** (pieces worn together, with tags such as `culture:norse` and grants such as
`covers-hair`), **pools** (skins, cloth layers, hair, beards, accessories, each item with a weight and
requires/excludes), **kinds** (villager, spearman: their sets by list or tag query, their pools) and **stances**;
`look.cloth` the cloth layers (slots bottom, top, over). One engine picks a unit's look by running a program of steps
(set -> skin -> bottom -> top -> over -> hair -> beard -> accessory) over that data with the unit's id and the game's
inputs (`culture:<id>`): each step draws with its own salt, so a villager who becomes a spearman keeps his face. The
export's manifest (schema 2) carries the program, the data and golden picks the game reproduces. The schema 4 fields
below (Gear.outfit, Gear.role, look.clothes) are kept, and kept in step, until the UI is ported; the rules below are the
migrated pools' requires/excludes.

## The rules of a pick (src/engine/folk.ts, once for Rigsmith, the export and the game)

- hair or beard tagged `fem` only on a skin tagged `female`; tagged `masc` only on one that isn't;
- a skin tagged `beardless` takes no beard; otherwise a beard about half the time;
- an outfit with a piece tagged `covers-hair` (helmets, hats, hoods) takes no hair; `covers-face` (a great helm), no beard;
- an outfit with a forearm piece (bracers) takes no long-sleeved clothes (the cuff would show through).

## Hiding the body under gear (src/engine/regions.ts)

The body's seams (material borders, UV island borders: where its vertices are split) cut it into regions: v6 has 28
(feet in three, hands in two, the forearm skin, the neck in three, face, back of the head, shirt torso and sleeves,
trouser legs and the crotch pieces). A piece hides a region when it covers at least `HIDE_SHARE` (97 %) of its
vertices: it lies within 4 % of the height out along the vertex's normal, inside a 60° cone (`garments.ts
coveredVertices`: a hat's brim is near the face but above it, not over it; a boot's sole lies under the foot's, so
boots must reach the floor: Emberhold's `gear_finish.py`). So the body always stops at a seam the piece covers, never
along a ragged line. Hair hides nothing. Below 97 % a region stays: a hidden region the piece doesn't quite reach is a
hole, and the gear is skinned like the body anyway, so on the library as it is most pieces hide little (bracers the
wrist pieces, hoods and some helmets the throat, a few boots a foot piece).

`node tools/dev/folk_regions.ts CHARACTER [FILTER]` prints every piece's share of each region (`*`: hidden).

## The export (tools/lib/unit_export.ts)

- The body's meshes are merged into one; each vertex's region (x) and material class (y) go in its second UVs
  (`TEXCOORD_1`, Godot's UV2). Region borders are locked while the levels are simplified, so no lower level's
  triangle spans two regions.
- Outfit, hair and beard pieces go in as swapped parts (`contract.ts SWAPPED`: `Outfit_<outfit>_<piece>`,
  `Hair_<style>`, `Beard_<style>`), outside the body's budget. Always-worn skin gear marked `hideBody` drops the
  regions it hides from the body.
- `<unit>.folk.json` beside the GLB: the regions (count, classes, each one's material and middle), the skins and clothes
  (copied into the work dir: `skins/`, `clothes/`), each outfit (its pieces, the regions each hides and the outfit's
  `mask`: bit r = region r, `coversHair`, `coversFace`, the clothes it can wear), the hair and beard pools with tags,
  `hairGreyMean` and the rules.
- A unit spec's `folk: { outfits: [...], hair: false }` keeps a kind's file to its own outfits (and leaves the hair
  and beards to one shared file): every part in a GLB is a node per unit in the game.

## Making the parts (Emberhold)

- outfits: `tools/comfy/gen_gear.py` (`--sheets qwen` paints the sheets locally with Qwen-Image-Edit-2511, no Codex
  quota), then `finish` (`gear_finish.py`: the key green filled, boots down to the floor);
- hair and beards: `tools/rigsmith/folk_split_hair.py` splits each hair head below the nose and in front of the ears,
  greys it; the outfits whose head is hair give theirs to the hair and beard pools;
- clothes: `tools/comfy/folk_clothes/` (MV-Adapter text + geometry on v6, baked onto its own UVs, the shirt and trouser
  areas kept);
- all of it into the character: `tools/rigsmith/import_folk.py CHARACTER [--replace]`.

## The female shape

A smooth field over the body (`folk.ts femaleOffset`; Emberhold's `tools/rigsmith/folk_female.py` is the same, pinned
by a test): a bust, a narrower waist, wider hips and seat, narrower shoulders with the arms moved in whole, a slimmer
neck and jaw. The body carries it as the morph `female` (folk_female.py adds it to the character's `rigged.glb` and
`model.glb`: run it again after a re-import or re-rig); every skinned piece takes the same field where it sits (the
viewer adds it when shown, the export as a morph on the piece), so armour follows a woman's chest and nothing clips. A
skin tagged `female` plays it at 1 (Rigsmith, the game).

## In the game (Emberhold)

- `assets/models/units/folk.glb` + `folk.folk.json` (this export, a spec with `folk.outfits`), then
  `tools/rigsmith/folk_maps.py folk`: the body's maps (its mask's red: the tunic's trims, for the clan), the skins
  and clothes as Texture2DArrays, one atlas per piece group (`assets/textures/models/folk_<group>/`: the export moved
  each piece's UVs into its cell and gives its surface `Atlas_folk_<group>`; gear has UV2 -1).
- `unit_folk.gdshader` (entity.gdshaderinc `EMB_FOLK`): one instance value per unit (skin, clothes, hidden-region mask,
  hair colour), the body's regions collapsed in the vertex shader, the clothes laid over the skin, the hair tinted, the
  clan on the tunic's trims (hem, collar, sleeve ends) by `data/visual.json folk.clan_on_tunic` (1).
- No blend shapes reach the game: shapes on a skinned mesh cost the GPU every frame whatever their weight (+3.9 ms with
  every villager folk, 10.9 -> 14.8 ms, 2026-11-06). The export bakes them: the body as `<unit>` and `FolkBody_F`,
  `FolkBody_L`, `FolkBody_FL` (female, long sleeves, both), each shaped piece as `<name>` and `<name>_F`. With them every
  villager folk draws in 10.8 ms (the same as none; `tools/dev/profile/layers.py -- --folk=all`); the file is ~36 MB.
- `game/view/UnitView.Folk.cs`: picks by the unit's id (the rules above, the manifest), shows its body and pieces of its
  shape and frees the rest. The plain villagers are drawn as it by default (docs/SWITCHES.md B, `FolkVillagers`; `--folk=off` the four old plain models; `--folk=all` every villager, a load test).

## Open

- Whether the trims are enough clan colour at a distance (the whole tunic washed every unit one colour).
- More gear for women (two styles are tagged fem; the rest unisex) and per-culture outfit lists for a kind.
