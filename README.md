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
| Animate | One library: your Mixamo clips, the 2,453-clip pack (deduplicated), bundled work/combat clips and creature clips. Categories, search, 24 per page, every card previewing the clip on *your* character. Build a per-character set (names, loop, in-place, speed) and copy it to other characters. |
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

### Pose-optimized weights

After Blender rigs a humanoid, `server/skinopt.ts` poses it through 256 library poses
(`tools/skin_opt/pose_set.ts`), fits the weights on the GPU for minimal stretch, wobble and volume loss
(`tools/skin_opt/optimize.py`, PyTorch from `RIGSMITH_TORCH_PYTHON`) and writes them into the GLB
(`tools/skin_opt/apply.ts`). ~10–15 s; skipped (with a warning) when PyTorch or the GPU isn't available.

Started from [Mesh2Motion](https://github.com/scottpetrovic/mesh2motion-app) (MIT code, CC0 assets).
