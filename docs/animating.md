# Animating with gear: Gear, then Motion

How to give a character a piece of gear (a spear, a staff, a bow), say where its hands hold it, then pose and key a
clip with it in Motion: both hands on it, the body solved to it when you ask, its events and sounds named, saved as the
clip the game plays.

## 1. Put the gear on the character (Gear step)

1. **Gear → Catalog** for a bundled weapon, shield or tool, or **Upload** for your own model (FBX, GLB, OBJ, DAE or a
   ZIP). Wait for an upload to finish importing.
2. **Click it in the list.** **Held by** is the bone it rides, usually `RightHand`. On a hand it gets its carry handle
   (see below); moving it to the other hand carries it across, held the same way.
3. **Pose:** look at it at Rest, "Rest, fists closed", or in one of the character's clips paused on a frame (Space
   plays and pauses; `,` and `.` step).
4. **Place it in the hand** with the gizmo, or type the position, rotation and scale. Turn it so the shaft runs
   through the closed fist.

This placement is the gear in every clip and in the game: the export attaches it to that bone exactly as it sits here.
Only parts the game built go into the game (brought in by `tools/game_import.py`); catalog gear and your uploads show
here and in Motion, and Ship's checks say the export leaves them out. "Other ways to wear it" (clothing on the
skin, a part pinned to a spot) isn't held by hands and doesn't lead.

## 2. Its handles (Gear step)

**Handles** say where hands hold a piece. Each has **Its hand**: the hand pose it closes to there (Default fist, Open
for the clip's own hand, one of the character's or the shared hand poses, or a fist from a library clip: Great sword,
Golf club, Holding, Rifle, 2hand idle).

- **Carried** (the carry handle): the hand it rides. Its pose closes that hand in every clip, unless a slot opens it.
  **Held exactly** keeps the hand at its hold, without slipping along it. Once Motion has put the hand somewhere else on
  it, "Held where the editor put the hand" shows, and **Use its placement** goes back.
- **Grips**: where the other hand holds it. **+ Left hand grip** (or right) makes one where that hand is now (pause a
  clip on a frame where it holds it); Motion also makes one when a free hand is let go on the gear. **For** says which
  hand it is for (or either).
- **Pulls**: a point of it another bone draws while a slot holds it (a bowstring). **+ Pull**, then **Drawn by** the
  bone, the hand's pose while it draws, and **Pick its point** on the piece; the strand bends there, and its weights
  (painted below the handles) say which parts follow. **Held in** lists the slots that hold it; when it is held is
  each slot's own (a bar in the timeline's Hands track).

The **Hands** panel (in Gear and Motion) shows, for the slot playing, each hand's layers bottom to top (what it
carries, what it holds in every clip, a pull being drawn, the slot's own hand poses), which one wins at the playhead and
why. **Held in every clip** there poses a hand whatever it carries.

## 3. The Motion step

There is no editor to open: the clip playing **is** what you edit. **Clips** lists the game's clips (each with its
variants under it), then your trials; click one to play it. The timeline docks under the viewport (drag its top edge
to make it taller), the joints show on the character, and the inspector beside it shows what is selected: keys, a
joint, a piece of gear, events, a hand bar, a strip of the Gear track. **Settings** under it holds the slot's ground,
blow timing, pace, hand poses and handle holds.

Every change is in the clip at once and is one step of the character's history: `Ctrl+Z` undoes it, `Ctrl+Shift+Z`
redoes. Nothing needs saving; the game gets it on Ship.

## 4. Pose and key

| You want to | Do this |
| --- | --- |
| Pick a frame | Click or drag the ruler (Alt: between frames), type a frame, `,` `.` or `←` `→` (Shift: 10), `↑` `↓` the previous / next key. Space plays and pauses. |
| Move a joint | Drag its dot. A hand or foot reaches, its arm or leg follows; any other joint turns its bone. Letting go keys every bone the drag moved, on that frame. |
| Crouch or jump | Drag the diamond at the hips up or down (the feet stay). Shift: any way. |
| Use the gizmo | Click a joint. `G` moves it, `R` turns its bone; Local / World in the toolbar. |
| Key a joint as it is | `K`, or the **+** on its timeline row. |
| Solve the body | **Solve body** (`B`): on the frame shown, arms are pushed out of the body, then the body is fitted to the hands on gear. It keys what it moved. |
| Smooth the whole clip | **Naturalize**: every frame edged toward how people move, the hands kept on gear, your keys held near; it keys every frame it moved (press again to go further; Cancel stops it, nothing keyed). |

Dragging moves only what you drag; hands on gear follow by IK, and the body is never solved while you drag. A joint's
first key also pins it at the clip's ends, so the change eases in and out. **Joint limits** (in the inspector) keeps
poses within the rig's range of motion. Keys sit on moments of the clip's own motion: change its speed, blow timing or
retime markers and they stay on the same moment.

## 5. The timeline

Under the ruler, one row per track; the eye on a row switches that track off (kept, not played).

- **Clip**: what the clip is built from (§5a), its length (type one), and **+** to append another clip.
- **Summary**: every key. **Body**: limb groups (open one with its arrow; **all** shows its unkeyed bones), opening
  to bones; selecting a joint in the viewport opens its row.
- **Gear**: each piece's keys, and under them its **Held by** and **Shown** strips (§8).
- **Hands and pulls**: each hand pose, pull held and hand kept on a handle as a bar: drag it, or its ends, to change
  when.
- **Events**: the clip's named moments, a row per name (§9).
- **Time**: the clip's speed, retime markers (drag to speed up or slow down round them; **+** adds one at the
  playhead), **insert** (half a second of the pose at the playhead held there, to key: §5a) and the hit (drag it to
  pick the blow; with the blow timing on, the clip is cut so it still lands where the game times hits).

Each key's span to the next is drawn as its easing: thin line smooth, solid linear, dashed eases, a step, or a thick
bar where the clip is held.

**Editing what is selected.** Keys and events are selected together and go together:

- **Select**: click; Shift+click adds, Ctrl+click toggles; drag a box over empty lanes, across rows (keys and events);
  `Ctrl+A` every key; `Esc` none.
- **Move**: drag a selected key (on frames; Alt: free), `Ctrl+←` `Ctrl+→` a frame (Shift: 10), or type **At frame** in
  the inspector. The selected events move with the keys.
- **Stretch**: drag the pink ends of the selection on the ruler. **Stretching retimes the clip** (inspector) retimes the
  motion under the keys instead (retime markers).
- **Duplicate** (`Ctrl+D`, just after the selection), **copy** and **paste** (`Ctrl+C`, `Ctrl+V` at the playhead, in this
  clip or another).
- **Delete**: keys, events, hand bars, markers, pieces of the clip and the Gear strips' switches and hidden spans
  selected.

**Seeing it.** `Ctrl`+wheel zooms (or the wheel over the ruler), Shift+wheel scrolls; `F` with the pointer over the
timeline fits the clip, `Shift+F` the selection (elsewhere `F` frames the character). **Loop a part**: Shift+drag the
ruler, or `[` and `]` at the playhead; `\` clears it. **Idle** (on a clip that plays once) previews it into the
character's Idle, blended in over 0.2 s as the game does. Loop, mirror and the speed menu at the right are the
preview's only: nothing they change is saved.

## 5a. Longer clips, combined clips (the Clip strip)

A clip can be built from **pieces** played one after another: a part of a library clip, a part of another of the
character's clips **as it plays** (its timing and keys: combine with an edited Attack), or a **held pose** (the pose
where the piece before ends, held: real time you pose and key like any other). Neighbours cross-fade, and each piece
walks on from where the one before left off, facing the same way, so the character never jumps back.

| You want to | Do this |
| --- | --- |
| Make the clip longer | Drag the bright grip at the strip's right end (or its left, for time before it), or type a length beside **Clip**. The extra time is the last pose held: key a pose in it. Dragging inward cuts the clip shorter. |
| Put time in the middle | Put the playhead there, then **insert** in the Time row: the piece is split and half a second held between its parts. Drag the held piece's ends to hold longer. |
| Add another clip after it | **+** beside Clip: pick one of the character's clips, or search the library, then the part of it (seconds) and the blend. |
| Trim a piece | Drag its ends (Alt: free of frames). A piece trimmed shorter can be let out again up to its clip's length. |
| Blend two pieces | Drag the diamond on the later one's top left: how long it cross-fades in (0: a cut). |
| Reorder | Drag a piece by its middle past another. |
| Remove a piece | Click it, then the cross on it (or Delete). |

A selected piece shows in the inspector: what it plays, the part of it (typed in seconds), its blend.

**Keys stay on their piece.** Keys, events, hand bars and the Gear strips belong to the piece they were made on:
trimming, blending or reordering pieces never slides them, and a piece removed (or a part trimmed off) takes what was
keyed on it along (`Ctrl+Z` brings it back). With the blow timing on, lengthening or shortening the clip keeps its start
and its hit where they are (the hit is set by hand then, so a longer clip can't find another one) and moves where the
game times the hit to match.

The game gets the clip as built: nothing is written to the library, and Ship exports it the same way.

## 6. Make the gear lead

1. **Click the gear** in the viewport (or its name in the Gear rows). Its box opens in the inspector.
2. Turn on **Leads the body**. Its path is fitted to the body once over the whole clip (it can take a few seconds):
   it moves a little so the hands hold it with room to spare. The hands on it follow its path.
3. **Move or turn it with its gizmo** to key its path:
   - **Move entire path** off: a key on this frame. On: the whole path moved by it, every frame.
   - **Moves in the hand** on: it moves where the hand holds it, whatever holds it stays. Then **In every clip**
     changes its placement (as Gear does); off, this frame only, tweened between keys.

Without leading, moving it keys its move in the hand. Moving it away from the body doesn't pull the body after it.

## 7. Put the hands on it

**Put a hand on:** drag a free hand onto the shaft and let go. Within about a tenth of the body's height it snaps on at
the nearest spot, the fist round the shaft, a hand's width from the other hand: a grip handle is made there (the
character's, every clip) and this clip keeps the hand on it by IK (its bar in the Hands track; drag its ends to hold it
only part of the clip). Or pick a grip in that hand's list in the gear's box ("Not on it" lets go).

**Adjust a grip:** click the hand. Its gizmo sits where it grips, lined up with the gear: **red** slides it along the
shaft, **green** and **blue** across; **Rotate** turns the hand about its grip. Letting go moves the grip handle there,
every frame. **Exactly here** keeps a hand on that spot; the trash button removes the grip.

**Hand pose:** each hand's picker sets how its fingers close on the gear. Where it is set is said beside it (the
carry handle's for every clip, the grip's, or this clip's own).

When an arm can't reach its grip (a spear thrust out past it), press **Solve body** on that frame: the body turns and
leans so both hands hold it, and those joints are keyed there.

## 8. Change hands, hide it (the Gear track)

Each piece's **Held by** and **Shown** strips let a clip draw a sword from the back, throw a javelin and have it gone,
or pick a tool up.

- **Change hands:** put the playhead where it changes hands and press the scissors on Held by (or **Change hands at
  frame N** in the inspector). The strip splits; pick the new segment and choose who holds it from there:
  - **a hand on one of its handles** (Left hand on Front grip): the hand takes it where the handle says;
  - **as placed in Gear**, on its own bone (sheathed again, back exactly where Gear puts it);
  - **a bone, where it is**: it changes hands without a pop, staying where it was at that frame and riding the new
    bone from then on. **Pin this place** keeps that spot even if the timing changes later.

  **No pop** on a segment says the same: on, it takes the piece where it is; off, by its handle, its placement or the
  pinned spot. Drag a boundary to move the switch (frames; Alt between them); the trash button or Delete hands it back
  to the holder before. The first segment is its Gear bone unless you set who holds it from the start.
- **Hide it:** put the playhead where it goes and press the eye on Shown (**Hide from frame N**): it is hidden from
  there to the next hidden span or the end. Press it inside a hidden span to show it again from there. Drag a span, or
  its edges; Delete or the trash button shows it again.
- **Plays in this clip** (the inspector) switches the piece's whole track off without losing it.

The piece never changes parents: the game gets it on its own `Prop_<piece>` bone under its Gear bone, moved to wherever
the holder has it, and sized to 0 while hidden. The unit's events file also tells the game `hide:<mesh>` /
`show:<mesh>` and `detach:<mesh>` / `attach:<mesh>` (with the bone) at each change, so it can spawn the thrown javelin or
play a sound.

## 9. Events: hits, sounds, steps

The **Events** track names moments of a clip for the game: **hit** (the blow lands; the game deals its damage there and
fits the Attack's speed to it), **release** (the arrow or javelin flies from its bone), **swing**, **draw** (a span),
**step.L** and **step.R**, or a name of your own (kept for the character: typed again in another clip, it is the same
name, with the same sound).

- **Add** puts one at the playhead; double-click a row to add that name there. **Add footsteps** lays a step wherever
  a foot comes down in the clip as it plays.
- Drag one to move it (on frames; Alt: free), a span by its ends. While the blow timing measures the hit, it shows
  hollow: moving it (or typing its frame) picks it by hand. Selected with keys, events move, duplicate, copy, paste and
  delete with them (§5).
- In the inspector: its name, frame (a span's frames, **Lasts** to make it one), its **sound** (one of the game's, each
  with a play button, or drop a WAV, OGG or MP3 file on it: kept with the character and installed in the game when the
  unit is exported), volume, pitch, and the bone it happens at (a release: where the projectile leaves).
- While the clip plays you hear each event's sound and see its name over the character; scrubbing blips. Each row's
  speaker mutes it in the preview only: the game gets every event. The eye on the Events row switches them all off,
  for the game too.

The game reads them from the unit's `<unit>.events.json` beside its model.

## 10. Pose tools (the timeline's toolbar)

They work at the playhead (on its frame), on the bones whose Body tracks are selected, or on every bone with none
selected. Each is one step of the history.

| Tool | What it does |
| --- | --- |
| **Copy pose** | The pose as the slot shows it at the playhead, and the Hips' height. It stays copied when you play another clip or character. |
| **Paste** | Keys the copied bones so the slot shows that pose at the playhead, whatever the clip does there. The Hips get the copied height, not where the body stood, so a walk isn't pulled back. |
| **Paste mirrored** | The same with left and right swapped and each turn reflected across the body's middle: a left-arm raise becomes the same raise on the right arm. |
| **Tween / Push / Relax** slider | **Tween** keys the bones between the keys either side of the playhead (left the previous key, right the next). **Push** moves the pose away from the plain inbetween of those keys, **Relax** toward it. The character shows it as you drag; letting go keys it, Esc cancels. |
| **Onion skins** | Ghost skeletons before (orange) and after (blue) the playhead, every few frames or at the keys round it. The counts are in its menu, and remembered. |
| **Ease** | For the selected keys, how the span to the next key tweens: Smooth (the default), Linear, Ease (stops at both keys), Step (holds, then jumps) or Hold (the clip's own motion stopped on the bone until the next key). |
| **Range edit** | Box-select keys across a range and **Set range**. Change the pose at a frame inside it (drag, paste, tween), then **Spread change**: what changed at the playhead since the range was set reaches the whole range, all of it at the playhead and none at the ends, with a **Smooth** or **Linear** falloff. |
| **Seam** (loops) | How far the last frame jumps to the first, by the worst bone. **Match ends** keys the last frame to the first; **Blend** takes half the jump off each side over N frames, so the loop meets in the middle without stopping. |

## 11. Save as, variants

**Save as** (the inspector): choose the clip the game plays (Attack, Run...), a trial, or **A new clip…** by name. The
clip playing, with its timing, keys, hands on gear, gear strips and events, is copied over it (what it had goes; `Ctrl+Z`
brings it back), and plays from then on. Nothing new is written to the library: the clip stays the library clip it was,
with your changes on top, exactly as the game will play it.

**+ variant** (beside Attack and Die in Clips) copies the clip as `Attack 2` (then `Attack 3`...) and plays it to
change. The game gets it as `Attack_2` and picks one of them at random for each attack (or death); remove the slot to
drop it.

## 12. Every shortcut

Not while typing in a field. Mouse: Alt while dragging leaves the frames (free); Shift+click adds, Ctrl+click toggles.

| Keys | What they do |
| --- | --- |
| `Space` | Play, pause |
| `,` `.` or `←` `→` (Shift: 10) | Previous / next frame |
| `↑` `↓` | Previous / next key (of the selection's tracks, else every track) |
| `Home` `End` | First / last frame |
| `[` `]`, `\` | Loop region start / end at the playhead; clear it |
| `F`, `Shift+F` | Over the timeline: fit the clip, fit the selection. Elsewhere `F` frames the character |
| `Ctrl`+wheel, `Shift`+wheel | Zoom the timeline (the wheel alone over the ruler), scroll it |
| `G`, `R` | The gizmo moves the joint, turns its bone |
| `K` | Key the selected joint as it is |
| `B` | Solve body on this frame |
| `Ctrl+A`, `Esc` | Select every key; select nothing (then: no joint) |
| `Ctrl+←` `Ctrl+→` (Shift: 10) | Nudge the selection (keys and events) a frame |
| `Ctrl+D` | Duplicate the selection just after itself |
| `Ctrl+C`, `Ctrl+V` | Copy the selection (keys and events), paste it at the playhead |
| `Delete` or `Backspace` | Delete what is selected |
| `Ctrl+Z`, `Ctrl+Shift+Z` or `Ctrl+Y` | Undo, redo |
| `Ctrl+Shift+C` (or `Ctrl+Alt+C`) | Copy pose |
| `Ctrl+Shift+V`, `Ctrl+Alt+V` | Paste pose, paste it mirrored |
| `Alt+O` | Onion skins on, off |
| `Esc` while the tween slider drags | Cancel the tween |

Browsers may keep `Ctrl+Shift+C` for their inspector: `Ctrl+Alt+C` is the same.

## Good to know

- **The game holds the gear by its Gear placement, moved by the slot's gear keys** (and, leading, by its path).
  Changing the placement in Gear afterwards moves the gear in every clip that keys it.
- **What you see is what ships.** The viewer, the timeline and the game export bake a clip the one way (hands kept on
  gear included, pieces composed), so the shown clip is the exported one.
- **Settings** (Motion, under the inspector): ground (Auto stands it on the floor by its flat feet), blow timing,
  pace, hand poses and handle holds, each switchable, applied in a fixed order.
- **Slow steps:** turning Leads on fits the whole clip; Naturalize solves every frame and shows progress.
- **A one-handed clip made two-handed** (Spear Thrust) turns the body side-on at the strike to get the front hand
  forward: Solve body on the strike frame.
