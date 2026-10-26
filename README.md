# Rigsmith

A personal character pipeline for the RTS: drop in a model, get a rigged, outfitted, painted and animated
GLB for Godot. One flow: **Import → Rig → Outfit → Texture → Animate → Export.**

```bash
npm install
npm run dev        # app + local server on http://127.0.0.1:5180
npm start          # production build, served the same way
```

Needs Node 24+, Blender 5.x on `PATH` (or `BLENDER=/path/to/blender`), and optionally the Codex CLI for
AI repainting and Godot 4.x for the export check. All data lives in `workspace/` (gitignored).

## The flow

| Step | What happens |
| --- | --- |
| Import | Drop FBX, GLB, OBJ, DAE or ZIP (Tripo zips work as-is), any number at once. Blender normalizes each one and detects whether it's a mesh, a rigged character (Mixamo, Unreal, Rigify, Tripo…) or an animation. |
| Rig | Humanoids: joints are detected automatically (Mixamo-style markers you can drag, mirrored), then weights are computed in Blender (~5 s). Choose 25/33/41/65 bones. Creatures: pick a body type (horse, fox, bird, dragon, kaiju, spider, snake, fish); the template fits to the model. Already-rigged imports keep their weights; non-Mixamo skeletons are mapped onto Mixamo (auto, editable, savable as presets). **Auto-rig all** does a whole batch. |
| Outfit | Props from the catalog (swords, shields, bows, tools, guns) pinned to sockets with a gizmo. Your own meshes: rigid pieces on a bone, or clothing skinned to the body with a policy (body, upper, lower, cape, skirt, head) so weights never bleed from the wrong bones, plus optional hide-body-underneath. |
| Texture | Fill the magenta holes AI texture generators leave (filled from nearby paint in 3D, seam-aware). Projection painting: mask an area with the smart brush or region wand (edge-aware), capture the view, let Codex paint `result.png`, preview it projected onto the UVs, keep it. |
| Animate | The complete named Mixamo collection (2,317 motions + 129 poses), bundled work/combat clips and creature clips. Search names, filenames and descriptions; numbered variants stay distinct. Every card previews the clip on *your* character. Build a per-character set (names, loop, in-place, speed) and copy it to other characters. |
| Export | GLB for Godot: bone names (`Hips` or `mixamorig:Hips`), texture size and format, `-loop` suffix for looping clips, props as bone attachments. Writes into your export folder (e.g. inside the Godot project). |

## Layout

```
src/app/        Svelte UI (one page; steps in app/steps)
src/state/      app state, viewer, animator, outfit, painter (Svelte 5 runes)
src/engine/     three.js: stage, character view, joint editor, retargeting, props, garments,
                projection painting, edge-aware selection, exporter, skeleton presets
server/         local API mounted on the Vite server: workspace, Blender/Codex job queue, library
blender/        Blender jobs: inspect/import, auto-rig (landmarks, skeleton, heat weights), texture fill,
                library conversion
static/         props, creature rig templates and their clips, bundled human clips
tests/godot/    headless Godot import check for exported GLBs
```

## Checks

```bash
npm run check                                   # types
npm test                                        # unit tests incl. retargeting on real library clips
npm run test:godot -- workspace/exports/X.glb   # imports a GLB in headless Godot, resolves every track
```

## Game units

The RTS's player units are these characters, and the game gets them exactly as they are here. Rigsmith keeps its own
list of them (`workspace/game/units.json`, `server/game.ts`; first copied from the game's): which character each unit
is, its height and budget, its horse, and the clip names the game plays (the character's **slots**). It is edited in
the Export step's "In the game" (or `tools/rig.ts unit`), saved at once and live in every page. **The game's repo
(Settings `gameRepo`) is written only by Export** ("Export <unit> to the game", `tools/rig.ts export UNIT`): the unit's
entry in its `tools/rigsmith/units.json` (that block alone, the rest of the file byte for byte), then its
`tools/rigsmith/build.sh` for that unit (the model, its maps, the holds check). Tinkering never touches the game.

```bash
npm run export:game -- <spec.json> <models dir> <work dir> [unit ...]        # what the game's tools/rigsmith/build.sh runs
python3 tools/game_import.py ~/dev/games/emberhold [unit ...] [--replace]     # fill a character in from the game's last build
node tools/dev/tune_parity.ts <unit.glb> <character> <game height> <clip ...> # the viewer's clip against the exported one
node tools/dev/ground.ts <unit.glb> ...                                       # how far each clip's feet sit off the ground
```

- **Slots** (Animate, "In the game"): each clip name the game plays, filled with a library clip. Arm a slot and press a
  card's button, or play a card and press Use. Entries the game doesn't name are Trials: kept here, never exported.
- **Tune** (Animate, under the slots; `src/engine/keys.ts`): on the slot playing, its **ground** (the whole body raised or
  lowered through the clip, in cm in the game; Auto stands it on the floor by its flat feet, `src/engine/ground.ts`: the
  frames a foot's heel and toe are down at one height, its lowest point only where it never plants one; All slots does
  every slot the game plays at once; library clips and rig tests are stood on the floor so as they play) and **keys** on its bones (turns;
  the Hips also move) and props (moves and turns about where they are held). Pause on a frame and drag the gizmo: letting
  go keys it there. Keys sit at a phase of the clip, blend between, wrap round a loop and hold at a one-shot's ends. A
  keyed prop gets its own bone in the game file (`Prop_<part>`) that the clips move.
- **Clip scripts** (Animate; `src/engine/scripts.ts`): switchable changes on top of the library motion: *Hold fist*,
  *Blow timing* (an attack cut so its blow lands at a share of it, or to a window around the blow), *Pace*.
- The order, the same in the viewer (`animator.scripted`) and the export: the clip at its speed, then the scripts, then the
  ground, then the bone keys, then the props. `tune_parity.ts` checks the two agree (every bone and prop point).
- **Gear** (Outfit): rigid garments, placed by one function the viewer and the export share (`src/engine/placement.ts`),
  fitted on the bone in any pose (Rest, fists closed, or a clip paused on a frame). A hidden garment stays out of the
  game, except the pieces the game shows by job (`Gear*`, `Head*`, `Wear*`). Only parts built in the game's Blender
  pipeline go in (brought in by `game_import`, `from: "emberhold:..."`); others are left out with a warning.
- `game_import` fills in what a character lacks from the unit's last build (its record in the game's
  `assets/textures/models/<unit>/<unit>.json`: clips, scripts, ground, keys, gear) and touches nothing already there;
  `--replace` puts it back as built.
- **Riding** (Outfit, Mount; `src/engine/mount.ts`): a character rides another (a horse on the horse template). "Rides"
  seats him from the two bodies (`straddle`: the low point of the horse's back over the middle of its spine, his thighs
  out round its barrel, the shins down its sides), then the gizmo moves the seat and shapes each held bone. His lower
  body holds the seat; the rest of him plays his slots with his scripts, keys and gear. The horse plays its own slots
  (the same names), fitted to his: loops by whole cycles (its gait leads), its Attack to his. The mount also picks the
  horse's skin and which of its garments it wears (one horse, its clips tuned once, dressed per rider). In the game spec
  the horse is the unit's `companion` with `ridden: true`; a unit still being made is a `draft` (built only when named).
- **Markers** (Rig, "Adjust joints and re-rig" on a rigged one; `src/engine/markers.ts`, `static/templates/markers.json`):
  a dozen points on one flat view (a person from the front, a horse from the side), seeded where the joints are; drag
  the wrong ones and every joint follows live (as rigidly as it can, keeping the skeleton's shape), saved on letting
  go. A person's finger tips go on a view of each hand ("Place finger markers": from the back of the hand, along the
  fingers, cut to the hand; the other hand mirrored).
- **Fix weights** (Rig; `src/engine/weightpaint.ts`, `src/state/paint.svelte.ts`, `server/weights.ts`): pause a test
  clip on the frame that shows the problem and paint on the body as it stands. *Heal*: mark the problem skin, Heal
  refills its weights smoothly from the good skin round it (skin pulled by a wrong bone goes with what surrounds it);
  *Add*, *Remove*, *Smooth* a chosen bone by hand. Seams never part (their vertices are one point), four bones a vertex.
  Save writes them into the rig and keeps them (`weight_edits.json`): every re-rig puts them back; Forget drops them.
- **Test the rig** (Rig, Check deformation; `static/templates/tests.json`): library clips picked for how hard they
  work the joints, per body type (a person: arm stretching, jumping jacks, an air squat, a fist pump, grab and slam,
  thumbs up, counting, boxing, each with its fingers animated; a horse: its template's walk, run, rear, kick, eating,
  lying down, head-butt, death), played on the rig in place, looped; pause and scrub on the timeline.
- A person's feet keep their own rest angle in a retargeted clip and take its turn on top (`retarget.ts` alignment):
  pointing the foot bone the way the source's points tipped the sole wherever the rigs' ankles sit at different heights
  (until 2026-10-26 a standing clip's heel sank 3 % of the height through the floor, its toe floating).
- A creature's hips under a root bone (the horse template's `root` is tilted) take their track in that bone's frame
  (`retarget.ts`; until 2026-10-26 written in world space, which crouched the caravan pony's walk).

## The journal, and the tools an agent uses

Every change to a character is journaled with who made it (`server/journal.ts`, `characters/<id>/journal.jsonl`): the
app's own as "app", a tool's under its `x-rigsmith-by` header. The History section under every step shows it, newest
first, with notes either side can leave. `tools/rig.ts` reads and changes characters as the app does, through the same
server (so open pages update and the journal names the change):

```bash
node tools/rig.ts list | show WHO [--json] | history WHO [N] | note WHO TEXT | get WHO [PATH] | set WHO FIELD JSON
node tools/rig.ts slot WHO SLOT CLIP [speed=1] [loop|once] [inplace|moving]   # fill a slot
node tools/rig.ts clips WHO QUERY [category]                                    # library clips for its rig
node tools/rig.ts ride WHO HORSE|off                                            # the app's default seat
node tools/rig.ts render WHO [clips=Idle,Walk] [at=0,.25,.5,.75] [views=right,front] [size=320]
node tools/rig.ts check [UNIT ...]                                              # is the game's file current?
```

`render` exports the unit (its filled slots) to `workspace/renders/<id>/` and draws each clip in Blender
(`tools/render.py`: orthographic, frames across, views down, a ground line under the feet). WHO is an id, a name or a
game unit. The node tools share `tools/lib/node3d.ts` (three's loaders headless, a character's body as the viewer
holds it); `npx tsc -p tools` type-checks them.

## Named animation library

```bash
npm run library:sync    # download, checksum-verify and convert all 2,446 named FBXs
npm run library         # rebuild from local sources/cache, no download
npm run library:verify  # verify every source hash, converted name, skeleton, FPS and frame count
node tools/library_verify.ts # load and retarget every named clip on Y Bot and a local character
```

Sources come from [Linzhan/Mixamo-Animations-Characters](https://huggingface.co/datasets/Linzhan/Mixamo-Animations-Characters),
pinned to revision `7f134bc734557b1d9516cb476d25ea1f577e45c1`. The full `animation/` folder includes static
poses. Downloads resume and use the publisher's SHA-256 hashes. Files live under
`workspace/library/sources/mixamo-named/animation/`; converted files use readable names such as
`workspace/library/clips/mixamo-Jab_Cross_2.glb`. `metadata.csv` and `index.json` preserve the original
Mixamo names, descriptions and motion IDs. The app reports completeness against that inventory;
`catalog-verification.json` records the full integrity check. Some publisher CSV frame counts are stale;
playback uses the actual FBX timing, and the report records those differences. The FBXs retain their source terms.

The original hashed pack is not a reliable filename-to-name index for this collection. Saved sets
must be checked and migrated before retiring it. Rebuilding keeps cached clips even if their old
Downloads folder is gone, and retains recovered names when the separate names file is unavailable.

### Rig quality vs Mixamo

`tools/dev/bench.ts` drives two rigs of the same meshes (e.g. Mixamo's and ours) with the same clips through
the same retargeter and scores deformation: edge stretch, rigidity of mid-limbs/head/feet, volume loss,
weight bleed, joint centering. Body regions come from geometry (Mixamo's own weights are lopsided), and
the 18 benchmark clips (`tools/skin_opt/holdout.json`) are never used to fit weights.

```bash
blender/autorig/dev/bench/rig_all.sh workspace/rigdev/bench/ours     # auto-rig the 12 Tripo characters
node tools/dev/bench.ts workspace/rigdev/bench/mixamo workspace/rigdev/bench/ours
```

On the user's 12 Mixamo-rigged Tripo characters our automatic rigs have 27% less stretch, half the limb
wobble and less than half the volume loss of Mixamo's hand-marked rigs.

### Volume build

A clean, watertight, evenly sampled stand-in for a character (for volumetric work later: weights on a
proxy, inside/outside tests). Sparse voxels via [sparse-cubes](https://github.com/navis-org/sparse-cubes)
(GPL-3.0), SurfaceNets meshing; under a second per character at the default 1 cm voxels (2–3 s at 5 mm). Single-layer cloth survives as a
thin solid, sealed pockets inside the body are filled.

```bash
npm run setup:python                                       # once: .venv with sparse-cubes + trimesh
npm run volume -- workspace/characters/<id>/rigged.glb proxy.glb [--voxel 0.01] [--smooth 10]
```

### Retopology

The in-repo, Linux take on MegaTopo's Blender + Instant Meshes mode: volume build → Instant Meshes
([PyNanoInstantMeshes](https://pypi.org/project/PyNanoInstantMeshes/), quad field-aligned, at a target
size) → [xatlas](https://github.com/jpcy/xatlas) UV atlas → colour baked from the original in Cycles
(OptiX/CUDA, CPU fallback) → GLB. ~8–9 s per character at 8k triangles / 2K texture.

```bash
npm run retopo -- workspace/characters/<id>/model.glb clean.glb [--triangles 8000] [--texture 2048]
```

Uniform quads spend triangles evenly, so at the same budget as a Tripo mesh thin parts (fingers, antler
tips) lose detail; best for messy generator output and for LODs.

### Pose-optimized weights

After Blender rigs a humanoid, `server/skinopt.ts` poses it through 256 library poses
(`tools/skin_opt/pose_set.ts`), fits the weights on the GPU for minimal stretch, wobble and volume loss
(`tools/skin_opt/optimize.py`, PyTorch from the repo's `.venv` via `npm run setup:python`, or
`RIGSMITH_TORCH_PYTHON`) and writes them into the GLB (`tools/skin_opt/apply.ts`). ~10–15 s on the GPU,
~60 s on the CPU when the GPU is busy; skipped (with a warning) without PyTorch. Creatures keep their heat weights:
trained on a template's own clips the optimizer tore a horse's chest and flank (`server/api.ts` runRig).

Started from [Mesh2Motion](https://github.com/scottpetrovic/mesh2motion-app) (MIT code, CC0 assets).
