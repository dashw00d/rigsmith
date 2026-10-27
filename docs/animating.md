# Animating with props: Outfit, then Animate

How to give a character a prop (a spear, a staff, a polearm), then pose and key a clip with it in the animation
editor: both hands on it, the body following it, saved as a new library clip.

## 1. Put the prop on the character (Outfit step)

The animation editor works with **your own meshes set to Rigid** (Outfit → "Your clothes and accessories"). Catalog
props under "Attached" are bone attachments for the export only: the editor doesn't see them.

1. **Outfit → Your clothes and accessories → Add.** Pick the prop's file (FBX, GLB, glTF, OBJ, DAE or a ZIP).
   Wait for it to finish importing.
2. **Click it in the list** to fit it, and set it to **Rigid**.
3. **Attached to:** the hand that carries it, usually `RightHand`.
4. **Pose:** pick "Rest, fists closed" or one of the character's clips, and pause on a frame.
5. **Place it in the hand** with the gizmo, or type the position, rotation and scale. Rotate it so the shaft runs
   through the closed fist.
6. Press **Done**.

This placement is the prop in the game: the export attaches it to that bone exactly as it sits here. It is also how
the carrying hand holds it in every clip until you change that hand's grip in the editor (step 4 below).

## 2. Open a clip in the editor (Animate step)

1. Play a library clip on the character (for a spear: Spear Thrust).
2. **Edit animation → Edit &lt;clip&gt;.** The timeline starts empty: the clip plays as it is until you key something.
   Or pause on a pose and use **New clip from this frame** with a length.

**Posing:**

| You want to | Do this |
| --- | --- |
| Pick a frame | Scrub the timeline, or press `,` and `.` to step a frame. The playhead snaps to frames. |
| Move a joint | Drag its sphere. A hand or foot reaches, its arm or leg follows. Any other joint swings its bone. |
| Crouch or jump | Drag the diamond at the hips up or down. The legs bend, the feet stay on the floor. Shift moves it any way. |
| Use the gizmo | Click a joint. **G** or **Move** moves it along an arrow or a plane; **R** or **Rotate** turns its bone. **Own axes / World** picks what Rotate turns about. |
| Delete keys | **Delete** removes the keys at this frame: the selected joint's, or every joint's with nothing selected. **Esc** lets go of the selection. |

Letting go keys only what you moved, at that frame. A joint's first key also pins it at the clip's ends, so the
change eases in and out. **Human joint ranges** keeps every joint within what a person can do; **Loops** says
whether the clip loops.

## 3. Make the prop lead

1. **Click the prop** in the viewport. Its panel opens.
2. Turn on **Leads (the body follows it)**. The prop's path is fitted to the body once over the whole clip (about
   10 seconds): it moves a little, for example farther from the body, so the hands can hold it with room to spare.
   The body now follows the prop: the hands on it follow its path, the body follows the hands, and the body keeps
   clear of it.
3. **Move or turn the prop with its gizmo** to key its path:
   - **Move every frame off:** the move keys this frame only.
   - **Move every frame on:** the move shifts the whole path, every frame (for example, hold it farther to the right
     all through the clip).

Moving the prop away from the body doesn't pull the body after it: the arms reach out.

## 4. Put the hands on it

The prop panel's **Hands on it** lists the hands holding the prop. With Leads on, the carrying hand is there too:
"(carries it)".

**Put a hand on:** drag the free hand onto the shaft and let go. Within about a tenth of the body's height, it snaps
on at the nearest spot: the fist squarely round the shaft, kept a hand's width from the other hand.

**Adjust a grip:** click the hand. Its gizmo sits where it grips, lined up with the prop.
- **Red** runs along the prop: drag it to slide the grip up or down the shaft.
- **Green** is up across it, **blue** is sideways.
- **Rotate** turns the hand any way about its grip, for example to lay the palm flat on the shaft.

Letting go saves the grip exactly where the hand is, on every frame. This works for the carrying hand too, when the
prop leads. Its grip moves on the prop, and the prop stays on its path.

**Fist:** each hand's picker (Great sword, Golf club, Holding, Rifle, 2hand idle) sets how its fingers close round
the prop. It applies to the character in every clip. Great sword fits a spear's shaft best.

**Take a hand off:** the trash button. For the carrying hand, this goes back to holding the prop the way Outfit
places it.

At extremes, such as a fast strike, a hand turns in its grip and slides along the shaft a little (at most about a
centimetre a frame) rather than bend its wrist far. The head keeps looking where the clip looks.

## 5. Naturalize, then save

- **Naturalize** edges every frame toward how people move and smooths the motion. The hands stay on the prop, and
  the frames you keyed stay near where you put them. Each press goes a little further. Do it when the clip is mostly
  right: any change after it rebuilds the clip from your keys.
- **Save:** name the clip and save it. It becomes a new library clip, tagged custom, in the category of the clip it
  came from. Add it to the character's set in Animate like any other clip.

## Good to know

- **The game holds the prop by its Outfit placement.** If you move the carrying hand's grip far from that in the
  editor, the hand and the prop won't line up in the game. To change the grip for the game, change the placement in
  Outfit (step 1).
- **Reload after Rigsmith updates.** An editor that's already open keeps its old code: reload the page
  (Ctrl+Shift+R) and open the clip again.
- **Slow steps:** turning Leads on fits the whole clip (about 10 seconds); Naturalize takes a few seconds. The
  panel shows what it's doing.
- **A one-handed clip made two-handed** (Spear Thrust) turns the body side-on at the strike to get the front hand
  forward. That's the solver keeping both hands on the spear at the clip's own speed.
