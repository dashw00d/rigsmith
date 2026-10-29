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
