# Inventory 4: the animation editor (Animate -> Edit)

Scope: `src/app/animate/EditPanel.svelte`, `src/state/clipedit.svelte.ts` (the `clipEdit` singleton), the engine files
`clipedit.ts PoseEditor.ts ik.ts bodysolve.ts bodycollide.ts posespace.ts handcontacts.ts surfacecontact.ts twohand.ts
twohandpose.ts propfit.ts clipexport.ts limits.ts`, `server/clipedits.ts` + the two library routes in `server/api.ts`,
`blender/clips/edit.py`, `tools/{posespace,rom,twohand_poses}.ts`, `static/templates/rom/*`. Boundary: the Timeline
(`Timeline.svelte`), Library, slots (`slots.svelte.ts`), Scripts and Tune panels belong to the Animate-library agent;
they are only noted where the editor touches them. Read-only audit; nothing was run.

Line references are `file:line` as of commit 36f9295 (clean tree).

---

## 1. Purpose

The editor lets the owner open the clip that is playing on the character (or freeze one frame as a new "held" clip),
pose it by dragging joints / props in the viewport, and key those poses. Props (rigid garments such as a spear) can
"lead" the body: hands attach to prop grip sockets and a whole-body natural-pose solver moves the body to follow.
"Naturalize" then smooths the whole clip toward how people move. Saving takes the result back off the character onto
the base clip's own skeleton and writes a new library clip (or overwrites the slot's previous custom clip), optionally
re-pointing the character's slot at it.

---

## 2. UI surface

### 2.1 Where it lives
- Mounted as the first section of the Animate step: `src/app/steps/AnimatePanel.svelte:83` (`<EditPanel />`), shown only
  when the character is rigged (`AnimatePanel.svelte:77`).
- Companion UI that is NOT in the panel but is part of the editor experience: `Timeline.svelte` (scrub, frame box,
  play/pause, keyed-frame diamonds at `Timeline.svelte:101-107`, Previous/Next key at `:127-133`, Loop toggle which
  routes through `clipEdit.setLoop` at `:119`, In place / Mirror disabled while editing `:120-121`). `Viewport.svelte:77,117,120`
  shows the busy spinner and the `clipEdit.busy` text. Boundary: the Timeline is the library agent's.
- Viewport overlay: `PoseEditor` (joint handles, bone lines, `TransformControls` gizmo) added to the stage scene.

### 2.2 Panel states (EditPanel.svelte)
The whole body is a `<fieldset disabled={busy}>` (`:60`) so every control is dead while a job runs.

**Not editing** (`:61-70`)
| Control | Line | Does |
|---|---|---|
| Hint text | 62 | "Edit the playing clip, or hold its current pose to start a new animation. Save creates a new library clip." (inaccurate when a slot is being edited: see 8) |
| "Edit playing clip" button | 63-65 | `clipEdit.start()`. Disabled if nothing plays or `current.url === ''`. Label flips to "Play a clip to edit it". |
| "Length" number (0.2-20 s) | 67 | Length of the new held clip; `aria-invalid` when out of range; validity text at 70. |
| "New clip from this frame" | 68 | `clipEdit.startFromPose(seconds)`: freezes the pose at the playhead for `seconds` (`holdOf`, clipedit.svelte.ts:126-143). |

**Editing** (`:72-188`)
| Control | Line | Does |
|---|---|---|
| Gizmo segmented: Move (G) / Rotate (R) | 73-76 | `setGizmo` -> `PoseEditor.setMode` (clipedit.svelte.ts:355). Applies to joints and props. |
| Local / World segmented (Rotate only) | 77-82 | `setSpace` (clipedit.svelte.ts:356). Prop rotate honours it; prop move is always world (PoseEditor.ts:258). |
| Target `<select>` | 84-90 | Selects a prop (optgroup "Props") or joint ("Joints", all bones, `prettyBone`); "Select a joint or prop..." deselects. Only way to select hidden/tiny joints. |
| Status line | 91 | "N bones keyed - M keyed frames. Drag a joint or prop, then release to key this frame." |
| "Delete keys here" | 93 | `deleteHere()`; disabled when no key at playhead for the selection (`keyHere`, :21-27). |
| "Clear all keys" | 94 | `clear()` (removes all bone keys, prop path keys, holds, groups). **No confirmation, no undo.** |
| Toggle "Joint limits" | 96 | `setLimits` rebuilds the PoseEditor with/without `JointLimits` (also changes the rebuild solver and Naturalize). |
| Length number (held clips only) | 98 | `setLength` (clipedit.svelte.ts:146) re-holds the base clip at the new length; keys keep their phase. |
| Prop box (only when a prop is selected) | 100-168 | see below |
| Naturalize / Naturalize again | 172 | `naturalize()` (only when `clipEdit.natural`, i.e. a person with the pose model). "Ready to save" label at 173. |
| "Cancel naturalization" | 59 | `cancelNaturalize()`; shown while `naturalizing`. |
| Name text | 176 | Defaults "New clip" (held) or "<base> edit" (:33-37). |
| "Save to <slot>" | 178-181 | `saveToSlot(name)`; only when editing a slot clip. Primary. |
| "Save new clip" | 182 | `save(name)`; library copy only. |
| "Finish editing" | 183 | `stop()` - **discards all unsaved keys silently**. |
| Footer help line | 185-187 | Explains Save to slot vs Save new clip, or "Make a pose change or naturalize the motion to save." |
| "Editing tips and shortcuts" `<details>` | 190-196 | Static help (see 2.4). |

**Prop box** (`:100-168`, shown when `clipEdit.prop !== null`)
| Control | Line | Does |
|---|---|---|
| Name + X (deselect) | 104 | `selectProp(null)` |
| Toggle "Prop leads the body" | 105 | `setLocked(prop,on)` (clipedit.svelte.ts:817). On = lock the path and, for a person, run the whole-clip prop fit (`fitPath`, ~10 s, async, with progress). |
| Toggle "Adjust its socket" | 106-107 | Sets `clipEdit.socketDrag`. Prop drags then move the prop in its socket instead of leading. |
| Toggle "Move entire path" | 108-109 | `propMoves = 'every' | 'frame'`. Meaning flips depending on "Adjust its socket": every-frame path offset, or edit the socket itself in every clip (changes Outfit placement). |
| "Grip sockets": Left hand / Right hand selects | 110-122 | Pick an existing socket per hand (`attach`), "Free"/"Outfit placement" (`detach`). Socket already used by the other hand is disabled. |
| Per-hand row: "<hand> hand - carries it", hand-pose picker | 123-130 | `HandPoseSelect` -> `setFist(hand, clipId)` (writes a Hold-fist script or the garment `carryPose`, then `reopen`). Trash button deletes the socket from the character (`release` -> `removeSocket`). |
| "Opens in this clip" text + "up-arrow" button | 131-139 | For the carrying hand: free-text windows `a-b, c-d` (phases 0-1) -> `setCarryOpen` (garment `carryOpen[slot]`). Button = "open from the frame shown to the end". Needs a slot. |
| Pull rows (bowstring etc.) | 144-165 | Per pull socket: hand-pose picker (`pull.pose`), "Held in this clip" window text, "held from here" and "let go here" buttons -> `setPullHolds` (pull `holds[slot]`). Pull point itself is set in Outfit. |
| Empty hint | 142 | "Drag a hand onto the prop to create a grip socket." |
| Footnote | 166 | Which of the above are character-wide vs clip-specific. |

### 2.3 Viewport interactions (PoseEditor.ts)
- **Handles**: one sphere per bone (`PoseEditor.ts:106-120`), hips = yellow diamond (x2.2), "ends" (hands, feet, head, hoofs:
  anything in `rig.limbs`) blue x1.4, small finger/ear/mouth/_End joints x0.5, others x0.85; selected pink; hover/selected
  scale x1.35; roughly constant screen size (:313). Bone lines drawn (:121-126). `depthTest:false` so they show through the mesh.
- **Pointer down on a handle** (`onDown` :358): picks the smallest, then nearest handle (:331) -> selects it and starts a
  plane drag (camera-facing plane; hips use an upright plane). `kind` = `hips` | `reach` (limb end) | `swing` (anything else).
  Disables orbit controls. Only button 0; ignored when over the gizmo (`overGizmo` :336).
- **Drag** (`onMove` :384-398 -> `moveJoint` :402-435):
  - limb end (hand/foot/head/hoof): 2-bone IK `reach` with joint limits, end keeps its world turn (`keepEnd`).
  - hips: `moveHips` - up/down only unless **Shift** held; legs reach back to planted feet; floor kept (`keepOffFloor`).
  - any other joint: swing the parent bone toward the pointer (one bone, clamped to limits).
  - After each move `events.constrain` runs (clipedit.svelte.ts:276 -> `keepLeading()` + `handsLive()`), then feet pushed off floor (`keepFeet` :448).
- **Release** (`onUp` :454) -> `commit(moved bones)` -> keys. A click without movement commits nothing (just resumes play).
- **Pointer down on a prop mesh** (no handle under the cursor): `pickProp` (:349) -> `selectProp`. Handles win over props.
  Clicking empty space does NOT deselect (only Esc, the X, or the Target select).
- **Gizmo** (`TransformControls`, size 0.7): attached by `attachGizmo` (:254-287)
  - joint + Move: a proxy at the joint; dragging calls `moveJoint` live (same as a handle drag).
  - joint + Rotate: gizmo attached to the real bone; local/world per `space`; limits clamp each change (:164).
  - **grip-locked hand** (hand on a socket, or carrying a leading prop): proxy placed at the fist, axes = the prop's (red along
    shaft); Move slides/offsets the hand with its turn kept; Rotate turns about the grip (`moveHeld` :219, `gripLock` :215).
    Release moves the socket "exactly" (`placed: true`).
  - prop: proxy on the prop node; Move = world translate, Rotate honours Local/World; `objectChange` -> `moveProp`
    (live: `propLive`; done: `commitProp`).
- **Hover** updates `clipEdit.hovered` (state field, appears unused by any UI; grep finds only the write at clipedit.svelte.ts:269).
- **Snap-to-prop**: a free hand released with its fist within `SNAP_REACH` (10% of body height, clipedit.svelte.ts:46) of any
  other-than-carried prop's shaft auto-creates a grip socket, snaps/rolls the fist onto the shaft, and attaches the hand
  (`snapTarget` :426, in `commit` :411-419). No visual affordance beforehand.
- **Carrying-hand re-grip**: moving the hand that carries a leading prop creates a socket for it where it is now
  (`commit` :402-410).

### 2.4 Keyboard
Window-level `keydown` in `EditPanel.svelte:46-52` (only while editing, not busy, and `allowsShortcut` = no modifier, not
in input/select/button/summary etc. targets, `shortcuts.ts:2`):
- `Delete` / `Backspace`: `deleteHere()` (prevents default).
- `Esc`: deselect joint and prop.
- `G`: Move gizmo. `R`: Rotate gizmo.
From the Timeline (not owned here, `Timeline.svelte:75-82,63-73`): `Space` play/pause, `,` / `.` step a frame; on the
focused scrub bar arrows (Shift = 10), Home/End, Space. `Shift` while dragging the hips frees them (PoseEditor.ts:377,396).
No undo/redo, copy/paste key, or select-all binding exists. Hotkeys do nothing while a button/select has focus (e.g. right
after clicking the Move/Rotate buttons), a mild trap.

### 2.5 Progress / busy surface
`clipEdit.busy` string drives: sticky spinner status in panel (:58), Timeline disabling, Viewport overlay text. Set by
`start` ("Opening the clip"), `fitPath` ("Fitting the prop to the body" + per-frame labels), `naturalize`
("Naturalizing every frame" / "N%" / finger-pass phase labels), `save` ("Saving the clip..." / "Writing <name> into the library").
Toasts (`app.toast`) report fit result, naturalize result/errors, save result/errors, socket changes.

---

## 3. User workflows

### 3.1 Edit a slot clip (the main flow)
1. In Animate, play one of the character's slot clips (e.g. Attack) or a library preview.
2. "Edit playing clip" -> `start()` (clipedit.svelte.ts:163-229): loads the source clip skeleton (`loadSource`), fetches
   `/templates/rom/<rig>.json` (limits) and, for a person, `/templates/rom/human-pose.json` (pose model), builds `JointLimits`,
   a `PoseEditor`, and the natural body solver bound to the character's collider. Playback pauses. The editor starts on the
   **already-baked** playing clip (`animator.clip`: for a slot that is speed + scripts + ground + Tune keys + prop keys).
3. Scrub to a frame (Timeline), drag a joint or use the gizmo, release: `commit` keys every bone the drag moved at that
   frame (turn from where the clip had it), plus end pins at 0 and 1 for a non-held clip (`keyBones` :450-466); `show()`
   rebuilds the whole clip (`buildEdit`) and displays it.
4. Repeat; use Target select for hidden joints; Delete removes keys at the frame; Loop button on Timeline changes tweening wrap.
5. Optional: toggle Joint limits, Naturalize.
6. Name it; "Save to <slot>" (writes library clip, then updates the slot entry and plays it) or "Save new clip" (library only).
7. "Finish editing" leaves (the edited clip stays displayed as "(editing)" but is unsaveable: `edited:true`).

### 3.2 New clip from a frame
Pause on a pose -> set Length -> "New clip from this frame" -> `holdOf` creates a constant clip (every track's value at the
playhead at t=0 and t=seconds). `held=true`: no end pins; keys hold between each other; Length field appears; loop off.
`slot=null` so only "Save new clip" exists. Hint text elsewhere says Naturalize/etc. all work the same.

### 3.3 Props leading vs socket adjustment (two modes, one gizmo)
- **Leads (default drag)**: click prop (or Target select) -> Move/Rotate -> release: `commitProp` keys a world-space delta
  from where the prop rode in the base clip (`rodeAt` :894), sets `locked:true`, records a `RootHold` (`holdRoot` :1032) so
  the body root is held near where the solve had it. Hands on sockets follow; body follows hands. "Move entire path"
  applies the delta to every key (`offsetProp` :1007).
- **Prop leads the body toggle**: `setLocked` locks without moving it, and `fitPath` runs the whole-clip fit (`propfit.ts
  fitProp`) which writes a few path keys.
- **Adjust its socket**: prop drag changes the prop in its own socket on its carrier bone (hands holding it stay put /
  follow, `propLive` :1071-1079). This frame -> a key on the (unlocked) path = socket adjustment tweened between keys
  (`commitSocket` :989-1002). "Move entire path" on -> changes the garment's placement (`position`, `rotation`) via
  `app.update` for every clip, and rebases the node tracks of the current base clip (`rebaseNode` :1408). Refused with a
  toast when the prop is currently leading (:947-951).

### 3.4 Two-handed grips
1. Select the prop; ensure it leads (toggle) or at least the carrying hand is on it.
2. Drag the free hand onto the shaft and release (snap, 3.0 above) - or choose a socket in "Grip sockets".
3. Click the hand: the gizmo goes to the fist aligned with the prop; slide along red, roll with Rotate; release re-saves the
   socket exactly (`placed`), `clearOfOthers` keeps hands a fist-width apart (:596-634, applied in `attach` and snap, not on gizmo slide).
4. Hand pose per hand via the picker (character-wide). Trash deletes the socket from the character.
5. Body follows via the natural solver; hands may slide <= `SLIDE.most` (5% of height) along the shaft and "give" about the grip.

### 3.5 Naturalize
Button -> `naturalize()` (:1166-1276): clones the posable, builds a `NaturalRig`, sets goals per frame (attached hands exact,
keyed bones soft with a 4-weight fading over 3 frames, root holds, leading prop shafts as obstacles), calls
`naturalizeClipAsync` (cancellable, yields every 12 ms), validates (finite, hand miss < 1% height, socket miss not worse,
floor miss < 0.2%), then a second async pass `correctHandContactsAsync` for fingers, then replaces `edited` and shows it.
Each press goes "a little further" (constants `NATURALIZE`, :44); no strength control in UI. Any later edit calls `show()`,
which rebuilds from keys and **throws the naturalization away** (`naturalized=false` at :1290).

### 3.6 Saving
- "Save new clip": `save(name)` (:1339). Branch on base URL:
  - base under `/files/library/clips/` (a library/custom clip): POST `/api/library/edits` (JSON incl. dense `frames`, keys, props,
    propPaths, characterId, replace) -> job -> poll `/api/jobs` every 1 s up to 240 s (`waitForJob` :1392) -> `library.reload`.
    Server writes `<id>.edit.json`, patches `work/sources.json`, runs Blender convert + aggregate (`server/clipedits.ts:100-143`).
  - otherwise (creature or bundled clip): build a `.glb` in the browser (`clipGlb`) and POST `/api/library/creature-clips`
    with an optional length-prefixed prop-path JSON header; server writes `creatures/<rig>/<id>.glb` + `creatures/index.json`
    (`saveCreatureClip` :147-173). No Blender involved.
- "Save to <slot>": `saveToSlot` (:1317): same save, with `replace` = the previous `custom-` id if the base was a made clip
  (so it overwrites that library clip in place, affecting every character using it). Then updates the slot's
  `AnimationEntry`: `clipId = saved.id`, `speed = 1`, drops `keys`, `url`, `note`, merges prop paths into `keys.props`
  (`withPropPaths`, slots.svelte.ts:68), stops the editor, plays the entry.
- Not saved anywhere: bone keys as reusable data (they are written into `.edit.json` but never read back), attachments,
  holds, groups, naturalization settings. Sockets/hand poses/open windows are *already* persisted on the character the moment you make them.

---

## 4. Data model

### 4.1 Transient edit state (`ClipEdit` class, clipedit.svelte.ts:52-123, all lost on `stop()`)
| Field | Shape | Meaning |
|---|---|---|
| `base` | `NowPlaying & {loop, inPlace}` | the clip as started; name has "(editing)/(naturalized)" suffix stripped (:194) |
| `slot` | `string|null` | AnimationEntry name this edit is of (derived at :198 from entry index / `now.slot` / matching clipId) |
| `baseClip` / `edited` | `THREE.AnimationClip` | the baked playing clip vs the last build |
| `keys` | `Record<bone, ClipKey[]>` | sparse bone keys, `ClipKey{u,q,p?}` from `server/workspace.ts:216`; `u` = phase 0..1 snapped to 30 fps frames; `q` = turn in the bone's own frame *relative to the base clip at the shown time*; `p` only on Hips (move) |
| `paths` | `Record<prop, PropPath{locked, keys}>` | `locked:true` keys are world-space deltas (about the prop's own origin) from where the prop rode in the base clip; `locked:false` keys are socket adjustments in the prop's placed frame (`clipedit.ts:79-82`). **Same type, two semantics.** |
| `attachments` | `{hand, prop, socket}[]` | one socket per hand; transient |
| `holds` | `RootHold[]` | per prop-drag: per-frame weight + hips offset + chest turn (clipedit.ts:106-117); fed to solver as soft goals (`rootGoals`, `ROOT_HOLD`) |
| `groups` | `{u, bones[]}[]` | which bones one drag keyed together, so Delete takes the whole drag |
| `fists` | per hand finger quats | fingers closed round a shaft (from the Hold-fist script / `animator.fistOf`) |
| `propRest` | per-prop node pos/quat | prop node as Outfit places it (re-applied after solve/stop) |
| `selected`, `prop`, `hovered`, `gizmo`, `space`, `limitsOn`, `propMoves`, `socketDrag`, `held`, `length`, `naturalized`, `busy`, `naturalizing`, `natural` | misc UI | |
| derived `phases`, `selectedPhases`, `hasKeys`, `canSave`, `props` | | timeline diamonds, enable flags, rigid non-hidden garments with their non-"(carries it)" sockets |

Frame model: `KEY_FPS = 30` (`keys.ts:9`); every build samples `frameTimes(duration)` = round(d*30)+1 frames.

### 4.2 Persisted character data the editor writes (via `app.update`, immediately, not on Save)
- `Garment.sockets[]` (`GarmentSocket{id,name,position,rotation}`; editor `Socket` adds `placed?` which is *not* in the server type
  `workspace.ts:166`, so it is written but untyped server-side): `saveSocket` :637, `pruneSockets` :776, `removeSocket` :785. Ids are `Math.random().toString(36)`; names "Left grip 2", "Left hand".
- Synthetic carrier socket `carrier:<prop>` computed from the Outfit placement vs the hand's rest frame, never stored (`carrierGrip` clipedit.ts:72; `carrierSocket` :883).
- `Garment.position/rotation` (Outfit placement) via "Move entire path" + "Adjust its socket" (:978-984).
- `Garment.carryPose`, `Garment.carryOpen[slot]`, `Garment.pulls[].pose`, `pulls[].holds[slot]` (`workspace.ts:126-132,149-163`).
- `Character.scripts` grip scripts (`kind:'grip'`, `side`, `clip`, `enabled`) through `setFist` :751.

### 4.3 Saved edit format
`workspace/library/sources/custom/<id>.edit.json` (`server/clipedits.ts:114-119`):
`{id,name,base,category,tags:['custom'],description,restFrom,loop,keys,props:{paths,attachments},propPaths,frames,createdAt}`.
`frames` = `{fps,bones[],rotations[frame][bone]=[x,y,z,w],hips[frame]=[x,y,z]}` in the **source skeleton's** space
(`unretarget`, clipedit.ts:599-650) - up to 3600 frames (`checkEdit` :60). The `sources.json` line is `{make:'blender/clips/edit.py', args:['--edit',file], inputs:[...]}`.
`propPaths` = `Record<propName, ClipKey[]>` sampled **per frame** from the final clip relative to the Outfit placement (`propKeysOf` keys.ts:139-160); `null` when the prop never moves.
Creature clip: a skeleton-only `.glb` + `creatures/index.json` row with `source:'custom'`, `rig`, `base`, `propPaths?`.
The `.edit.json` `keys`/`props` are stored "to open it again" (clipedits.ts:2) but no code ever reads them (grep: only `clipedits.ts` writes them).

### 4.4 Rig descriptors
`PoseRig` (PoseEditor.ts:16-21): `{hips, limbs{dragged joint -> {upper,lower,end}}, legs[{upper,lower,end,ball,tip}]}`; `HUMAN_RIG`
(:23), `HORSE_RIG` (:39). Selected by `template` (`start` :172-174).

### 4.5 Range-of-motion & pose models (static data, built offline)
- `static/templates/rom/human.json` (28 KB, 51 bones), `horse.json` (25 KB, 44 bones): per bone, a 36x72 spherical grid bitmask of reached directions + twist range, built by `tools/rom.ts` from the library's Mixamo clips (human) or the template's own clips (horse). Loaded by `JointLimits` (limits.ts:73), slack 1 cell / 5 deg twist (human) or 3 / 15 (horse) (`start` :183), wrist swing cap 70 deg (limits.ts:23).
- `human-pose.json` (36 KB): PCA of 22 body bones x 3 (66 numbers) over 130,763 frames of 2,446 clips and their mirror, `k=49` components + variances + held-out error. Built by `tools/posespace.ts`. Loaded for humans only.
- `human-twohand.json` (**635 KB**): real two-handed grips (`clips/frames/grip/turns/qualified`). **Unused at runtime** (see 7).

---

## 5. Algorithms

All numbers/limits quoted are constants in code.

| # | Algorithm | File | Inputs -> outputs | Cost / async |
|---|---|---|---|---|
| A | **2-bone IK `reach`** with pole search when limits block it; `moveHips` (feet re-reach, binary search down), `keepOffFloor`, `plantedFeet` | `ik.ts` | limb bones + target + `JointLimits` -> mutates bones, returns miss | per pointer-move, cheap, sync. Used live by PoseEditor and inside every solver |
| B | **Live drag** handling: reach/hips/swing, `handsLive` re-reaches attached hands to their sockets with IK each pointer move, `keepLeading` pins leading props | `PoseEditor.ts` + `clipedit.svelte.ts:330,1104` | pointer -> bone mutation; on release `commit(moved)` | sync, per frame |
| C | **Joint limits** - nearest allowed spherical cell edge for a bone's direction + clamp twist, mapped through retarget offsets K | `limits.ts` | local quat -> clamped quat | sync; O(allowed cells) per clamp |
| D | **Rebuild** `buildEdit`: apply bone keys (`applyBoneKeys`), then for each of ~30 fps frames: pose base+keyed, set unlocked-prop socket adjustments, compute hand goals (`handGoals`), prop obstacles, root soft goals, call the **body solver**, lift sunk legs, record touched bones/hips/prop nodes, then write dense quaternion/position tracks | `clipedit.ts:459-581` | base clip, keys, PropRig -> new AnimationClip | **sync on the main thread, every call of `show()`** (every key commit, attach, loop change, socket change). Pure fast path when no keys/props (:466) |
| E | **Body solver, natural** (`createBodySolver` -> `NaturalRig.solve`): Levenberg-Marquardt in whitened PCA coordinates; goals (hand place/turn, fist point on shaft with give/roll/slide), near-start, naturalness, limits, soft feet with FOOT costs, balance (COM over support), upright, elbow-bow table, capsule collision, obstacles, gaze, smoothing to previous frame (`FOLLOW 100`) | `posespace.ts:627-1703, 1820-1908` | bones + `HandGoal[]` -> pose + state{warm, slid} | 10-25 ms/frame "full", few ms "quick"; sync inside D |
| F | **Body solver, rule search** (`solveBody`): grid + pattern search over yaw/lean/forward/drop with arm "strain" cost | `bodysolve.ts` | same contract | cheap; used only if the pose model is unavailable (non-human template or fetch failure) |
| G | **Body collision**: capsule per segment (elliptical section) fitted to the skinned mesh by vertex weight quantiles; pairs list with allowed overlaps; `BoundShape` for solver; `penetration` for props | `bodycollide.ts` (`fitBodyShape` :303, `solidsOf` :450, cached per root) | character root -> shape; poses -> depths | fitting once per character; queries in solver hot loop |
| H | **Prop fit** (`fitProp`): per prop, compass search over 3 world axes at every 4th frame (+ frames where the prop starts in the body) using quick solves, forward/back sweeps, smooth curve, `fewestKeys` Hermite reduction to <= 12 keys | `propfit.ts:265-350` | FitInput -> offsets + `ClipKey[]` written to the path | ~10 s; **async** (yields via `setTimeout 0`), progress labels; marked stale if edit changes |
| I | **Naturalize** (`naturalizeClipAsync`): solve every frame with E using the edit as start, goals (hands exact, keyed bones soft, root holds), pull toward model mean, smoothMotion 15, 3 sweeps; wrap seam for loops | `posespace.ts:2012-2200` + `clipedit.svelte.ts:1166` | edited clip -> dense clip + per-frame misses | seconds to tens of seconds; **async batches of 12 ms, cancellable** |
| J | **Finger contact correction** (`correctHandContactsAsync`): skins each hand's actual vertices, per finger per frame evaluates 29 redistribution angles, dynamic-programming path (`contactPath`) with motion/acceleration limits; tip tolerance 0.4% height; protected hands skipped | `handcontacts.ts` + `surfacecontact.ts` (Moller triangle crossings, solid-angle cover) | clip + root -> clip | heaviest; **async** with phase labels (clearance/relaxation/trajectory/search), cancellable |
| K | **Hand grip geometry**: `handGrip` (rest-knuckle estimate, 25 deg lean), `fistGrip` (circles through finger joints + raycast palm depth `palmDepth` using double-sided material swap), `socketAt`, `clearOfOthers`, `shaftOf` (PCA axis of prop verts by power iteration) | `clipedit.ts:272-389`, `clipedit.svelte.ts:496-634` | -> `Grip{axis,fist}`, `Socket` | sync, on each attach/commit/`show` (shaftLocal recomputed per `propRig()`) |
| L | **Unretarget** (`unretarget`): world turn of each source bone = character world turn * K^-1, local to parent; hips move scaled by retarget scale, minus lift; bones the character lacks keep base motion | `clipedit.ts:599-650`, `retarget.ts` | edited clip -> `SourceFrames` | sync at save |
| M | **Library write**: Blender: import rest FBX, pose each frame by FK from local rotations, `common.key_poses`, `into_library` (`edit.py`); server queue serializes saves, ids reserved | `server/clipedits.ts`, `blender/clips/edit.py` | `SavedEdit` -> `clips/<id>.glb`, manifest | Blender convert + aggregate; job with progress; 240 s client wait cap |
| N | **Creature clip write**: GLTFExporter skeleton + clip | `clipexport.ts`, `server/clipedits.ts:147` | frames -> .glb | browser, up to 64 MB body |
| O | **Key tween** `sampleKeys` (Catmull-Rom Hermite on quats/pos; one-shot eases at ends; loops wrap) - shared with Tune and the game export | `engine/keys.ts` | keys,u -> q,p | cheap |
| P | **Root hold**: per prop drag, weights per frame by prop displacement vs the key frame; stored as hips offset + chest turn; soft goals in build and Naturalize | `clipedit.ts:106-145`, `clipedit.svelte.ts:1032` | | cheap |
| Q | **Offline model builders**: `tools/posespace.ts` (PCA/Jacobi eigen, mirror augmentation, held-out), `tools/rom.ts` (sphere-grid reach), `tools/twohand_poses.ts` (find two-hand holds in the library) | `tools/` | library clips -> `static/templates/rom/*.json` | minutes, offline |

Order of operation on a release: `commit` (key bones, maybe create/refresh sockets with awaits) -> `show` -> `buildEdit` (D with E or F) -> `animator.showClip`.

---

## 6. Cross-area dependencies

- **Animator / Timeline (library agent's)**: `animator.clip/current/time/duration/loop/inPlace/lift/character/stage/posableCopy/fistOf/showClip/seek/setPlaying/setLoop/forgetClip/playEntry/refresh/play`, plus hooks the editor installs: `animator.editing` (rebuild on refresh), `animator.leaveEditor` (called by `play`/`detach`), `animator.holding` (stops the clip driving bones during a drag). Timeline calls `clipEdit.snapTime/phases/selectedPhases/active/busy/setLoop`.
- **Slots** (`slots.svelte.ts`): `withPropPaths`; `AnimationEntry` edited by `saveToSlot`. Also the editor deletes the slot's Tune `keys` and resets `speed` (the edit baked them in), but keeps `trim`, `inPlace`, `loop`, `lift`, and the character's *scripts* still apply by slot name (see 8).
- **Tune** (`tune.svelte.ts`): shares `ClipKey`, `sampleKeys`/`applyBoneKeys`/`propTracks`/`propKeysOf` (`engine/keys.ts`), and `propNode(name)` (imported into clipedit.svelte.ts:19). Has its own gizmo.
- **Scripts** (`engine/scripts.ts`): `handScripts`, `GRIP_CLIP` (Hold fist), pulls (`engine/pulls.ts`) and `carryOpen` windows are edited here but defined/played elsewhere.
- **Outfit**: garments (rigid props), their `sockets`, `pulls`, `carryPose`, placement (`garmentMatrix`, `placement.ts`), `restFrame` (garments.ts); "(carries it)" sockets filtered at clipedit.svelte.ts:61. Outfit's PropAttachment catalog props are invisible to the editor.
- **Rig step**: `HandPoseSelect` + `handPoses` state (hand poses, shared pool in settings); the character's rig/`rest`/`bones`/`height` via `CharacterView`; retarget (`retarget.ts retargetOffsets`, `pelvisName`, `canonical`), `mixamo.ts prettyBone`.
- **Library** (`library.svelte.ts` reload; `server/library.ts` lists `source:'custom'` clips and creature index; `blender/library/build.py convert/aggregate`; `blender/clips/common.py`). Jobs system (`/api/jobs`, `enqueue('clip',...)`).
- **App**: `app.selected`, `app.update`, `app.toast`; `Stage` (camera, controls, `onFrame`, `covered`), `three/addons TransformControls`.
- **Game export**: consumes the slot's `keys.props` created from `propPaths`; the game plays prop paths as `Prop_<part>` bones. `tools/tune_parity.ts` verifies viewer/export agreement (not for editor-built clips).
- **Tools/offline**: `tools/lib/node3d.ts`, `tools/lib/surface.ts`, `tools/dev/verify_naturalize|surfaces|hands.ts` use the same engine files.

---

## 7. Redundancy and overlap

### 7.1 Solvers for similar problems
1. **Three whole-body "hands reach their goals" solvers**:
   - `bodysolve.ts solveBody` (rule grid search; hard-codes `Hips`, `LeftArm` names; header still says it "stands in for the library's natural-pose solver, being built" - `bodysolve.ts:5`).
   - `posespace.ts NaturalRig.solve` via `createBodySolver` (the real one).
   - `twohand.ts holdTwoHanded` (an even earlier special-purpose two-hand version with its own `SHARE_YAW/LEAN`, `strain`, `turnWorld`). **No production caller** (only tests + comments referencing a non-existent `clipedit.ts Hold`).
   `bodysolve.ts` also duplicates `SHARE_YAW/SHARE_LEAN/strain/turnWorld/armOf` from `twohand.ts`. `solveBody` remains live only as the fallback when `human-pose.json` fails to load or the template is not human (clipedit.svelte.ts:190), a path that cannot do much for a horse (no hands/props, no `Hips`).
2. **IK vs the natural solver, two answers to the same pose**: while dragging, the pose comes from `ik.ts` reach + `handsLive` IK for attached hands; on release the build re-solves the whole body with `NaturalRig`. The pose on release can visibly jump from what the user dropped. (`PoseEditor` live path never uses `quick` natural solves; `bodysolve.quick`, `NaturalOptions.mode:'quick'` exist for it but the editor does not use them.)
3. **Four representations of "is this pose OK for a human"**: (a) `JointLimits` ROM grids (limits.ts), (b) PCA pose-space model naturalness (posespace.ts), (c) hand-coded `ELBOW` table, `WRIST`, `GIVE`, `BALANCE`, `UPRIGHT`, `FOOT` costs inside posespace.ts, (d) `bodysolve.strain`. The ROM limits are applied *both* as hard clamps (ik.ts `clampBone`) and as soft penalties (`LIMIT_WEIGHT` in NaturalRig) and additionally 35-degree/10-degree bounds in handcontacts.ts. "Joint limits" toggle switches a-only.
4. **Two collision models**: capsule `bodycollide.ts` (bodies/props, solver), and triangle-surface `surfacecontact.ts` + `HandContactSurface` (fingers). Plus `propfit.ts` has `BodyColliderLike`/`NO_COLLIDER`/`FIT.prop` as a third interface to the same capsule collider, and `propObstacles` in clipedit.ts turns prop shafts into capsules.
5. **Duplicate hand-grip estimators**: `handGrip` (rest-bone heuristic), `fistGrip` (fist-based circle fit + mesh raycast), `gripAxisOf` (posespace.ts, re-implements `handGrip`'s axis math), plus `fistPose`/`handPose` in animator scripts.
6. **Duplicate geometry code**: PCA-by-power-iteration of mesh points appears in `shaftOf` (clipedit.svelte.ts:515-528) and `fistGrip` (clipedit.ts:370-374); `widthOf(hand)` is copy-pasted inside `handGap` (:587) and `clearOfOthers` (:616); `bonesOf` exists in clipedit.ts:39, propfit.ts:101 and inline at clipedit.svelte.ts:1180/839 and handcontacts; `wp/wq` helpers redefined in ~6 files; `r5/r6` rounding closures repeated; `Y_BOT_LEG = 0.827` in both posespace.ts:425 and bodycollide.ts:44; the hold-window text parsing is pasted twice in EditPanel (:136, :159) plus the "frame shown" button math three times.
7. **Two prop-motion storages with the same type**: `PropPath.keys` is world-delta when `locked`, socket-adjust when not (see 8). Tune's `entry.keys.props` is a third meaning (offset in placed frame). On save the editor's sparse path is resampled into a **dense per-frame** `ClipKey[]` (`propKeysOf`), so a saved slot's prop "keys" are ~30/sec rather than the handful the user made, and are then editable (badly) in Tune.

### 7.2 Keys here vs Tune's keys
- Same `ClipKey` and `sampleKeys`/`applyBoneKeys` code, but different lifecycle: editor keys are transient and relative to the *baked* clip (already containing Tune keys + scripts + speed); Tune keys persist on the slot entry relative to the unkeyed clip. Saving to slot deletes the slot's Tune `keys` entirely (`saveToSlot` :1328) because they were baked into the new clip (and silently loses the ability to re-tune). Two separate gizmos (`Tune.show` TransformControls vs `PoseEditor`), two selection UIs (Tune target `<select>` vs EditPanel Target `<select>`), two "key here/delete key" concepts, two phase-snapping implementations (`Tune.phase` vs `ClipEdit.phase/snapTime`).
- Editor's `keys` stored in `.edit.json` are never reloaded, so the keyed history of a custom clip is a dead record.

### 7.3 Socket systems
- Editor sockets live in `Garment.sockets` (`GarmentSocket`), the same field Outfit uses for its prop sockets; editor adds `placed` (not typed server-side); ids random; the editor deletes any socket no hand is on (`pruneSockets`, clipedit.svelte.ts:776) - **this can delete sockets the user made in Outfit** if no editor attachment points at them.
- "Carry socket" (Outfit placement) is represented three ways: the garment placement itself, a synthetic `carrier:<prop>` socket built on the fly (`carrierGrip`), and "(carries it)" named sockets that the editor filters out (:61).
- Outfit's catalog `PropAttachment` (bone socket string) is a separate legacy attachment system the editor ignores.
- Pull sockets (`PullSocket`) are a fourth socket-ish concept (hand pulls a point), with per-clip `holds`.
- Hand pose storage has **four** homes: `Character.handPoses` + `settings.handPoses` (library), `Garment.carryPose`, grip `scripts`, `PullSocket.pose`; `handPoseOf/setFist` (clipedit.svelte.ts:664-773) shuffle between them depending on whether the hand carries a prop, and `fistClip` (:745, unused) is a fifth reader.
- Per-clip open/hold windows are stored by *slot name* on the garment (`carryOpen[slot]`, `holds[slot]`): renaming a slot orphans them; windows are only editable when a slot is being edited.

### 7.4 Saving paths (3, with different fidelity)
1. Library clip via Blender (`/api/library/edits`): full frames, edit.json, `custom-` id, appears under Custom; Blender job; 240 s poll.
2. Creature clip via browser-built GLB (`/api/library/creature-clips`): no keys/props record, no Blender, id `custom-<rig>-<name>`, category via `categoryOf(base)`; chosen by *base URL prefix*, not by rig (a bundled `/animations/` human clip would be saved as a "human creature clip").
3. Slot update (`saveToSlot`): path 1 or 2 plus an `app.update` of the slot, which can overwrite the previously saved custom clip in place (`replace`), mutating all characters that share it.
"Save new clip" vs "Save to <slot>" are two buttons that differ only in whether the slot is re-pointed; the distinction is explained in a single dense help line (EditPanel.svelte:186).

### 7.5 Dead / vestigial code
- `src/engine/twohand.ts` (155 lines): unused in production. References `clipedit.ts Hold` which no longer exists.
- `src/engine/twohandpose.ts` (422 lines), `tools/twohand_poses.ts` (225), `static/templates/rom/human-twohand.json` (**635 KB shipped under `static/`**), `twohandpose.test.ts`: no runtime caller; README line 165 still advertises it.
- `propfit.ts`: `placeGrip`, `gripCost`, `movedSocket`, `GRIP`, `GripInput`, `GripResult` (lines ~408-547) - only tests call `movedSocket`; `NO_COLLIDER` unused; header (1-17) still says "Leads" (the toggle is now "Prop leads the body") and describes grip auto-placement that no UI uses (`attach` uses `clearOfOthers` instead).
- `posespace.ts`: `solveNatural` wrapper (:1725), `bindNaturalBody`/`solveBodyNatural` module-global (:1910-1916, throws if unbound, no callers), `restSoles` (only tools/tests; the editor re-derives soles at clipedit.svelte.ts:1218 and clipedit.ts:476), `naturalizeFrames`/`naturalizeClip` sync variants (tests/tools only), `NaturalOptions.keep`.
- `clipedit.svelte.ts`: `fistClip` (:745, never called), `hovered` state (written, never read), unused `stage` locals (:164, :255), `holdOf` takes `t` but `setLength` always passes 0, `Segment`/`quick`.
- `PoseEditor.ts`: getters `gizmoMode`, `selection`, `selectedProp` unused; `floor` parameter always 0 (and `buildEdit`'s `floor` too).
- `bodycollide.ts:447` `solids.enabled` is a debug switch ("for measuring the difference").
- `bodysolve.ts` `SolveOptions.quick` branch is used by propfit via cast (`as Parameters<...>`), not by the editor.
- `src/engine/vendor/TransformControls.ts`: a forked "CustomTransformControls" that nothing imports (PoseEditor/Tune/Outfit import `three/addons`).
- Comment drift: `bodysolve.ts:5` ("being built"), `clipedit.svelte.ts:1160-1165` two stacked doc comments for `naturalize`, `:662-663` two stacked doc comments for `handPoseOf`, `server/clipedits.ts:97-98` two stacked doc comments for `editId`, `clipedit.svelte.ts:1-9` header does not mention naturalize/two-hand/slots.

---

## 8. Rough edges

### 8.1 Data-loss and safety
- **No undo/redo.** Not for key edits, not for "Clear all keys", not for socket deletion (trash button removes the socket from the *character* immediately).
- **"Finish editing", picking another clip, leaving the Animate step, and "Edit playing clip" on another clip all discard the unsaved edit with no confirmation** (`stop()`; EditPanel effect :29-32; `onDestroy` :38; `animator.leaveEditor`).
- **The editor mutates persistent character data while "editing"**, outside Save: sockets are created/updated on every drag release (`saveSocket`), unused sockets are pruned, hand poses write scripts/garment `carryPose`, windows write garment data, and "Adjust its socket + Move entire path" rewrites the Outfit placement used by the game export and every clip (toasted but not confirmable). Cancelling the edit does not revert any of it.
- `saveToSlot` with a previously-made `custom-` clip overwrites that library clip in place (`replace`), changing every character/slot that uses it; the UI says "saved over" only in small grey text (:186).
- Saving to slot **drops the slot's Tune keys** and keeps its scripts. Scripts act by slot name on top of the clip (blow cut, pace, grip): editing a slot clip bakes `animator.clip` (scripts already applied) into a new clip, and the slot then re-applies the same scripts on top. That likely double-applies a blow/pace cut and was not obviously considered (`saveToSlot` :1327-1331). Worth verifying on a Blow-scripted slot.
- `commit()` is `async` with awaited `app.update` calls but doesn't set `busy`, and writes `this.keys = next` computed before the awaits (:391-420): edits made while sockets save can be clobbered.
- `setLocked(prop,false)` keeps the existing `keys` but flips their meaning from world-delta to socket-adjust (:819); `commitProp` after a socket drag appends world-deltas onto socket-adjust keys (:922). Mixed semantics produce garbage motion.
- `Math.random()` socket ids and `reserved` set in server; `newId` race documented but `editId` docs duplicated.
- `waitForJob` swallows fetch errors and gives up after 240 s while Blender may still be running; the clip then appears later without feedback.

### 8.2 Confusing UI / naming
- Four toggles in the prop box with interacting meanings: "Prop leads the body", "Adjust its socket", "Move entire path" (means a different thing depending on the previous toggle, with two alternate hint strings), and the hidden precedence (socket mode is refused while leading). The vocabulary mixes socket / grip / hand / carry / Outfit placement / pull. `docs/animating.md` calls hands "carrier" and the toggle "Leads"; the UI says "carries it" and "Prop leads the body".
- Target select vs viewport selection vs Tune's select: three ways to select; empty-space click doesn't deselect.
- "Opens in this clip" / "Held in this clip": free-text `0.2-0.5, 0.8-1` phase windows (0-1) with silent parse failure and no preview/scrub integration; only valid when editing a slot (disabled silently otherwise, since `carryOpen` returns `[]` and `setCarryOpen` no-ops when `slot===null`).
- Naturalize has no strength/scope control (fixed `NATURALIZE`), cannot target a frame range, silently loses itself on the next edit, and is shown only for people (`natural`), with no explanation for horses.
- Naturalize alone enables Save even with no edits (`canSave`, :121).
- Hint text at EditPanel:62 says "Save creates a new library clip" but when editing a slot the primary button replaces the slot.
- Keyed-frame count line counts "bones keyed" including bones that only have end pins? (`keyedBones = Object.keys(keys).length` counts anchors-only bones if `held` false and only pins remain? pins are removed by `deleteHere` but a bone keyed once shows 3 keys: pins + key.) Counter may overstate.
- Hotkeys G/R/Delete/Esc don't work while any button/select has focus (the common case after clicking a toolbar button), and Backspace deletes keys globally.
- Shift-hip-drag, hand snap-to-prop, gizmo-on-hand-slides-along-prop, and per-hand sockets are only documented in `<details>` or `docs/animating.md`; the snap has no preview ring.
- "Joint limits" toggle recreates the PoseEditor (resets live drag state) and also affects build/naturalize but not hand-contacts bounds.

### 8.3 Performance / responsiveness
- `show()` -> `buildEdit` runs on the main thread for all frames, every release; with a prop leading plus the natural solver this is 10-25 ms x frames (>1 s for a 2 s clip), blocking the UI with no busy indicator (only `fitPath`/`naturalize` set `busy`).
- `propRig()` recomputes `shaftLocal` (power iteration over up to 3000 vertices per mesh) and `gripOf` per call, which runs inside each `show`, `fitInput`, `naturalize`.
- ROM and pose JSON are re-fetched every `start()` (not cached); `human-twohand.json` 635 KB sits in static unused.
- Dense per-frame prop key arrays (up to 3600 keys per prop) go through JSON to the server and into the slot entry.

### 8.4 Correctness / fragility visible in code
- Horse support is thin: `HORSE_RIG` and limits only; no natural model, so `natural=false`, hand/prop features and Naturalize unavailable; `bodysolve` assumes Mixamo names. `rigName` for any other template falls through to `fetch('/templates/rom/<template>.json')` which 404s -> limits silently off.
- Non-Blender save of "human" bundled clips goes to `creature-clips` with `rig='human'` (base URL check, :1348).
- The saved library clip depends on `restOf(base)` finding the original FBX on disk (`server/clipedits.ts:35-46`); if the source FBX is moved the save fails late (after the client already built frames).
- `Socket.placed` isn't in the server/workspace type; unknown fields persisted as-is.
- `commit` snaps to prop when `moved` includes the hand even if the user intended only to reposition the hand near a prop.
- `Naturalize` throws "your edit is unchanged" errors on strict thresholds (hand miss 1% height, floor 0.2%), common failure mode on edgy clips (HANDOFF.md documents 13 unfinished cases).
- Tests: `clipedit.test.ts` (138 lines) vs a 1,421-line state class that has no unit tests; the state machine (stale tokens `opening`, `naturalizeRun`, `fitPath` stale check) is only exercised by manual use.
- Legacy / stale comments: README:165-166 sells `twohandpose`; `docs/animating.md` says "Leads"/"carrier"/"Free" labels that differ from the UI; `clipedit.svelte.ts` header (1-9) describes the first version only.
- Library "Custom" clips can only be removed outside the editor (no delete in this area); every Save adds a Blender-built clip (and a `custom/<id>.edit.json`) with no pruning.
