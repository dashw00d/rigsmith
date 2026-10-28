# Inventory 3: Animate step (library, slots, playback, retargeting, scripts, tuning)

Scope: everything in the Animate step except the animation EDITOR (EditPanel, `src/state/clipedit.svelte.ts`,
`clipedit.ts`, `posespace.ts`, `PoseEditor`, `ik`, `limits`, `bodycollide`, `handcontacts`, `twohand*`). The editor
boundary is noted where it touches this area. Line numbers are as of the commit `36f9295` working tree (clean).

---

## 1. Purpose of the area

The Animate step lets you browse a ~2,500-clip library (2,446 named Mixamo clips + 14 "custom" made clips + bundled
creature/human clips), preview any clip live on the selected character, and build the character's **animation set**
(`Character.animations: AnimationEntry[]`). Entries whose names the game plays are **slots**; the rest are **trials**.
On top of the raw clip the set carries per-entry speed/loop/in-place/ground-lift/bone-and-prop keys and
character-wide **scripts** (blow timing, pace, fist hold); one shared bake (`bakeEntry`) makes the viewer, the GLB
export and (nominally) the game export agree.

---

## 2. UI surface (exhaustive)

Layout (`src/app/App.svelte:55-100`, `Viewport.svelte`, `Inspector.svelte`): when `app.step === 'animate'` the **left
panel** is `Library.svelte` (`App.svelte:75-76`; other steps show CharacterList or PropCatalog), the **centre** is the
viewport with the **Timeline dock** (`Viewport.svelte:102`; also shown on the Export and Outfit steps and, for rig
tests, the Rig step), and the **right Inspector** renders `AnimatePanel` (`Inspector.svelte:25`).

### 2.1 Library panel (left) - `src/app/animate/Library.svelte`
| Control | What it does | Where |
|---|---|---|
| Title "Library" + "N animations" | Sum of category counts for the current rig (not the filtered total) | `Library.svelte:52-55` |
| Search box + clear (x) | Debounced (180 ms) server search over name, description, variant, id, motionId, source FBX name, candidate names, tags, category; resets to page 0 | `:56-61`, `library.svelte.ts:52-57`, `server/library.ts:70-81,194-197` |
| Coverage line | "Mixamo collection complete - 2,317 motions + 129 poses" or "N of M clips" | `:63-71` |
| Source chips "All clips" / "Custom (n)" | `source=''` or `source='custom'` (only two values exposed; the server accepts any `source`) | `:74-77` |
| Category select | "All categories" + per-category counts (counts are for the whole rig, not narrowed by search/source) | `:78-83` |
| Clip grid | 24 cards/page, `auto-fill minmax(124px,1fr)`; dims while loading | `:102-106` |
| Empty/error states | Error + Retry; "No animations available"; "No matches" + Clear filters | `:87-100` |
| Pager | Prev/next, numbered pages with ellipsis, "a-b of N" | `:110-125` |
| Keyboard | PageDown/PageUp, Alt+Right/Alt+Left = page (ignored when focus is in input/select/button/a/summary) | `:36-40` |
| Side effects | `library.setRig(app.selected.template ?? 'human')` on every selection change (resets category, page); unmount cancels pending sprite renders | `:12,15` |

### 2.2 Library card - `src/app/animate/LibraryCard.svelte`
- Whole card is `role=button tabindex=0`: click or Enter -> `animator.playLibrary(clip)` (preview on the character) (`:76-77`). Space does not activate it.
- Animated sprite preview (16 frames, 144 px, rendered on *this* character, lazily via IntersectionObserver with 200 px margin) (`:16-36`, `:78-79`); shimmer while pending.
- Badges: duration "N.Ns"; loop icon "Loops seamlessly" (`:81`); "custom" badge "Made here (the animation editor, or a script)" (`:82`); warning triangle from the library audit "Doesn't move as its name says: ..." (`:83`, `:52-54`); "?" for uncertain motion-candidate names (`:91`).
- Name + detail line (Mixamo description / variant); tooltip lists alternatives for uncertain names (`:90-93`, `:44-49`).
- **Round button (top-right of the preview)** `add()` (`:56-73`, `:84-88`), three behaviours by state:
  1. A slot is armed -> label shows the slot name; fills that slot (`slots.fill`) with clip's own `inPlace||category==='locomotion'` and `loop` defaults.
  2. Not armed and clip already used by any entry (check mark) -> **removes every entry with that clipId** (slot fills included).
  3. Not armed and not used -> "Add as a trial": appends an entry named `clip.name` (or the description if the name is already taken), speed 1, `withPropPaths`.

### 2.3 Animate inspector - `src/app/steps/AnimatePanel.svelte`
Order top to bottom (`:77-162`):
1. If character not rigged: "Rig this character first" + "Go to Rig" button (`:77-81`).
2. `EditPanel` (editor, out of scope) (`:83`).
3. **"In the game: <unit> [(its companion)]"** section, only when `slots.game` exists (`:84-106`). One row per clip name the game plays (`game.clips`):
   - Play button (disabled when empty), slot name, clip label (cleaned `clipId`; tooltip = note or clipId, or "No clip yet"/"empty"), and for filled slots the shared **controls** snippet: Loop toggle, In-place toggle, Speed select (0.5, 0.6, 0.75, 0.8, 1, 1.25, 1.5, 2, plus the current value) (`:69-75`). Tooltips say "Saved setting".
   - **Use** button (only while a library clip is being previewed) -> `useForSlot(slot)` (`:63-66,96-98`).
   - **Crosshair (arm)** toggle: arms the slot so a library card's round button fills it (`:99-100`, `slots.armed`).
   - x (empty the slot) -> `slots.clear` (`:101`).
   - Row highlight: playing, armed, empty.
4. **"Trials"** (or **"Animation set"** when the character has no game unit) (`:108-136`): list of entries whose name is not a slot name. Each row: drag grip, play, editable name input (commit on change), Loop / In place / Speed (same snippet), delete (trash). Native HTML5 drag-reorder (`:122-124,49-56`). Empty state text. "Clear" button (header action) only when no game unit (`:109-113`). Footer hint differs by mode.
5. If any entries exist: `TunePanel`, `ScriptsPanel`, and **"Send hand pose"** (Left hand / Right hand buttons -> `handPoses.capture(side)`; disabled when nothing is playing) (`:138-149`).
6. If no game unit and other rigged characters exist: **"Use this set on N other rigged character(s)"** -> `copyToAll()` overwrites every other rigged character's `animations` with a copy of this set (`:58-61,151-155`). No confirmation.
7. "Export" primary button (disabled without entries) -> `app.step = 'export'` (`:157-161`).

### 2.4 Timeline dock - `src/app/animate/Timeline.svelte` (rendered by Viewport, shown only when `animator.current !== null`)
| Control | Behaviour | Line |
|---|---|---|
| Title (name of what plays) | | `:90` |
| Frame number input "n / total" (30 fps assumed) | seek to frame | `:91` |
| Scrub bar (role=slider; pointer capture; resumes playback after scrub if it was playing) | click/drag seek, snaps to editor keys when editing | `:93-100`, `:44-48` |
| Arrow keys (+Shift = 10), Home, End, Space on focused bar | frame step / ends / play | `:62-73` |
| Key diamonds (only while the editor is active) | click to jump | `:101-107` |
| Transport: first / prev frame / play-pause / next frame / last | | `:109-117` |
| Loop toggle | `animator.setLoop`, or `clipEdit.setLoop` while editing; **preview-only for entries** (does not change `entry.loop`) | `:119` |
| In place toggle | sets `animator.inPlace` then `refresh()`; disabled while editing | `:120` |
| Mirror left/right toggle | sets `animator.mirror` then `refresh()`; disabled while editing; never saved or exported | `:121` |
| Playback speed select (0.25 ... 2 + current) | `animator.setSpeed`; preview-only multiplier that *replaces* the entry's speed during playback | `:122-124`, `:17` |
| Previous key / Next key + "N keyed frames" (editor only) | | `:127-133` |
| Global keys | Space = play/pause; `,` / `.` = previous/next frame; ignored when focus is in an input/select/button/slider or modifiers held (`allowsShortcut`) | `:75-82`, `src/ui/shortcuts.ts:2-5` |
| Layout side effect | writes `--playback-dock-height` CSS var so toasts sit above the dock | `:20-28` |

### 2.5 Tune panel - `src/app/animate/TunePanel.svelte` ("Tune <entry name>", only when an entry is playing)
- **Ground**: number input (cm of game height when the unit has a height, else % of character height), "Auto" (stand on floor by flat feet), "All slots" (only when the unit has >1 slot), clear-lift x (`:61-70`, `tune.svelte.ts:154-190`).
- **Tweak** select: Nothing / Props (rigid garments present in the scene) / Bones (all bones, fingers included) (`:72-79`).
- When a target is chosen: **Turn / Move** mode buttons (Move only for props and `Hips`), frame readout "frame n / total" (in the *sped* timeline: see 8), help text, **Key here**, **No change here** (an identity key) (`:81-92`). Gizmo (TransformControls, local space) shown on the stage; letting go commits a key (`tune.svelte.ts:43-63`).
- Key list: "frame N", description ("no change" or degrees + "move"), delete; "Clear <target>" (`:93-104`).
- "Keyed: Bone (n), Prop (n)" quick links (`:107-109`).

### 2.6 Scripts panel - `src/app/animate/ScriptsPanel.svelte` ("Scripts")
- Lists the character's non-grip scripts (`:16`); each: on/off Toggle with description and hint (`:86`), delete (`:87`).
- **Blow timing** params: clip select; either "Auto" fixed-frame readout (when `blowU` set) or hand select (right/left hand's fastest); **Set to this frame** (uses frame playing; rejects first/last frame, `:49-58,103-104`); late-blow explanation + `cut the start / hold the end` select, shown only when the blow is later than "lands at" (`:60-68,105-110`); **lands at %** (5-95 step 5) (`:111-112`); **window s** (`:113-114`).
- **Pace** params: clip select, "like" clip select (`:115-122`).
- "+ Add": **Blow timing**, **Pace** buttons (`:129-134`). The `add('grip')` branch exists (`:31-32`) but no button calls it.
- Every change saves `character.scripts` and `animator.refresh()` (`:19-22`).

### 2.7 Other Animate-related surfaces
- **Rig step test chips** call `animator.playTest` and show the Timeline (`RigPanel.svelte:84,128,162-164`).
- **Outfit step Pose select** (rest / "fists" / any entry) uses `playEntry`, `playFists`, `stop` (`OutfitPanel.svelte:109-129`); Outfit also steps through the animator frame by frame for pull sampling (`outfit.svelte.ts:434-450`).
- **Hand pose preview** `animator.playHandPose` (`handposes.svelte.ts:149,210`).
- **Skeleton mapping** change -> `animator.rebind()` (`SkeletonMapping.svelte:35`).
- **Export step** consumes the entries (see 6).
- **CLI**: `tools/rig.ts slot|clips|show|render` fill/inspect slots outside the UI.
- Not in this area but adjacent: `GameUnitPanel.svelte` (Export step) edits which clip names are slots (`PUT /api/game/units/:name`).

---

## 3. User workflows (step by step)

### 3.1 Fill a slot from the library
Two routes in the UI (plus two programmatic ones):
- **Arm route**: in "In the game", press the crosshair on a slot (it gets an accent outline) -> every library card's round button now reads the slot's name -> press one -> `slots.fill(slot, ...)` writes the entry (kept `speed`/`loop`/`inPlace`/`keys`/`lift` of the old entry if the slot was filled; otherwise speed 1 and the clip's defaults), clears `armed`, and plays it (`slots.svelte.ts:39-53`).
- **Use route**: click a card to preview it (the character plays it immediately, grounded by flat feet) -> every slot row shows **Use** -> press it. Uses the *Timeline toggles* (`animator.inPlace`, `animator.loop`) as the entry's flags, not the clip's metadata (`AnimatePanel.svelte:63-66`).
- Editor route: `clipEdit.saveToSlot` (editor area) re-points the slot at the saved clip, resets `speed` to 1 and drops `keys`/`url`/`note` (`clipedit.svelte.ts:1317-1335`).
- CLI route: `node tools/rig.ts slot WHO SLOT CLIP ...`.

### 3.2 Trials (compare without exporting)
Click a card, press the round "+" -> a Trial entry (name = clip name). It is listed under "Trials" (game unit present) or "Animation set" (none). Play it, rename it, set loop/in-place/speed, reorder by drag, delete. Anything that matches a slot name instead becomes that slot. The Export step only gets what the game names (via `bakeEntry` for the GLB export, `game.clips` for the game export); trials are "kept here".

### 3.3 Previews
Click card -> `animator.playLibrary` -> `play({entry:null})`: retarget (`RetargetCache.get`, inPlace per Timeline toggle, mirror per toggle), add prop paths, **auto-ground** (`grounded`, `animator.svelte.ts:345-355`), play. If the character rides, the horse plays its "Idle" entry beneath. Card sprite sheets are separate (PreviewRenderer, always in place, 16 samples, not grounded).

### 3.4 Speed / loop / in-place / mirror
- Saved: per-entry controls in the Inspector list (`patch()` writes the entry and replays it).
- Preview-only: Timeline Loop/In place/Mirror/Speed. For an **entry**, In place does not alter the bake (the bake reads `entry.inPlace`, `animation.ts:46-49`), Mirror does (not saved, not exported), Loop and Speed only drive the Player. They reset on the next `playEntry` (`animator.svelte.ts:247-249`).

### 3.5 Blow timing (attack)
1. Add a **Blow timing** script (defaults: clip "Attack" or the first entry, `at`=0.45, right hand) (`ScriptsPanel.svelte:33-34`).
2. Default is automatic: `blowTime` finds the chosen hand's fastest moment (`scripts.ts:120-134`).
3. Or play the entry, pause on the impact frame, **Set to this frame** -> `blowU` (phase of the uncut clip) (`:49-58`).
4. "lands at %" is where in the cut clip the blow sits (the game times hits at 0.45). Late blow -> either cut the start or hold the end. "window s" optionally keeps only N seconds around the blow.
5. The viewer plays the cut clip; the export applies the same cut.

### 3.6 Pacing (e.g. Villager Carry at Walk's pace)
Add **Pace**, choose the clip and the "like" clip. `paceTo` retimes the clip so its median planted-foot ground speed equals the reference's (`scripts.ts:259-266`). Only Villager uses it in the current workspace.

### 3.7 Grip / fist scripts
Not shown in ScriptsPanel (`:16` filters `kind==='grip'`; hint text points to "the animation editor's prop panel"). 8 of the 34 characters in the workspace still carry stored grip scripts (all with `Great_Sword_Crouching_6` or `2hand_Idle`) that cannot be seen or toggled here. Fists really come from several sources, see 7.1.

### 3.8 Tuning the ground and keys
1. Play a slot/entry. 2. **Ground**: press Auto (or type cm); "All slots" does every slot. 3. **Tweak**: pick a bone or prop, pause on a frame (Space, `,`/`.`), drag the gizmo; mouse-up keys it (`tune.commit`), or use Key here / No change here. 4. Keys are phases (0..1) of the clip; sampled with a Catmull-Rom/Hermite curve, wrapping for loops, holding for one-shots. Everything saves into the entry (`keys`, `lift`) and the entry replays with `keepTime`.

### 3.9 Riding a horse
Set up in Outfit (`Character.mount`, `outfit.svelte.ts`, `mount.ts straddle`). In Animate nothing is specific: `viewer.syncMount` loads the horse and calls `animator.attachMount`; `play()` then (a) freezes the rider's lower body (`freezeClip`), (b) bakes the horse's entry of the same name (fallback "Idle"), (c) fits the pair (`fitRide`: whole-cycle ratio for loops, horse retimed to the rider's attack length), (d) sets `animator.cycles` so Tune frames/phases are per rider cycle (`animator.svelte.ts:187-210`).

### 3.10 Sending a hand pose
Pause on a frame (or Rest), press Left/Right hand under "Send hand pose" -> `handPoses.capture` reads the current finger bones and stores a named `HandPose` on the character (visible in Rig -> Hand poses) (`handposes.svelte.ts:118-128`). That pose can then be picked by a socket (Outfit `carryPose` / pull `pose`) or a grip script via `pose:<id>`.

### 3.11 Copy the set to other characters
Only if the character has no game unit: "Use this set on N other rigged characters" overwrites their entire `animations` (including keys/lift tuned to this body).

---

## 4. Data model

### 4.1 `AnimationEntry` (`server/workspace.ts:191-207`; stored in `character.json`)
`clipId` (library id), `url?` (only for bundled `/animations/..#Name` and creature `/files/library/creatures/..`), `name` (the slot name / animation name in Godot), `inPlace`, `loop`, `speed`, `trim?: [n,n]` (**never read or written anywhere**), `note?` (rationale text, 31 of 34 characters have it on most entries), `keys?: ClipKeys`, `lift?` (character units, height about 1).

### 4.2 `ClipKeys` / `ClipKey` (`workspace.ts:212-222`)
`bones: Record<boneName, ClipKey[]>`, `props: Record<garmentName, ClipKey[]>`; `ClipKey = { u (phase 0..1), q (quat turn), p? (move: Hips in parent frame, prop in its placed frame) }`. Applied last, after speed + scripts + lift: `applyBoneKeys` (q_clip * q_key) and `propTracks` (`keys.ts:91-135`). Props always get placement tracks even when un-keyed, so previous clip keys never leak (`animation.ts:22-35`).

### 4.3 `ClipScript` (`scripts.ts:17-75`; stored in `character.scripts`)
- `GripScript` {side, clip (library id or `pose:<id>`), open?: windows per clip where hand opens, during?: windows per clip where the hand is posed, carries? (label), hand? (resolved HandPose)}. Created by `handScripts()` from three places: the character's own stored grips, each ready/visible rigid garment on a hand (`Garment.carryPose`/`carryOpen`, id `carry:<garmentId>`), and each garment pull with a pose (`pull:<g>:<p>`, `during = pull.holds`).
- `BlowScript` {clip (entry name), at (0.05-0.95; default 0.45), blowU?, late?: 'cut'|'hold', hand?, window?}.
- `PaceScript` {clip, like} (both entry names).
- Common: `id`, `enabled`, `note?`. Scripts reference entries **by name**, not by id.
- Fixed order everywhere: entry speed -> grip(s) -> blow(s) -> pace(s) -> lift -> bone keys -> prop tracks (`scripts.ts:1-10`, `animation.ts:38-55`).

### 4.4 Library `Clip` (`server/library.ts:6-45`) / `LibraryClip` (`state/api.ts:11`)
id, name, description, variant, sourceName/originalName/motionId, `nameSource` (source|matched|motion-match|motion-candidate|catalog|provisional|bundled), `problems[]` (audit), `candidates[]`, `source` (`mixamo-catalog`, `custom`, `bundled`, legacy `mixamo*`), `file`, fps/frames/duration, `category`, `confidence`, `tags`, `loop`, `inPlace`, `duplicateOf`, `rig` ('human' or a creature template), `propPaths?` (a clip saved from the editor with props leading), `href?` (outside the library), plus `url` added by `queryLibrary`.
Library sources merged at query time (`library.ts:192`): `manifest.json` (generated), `static/animations/*.glb` (bundled: human-base/addon/mocap + bird/dragon/fox/horse/kaiju/shark/snake/spider, categorised by regex `CATEGORY_WORDS`), and `workspace/library/creatures/index.json` (clips saved from the editor for creature rigs).
`LibraryPage` = {total, page, pages, pageSize, catalog, custom, categories[], clips[]} (`api.ts:12-22`).

### 4.5 `Mount` (`workspace.ts:71-88`)
`character` (horse id), `bone`, `position`, `rotation`, `scale?`, `freeze[]` (held bones), `pose` (their local rotations), `hips?`, `skin?`, `gear?`. Default seat from `straddle()` (`mount.ts:44-112`).

### 4.6 Game side (`server/game.ts`, `state/slots.svelte.ts:7`)
`UnitSpec` {character, height, budget, clips[], companion?{character,height,ridden,...}, draft?}; `GameSide` = {unit, role: unit|companion, clips, height, spec} from `gameSlots(id)`. A companion's slot list is the union of every unit that uses it (`game.ts:157-161`). `GameSide.spec` (the path of `units.json`) and server `companion` are not used by Animate.

### 4.7 Runtime state
- `animator` (`animator.svelte.ts`): `current: NowPlaying{clipId,url,name,test?,entry,propPaths?,edited?,slot?}`, `playing,time,duration,speed,loop,inPlace,mirror,loading,error,cycles,cut{name,start,end,uncut,blow}`, `previewSubject`, `previewVersion`, `lift`, `holding`, `unkeyed`; private `player`, `cache`, `posable`, `previews`, `mannequin`, plus horse twins `horseView/horsePlayer/horseCache/horsePosable`.
- `slots` {game, armed}; `library` {category, source, query, rig, page, data, loading, error}; `tune` {target, mode, busy, gizmo}.

---

## 5. Algorithms and jobs

### 5.1 Retargeting (`src/engine/retarget.ts`, cached by `src/engine/clips.ts`)
- `loadSource(url)` loads a GLB once (`files` map, never evicted except on failure/`forgetClip`), builds a per-clip source (`sources`, FIFO-capped at 200) with its rest skeleton (`clips.ts:26-53`). `file.glb#Name` picks a named clip from a multi-clip bundle (cloned scene per clip).
- `RetargetCache(targetRest).get(url, {inPlace, mirror, fps|samples})` memoizes baked clips by `url|inPlace|mirror|samples` (`clips.ts:61-77`).
- `retarget()` (`retarget.ts:369-452`): bones matched by canonical Mixamo names (`canonical` also maps the Mesh2Motion/UE rig, `:61-73`); each target bone's world turn = source bone's world turn * K, where K aligns bone directions (`alignment`, toward main child; hands toward the shared knuckle), adds palm-twist (half on forearm, full on hand) from palms measured off the skin (`restPalms`), and feet keep their own rest angle (`FEET_KEEP_REST`, env `RIG_FEET_ALIGN=1` reverts; `:304-326`). Hips translation scaled by hip-height ratio and expressed in the hips' parent frame. Sampled at 30 fps (or `samples` for sprites), played LoopOnce+clamp so the last frame isn't a wrap. `inPlace` removes least-squares horizontal drift while keeping sway (`removeTravel`, `:454-482`). `mirror` swaps L/R tracks and reflects (`mirrorClip`, `:484`).
- `retargetOffsets` (`:357`) is exported for the editor's un-retarget.

### 5.2 `bakeEntry` (`src/engine/animation.ts:38-55`) - the shared slot bake
1. `retime(cache.get(entryUrl(e), {inPlace: e.inPlace, mirror, fps}), e.speed)` for the entry (and for each enabled pace "like" clip).
2. `applyScripts(posable, clips, handScripts(character), gripClip)`.
3. `applyLift` on the Hips (`keys.ts:72-86`), then `applyBoneKeys`, then `withPropTracks` for every rigid garment.
4. Returns `{clip, unkeyed (before keys), report}`. Callers: `animator.bake` (viewer), `exportCharacter` (GLB export, `exporter.ts:88`). The *game* export (`tools/game_export.ts:160-185, 640-720`) re-implements steps 1-3 by hand (see 7.3).

### 5.3 Viewer playback (`animator.play`, `animator.svelte.ts:171-233`)
Entry path: bake -> (if riding) `freezeClip` rider, bake horse entry, `fitRide`, store `cycles` -> **un-retime** by `1/entry.speed` (the bake retimed by speed, the player then applies `timeScale = entry.speed`) -> `Player.play`. Library path: cache.get with the Timeline toggles -> `withProps` -> `grounded` (groundFit + applyLift). Horse plays in lock-step through a second `Player`. Token counter cancels stale async plays. `showClip` lets the editor push its own clip. `refresh()` re-runs the current thing (entry, library clip, fists, hand pose, or the editor's rebuild).

### 5.4 `Player` (`Player.ts`)
One `AnimationMixer` per root; saves every bone's rest TRS and restores on `stop()`; LoopRepeat or LoopOnce+clamp; `keepTime` preserves phase across rebakes; `seek` updates the mixer immediately. Frame driver: `stage.onFrame` in `animator.attach` (`:103-108`) updates both players and mirrors `time` into state; `holding` pauses the driver during gizmo drags.

### 5.5 Fist/grip application (`scripts.ts`)
`fistPose` (`:180-204`): sample the grip clip's finger chains at 30 Hz on the character, pick the frame whose chains are most curled (1 - chord/length), read each finger bone's local quaternion there (the **most-closed moment of a Mixamo clip**). `holdFist` (`:207-234`): remove the clip's own finger tracks and replace with that pose, either constant, or blended back to the clip's own hand inside `open` windows (or outside `during` windows) with eased `holdFactor` (0.06). `handPose()` is used when the grip names a stored HandPose. `animator.fistOf/playFists` expose the same poses to hand-pose tools and the Outfit "Rest, fists closed" pose.

### 5.6 Blow cut (`blowCut`, `scripts.ts:237-256`)
Blow time = either `blowU * duration` (kept a frame inside) or `blowTime` = hand's fastest world speed between 5% and 88% of the clip, ignoring one-frame snaps (4x 90th percentile steps). Then: `window` -> `[blow - at*window, +window]`; early blow -> shorten the end to `blow/at`; late blow -> shorten the start (`cut`) or lengthen the end (`hold`). `cut()` re-keys every track exactly at both ends via the track interpolant. The viewer records `animator.cut` (start/end/uncut/blow) so the script UI can say what the late blow costs.

### 5.7 Pace (`paceTo`, `stride`; `scripts.ts:137-148,259-266`)
Stride = median over frames of the lower foot's horizontal speed; factor = stride(like)/stride(clip); `retime`.

### 5.8 Ground fit (`src/engine/ground.ts`)
Cluster the skin vertices within 4% of height of the lowest point into feet (union-find on 5%-height radius), split each foot into heel/toe halves along its principal axis; through the clip (30 Hz) a foot is **flat** when heel and toe minima agree within 1.2% height; lift = -(10th percentile of flat contact heights relative to rest sole). Fewer than 3 flat contacts -> clip's lowest point. Used by `tune.autoGround`, `autoGroundAll`, `animator.groundEntries`, and `animator.grounded` (every library preview). `keys.ts:lowestPoints` (older "lowest skin point per frame") is dead code.

### 5.9 Mount / ride (`src/engine/mount.ts`)
`straddle` (rays onto the horse's back for the seat and barrel width; solves thigh/shin swings; yields bone, position, freeze list, pose, hips); `riderScale` (game heights ratio else `mount.scale`); `seatMatrix`; `freezeClip` (constant turn and Hips position on the frozen bones); `fitRide` (loops: pick (m,n) <= 6 minimising mismatch of m rider cycles vs n horse cycles, retime rider, `repeat` both; attacks: stretch horse to rider length; else untouched).

### 5.10 Library build pipeline (`blender/library/*`, `blender/clips/*`, `tools/library_*`)
- `npm run library:sync` -> `catalog.py sync` (downloads the pinned HuggingFace dataset revision, checksum-verifies, writes `sources/mixamo-named`), then `build.py all`, then `catalog.py verify`.
- `build.py convert` (`:144-265`): enumerate sources (catalog jobs + legacy local Mixamo packs under `~/Downloads` when no catalog index + made clips from `work/sources.json`), hash, skip done, run N parallel Blender processes of `convert.py` (FBX -> canonical 65-bone bones-only GLB in glTF space, `cache/<id>.npz` joint positions, `meta/<id>.json`; failures to `failures/*.jsonl`).
- `build.py aggregate` -> `aggregate.py run` (`:607+`): recompute features if `FEATURES_VERSION` changed (`features.py`, numpy only), classify into 14 categories, tags, duplicate detection, name recovery from a names file, provisional names, variant labels, patch GLB animation names, write `manifest.json` and this README.
- `tools/library_audit.py` (also run by `npm run library`) writes `audit.json` (name vs motion contradictions) shown on cards and enforced by game export `checkClip` (`tools/game_export.ts:110-120`).
- **Made clips**: `blender/clips/spear_thrust.py` (scripted), `blender/clips/edit.py` (editor saves: `POST /api/library/edits` -> `server/clipedits.ts` writes `<id>.edit.json` then runs the library build as a job). Creature clips from the editor are written as plain GLBs by `saveCreatureClip` (`POST /api/library/creature-clips`).
- Verification: `tools/library_verify.ts` (load + retarget every clip onto Y Bot and one character, write `verify/named-runtime.json` and a sample export), `blender/library/verify/*` (Blender reference vs three.js fidelity, skin checks), `blender/library/test_catalog.py`.
- Server-side serving: `server/library.ts queryLibrary` caches the manifest by mtime, `audit.json` by mtime, bundled clips forever, creatures by mtime; filter -> relevance sort (word-start, contains, tag-only) -> name rank -> name -> description -> duration; page size clamp 1..96.

### 5.11 Previews / thumbnails
- Library card sprites: `PreviewRenderer` (`PreviewRenderer.ts`), own WebGL canvas (144 px), clones the current character (or the Y Bot mannequin when none), retargets each clip in place at 17 samples, renders 16 frames into a 2304x144 webp sheet, blob URL cached per `(characterId, revision, boneMap)` key; queue is sequential with a `setTimeout(0)` yield; page change cancels pending jobs. Subject changes bump `previewVersion` so visible cards re-request.
- `src/state/thumbnails.svelte.ts` is **not** an animation thumbnail: it renders *character* list thumbnails with `ThumbnailRenderer` and uploads them (`api.thumbnail`). It lives next to animation state but belongs to the character list.

---

## 6. Cross-area dependencies

| Depends on / is used by | Detail |
|---|---|
| **Props/Outfit** | `Garment` (rigid, `bone`, `carryPose`, `carryOpen`, `pulls`, `scale`) drive `handScripts`, `withPropTracks`, tune prop targets (`propNode`). Outfit's Pose select, pull sampling, mount editor call `animator.*`. `outfit.svelte.ts` also calls `animator.refresh(true)` after edits. |
| **Hand poses (Rig step)** | `HandPose` objects are referenced as `pose:<id>` by scripts, `carryPose`, pull `pose`; `FISTS` (the 5 canned fist clips) is exported from `animator.svelte.ts` and consumed by `HandPoseSelect`, `HandPosesPanel`, `handposes.svelte.ts`. `animator.fistOf/playHandPose` serve that panel; `handPoses.capture` serves Animate's "Send hand pose". |
| **Editor** | `clipEdit` sets `animator.editing/leaveEditor`, calls `animator.showClip`, reads `animator.lift`, `restOf`, `GRIP_CLIP`, `handScripts`, `forgetClip`; Timeline reads `clipEdit` (busy, phases, snapTime, setLoop); `AnimatePanel` mounts `EditPanel`; `useForSlot`/LibraryCard refuse `edited` clips. Editor save -> `library.reload()` (`clipedit.svelte.ts:1359,1378`). |
| **Rig step** | `animator.playTest` (tests from `static/templates/tests.json`), `rebind()` on bone map change, markers board and painter stop playback. |
| **Export (GLB)** | `ExportPanel` -> `exportCharacter(view, c.animations, new RetargetCache(...), entryUrl, ...)` -> `bakeEntry` per entry (no mirror). |
| **Export (game)** | `tools/game_export.ts` (headless) consumes `character.animations`, `scripts`, `mount`, `units.json` clips; `server/game.ts exportUnits` spawns the game repo's `build.sh`; `tune_parity.ts` compares viewer vs exported clip. |
| **Game spec** | `gameSlots` -> `/api/characters/:id/game` -> `slots.game` (re-fetched on SSE `game` events via `app.gameBeat`); `viewer.gameHeights` re-reads the same endpoint for rider scale. |
| **Viewer/Stage** | `animator.attach(view, stage)`; `tune` creates a `TransformControls` on `stage`; `viewer.syncMount` feeds the horse. |
| **Server** | `GET /api/library`, `POST /api/library/edits`, `POST /api/library/creature-clips`, `PATCH /api/characters/:id` (whitelist includes `animations`, `scripts`, `mount`, `handPoses`), `GET /api/characters/:id/game`, `PUT /api/game/units/:name`. |
| **Rigging/skin optimisation** | `api.ts trainedClips()` uses the entries' `clipId`s to train weights on the clips the unit actually plays (`server/api.ts:108-115`). |

---

## 7. Redundancy and overlap

### 7.1 Many ways to close a hand (fists)
1. Stored **grip script** (`character.scripts` kind `grip`): now UI-less in ScriptsPanel (`ScriptsPanel.svelte:16`), editable only via the editor's prop panel (`clipedit.svelte.ts:666,746-767`); 8 characters still hold them.
2. **Garment `carryPose`/`carryOpen`** on a hand-borne rigid garment -> synthesized grip (`scripts.ts:48-54`); default `DEFAULT_FIST` when unset.
3. **Pull poses** (`pulls[].pose`/`holds`) -> synthesized `during` grips (`scripts.ts:56-62`).
4. **Named `HandPose`** (`pose:<id>`, Rig -> Hand poses), created by Rig tools, by "Send hand pose" from a frame, or by `addFist` from a clip.
5. **`FISTS`** list: five hard-coded Mixamo clips offered in `HandPoseSelect`, `HandPosesPanel`, plus `DEFAULT_FIST`/`GRIP_CLIP` (same constant under two names: `scripts.ts:32`, `animator.svelte.ts:41`).
6. **Per-finger bone keys** through Tune (the Tweak select lists every bone including finger joints, `TunePanel.svelte:77`) and the editor's finger keys, which `clipedit` has to *protect* (`clipedit.svelte.ts:1258`).
7. **Rest, fists closed** preview (`playFists`) - a seventh place that resolves the same set, with its own re-implementation of "which grip applies" (`animator.svelte.ts:297-325` vs `fistOf` `:269-278` vs `handScripts`).
Result: precedence is implicit (own grip wins over carry; pull on top; keys on top of all) and nothing in the Animate UI shows which source is closing a given hand in a given clip.

### 7.2 Tune keys vs editor keys vs saved clips
- Tune keys (`entry.keys`, phase-based, per slot, applied on top of any clip, Catmull-Rom) and the animation editor's keys (per-frame solved poses saved as a *new library clip*) both "adjust a clip". Different storage, different interpolation, different UI (gizmo on one bone vs full-body IK). A tuned slot that is later edited has its keys either kept or dropped depending on route (`saveToSlot` drops `keys`, `slots.fill` keeps them).
- Prop paths exist in three forms: the editor's live `paths`, `LibraryClip.propPaths` (saved with a clip), and `entry.keys.props` (what the slot actually plays); `withPropPaths` merges clip->entry on add/fill.
- Real usage: across 34 characters / 168 entries only **1** entry has keys and **1** has a lift; 0 have `trim`. The tune system is essentially unused in data.

### 7.3 Duplicated baking paths (viewer vs exports)
- `bakeEntry` (viewer + GLB export) and `tools/game_export.ts` (`:160-185` for companion clips and `:640-720` for the unit) implement the same speed -> scripts -> lift -> keys -> props pipeline separately, plus separately duplicate the ride freezing/fitting. `tools/dev/tune_parity.ts` exists to detect drift and still cites a non-existent `animator.scripted` (`:2`), as does README.md:169.
- `tools/library_verify.ts` is a third retarget harness (retargets on Y Bot + a character) with its own loader shims.
- Mirror exists only in the viewer path (`animator.mirror` -> `bakeEntry({mirror})`); neither export passes it.

### 7.4 Multiple players, caches, copies
- Players: main `Player` + horse `Player` in `animator`; `PreviewRenderer` own mixer per sprite; `tune`/`groundFit`/`sample`/`lowestPoints`/`blowTime` each create temporary `AnimationMixer`s and hand-roll "save bones -> sample -> restore" (`scripts.ts:109-116`, `keys.ts:163-185`, `ground.ts:52-56`).
- Retarget caches: `animator.cache`, `animator.horseCache`, `PreviewRenderer.retargets`, `ExportPanel` makes a fresh one per export, plus module-level `files`/`sources` in `clips.ts`. `sources` is capped at 200 (FIFO, not LRU) but `files` (whole parsed GLTFs) is not capped at all.
- Posable character clones: `animator.posable`, `horsePosable`, `PreviewRenderer.model`, exporter clone, editor posable.
- Three WebGL contexts for one page: stage, `PreviewRenderer`, `ThumbnailRenderer`.
- "Find the character's first SkinnedMesh" is copy-pasted three times (`animator.svelte.ts:333-334,348-349`, `tune.svelte.ts:181-182`; again in `tools/dev/tune_parity.ts`).
- `propNode()` is defined twice (`tune.svelte.ts:17`, `animation.ts:11`) and inlined a third time in `tune_parity.ts:46,70` and `garments.ts:487,508` (the `_place` naming convention is implicit).
- `restOf` in `animator.svelte.ts:468` is a one-line wrapper over `boneRest` (`animation.ts:15`).
- `KEY_FPS`(keys.ts:9) vs `const fps = 30` in Timeline (`:11`) vs `fps` options in retarget.
- URL-retention rule "keep `url` only for `/animations/` or creature clips" is written three times: `LibraryCard.svelte:62`, `AnimatePanel.svelte:65`, `tools/lib/node3d.ts:47-50` (and `entryUrl`).
- Speed option lists differ: entry (`AnimatePanel.svelte:73`: 0.5,0.6,0.75,0.8,1,1.25,1.5,2) vs Timeline (`Timeline.svelte:17`: 0.25..2).
- Two "defaults for loop/in-place on a new entry": card button uses clip metadata (`LibraryCard.svelte:62,71`), Use button uses the Timeline toggles (`AnimatePanel.svelte:65`).
- Two category vocabularies: aggregate.py's 14 (`aggregate.py:~28-35`) vs server fallback/`CATEGORY_WORDS` for bundled clips with 10 (`library.ts:91-102`, no climb/sports/transition/pose).

### 7.5 Library vs creature clips vs bundled clips
Three physically different catalogs (generated manifest, `static/animations`, `workspace/library/creatures`) merged at query time with one `source` string; "Custom (n)" counts every `source==='custom'` from any of them. Human "bundled" clips (human-base/addon/mocap) sit beside the Mixamo set (the label stripper `AnimatePanel.svelte:31` removes `mixamo-|custom-|human-|horse-`).

### 7.6 Several paths that fill a slot / set a name
Arm+card, Use, `saveToSlot`, `tools/rig.ts slot`; plus "Trial" with the same name, and the trial rename box, can silently take over a slot (7 below).

### 7.7 Dead or vestigial code
- `AnimationEntry.trim` (`workspace.ts:199`) unused.
- `lowestPoints` (`keys.ts:162-188`) unused.
- `const frames = frameTimes` alias in `keys.ts:61` (use only inside the same file).
- `ScriptsPanel.add('grip')` branch (`:31-32`) unreachable from the UI; `hint()` grip branch (`:39-40`) can never render (grips are filtered out at `:16`).
- Orphan doc comment above `riding()` ("The local pose of `bones` at the first frame of a library clip ... a seat's legs") describing a removed function (`animator.svelte.ts:130-131`).
- `animator.lift` field is set in `grounded()` but only consumed by the editor (`clipedit.svelte.ts:202`).
- `GameSide.spec` (`slots.svelte.ts:7`, `game.ts:147-149`) is never used by the UI; server returns `companion` that the client type omits.
- `README.md:169`, `tools/dev/tune_parity.ts:2` mention `animator.scripted` (gone).
- Library build legacy: `build.py enumerate_sources` still has `mixamo-pack`, `mixamo-pack-extra`, `mixamo` (local `~/Downloads/Mixamo*` packs, `NAMED_TAGS`, `NAMED_EXCLUDE`, hard-coded Y Bot path) used only when no catalog index exists; `aggregate.py` duplicate detection/names matching for those packs; `README` generator says "Do not edit".
- `FEET_KEEP_REST` env switch (`retarget.ts:304`) is a one-off experiment toggle.
- `cmd` `Library.svelte` `total` vs server `total` naming: header shows sum of category counts, the pager shows `data.total`.

---

## 8. Rough edges

### 8.1 Confusing UI / discoverability
- **Vocabulary soup**: slot / entry / clip / animation / trial / "set" / "Animation set" / "Library". The same list is "Trials" or "Animation set" depending on whether a game unit exists. "Tune <name>" panel has a "Tweak" select and a "Ground" field whose model name is `lift`. "Scripts" contains Blow timing and Pace, while "Hold fist" (README still lists it as a script) is invisible.
- **Grip scripts vanished from the UI** but remain active data (8 characters) and still affect the output; the only hint is the sentence in the empty Scripts help text.
- **Three slot-fill gestures** (arm, Use, direct editor save) with different defaults for loop/in-place/speed/keys (see 7.4, 7.6).
- Armed slot is easy to forget: a card's round button silently changes meaning (remove/add/fill) with only its label and the outline on a row in a different panel as feedback.
- Timeline In place / Loop / Mirror / Speed look identical to the Inspector's saved controls (same icons), but do different things (preview-only vs saved). Only tooltips ("Saved setting") distinguish them.
- Frame numbering differs: Timeline counts frames of the *nominal* clip (`duration*30`), Tune counts frames of the *sped* timeline (`duration/entry.speed/cycles*KEY_FPS`, `TunePanel.svelte:19`); blow frames are yet another scale (uncut clip, `ScriptsPanel.svelte:69-74`). At speed != 1 "frame 45" means different frames in three places.
- Hand poses are "sent" by pressing Left hand/Right hand with no preview and no naming prompt; the result lives in a different step.
- "Use this set on N other characters" is destructive (replaces all of each other character's animations, keys and lifts included), offered without confirmation or per-character choice, and hidden for any character with a game unit.
- "Clear" in the set header deletes all entries without confirmation and is only shown when there is no game unit.
- Key list label shows "frame N / total" where `total` changes with entry speed and rider cycles; keys appear in "Keyed:" quick links but are not drawn on the Timeline (the Timeline only draws editor keys).
- The slot row's clip name is rendered under the slot name in a wrapped row (`order:1; flex-basis:100%`), but the row also carries 5-6 icon buttons; at the 328 px inspector width this is dense.
- Library: `Custom` chip is the only source filter; there is no way to show only Mixamo, only bundled or only creature clips. Header count ignores filters; search does not search by category/slot.
- The Timeline is mounted on Export and Outfit steps too, with no explanation of where its Loop/Speed state comes from.

### 8.2 Bugs / risky behaviour visible in code
- **Index-based identity**: `animator.current.entry` and `tune.entry` hold an *array index*. `drop()` (reorder) and `slots.clear()` / `remove()` of an earlier item shift indexes without updating `animator.current.entry`, so the highlighted row, the Tune panel and the gizmo can point at a different entry afterwards (only the entry being removed is checked: `AnimatePanel.svelte:44-56`, `slots.svelte.ts:56-62`).
- **Name-based slot identity**: an entry *is* a slot purely because its `name` equals a game clip name. A trial renamed (`AnimatePanel.svelte:127-128`) or added (`LibraryCard.svelte:70`) with a slot's name silently becomes that slot; a second entry with the same name is shown nowhere (excluded from Trials by `names.includes`, hidden behind `findIndex` in slots). Scripts also address entries by name (blow/pace `clip`, `like`): renaming/clearing a slot silently disables its script (`applyScripts` just `continue`s, `scripts.ts:285-286,292-293`).
- **Card "remove" is by clipId**: the check mark appears for any clip used by *any* entry, including a slot's; pressing it (not armed) removes all entries with that clipId (`LibraryCard.svelte:65-67`, `Library.svelte:19`), wiping slots, keys and lifts with one click.
- **Preview != entry height**: library previews are auto-grounded on every play (`animator.svelte.ts:215,345-355`) but an entry plays with its stored `lift` (default 0) and nothing runs ground-fit when a slot is filled; so "Use" visibly drops/pops the character, and the Auto button must be remembered.
- **Fill keeps the old tweaks**: `slots.fill` over an existing slot keeps `speed`, `loop`, `inPlace`, `keys` and `lift` of the previous clip (documented as intended, `slots.svelte.ts:34-35`) but those were tuned for a different motion; blow `blowU` and `at` in scripts also stay.
- **Timeline toggles that don't do what they say for entries**: In place toggles `animator.inPlace` but the entry bake uses `entry.inPlace` (`animation.ts:46-49`), so on an entry the button changes only its own pressed state and the flag that the next "Use"/new card add will inherit. Mirror affects the viewer bake but is never saved/exported (violates "what plays here is what the game gets"). Speed select replaces `animator.speed`, so scrubbing the dock at 2x then pressing the saved speed does nothing visible until the entry is replayed.
- `copyToAll` and `save()` are not awaited transactionally; `Promise` failure leaves a partial copy.
- `Library.setRig` resets category but not source/query/page filters of the previous rig; `library.load` is only triggered via `setRig` effect on mount (no explicit initial load) and debounce timer can fire after a rig switch (`library.svelte.ts:52-57,68-74`).
- `LibraryCard` `playing` highlight is `current.clipId === clip.id`, also lit while an *entry* with that clipId (e.g. a slot) plays, and the `clipId` strings `'fists'`, `'handpose'` are magic values mixed into `NowPlaying` (`animator.svelte.ts:293,301`, `AnimatePanel.svelte:30`).
- Naming runaway in the library: `custom-Attack_Editing_Editing_Editing_Editing_Edit`, `custom-Spear_Thrust_Edit1` exist (`workspace/library/clips`, `work/sources.json`): editing an edit appends to the name each time.
- `bundledClips()` reads all bundled GLBs once and caches forever (no mtime check); `clips.ts files` map grows unbounded; `PreviewRenderer.sheets` blob URLs live until the subject changes (no cap), with no disk cache so every launch re-retargets every visible card.
- `mirrorClip` relies on `track.name.split('.')` (bone names with dots would break); `canonical()` regex strips `mixamorig` generically.
- `fitRide` brute-forces ratios up to 6:6 and can leave a >0 error unreported in the UI (`report.fit` is computed but never surfaced).
- `Timeline.finishScrub` is bound to `window blur` and pointer events; dock height CSS var is written to `document.documentElement` (global side effect, removed on unmount).
- `GRIP_CLIP` vs `DEFAULT_FIST`, `propNode` x2, `restOf`/`boneRest` x2: two names for one thing invite drift.

### 8.3 Legacy comments / naming
- `README.md:169`, `tools/dev/tune_parity.ts:2`: `animator.scripted`.
- `docs/animating.md` still says "Fist: each hand's picker (Great sword, ...)" and "grip scripts" in the editor, while the Scripts panel says the fist is "set on its prop, in the animation editor".
- `scripts.ts:1-10` header says scripts are applied "in `tools/game_export.ts`" while that tool duplicates, not reuses, `bakeEntry`.
- `workspace/library/README.md` says "Mixamo pack" legacy language and is generated; `build.py` header still documents `~/Downloads/Mixamo/animation-names.json`.
- Comment style: prose-heavy parenthetical comments; some UI strings are instructions embedded in `<p class="faint small">` that duplicate docs.
- `LibraryCard` names the round button "add"/"slot"/"on" classes for three semantic states; `Library.svelte` calls the left panel "Library" even for creature rigs where it is a different catalog.

### 8.4 Suggestions for the rebuild (from the above)
1. One entry identity (stable id) separate from slot name; slot = (unit, clip name) mapping to an entry id.
2. One "hand state" model (poses + per-clip overrides) replacing grip scripts, carryPose, pull poses and finger keys.
3. One bake function used by viewer, GLB export and game export (mirror/in-place flags included or removed), with the parity script as a test.
4. Show effective vs saved settings clearly; make the Timeline an inspector of the *entry* (or a pure preview) but not both.
5. Auto-ground on fill, show ground state per slot; decide whether tune keys stay (almost unused) or fold into the editor.
6. Collapse caches/players behind one `ClipRuntime` (retarget cache + posable + sampler), cap memory, persist sprite sheets.
7. Unify the library catalogs behind one manifest (bundled and creature clips included) and one category vocabulary; remove legacy `~/Downloads` source paths and unused fields (`trim`, `lowestPoints`).
