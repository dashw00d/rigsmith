# Rigging, weights and naturalization: how they work

The design notes behind the Skeleton and Skin steps and the editor's Naturalize, moved out of the README. The README
says what each step does; this says how and why, and how to check it. The paused hand/surface work that produced much
of this is described in [HANDOFF.md](../HANDOFF.md).

**The rule above all of it:** no code path changes a character's weights as a side effect. Only the explicit rig and
paint routes write `rigged.glb` skin data or `weight_edits.json`, and they refuse while the skin is locked
(`skin.locked`, Skin step; every rigged character except Scout and Villager came out of the migration locked as
"hand-fixed weights"). `tools/skin_opt/apply.ts` needs an explicit output and refuses `characters/*/rigged.glb`;
`tools/dev/coat_weights.ts --apply` checks the lock.

## The skeleton (Skeleton step)

- **Detected and placed.** Import detection (and a template fit, a conversion, a finger trace) writes
  `skeleton.detected`; what you place by hand is kept apart as `skeleton.overrides`, only the joints that differ. The
  skeleton everything uses (the rig job, the joint editor, the marker board, the export) is `select.jointsOf`: detected
  with the overrides on top, restricted to the template's hierarchy (for a person, at its finger level). Who writes
  what is DESIGN.md §2.2.
- **Markers** (`src/engine/markers.ts`, `static/templates/markers.json`): a dozen points on one flat view (a person
  from the front, a horse from the side), seeded where the joints are; drag the wrong ones and every joint follows live
  (as rigidly as it can, keeping the skeleton's shape). The board and the 3D joints are two cameras on the same
  overrides. A person's finger tips go on a view of each hand (from the back of the hand, along the fingers, cut to the
  hand; the other hand mirrored). Overlapping connected markers are reported by name before fitting.
- **Finger levels** (25/33/41/65 bones): a level change traces the new chains at the wrists as placed. Placements the
  new trace no longer means the same (the index chain between full and mitten) are set aside as stale overrides, shown
  for you to restore or discard, never dropped silently.
- **Creatures** use fitted body templates (`static/templates/<id>.json`, `tools/creature_fit.py` fits a quadruped
  along its skeleton). Human and horse are supported; the others are experimental.

## Weights (Skin step)

- **Candidates.** Humans and horses compare regional and volume-heat skinning on deformation tests; a re-rig also
  compares the previous weights carried onto the new joints. Native heat retries failed disconnected surfaces
  independently, then fills unbound pieces from the regional solution. Painted edits are re-applied before candidates
  are compared, and a failed build leaves the previous GLB intact. Independent surface islands can keep different
  candidate weights when every test agrees on both strain and extreme deformation; material and UV seams stay
  together. The deformation comparison covers humans and horses; other templates keep the regular heat solver. The
  rig report lists each stage's choice and why.
- **Previous skins** are matched in bind space, with barycentric interpolation for small triangle-interior repairs
  (`tools/lib/skintransfer.ts`). Painted vertices follow that surface across reordered vertices and UV splits; sparse
  strokes do not spread onto unpainted triangles. An ambiguous or missing painted point stops the rebuild and keeps
  the previous rig. Rig and remapped paint publication rolls back if the paint record cannot be written
  (`server/weights.ts`).
- **Pose-optimized weights.** Blender's weights are sharp at every joint but the shoulders, which bend over a tenth of
  the height (`blender/autorig/weights.py` soft_shoulders: an arm raised overhead turns ~125° from an A pose, and sharp
  weights put all of it in the armpit's first rows of triangles). After Blender rigs a humanoid, `server/skinopt.ts`
  poses it through 256 poses (`tools/skin_opt/pose_set.ts`: the unit's own clips and the deformation tests always, six
  each, the rest a random library draw, never the clips in `tools/skin_opt/holdout.json`); fits the weights on the GPU
  for minimal stretch (its root mean square, which spreads a stretch out: the mean gathered it into one hard band at
  the armpit), wobble and volume loss, one set of weights for each point and its mirror twin, so the two sides match
  (`tools/skin_opt/optimize.py`, PyTorch from the repo's `.venv` via `npm run setup:python`, or
  `RIGSMITH_TORCH_PYTHON`), then validates it again on a spread of additional library motions and writes it into the
  GLB (`tools/skin_opt/apply.ts`). ~10–15 s on the GPU, ~60 s on the CPU; skipped (with a warning) without PyTorch.
  Its objective penalizes extreme compression and stretching symmetrically; volume is preserved only for individually
  closed, consistently oriented surfaces, so open robes and disconnected parts cannot inflate one another. Creatures
  keep their heat weights: trained on a template's own clips the optimizer tore a horse's chest and flank
  (`server/routes/skin.ts`).
- Hand retargeting reads bind geometry around the placed wrist and knuckles, so repainting weights does not rotate the
  grip.

### Painting weights

Pause a deformation test on the frame that shows the problem and paint on the body as it stands
(`src/engine/weightpaint.ts`, `src/state/paint.svelte.ts`, `server/weights.ts`). Brushes follow the posed surface
instead of reaching through nearby fingers or cloth.

- *Heal*: mark the problem skin; Heal refills its weights smoothly from the good skin round it (skin pulled by a wrong
  bone goes with what surrounds it). It needs an unmarked boundary; an entirely selected island is left unchanged.
- *Add*, *Remove*, *Smooth* a chosen bone by hand.
- *Follow*: the brushed skin takes the weights of the skin it covers (looking in toward its nearest bone at rest: the
  trousers under a coat), or of the nearest bones where nothing is close under it, so the body pushes it (a hem the
  legs walk through).
- *Bone*: the brushed skin moves with only the bone under the brush, every other pull dropped (a face a hood drags, a
  buckle): the bone already moving most of the skin where the stroke begins, named in the panel as you hover.
- Seams never part (their vertices are one point); four bones a vertex. *Mirror left and right* lands every stroke on
  the other side too, each point's twin taking the other side's bone, the middle line evened; *Left → right* /
  *Right → left* set the whole other side from one (skin with no twin stays as it is).
- Save writes them into the rig and keeps them (`weight_edits.json`): every re-rig puts them back; Forget drops them.
  The Rig button warns first when painted weights exist, and the server checks the paint still maps onto the model
  before it starts.

Gear has its own painted weights (`garments/<id>/weights.json`): skin gear by bone name, pulled gear by `PropRoot` and
`pull:<handle id>` (which parts follow a pull).

### Deformation tests

`static/templates/tests.json`: library clips picked for how hard they work the joints, per body type (a person: arm
stretching, jumping jacks, an air squat, a fist pump, grab and slam, thumbs up, counting, boxing, each with its fingers
animated; a horse: its template's walk, run, rear, kick, eating, lying down, head-butt, death), played on the rig in
place, looped.

## Retargeting notes

- A person's feet keep their own rest angle in a retargeted clip and take its turn on top (`retarget.ts` alignment):
  pointing the foot bone the way the source's points tipped the sole wherever the rigs' ankles sit at different
  heights (until 2026-10-26 a standing clip's heel sank 3 % of the height through the floor, its toe floating).
- A creature's hips under a root bone (the horse template's `root` is tilted) take their track in that bone's frame
  (until 2026-10-26 written in world space, which crouched the caravan pony's walk).

## Naturalization (the clip editor)

The editor's body solve (`src/engine/posespace.ts`, the library's natural-pose model: 66 numbers a pose, PCA over the
131k library frames; soft feet that pivot, slide or step, never under the floor; the hips free). Joint ranges come from
one model (`src/engine/limits.ts`, measured on real motion by `tools/rom.ts`); collisions from one
(`src/engine/bodycollide.ts`). Without a pose model (non-human templates) edits are built from keys and IK only.

- Naturalization resets the original pose for each sample, infers balance support from grounded heels and toes
  (raised feet don't count), and runs in cancellable batches. Failed or cancelled solves restore the source scene; the
  editor keeps the previous clip if hand constraints or floor clearance fail.
- Temporal averaging uses orientations and unwraps corrections across 180 degrees. It uses the unedited clip to keep
  captured elbow freedom while correcting added bow from edits; newly authored held poses keep the anatomical default.
  Elbow allowances and capsule endcaps vary continuously. Measured joint ranges clamp to the nearest allowed cell
  edge, so a tiny boundary crossing doesn't snap an arm to the cell centre and move its hand off target.
- While dragging, a quick solve runs with the same goals the release will use, so letting go doesn't jump.

### The finger contact pass

`src/engine/handcontacts.ts` with `src/engine/surfacecontact.ts`. It first keeps tips with a three-joint
redistribution, scores the rendered skin, and refines a continuous trajectory. It checks both proper crossings and
covered surface estimated from oriented solid angles (three probes per hand triangle, positive signed winding above
0.5, bind-space area weights, so a compressed buried triangle can't look improved).

- A whole finger is kept unchanged if any frame increases covered area or if RMS or peak angular acceleration rises; a
  constant pad tilt is also tried when a varying correction would add motion.
- Free fingers can instead uncurl gently toward their bind pose, by at most 10 degrees per joint and within the smaller
  of 0.4 % of the character's height or 8 % of the finger's length at the tip. A constant relaxation is tried first. If
  changing contacts stop one adjustment from working throughout, the solver searches a smooth trajectory through each
  frame's safe relaxation interval (amounts 0 to 0.1, motion weights 10, 100, 1000), prunes unsafe intervals and
  solves again.
- The stored quaternion tracks are replayed at each interval midpoint (the actual float32 interpolants, as three.js
  plays them); an unsafe interpolated pose constrains the adjacent choices before the trajectory is solved again. Extra
  contour length is allowed only on frames where covered area decreases.
- Trials reuse unaffected vertices and triangle pairs, cache skin transforms and face planes, and score intersection
  length without allocating segment objects. Coverage trials keep stationary probes outside the moving patch's swept
  bounds when its boundary is unchanged; open moving boundaries, separating seam copies and probes near the winding
  threshold use full queries.
- Hands carrying gear, saved fists, hands held in every clip (`hands.hold`) and explicitly keyed fingers are protected.
  Loop corrections share their duplicated endpoint; cancellation restores the pose and prior edit.

**Limits.** Neither crossing length nor sampled coverage measures penetration depth or guarantees collision-free
geometry. Midpoint checks increase temporal coverage but don't prove safety between samples. The solid-angle query
detects enclosed geometry, but open wrists and inconsistent orientation need comparison against the same source mesh.
Crossing lengths are intersection contours, not depths; a contour moving across faces is not a new collision.

## Checking it

```bash
npm run test:python                                                           # heat, catalog, skin quality invariants
python3 tools/verify_autorig.py --out workspace/audits/rigging/generated --native
node tools/dev/verify_rigs.ts workspace/audits/rigging/generated workspace/audits/rigging/checks.json
node tools/dev/verify_rigs.ts workspace/audits/rigging/generated workspace/audits/rigging/extended.json --extended
node tools/dev/verify_naturalize.ts workspace/audits/motion-checks.json
node tools/dev/verify_naturalize.ts workspace/audits/dense-motion-checks.json --dense
node tools/dev/verify_hands.ts workspace/audits/hand-checks.json skirmisher-19c713 mixamo-Grab_And_Slam --free --coverage --midpoints
node tools/dev/verify_surfaces.ts workspace/audits/surface-checks.json skirmisher-19c713 mixamo-Grab_And_Slam --frames 24,97
```

- The isolated rig check (`verify_autorig.py`, then `verify_rigs.ts`) leaves saved characters alone. It verifies
  exported joint positions, finite normalized weights, four influences, matching split seams, and samples eight poses
  from each rig test clip. `--extended` adds 16 catalog motions across eight human movement categories. Stretch,
  compression and RMS strain measure deformation; a structurally valid rig can still crease or clip clothing.
- `verify_naturalize.ts --dense` samples every output frame and reports hand and floor error, foot movement, collision
  depth and angular acceleration. Contact increases are compared against the same body-part pair in the same source
  frame, after the final hand and floor corrections.
- `verify_surfaces.ts` reads the actual deformed triangles and tells crossings already present at rest and in the
  source frame from new ones. `verify_hands.ts` is the read-only finger contact check, one character and clip a run.
- All of these read characters through `tools/lib/node3d.ts` (schema 2, whatever the file). Back up
  `workspace/characters` (`tools/dev/backup_workspace.sh`) before a library-wide rebuild.

### Rig quality against Mixamo

`tools/dev/bench.ts` drives two rigs of the same meshes (Mixamo's and ours) with the same clips through the same
retargeter and scores deformation: edge stretch, rigidity of mid-limbs, head and feet, volume loss, weight bleed,
joint centering. Body regions come from geometry (Mixamo's own weights are lopsided), and the 18 benchmark clips
(`tools/skin_opt/holdout.json`) are never used to fit weights. `bleed_where.ts` and `weights_at.ts` say where one rig
puts weight another gives to a bone.

```bash
blender/autorig/dev/bench/rig_all.sh workspace/rigdev/bench/ours     # auto-rig the 12 Tripo characters
node tools/dev/bench.ts workspace/rigdev/bench/mixamo workspace/rigdev/bench/ours
```

On the owner's 12 Mixamo-rigged Tripo characters the automatic rigs have 27 % less stretch, half the limb wobble and
less than half the volume loss of Mixamo's hand-marked rigs.
