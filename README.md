# Rigsmith: auto-rig, skin, dress and animate 3D game characters

**Rigsmith is a local web app for turning a character mesh into a game-ready, animated glTF/GLB unit.** Drop in an
FBX, GLB, OBJ, DAE or Tripo ZIP and Rigsmith auto-rigs it onto the Mixamo skeleton (up to 65 bones, every finger), computes
skinning weights, fits gear and clothing, plays animations from a library of 2,446 named Mixamo clips, and exports
the result into a game with the checks its engine contract needs. It runs on Three.js and Svelte in the browser with
Blender doing the heavy jobs behind a small local server.

It was built as the character pipeline for the Emberhold game's units, and its export step speaks that game's
`units.json` / `build.sh` contract. The rigging, weight painting, retargeting and animation tools are general.

![Rigsmith's Motion step: a huntress drawing a bow in the Attack clip, with the skeleton overlay, the game's clip slots and the timeline with a Release event](docs/screenshots/motion-huntress-bow-release.webp)

*The Motion step on a real character: the Attack clip ("Standing Aim Overdraw") paused mid-draw with the bones shown, the
unit's clip slots (Idle, Walk, Run, Attack, Die) on the right and the timeline below with a Release event on the
Events row.*

```bash
npm install
npm run dev        # the app and its local server on http://127.0.0.1:5180
```

Needs Node 24+ and Blender 5.x on `PATH`. See [Quick start](#quick-start) and [Requirements](#requirements).

## Why Rigsmith

- **One pipeline, seven steps, in order:** Import, Skeleton, Skin, Gear, Look, Motion, Ship. Each step is a
  panel on the same character, with the same 3D viewport.
- **Fixing things by hand is first class.** Auto-rigging gets you most of the way; every joint, finger, weight, gear
  placement and animation key can be adjusted in the app, and your hand edits are kept across re-rigs.
- **Everything is undoable and journaled.** Each change is a command in one pure reducer; the Activity drawer shows who
  changed what (you, or the command line) and can take it back.
- **What you preview is what ships.** The viewer and the game export bake animations with the same code, and the Ship
  step checks the game's rules before you export.

## Features

- **Auto-rigging to the Mixamo skeleton.** Joints are detected from the mesh (hand tips, wrists, armpits, crotch,
  feet) and the rig is built in Blender at a finger level of 25, 33, 41 or 65 bones. Rigged imports from Mixamo,
  Unreal, Rigify or Tripo can be mapped onto the same skeleton.
- **Manual landmark placement.** Drag body markers on a flat front view and fingertip markers on a view of each hand;
  the skeleton follows and the other side mirrors.
- **Skin weights you can judge and paint.** Regional heat weights with a per-island volume-heat comparison, a weight
  lock for hand-fixed weights, deformation tests that play clips which work the joints hard, and weight painting on the
  posed body (Heal, Add, Remove, Smooth, Follow, Lift, Bone brushes, with left/right mirroring).
- **Gear with handles.** Catalog weapons, shields and tools, game gear, or your own models ride a bone with a gizmo
  placement. Handles say where hands hold a piece: a carry handle, grips for the other hand, and pulls (a bowstring
  drawn by the other hand).
- **A clip library of 2,446 named Mixamo animations** plus bundled work and combat clips and creature clips, each
  previewed on your character, retargeted onto your rig.
- **A clip editor on the timeline.** Per slot: speed, loop, in place, ground contact, blow timing, pace, hand poses,
  handle hold, keys, and events (hit, release, step, or your own) with sounds.
- **Mounted units.** Seat a rider on a horse, size him against the game's horse, and hold his lower body in the seat while
  the rest plays his clips.
- **Dynamic (modular) characters.** One shared body dressed per unit from sets, skins, clothes, hair and beards; a
  Wardrobe browser and a Crowd preview.
- **A game contract checked before export.** LODs, grounding, bone names, clip names and stepping, and budget checks,
  then a cancellable Export that builds the unit into the game repo.
- **A command line** (`tools/rig.ts`) that reads and changes characters through the same commands as the app.

## Screenshots

All screenshots are of the running app. The characters are from the project this tool was built for.

### Rigging: skeleton and markers

![The Skeleton step on a healer: the skeleton drawn inside the model, the marker legend and the joint list](docs/screenshots/skeleton-healer.png)

The **Skeleton** step picks the template (Person, Horse, or Other creatures) and shows the detected joints in the 3D
view. Markers for chin, shoulders, elbows, wrists, groin, knees and ankles (and thumb and index tips for the fingers)
place the whole skeleton at once; the joint chips below fine-tune each joint, with Mirror left and right on.

![Marker placement on a flat front view of a farmer in A-pose, with colored A and B markers on the head, shoulders, elbows, wrists, hips, knees and ankles](docs/screenshots/skeleton-markers-body.webp)

![Close-up of a right hand with thumb and index fingertip markers to drag onto the finger ends](docs/screenshots/skeleton-markers-hand.webp)

*Manual landmark placement for auto-rigging. Body tab: "Drag each marker onto its joint. The skeleton follows; letting
go saves it." Right hand (A) tab: drag the T and I markers onto the very end of the thumb and index finger (the other
hand follows, mirrored).*

### Skinning: weights and weight painting

![The Skin step: rainbow bone-weight view of a bear-pelted warrior during the Jumping jacks test, with Heal, Add, Remove, Smooth, Follow, Lift and Bone brushes](docs/screenshots/skin-weight-painting-bearguard.webp)

The **Skin** step shows the weights as colors while a deformation test clip plays (here "Jumping jacks"), so creases
and candy-wrapping show up. Pause on the frame that shows the problem and paint on the body with the Heal, Add, Remove,
Smooth, Follow, Lift and Bone brushes, with a mirror toggle and Left to right / Right to left copies. Painted weights are
saved and put back after every re-rig.

### Gear: weapons, shields and bow pulls

![The Gear step: a bear-pelted warrior with a war hammer and a round shield, the move gizmo on the shield, and held-by, swap set and position controls](docs/screenshots/gear-bearguard-hammer-shield.webp)

In **Gear**, each piece rides a bone (here the shield on the left forearm, the hammer on the right hand) with a gizmo and
Position / Turn / Size fields, a Held by bone, a Shown toggle and a Swap set. Choosing a clip under **Pose** shows the gear
as the game plays it.

![The Gear step on an archer seen from the side at full draw, with the Draw pull on the bow, drawn by the right hand](docs/screenshots/gear-bow-pull.png)

*Bowstring pull.* The bow's handles list a carried handle (Bow Grip in the left hand) and a **Pull** named "Draw",
drawn by the Right hand and held in Attack 52-90%. "Pick its point" chooses the point on the bow the strand bends at.

### Motion: clips, hands, ghosts and events

![The Motion step with the clip library open, searched for "bow", with each card previewed on the archer](docs/screenshots/motion-library.png)

The clip **Library** is searchable and filterable (sort, group, rig, loop, movement, use); each card previews the clip on
your character, and its + button keeps it as a trial to compare.

![The Motion step on the Attack clip with the right panel scrolled to the Attack: ground, timing and hands section and the Hands panel](docs/screenshots/motion-huntress-hands-panel.webp)

Each slot takes a stack of adjustments: **Layer**, **Blow timing**, **Pace**, **Hand pose**, **Posture**, **Ground**,
**Event or sound**, and a **Handle hold**. The **Hands** panel shows each hand's layers (here the left hand carrying
Weapons_LeftHand in a 2BoneGrip pose) and "Held in every clip" poses.

![The Motion step on a farmer's Harvest clip with colored joint trails drawn around the figure, the full game clip list and a Hit event](docs/screenshots/motion-farmer-harvest-trails.webp)

*A game unit's full clip list* (Idle, Walk, Run, Carry, Work, Mine, Build, Harvest, Forage, Trade, Hunt, Attack, Die), with
per-slot speed (Harvest at 0.8x), a **Hit** event on the timeline, joint trails around the figure, and a Trials list for
comparing library clips without adding them to the game.

![The Release event of an archer's Attack clip selected, with its sound set to "bowshot"](docs/screenshots/events-sound.png)

*Sound events.* The selected **Release** event reads "Something leaves the hand: the arrow or javelin flies from its
bone", at frame 28 of 31, with a sound ("bowshot", with a play button) or a dropped WAV, OGG or MP3. The game's sound
mix table wasn't available when this was captured, which is why the field says it isn't there.

### Mounted units: a rider on his horse

![The Ship step for a knight on a horse: the game unit's height, budget and levels, the Rides setting and the Mount section](docs/screenshots/mounted-knight-ship.png)

A rider's horse is his unit's companion. **Ship** shows the unit (height, triangle budget, levels, the clips it
plays), which horse it rides ("Horse", 2.3 tall) and the **Mount**: the horse bone he sits on (spine_2), **Place him**,
and the list of his lower-body bones held still in the seat.

![The Motion step playing the knight's Walk clip, the rider with lance and shield on his horse](docs/screenshots/mounted-knight-motion.png)

### Dynamic characters: outfits, skins, hair and beards

One body shared by every unit of a kind, dressed per unit. The same character, two looks:

![The Gear step for the dynamic Folk V6 character in a red tunic with the Set picker, Skin, Clothes and Hair choices](docs/screenshots/dynamic-folk-outfit-picker.webp)
![The same character in a helmet and mail armour with the Set "arm mail remake" selected and a tooltip reading "arm mail remake (1% of units)"](docs/screenshots/dynamic-folk-mail-armour.webp)

*Left: set "gael a remake". Right: the **armour** category with "arm mail remake" selected (the options are brigandine,
fur, leather, mail, plate, scale and their remakes), hair set to None and a beard piece listed.* The panel also has Skin
swatches, Clothes swatches, and Hair choices (norse, gael, wagon, order, swiss, barrow, warrior tail, mohawk, braided
crown, plaits, bun, loose).

![The Wardrobe drawer on the Sets tab, with tabs for Sets, Skins, Clothes, Hair, Beards, Pieces and Props and filters for culture, kind, body part and tag](docs/screenshots/wardrobe-sets.png)

![A crowd of twelve differently dressed units of the dynamic character](docs/screenshots/crowd-preview.png)

![The Look step listing cloth layers with bottom, top and over slots and Wear, Up, Down, Remove and Duplicate as shorts buttons](docs/screenshots/look-clothes.png)

The **Wardrobe** browses sets, skins, clothes, hair, beards, pieces and props; **Crowd** draws 8, 12 or 24 randomized units; **Look** keeps cloth layers in bottom, top and over slots, with shorts and short-sleeve
duplicates and cut-and-trim controls.

### Command line output

![A terminal: rig.ts list showing every character with its game unit, then rig.ts show for the archer with its slots and events](docs/screenshots/cli.png)

`tools/rig.ts` lists, shows and changes characters the same way the app does. See [The command line](#the-command-line-1).

## Quick start

```bash
git clone https://github.com/dashw00d/rigsmith.git && cd rigsmith
npm install
npm run dev        # the app and its local server on http://127.0.0.1:5180
npm start          # a production build, served the same way on 5181
```

Then drop a character on the window (FBX, GLB, OBJ, DAE or a Tripo ZIP, any number at once) and follow the steps along the
top. To try it without a mesh of your own, drop `static/models/model-human.glb` (a T-pose mannequin): joint detection
finds its joints and the Skeleton and Skin steps run on it as they are. Everything you make lives in `workspace/` (gitignored, see [Workspace](#workspace)); set `RIGSMITH_WORKSPACE` to put
it elsewhere.

Before the Motion step is useful, build the clip library (about 1.4 GB of Mixamo FBX from a pinned Hugging Face
revision, checksum-verified):

```bash
npm run library:sync
```

Tips from running it:

- Joint detection needs an A- or T-pose humanoid facing the camera (arms level or sloping down); for anything else,
  place the markers by hand on the Skeleton step.
- Without PyTorch in `.venv` the pose optimizer is skipped and the rig report says so (`npm run setup:python` sets it up).

## Requirements

- **Node 24+** (`.nvmrc` says 24; it runs `node tools/*.ts` directly).
- **Blender 5.x** on `PATH` (or `BLENDER=/path/to/blender`), for import, rigging, texture and library jobs.
- A browser (Chrome was used for the screenshots); `google-chrome` (or `CHROME=...`) for `tools/rig.ts shot` and the end-to-end tests.
- Optional: the Codex CLI (AI repainting in Look), PyTorch in `.venv` (pose-optimized weights), and Godot 4.x (the
  import check, `npm run test:godot`).

## How it works

A Vite dev server serves the Svelte 5 app and mounts a local API (`server/`). The app keeps one JSON document per
character and sends every edit as a command; one pure reducer applies it on the server and, optimistically, in the app,
and each request is one undoable entry in the character's journal. Long work (import, rig, finger trace, texture compose,
export) runs as cancellable jobs: Blender for geometry and rigging, Node and optional PyTorch for weights, and the game's
own build script for export. The 3D engine (`src/engine/`, Three.js, no DOM) runs headless in Node too, which is how the
exporter and the command-line tools bake with the same code the viewer plays.

## The seven steps in detail

| Step | What it does |
| --- | --- |
| **Import** | Drop FBX, GLB, OBJ, DAE or ZIP (Tripo zips work as they are), any number at once. Blender normalizes each and says what it holds: a mesh, a rigged character (Mixamo, Unreal, Rigify, Tripo…) or an animation. Shows the source, its stats, its size (height, stood on the floor; resize keeps everything placed in proportion) and what the import noticed. Re-import asks first, refuses while a job runs, and keeps your placed joints. |
| **Skeleton** | Pick the template (a person, a horse; "Other creatures" for the experimental ones). One joint view: the marker board (a dozen points on a flat view; drag one and the skeleton follows) and the 3D joints are two cameras on the same placements, with a Mirror toggle. Finger level (25/33/41/65 bones) and "Detect again" re-trace the hands; placements they make meaningless are set aside for you to restore or discard. A rigged import with a foreign skeleton can be mapped onto Mixamo's and converted. **Rig** runs the rig job in Blender; **Auto-rig all** does a batch. |
| **Skin** | The rig report as decisions (which weights won and why), the weight lock (hand-fixed weights are locked: nothing may change them until you unlock), deformation tests (library clips that work the joints hard), the weight view, and weight painting on the posed body. |
| **Gear** | What the character wears and carries: game gear (brought in by `tools/game_import.py`), catalog weapons, shields and tools, and your own uploads. Each piece rides a bone with a gizmo placement; "Other ways to wear it" puts clothing on the skin or pins a part to a spot. Swap sets show one piece at a time. **Handles** say where hands hold it: the carry handle (the hand it rides), grips for the other hand, pulls (a point another bone draws, like a bowstring), each with the hand pose it closes to. Gear weight painting for clothing and pulled gear. |
| **Look** | Texture layers over the model's own image: the hole fill (the magenta gaps AI texture generators leave, filled from nearby paint in 3D, seam-aware), repaints and old snapshots; each can be switched off, removed or reordered, and every change can be undone. Projection painting: mask on the model (smart brush, wand, brush), capture the views that see it squarely, have Codex (or an image of yours) paint them, preview the bake, keep it as a new layer. |
| **Motion** | The unit's **slots** (each clip name the game plays) and trials. Arm a slot, then pick a card in the clip **Library** (the complete named Mixamo collection, bundled work and combat clips, creature clips, and your own edits; every card previews on your character). Per slot: speed, loop, in place, and an **adjustments** stack: ground (with Auto), blow timing, pace, hand pose, handle hold, keys. The timeline shows the playing slot's adjustments as lanes. **Edit** opens the clip editor ([docs/animating.md](docs/animating.md)). Copy a set to other characters. |
| **Ship** | The unit: its height (set by eye in the scale room, among the game's own models), budget, levels, clip names, draft; its companion and the mount (a rider and his horse, set together); the contract checks, pass or fail, before you export; **Export to the game** (cancellable) and the last build record (strides, holds that failed, warnings). The game repo's path is set here. |

Round the steps: the **character list** (search, import, rename, delete with a check for riders, units and running
jobs, status from what the character can do now), the **Activity** drawer (this character's journal with Undo on each
change you can take back, notes, and every job with its progress and Cancel), the **Hands** panel in Gear and Motion
(each hand's layers for the slot playing, which one wins at the playhead and why, and the named hand poses), and
**Settings** (the game repo). Hand poses can be shared by every character (`settings.json`).

## How a character is kept

One document per character (`characters/<id>/character.json`, schema 5: `src/model/types.ts`; older files are migrated on first read), in sections with one
owner each: source, skeleton, skin, hands, gear, clips, look, mount. Every change you make is a **command**
(`src/model/command-types.ts`) applied by one pure reducer on the server and, optimistically, in the app; each request
is one entry in the character's **journal** (`journal.jsonl`: who, when, what, in words) and can be undone from the
Activity drawer unless a later change touched the same thing. Long work (import, rig, finger trace, texture compose,
export) runs as **jobs** that write through the same journal and can be cancelled. The rules and APIs behind this are
in [docs/rebuild/DESIGN.md](docs/rebuild/DESIGN.md); why it was rebuilt this way is
[docs/rebuild/PLAN.md](docs/rebuild/PLAN.md).

## Game units: the contract and the flow

The game's units are these characters, and the game gets them exactly as they are here.

- **Rigsmith keeps its own unit list** (`workspace/game/units.json`, `src/model/unit.ts UnitSpec`; first copied from
  the game's): which character each unit is, its height and budget, its levels, the clip names it plays, its
  companion, and whether it is a draft (built only when named). Ship edits it (or `tools/rig.ts unit`), live in every
  open page and journaled on the characters it names.
- **The game's repo is written only by Export** (Ship's "Export to the game", `tools/rig.ts export UNIT`): the unit's
  block of the game's `tools/rigsmith/units.json` (that block alone, every other byte kept), then the game's
  `tools/rigsmith/build.sh` for it, which runs `tools/game_export.ts` (`tools/lib/unit_export.ts`). One export runs at
  a time. Each build gets a run token (`RIGSMITH_RUN`, through `build.sh`'s environment into the build record); the
  export passes only when every unit's record carries it and its `.glb` was written after the build started.
  Anything else (a failed build, a missing record, Cancel) puts the game's `units.json` back as it was.
- **One bake.** The export bakes each slot with the same code the viewer plays (`src/engine/bake.ts`: speed, blow
  timing, pace, hands, ground, keys, gear tracks; `bakeRide` for a rider), then scales and grounds it into game units.

What the game expects of a unit, each rule in `src/engine/contract.ts` (Ship's checks show them before you export):

- `<models dir>/<unit>.glb`: the mesh named `<unit>`, levels `<unit>_LOD1`, `_LOD2` (default ratios 0.45, 0.15; none
  for a mesh of 60 triangles or fewer), LOD0 within the budget (swapped parts not counted), soles at y = 0, facing +Z,
  a `root` bone above `Hips`, one material `Main` (the game binds its own maps).
- Clips named after the slots the spec lists. `Walk`, `Carry` and `Run` must step (the lesser foot swings at least
  0.12 of the height); `Idle`, `Trade` and `Hunt` must stand (the hips' median at least 0.8 of their rest height); the
  game times hits at 0.45 of an attack.
- Gear: only parts the game built go in (`from: "emberhold:<unit>/<part>"`, brought in by `game_import`), each mesh
  named after its part; a hidden piece stays out unless the game swaps it in by job or look (`Gear*`, `Head*`,
  `Wear*`). A keyed piece gets its own `Prop_<gear>` bone the clips move; a pull handle a `Prop_<gear>_<handle>` bone.
  Clothing and spot parts go as skinned meshes weighted as shown (`tools/lib/gearskin.ts`).
- A companion (a pony beside it, the horse under it) is built the same way under the unit's root, its bones prefixed.
  A rider's horse is the unit's companion with `ridden: true`; his lower body holds the seat while the rest plays his
  slots, the horse's slots fitted to his by whole cycles. The horse's gear (`mount.gear`) has never shipped and still
  doesn't (an open question for the owner).
- The build record (`<work dir>/<unit>/rigsmith.json`, `src/model/unit.ts BuildRecord`): every key the game reads
  (`texture`, the clip names, `companion`) plus, since schema 2, the run token, the slots as baked, the hands and the
  gear ids. The game keeps it as `sources.rigsmith` in the unit's texture provenance.

**The way back:** `tools/game_import.py` brings a unit back from its last build (its slots, hands and the parts it
carries; old builds' clips and scripts read as Rigsmith reads an old character), for a character that lacks them or a
part rebuilt in the game's Blender pipeline. New parts go through the gear upload; the rest is one undoable batch
(`POST /api/characters/:id/restore`, `server/routes/restore.ts`). By default it only adds what is missing;
`--replace` puts the character back as built; `--repivot` moves each game part's origin to where it is held;
`--dry-run` prints the batch.

```bash
npm run export:game -- <spec.json> <models dir> <work dir> [unit ...]                # what the game's build.sh runs
python3 tools/game_import.py ~/dev/games/emberhold [unit ...] [--replace] [--dry-run]  # fill a character from a build
node tools/dev/ground.ts <unit.glb> ...                                              # how far each clip's feet sit off the ground
npm run test:godot -- <models dir>/<unit>.glb                                        # the unit imported in headless Godot
```

## The command line

`tools/rig.ts` reads and changes characters as the app does: reads straight from the workspace (as the current schema, however
old the file), changes as commands through the running server, so open pages update at once and the journal names the
change (signed `agent`; `RIGSMITH_BY` overrides; `RIGSMITH_URL` for another port).

```bash
node tools/rig.ts list                                     # every character: unit, clips, gear, mount
node tools/rig.ts show WHO [--json]                        # slots with adjustments, hands, gear with handles, mount
node tools/rig.ts history WHO [N] | note WHO TEXT...       # the journal; a note in it
node tools/rig.ts get WHO [PATH]                           # the record or a part (clips.Idle.adjustments, mount.pose.Hips)
node tools/rig.ts set WHO FIELD JSON                       # name, joints, markers, boneMap, handPoses, hold, fingers, mount
node tools/rig.ts do WHO COMMANDS | undo WHO [SEQ]         # any commands as one change; take one back
node tools/rig.ts slot WHO SLOT CLIP [speed=1] [loop|once] [inplace|moving]
node tools/rig.ts clips WHO QUERY [category]               # library clips for its rig
node tools/rig.ts ride WHO HORSE|off                       # the app's default seat
node tools/rig.ts render WHO [clips=Idle,Walk] [at=0,.25,.5,.75] [views=right,front] [size=320]
node tools/rig.ts units | unit NAME JSON|null | export UNIT ...
node tools/rig.ts check [UNIT ...]                         # is the game's file what Rigsmith builds now? (npm run verify:units)
```

WHO is an id, a name or a game unit. `render` builds the unit (its filled slots) into `workspace/renders/<id>/` and
draws each clip in Blender (`tools/render.py`). Without a server, these write the workspace directly (each refuses
while a Rigsmith server answers, so that server stays the only writer; `--ignore-server` when the one answering serves
another workspace):

```bash
node tools/apply.ts <id> <commands.json | -> [--by NAME]   # the offline twin of POST /api/characters/:id/commands
node tools/restore.ts <id> <request.json | -> [--dry-run]  # the offline twin of POST /api/characters/:id/restore
npm run migrate [-- --dry-run]                             # every v1 character and settings.json to schema 2
npm run migrate:check [-- --hashes <file>]                 # then check each against its v1 record; no GLB or paint changed
```

The node tools share `tools/lib/node3d.ts` (three's loaders headless, a character's body as the viewer holds it,
`readCharacter` for every character file, the clip source in Node).

## The v1 compatibility layer (deprecated)

The game repo's own scripts (`tools/rigsmith/import_new_units.py`, `import_gear.py`, `stage_new_units.sh`) speak the
schema 1 HTTP API, and the game repo can't be changed from here. So the server keeps a v1 layer (`server/compat.ts`,
`src/model/legacy.ts`) until they are ported:

- `GET /api/characters[/:id]` answer the v1 view unless the request sends `x-rigsmith-schema: 2` (the app and the ported
  tools always do).
- `PATCH /api/characters/:id` takes only `animations`, `scripts`, `garments` and `props` in v1 shape, turned into one
  batch of commands journaled under the caller's `x-rigsmith-by`; any other key answers 410.
- The upload routes keep their paths and query parameters (`POST /api/characters?name=`,
  `POST /api/characters/:id/garments?name=&kind=` with optional `bone=`, `from=`), and `/rig` and `/reimport` too.

Every non-GET request must carry `x-rigsmith: 1` or `x-rigsmith-by: <tool>` (403 otherwise). Port a client by sending
`x-rigsmith-schema: 2`, reading the schema 2 document, and writing through `POST /api/characters/:id/commands`
(`{ commands }`, one undoable entry) or `tools/apply.ts`. Python readers of `character.json` check `schema == 2` and
otherwise ask for `node tools/migrate.ts`. Remove the layer once nothing sends v1.

## Workspace

`workspace/` (gitignored; `RIGSMITH_WORKSPACE` points elsewhere). User data that can't be rebuilt is marked ★; back it
up with `tools/dev/backup_workspace.sh`.

| Path | What it is |
| --- | --- |
| `settings.json` ★ | The game repo and the shared hand poses. |
| `characters/<id>/` ★ | One folder a character: `character.json` (schema 5), `character.v1.json` (the file before migration, kept once), `journal.jsonl`, `source/original.<ext>` (the upload, never deleted), `model.glb` (the normalized import), `rigged.glb` (the live rig), `weight_edits.json` (painted weights, re-applied on every re-rig), `thumbnail.webp`, `textures/` (the composite each image wears; `textures/layers/<id>.png` the look layers), `projections/<id>/` (projection painting captures), `garments/<id>/` (a gear piece's source, model and `weights.json`). |
| `game/` ★ | `units.json` (Rigsmith's unit list), `builds/<unit>.json` (each unit's last export), `export-backup.json` (the game's `units.json` while an export runs). |
| `library/` | The clip library: `clips/<id>.glb` and `manifest.json` (rebuildable), `sources/` ★ (downloaded FBX with hashes, and `custom/` edits), `creatures/<rig>/` ★ (saved creature clips), `mannequin/ybot.glb`, `audit.json`, `verify/`. |
| `trash/` | Deleted characters (`<id>-<when>/`) and gear folders nothing uses: put one back to restore it. |
| `renders/` | `rig.ts render` sheets and `rig.ts check` scratch. |
| `cache/`, `exports/`, `backups/`, `audits/`, `rigdev/`, `scratch/` | Caches; old browser exports (the generic export is gone); hand-made safety copies; evidence from the rigging and naturalization work ([HANDOFF.md](HANDOFF.md)); rig R&D (its `gt/` is hand-made ground truth ★); throwaway scripts. |

## The clip library

```bash
npm run library:sync     # download (about 1.4 GB), checksum-verify and convert all 2,446 named FBXs
npm run library          # rebuild from local sources and cache, no download
npm run library:verify   # every source hash, converted name, skeleton, FPS and frame count
npm run library:runtime  # every clip loaded and retargeted on Y Bot and a local character, and every clip a slot plays
```

Sources come from [Linzhan/Mixamo-Animations-Characters](https://huggingface.co/datasets/Linzhan/Mixamo-Animations-Characters),
pinned to revision `7f134bc734557b1d9516cb476d25ea1f577e45c1` (the full `animation/` folder, static poses included).
Downloads resume and use the publisher's SHA-256 hashes. Files live under
`workspace/library/sources/mixamo-named/animation/`; converted clips have readable names such as
`workspace/library/clips/mixamo-Jab_Cross_2.glb`. `metadata.csv` and `index.json` keep the original Mixamo names,
descriptions and motion ids; `catalog-verification.json` records the full integrity check. Some publisher CSV frame
counts are stale; playback uses the FBX's own timing. The FBXs keep their source terms.

**Made clips** (`blender/clips/`): motions no library has, made by a script from library sources and written into the
library by its own converter (`convert.py convert_clip`, on the source's armature as Blender holds it, so the clip
keeps that source's rest skeleton). Each one's line in `work/sources.json` names its script and inputs; `build.py
convert` remakes it when either changes. `custom-Spear_Thrust` (`spear_thrust.py`): a one-handed underhand thrust
behind a shield, from Stabbing 2 and Sword And Shield Idle 4. Clips saved from the editor are `custom-<Name>`
(`workspace/library/sources/custom/<id>.edit.json`; a creature's as a `.glb` under `library/creatures/<rig>/`).

## Checks

```bash
npm run check            # check:app (svelte-check, errors) and check:tools (tsc -p tools)
npm test                 # vitest: model, engine, server, app rules and tools (the unit export included)
npm run test:python      # blender/autorig, blender/library and tools/skin_opt unittests (.venv)
npm run lint
npm run migrate:check    # every character still means what its v1 record meant
npm run verify:units     # each game unit's file against what Rigsmith builds now
```

How the rig, the weights and Naturalize work, and their own verification scripts (`tools/verify_autorig.py`,
`tools/dev/verify_*.ts`, the Mixamo bench), are in [docs/rigging.md](docs/rigging.md).

## Code layout

```
src/model/      the character document (types.ts), commands and their reducers, migrations, selectors, unit specs
src/engine/     three.js, no DOM (runs headless in Node too): stage, character view, retargeting, the one bake
                (bake.ts, hands.ts, timing.ts, keys.ts), gear placement, pulls, projection painting, the editor's solvers,
                the game contract (contract.ts), GLB chunks (glb.ts), levels (lods.ts)
src/state/      app state (Svelte 5 runes): app.svelte.ts and api.ts (every request), viewer, animator, one module a step
src/app/        the UI: steps/<Step>Panel.svelte and a folder a step; src/ui/ the shared controls
server/         the local API mounted on the Vite server: store (the per-character lock and journal), commands and
                undo, jobs (Blender, Codex, torch, the game build; cancellable), routes/<area>.ts, the v1 layer
blender/        Blender jobs: inspect, auto-rig (landmarks, skeleton, fingers, weights), texture fill and compose,
                library conversion, made clips
tools/          rig.ts, game_import.py, game_export.ts and lib/unit_export.ts, migrate.ts, apply.ts, restore.ts,
                library tools, skin_opt/ (pose-optimized weights), dev/ (diagnostics)
static/         catalog props, creature templates and their clips, bundled human clips, joint ranges
tests/          godot/check_export.gd (a unit GLB in headless Godot)
docs/           animating.md (gear in the clip editor), rigging.md (rigging and naturalization notes), rebuild/
```

## Other tools

**Volume build**: a clean, watertight, evenly sampled stand-in for a character (sparse voxels via
[sparse-cubes](https://github.com/navis-org/sparse-cubes), GPL-3.0, SurfaceNets meshing; under a second a character at
1 cm voxels). **Retopology**: volume build → Instant Meshes
([PyNanoInstantMeshes](https://pypi.org/project/PyNanoInstantMeshes/)) → [xatlas](https://github.com/jpcy/xatlas) UVs
→ colour baked from the original in Cycles → GLB (~8–9 s a character at 8k triangles, 2K texture; uniform quads lose
thin detail at the same budget, so best for messy generator output and for LODs). Neither is part of a step.

```bash
npm run setup:python                                       # once: .venv with sparse-cubes, trimesh, PyTorch
npm run volume -- workspace/characters/<id>/rigged.glb proxy.glb [--voxel 0.01] [--smooth 10]
npm run retopo -- workspace/characters/<id>/model.glb clean.glb [--triangles 8000] [--texture 2048]
```

Started from [Mesh2Motion](https://github.com/scottpetrovic/mesh2motion-app) (MIT code, CC0 assets).
