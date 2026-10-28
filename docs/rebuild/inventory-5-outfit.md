# Inventory 5: the Outfit step (accessories, sockets, pulls, mechanisms, switch sets, garment weights, mounts, scale room)

Audit only; nothing was modified. Line numbers are as of commit 36f9295 (clean tree). Paths are relative to `/home/ryan/dev/games/rigsmith`.

Workspace usage snapshot (read from `workspace/characters/*/character.json`, 31 characters): **85 garments, all `mode: 'rigid'`, all with `from: "emberhold:..."`** (brought in by `tools/game_import.py`); **zero clothing, zero parts, zero switch-set `group`, zero `anchor`, zero `animation`, zero painted weights, zero `hideBody`**; 29 of the 85 are `hidden`; 2 pulls, 3 grip sockets, 1 `carryPose`, 0 `carryOpen`; 2 legacy catalog `props` on 2 characters; 3 mounts (all three carry `skin`/`gear`, which have no UI). So in practice the Outfit step is used as "the unit's tool/weapon/wear set imported from the game"; the clothing, part, mechanism, switch-set and hide-body features have never been used on real data.

---

## 1. Purpose of the area

The Outfit step puts things on a rigged character: bundled catalog weapons pinned to sockets (legacy `Character.props`), and the user's own meshes ("garments", `Character.garments`) in three kinds (prop = rigid on a bone, clothing = skinned to the body, part = pinned to a skin spot, optionally a mechanism with its own animation). It also owns prop "pull sockets" (bowstring drawn by the other hand), the carrying hand's pose, switch sets, per-garment weight painting, and "Mount" (a rider seated on a horse character). The data feeds the viewer, the animation editor (grip sockets), the GLB export, and the Emberhold game export.

---

## 2. UI surface

Outfit has no panel of its own; it is spread over four places in the shell:

- Right column (Inspector): `src/app/Inspector.svelte:20-21` renders `OutfitPanel` for step `outfit`.
- Left column (library): `src/app/App.svelte:77-78` renders `PropCatalog` for step `outfit` (the Library takes the slot in Animate, CharacterList elsewhere).
- Centre: viewport + a TransformControls gizmo (created in `src/state/outfit.svelte.ts:57-72`), and the shared Timeline, shown in Outfit (`src/app/Viewport.svelte:102`).
- Export step: the Scale room (`src/app/export/ScaleRoom.svelte`, opened from `src/app/steps/GameUnitPanel.svelte:91`), not the Outfit step.

### 2.1 Left column: `src/app/outfit/PropCatalog.svelte`
| Element | What it does |
|---|---|
| Header "Props" + "N items" (`:15-18`) | Title and count of the 44 bundled catalog props (`CATALOG`, `src/engine/props.ts:38-56`). |
| Category chips (`:19-23`) | Swords, Axes, Hammers, Polearms, Staves, Ranged, Shields, Daggers, Tools, Guns. Tablist, default "Swords". |
| Hint "Rig the character first" (`:25-27`) | Shown when not rigged; tiles disabled (`:30`). |
| Item tiles (`:28-35`) | Thumbnail from `static/props/preview/*.png`, name, "+" on hover; a green border if that catalog file is already attached (`attached` set `:11`). Click -> `outfit.add(file)` (adds a legacy `PropAttachment`, selects it, no gizmo mode switch). Catalog items can be added repeatedly (the green border is only a marker). |

### 2.2 Right column: `src/app/steps/OutfitPanel.svelte` (471 lines), top to bottom
Gate: `character.status !== 'rigged'` shows only "Rig X first" (`:142-143`).

**Section "Pose" (`:145-153`)**
- Select "Pose" (`:146-150`): Rest / "Rest, fists closed" / each clip of the character. `setPose` (`:122-130`) calls `animator.stop()`, `animator.playFists()` or `animator.playEntry`. Hint text mentions Space / `,` / `.` to pause and step (those keys belong to the Timeline).

**Section "Mount" (`:155-190`)**
- Select "Rides" (`:158-162`): "Nothing (on foot)" or any other `rigged` non-human-template character (`horses` `:112`). -> `outfit.setMount(id|null)`.
- When a mount exists:
  - Select "Sits on" (`:166-168`): horse bone; -> `outfit.patchMount({bone})`.
  - Button "Place him" (`:171`): toggles `outfit.aim('seat')`, attaches the gizmo to the `mount_seat` group (`outfit.svelte.ts:129-134`).
  - Button "Take the legs from the pose playing" (`:172`): `outfit.takeSeatPose()` stores the current local quaternions of the held bones + Hips position as the seated pose.
  - Grid "Held still in the seat" (`:176-184`): one checkbox per rider bone (LOWER_BODY or already frozen, `mount.ts:11`) toggling `mount.freeze` (`toggleHeld` `:116-120`), plus a link button per bone that aims the gizmo at that bone (`bone:<name>`), enabled only when held.
  - When a target is aimed: a Move/Rotate/Scale `Segmented` (`:186`) and a hint (`:187`). "Letting go saves it" (gizmo drag end -> `commitMount`, `outfit.svelte.ts:179-196`).
  - No UI for `Mount.scale`, `Mount.rotation` numerics, `Mount.skin`, `Mount.gear`, `Mount.hips` (all only reachable by gizmo/CLI/raw PATCH).

**Section "Attached" (`:192-211`)** (legacy catalog props only)
- Empty state with Sword icon (`:194-197`): "Pick a weapon, shield or tool from the catalog."
- List rows: name + socket label (click selects/deselects `outfit.select`), trash icon removes (`outfit.remove`).

**Section `<selected prop name>` (`:213-233`)** (shown when a catalog prop is selected)
- Select "Attached to" (`:217`): 9 `SOCKETS` (Right hand, Left hand, L/R forearm, Back(Spine2), Hips, L/R thigh, Head) -> `outfit.setSocket` which also resets placement to `defaultPlacement`.
- Move/Rotate/Scale `Segmented` (`:221`), shared `mode`.
- Position X/Y/Z number inputs (step 0.05, in bone-length units) (`:224`), Rotation X/Y/Z (step 5 degrees) (`:226`), uniform Scale (`:228`).
- Button "Reset placement" (`:230`) -> `outfit.reset` (default placement + `defaultScale(height)`).
- Hint "Props export as bone attachments." (`:231`)

**Section "Accessories" (`:235-278`)** (garments)
- Header action: three upload buttons "Prop", "Clothing", "Part" (`:237-239`), each with the kind's hint as title; all open the one hidden `<input type=file multiple accept=".fbx,.glb,.gltf,.obj,.dae,.zip">` (`:241-242`, `add()` `:78`). Each file -> `outfit.upload(file, kind)` -> `api.uploadGarment` (Blender normalises to GLB, a job "garment").
- Empty state with Shirt icon (`:243-249`) explaining the three kinds.
- Grouped lists by kind ("Props", "Clothes", "Parts" with counts) (`:251-276`). Each row:
  - Main button (disabled until `status === 'ready'`): name + detail text (`detail()` `:36-40`: "on RightHand" / "pinned · plays X" / "<policy> · painted") or "importing" spinner / "failed"; click -> `open(g)` (`:42-47`): toggles `outfit.focus`, ends any fitting.
  - Switch-set pill (`:266`) showing `group`.
  - Eye / EyeOff toggle (`:267-270`) -> `outfit.setShown` (showing a member of a switch set hides the others).
  - Trash (`:271`) -> `outfit.removeGarment`.
  - Row `selected` class when it is `fitting ?? focus`.

**Section `<current garment name>` (`:280-350`)** (current = `fitting ?? focus`)
- Select "Kind" (`:285-287`): Prop / Clothing / Part, `setKind` (`:33-35`) patches `mode` only; plus the kind hint paragraph (`:289`).
- Input "Switch set" with `<datalist>` of existing groups (`:291-296`).
- Toggle "Shown" (`:297-298`) (same action as the eye icon).
- Per kind:
  - Prop: nothing here (see "Sockets & pulls").
  - Clothing: select "Follows" (policy: body / upper / lower / cape / skirt / head, `POLICIES` `garments.ts:23-30`) + hint (`:303-309`); Toggle "Hide body underneath" (`:310-311`).
  - Part: read-only "Pinned to" text (`:313-316`); button "Pick the spot on the body" / "Click the body..." (`:318-319`, `outfit.pickSpot`); button "Use the nearest skin" when anchored (`:320`); hint (`:322`); when the model has animations (`clips` from `garmentAnimations`, `:80-87`): select "Its own animation" (None/clip) (`:323-332`) and a note that the game gets it still.
- If `outfit.fitting === current.id` (`:335-346`): Move/Rotate/Scale `Segmented`, Position/Rotation/Scale number inputs (a second copy of the prop-panel inputs, step 0.01 here), "Shown unbound while you place it" note for non-props, primary button "Done" (prop) or "Bind to <character>" (clothing/part) -> `outfit.fit(null)`. Else button "Place it (gizmo)" (`:348`) -> `outfit.fit(id)`.

**Section "Sockets & pulls" (`:351-410`)** (rigid + ready only)
- Select "Held by" (`:355`): 18 hard-coded humanoid bones (`bones` `:89`) (+ the current bone if not in the list) -> `outfit.setBone` (mirrors the placement across the body when going Left<->Right; see 5.7).
- For a hand: `HandPoseSelect` carry pose (`:359-364`) (`carryPose`: default fist / Open / Hand poses / Shared hand poses / Fists).
- Explanatory paragraph (`:365-366`) pointing to Animate -> Edit for the other hand's grip.
- Button "Add a pull socket" (`:367`) -> `outfit.addPull` (+ empty-state explanation `:368-372`).
- Per pull card (`:373-408`): name input + trash (`:376-379`); select "Drawn by" (RightHand, LeftHand, then every rest bone) with `setPullBone` (also sets `grip` from `outfit.gripOf`) (`:380-385`); `HandPoseSelect` "Its hand while drawing" for hands (`:386-392`, `open={false}`, default label "As the clip has it"); button "Pick its point on the prop" (ray pick on the prop, `outfit.pickPullPoint`) (`:393-396`); a grid with one row per clip of the character: Play link (`playClip`), a text input of hold windows ("0.12-0.45, 0.7-0.9"; `setHolds` `:56-62`) and a "Find" link (`find` `:64-71`, `outfit.findHolds`, auto-detects window by simulating the clip) (`:399-406`).

**Section "Fix weights" / "Weights" (`:411-419`)**
- When clothing is bound (not fitting) or a prop has pulls: embeds the Rig step's `WeightPaintPanel` (`src/app/rig/WeightPaintPanel.svelte`) with `garment={current}`. Otherwise a section "Weights" with only a hint ("Show it to paint...", "A prop is rigid on its bone: add a pull socket...", "Bind it ... to paint"); nothing for parts.
- WeightPaintPanel (shared with Rig; 111 lines): "Paint <name>'s weights"/"Done painting" button; tools Heal(area)/Add/Remove/Smooth/Follow/Bone(rigid) (`:34-41`); "Bone under the brush" readout; bone select (for Add/Remove; for a pulled prop the list is `PropRoot` "Rigid (the prop itself)" + "Pulled by <pull>" per pull, `:21-25`); Mirror toggle (forced off for rigid garments, `paint.svelte.ts:69`); Brush radius slider; Strength slider; Heal/Clear buttons with marked-point count; "Left -> right" / "Right -> left" copy; Undo; "Save N points"; "Forget the painting" link (garment: `DELETE .../weights`; body: `forgetWeights`).

### 2.3 Viewport interactions in Outfit
- TransformControls gizmo (`outfit.svelte.ts:57-72`): translate/rotate/scale; attached to one of: mount seat / a held bone, the fitting garment, or the selected catalog prop (`updateGizmo` `:114-125`). Space is `world` for garment fitting and seat, `local` otherwise; held bones other than Hips are forced to rotate mode. Dragging pauses a playing clip and sets `animator.holding`. Drag end commits (`commitMount` / `commitFit` / `commitGizmo`).
- Pick mode "part spot" (`pickSpot` `:318-350`): capture-phase pointerdown on the canvas; raycasts the body only; stores a rest-space barycentric point as `anchor`. Mode shown as the button's "Click the body..." state.
- Pick mode "pull point" (`pickPullPoint` `:395-421`): raycasts the prop's meshes; stores the point in the prop's local space as `PullSocket.rest`.
- Weight brush on the prop/clothing (paint.svelte.ts).
- Viewport busy overlay "Fitting clothes" while `outfit.busy` (`Viewport.svelte:117-120`).
- Timeline docked under the viewport (Timeline.svelte; also keys Space/`,`/`.`).

### 2.4 Scale room (Export step; relevant to mounts)
`src/app/export/ScaleRoom.svelte` (238 lines), state `src/state/scaleroom.svelte.ts` (17 lines), opened by `GameUnitPanel.svelte:91` "Scale it with the game" (`scaleRoom.show(unit, entry, companion)`), mounted over the viewport at `Viewport.svelte:104-108`.
- Full-viewport overlay with its own WebGL renderer, scene, OrbitControls, ground, grid; a clone of `view.root` (character as it stands) scaled to the chosen height at the game's `visualScale` (`fitMe` `:91-97`).
- Panel (`:197-215`): title (unit, " . its mount" when `companion`); Height range slider 0.5-4 m + number input (0.3-10); "Save height" (disabled when unchanged) -> `api.putUnit` (writes Rigsmith's unit spec, not the game); "Back to N m"; note text; chips for the game's other units (default shown: warrior, spearman, archer, villager, raider, caravan, bearguard); select "+ a building or prop..." with Buildings/Props optgroups; floating height labels per model; close X (`:216`).
- Loads game models from `/api/game/models/...` (server/api.ts:377-384; read-only access to the game repo). LOD meshes and `Gear*/Wear*/Head*` pieces are hidden for height measurement (`:46`).
- For the "companion" case the room sets the horse's height (`entry.companion.height`). It does NOT edit the rider-on-horse relation: a rider's size on the horse is derived (`riderScale`) from the two game heights, with `Mount.scale` as an unreachable fallback.
- Related duplicate input: `GameUnitPanel.svelte:~72-73` has a plain "Height" number input for the same `entry.height`, and an "Its height" input for the companion (`:~88`).

### 2.5 Other places that touch Outfit data (outside this area but part of the same features)
- Animate -> Edit panel (`src/app/animate/EditPanel.svelte:101-160`): "Grip sockets" selects per hand (Outfit placement / Free / named sockets), per-hand hand-pose select with "Opens in this clip" windows and "↦" button (writes `carryPose`, `carryOpen`), pull rows with hand pose + "Held in this clip" windows + "Held from here" / "Let go here" buttons (writes `pulls[].pose`, `holds`), "Delete grip socket" trash.
- Export panel: "Include props" toggle for catalog props only (`ExportPanel.svelte:121-122`).
- Journal text for gear changes (`server/journal.ts:37-69`, `:97`).
- Library/left column in Animate shows the clip Library, not Outfit controls.

---

## 3. User workflows

### 3.1 Add a catalog prop and put it on a bone (legacy path)
1. Rig the character. Open Outfit. 2. In the left catalog pick a category, click a tile. `outfit.add` (`outfit.svelte.ts:483-498`) creates a `PropAttachment` with `socket` from the catalog entry (RightHand by default; bows LeftHand; shields LeftForeArm), `defaultPlacement(socket, category)`, `scale = height/1.6`, selects it, PATCHes `props`. 3. The viewer attaches it as a child of the bone under a `mount` (grip frame) -> `holder` (offset) group. 4. Pick a different "Attached to" socket (placement resets), drag the gizmo or type numbers (units of the bone length), "Reset placement". 5. Remove with trash. It exports to GLB (toggle "Include props"), and is dropped from the game export with a warning. It cannot be gripped, keyed, hidden, switch-setted or weight painted.

### 3.2 Add a prop (rigid garment) and place it on a bone
1. Accessories -> "Prop" button, choose a file. A Blender job normalises it (`jobs/inspect.py --animations`), garment appears as "importing" and becomes `ready` with `bone: RightHand`, identity placement. 2. Click the row (focus). In the "<name>" section choose "Place it (gizmo)": the prop sits as a node under its bone's rest frame; move/rotate/scale at any pose (choose a clip in "Pose" and pause on a frame to fit it to the grip in motion), or type numbers. "Done". Each gizmo release PATCHes the whole `garments` array. 3. "Sockets & pulls" -> "Held by" picks a bone; going to the opposite hand mirrors the placement (5.7). 4. For a hand, pick the carry hand pose (closes that hand on the prop in every clip). 5. Other-hand grips (two-handed holds) are created in Animate -> Edit by dragging a hand onto the prop (stored in `garment.sockets`); keyed prop motion per clip lives in `AnimationEntry.keys.props`.

### 3.3 Clothing fitted to the body
1. Accessories -> "Clothing", upload. 2. Row -> section: pick "Kind = Clothing" (already), choose "Follows" policy, optionally "Hide body underneath". 3. "Place it (gizmo)": the mesh is shown unbound as a static group; move/scale it over the body; "Bind to <character>" runs `attachGarments` which computes weights (5.1) and creates a SkinnedMesh bound to the body skeleton (busy overlay "Fitting clothes"). 4. Fix areas: "Paint <name>'s weights" -> Heal / Add / Remove / Smooth / Follow / Bone brushes, "Save N points" (PUT weights.json, `painted` count) or "Forget the painting". 5. Play a clip in "Pose" to inspect deformation.

### 3.4 Parts pinned to the skin
1. Upload as "Part" (or switch Kind). 2. Optional "Pick the spot on the body" (else nearest skin to the mesh bbox centre). 3. Place it with the gizmo and Bind. 4. Every vertex takes the same skin weights from that spot (5.2). 5. If the model carries animations, "Its own animation" turns it into a mechanism that rides the spot's leading bone and plays in the viewer (not in the game export).

### 3.5 Switch sets (job tools)
Type a set name in "Switch set" for each member (datalist suggests existing). Turning one on (eye icon or "Shown" toggle) switches the others in the set off (`setShown`, `outfit.svelte.ts:301-310`). Hidden pieces are not shown in the viewer, nor exported to GLB; the game export keeps hidden pieces only if their name matches `/^(Gear|Head|Wear)/`.

### 3.6 Mechanisms
A part whose model has its own animation clip (e.g. spinning wheel): choose it in "Its own animation". Plays continuously in the viewer regardless of the clip (`tickMechanisms`, `viewer.svelte.ts:46-55`). Exported still (warning in `game_export.ts:415`).

### 3.7 Pull sockets and holds (bowstring)
1. On a rigid prop press "Add a pull socket": `addPull` picks the longest-thinnest strand (`strandMiddle`) as `rest`, uses the right hand's grip frame as `grip`. 2. Optionally "Pick its point on the prop". 3. "Drawn by": the pulling bone (RightHand by default). 4. For each clip, type windows or press Find (plays the clip, samples 120 frames, finds when the grip comes within 3% of height of the strand; ends at the clip's `blow` script or when the grip exceeds 60% of the strand length). 5. Paint which prop parts follow (Weights panel lists "Rigid" and "Pulled by X"). Unpainted: only vertices next to the pull's rest point follow. 6. Pull hand pose: "Its hand while drawing" (or from Animate -> Edit).

### 3.8 Carry pose
In "Sockets & pulls" (prop on a hand): pick hand pose; else default fist (`DEFAULT_FIST = mixamo-Great_Sword_Crouching_6`). Animate -> Edit can set the same value (through `clipEdit.setFist`) and "Opens in this clip" windows (`carryOpen`, per clip name). Resolution is in `handScripts` (5.6).

### 3.9 Painting garment weights
See 3.3 step 4. For props with pulls the paint bones are PropRoot + pull bones. Not available for parts or props without pulls.

### 3.10 Mounting a rider on a horse and sizing
1. Rig a creature character from a non-human template (horse). 2. In the rider's Outfit -> Mount -> "Rides": `setMount` loads the horse, fetches `/api/characters/<id>/game` heights, computes `riderScale`, then `straddle(horse, rider, k)` (5.5) to produce `bone`, `position`, `freeze` (lower body), `pose`, `hips`. The viewer loads the horse, hangs a `mount_seat` group off the horse's bone and parents the rider's root under it (`viewer.svelte.ts:172-218`). 3. "Place him" and drag the seat. Tick/untick held bones; click a held bone's name to aim the gizmo and rotate it; or pause a seated clip and "Take the legs from the pose playing". 4. Size: derived from the two game unit heights; to change it, open the Export step, "Scale it with the game" on the unit (rider) or its companion (horse), set the height, Save. 5. The horse's skin/gear (`Mount.skin`, `Mount.gear`) can only be set by hand-editing. 6. `tools/rig.ts ride WHO HORSE|off` does the same seating headlessly.

---

## 4. Data model (`server/workspace.ts`)

### Character fields (`:57-65`)
- `props?: PropAttachment[]` (`:58`, def `:173-181`): LEGACY bundled-catalog props. `ref: 'catalog:<file>'` (also documented `custom:<id>` in `src/engine/props.ts:24`, which no code creates; `propUrl` still resolves `/files/props/<id>/model.glb`). `socket` is a string (typed `Socket` union in the engine). `position` is in units of the socket bone's length in a grip frame, rotation degrees, uniform scale.
- `garments?: Garment[]` (`:60`): the user's own meshes.
- `mount?: Mount` (`:62`, def `:71-88`).
- `skins?: Array<{name,file}>` (`:65`): alternative colour maps (horse coats); only consumed by Mount.skin and the game export; no UI in the files read.
- `handPoses?: HandPose[]` (`:56`, + Settings.handPoses shared): referenced by `carryPose` / `pull.pose` as `pose:<id>`.
- `scripts?`, `animations[].keys.props` (per garment NAME), `AnimationEntry.keys` are other areas but reference garments by name.

### Garment (`:90-133`)
| Field | Purpose |
|---|---|
| `id` | Random 8 hex, folder name `garments/<id>/` (model.glb, source.*, weights.json). |
| `name` | From the filename (`_`/`-` -> spaces). Used as an identity everywhere else (see 7/8). |
| `file`, `status`, `error` | Normalised GLB; `importing | ready | error`. |
| `mode` | `'rigid'` (UI "Prop"), `'clothing'`, `'part'`. |
| `policy` | Clothing: `body|cape|skirt|upper|lower|head` bone filter + smoothing iterations. Present (default `'body'`) on every garment regardless of mode. |
| `bone` | Rigid: the bone it rides. For non-rigid it is a dummy `'Head'` default (`api.ts:719-721`). |
| `position`, `rotation`, `scale` | Placement in the character's rest space (rigid: relative to bone rest frame undone, i.e. a world rest placement; clothing/part: static placement before skinning). `garmentMatrix` (`placement.ts`). Uniform scale only. |
| `hideBody` | Clothing only: hides body triangles under it (viewer only; not applied in game). |
| `hidden` | Switched off. |
| `from` | `emberhold:<unit>/<part>` tag from `game_import.py`: the only garments `game_export.ts` exports. |
| `sockets?: GarmentSocket[]` | Grip sockets of a rigid garment: `{id,name,position,rotation(quat)}` (the editor's `Socket` adds `placed?`, which the server type lacks). Created in Animate -> Edit; the Outfit step never shows them. A special socket named `... (carries it)` is filtered out in the editor (`clipedit.svelte.ts:61`). |
| `group?` | Switch set name. |
| `anchor?` | Part spot in rest space. |
| `painted?` | Count of hand-painted vertices (file `weights.json`); doubles as a cache-buster (`garmentWeightsUrl`). |
| `animation?` | Part: the model clip it plays (mechanism). |
| `pulls?: PullSocket[]` (`:149-163`) | `{id,name,bone,grip,rest,holds?,pose?}`: `bone` the pulling bone, `grip` where it holds in that bone's rest frame, `rest` the point in the prop's model space, `holds` per clip NAME windows [0..1], `pose` the hand pose while pulling. |
| `carryPose?` | Carrying hand pose ('pose:<id>', fist clip id, `'open'`, unset = default fist). |
| `carryOpen?` | Per clip NAME windows where the carrying hand opens. |

### Mount (`:71-88`)
`character` (horse id), `bone` (horse bone the seat hangs from), `position`/`rotation`(deg) (rider's rest space in the horse bone's rest space), `scale?` (fallback size), `freeze` (rider bones held), `pose` (local quaternions of held bones), `hips?` (local position of Hips), `skin?`, `gear?` (horse garment names).

### Server API (`server/api.ts`)
- `PATCH /api/characters/:id` (`:314-335`): whitelist including `props`, `garments`, `mount`, `skins`, `handPoses`; `null` deletes the field (used for dropping a mount). Whole-array replacement; all Outfit edits are read-modify-write of the entire `garments` array.
- `POST /api/characters/:id/garments?name=&kind=` (`:706-743`): saves the source, creates the garment (`status importing`), enqueues a Blender `inspect.py --animations` job, marks ready/error. `kind` = prop|rigid|part|else clothing.
- `PUT /api/characters/:id/garments/:gid/weights` (`:747-767`): merges edits by `mesh:vertex` into `garments/<gid>/weights.json`, sets `painted`.
- `DELETE .../weights` (`:769-781`): deletes the file, clears `painted`.
- No `DELETE` for a garment: removal is a PATCH dropping it from the array; its folder stays on disk (orphaned).
- Scale transform (`:560-590`, character size change) rescales garments' `position`, `scale`, `anchor`, pull `grip`; it does NOT touch pull `rest` (model space, correct), `rotation`, `mount.position`, or catalog `props` (those are bone-relative).
- Read-only game model access `GET /api/game/models...` (`:377-384`) for the scale room.

---

## 5. Algorithms

### 5.1 Clothing skinning / weight transfer (`src/engine/garments.ts`)
`attachGarments` (`:469-560`): `detachGarments` first (everything is rebuilt on every change), find the body's single non-garment skinned mesh (`bodySurface` `:196-215`: rest positions via `bindMatrix`, a `TriangleGrid` of cell `height/40`, the body's `skinIndex/skinWeight`; uses `userData.fullIndex` when body triangles are hidden). For each clothing mesh `computeWeights` (`:221-272`): for every vertex find the closest body triangle (grid, up to 6 rings), interpolate the 3 corners' weights by barycentre, keep only bones allowed by the policy regex (`ALLOWED` `:32-39`); if nothing allowed, 100% to the nearest allowed bone by joint position; skirts are overwritten by `skirtBlend` (hips vs thigh by |x| and depth below hip); Laplacian smoothing over welded vertices (`SMOOTHING` iterations: body 3, upper 3, lower 3, cape 10, skirt 14, head 2); top 4 normalised. Painted edits `applyEdits` (`:310-321`) overwrite per (mesh index, vertex) by bone NAME. SkinnedMesh is bound to the body skeleton with the body's bindMatrix. `hideCovered` (`:389-432`) removes body triangles whose three vertices sit within 5% height under a garment surface and lie "outside" along the body normal.

The identical function set is reused by `tools/lib/gearskin.ts` for the game, so viewer and game weights agree (including painted edits), with bones mapped by name onto the export joint list.

### 5.2 Part pinning
`partSpot` (anchor else bbox centre of the placed meshes) -> `spotWeights` (closest triangle within 40 rings, barycentric weights, top 4) -> `partWeights` (same four indices/weights for every vertex). A part whose chosen `animation` exists is a mechanism: instead of skinning, a group riding the spot's leading bone (`spotWeights(...)[0][0]`) holding a cloned skinned model and a `THREE.AnimationMixer` (`:499-520`); mixers are stepped by `tickMechanisms`. Fitting (placing) shows a static unbound mesh in a group the gizmo moves (`:521-531`) and `commitFit` writes the node's world pos/euler/scale back to the garment.

### 5.3 Rigid props and placement math
`garmentMatrix` (`placement.ts`): compose(position, quaternion from Euler XYZ degrees, uniform scale). A rigid garment: `bone -> group (inverse of bone's rest frame, no scale) -> place (garmentMatrix) -> meshes` (`garments.ts:479-495`). `restFrame` = compose(rest worldPosition, rest worldQuaternion, 1). Thus placement is expressed in character rest space; the viewer, animation baking (`withPropTracks` writes placement tracks for every visible rigid garment on every clip, `animation.ts:24-37`), and the export share it. `setBone` (`outfit.svelte.ts:243-292`) moves a prop to the opposite side of the body by a reflection across its thinnest axis (Jacobi eigenvector, `thinnestAxis` `:538-567`) followed by an X mirror (a proper rotation, so the mesh is not flipped); any other bone change keeps the rest-space placement.

Legacy catalog props use a different system (`props.ts`): `gripFrame` builds a per-socket frame from the bone's rest quaternion (+Y forward, +Z up, +X right), anchors the origin at a fraction along the bone toward its farthest child (`ANCHOR` table), offsets in multiples of the bone length (`unit`), `defaultPlacement` table per socket/category, scale `height/1.6`.

### 5.4 Pulls (`src/engine/pulls.ts`)
A prop with pulls is skinned to its own mini skeleton: `PropRoot` (rides the prop) + one `Prop_<prop>_<pull>` bone per pull at `rest` (`rigPulls` `garments.ts:565-594`). Each mesh is cut at each pull's rest with `splitStrand` (find connected component nearest the point via union-find with welded positions, long axis by power iteration, cut every triangle crossing the plane, interpolate all attributes), then `defaultPullWeights` (vertices of that strand within 2% of its length of the point follow the pull, others 100% root) then painted edits by bone name. `tickPulls(clip, at)` per frame (`viewer.svelte.ts:54`): `holdFactor(holds[clip], at, ease 0.03)` (ease in over 3% before a window, let go over 1% after) lerps the pull bone from `rest` toward the pulling bone's `grip` converted into the root's space. `findHolds` (`outfit.svelte.ts:426-460`) auto-detects windows (5.7 notes problems). Hand pose while pulling goes through `handScripts` as a `grip` script with `during = holds` (`scripts.ts:55-62`).

### 5.5 Mount seating (`src/engine/mount.ts`)
`straddle(horse, rider, k)` (`:44-112`): raycast the horse surface at rest from above along the middle 25-70% of its spine to find the lowest back point (the saddle seat); the nearest spine/pelvis bone is the seat bone; the barrel half-width by horizontal rays down a third of the horse's height; the rider's Hips placed a tenth of his height above the seat (with `k` scale); per leg, knee and foot targets solved by two-bone geometry (thigh swung from rest toward the knee; shin bent to the foot; foot level), producing `pose` quaternions for UpLeg/Leg/Foot/Hips and `freeze` = LOWER_BODY. `riderScale` = (rider game/own height)/(horse game/own height), else `Mount.scale ?? 1`. `seatMatrix(mount, scale)` = compose(position, euler(rotation), scale). `freezeClip` replaces tracks of frozen bones with constants. `fitRide` fits rider/horse clips: loops by whole-number cycle ratio m:n (<=6, minimising mismatch; rider retimed to match), attack: horse retimed to rider, else unchanged. Same code is used by the animator (`animator.svelte.ts:18`) and by `tools/game_export.ts:37,515,702-706`.

### 5.6 Carry pose / hand scripts (`src/engine/scripts.ts:39-64`)
`handScripts(character)` = the character's own scripts + for each side without an enabled own grip script and a visible ready rigid garment whose `bone` is that hand (first match only): a synthetic `grip` script (clip = `carryPose ?? DEFAULT_FIST`, `open = carryOpen`), unless `carryPose === 'open'`; + for each visible rigid garment's pull whose bone is a hand and `pose` is set: a synthetic `grip` script with `during = holds`. `pose:<id>` is resolved to the character's HandPose object. Used by animator, clip editor, bake and the game export.

### 5.7 Algorithm caveats
- `findHolds` uses `strandSegment`, which takes the FIRST mesh of the prop (`:597-599`), while `strandMiddle`/`addPull` scan all meshes; a multi-mesh bow can find the wrong strand.
- Pull `rest` is stored in model space but `addPull` computes it in `node` (placed) space with `c.applyMatrix4(m.matrix)`, correct only if the garment's local mesh matrix is identity relative to the model; for rigPulls the meshes are created in `meshesOf(... identity)`, i.e. with their node matrices baked, so consistent.
- `setBone` mirroring only fires when the prop is on the side-counterpart bone and nearer the other side.

### 5.8 How it reaches the game export (`tools/game_export.ts`, `tools/lib/gearskin.ts`)
- Only garments with `from` starting `emberhold:` are exported; all others are skipped with a warning (`:387-396`). Hidden ones are skipped unless named `Gear*`, `Head*` or `Wear*` (`SWAPPED`, `:106`, `:390`). `character.props` (catalog) are always dropped with a warning (`:506`). The tool header says "only parts the game built go in (AGENTS.md, every model starts in Blender)".
- Clothing/part: `gearSkin` (5.1/5.2) -> geometry transformed to game space -> one merged mesh named after the garment weighted to the export skeleton, `lead` bone; hideBody "not applied"; mechanism "still" (`:410-424`).
- Rigid: a single-bone weighted mesh on the garment's bone (`ride`); if the prop is keyed in any exported clip (`keys.props[name]`) it gets a dedicated bone `Prop_<name>` under its bone at its pivot that clips move (`:430-443`, `propTracks`, `:694`). With pulls: pull bones `Prop_<prop>_<pull>` under the riding bone, mesh split and weighted with `pullSkin`, per clip pull tracks following `holdFactor` (`:723+`).
- Mount: rider's game space placed on the horse's seat bone with `seatMatrix`; frozen clips; fitted ride clips; horse `skin` and `gear` (`:599-644`).
- GLB export (`ExportPanel` -> `exportCharacter`): `loadExportView` attaches catalog props (if toggled) and ALL ready non-hidden garments (`exporter.ts:34-42`); it does not apply the game's `from` filter. Pull rigs are exported as in the viewer's scene graph.
- `tools/game_import.py` goes the other way: reads a built unit, creates rigid garments `from: emberhold:<unit>/<part>` (moving pivot, hidden unless the game would show it).
- Godot side: `godot/rigsmith_lods.gd` for LODs; props "export as bone attachments (BoneAttachment3D)" per the comment in `props.ts:1-3`.

---

## 6. Cross-area dependencies

| Depends on / feeds | Where |
|---|---|
| Rig: skeleton, `view.rest` bones, body weights (`bodySurface`), template (non-human = horse), `status === 'rigged'` gate. A re-rig changes bone indices, so painted edits are by bone NAME (good) but a re-rig that changes names loses them. | `garments.ts:196-215`, `OutfitPanel.svelte:142`, `horses` `:112` |
| Rig -> Hand poses: `HandPoseSelect` imports state `handposes` (shared poses via `handPoses.useShared`). | `src/app/rig/HandPoseSelect.svelte`, `scripts.ts:39` |
| Rig weight painting: `WeightPaintPanel` + `paint.svelte.ts` + `WeightPainter` (`weightpaint.ts`) reused for garments (`paint.garment`). | `OutfitPanel.svelte:411-413` |
| Animate: clip list, `animator.playEntry/playFists/stop/refresh/holding`, Timeline; `animator.character`, `animator.horse`, `attachMount`. | `OutfitPanel.svelte:3-4,54,109-130`, `viewer.svelte.ts` |
| Animate -> Edit: grip sockets (`garment.sockets`) by garment NAME, carry hand pose and `carryOpen`, pull holds and poses (duplicates of the Outfit fields); prop keys `AnimationEntry.keys.props` by garment name; `propfit.ts`, `twohand.ts`, `clipedit.ts` (`carrierGrip` from Outfit placement). | `clipedit.svelte.ts:61,556-800`, `EditPanel.svelte:101-160`, `animation.ts:24-37` |
| Scripts: `handScripts` (grip scripts from carry/pull), `blow` script feeds `findHolds`. | `scripts.ts`, `outfit.svelte.ts:453` |
| Texture: garments are not part of texture painting (no matches for garment in the texture area); garments keep their own materials. Export `gearModel` maps materials named `Main(.n)` onto the body's single "Main" material. | `game_export.ts:369-383` |
| Export step: GLB export (catalog props toggle + garments), GameUnitPanel (heights, companion, scale room), game export (5.8), `server/game.ts` unit spec (`putUnit`, `/game` heights). | `ExportPanel.svelte`, `GameUnitPanel.svelte`, `scaleroom.svelte.ts` |
| Server: Blender job `jobs/inspect.py --animations`, job queue (`enqueue('garment', ...)`), journal (`server/journal.ts:37-69`), SSE `character` events, workspace atomic JSON. | `api.ts:706-743` |
| Tools: `tools/rig.ts ride`, `tools/game_import.py`, `tools/game_export.ts`, `tools/lib/gearskin.ts`, `tools/dev/coat_weights.ts` (a hand tool for coat weights). | |
| App shell: `app.selected`, `app.update`, `app.upsert`, `app.toast`, `app.gameBeat`; `Viewport.svelte:38-46` re-syncs on any change of props/garments/mount/fitting. | |

---

## 7. Redundancy and overlap

1. **Two accessory systems for the same job: `Character.props` (catalog `PropAttachment`) vs `Character.garments` (`mode: 'rigid'`).** Both are "an object that rides a bone". Differences: props: 9 sockets, grip-frame, bone-length units, `defaultPlacement` table, mounted under a `_mount` group (`props.ts:139-161`), no hidden/group/pulls/sockets/weights/carry pose, not visible to the editor, scripts, game export; garments: 18-bone list, rest-space placement (`placement.ts`), everything else. Different placement math, different panels (`OutfitPanel.svelte:192-233` vs `:235-410`), two Gizmo state pairs (`selected` vs `fitting`/`focus`), two persistence calls (`save`/`patch` vs `patchGarment`), two loaders (`props.ts:85-96` and `garments.ts:45-56` duplicate GLTFLoader+cache), two detach paths. Real data: 2 props total on 2 characters vs 85 garments. The export explicitly drops catalog props (`game_export.ts:506`). The catalog could simply be a source of garments.
2. **Three "kinds" are one data structure with a `mode` switch** (`Garment.policy` and `bone` are present on all, `bone: 'Head'` for non-rigid, `hideBody` only for clothing, `anchor`/`animation` only for part, `pulls`/`sockets`/`carry*` only for rigid). The Kind select (`OutfitPanel.svelte:285`) can change it after the fact without resetting inapplicable fields (e.g. clothing->prop leaves `bone: 'Head'`, so the prop rides the head).
3. **Clothing vs part are the same algorithm at different granularity** (per-vertex body-weights vs one spot's weights). A "part" is clothing whose weights are smoothed to a single sample; a mechanism is a rigid prop whose bone is chosen by the same spot lookup. Neither has ever been used in the workspace.
4. **Sockets/grips are split across areas.** Carry socket = Outfit (`bone`, `carryPose`, `carryOpen`), other-hand grip sockets = Animate -> Edit (`sockets`), pull sockets = Outfit (point, bone) plus Animate (holds per clip, pose). Three different socket concepts: `Socket` type (props.ts, 9 body sockets), `GarmentSocket` (editor grips), `PullSocket` (pull). Naming: "socket" means three things; the Outfit panel section titled "Sockets & pulls" shows neither grip sockets nor the 9-socket choice.
5. **Same fields editable in two panels:** `carryPose` (Outfit `OutfitPanel.svelte:362`, Animate `EditPanel.svelte:127` via `clipEdit.setFist`, which silently writes to `carryPose` OR the character's grip script depending on whether a prop is on the hand, `clipedit.svelte.ts:746-770`); pull `pose` (Outfit `:389`, Animate `:149`); pull `holds` (Outfit text per clip + Find `:399-406`, Animate "Held in this clip" + two buttons). Hold-window text parsing is copy-pasted: `OutfitPanel.svelte:57-58` and three times inline in `EditPanel.svelte:136,159`.
6. **Hand pose / fist machinery has three entry points:** default fist constant (`scripts.ts:32`), the character's own "Hold fist" grip scripts (Rig/Animate), carry pose on a garment, and Hand poses (Rig). `handScripts` plus `clipedit.handPoseOf/fistClip/setFist` encode "which one wins" in two separate places (`scripts.ts:46-53` and `clipedit.svelte.ts:664-669,757-765`).
7. **Pose picker duplicates the Timeline/Animate player.** `OutfitPanel.svelte:145-153` re-implements "pick a clip to look at" (plus a fake "fists" pose = `animator.playFists`, a special case in `animator`, `outfit` and `clipId === 'fists'` branches `OutfitPanel:109`, `viewer.svelte.ts:103`). The Timeline is already docked.
8. **Weight painting: one component, two meaning-different uses.** `WeightPaintPanel` serves the Rig body (title "Fix weights", "Saved weights go into the rig") and garments (title is the same "Fix weights" in a section called "<name>"/"Weights" in Outfit; the pulled prop path changes labels and bones). Pull-prop "Weights" semantics (rigid/soft slider via bone select) are unrelated to body weighting yet share the 6-tool UI (Heal/Follow/Bone make no sense on a bowstring). The Weights panel is also embedded conditionally in two branches of an `{#if}` (`:411-419`).
9. **Placement in Outfit vs per-clip prop keys.** Outfit placement (`position/rotation/scale`) is the base; `AnimationEntry.keys.props[name]` (Animate) keys offsets per clip from that base; `withPropTracks` (`animation.ts:24-37`) rewrites placement tracks for every rigid garment on every clip; the game export adds a `Prop_<name>` bone only if keyed. So "where it sits" has three sources: Outfit placement, grip socket "Move entire path / adjust its socket" in the editor (updates sockets, not placement), and keys. The editor's note "its carry socket is its Outfit placement" documents this.
10. **Height in two places:** `GameUnitPanel` number input and `ScaleRoom` slider+number both write `UnitSpec.height`; Import -> Size and server `scale` (`api.ts:560-590`) are a third scale concept (character `scale`, `stats.height`, game `height`, `Mount.scale`, `riderScale` ratio, and default prop `scale = height/1.6`).
11. **Mount lives on the rider (`Character.mount`) but its inputs also live in the game spec** (`UnitSpec.companion` in `workspace/game/units.json`: `character`, `height`, `prefix`, `ridden`). `game_export.ts:282-285` throws if the two disagree; the Outfit Mount UI and the Export "Rides / leads" select (`GameUnitPanel:82`) can set different horses.
12. **Switch sets vs `hidden` vs name-pattern conventions.** `hidden` (per piece), `group` (set) and the game export's `SWAPPED = /^(Gear|Head|Wear)/` name regex (`game_export.ts:106`; also `ScaleRoom.svelte:46`, `game_import.py`) are three mechanisms for "which one is on", the third implicit in names. `group` is never used in the workspace.
13. **Duplicate geometry helpers:** `strandNear`/`strandMiddle`/`strandSegment`/`thinnestAxis`/`splitStrand` in `pulls.ts` and `outfit.svelte.ts:536-608` (store contains 70 lines of pure geometry); `TriangleGrid` in `garments.ts`; `weightpaint.ts` has its own closest-point/follow machinery; `props.ts`'s and `garments.ts`'s loaders; `garmentMatrix` is re-exported from garments.ts. `restFrame` (garments) vs `gripFrame` (props) are two "bone rest frame" functions.
14. **Bone lists:** `OutfitPanel.bones` (18 hard-coded humanoid bones, `:89`), `SOCKETS` (9, `props.ts:10`), `pullBones` (hands + rest order, `:54`), `LOWER_BODY` (`mount.ts:11`), `ANCHOR` table. Four different bone vocabularies, none template-aware (a horse-mounted rider is fine, but a prop on a creature/horse garment offers only human bones).
15. **Legacy / vestigial:**
   - `PropAttachment.ref` `custom:<id>` and `propUrl` branch `/files/props/<id>/model.glb` (`props.ts:62-65`): nothing creates custom props any more (replaced by garments).
   - `ExportPanel` "Include props" (only catalog props) while garments always export in GLB; the label "Props" for two different concepts.
   - `garmentMeshes` exported but only used inside `garments.ts`; `createProp`, `detachProps`, `PROP_FLAG`, `propUrl`, `readOffset` exported but internal.
   - Socket naming hack `'(carries it)'` in `clipedit.svelte.ts:61` and `clipedit.ts:76` (`carrierGrip` creates a socket that is filtered out again).
   - `GarmentSocket` (server) lacks `placed?` that the editor's `Socket` adds (`clipedit.ts:60-63` vs `workspace.ts:166-171`).
   - `Garment.policy` required for rigid/part; `Garment.hideBody` required boolean.
   - Comments referring to older UI: `OutfitPanel.svelte:151` mentions fitting "on a clip", "Props export as bone attachments" (`:231`) true only for the GLB export; `Garment.animation` doc says played while worn but the game gets it still; `workspace.ts:57` "Props/accessories pinned to bones" for the legacy field.
   - README says "Props from the catalog ... pinned to sockets with a gizmo" and "props as bone attachments" in Export, while the game export drops them.
16. **Server whitelisted PATCH for everything** means `garments`, `props`, `mount`, `skins` are all whole-array replaces; the same array is edited by Outfit, Animate -> Edit (`clipedit.svelte.ts` builds new garment arrays at 640, 686, 722, 760, 782, 789), the weight routes (`painted`) and Python (`game_import.py` PATCH). Concurrent writers can clobber each other (the app takes SSE `character` events to mitigate).

---

## 8. Rough edges

### Confusing UI / naming
- "Props" means: the left-column catalog (legacy), the "Prop" kind (rigid garments), the `Attached` section (only legacy props), the Export toggle "Include props", and `AnimationEntry.keys.props` (garments). "Attached" (props) and "Accessories" (garments) are adjacent sections for what the user sees as the same thing.
- Order of sections is by implementation history, not workflow: Pose, Mount, Attached, selected-prop, Accessories, current-garment, Sockets & pulls, Weights. Mount is above the thing you do first. The Pose picker is at the top yet only matters while placing.
- Both the "selected prop" section (`:213`) and the "current garment" section (`:280`) can be shown at once: `outfit.select` clears `fitting` but not `focus`, and `outfit.open` sets `focus` but not `selected` (`outfit.svelte.ts:203-214`, `OutfitPanel:42-47`); two gizmo contexts, two different "Scale" inputs.
- Prop/garment number inputs differ: legacy position in bone-length units step 0.05, garment in rest-space metres step 0.01; both labelled "Position".
- Kind select changes semantics destructively (see 7.2) and, for parts/clothing converted back, leaves stale fields; there is no confirmation.
- Gendered, odd copy: "Place him", "Held still in the seat", "Take the legs from the pose playing", "Rides" (a character-level verb) with the rider's name never shown.
- Parts: "Pinned to" is a read-only display field; "Pick the spot on the body" requires being bound; "Place it" before binding shows the part unbound ("Shown unbound while you place it") and the Weights section shows nothing for parts.
- Pulls: the explanation paragraph is long and the same concept appears as "pull socket", "Draw", "strand", "Rigid <-> soft", "Pulled by"; "Find" is a bare link; the hold windows are free-text with hidden syntax "0.12-0.45, 0.7-0.9" as fractions of clip length rather than seconds/frames; clip names rather than ids key the windows.
- Hidden state is communicated by a dimmed name and an eye icon; "Switched off" and "hidden" are used interchangeably; the tooltip notes game exceptions for Gear/Wear/Head names, which a user can't see.
- The ScaleRoom lives in Export, but the user of Outfit > Mount expects to size the rider there; the Mount section gives no hint that sizing derives from game heights.
- Mount: no way to see/change `scale`, `skin`, `gear`; 3 of 3 existing mounts rely on them.
- The "Bone"/"Heal"/"Follow" weight tools (body-centric wording: "legs under a coat") are shown on a bow.
- Accessory upload: the whole panel for a bad import is a row "failed" with no error text (garment `error` is not displayed) and no retry; a name can't be edited after import.
- No catalog-to-garment path; no preview thumbnails for garments; no duplicate / mirror garment (mirror to the other hand is only through the bone select, only for the opposite-side bone).

### Risky behaviour visible in code
- Garments are identified by NAME in other subsystems (`keys.props[name]`, `carryOpen` owner lookup `g.name === prop` in `clipedit.svelte.ts:675`, `Mount.gear` names, pull bone names `Prop_<name>_<pull>`, `game_export.ts:471` throws on duplicate bone name, `Gear*` regexes). Uploading two files of the same name, or renaming (no UI), silently breaks keys/sockets or throws at export.
- `removeGarment` (`outfit.svelte.ts:462-468`) leaves the folder on disk, leaves `keys.props[name]`, `mount.gear` entries and `carryOpen` references pointing at a missing garment; there is no server DELETE. Weights file orphaned.
- `playClip`/`holds`/`carryOpen` are keyed by the clip's `name`; renaming a clip (Animate) or saving to a slot with another name silently drops windows.
- Every garment patch (even `holds`, `carryPose`, `group`, `hidden`) changes `garmentKey` (`outfit.svelte.ts:90`; only `sockets` is excluded), forcing `detachGarments` + a full re-skin of ALL garments (`computeWeights` is synchronous main-thread work per vertex with a 6-ring grid search and Laplacian smoothing) and an `animator.refresh(true)` (retarget again). Hold-window typing, hiding an item, or the eye toggle on a 85-garment villager re-attach everything. `fetchEdits` re-fetches weights.json each attach.
- `outfit.busy`'s `garments.some(g => g.status === 'ready' && g.id !== fitting)` shows "Fitting clothes" even for pure rigid garments.
- `findHolds` blocks a polling loop up to 5 s (`100 x 50 ms`), is not cancellable, resets the animator to time 0 afterwards, pauses playback, and writes `holds` for only the first plausible window; `strandSegment` uses the first mesh only. Disabled `Find` while another is running.
- `setHolds` input is not validated beyond number parsing (windows may overlap or be reversed; reversed are swapped).
- `pickSpot` and `pickPullPoint` register capture-phase pointerdown listeners; the overridable `stopPicking` field (`:350`) is only cleaned up if the user clicks the button again or hits the target; changing step, character, or garment while picking leaves the listener attached and `picking` set (no cleanup on unbind: `bind()` does not call it). `picking` of the pull is a string composed `id:pullId` compared in the template.
- `setMount` fetches `/api/characters/<id>/game` and silently falls back to a null game height; the horse is loaded twice (once for straddle, once for the viewer) and the temporary `CharacterView` `hv` is never disposed (`outfit.svelte.ts:159`).
- `patchMount` calls `animator.stop()` only when nothing is playing, otherwise `animator.refresh`, so changing `freeze` mid-clip re-bakes the ride; the seat gizmo is world-space, not horse-bone-space.
- Mount seat vs game spec mismatch throws at game export (`game_export.ts:283-285`) rather than being visible in the UI.
- PATCH replaces the entire `garments` array from client state (`outfit.svelte.ts:297`): if another writer (Python `game_import`, a second tab, Animate -> Edit) changed the garments between SSE events, the latest click overwrites them.
- `GarmentEdit` painted weights are keyed by mesh index of the model and bone NAME; replacing a garment's mesh (new upload under the same entry; `game_import.py` writes `model.<hash>.glb`) invalidates them silently (`painted` count stays).
- `hideBody` removes body triangles in the viewer only; the game export says "not applied (the body is whole in the game)". `hideCovered` writes to `body.mesh.geometry` index and relies on `userData.fullIndex` for restore; it is applied in `attachGarments` but `detachGarments -> restoreBody` runs at the start of every attach.
- Game-side scope surprise: everything made in the Outfit step by hand (clothes, parts, props with pulls and carry poses) is skipped by the game export unless it was imported from the game (`from: emberhold:`), so Outfit is currently a viewer/GLB feature plus an editor for already-imported game gear. This is documented only in code comments and the README.
- `Garment.bone` for clothing/part defaults to `'Head'`; `detail()` and `OutfitPanel` never show it, but `clipedit.props` / `handScripts` filter by `mode === 'rigid'`, so fine; a conversion bug is the only way it leaks.
- Held-bone list in Mount only lists LOWER_BODY plus frozen ones, so freezing e.g. the spine requires editing JSON.

### Missing / thin test coverage
- `garments.test.ts` has 3 tests (part weights, spot, applyEdits); `pulls.test.ts` 5; `gearskin.test.ts` 6. No tests for `computeWeights`, `attachGarments`, `setBone` mirroring, `straddle`, `fitRide`, `freezeClip`, `findHolds`, `hideCovered`, or the server garment routes.

### Legacy comments / docs
- `README.md:21` and `:25` still describe the catalog as the primary prop path and props "exported as bone attachments"; `HANDOFF.md:45` mentions "prop carriers, attachments, authored fists" as protected in the editor (only garments).
- `scaleroom.svelte.ts:1` and the ScaleRoom header describe it as the way to "set its height by eye"; it is the only UI that can size a mounted horse, but is described as a unit tool.
