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
2. **Edit animation → Edit playing clip.** The timeline starts empty: the clip plays as it is until you key something.
   Or pause on a pose and use **New clip from this frame** with a length.

**Posing:**

| You want to | Do this |
| --- | --- |
| Pick a frame | Scrub the timeline, type a frame number, or use the frame buttons. `,` and `.` step one frame; a focused timeline also accepts arrows, Home and End. |
| Jump between keys | Use **Previous key / Next key**, or click a diamond below the timeline. Diamonds also accept Enter and Space. |
| Select a hidden joint or prop | Choose it in **Edit animation → Target**. |
| Move a joint | Drag its sphere. A hand or foot reaches, its arm or leg follows. Any other joint swings its bone. |
| Crouch or jump | Drag the diamond at the hips up or down. The legs bend, the feet stay on the floor. Shift moves it any way. |
| Use the gizmo | Click a joint. **G** or **Move** moves it along an arrow or a plane; **R** or **Rotate** turns its bone. **Local / World** picks what Rotate turns about. |
| Delete keys | **Delete** removes the keys at this frame: the selected joint's, or every joint's with nothing selected. **Esc** lets go of the selection. |

Letting go keys only what you moved, at that frame. A joint's first key also pins it at the clip's ends, so the
change eases in and out. **Joint limits** keeps joints within the rig's motion ranges. The timeline's **Loop**
button controls whether the clip loops.

## 3. Make the prop lead

1. **Click the prop** in the viewport. Its panel opens.
2. Turn on **Prop leads the body**. The prop's path is fitted to the body once over the whole clip (about
   10 seconds): it moves a little, for example farther from the body, so the hands can hold it with room to spare.
   The body now follows the prop: the hands on it follow its path, the body follows the hands, and the body keeps
   clear of it.
3. **Move or turn the prop with its gizmo** to key its path:
   - **Move entire path off:** the move keys this frame only.
   - **Move entire path on:** the move shifts the whole path, every frame (for example, hold it farther to the right
     all through the clip).

Moving the prop away from the body doesn't pull the body after it: the arms reach out.

## 4. Put the hands on it

The prop panel lists each holding hand's fist. With **Prop leads the body** on, the carrying hand is labeled
"carrier". **Grip sockets** lets either hand use an existing socket without dragging it in the viewport.

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

**Take a hand off:** choose **Free** in its socket picker, or **Outfit placement** for the carrying hand. This
preserves the socket for reuse. The trash button deletes that grip socket from the character.

At extremes, such as a fast strike, a hand turns in its grip and slides along the shaft a little (at most about a
centimetre a frame) rather than bend its wrist far. The head keeps looking where the clip looks.

## 5. Naturalize, then save

- **Naturalize** edges every frame toward how people move and smooths the motion. The hands stay on the prop, and
  the frames you keyed stay near where you put them. Each press goes a little further. Do it when the clip is mostly
  right: any change after it rebuilds the clip from your keys.
- **Save:** name the clip and save it. It becomes a new library clip, tagged custom, in the category of the clip it
  came from. Add it to the character's set in Animate like any other clip.
- **A leading prop's path is saved with the clip.** The library clip plays with the prop where the editor had it, and
  a slot it fills (on a character with a prop of the same name) gets that path as the prop's keys, which the game
  export plays. **Use** isn't offered for the editor's own unsaved clip: save it, then use the saved one.

## Good to know

- **Workspace controls:** use the character picker to switch models without leaving Animate. **Library / Props /
  Characters** and **Inspector** toggle the side panels. On smaller windows they open as drawers; click outside or
  press Escape to close one. Hiding a panel keeps the current edit open.
- **Library filters:** All clips / Custom selects the source; the category picker filters within it. **Clear filters**
  resets the source, category and search when there are no matches.
- **The game holds the prop by its Outfit placement, moved by the clip's prop path.** The path is saved relative to
  that placement, so changing the placement in Outfit afterwards moves the prop in every clip that carries a path.
- **Reload after Rigsmith updates.** An editor that's already open keeps its old code: reload the page
  (Ctrl+Shift+R) and open the clip again.
- **Choose In place and Mirror before editing.** These source-motion controls are disabled while the editor is open,
  so the frame your keys and grips were made against stays fixed.
- **Slow steps:** turning Leads on fits the whole clip (about 10 seconds); Naturalize takes a few seconds. The
  panel shows what it's doing.
- **A one-handed clip made two-handed** (Spear Thrust) turns the body side-on at the strike to get the front hand
  forward. That's the solver keeping both hands on the spear at the clip's own speed.
