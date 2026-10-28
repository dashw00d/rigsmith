# Inventory 6: Texture step (hole filling, projection painting, texture saving)

Audit of the Texture step as of commit 36f9295 (working tree clean). Read-only: nothing was run. Line numbers refer to
that tree. Findings marked "by reading" are inferred from code, not reproduced.

## 1. Purpose of the area

Take a character's single color texture (usually from an AI generator such as Tripo) and improve it in place, in two
ways. (a) **Fill holes**: detect the magenta "unpainted" texels the generator leaves and repaint them from nearby
surface in 3D (a Blender job). (b) **Projection painting**: mask an area on the model itself, render the views that see
it, have Codex (or a human) repaint each view, project the results back through the cameras onto the UV texture
(WebGL, in the browser), preview, stack, and Keep. The saved result is a PNG override in `textures/` that is swapped
into the character's GLBs (`model.glb`, `rigged.glb`) without re-rigging.

---

## 2. UI surface

All UI is one inspector panel, `src/app/steps/TexturePanel.svelte` (212 lines, mounted from `src/app/Inspector.svelte:23`
when `app.step === 'texture'`), plus a brush-cursor overlay in the viewport. State lives in the `painter` singleton
(`src/state/painter.svelte.ts`). `src/app/texture/` contains only `MaskPainter.svelte`.

### 2.1 Section "Unpainted areas" (TexturePanel.svelte:60-85)

| Element | Where | What it does |
|---|---|---|
| Intro text | :61 | Explains magenta holes and 3D fill. |
| "Filled N.N% of the texture" badge (Sparkles icon) | :63-67 | Shown when `character.texture.filled`. Percentage = max `coverage` over `texture.images` (:18). |
| "Filled areas (texture layout)" thumbnails | :68-73 | One `<figure>` per image that has a `mask`; loads `textures/<name>.mask.png` (red = filled texels, UV layout, pixelated). Not clickable. |
| "No unpainted areas found" badge | :74-76 | Shown when `texture` exists, not filled, and max coverage < 0.0005. **Also shows after a Keep without any scan** (see 8.2). |
| **Find and fill holes** (primary, block, Wand icon; shows job message while busy) | :82 | `api.fillTexture` -> POST `/texture/fill` -> `fillTexture` job. Only shown when not filled and not painted. |
| **Restore original texture** (ghost, RotateCcw) | :79-80 | `api.revertTexture` -> DELETE `/texture/fill` -> `revertTexture` job. Replaces the Fill button once `filled \|\| painted`. Disabled while a texture job runs. |

Error handling: toast on API failure (:21, :56). `busy` = the character has a running `texture` job (:15).

### 2.2 Section "Projection painting" (TexturePanel.svelte:87-183)

**Idle state (painter not active), :88-101**

| Element | Where | What |
|---|---|---|
| Intro text | :89 | Describes mask -> Codex -> project back. |
| **Start painting** (primary, block) | :90 | `painter.start()`. Disabled unless `status === 'rigged'` or `kind === 'mesh'`. Needs a model with a color map and UVs, else toast "no color texture". |
| "Earlier captures" list (max 5) | :91-101 | One button per capture: "N min ago · K views" and "Result ready · preview" / "Waiting for result". Click -> `painter.resume(character, id)` (starts painting mode + reopens the capture). |

**Active state (:102-182): an ordered list of 4 steps, each with a green left border when "done"**

Step 1 "Mask the area" (:104-124, done = `painter.hasMask`)

| Control | Where | Behavior |
|---|---|---|
| Tool segmented control (icons only; tooltip text is the long label) | :106, options :26-32 | `smart` (Sparkles), `wand` (WandSparkles), `brush` (Brush), `erase` (Eraser), `navigate` (Hand). Writes `painter.tool` (and a local mirrored `tool` state, :24-25). |
| Per-tool help sentence | :107, texts :33-39 | One line per tool. |
| **Size** slider 8-200 px | :108-110 | `painter.brush`; shown for smart, brush, erase. Also drives the cursor circle size. |
| **Tolerance** slider 0-1 | :111-113 | `painter.tolerance`; smart and wand. Mapped to color-distance limit `0.04 + tol*0.5` (surfacemask.ts:142, :168). |
| **Contiguous** toggle | :114-116 | wand only; off = every matching triangle on the model. |
| Camera hint text | :117 | "Drag off the model to turn the camera; right-drag pans, the wheel zooms." |
| Shrink (Minus), Grow (Plus), Invert (ArrowLeftRight), Clear (X + label) | :118-123 | `growMask(-3/+3)`, `invertMask()`, `clearMask()`. Fixed 3-texel step; `title=` tooltips (not the shared `tooltip` action). |

Modifier keys (painter.svelte.ts:115-132): Shift-click on wand = add, Alt-click on wand = subtract, Alt-drag on smart/brush
= erase. Left-drag on the model paints (camera held); left-drag off the model orbits (OrbitControls); right-drag pans;
wheel zooms. While a result is previewing, mask editing is blocked (`previewing` check, :116).

Step 2 "Describe and capture" (:125-139, done = `capture !== null`)

| Control | Where | Behavior |
|---|---|---|
| Notes textarea (3 rows, placeholder "e.g. a deep purple priest's stole...") | :127 | `painter.notes`; baked into `prompt.md` at capture time only. |
| **Find views and capture** (Camera icon; label becomes "Finding the views" / "Capturing N views") | :128 | `painter.captureViews`. Disabled until `hasMask`. |
| View thumbnails grid (3 columns) | :129-138 | Shown when the capture has a `uvMask` (new format). `view-N-color.png` with caption "N · front-left". Not clickable. |

Step 3 "Paint the views" (:140-154, only when `painter.capture`; done = `resultReady`)

| Control | Where | Behavior |
|---|---|---|
| **Generate with Codex** (primary, block; shows Codex job message while running) | :143-145 | `painter.askCodex` -> POST `.../codex`. |
| **Open folder** | :147 | POST `/api/open` with the capture folder -> `xdg-open` (Linux only). |
| **Use an image...** | :148, :150 | Only when exactly 1 view. File picker (png/jpeg/webp) -> `painter.useFile` -> writes `result-1.png` (or legacy `result.png`). |
| Folder path (monospace) | :151 | Absolute path of the capture folder. |
| "Waiting for result-1.png ... result-N.png in that folder..." | :152 | Shown until all results exist; polling picks them up. |

Step 4 "Keep it?" (:155-168, only when `previewing` or `layers > 0`)

| Control | Where | Behavior |
|---|---|---|
| Layers explanation ("N earlier results kept under this one...") | :158-161 | Text only. |
| **Keep** (primary, Check) | :163 | `painter.keep` -> saves the baked canvas as the texture override. |
| **Discard** / "Discard this one" | :164 | `painter.discard()`: takes back the showing preview (to the layered base). Only when previewing. |
| **Discard all** | :165 | `painter.discardAll()`; only when layers > 0. |

Below the list:

| Element | Where | Behavior |
|---|---|---|
| Second "Earlier captures" list (excludes the current capture, max 5) | :170-180 | Same buttons as the idle list; label notes that opening one while previewing keeps the shown result and stacks the new one on top. |
| **Done painting** (small ghost) | :181 | `painter.stop()`; `window.confirm` if there are unsaved previews/layers. |

### 2.3 Viewport pieces

- `src/app/texture/MaskPainter.svelte` (14 lines): draws the brush circle (size = `painter.brush` px, plus a center dot for smart) at `painter.cursor`. Mounted at `Viewport.svelte:103` when `painter.active && app.step === 'texture'`. Hidden for navigate/wand/previewing (painter.svelte.ts:136).
- Mask itself: a tinted blue overlay mesh (`0x7f9bff`, 60% opacity) added next to each painted mesh (surfacemask.ts:81-105). Hidden during preview.
- Viewport busy spinner shows `painter.busy` text ("Finding the views", "Capturing N views", "Projecting onto the texture", "Saving the texture"), `Viewport.svelte:117,120`.
- Toasts: "Painting applied: putting it into the rig in the background", "Codex is painting. The result is picked up automatically.", errors.
- The Jobs popover/Viewport also show the server jobs of kind `texture` and `codex`.

### 2.4 Not present (relevant to a redesign)

No undo/redo for mask strokes; no delete/rename/pin of captures; no thumbnail of results (only of the inputs `view-N-color.png`);
no before/after toggle (a preview simply replaces the texture; only Discard returns); no editing of the prompt after capture
(only the files in the folder); no way to supply per-view images except the file manager (multi-view) or the single "Use an image"; no
journal/History entry for texture operations (the three `record()` calls in api.ts are elsewhere); no texture selection when a model
has several images (only the first color-mapped material is paintable); no regenerate-single-view.

---

## 3. User workflows

### 3.1 Fill holes
1. Texture step -> "Find and fill holes".
2. Server: `fillTexture` job runs `blender/jobs/texture_fill.py` on the character's *original source file* (api.ts:265), writes `textures/<clean>.png` and `<clean>.mask.png` for each image with >=0.05% magenta.
3. Character.texture = `{filled: anyFile, images, at}` (api.ts:268). Then `refreshOutputs` (non-direct): re-runs Blender inspect (re-imports with overrides) to rebuild `model.glb`, then `swapImages` into `rigged.glb` using the new model as "original" (api.ts:251-259).
4. Panel shows "Filled X%" and the mask thumbnail; the button flips to "Restore original texture".
5. If nothing found: "No unpainted areas found", the Fill button stays (no override written).

### 3.2 Restore
"Restore original texture" -> DELETE `/texture/fill` -> removes the whole `textures/` dir (fill *and* any painting), clears `filled`/`painted`, re-inspects, swaps original images back into `rigged.glb`.

### 3.3 Mask and capture
1. Start painting (animator stopped, viewport forced to Shaded, `SurfaceMask` built over every mesh sharing the paint target's texture).
2. Pick a tool; paint on the model. Mask shows as a blue overlay on the model; camera moves freely.
3. Optionally type notes. "Find views and capture":
   a. Mask samples (<=4000 surface points) -> `planViews` chooses up to 6 camera directions (greedy cover).
   b. For each view, render 5 passes at 1024x1024 (color, flat, depth, normal, mask) and PUT them to `projections/<id>/view-N-*.png`.
   c. PUT `uvmask.png`, `views.json`, `prompt.md`.
4. Capture appears in step 2 (thumbnails) and step 3. Polling (2 s) starts.

### 3.4 Ask Codex or supply images
- Codex: "Generate with Codex" -> server job spawns `codex exec` in the capture folder with `view-N-flat.png` + `view-N-mask.png` attached and `prompt.md` on stdin. It must write `result-N.png` for every view. Job message streams Codex events. Failure if any result-N is missing afterward.
- Manual single view: "Use an image..." (writes result-1.png). Manual multi-view: "Open folder" and drop `result-N.(png|jpg|webp)` in by hand.

### 3.5 Preview
Polling (`check`, 2 s) calls `GET projections/<id>`; when all results exist and the newest mtime changed, `preview` loads each result, `fitted` scales it to the capture size, and `bakeViews` projects them onto the base texture (GPU). The model's texture image is swapped to the baked canvas; the mask is hidden; Step 4 appears. Re-generating overwrites result files, mtime changes, the preview refreshes on top of the same base (never on top of the previous preview).

### 3.6 Stack several repaints
While a preview shows, either click "Find views and capture" again (mask still present) or open an earlier capture. `layerPreview()` turns the showing preview into `layerBase` (`layers++`); the next capture renders from the model *with* that texture and its result is baked onto `layerBase`. Keep saves everything stacked; "Discard this one" drops only the latest; "Discard all" drops all unsaved.

### 3.7 Keep
`keep()` PNG-encodes the baked canvas (full texture resolution) and PUTs `/textures/<clean texture name>.png` -> `saveTexture` job: writes `textures/<name>.png`, sets `texture.painted = true`, then `refreshOutputs(direct)`: `swapImages` straight into `rigged.glb` (+ `model.glb`), bumps `revision`, clears thumbnail. Panel then clears the capture and mask. (Not rigged: falls through to re-import via Blender inspect.)

### 3.8 Resume / earlier captures
Click a capture: loads `views.json` + `view-N-mask.png` + `uvmask.png` (or legacy `camera.json` + `mask.png`), restores the mask onto the model (new format only), selects the navigate tool, starts polling, and immediately previews the result if one exists. Opening a different capture while previewing stacks.

### 3.9 Leave
"Done painting" (confirm if unsaved), or leaving the Texture step (TexturePanel `onDestroy`, :42) calls `painter.stop()`, which discards unsaved previews.

---

## 4. Data model

### 4.1 `Character.texture` (server/workspace.ts:50, `TextureImage` :183-189)
```
texture?: { filled: boolean, images: TextureImage[], at: number, painted?: boolean }
TextureImage { image: string /* Blender image name */, coverage: number /* magenta fraction */, file: string|null /* null: nothing to fill */, mask?: string }
```
- `filled`: true if any fill output file was written.
- `images`: the fill scan result; also kept (stale) after painting.
- `at`: timestamp; used as cache-bust `?v=` for `textures/...` URLs (src/state/api.ts:82).
- `painted`: set by Keep, cleared by Restore. There is no per-layer record of what was painted, prompts, or which captures contributed.
- Real data in `workspace/characters/*/character.json` shows variants: fill-only entries without `at`, paint-only entries with `images: []`.

### 4.2 Texture overrides directory: `workspace/characters/<id>/textures/`
- `<bpy.path.clean_name(image name)>.png`: the *only* representation of the current texture (fill output and painted output share the file name; Keep overwrites the filled file).
- `<clean>.mask.png`: fill's hole mask in UV layout (red=hole, green 0.4*hole), size <= 1024. Written only by fill; stale after painting.
- Read by Blender via `--overrides` in inspect.py:27/37, rig.py:40/179, bake.py:32/80; read by `server/glbimages.ts` via `cleanImageName`. Two separate implementations of clean_name (`projection.ts:34 cleanName`, `glbimages.ts:15 cleanImageName`).
- The painted file name comes from the browser: `cleanName(target.texture.name || 'texture')` (painter.svelte.ts:370). It works only if three's `texture.name` equals the GLB image name; if empty, it writes `texture.png`, which matches nothing, and `swapImages` silently swaps 0 images while the toast says "Painting applied".

### 4.3 Projection folders: `workspace/characters/<id>/projections/<pid>/`
`pid = 'p' + Date.now().toString(36)` (painter.svelte.ts:202); the server accepts `[a-z0-9-]+` (api.ts:604). Files:

New "views" format (current):
| File | Written by | Content |
|---|---|---|
| `view-N-color.png` | captureViews | lit render of the character (1024x1024) for a human; the UI thumbnail |
| `view-N-flat.png` | captureViews | unlit texture as seen (what Codex edits) |
| `view-N-mask.png` | captureViews | white = repaint, black elsewhere (mask seen through the camera, gaps closed) |
| `view-N-depth.png`, `view-N-normal.png` | captureViews | depth/normal guides. **Never read by anything** (not attached to Codex, not used by bake) |
| `uvmask.png` | captureViews | padded mask in texture layout, <= 2048 px; grey = soft strength |
| `views.json` | captureViews | `{views:[{name, camera:{width,height,projection[16],view[16],position,near,far}}]}` |
| `prompt.md` | captureViews | prompt text for Codex (client-built from notes + view list) |
| `result-N.(png\|jpg\|webp)` | Codex or user | per-view repaint, any size (fitted to 1024x1024 on load) |

Legacy "single view" format (still on disk in `seer-3ed164`; nothing creates it now):
`camera.json`, `mask.png`, `color.png`, `flat.png`, `depth.png`, `normal.png`, `prompt.md`, `result.png`. Extra free-form files (e.g. `result-1-prompt.txt`, `repaint-prompt.txt`) appear in real folders; they were written outside the app (by Codex/humans).

Upload route accepts only `png|jpg|webp|json|md` names (api.ts:619); limit 64 MB per file for projections; texture PUT 512 MB (MAX_UPLOAD, api.ts:22).
Server lists the 12 newest captures; UI shows 5. No deletion, no cleanup, no size accounting (about 5 PNG x 1 MB x views per capture).

### 4.4 In-memory state (painter.svelte.ts)
`active, tool, brush(48), tolerance(0.35), contiguous(true), notes, hasMask, cursor, capture{id,folder,views[{name,camera,mask canvas}],uvMask|null}, resultReady, previewing, busy, layers, private mask(SurfaceMask), poll, originalImage, layerBase, bakedCanvas, resultVersion, off(listeners)`.
The mask itself (`SurfaceMask.data`, 1 byte/texel at <= 2048) is **not persisted** except as `uvmask.png` inside a capture.

---

## 5. Algorithms

### 5.1 Mask representation and painting (`src/engine/surfacemask.ts`)
- **Storage**: `data` Uint8 per texel in the *texture layout* (scale so max side <= 2048; `MAX` :31), `covered` = texels any triangle covers (rasterized at construction, :70-73), `colors` = the texture downsampled to mask size for color tests, `texture` = RGBA DataTexture used as `alphaMap` on the overlay (value in every channel; `changed()` :108-113 rebuilds the whole RGBA array on every dab, O(w*h)).
- **Parts**: per mesh `partOf` (:333-375) builds rest-pose world positions (bind matrix for skinned), a welded "point" id per vertex (position-quantized so seams share points), point adjacency, point->triangles, triangle adjacency through shared edges (across seams).
- **Dab / brush / smart brush** (`dab` :119-157): from the hit triangle, Dijkstra (array-scan heap, O(n^2) worst) over the *posed* surface graph out to `1.5*radius` (geodesic-ish reach; keeps the brush from leaking through the air to a nearby sleeve). All triangles touching reached points are rasterized in UV space; for each texel the barycentric-interpolated *posed* 3D position gives distance to the hit point; falloff = `1 - smoothstep(d, 0.75r, r)`; value = max (paint) or min(255-v) (erase). Smart brush additionally rejects texels whose `colorDistance` (YCbCr-weighted, selection.ts:18-26) to the stroke's start color exceeds `0.04 + tol*0.5`. Brush radius in world units = screen px * perspective scale at the hit (`radiusAt`, painter.svelte.ts:100-104).
- **Stroke** (painter.svelte.ts:133-142): pointer moves are interpolated to dabs spaced `brush/3` px, capped at 6 per event.
- **Wand** (`wand` :167-198): replace (clears the whole mask first), add, subtract. Contiguous: BFS across triangles by `triAdj`; a neighbor joins if its centroid or any corner texel is within tolerance; every texel of included triangles within tolerance is set to 255/0. Non-contiguous: every triangle on every part that is "near". (Does not respect the soft values: wand writes hard 0/255.)
- **Grow/shrink** (`grow` :201-206): threshold >=128, 4-neighbor dilate/erode via `morph` (selection.ts:126), re-clipped to `covered`. **Invert** (:208): `255 - v` on covered texels. **Clear**, **load** (:216).
- **`any`** (:76) and **`samples`** use the 128 threshold (soft edges below 128 are not "masked" for view planning but do count in the bake).
- **`samples(limit=4000)`** (:308-329): every texel centre in mask, once, subsampled evenly, as rest-pose world position + face normal (per-triangle flat normal).
- **`padded()`** (:240-264): copy of data, then 3 iterations of 4-neighbor dilation of values *into uncovered texels only* (so a seam never fades). Output is a canvas (grey + opaque alpha). `paddedTexture()` (:228) makes it a DataTexture for rendering the per-view masks.

### 5.2 View planning, greedy cover (`planViews`, projection.ts:253-360)
Inputs: renderer, view, mask samples, fov. Parameters: `most=6, enough=0.6, short=0.03, minGain=0.04`.
1. 48 candidate directions on a Fibonacci sphere. Each is framed on the bounding sphere of the samples (radius >= 5% of character height), distance by fov.
2. For each direction render a 256x256 float depth map of the **rest-pose** geometry (all meshes, double-sided; custom shader writing NDC z), read it back (CPU).
3. Per sample quality `q = n . dirToCamera` if facing >= 0.15, inside the frustum, and not occluded (z <= max(min 3x3 neighbourhood depth, center) + 0.004), else 0.
4. `reachable[i]` = best quality over all directions; `need[i] = min(0.6, 0.8*reachable[i])`.
5. Greedy: each round pick the unchosen direction with max gain = sum over samples of the *capped* improvement (`min(q,need) - min(best,need)`) plus a tiny tie-break for squarer views. Stop when none, gain < 4% of samples, 6 views chosen, or <=3% of samples still short.
6. Each chosen view is re-framed on the samples it "owns" (those it sees at least as squarely as any other chosen view), united with samples it sees at quality > 0.3, min radius 5% height; named by azimuth/elevation (`nameOf` :363-371, character faces +z).

### 5.3 Capture passes (`renderPasses`, `captureFrom`, projection.ts:79-234)
- Builds a private scene with hemisphere + key light and environment; temporarily hides mask overlays; clones the camera at the requested aspect; renders at 1024x1024 (fixed in `captureFrom` default; viewer size is irrelevant).
- Passes: `color` (lit, sRGB target), `flat` (material swapped to MeshBasic with the map, unlit), `depth` (custom shader, linear, normalized to the character sphere, 1 = near; skinning chunks included), `normal` (MeshNormalMaterial), `mask` (MeshBasic with the padded UV mask as `map`, DoubleSide).
- Mask post-process: alpha > 0 ? R : 0 over black; `closeGaps(r=2)` (:194-215) = separable max then min filter to close hairline cracks between triangles (O(n*r) JS loops over 1M px, 4 passes).
- Output camera record = projection and view matrices, position, near/far, size, so baking uses exactly the same camera (stored in `views.json`).
- The captured model is the **currently displayed** model (posed state: `animator.stop()` is called first; the texture shown includes any layered preview) whereas planning and baking use the **bind-pose** geometry.

### 5.4 Bake: weighted accumulation (`bakeViews`, projection.ts:519-636)
Inputs: renderer, view, per-view `{camera, result canvas, mask canvas}`, `uvMask` canvas, `base` image (layerBase or original).
1. Output size = base image size (could be 4096+; read back full-res).
2. For each view: render rest-pose depth of all geometry from that camera (float RT at capture size, red=far clear). Then render the **paint-target meshes in UV space** (vertex shader places each vertex at its UV; `gl_Position = uv*2-1`), with a fragment shader that computes the fragment's clip position in the capture camera and discards if outside frustum, `facing = n.(cam-world) <= 0.05` (back/grazing), occluded (`ndc.z > depth + 0.002`), or weight `w = mask.r * result.a * facing^3 <= 1e-6`; otherwise outputs `(rgb*w, w)`. Additive blending (One, One) into a half-float accumulator.
3. Composite pass over the base texture: `k = uvMask * clamp(sumW / 0.0005, 0, 1)` (only if any view saw it); `out = mix(base.rgb, sumRGB/sumW, k)`, alpha = base alpha. Read back, flip rows, return as a canvas.
- Properties: blended average across views weighted toward the squarer view (facing cubed), mask strength is the UV mask value times the view's mask; "any view that saw it at all paints it". There is no gutter padding after baking: texels outside UV islands are not written (no dilation of the baked color past island borders), so mip/filter bleed of old colors at seams is possible (by reading).
- Legacy `bakeProjection` (:387-512): single camera; same idea but alpha-over blend with `a = mask * result.a * smoothstep(0.05, 0.35, facing)`; the copy of the base is drawn first, projection on top; front faces only depth pass (no DoubleSide). Not selectable from the UI, but used when a legacy capture is opened (painter.svelte.ts:320-321).

### 5.5 Gap closing / padding summary
- UV padding: `SurfaceMask.padded()` 3 texels (surfacemask.ts:240).
- Screen gap closing: `closeGaps` r=2 on every view mask (projection.ts:224).
- Fill: `dilate` 2 steps before downsampling, 3 steps for the composite alpha; `fill_gutters` 96 iterations of 4-neighbor growth (texture_fill.py:150-168).

### 5.6 Layering (painter.svelte.ts:52-57, 179-185, 307-359)
`originalImage` = the model texture as saved (captured at first preview); `layerBase` = the baked canvas of earlier unsaved results; `bakedCanvas` = the one showing. `preview` always bakes onto `layerBase ?? originalImage`; `layerPreview` moves `bakedCanvas -> layerBase`; `discard` restores `layerBase ?? originalImage`; `keep` saves `bakedCanvas ?? layerBase`. Layers are in memory only; they are lost on reload.

### 5.7 Hole fill (`blender/jobs/texture_fill.py`)
Inputs `--input <source model> --out <textures dir>` (docstring also claims `--overrides`, which is not parsed, :6 vs :172-175). For each image used by any material:
1. Read float pixels, flip rows. `magenta_mask`: r>0.5, b>0.5, g<0.5*min(r,b), |r-b|<0.25 (:24-28). Skip if coverage < 0.05%.
2. Work at min(1024, w): area-average colors; hole mask dilated 2 px then downsampled (>0.05).
3. `texel_positions` (:68-108): per triangle (Python loop) barycentric rasterization in UV space (tolerance -0.02) giving a world position per texel + `covered`.
4. `fill_from_surface` (:111-147): 3D voxel grid (cell = height/160); sum valid colors per voxel; iteratively (<=64) fill missing voxels from the mean of 6-neighbors (`np.roll` wraps); assign each hole texel its voxel mean.
5. `fill_gutters` (:150-168): holes outside any UV island grown from neighbors.
6. Composite at full resolution: bilinear upsample of the fill; alpha = max(dilate(hole,3), 1.5*soft); output opaque (alpha forced to 1, :214). Writes `<clean>.png` and `<clean>.mask.png`.
- Image names: `bpy.path.clean_name`. Handles *every* image node in every material, not just the color map.

### 5.8 Image swap into GLBs (`server/glbimages.ts`, `swapImages`)
Parse GLB (JSON chunk + BIN), for each embedded image (with name and bufferView): if `<dir>/<cleanName>.png` exists use its bytes; else if `original` GLB is given use the image of the same name from it (restore). Drop identical ones. Re-lay-out the BIN chunk (buffer 0 views sorted by offset, 4-byte aligned), set `mimeType: image/png`, rewrite buffer length, atomically replace the file (tmp + rename). Returns count changed. Unit test: `server/glbimages.test.ts`. Not handled: images referenced by `uri`, multi-buffer files, image names that do not clean to the file name.

### 5.9 Texture refresh (`refreshOutputs`, api.ts:239-260)
- `direct` (Keep) and rigged mesh: `swapImages(rigged)` + `swapImages(model)`; revision++; thumbnail cleared. No Blender.
- Otherwise (Fill, Restore, unrigged Keep): `runInspect(keepEdits=true)` re-imports source with overrides (rebuilds `model.glb`, stats, thumbnail, joints), then `swapImages(rigged, overrides, made)`.

### 5.10 Codex job (`server/jobs.ts:117-148`, api.ts:652-670)
`codex exec -C <dir> --skip-git-repo-check --ephemeral -s workspace-write --json -c model_reasoning_effort="low" -i <flat/mask files...> -` with prompt on stdin; env overrides `CODEX`, `CODEX_EFFORT`; 15 min timeout; events streamed as the job message. Success check = all `result-N.*` exist in the folder (existing old results satisfy this even if Codex wrote nothing new).

---

## 6. Cross-area dependencies

- **Viewer/CharacterView** (`viewer.svelte.ts`, `src/engine/CharacterView.ts`): painter uses `viewer.character` (meshes, skinned, box, height, root) and `viewer.stage` (renderer, camera, controls, scene environment); forces `setMode('shaded')`; the model is reloaded by `Viewport.svelte:37-46` whenever `revision`, `status`, `props`, `garments`, `mount` change.
- **Animator**: `animator.stop()` before starting/capturing/previewing (mask and capture assume rest pose).
- **App/jobs/SSE**: `app.jobFor`, job `kind` strings `texture` and `codex` (also `inspect`, `rig` indirectly); `app.toast`.
- **Rig/Import pipeline**: `scene_io.apply_texture_overrides` (blender/common/scene_io.py:50-72) applied on *every* `import_any` (inspect, autorig, bake, fill's other callers). `runInspect` and `runRig` pass `--overrides textures/`. So the texture override mechanism is a cross-cutting contract: inspect (api.ts:78), rig (api.ts:126), `refreshOutputs`.
- **Outfit**: garments/props change `characters.garments`/`props`, which retrigger viewer.sync -> reload; painting does not include garment meshes unless they share the paint target's texture (`paintTarget` filters by identical `map`).
- **Export**: `exporter.ts` resizes/re-encodes the texture at export (`textureSize`); painted PNG is embedded at full resolution in `rigged.glb` before that.
- **Retopo tool** (`tools/retopo/retopo.py:17,208`) is the only caller of `blender/jobs/bake.py` (also reads `--overrides`). Not part of the Texture step UI.
- **Workspace/server**: `characterDir`, `updateCharacter` (workspace.ts), `/api/open` (xdg-open allowlist: workspace + export dir), `/files/...` static serving (used for capture images and masks).
- **UI kit**: `Section`, `Button`, `Segmented`, `Toggle`.
- `selection.ts` is shared only for `colorDistance` and `morph`; all of its edge-aware region growing is dead (7.4).
- No tests cover painter, projection, surfacemask, selection, texture_fill, or the projection/codex routes; only `server/glbimages.test.ts` exists.

---

## 7. Redundancy and overlap

### 7.1 Two capture/bake generations living side by side
| Concern | Legacy single-view | Current multi-view | Where |
|---|---|---|---|
| Folder files | `camera.json, mask.png, color/flat/depth/normal.png, result.png` | `views.json, uvmask.png, view-N-*.png, result-N.png` | api.ts:634,644,661,667 |
| Client capture | `captureView` (**dead**, no callers) | `captureViews`/`captureFrom` | projection.ts:177 vs :217 |
| Client bake | `bakeProjection` | `bakeViews` | projection.ts:387 vs :519; chosen at painter.svelte.ts:320-322 |
| Resume | `else` branch with `camera.json`+`mask.png`, `uvMask: null` | `views.json` branch | painter.svelte.ts:239-250 |
| Result name | `result.png` | `result-N.png` | useFile :303; server resultsOf/GET :616-648; Codex :660-667 |
| Capture type | `Capture.uvMask === null` | `uvMask !== null` | painter.svelte.ts:29-30, TexturePanel :129, :152 |
| List validity | `camera.json && mask.png` | `views.json` | api.ts:634 `complete` |
A single-view capture can be expressed as a 1-view `views.json`; the whole legacy branch (UI text, resume, bake shader, server fallbacks, `captureView`) can go. Only two old captures (seer) remain on disk and would need a converter or can simply be dropped.

### 7.2 Many mask representations
1. `SurfaceMask.data` (UV layout, <= 2048, soft 0-255) + overlay alpha texture.
2. `padded()` canvas / `uvmask.png` (same data with 3-texel gutter spread).
3. `paddedTexture` DataTexture (same pixels again) used only to render view masks.
4. `view-N-mask.png` + in-memory `CaptureView.mask` canvas (screen space, per view, gap-closed).
5. Legacy `mask.png` (screen-space drawn mask).
6. Fill's `<clean>.mask.png` (red hole mask, UV, 1024).
7. Dead screen-space `Analysis`/`edges` model in selection.ts.
Redesign hint: one UV-space mask asset (+ derived per-view masks computed on the fly or at capture).

### 7.3 Fill vs. projection painting, and texture saving paths
- Two unrelated pipelines produce the same artefact (a PNG override in `textures/`): fill (Blender, from the *source* file, ignoring existing overrides, full-image), Keep (browser canvas -> PUT). Both end in `refreshOutputs`, but with different modes (`direct` flag): Blender re-import vs in-place byte swap. Fill/Restore pay a full Blender inspect + joint/stat/thumbnail refresh (and can reset non-edited joints to auto-detected, api.ts:86) just to change pixels; Keep does not.
- They overwrite the same file name, so fill and paint cannot be separated or undone individually. `Restore` is all-or-nothing; there is no stack of texture versions.
- The UI hides "Find and fill holes" once `painted` (TexturePanel:79), but nothing forces filling before painting; a character with holes can be painted first and then never filled (or the fill re-reads the original source and would drop the paint if it were allowed to run).
- Hole detection only works for Tripo-style magenta; the fill is conceptually a mask+inpaint (could be just another mask source for the projection pipeline: "mask = magenta texels" -> repaint, or the same 3D diffusion run in the browser/server).
- Three server job kinds touch textures (`texture` for fill/save/restore, `codex`, `inspect`), all through the global 3-slot queue.

### 7.4 Dead / vestigial code
- `src/engine/projection.ts:177-189 captureView` (no callers; legacy capture; also writes the legacy file set).
- `projection.ts:374-380 analyzeView` (no callers).
- `src/engine/selection.ts:4-15 Analysis`, `:28-63 buildEdges`, `:65-123 GrowOptions/grow` (no callers; only `colorDistance` and `morph` are used, surfacemask.ts:12). README.md:33 still advertises "edge-aware selection".
- `projection.ts:191` orphan doc comment ("Render passes of just the character from `camera`...") that belongs to `captureFrom` but sits above `closeGaps`; `api.ts:232` orphan one-line doc above the real `refreshOutputs` doc.
- `renderPasses` always renders `depth` and `normal`, saved as `view-N-depth/normal.png` and never consumed (cost: 2 extra render passes + 2 uploads per view and about 1 MB each on disk).
- `view-N-color.png` is used only for the thumbnails (Codex gets flat+mask only, api.ts:661); in the legacy list it gets `color.png` too.
- `texture_fill.py` docstring `[--overrides <dir>]` (:6) is not an argument; `fillTexture` job callback unused `job` param; `saveTexture` unused `job`.
- `projection.ts:406-411 restGeometry` inside `bakeProjection` duplicates the module-level `restGeometry` (:237); the depth vertex/fragment shader strings are duplicated (:243-244 vs :403-404); the projection vertex shader is duplicated across the two bakes.
- `bake.py` is not part of the Texture step at all (only `tools/retopo`); keep out of the new texture design unless retopo is kept.
- Duplicated client helpers: `fitted` (async but sync body, painter.svelte.ts:397), `canvasOf`, `blobOf`; `toPng`/`readPixels` in projection.ts duplicate canvas handling; flipping rows is copy-pasted 3 times (projection.ts:60, :500, :627).
- `TexturePanel` keeps a duplicated `tool` state mirrored from `painter.tool` (:24-25, :106).
- Duplicated "Earlier captures" markup (:91-101 vs :170-180).
- `SurfaceMask.texture` (a DataTexture the mask draws from) vs `paddedTexture()` DataTexture vs `padded()` canvas: three copies of the same data per capture.

### 7.5 Overlap with other steps
- Magenta hole fill is arguably an Import-time cleanup (inspect already re-imports with overrides), not a Texture step peer of painting.
- Painting visuals depend on Outfit (clothes share the body texture only by coincidence of identical `map`); garments with their own texture are not paintable.

---

## 8. Rough edges

### 8.1 Probable bugs / risks (by reading)
1. **Painter goes stale after Keep or any model reload.** `viewer.sync` reloads the model on every `revision` bump (Viewport.svelte:37-46; viewer.svelte.ts:76-98 disposes the old `CharacterView`), but `painter` is never told: `active` stays true; `SurfaceMask`, the raycast `targets`, `view`, `stage` captured in `attach()` (painter.svelte.ts:81-88) point at the disposed view. After Keep (which bumps revision via `refreshOutputs`) brushing silently does nothing (hits are on new meshes not in `targets`, :96), until the user clicks Done painting and Start painting again. The same happens when a fill/restore/outfit/props change reloads the viewer while painting, or when another character is selected (TexturePanel is not destroyed on character change, so `painter.stop()` is not called and `painter.capture`/mask refer to the previous character).
2. **Mask overlay stays hidden after stacking.** `layerPreview` (:179-185) sets `previewing = false` but never calls `mask.show(true)`; `discard()` re-shows only `if (previewing)`. After "capture again while previewing" or opening another capture, the mask remains invisible although painting is enabled again.
3. **"No unpainted areas found" appears after Keep without a scan** (`saveTexture` writes `images: c.texture?.images ?? []`; coverage = max over empty = 0 < 0.0005, TexturePanel:74). Misleading; also stale "Filled areas" thumbnails remain after painting.
4. **Silent no-op texture save**: if `texture.name` is empty or does not clean to the GLB image's name, `swapImages` matches nothing (returns 0) and the UI says "Painting applied" (painter.svelte.ts:370, glbimages.ts:37). The server never validates that an image changed.
5. **Race with rigging**: `texture` jobs and `rig` jobs are independent queue entries (concurrency 3). A Keep while a rig job runs is lost from the new `rigged.glb` (the rig imported textures before) or `publishRig` overwrites the swapped file.
6. **Fill/Restore side effects**: both call `runInspect(keepEdits=true)`, which re-detects `autoJoints`, resets `joints` unless `jointsEdited`, replaces stats, bumps `revision`, clears the thumbnail (api.ts:81-94). A texture-only change can touch rig placement data if markers did not set `jointsEdited`.
7. **Partial-regeneration mix**: `resultsOf` accepts any existing `result-N`, so re-running Codex can preview a mix of new `result-1` and old `result-2/3` (polling sees max mtime change as soon as the first file lands); and the Codex success check passes on stale files.
8. **Polling is unprotected**: `check()` is called from `setInterval` with `void` and no catch (painter.svelte.ts:279, :287-298); a server error is an unhandled rejection every 2 s. The Earlier-captures list refreshes only when `painter.capture` changes, so "Waiting for result" labels go stale.
9. **Texture-name coupling to Blender**: `cleanName` (client), `cleanImageName` (glbimages), and `bpy.path.clean_name` (Blender) must stay identical (three places).
10. **Only the first color-mapped material is paintable** (`paintTarget`, projection.ts:18-31). A model with several textures cannot paint others; and `texture_fill` fills every image node but the UI shows only one total percentage (max).
11. **Fill ignores existing overrides** (reads the original source, api.ts:265) and discards texture alpha (`out[..., 3] = 1.0`, texture_fill.py:214).
12. **No gutter dilation after bake**; mip bleed of old colors at island borders is possible (5.4).
13. **Large canvas**: bake renders and reads back at the texture's full size (4096 or 8192 possible; a 22 MB PNG exists in the workspace), `toBlob` PNG encode on the main thread, 512 MB upload limit; and that full PNG is embedded in `rigged.glb` and `model.glb`.
14. **Mask edits cost**: every dab re-uploads the full RGBA array (surfacemask.ts:108-113) and `any` scans the whole mask (`some`); `dab` uses a linear-scan heap. Fine at normal sizes; potentially slow for 2048 masks and large brushes.
15. **Alt/Shift semantics are invisible**: only mentioned in tooltips/help; no touch/pen support beyond pointer events; no undo for strokes (Clear and Invert are the only recoveries).
16. **Planning vs capture frames differ**: planning uses bind-pose geometry, capture renders the displayed pose (the animator is stopped, but a posed mesh from the Rig step's test clip could differ). The masks and bake use rest geometry, so a posed capture projects with a mismatch (by reading; the animator stop probably returns to rest).
17. Hard-coded caps in `planViews` (6 views, 256 px depth, 48 directions) and a fixed 1024x1024 capture make fine detail (faces, eyes) low-res (the real prompt in `result-1-prompt.txt` is about fixing an eye).

### 8.2 Confusing UI / discoverability
- Naming drifts: "Unpainted areas" / "holes" / "Find and fill holes" / "Filled areas (texture layout)"; "Projection painting" / "Start painting" / "Done painting" / job label "Apply painting" (api.ts:599) / "Keep"; "captures" / "projections" (folder, API) / "Repaint request" (prompt title); "Select region" (wand tooltip) vs "wand"; "Mask the area" vs "mask tools"; Restore button says "original texture" but also removes painting.
- Step 1 is 6 controls + 4 buttons; tool descriptions are long single sentences; the tool tooltips are the only place Shift/Alt are explained (smart tooltip mentions Alt only).
- Steps 2 and 3 are separate but nothing says that prompt notes are frozen at capture time; edits afterwards have no effect; notes are not restored on Resume.
- "Earlier captures" appears in two places with the same markup and differing helper text; items show "Waiting for result" for failed captures forever; no delete.
- Result thumbnails are never shown; the user must trust the preview on the model. The views grid shows `color` renders, not the `flat`+mask Codex actually receives, so the user cannot see the mask per view.
- "Use an image..." only for 1 view; multi-view manual path is "Open folder" (Linux-only `xdg-open`) with no feedback besides the 2 s poll text.
- Keep is destructive of the previous painted/filled file and has no undo besides "Restore original texture", which also removes the fill.
- Start painting is disabled with no reason shown (status/kind rule, :90).
- `window.confirm` for Done painting (inconsistent with the app's other confirmations, by contrast not checked).
- Mask-tool buttons use native `title` instead of the app `tooltip` action used by `Segmented`.
- Brush Size is screen pixels but the tolerance and grow step have no units; grow/shrink fixed 3 texels (texture-layout, so the visible size depends on UV scale).
- The viewport is forced to Shaded and not restored on exit.
- No progress UI for the long synchronous parts of capture (JS loops, per-view uploads of 5 PNGs); `busy` shows only a label.

### 8.3 Naming/structure inconsistencies in the API
- `POST /texture/fill` (fill), `DELETE /texture/fill` (restore everything), `PUT /textures/:name` (save), `GET|PUT /projections...`, `POST /projections/:id/codex`; singular vs plural and "fill" overloaded for restore.
- Projection upload route is a generic file writer (any of 5 extensions) rather than a capture-level operation; the capture is 8+ round trips and is not transactional (failed capture leaves partial folders; they are hidden by `complete` only when `views.json` is missing).
- Job `kind: 'texture'` covers fill/save/restore; the panel can only observe one job per character (`jobFor`).

### 8.4 Legacy / stale comments
- painter.svelte.ts:7-8 "Captures from before (one view, a mask drawn on that view) still open and bake as they did."
- projection.ts:1-2 file header describes only the single-view design; `bakeProjection` doc (:382-386).
- README.md:22, :33 mention "edge-aware selection" for the removed screen-space tools; `docs/` has no texture document; HANDOFF.md does not cover the Texture step (it is about rigging/naturalization).
- api.ts:652 comment "paint result.png" (now result-N.png).

### 8.5 Test coverage
Only `server/glbimages.test.ts` covers this area. No tests for `planViews` selection logic (pure given quality matrices), mask tools, `closeGaps`, route behaviors, resultsOf matching, or Codex arg building. Several functions are pure and easy to test if split from three.js/WebGL (greedy cover, `nameOf`, `morph`, `colorDistance`, `padded`).

---

## Appendix: file index

| File | Lines | Role |
|---|---|---|
| src/app/steps/TexturePanel.svelte | 212 | whole UI |
| src/app/texture/MaskPainter.svelte | 14 | brush circle |
| src/state/painter.svelte.ts | 439 | workflow state machine, pointer handling, polling, layering, keep |
| src/engine/surfacemask.ts | 390 | UV-layout mask, brushes, wand, padded, samples |
| src/engine/selection.ts | 141 | `colorDistance`, `morph` used; rest dead |
| src/engine/projection.ts | 636 | passes, closeGaps, planViews, two bakes, paintTarget, cleanName |
| server/api.ts | 71, 232-290, 589-703 | jobs, routes |
| server/glbimages.ts | 97 | image swap |
| server/jobs.ts | 117-148 | `runCodex` |
| blender/jobs/texture_fill.py | 233 | magenta fill |
| blender/common/scene_io.py | 50-72, 75-95 | override application on import |
| blender/jobs/bake.py | 164 | retopo color bake (not Texture step) |
