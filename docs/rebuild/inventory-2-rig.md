# Inventory 2: the Rig step (skeleton placement, auto-rigging, weights, hand poses)

Audit date 2026-10-28, read-only. Paths are relative to `/home/ryan/dev/games/rigsmith`. Line numbers are from the checkout at HEAD `36f9295` (clean tree). "Hand-written" means by the owner, not by an agent: per MEMORY.md, only Scout and Villager may be re-rigged; weights on the other characters are hand-fixed (`weight_edits.json`) and must not be altered by any rebuild/migration.

---

## 1. Purpose of the area

The Rig step turns an imported unrigged mesh into a game-ready skinned GLB: it finds or lets the user place a skeleton (Mixamo humanoid at 4 finger levels, or one of 8 creature templates), runs a Blender job that builds the armature and computes skin weights (heat diffusion + region steering + validation/optimization), and then gives the user tools to inspect and repair the result (deformation test clips, weight painting, named hand poses). It also converts an already-rigged import onto the Rigsmith/Mixamo rig. Everything downstream (Outfit, Animate, Export) depends on the bone names, weights and hand poses produced here.

---

## 2. UI surface

### 2.0 Where the Rig step mounts

`src/app/Inspector.svelte:18` renders `RigPanel` when `app.step === 'rig'`. The viewport (`src/app/Viewport.svelte`) hosts the 3D joint editor, joint hover label, the full-screen `MarkerBoard` overlay, the busy spinner, and (for the rig test clips) the Timeline. `RigPanel.svelte` is a four-way state machine:

| Branch (RigPanel.svelte) | Condition | What shows |
|---|---|---|
| Animation-only | `kind === 'animation'` (:134) | A one-line note: "add it from the Animate step" |
| Rigged elsewhere | `kind === 'rigged'` (:136) | Convert panel (SkeletonMapping, Convert button, creature chips) |
| Rigged result | `status === 'rigged' && !rigging && !viewer.adjusting` (:149) | Rig summary, Check deformation, Fix weights, Hand poses, "Adjust joints and re-rig" |
| Placement (default) | everything else (:181) | Body type, Markers, Fine-tune joints, Hand poses (only if already rigged and adjusting), Fingers, Rig character |

### 2.1 Branch A: "Rigged elsewhere" (`RigPanel.svelte:136-148`)

- **Warn card** "Rigged elsewhere (Mixamo): convert it to the Rigsmith rig" with bone count (:138-141).
- **`SkeletonMapping`** (`src/app/steps/SkeletonMapping.svelte`, shown only when `rigPreset !== 'mixamo'`, :142). Sits in `steps/`, not `rig/`.
  - Status line "N of M core bones mapped to Mixamo" + Edit/Hide link (:57-61).
  - Auto-map button (:66), "Apply preset..." select (:67-72), per-bone selects grouped by `MAP_GROUPS` (:74-88), "Save preset" name input + button (:89-92; Enter key saves).
  - Auto-maps silently on first sight via an `$effect` (:29-31) that writes `boneMap` and calls `animator.rebind()`.
  - Backing: `api.skeletonPresets()` / `saveSkeletonPreset` -> `server/api.ts:675-689` (`workspace/presets/skeletons/*.json`); engine `src/engine/presets/skeletonMap.ts` + `presets/automap/*` (Mixamo, Rigify, Mesh2Motion, canonical mappers).
- **"Convert to the Rigsmith rig"** primary button -> `convert()` (:62-82): reads world positions of the 65 Mixamo bone names off the loaded rest skeleton, requires 16 core bones, infers the finger level (`full`/`two`/`one`/`none`), calls `api.setTemplate(id,'human',joints,level)`, then toast "place the markers, then Rig character".
- **"Not a person? Rig it with a template"** chips (:145-147), one per non-human `BODY_TYPES` -> `chooseBody(id)`.

### 2.2 Branch B: rigged result (`RigPanel.svelte:149-180`)

Section "Rig":
- Green OK card: "Rigged with the Mixamo/<creature> skeleton" + seconds + finger hint or bone count (:151-154).
- One warning row per `rigReport.warnings` (:155) (retained previous weights, painted vertices put back, optimizer failure, "Placements changed during rigging" etc.).
- **"Pick animations"** primary button -> `app.step = 'animate'` (:156).

Section "Check deformation" (:158-175):
- Test-clip chips from `static/templates/tests.json` (human: 8 Mixamo clips; horse: 8 bundled clips; no other body type has any, :166). Click -> `animator.playTest(t)` (in place, looped). Active chip highlighted by `clipId`. "Stop" chip when a test is playing (:164).
- Three static hint paragraphs (:167-168).
- Bone-influence chips (humans only, hidden by CSS class for creatures :169): Head, Spine2, LeftShoulder, LeftArm, LeftForeArm, LeftHand, Hips, LeftUpLeg, LeftLeg, LeftFoot, each switches viewport to Weights mode and highlights that bone (`viewer.character.setHighlightBone`); "All" clears it (:170-173).

Then (mesh only) `WeightPaintPanel` (:176), (humans only) `HandPosesPanel` (:177), and a ghost button **"Adjust joints and re-rig"** (:179) -> `adjust()` (:126-131): stops playback, sets `viewer.adjusting = true`, rebuilds the 3D editor; the panel then falls into Branch C while the rig stays until the next rig replaces it.

### 2.3 Branch C: placement / re-rig (`RigPanel.svelte:181-260`)

**Section "Body type"** (:182-187): 9 chips (Humanoid, Horse, Fox, Bird, Dragon, Kaiju, Spider, Snake, Fish; `templates.ts:79`). Click -> `chooseBody()` (:38-59):
  - creature: server `POST /fit-template` (medial skeleton fit via `tools/creature_fit.py`), falling back to client `fitTemplate()` bounding-box fit; then `POST /template`.
  - human from a creature: `POST /template` with no joints (server restores `autoJoints`).
  - human on a `rigged` character: runs `convert()`.
  - Footnote text for creatures (:186).

**Section "Markers"** (:189-217):
- Intro text varies by view (front/side) and by human/creature (:190).
- `markerBoard.missing` text when the body has no marker set ("No markers for the X body yet: drag its joints instead", `markers.svelte.ts:32`).
- Legend (2-column grid): one row per body marker with colour swatch + letter; click selects the marker, switches the board to the body view and opens it (:194-198). Shows "· no joint" when the marker's joint does not exist.
- "Mirror left and right" toggle (`markerBoard.mirror`; shown only for front-view sets, :200).
- **"Place markers" / "Done with markers"** toggle button (:202), **"Start again"** (clears saved markers, remounts the board, :203; `resetMarkers` :94).
- Finger-tip sub-block (only when the set has hand markers whose joints exist): label, legend rows (each opens the right-hand view, :209), **"Place finger markers" / "Done with fingers"** (:214).

**Section "Fine-tune joints"** (:219-239):
- Text + "Mirror left and right" toggle (local `mirror` state mirrored to `viewer.setMirror`, :221).
- Joint chip groups from `groups(fingers)` (`mixamo.ts:55`): Spine & head, Arms, Hands (finger joints, left side only), Legs. Humans only (hidden by CSS for creatures, :222). Click selects the joint in the 3D editor (`viewer.editor.select`) which highlights it and shows its label in the viewport.
- "Reset to detected joints" (when `jointsEdited && human`, :234) -> `resetJoints()` (:115) sets `joints = autoJoints`; or "Refit template" (creatures, :237) -> `chooseBody(template, true)`.

**HandPosesPanel** mounted again here when `human && status === 'rigged'` (:241) (i.e. during Adjust).

**Section "Fingers"** (humans, :242-252): 4-way `Segmented` None/1/2/All (`fingerOptions` :23-28; hints say 25/33/41/65 bones) -> `setFingers(level)` (:102-113) -> `POST /fingers`; explanatory text; **"Detect fingers again"** (:247) -> `setFingers(level, true)` (`redetect`), hidden at None.

**Primary "Rig character"** (:254-259): disabled with no joints or while fitting fingers; shows job message while rigging; caption "Builds the rig and checks its weights against the deformation tests before replacing your previous rig." -> `app.rig(id)` -> `POST /rig`.

### 2.4 Viewport interactions (Rig step)

| Interaction | File | Notes |
|---|---|---|
| Orbit/pan/zoom camera | `src/engine/Stage.ts` (controls) | Disabled during joint/ring/brush drags; `stage.covered` rests it under the marker board |
| Display mode toolbar: Shaded / Clay / Weights / X-ray | `Viewport.svelte:78-85,93` | Shared by all steps. Joint editor auto-forces X-ray if mode is Shaded (`viewer.svelte.ts:131`). Painting forces Weights (`paint.svelte.ts:73`) |
| "Show bones" toggle | `Viewport.svelte:95` | Draws the rig's skeleton helper |
| "Frame character (F)" | `Viewport.svelte:98,133` | Only keyboard shortcut in the viewport |
| **3D joint editor** (`JointEditor.ts`) | `viewer.svelte.ts:109-133` | Present when step is rig, kind mesh, joints exist, and (not rigged or adjusting). Spheres (blue left, pink right, yellow centre; finger/leaf/tip/ear/teeth markers 0.55 scale, `JointEditor.ts:70`), white lines for bones. Hover grows/highlights marker (picking is screen-space nearest within 14px, :147-161) and shows joint-name label (`Viewport.svelte:64-73,103-107`). Left-drag a joint on a camera-facing plane (:163-197). Mirror: partner moves to `2*centerX - x` and centre joints are clamped to the symmetry plane; with mirroring on, right-side spheres are hidden (`sync` :124-128). On release, `commit` saves `{joints, jointsEdited:true}` via PATCH (`viewer.svelte.ts:128`) |
| **Marker board** (full overlay) | `MarkerBoard.svelte` | See 2.5 |
| **Weight brushes** on the body | `paint.svelte.ts` | See 2.6 |
| **Hand pose rings** | `HandDots.ts` via `HandPosesPanel.svelte:20-27` | See 2.7 |
| Test clip timeline (play/pause/scrub) | `Viewport.svelte:94`, `animate/Timeline.svelte` | Shown in Rig when a test clip is current. Shared Timeline keyboard shortcuts (arrows, Home/End, Space, `,` `.`) |

Keyboard shortcuts owned by this area: `Esc` closes the marker board (`MarkerBoard.svelte:361`, ignored mid-drag); `F` frames (shared); `Alt` while using the Heal "area" brush unmarks (`paint.svelte.ts:111`); `Enter` in the skeleton preset name field saves. There are no shortcuts for undo (Undo is a button only), for tool switching, brush size, or nudging joints.

### 2.5 Marker board (`src/app/rig/MarkerBoard.svelte`, 428 lines; state `src/state/markers.svelte.ts`)

Full-viewport overlay (z-index 5) with its own WebGL renderer and orthographic camera:
- Clay copy of the mesh at rest, hemisphere + key light (:46-62). Camera: front view (from +Z) for humans, side view (from +X, head on left) for horses (`placeBody` :146-160), or a **hand view** (back of the hand, fingers up, cut to a slab around the hand; `handView` :94-119, `flattest` :65-91 estimates the palm normal by PCA on nearby vertices).
- SVG overlay: skeleton lines (dashed/faded for the far side on a side view), joint dots, and draggable **markers**: colour disc + halo + letter (pairs on front view get A=right, B=left; horse legs F/H letters), hover tooltip via foreignObject with name + hint (:385; `nameOf` :293).
- Tabs "Body / Right hand (A) / Left hand (B)" (only when the character has fingers, :391-397; `hasHands` :41).
- Hint text bottom-left (:398), close X button top-right (:399), Esc to close.
- Drag: `pointerdown` captures, `move` queues one update per animation frame (:310-315), dot follows pointer in the view plane (`inPlane` :215), the rest of the skeleton updates only on release (:323); on release `toBody` (:169-196) raycasts the mesh to set depth (middle of the first stretch of body under the ray, `insideDepth` in `markers.ts:439`; side-view pairs take the near side), `solveNow()` runs the ARAP solve, then `app.update({markers, joints, jointsEdited:true})` and "Fitting the skeleton" spinner (:325-349).
- Mirror: `markerBoard.mirror` mirrors a moved front-view pair (`placeMarker` `markers.ts:403`); on hand views the hint says "the other hand follows, mirrored" (:398) but there is no separate mirror logic in the hand case beyond the same toggle.
- Re-fits itself when `character.joints` changes while open (e.g. a finger level switch): `$effect` :235-243 calls `fitMarkers`.
- Marker definitions: `static/templates/markers.json` (human: 12 markers = chin, shoulder, elbow, wrist, groin, knee, ankle + 5 finger tips; horse: 14 markers on a side view; no other creature has a set).

### 2.6 Weight painting (`WeightPaintPanel.svelte`, `paint.svelte.ts`, `weightpaint.ts`)

Panel (shared with the Outfit step, `OutfitPanel.svelte:412`, via the `garment` prop):
- **"Paint weights" / "Done painting"** toggle (`:54`); text for garments "Paint <name>'s weights".
- Tool chips (:34-41,60-64): **Heal** (`area`), **Add**, **Remove**, **Smooth**, **Follow**, **Bone** (`rigid`). Tooltips carry the explanation.
- "Bone under the brush" readout for the Bone tool (:67).
- **Bone selector** for Add/Remove (:70-74); bones list excludes `end|leaf|tip` names; for a rigid prop with pulls it lists "Rigid (the prop itself)" and each pull bone (:21-25).
- **Mirror left and right** toggle (`paint.mirror`, :76); not applied for rigid garments (`paint.svelte.ts:69`).
- **Brush** radius slider 0.01-0.15 (share of body height) (:77); **Strength** slider 0.05-1 (hidden for Heal, :78).
- Heal row: **"Heal N points"** and **"Clear"** (:79-84).
- **"Left -> right" / "Right -> left"** whole-side copy (:85-88; `copySide` `weightpaint.ts:166`).
- **Undo** (single-step stack of strokes, :90) and **"Save N points"** (:91).
- Footnote with **"Forget the painting"** link (:94-96): body -> `DELETE /weights`; garment -> `DELETE /garments/:gid/weights`.

Viewport behaviour (`paint.svelte.ts:59-141`): a magenta ring follows the cursor on the posed surface (surface-distance brush, `weightpaint.ts:195`); left-drag on the body paints and stops orbit, off-body drags orbit; `Alt` while marking unmarks; hover with Bone tool shows/ highlights "bone under brush" and previews it in Weights mode; the area mask is shown in pink in Weights view; painting happens on the body as posed (a paused test clip), so you pause a test clip on a bad frame and paint. Tools:

| Tool | Behaviour (`weightpaint.ts`) |
|---|---|
| Heal (`area`) | mark skin (brush adds, Alt removes), then harmonic refill from the unmarked boundary (400 Jacobi iterations; closed selections left alone) (:247,460) |
| Add / Remove | raise/lower one bone's weight under the brush, share goes to others (:259,272) |
| Smooth | blend with neighbours (:300) |
| Follow | take the weights of what's under the brush: skin covered by the part (legs under a coat) or nearest bones (:317,401) |
| Bone (`rigid`) | paint skin onto the one bone leading at stroke start, dropping other influences (:366,377) |

All edits keep max 4 influences, normalized; vertices split at UV seams are one "point"; mirror twins found across the hips at rest (`twins` :537).

### 2.7 Hand poses (`HandPosesPanel.svelte`, `handposes.svelte.ts`, `HandPoseSelect.svelte`)

Humans only; shown after rigging (Branch B, and again inside Adjust). Section "Hand poses":
- **New**: `+ Grip` (default fist as a pose, `addFist(undefined,'Grip')`, :36), `+ Blank` (rest, :37), "From a fist..." select of `FISTS` (5 Mixamo grips from `animator.svelte.ts:43`) (:38-41).
- Explainer paragraph (:44-47) and an empty state (:48-51).
- Pose list: click row to open/close the editor; **share** toggle (users icon; share with every character through `settings.handPoses`); **delete** trash. Shows "from <clip> at <t> s" or "made by hand".
- "Shared by other characters" list with "+" to add (:66-75).
- Editor (when a pose is open, :76-104): name input; "Shown on" Left/Right segmented (`setSide`); hint; **Natural limits** toggle (`handPoses.natural`, clamps every joint to ROM measured from the library, `limits.ts`); **Whole hand** open<->fist slider (0-1.3); one slider per finger (Thumb..Pinky) (:87-97); caption; **Done**.
- **Viewport rings** (`HandDots`): while a pose is open, a ring sprite on every finger joint past the knuckle and on tips; dragging a ring turns the joint behind it so the finger points at the pointer (`handdots.ts:111-134` -> `handPoses.turnJoint`); applies natural limits live; saved 400 ms after the last change (`show` :205).
- The pose previews by playing a synthetic one-frame "Hand pose: X" clip (`animator.playHandPose` `animator.svelte.ts:281`), which also keeps the Rig step's clip playback alive (`viewer.svelte.ts:103`).
- `HandPoseSelect.svelte`: small `<select>` reused by Outfit (carry pose, pull pose; `OutfitPanel.svelte:362,389`) and Animate edit (`EditPanel.svelte:127,151`): Default fist / Open / this character's poses / shared poses / the 5 fists. Selecting a shared pose copies it onto the character.
- Animate step's "Send hand pose" (`AnimatePanel.svelte:145-146`) calls `handPoses.capture(side)`, saving the posed hand into this list. So the Hand-poses data is authored in three steps (Rig, Animate, Outfit) but the only management UI lives in Rig.

### 2.8 Other Rig-adjacent UI outside RigPanel

- `ImportPanel.svelte:93-95`: shows `rigReport.warnings`; `:100-103` "Rig this character" button jumps to the Rig step; labels like "Auto-rigged", "Rigged character", preset label (Mixamo / Tripo auto-rig / Rigify / Unreal / Unknown).
- `JobsPopover`/`Viewport` busy spinner show the rig job's progress and message (`Viewport.svelte:117-123`).
- `HistoryPanel`/journal: joints/markers/fingers/weights changes are recorded in `server/journal.ts`.
- CLI `tools/rig.ts`: `set WHO joints|markers|fingers|handPoses|boneMap JSON` can write the same PATCH, but there is no `rig`, `weights`, or `fingers` command (see 8).

---

## 3. User workflows

### 3.1 First rig of an unrigged humanoid
1. Import (`inspect.py` runs landmark detection and stores `joints` + `autoJoints`, finger level `full`; warns if detection fails).
2. Open Rig. Branch C shows. The model goes X-ray with the 3D joint editor active.
3. Optional: **Place markers**. Board opens at rest, front view. Drag the 7 body markers onto chin/shoulders/elbows/wrists/groin/knees/ankles (pairs mirrored). On release the whole skeleton is re-solved and saved.
4. Optional: **Place finger markers**; switch Right/Left hand tab; drag each of 5 tips to the end of its finger. Tips on a hand are laid out as chains (`layHands`).
5. Optional: **Fine-tune joints** in 3D: drag any sphere, mirrored. Saves on release.
6. Optional: choose finger level in **Fingers** (default All).
7. **Rig character**: `POST /rig` -> `runRig`. Progress in the viewport spinner. On success the panel flips to Branch B.
8. Check deformation (click a test clip), view Weights, press "Pick animations".

### 3.2 Adjusting joints and re-rigging
1. In Branch B press **Adjust joints and re-rig**: playback stops, `viewer.adjusting=true`, the markers and the 3D editor reopen on the rest body.
2. Edit markers / joints / finger level as above (finger changes call `/fingers`, a Blender `--placements-only` job).
3. **Reset to detected joints** returns to `autoJoints` (does not reset markers; the board re-seeds if they no longer match, `markers.ts:93`).
4. **Rig character**. The server builds a new GLB beside the old; maps saved painting onto the new surface; compares with the previous weights on deformation tests; optionally runs the PyTorch optimizer; publishes atomically. Painted weights are written back.

### 3.3 Finger levels
- Select None / 1 / 2 / All. `POST /fingers {fingers, redetect}` removes index-chain joints when switching to/from `full` (index means "centre of the mitten" at lower levels and a real finger at full), optionally removes every finger joint (`redetect`), runs `rig.py --placements-only` (which calls `complete_joints`: fill missing joints, trace fingers on the mesh at the edited wrists, reduce to level) and replaces `joints`; marks `jointsEdited=true`; strips stale markers for the index. The board, if open, refits.
- **Detect fingers again** is the same call with `redetect=true`.
- Finger count affects bone count (25/33/41/65) and which animations' fingers play (extras ignored).
- Re-rig with `fingers=full` but no `LeftHandMiddle1` joint drops the index chain (`api.ts:131-136`), duplicating `/fingers`' logic.

### 3.4 Painting weights
1. Rig first (paint requires `rigged.glb`, kind mesh).
2. Play a test clip and pause on a bad frame (or paint at rest).
3. **Paint weights**, choose tool. Heal: brush to mark, brush with Alt to unmark, **Heal**. Add/Remove: choose bone, brush. Smooth/Follow/Bone as needed. Mirror on by default; "Left -> right" for whole-side copy.
4. **Undo** steps strokes back; **Save N points** -> `PUT /weights`: writes `JOINTS_0/WEIGHTS_0` into `rigged.glb` in place and merges into `weight_edits.json` keyed `mesh:vertex`; bumps `revision` so the viewer reloads.
5. A later re-rig maps the painting through geometry changes (`mapPainting`) and writes it back last so authored paint wins over every automatic choice.
6. **Forget the painting** clears `weight_edits.json` to `{}`; the live GLB keeps the painted weights until the next rig.

### 3.5 Hand poses
1. Rigged human. Hand poses section: `+ Grip` (or `+ Blank` / from a fist).
2. Pose opens: choose hand, drag rings or sliders; Natural limits keeps joints within measured ROM.
3. Share across characters (optional). Delete or rename.
4. Used by Outfit (prop carry pose per socket; pull pose), Animate edit (per-hand fist), and by `scripts.ts` hand scripts. From Animate: "Send hand pose" captures the hand on the current frame of the playing clip.
5. Poses are stored as per-joint turns in the joint's own frame (rest-relative), so they survive re-rig; the other hand uses a mirrored copy.

### 3.6 Converting a pre-rigged model
1. Import detects `kind: rigged` and a preset (`blender/common/rigs.py detect_preset`).
2. Rig step Branch A. If not Mixamo, edit the bone map (auto-map runs on first view; presets can be saved/applied).
3. **Convert to the Rigsmith rig**: joints read from the existing skeleton, `kind` flips to `mesh`, `files.rigged` cleared, `template=human`, `autoJoints=joints`. Skin/weights of the original are discarded (the mesh is kept; `rigged.glb` removed from the record).
4. Continue as 3.1 (place markers, Rig character). `boneMap` stays on the record but is only used for retargeting animation onto a still-foreign rig (Animate/export).
5. Alternatively "Not a person?" chips: set a creature template (fit from the mesh).

### 3.7 Creature templates
1. Click a body-type chip (Horse, Fox, Bird, Dragon, Kaiju, Spider, Snake, Fish).
2. Client asks the server to fit the template along the mesh's medial skeleton (`creature_fit.py`, python venv); on failure it falls back to the bounding-box fit in `templates.ts:106`. Animations are cleared (a different skeleton family can't play the previous set's clips), markers deleted.
3. Horse has a marker set (14 markers on the side view); all others "drag its joints instead" in 3D. No chip list for joints on creatures (`groups` hidden), so joint selection is by clicking spheres only.
4. **Rig character** with `--template`: uses plain bone-heat weights (`method='heat'`), no region steering, not pose-optimized (unless `RIGSMITH_OPTIMIZE_CREATURES=1`), horse also compares a native-heat alternative. Only horses have deformation tests.
5. **Refit template** re-runs the fit.

---

## 4. Data model (fields this area owns)

`server/workspace.ts` `Character` (persisted as `workspace/characters/<id>/character.json`). The generic `PATCH /api/characters/:id` accepts a whitelist (`api.ts:318`): name, joints, jointsEdited, markers, fingers, animations, scripts, props, garments, mount, skins, boneMap, handPoses. `template`, `autoJoints`, `rigReport`, `status`, `files.rigged` are set only by dedicated routes/jobs.

| Field | Written by | Purpose |
|---|---|---|
| `kind` ('mesh' / 'rigged' / 'animation') | import job (`runInspect` :74), `POST /template` (rigged -> mesh) | Selects the Rig panel branch |
| `rigPreset` | import job; cleared by `/template` | Which foreign rig (mixamo/tripo/rigify/unreal/unknown) |
| `status` ('ready' / 'rigging' / 'rigged' / 'error') | rig job, `/template` (rigged -> ready), import | Panel branch; blocks paint/forget while 'rigging' |
| `joints` (bone -> [x,y,z], glTF space, Y up, +Z forward) | import detection, markers, 3D editor, `/fingers`, `/template`, rig job result, resize | The skeleton to build; input to `rig.py --joints`. Rig job overwrites it with the Blender-final joints if unchanged during the job |
| `autoJoints` | import detection, `/template` (convert), resize | What "Reset to detected joints" returns to. On a convert it is the foreign skeleton's positions |
| `jointsEdited` | any manual edit, `/fingers`, convert | Gates the "Reset" button; makes re-import (`keepEdits`) preserve joints |
| `markers` {set, base, positions} | marker board | `base`: the joints (and `marker:<id>` own points) the markers were seeded from; `positions`: current marker points keyed `id` or `id_l/_r`. Input to the ARAP solve |
| `fingers` ('none'/'one'/'two'/'full') | `/fingers`, `/template`, import default | Finger level: hierarchy and detection depth |
| `template` ('human' default or creature id) | `/template` | Skeleton family; selects hierarchy, marker set, test clips, weighting method, animation set |
| `scale` | Import -> Size | Re-applied to every import/rig; joints/markers scaled with it (`/fit` :548) |
| `boneMap` | SkeletonMapping | Foreign bone -> Mixamo name, used to retarget animation onto a still-foreign rig (not by rigging) |
| `handPoses[]` {id,name,side,joints{Finger1..3: quat},from?} | Hand poses panel, Animate "Send" | Named finger poses (rest-relative, joint-frame turns) |
| `rigReport` {method, seconds, warnings[]} | rig job; import job sets `{method:'import'}` | Shown in Rig/Import; `method` also exported into the game build metadata (`tools/game_export.ts:869`) |
| `files.rigged` (`rigged.glb`), `files.model`, `revision` | rig job / weights PUT | The skinned result; `revision` bumped to reload the viewer |
| `stats.bones` | import, rig | Bone count shown |
| `error` | failed jobs | Shown in the character list |

Files in `workspace/characters/<id>/`:
- `rigged.glb` (live skinned result; also patched in place by weight painting and by the optimizer).
- `weight_edits.json` (`{ "mesh:vertex": {mesh, vertex, weights:[[bone,w],...]} }`): authored paint, re-applied after every re-rig. Hand-fixed weights on non-Scout/Villager characters live here and in the GLB and must never be regenerated.
- `joints.json` (temp input to the rig job), `finger-joints-*.json` (temp), `rigging-*.glb`, `*-heat.glb`, `*-before-optimize.glb` (temp candidates; cleaned in `finally`).
- Garments' `garments/<id>/weights.json` (Outfit painting; same panel, separate store).

Global:
- `settings.handPoses` (shared poses).
- `workspace/presets/skeletons/*.json` (saved bone maps).
- Static data: `static/templates/{horse,fox,bird,dragon,kaiju,spider,snake,shark}.json` (joints, parents, order, mirror, meshBox, animations path), `markers.json`, `tests.json`, `rom/{human,human-pose,human-twohand,horse}.json` (only `human.json` is read by this area), `static/animations/*-animations.glb` (creature clips), `blender/autorig/reference/ybot_frames.json` (bone roll reference).

Client-only state (`src/state`):
- `markerBoard`: open, selected, mirror, busy, view, forId, setName, set, parents, missing.
- `viewer`: editor, selectedJoint, hoveredJoint, mirror, adjusting, mode, skeleton.
- `paint`: active, tool, bone, radius, strength, mirror, boneUnder, edited, marked, busy, busyText, garment (+ private WeightPainter).
- `handPoses`: editing, side, natural, ref (reference grip), limits.
- Local component state in RigPanel: `fingers`, `mirror`, `choosing` (unused), `fittingFingers`, `testSets`.

---

## 5. Algorithms and jobs

### 5.1 Joint detection (import time; also `complete_joints` fallback)
`blender/autorig/landmarks.py`, `skeleton.py`, `raster.py` (+`jobs/inspect.py:73-88` calls it on import):
- `Silhouettes` (landmarks.py:14) rasterizes front/side/depth silhouettes of the mesh (Blender frame: Z up, faces -Y, left = +X). `detect_legs` (:82), `detect_arm` (:131), `arm_axis` (:184), `detect_markers` (:199) find hand tips, wrists, armpits, crotch, feet, head top, limb centrelines for an A or T pose.
- `skeleton.build_joints` (:143) turns markers into the 25-bone layout by proportions calibrated against Mixamo's own rigs of Tripo characters (constants `SHOULDER_ABOVE_ARMPIT`, `ELBOW_RATIO`, ...; chin notch regression, `_chin_notch` :236, head width fit), symmetric arms (`symmetric_arm_joints` :123), spine placed at front + depth bias (:152-157).
- Fingers placed from hand frame (`hands.measure_hand`) via `FINGER_LAYOUT` (`_add_fingers` :287) or, when traced, by `detect_finger_joints` (:308).
- Output: `{bone: [x,y,z]}` in glTF space. Failure (non-humanoid pose) leaves `joints` undefined with a warning.

### 5.2 Hand measurement and finger detection
`hands.py`: `measure_hand` finds hand direction/length/palm/thumb from the mesh around the wrist (`_flood`, `_adjacency`); `assumed_palm` fallback; `symmetric_hand` averages the two hands.
`fingers.py`: `detect_fingers` (:122) builds a graph of the hand region (welding UV seams, `_graph`), geodesic distance from the wrist (`geodesic` :38), merge tree of the distance field (`merge_tree` :56: fingertips are births, merges are where fingers join the palm), `centerline` per finger, thumb = branch joining nearest the wrist, others ordered across the palm (`label_fingers` :141). `finger_chains` (:241) places 4 joints per finger along each centreline using `ANATOMY` fractions (knuckle at 0.56-0.59 of the tip reach, middle joints at 0.36/0.69-0.71). `space_evenly` (:274) evens knuckle spacing across the palm. `hand_fingers` (:332) is the entry and returns `{}` unless exactly five fingers are found.
`skeleton.fit_finger_level` (:334) reduces five-finger results to a level (mitten levels average the four fingers into the Index chain). `complete_joints` (:352) fills only missing joints (core via detection if absent, fingers traced at the *edited* wrists).

### 5.3 Marker solve (TypeScript, client, live)
`src/engine/markers.ts`:
- `seed`/`fitMarkers` (:69,93): markers start on their joints (own points like `groin` are seeded by raycasting up from the ground, `MarkerBoard.seedOwn` :199, else mean of `attach` joints). `fitMarkers` migrates saved markers to the skeleton as it is now (finger-level change adds/removes bones; legacy boards from before whole-finger fitting are upgraded or re-seeded, :95-109).
- `solve` (:214): as-rigid-as-possible deformation of the base skeleton graph with pinned markers. Global step: Cholesky solve of `L x = b` (dense, pin weight 1e4, +1e-6 regularization) per axis; local step: per-node rotation by Horn's method via power iteration (`bestTurn` :159). 16 iterations by default, warm-started rotations and cached factorization while dragging (`SolveCache`). With a `depthAxis` the shape is fitted in the view plane only and depth is blended afterwards (:221-224,280-287), otherwise a plane-pinned system tips chains through depth.
- `pinsOf`/`edgesOf` (:130,148): on a side view each pair's near marker pins its far partner mirrored across `xCenter`.
- `jointsFrom` (:294): solve, then `layHands` (:350) lays the four long fingers of each full hand using a ported copy of the Python ANATOMY (:344) so the knuckles stay on the palm and even across it, then a generic per-finger rigid refit between wrist and tip for others (:304-338).
- `placeMarker` (:403): mirrors pairs on a front view; moving wrist/elbow rigidly carries that hand's tip markers.
- Depth: front view markers get z from `insideDepth` of the ray (middle of first body interval), `depth:'keep'` markers (chin) keep their joint's depth.

### 5.4 Template fitting (creatures)
`tools/creature_fit.py` (server `POST /fit-template`): voxelizes the mesh, skeletonizes (TEASAR), reads branch tips as feet/tail/muzzle/ears, moves the template's legs onto the leg columns, shifts the spine, lays the tail, mirrors L/R; output joints in glTF space or non-zero exit (422) if it isn't a quadruped. Client fallback `templates.ts fitTemplate` maps the template's `meshBox` onto the model's bounding box and symmetrizes. Template data came from Mesh2Motion rigs via `tools/extract_templates.py`.

### 5.5 Rig build and weight generation (Blender job)
`blender/autorig/rig.py` `main()` (:174), launched by `runBlender('autorig/rig.py', ...)`:
1. Import mesh(es) (`common/scene_io`), scale (Import->Size), stand on the floor, strip existing rigs.
2. Joints: template (`--joints` required) / user joints (validated, shifted up if they predate grounding, `complete_joints`) / fresh detection (`detect_markers` + `build_joints`).
3. `validate_joints` (`skeleton.py:13`) rejects collapsed/overlapping parent-child pairs by name.
4. `--placements-only` returns joints only (used by `/fingers`).
5. Humanoid: `palm_normals` (:73) then `build_armature` (:98): Mixamo hierarchy; bone tails point at the main child (hand toward middle knuckle); roll from palm normals (forearm/hand/fingers) else from `ybot_frames.json` reference via minimal rotation; end bones non-deforming. Creature: `build_template_armature` (:138).
6. `weights.skin` (`weights.py:202`):
   - Humanoid (`method='regions'`): `regions.attach` assigns each vertex a region/bone (spine bands, arm chains, clavicle, neck, feet, torso width from the silhouette, fingers via `_attach_hands`), then `heat.diffuse` (Baran-Popovic style bone heat with cotangent Laplacian, welded seams, conjugate gradients, `HEAT=32`), `band_blend` (narrow blend at region borders, `BAND=0.04`), `soft_shoulders` (softer across the arm border), `finalize` (<=4 influences, floor 0.02).
   - Creature (`method='heat'`): `heat.bone_heat` with ray-cast visibility, per-side eligibility (`side_eligible`), then width-adaptive band blend (`CREATURE_BAND`).
   - Tunables are environment variables `RIG_HEAT`, `RIG_BAND`, `RIG_LOCALIZE`, `RIG_SHOULDER_*`, `RIG_CREATURE_*`, `RIG_SIDES`.
7. `--native-output`: a second GLB using Blender's own volume heat (`native_candidate` :257: ARMATURE_AUTO parent, retries failed disconnected islands individually, falls back to the regional weights where missing, then `finalize`). Produced for humans and the horse only.
8. Export GLB; `report.result` returns joints (glTF space), seconds, method, warnings.

### 5.6 Weight selection, validation, optimization, painting transfer (Node, around Blender)
`server/api.ts runRig` (:116-217), in order:
1. Job args include `--joints` (with the mitten/full index cleanup), `--template` for creatures, `--native-output` for humans and horse.
2. **Painting transfer**: read `weight_edits.json`; `mapPainting` (`server/skinopt.ts:173` -> `tools/skin_opt/painting.ts` -> `tools/lib/skintransfer.ts transferPainting`) maps old vertex addresses onto the new mesh via barycentric samples in bind space (tolerance ~0.1% of size; `alignRest` first undoes a pure floor move). Ambiguous or missing -> job aborts, old rig kept. Writes mapped paint into the candidate (`writeWeights`, `server/weights.ts:33`, patches `JOINTS_0/WEIGHTS_0` in the GLB binary chunk in place).
3. **Regional vs native heat**: `validateSkin` (`server/skinopt.ts:162` -> `tools/skin_opt/validate.ts`) compares the candidates on deformation test clips (tests.json; with `deformationTests(true)` extended spread of library clips for validation): per surface island, log-strain RMS and "extreme" edge counts (>2x stretch) at 8 samples per clip. `retainReference` (`selection.ts:162`) keeps the reference when the generated one worsens totals (1.01x), any single test (1.1x), or extreme counts. `selectIslands` (:171) allows island-wise substitution only when every test agrees. Result `{compared, retained, hybrid}`.
4. **Previous rig comparison**: same validation vs the currently published `rigged.glb`, after `transferSkin` maps its weights onto the new skeleton/surface (requires the same bones). Retained or hybrid -> method suffix `+retained-weights`.
5. **Pose-optimized weights** (humans; creatures only with `RIGSMITH_OPTIMIZE_CREATURES=1`; needs PyTorch venv, else skipped): `pose_set.ts` poses the rig through 256 library poses (+ the unit's own clips and the Rig tests via `--with`; held-out list `holdout.json`), `optimize.py` fits weights in PyTorch (edge strain, extreme-strain tail, shell volume, rigid limb regions, smoothness, prior; restricted to each vertex's existing influences; 300 iterations; GPU or CPU), `apply.ts` writes `JOINTS_0/WEIGHTS_0` back. Then paint is re-applied and `validateSkin` against the pre-optimize copy decides keep/hybrid/revert. Optimizer failure restores the pre-optimize skin and adds a warning.
6. Paint re-applied last; checks that `weight_edits.json` did not change during the job; `publishRig` (`server/weights.ts:92`) renames candidate -> `rigged.glb` and stages the remapped paint record with rollback on failure.
7. Character update: `status='rigged'`, `files.rigged`, `revision++`, `joints` replaced with Blender's final joints only if the user did not edit during the job, `stats.bones`, `rigReport`.

### 5.7 Weight painting engine
`src/engine/weightpaint.ts` `WeightPainter`: welds coincident vertices into "points" (seams), builds point adjacency, finds mirror twins and a per-point side at rest (`twins` :537), builds a bone swap map (`mirrorName` :54; note it supports `_l/_r`, `.L/.R` for creature rigs). Brush footprint is a **surface-geodesic** distance on the posed mesh with smoothstep falloff (`under` :195), so fingers/other cloth sheets are not neighbours. Each op writes top-4 normalized weights, logs undo, tracks `edited`, and `follow()` mirrors to twins swapping bones (middle points averaged). Heal solves harmonic interpolation from the marked region's boundary. `edits()` exports per-vertex `{bone name, weight}` lists. Save = `PUT /weights` -> `writeWeights` + `keepWeightEdits`.

### 5.8 Hand pose math
`src/engine/handposes.ts`:
- `bindRest` reads rest world/local transforms from the skeleton's bind inverses (independent of the current pose). `handRest` builds a per-joint frame: y along the bone, z off the back of the hand (cross of forward and across-knuckles, signed per hand so frames mirror), x across.
- A pose stores, per joint `Index1..Pinky3`, the quaternion of the rest-relative turn expressed in that joint frame (`poseFrom` :218); `poseLocals` (:233) converts back into local quaternions on any rig (other hand uses `mirrorTurn`, which negates y,z).
- `closeFinger` slerps from straight toward the reference grip (`t` up to 1.3 extrapolates), `closedness` measures angle ratio. The reference grip is the default fist (`DEFAULT_FIST` from `scripts.ts`) re-expressed as a pose on this character.
- `bendOf`/`setBend` (curl about x, spread about z, 'XZY' Euler) exist but are not used by any UI.
- `HandPoses.natural_` (`handposes.svelte.ts:56`) clamps each turned joint via `JointLimits` (below).
- `handdots.ts`: swing-to-point on drag; the rotation about the joint behind the ring is `setFromUnitVectors(now,want)` in world space re-expressed in the parent frame.

### 5.9 Joint limits (ROM)
`src/engine/limits.ts` `JointLimits`: per-bone reached-direction bitmask on an elevation/azimuth sphere grid (+ twist interval) measured from the Mixamo capture library (`tools/rom.ts` -> `static/templates/rom/*.json`), with 1-cell slack and 5-degree twist slack; `SWING_CAP` clamps wrists to 70 degrees; `clamp` projects onto the nearest allowed cell edge (`nearestInCell`). Characters map onto the measured skeleton's frames via `retargetOffsets` (offsets K per bone). Used in this area only by hand poses; used heavily outside (clipedit, PoseEditor, ik, posespace, twohand, propfit, bodysolve).

### 5.10 Server routes touching this area
| Route | Handler | Purpose |
|---|---|---|
| `PATCH /api/characters/:id` | `api.ts:315` | joints, jointsEdited, markers, fingers, boneMap, handPoses (whitelist) |
| `POST /api/characters/:id/rig` | :461 | Queue `runRig` job (only `kind==='mesh'`) |
| `POST .../fingers` | :469 | Finger level / redetect via Blender `--placements-only`; guarded by compare-and-swap on joints/fingers |
| `POST .../template` | :509 | Set template (clears animations and markers, converts rigged to mesh, restores or sets joints) |
| `POST .../fit-template` | :439 | Python medial-skeleton creature fit (422 -> client falls back) |
| `PUT/DELETE .../weights` | :353,366 | Save/forget body paint |
| `PUT/DELETE .../garments/:gid/weights` | :747,769 | Same for a garment (separate store) |
| `GET/POST /api/skeleton-presets` | :675,681 | Bone-map presets |
| `POST .../fit` | :548 | Resize (scales joints/markers/autoJoints) |
| `POST .../reimport` | :538 | Re-run import detection |

---

## 6. Cross-area dependencies

- **Import**: `inspect.py` produces `joints`, `autoJoints`, `rigPreset`, `kind`; Import->Size changes `scale` and rescales joints/markers (`api.ts:548`); `ImportPanel` links into the Rig step and shows `rigReport`.
- **Animate**: the rig test clips use `animator.playTest`; hand-pose preview is `animator.playHandPose`/`refresh`; Animate "Send hand pose" calls `handPoses.capture`; `boneMap` drives retargeting (`animator.rebind`); creature templates choose which clip library (`rig` query in `/api/library`); `JointLimits`/`rom` are shared with the clip editor; `FISTS`/`DEFAULT_FIST` live in `animator.svelte.ts` and `scripts.ts`.
- **Outfit**: `WeightPaintPanel` is reused for garments; `paint.rebuild()` is called by `outfit.svelte.ts:102` when garments are rebound; carry/pull poses use `HandPoseSelect` and `character.handPoses`; clothing takes the body's weights, so Rig re-weights change garment weights; garments' bone names rely on the Mixamo naming here.
- **Texture**: `refreshOutputs` swaps images into `rigged.glb` rather than re-rigging (`api.ts:229-260`). `engine/selection.ts` (in this area's file list) is actually texture mask code, imported only by `engine/surfacemask.ts`.
- **Export / game**: `game_export.ts` reads `rigged.glb`, `rigReport.method`, painted weights, bone naming (`Hips` vs `mixamorig:Hips`); the Godot side expects the Mixamo skeleton.
- **Jobs/Server infrastructure**: `enqueue`, `runBlender`, `events`, journal, `updateCharacter` (all in `server/`).
- **Dev/verification tooling** (not user-facing): `tools/verify_autorig.py`, `tools/dev/verify_rigs.ts`, `verify_hands.ts`, `bench.ts`, `blender/autorig/dev/*` (calibration against Mixamo ground truth), `tools/lib/deformation.ts` (shared with `validate.ts`), `test_heat.py`, `tools/skin_opt/test_quality.py`.
- **Env/tooling**: Blender binary; `.venv` Python (creature fit, torch optimizer, requirements in `tools/requirements*.txt`); Node 22+ type-stripping (scripts run as `node file.ts`).

---

## 7. Redundancy and overlap

### 7.1 Many ways to place or change the same joints
Eight mechanisms write `character.joints`; none is the single owner:
1. **Import detection** (`inspect.py` -> `runInspect` :74; `autoJoints` + `joints`).
2. **Marker board** (`MarkerBoard.svelte:343`, ARAP in TS) writes `markers`, `joints`, `jointsEdited`.
3. **3D joint editor** (`JointEditor.ts`, via `viewer.svelte.ts:128`) writes `joints`. Two UIs for the same thing, opposite frames of reference, no relation between them except that `fitMarkers` (`markers.ts:93-109`) re-bases or re-seeds markers when joints change underneath. `followJoints` (`viewer.svelte.ts:137`) keeps the editor in sync the other way.
4. **Finger level switch** (`POST /fingers` -> Blender -> overwrites all finger joints, flips `jointsEdited`).
5. **"Detect fingers again"** (same route, `redetect`).
6. **Fine-tune joint chips** (`RigPanel.svelte:223-232`) just select a sphere in (3).
7. **Reset to detected joints** (`resetJoints` :115) and **Refit template** (:237).
8. **Rig job** replaces `joints` again with Blender's final joints (`api.ts:202`) and `rig.py` re-runs `complete_joints` (fills any missing joints by detecting again) and `complete`s core joints (`skeleton.py:352-385`).
Additionally: `convert()` (:62) from a foreign skeleton, `chooseBody()` (templates), CLI `rig.ts set WHO joints`.
Overlapping consequences: user edits are silently overwritten by (4)/(5)/(8)-adjacent paths for finger joints (the Fingers section says "the rest of the skeleton stays", but `/fingers` with a level change re-derives the whole hand per `complete_joints`), and `markers` + `joints` can disagree (Reset resets joints but not markers; 3D edit moves joints but not markers; markers are rebased on next open).

### 7.2 Two implementations of finger placement
- Python (`fingers.py`, `skeleton._add_fingers`, `skeleton.complete_joints`): geodesic merge-tree tracing on the mesh, ANATOMY fractions, FINGER_LAYOUT constants.
- TypeScript (`markers.ts` `layHands` :350-399, `ANATOMY` :344-346 copied from `fingers.py:233`; generic refit loop :304-338): lays fingers from tip markers and wrist. The comment at :296-299 states it reproduces "the finger detection lays them (blender/autorig/fingers.py)".
Plus a third path: hand view in `MarkerBoard` re-estimates palm normal with its own PCA (`flattest` :65), while Python `hands.measure_hand` and `handposes.handRest` each compute hand/palm frames again (three palm-frame implementations: `hands.py`, `MarkerBoard.handView`, `handposes.handRest`).

### 7.3 Duplicated skeleton definitions and helpers
- Mixamo hierarchy: `src/engine/mixamo.ts:12` and `blender/autorig/mixamo.py:15` (comment admits mirror), also hard-coded bone lists in `bodycollide.ts`, `retarget.ts`, `PoseEditor.ts`, `BoneChainResolver.ts`.
- `mirrorName`: `engine/mixamo.ts:40` (Left/Right prefix only), `engine/weightpaint.ts:54` (also `_l/_r`, `.L/.R`), `skeleton spec.mirror` for templates (`JointEditor.ts:23` from `template.mirror`), `mixamo.py:313`, `landmarks`' own x-mirroring. Left/right deduction: `mixamo.side`, `templates.templateSide` (regex), `weightpaint.twins`.
- Finger counts/levels: `FINGER_LEVELS` in both mixamo files plus hard-coded numbers in UI hints (25/33/41/65 in `RigPanel.svelte:24-27`) and `convert()` level inference (:74-75).
- Finger-level naming: UI "None/1/2/All" vs code `none/one/two/full` vs docs "Mixamo mitten".
- Rig test clip list: `static/templates/tests.json` (UI "Check deformation"), reused for validation (`deformation.ts`), training (`trainedClips`, `api.ts:110`) and the held-out list `tools/skin_opt/holdout.json`. They contradict: `holdout.json` names Air_Squat and Arm_Stretching as never-trained benchmark clips, yet `trainedClips` adds all tests.json human clips to `--with` (always-trained). Validation then scores clips the optimizer trained on.
- Hierarchy resolution for templates: `loadTemplate` (client, `./templates/<id>.json`) and server `templateAnimations` (reads the same JSON from disk) and `rig.py` (reads the JSON again).

### 7.4 Weight painting here vs in Outfit
Same `WeightPaintPanel`, same `paint` singleton, same `WeightPainter`, but two parallel persistence stacks: body paint (`weight_edits.json` + in-place patch of `rigged.glb`, remapped at re-rig) vs garment paint (`garments/<id>/weights.json`, laid over at load, `Garment.painted` count). Two pairs of near-identical routes (`api.ts:353/366` vs `747/769`), two API calls, two "Forget" paths, and two copies of the vertex-weight writer (`server/weights.ts` `write()`/`writeWeights` vs `tools/skin_opt/apply.ts`, which re-implements GLB accessor patching including the identical `write()` and `sanitize()`). The Section title "Fix weights" is the same for both with different semantics (body permanent in the GLB; garment lives beside it).

### 7.5 ROM / limits used in many places
`JointLimits` is a general engine; in Rig it is used only by `handposes.svelte.ts:prepare` which re-loads `rom/human.json` and re-computes `retargetOffsets` for every rig change. The same ROM data feeds Animate's editor (`clipedit.svelte.ts`), `posespace`, `twohandpose`, `ik`, `bodycollide`, `propfit`, and `tools/dev/verify_*`. `rom/horse.json` exists but only the clip editor uses it. `rom/human-pose.json` and `human-twohand.json` belong to pose-space models, not the Rig step. A rebuild should treat ROM/limits as a shared service, not a Rig-step module.

### 7.6 Multiple Mirror toggles and mirror logic
Four independent mirror switches with different state homes and defaults: `markerBoard.mirror` (Markers section), `viewer.mirror` via a local copy in RigPanel (Fine-tune joints), `paint.mirror` (Fix weights), and hand poses mirror implicitly (opposite hand takes the mirrored pose). Four mirror implementations: board `mirrorX` (`markers.ts:65`), `JointEditor.move` (:200), `WeightPainter.twins/follow`, and `handposes.mirrorTurn`. RigPanel keeps `let mirror = $state(viewer.mirror)` (:31), a stale copy that never re-syncs.

### 7.7 Two ways to choose creature fit and two ways to re-fit
Server medial fit (`creature_fit.py`, TEASAR) vs client bounding-box fit (`templates.ts fitTemplate`). "Refit template" and re-choosing the same chip are two buttons for one action (`chooseBody(template,true)` vs the "Body type" chips, which are no-ops for the current type).

### 7.8 Convert vs template vs re-rig on a rigged model
Rigged-import has three entry points: Convert (human), creature chips under the convert card, and the Body type chip "Humanoid" in the main branch which also calls `convert()` for a rigged character (:48-51). The main Body-type section is not reachable for `kind === 'rigged'` so that code path is only reached via chips for other templates; `chooseBody('human')` with `kind==='rigged'` is dead-ish (the chips list excludes human, :146).

### 7.9 Heat candidates and fallbacks
Three weight generators plus two optional overrides stack: regional (steered heat), native Blender heat (`--native-output`), previous-rig weights, then PyTorch optimization, then painting. Each stage reruns `validateSkin`; method names concatenate (`regions+hybrid-heat+retained-weights+pose-optimized`). The result is a good defensive pipeline but the intermediate decisions are only visible as a method string and warnings.

### 7.10 Dead, vestigial or misplaced code
- `RigPanel.svelte:2` imports `FlipHorizontal2` (unused); `:36` `let choosing` is only ever set (never read).
- `RigPanel.svelte:170` hard-coded bone chips for Weights highlighting; their list differs from `groups()`.
- `handposes.svelte.ts` `bend()` (:174) and `setBend()` (:180) and `engine/handposes.ts bendOf/setBend` (:269,276) have no UI callers (only tests). The sliders use `closed`/`setClosed`. The "curl/spread" per-joint UI was replaced by rings + whole-finger sliders.
- `JointEditor.events.change` (`JointEditor.ts:197`) is emitted on every pointer move (allocating a full joints copy via `this.value`) but `viewer.svelte.ts:125-129` supplies no `change` handler.
- `HandDots` `end: () => {}` handler (`HandPosesPanel.svelte:23`).
- `JointEditor.hovered` mirrored in `viewer.hoveredJoint`/`selectedJoint` + Viewport label; `frame++` per frame while hovered (`viewer.svelte.ts:46`).
- `engine/selection.ts` (141 lines) is texture mask region growing; wrongly in this area's file list. `useMarkerSets` (`markers.ts:47`) exists for tests only.
- `blender/autorig/dev/*` (calibration scripts, `bench/`) and `rig.py --dump/--report/--no-segments` are dev-only flags. `weights.localize` / `LOCALIZE_HOPS=0` is disabled by default.
- `tools/rig.ts` is the project CLI (animation slots, units, export), not rigging; name collides with the Rig step.
- Comments referring to history: "Saved boards from before whole-finger fitting" (`markers.ts:102-103`), "the old forearm frame" fallback (`skeleton.py:73`), "(2026-10-26)" notes in `regions.py:34` and `api.ts:149-151`, "joints placed before it was stood on the floor" (`rig.py:201`) — compatibility code for old data.
- `character.rigPreset` conditions: Convert panel's SkeletonMapping is skipped for Mixamo, but the "Rigged elsewhere (Mixamo)" wording suggests Mixamo rigs would not need converting; they still do (no direct bone use).
- `Template.animations` string path and `meshBox` coupling: client `fitTemplate` needs `meshBox`; `templateSide` regex handles both `_l`/`.L` conventions.

---

## 8. Rough edges

### 8.1 Confusing UI, naming, discoverability
1. **Step name vs verb vs panel names**: "Rig" step; "Rig character"; "Rigged with the Mixamo skeleton"; "Adjust joints and re-rig"; "Convert to the Rigsmith rig"; Import's "Rig this character"; "Pick animations". Rigsmith, Mixamo and "rig" (skeleton vs verb vs the whole step) are used interchangeably.
2. **Two placement tools presented together without a recommendation**: "Markers" (board) and "Fine-tune joints" (3D) both edit joints; the text distinguishes them ("for what the markers don't reach") but a first-time user sees 12 markers, 65 chips and a finger-level selector in one scroll. The Fingers section is placed *after* both and *before* Rig; changing it changes joints the user may have already placed.
3. **Finger section vs finger-tip markers**: three ways to place fingertips (finger-tip markers on a hand view, 3D finger joints in Hands chips, "Detect fingers again"). Level switching rewrites finger joints.
4. **Hidden state**: markers vs joints can drift (3D edit or Reset changes joints; markers are only reconciled next time the board opens, `fitMarkers`). "Start again" is the only way to guarantee a clean marker state.
5. **Chips hidden by CSS instead of removed** (`class:hidden`, :169,:222) so creature rigs lack any joint list; creature joint editing has no discoverable list, only 3D dragging; only horses have markers; other creatures show a one-line "No markers for the X body yet".
6. **Test clips**: "Check deformation" has no creature entries except the horse; text "No test clips for this body type yet (static/templates/tests.json)" leaks a file path into the UI. Bone-influence chips are hard-coded (10 bones, Left only).
7. **Fix weights is invisible unless rigged and kind==='mesh'**; there is no explicit empty-state explanation for rigged-elsewhere characters. "Forget the painting" does not touch the live GLB; the toast says "the next rig makes them afresh" but the current weights stay painted, with no visible indicator that edits exist (no "N painted vertices" count for the body, unlike garments).
8. **Hand poses**: sliders go to 1.3 ("fist" label at 1.0 is not the end); "Whole hand" and finger sliders overwrite individual ring edits; the reference "Grip" depends on the character's own fist script. Shared poses are global across characters, silently editing a shared pose edits it for everyone (`show` :213). Explainer text mentions `Props' sockets` and `Animate: Send hand pose`, scattering the feature across steps.
9. **Tooltips on the board are SVG foreignObject** only on hover; markers use letters A/B for left/right on the human front view (right is A) while other UIs say Left/Right. Hint text says "Esc closes", but Esc on the main window also closes drawers.
10. **Terminology drift**: "markers" (board) vs "joints" vs "bones" vs "placements" (server messages) vs "tips" vs "pins" (solver). Finger levels: None / 1 / 2 / All vs one/two/full vs "mitten".
11. **Long operations without cancel**: rig job (Blender + validation + torch, minutes), "Detect fingers again" (blocking Blender call from a UI with `fieldset disabled`), template fit. No cancel, no per-stage visibility beyond the message string.
12. **Mixed Viewport busy sources**: five different `busy` strings (`markerBoard.busy`, `paint.busyText`, `clipEdit.busy`, `outfit.busy`, `job.message`) funneled into one spinner with a precedence chain (`Viewport.svelte:117-123`).

### 8.2 Behaviour risks visible in the code
1. **No manual path when detection fails for a human**: `joints` undefined disables "Rig character" and the 3D editor/board. `chooseBody('human')` on an already-human mesh returns early (:39), so the only way out is picking a creature then switching back, which in turn restores `autoJoints` (also undefined). Import warns "the user places joints by hand" (`inspect.py:87`) but no UI seeds a blank skeleton.
2. **Changing template deletes the character's animations and markers with no confirmation** (`api.ts:512-514,532`). `chooseBody` back to human restores `autoJoints`, discarding any manual joint edits made while on the human template (they were overwritten by the creature fit).
3. **Fragile mesh indexing for painting**: `paint.svelte.ts:94` computes `part` with `view.skinned.indexOf(...)` but `WeightPainter.parts` is built from `meshesOf()` (garment meshes first when painting a garment, body subset otherwise). Mismatch is avoided only because garment meshes happen to follow body meshes; the server (`weights.ts:39-44`) counts skinned primitives in scene order. Any change to mesh load order silently writes paint to wrong vertices.
4. **Paint and rig coupling by vertex number**: saved edits are keyed `mesh:vertex` of the rigged GLB; re-rig remaps by geometry (`transferPainting`) but any ambiguity aborts the whole rig ("An ambiguous or missing painted point stops the rebuild"). Hand-fixed characters therefore cannot be re-rigged safely if the mesh was modified; this is consistent with MEMORY.md's rule (Scout/Villager only) but nothing in the UI warns about it. "Rig character" is one click.
5. **`/rig` has no guard for concurrent painting/finger fits** besides `status==='rigging'` checks on weights routes; the job re-reads `weight_edits.json` at the end and aborts if it changed (`api.ts:195`) - user loses the whole rig after minutes.
6. **Stale-joint race handled by compare-and-swap in one place only**: `/fingers` returns 409 if joints changed (`api.ts:488-491`); marker saves, 3D commits and the rig job rely on last-writer-wins in the generic PATCH. The rig job adopts Blender's joints only if unchanged; otherwise a warning. A user can lose joint edits made during a long rig.
7. **PATCH `fingers` bypasses the fit route** (whitelisted at `api.ts:318`), so CLI/other tools can set a level without re-fitting joints, leaving `joints` inconsistent with the hierarchy (the rig will then run `complete_joints`/validation).
8. **`validate_joints` errors are reported only in the rig job failure** ("X and Y overlap; move their markers apart"), not while placing markers.
9. **Optimizer/holdout inconsistency** (see 7.3): validation clips overlap training clips, so the "deformation improves" gate is optimistic for humans. Creature optimization is off by default after a regression (comment `api.ts:140-146`); creatures' validation exists only for the horse, so Fox/Bird/Dragon/etc. have no regression check at all (`validate.ts:33-34` -> `compared:false`).
10. **Hard-wired externals**: `.venv/bin/python` at repo root for creature fit and torch (with a fallback path `~/dev/ml/make-it-animatable/.venv`, `skinopt.ts:131`); `fit-template` returns 422 "Skeleton fit unavailable" without it; `blender` binary; game repo path `~/dev/games/emberhold` (`tools/rig.ts:44`).
11. **Performance**: `JointEditor` allocates a full joints copy per pointer move (`:196-197`); `fitMarkers` effect serializes all joints to JSON on every `character.joints` change (`MarkerBoard.svelte:236-237`); `ARAP.solve` builds a dense n x n matrix (n~65-140) - fine now, quadratic if skeletons grow; `paint.pick` recomputes bounding spheres for all skinned meshes on every pointer move (:84).
12. **Persistence granularity**: marker drags save `markers`+`joints`+`jointsEdited` with a single PATCH on release (good), but hand-pose slider drags debounce 400 ms and write the *entire* `handPoses` array, and a shared pose writes the settings file too (`handposes.svelte.ts:210-214`), so two tabs editing poses overwrite each other.
13. **`SkeletonMapping`'s auto-save `$effect`** (:29-31) runs on first view of any non-Mixamo rigged character and writes `boneMap` as a side effect of viewing the Rig panel; also the section is in `steps/`, and mapping is only ever used for retargeting, which makes the "Rig" step own a retarget concern.
14. **Dev/legacy code in production paths**: env-var tunables (`RIG_*`) read at Python import time; migration branches for pre-existing data (`fitMarkers` legacy upgrade, floor-grounding compensation, mitten/index cleanup) which run silently on every open.
15. **Test coverage** (area files): unit tests exist for markers, weightpaint, handposes, limits, server/weights, skintransfer, skin_opt selection, test_heat, test_quality. Not covered by automated tests: RigPanel/MarkerBoard UI logic, `/fingers` route, `runRig` orchestration, `creature_fit.py`, finger detection (`fingers.py`), landmark detection. Quality of the automatic rig is tracked by manual audits (`HANDOFF.md`: "automatic rigging ... not perfect or world class across the library").

### 8.3 Questions a from-scratch design should settle (for the redesign owner)
- One authoritative "skeleton placement" model (joints + provenance: detected / marker-solved / hand-edited per joint) instead of `joints` + `autoJoints` + `jointsEdited` + `markers.base/positions` + finger level.
- One placement UI (markers as a mode of the 3D editor, or a staged wizard) rather than board + 3D + chips + finger section.
- One finger system (single implementation, preferably shared by TS and Python or run in one place) and explicit finger-level semantics.
- A single "weights" store: base weights in the model, authored edits as a layer, clear indicator of what is authored; unify body and garment painting storage.
- Treat ROM, hand math, mirror, and Mixamo hierarchy as shared libraries.
- Surface every long job's stage and cancel; warn before destructive actions (template switch, re-rig over authored paint, forgetting painting).
- Protect hand-fixed characters (MEMORY.md): a "locked weights" flag so re-rig is blocked or requires explicit unlock.
