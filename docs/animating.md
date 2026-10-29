# Animating with gear: Gear, then Motion

How to give a character a piece of gear (a spear, a staff, a bow), say where its hands hold it, then pose and key a
clip with it in Motion: both hands on it, the body solved to it when you ask, saved as the clip the game plays.

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

## 3. Pose and key a clip (Motion step)

There is no editor to open: the clip playing **is** what you edit. Click a clip in **Clips** to play it; the timeline
docks under the viewport and the joints show on the character.

| You want to | Do this |
| --- | --- |
| Pick a frame | Click or drag the ruler (Alt: between frames), type a frame, `,` `.` or `←` `→` (Shift: 10), `↑` `↓` the previous / next key. Space plays and pauses. |
| Move a joint | Drag its dot. A hand or foot reaches, its arm or leg follows; any other joint turns its bone. Letting go keys every bone the drag moved, on that frame. |
| Crouch or jump | Drag the diamond at the hips up or down (the feet stay). Shift: any way. |
| Use the gizmo | Click a joint. `G` moves it, `R` turns its bone; Local / World in the toolbar. |
| Key a joint as it is | `K`, or the **+** on its timeline row. |
| Solve the body | **Solve body** (`B`): on the frame shown, arms are pushed out of the body, then the body is fitted to the hands on gear. It keys what it moved. |
| Smooth the whole clip | **Naturalize**: every frame edged toward how people move, the hands kept on gear, your keys held near; it keys every frame it moved (press again to go further). |
| Undo | `Ctrl+Z`, `Ctrl+Shift+Z` to redo: the character's own history (Activity), so every key, grip and timing change is one step. |
| Keep it | Nothing to save: every change is in the clip already, and the game gets it on Ship. **Save as** copies the clip playing over another (Attack, Run, a trial, or a new name), replacing what that one played. |

Dragging moves only what you drag; hands on gear follow by IK, and the body is never solved while you drag ("the
solver needs to run when you ask it to"). A joint's first key also pins it at the clip's ends, so the change eases in
and out. **Joint limits** (in the inspector) keeps poses within the rig's range of motion. Keys sit on moments of the
clip's own motion: change the speed, the blow fit or the timing, and they stay on the same moment.

## 4. The timeline

Under the ruler, one row per track:

- **Summary**: every key. **Body**: limb groups (open one with its arrow; **all** shows its unkeyed bones), opening
  to bones; selecting a joint in the viewport opens its row. **Gear**: each piece's keys (and, once the gear area's
  strips land, who holds it and when it shows). **Hands and pulls**: each hand pose, pull held and hand kept on a
  handle as a bar: drag it, or its ends, to change when. **Events**: the clip's named moments. **Time**: the clip's
  speed, retime markers (drag to speed up or slow down round them; **+** adds one at the playhead), holds (**hold**
  adds one; drag its end to hold longer) and the hit (drag it to pick the blow; with the blow fit on, the clip is cut
  so it still lands where the game times hits).
- The eye on a row switches that track off (kept, not played).
- Each key's span to the next is drawn as its easing: thin line smooth, solid linear, dashed eases, a step, or a thick
  bar where the clip is held.

| Keys | |
| --- | --- |
| Select | Click; Shift+click adds, Ctrl+click toggles; drag a box over empty lanes (across rows); `Ctrl+A` all; `Esc` none |
| Move | Drag a selected key (snaps to frames; Alt: free), or type **At frame** in the inspector |
| Stretch | Drag the pink ends of the selection on the ruler. **Stretching retimes the clip** (inspector) retimes the motion under the keys instead (retime markers) |
| Duplicate, copy, paste | `Ctrl+D` (just after the selection), `Ctrl+C` / `Ctrl+V` (at the playhead, this clip or another) |
| Delete | `Delete`: keys, events, hand bars, markers and holds selected |
| Zoom | `Ctrl`+wheel (or the wheel over the ruler); Shift+wheel scrolls; `F` fits, `Shift+F` fits the selection |
| Loop a part | Shift+drag the ruler, or `[` and `]` at the playhead; `\` clears it |
| Preview into Idle | The **Idle** button (a clip that plays once): the clip, then the character's Idle blended in over 0.2 s as the game does |

Loop, mirror and the speed menu at the right are the preview's only: nothing they change is saved.

## 5. Make the gear lead

1. **Click the gear** in the viewport (or its name in the Gear rows). Its box opens in the inspector.
2. Turn on **Leads the body**. Its path is fitted to the body once over the whole clip (it can take a few seconds):
   it moves a little so the hands hold it with room to spare. The hands on it follow its path.
3. **Move or turn it with its gizmo** to key its path:
   - **Move entire path** off: a key on this frame. On: the whole path moved by it, every frame.
   - **Moves in the hand** on: it moves where the hand holds it, whatever holds it stays. Then **In every clip**
     changes its placement (as Gear does); off, this frame only, tweened between keys.

Without leading, moving it keys its move in the hand. Moving it away from the body doesn't pull the body after it.

## 6. Put the hands on it

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

## 7. Save as

**Save as** (the inspector): choose the clip the game plays (Attack, Run...), a trial, or **A new clip…** by name. The
clip playing, with its timing, keys, hands on gear and events, is copied over it (what it had goes; Ctrl+Z brings it
back), and plays from then on. Nothing new is written to the library: the clip stays the library clip it was, with your
changes on top, exactly as the game will play it.

## 7. Change hands, hide it (Motion step, the Gear track)

Each piece has a **Held by** strip and a **Shown** strip under its keys in the timeline, so a clip can draw a sword
from the back, throw a javelin and have it gone, or pick a tool up.

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

**Variants:** **+ variant** on one of the game's clips (Attack, Die...) copies it as `Attack 2` (then `Attack 3`...) and
plays it to change. The game gets it as `Attack_2` and picks one of them at random each time; remove the slot to drop
it.

## 8. Pose tools (the timeline's toolbar)

They work at the playhead (on its frame), on the bones whose Body tracks are selected, or on every bone with none
selected. Each is one change in Activity (one Undo).

| Tool | What it does |
| --- | --- |
| **Copy pose** (Ctrl+Shift+C, or Ctrl+Alt+C) | Takes the pose as the slot shows it at the playhead, and the Hips' height. It stays copied when you play another clip or character. |
| **Paste** (Ctrl+Shift+V) | Keys the copied bones so the slot shows that pose at the playhead, whatever the clip does there. The Hips get the copied height, not where the body stood, so a walk isn't pulled back. A bone's first key also pins it at the clip's ends. |
| **Paste mirrored** (Ctrl+Alt+V) | The same with left and right swapped and each turn reflected across the body's middle: a left-arm raise pasted mirrored is the same raise on the right arm, and a twist to the left becomes a twist to the right. |
| **Tween / Push / Relax** slider | **Tween** keys the selected bones (or every keyed bone) between the keys either side of the playhead: left is the previous key, right the next. **Push** moves the pose away from the plain inbetween of those keys (more of it). **Relax** moves it toward that inbetween (smoother). The character shows it as you drag; letting go keys it, and Esc cancels. |
| **Onion skins** (Alt+O) | Ghost skeletons before (orange) and after (blue) the playhead, every few frames or at the keys around it. Set the counts in its menu; the settings are remembered. |
| **Ease** | For the selected keys, how the span to the next key tweens: Smooth (the default), Linear, Ease (stops at both keys), Step (holds, then jumps) or Hold (the clip's own motion stopped on the bone until the next key). |
| **Range edit** | Box-select keys across a range and **Set range**. Then change the pose at a frame inside it (drag, paste, tween) and **Spread change**: what changed at the playhead since the range was set reaches the whole range, all of it at the playhead and none at the ends, with a **Smooth** or **Linear** falloff. Outside the range nothing changes. |
| **Seam** (loops) | Shows how far the last frame jumps to the first, by the worst bone. **Match ends** keys the last frame to the first. **Blend** takes half the jump off each side of the seam over N frames, so the loop meets in the middle without stopping. |

Keys are stored on the source clip's moments, so a later change of timing (speed, fit, markers) keeps them on the same
part of the motion.

## 7. Events: hits, sounds, steps (Motion step)

The **Events** track under the timeline names moments of a clip for the game: **hit** (the blow lands; the game deals
its damage there and fits the Attack's speed to it), **release** (the arrow or javelin flies from its bone), **swing**,
**draw** (a span), **step.L** and **step.R**, or a name of your own (it is kept for the character: typed again in
another clip, it is the same name, with the same sound).

- **Add** puts one at the playhead; double-click a row to add that name there. **Add footsteps** lays a step wherever
  a foot comes down in the clip as it plays.
- Click to select (Shift adds, Ctrl toggles); drag to move on frames (Alt: free); drag a span's ends; Delete removes.
  While the blow timing measures the hit, it shows hollow: moving it (or typing its frame) picks it by hand.
- In the inspector: its frame, its **sound** (one of the game's, each with a play button, or drop a WAV, OGG or MP3
  file on it: kept with the character and installed in the game when the unit is exported), volume, pitch, and the
  bone it happens at (a release: where the projectile leaves).
- While the clip plays you hear each event's sound and see its name over the character; scrubbing blips. Each row's
  speaker mutes it in the preview only: the game gets every event.

Events are stored on the source clip, so retiming the clip never moves them; the game reads them from the unit's
`<unit>.events.json` beside its model.

## Good to know

- **The game holds the gear by its Gear placement, moved by the slot's gear keys** (and, leading, by its path).
  Changing the placement in Gear afterwards moves the gear in every clip that keys it.
- **Settings** (Motion, under the inspector): ground (Auto stands it on the floor by its flat feet), blow timing,
  pace, hand poses and handle holds, each switchable, applied in a fixed order.
- **What you see is what ships.** The viewer, the timeline and the game export bake a clip the one way (hands kept on
  gear included), so the shown clip is the exported one.
- **Slow steps:** turning Leads on fits the whole clip; Naturalize solves every frame and shows progress (Cancel stops
  it, nothing keyed).
- **A one-handed clip made two-handed** (Spear Thrust) turns the body side-on at the strike to get the front hand
  forward: Solve body on the strike frame.
