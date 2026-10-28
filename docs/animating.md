# Animating with gear: Gear, then Motion

How to give a character a piece of gear (a spear, a staff, a bow), say where its hands hold it, then pose and key a
clip with it in the clip editor: both hands on it, the body following it, saved to the slot or as a library clip.

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
here and in the editor, and Ship's checks say the export leaves them out. "Other ways to wear it" (clothing on the
skin, a part pinned to a spot) isn't held by hands and doesn't lead in the editor.

## 2. Its handles (Gear step)

**Handles** say where hands hold a piece. Each has **Its hand**: the hand pose it closes to there (Default fist, Open
for the clip's own hand, one of the character's or the shared hand poses, or a fist from a library clip: Great sword,
Golf club, Holding, Rifle, 2hand idle).

- **Carried** (the carry handle): the hand it rides. Its pose closes that hand in every clip, unless a slot opens it.
  **Held exactly** keeps the hand at its hold in the editor, without slipping along it. Once the editor has put the
  hand somewhere else on it, "Held where the editor put the hand" shows, and **Use its placement** goes back.
- **Grips**: where the other hand holds it. **+ Left hand grip** (or right) makes one where that hand is now (pause a
  clip on a frame where it holds it); the editor also makes one when a free hand goes on the gear. **For** says which
  hand it is for (or either).
- **Pulls**: a point of it another bone draws while a slot holds it (a bowstring). **+ Pull**, then **Drawn by** the
  bone, the hand's pose while it draws, and **Pick its point** on the piece; the strand bends there, and its weights
  (painted below the handles) say which parts follow. **Held in** lists the slots that hold it; when it is held is
  each slot's own (a Handle hold adjustment in Motion).

The **Hands** panel (in Gear and Motion) shows, for the slot playing, each hand's layers bottom to top (what it
carries, what it holds in every clip, a pull being drawn, the slot's own hand poses), which one wins at the playhead and
why. **Held in every clip** there poses a hand whatever it carries.

## 3. Open a clip in the editor (Motion step)

1. Play one of the character's slots (or a library card).
2. **Edit animation:**
   - **Edit as it plays**: the slot with its speed, timing, hands, ground and keys. Saving bakes them in.
   - **Edit the clip alone**: the clip without the slot's speed or adjustments. Saving keeps them on the slot.
   - Or pause on a pose, set a length and **New clip from this frame**.

The badge says what you're editing ("as it plays", "the clip alone", "a new clip") and turns to "unsaved" once you
change something.

**Posing:**

| You want to | Do this |
| --- | --- |
| Pick a frame | Scrub the timeline or click a key's diamond. `,` and `.` step one frame; Space plays and pauses. |
| Select a hidden joint or gear | Choose it in **Target**. |
| Move a joint | Drag its sphere. A hand or foot reaches, its arm or leg follows. Any other joint turns its bone. |
| Crouch or jump | Drag the diamond at the hips up or down. The legs bend, the feet stay on the floor. Shift moves it any way. |
| Use the gizmo | Click a joint. **G** or **Move** moves it; **R** or **Rotate** turns its bone. **Local / World** picks what Rotate turns about. |
| Take keys off | **Delete keys here** (or Delete): the selected joint's at this frame, or every joint's with nothing selected. **Clear all keys** takes them all. **Esc** deselects. |
| Undo | **Ctrl+Z**, **Ctrl+Shift+Z** to redo: every pose change, key and grip in this edit. |

Letting go keys only what you moved, at that frame. A joint's first key also pins it at the clip's ends, so the change
eases in and out. **Joint limits** keeps poses within the rig's range of motion. **Loop** is in the timeline. Choose
In place and Mirror before editing: the frame your keys and grips were made against stays fixed while the editor is
open.

## 4. Make the gear lead

1. **Click the gear** in the viewport (or pick it in Target). Its box opens.
2. Turn on **Leads the body**. Its path is fitted to the body once over the whole clip (it can take a few seconds): it
   moves a little, for example farther from the body, so the hands can hold it with room to spare. The body now
   follows it: the hands on it follow its path, the body follows the hands, and the body keeps clear of it.
3. **Move or turn it with its gizmo** to key its path:
   - **Move entire path** off: the move keys this frame only.
   - **Move entire path** on: the move shifts the whole path, every frame (hold it farther to the right all through).
   - **Moves in the hand** on: dragging it moves it where the hand holds it, and whatever holds it stays. Then **In
     every clip** changes its placement (as Gear does); off, this frame only, tweened between keys.

Moving it away from the body doesn't pull the body after it: the arms reach out.

## 5. Put the hands on it

The gear's box has a row for each hand that carries it or holds it.

**Put a hand on:** drag a free hand onto the shaft and let go. Within about a tenth of the body's height it snaps on at
the nearest spot, the fist squarely round the shaft, a hand's width from the other hand, and a grip handle is made
there. Or pick one of its grips in that hand's handle list ("Not on it" takes the hand off; for the carrying hand, "As
placed" goes back to the Gear placement).

**Adjust a grip:** click the hand. Its gizmo sits where it grips, lined up with the gear.
- **Red** runs along the gear: drag it to slide the grip up or down the shaft.
- **Green** is up across it, **blue** is sideways.
- **Rotate** turns the hand any way about its grip, for example to lay the palm flat on the shaft.

Letting go saves the grip handle exactly where the hand is, on every frame. This works for the carrying hand too when
the gear leads: its carry handle moves on the gear, and the gear stays on its path. **Exactly here** keeps a hand on
that spot (no give or slide along the shaft); the trash button removes the grip handle from the gear.

**Hand pose:** each hand's picker sets how its fingers close on the gear (Great sword fits a spear's shaft best). For
the carrying hand it is the carry handle's pose, in every clip; for a gripping hand, its pose in this slot. For the
carrying hand, **Opens in <slot>** sets where in this slot it lets go (a bow released); a pull's row has its pose while
drawing and **Held in <slot>**, where in this slot the pull is held. Those windows are the slot's, so they can be
changed only while editing a slot as it plays.

Handles and hand poses are the character's, for every clip, and change at once (each is in the journal). Finishing
with unsaved edits asks first and offers to undo the handle changes made during the edit.

At extremes, such as a fast strike, a hand turns in its grip and slides along the shaft a little (at most about a
centimetre a frame) rather than bend its wrist far. The head keeps looking where the clip looks.

## 6. Naturalize, then save

- **Naturalize** edges every frame toward how people move and smooths the motion. The hands stay on the gear, and the
  frames you keyed stay near where you put them. Each press (**Naturalize again**) goes a little further; "Ready to
  save" shows when it is done. Do it when the clip is mostly right: any change after it builds the clip again from
  your keys. Captured stretches and crossed-arm movements keep their own elbow freedom; the solver corrects extra
  elbow bow your edits added. **Cancel naturalization** keeps your previous edit.
- Free fingers get a contact pass that checks the actual skinned hand, including surfaces buried inside it (how it
  works: [rigging.md](rigging.md#the-finger-contact-pass)). Hands carrying gear, saved fists, hands held in every clip
  and explicitly keyed fingers keep their poses. This pass can take longer on detailed hands.
- **Save to <slot>**: the slot plays the edit as a new clip (one you made before that only this slot plays is saved
  over; one another slot uses is never changed). As it plays: its speed, timing and bone keys are baked in, the ground
  stays an adjustment, the gear's path becomes the slot's gear keys, and its hand poses and holds stay. The clip alone:
  its speed and adjustments stay as they were.
- **Save as a library clip**: a copy under Library → Custom, in the category of the clip it came from; the slot is
  unchanged. A leading gear's path is saved with it (by the gear's name): a slot it fills on a character with gear of
  that name gets that path as gear keys, which the game export plays.
- **Finish** closes the editor (asking first when there are unsaved edits).

## Good to know

- **The game holds the gear by its Gear placement, moved by the slot's gear keys.** Keys are relative to that
  placement, so changing the placement in Gear afterwards moves the gear in every clip that keys it.
- **Adjustments** (Motion, under each slot): ground (Auto stands it on the floor by its flat feet), blow timing, pace,
  hand pose, handle hold and keys, each switchable, applied in a fixed order whatever their order in the list. The
  timeline shows the playing slot's as lanes. Keys you add there (pause, drag the gizmo, let go) are the same keys the
  editor bakes.
- **Slow steps:** turning Leads on fits the whole clip; Naturalize solves every frame and shows progress. Raised feet
  don't count as ground support, and a solve that loses hand targets or floor clearance leaves the previous edit in
  place.
- **A one-handed clip made two-handed** (Spear Thrust) turns the body side-on at the strike to get the front hand
  forward. That's the solver keeping both hands on the spear at the clip's own speed.
- **Reload after Rigsmith updates.** An editor already open keeps its old code: reload the page (Ctrl+Shift+R) and
  open the clip again.
