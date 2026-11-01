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
- **Lifted skin (Lift brush).** Shape corrections against the covered body's posed surface. Cloth layers and their
  body correspondences are found in the shape at the start of painting, so a leg poking through during a squat does
  not become cloth. Gap is applied once, between the body and the innermost cloth, and outer layers keep their
  starting separation. Each patch has its own clearance: a collision elsewhere in the brush does not inflate it.
  Body vertices stay fixed, including where cloth and body share an attachment. The reference stays fixed through
  repeated dabs, undo, saving and reopening. Painter setup reads the saved original positions through GET `/shape`,
  using only records whose saved destination matches the loaded vertex; stale topology records are ignored. The
  shape writer keeps sparse original references at the actual vertex addresses in each GLB primitive, including
  reordered/split vertices found during re-rig. The sidecar uses original positions as keys, so reused indices cannot
  take another point's origin. Forget resolves those current addresses before restoring positions. The
  displayed shape and stroke baseline remain the saved shape. Original positions also preserve mirror partners
  after a one-sided lift. Collision distance is measured to the nearest finite body triangle in a posed BVH, rather
  than to an infinite plane through a rest correspondence. A limb that moved sideways clear of the cloth must not
  lift it just because that plane is close; an open boundary is not treated as solid penetration beyond its edge.
  Each layer already outside its required gap stays fixed (the innermost's Gap plus the outer layer's original
  separation). Kept as rest positions in `shape_edits.json` with where each vertex first was
  (`server/shapes.ts`): a fresh rig is made from the unlifted model, so the rig job finds them there and lifts them
  again before the painting is carried over. Forget the lifts puts them back. Body only. This changes every pose:
  clearing a deep squat can bulge the standing shape. Lift is not an animation collision solver; constant clearance
  through a bend needs pose-dependent corrections shared by preview and export. Check both poses before saving.
- **Pose correction transport.** Geometry transforms, material merges, head splits and LOD compaction preserve
  morph target coordinates, names, relative mode and loaded default influences. Relative deltas follow the linear
  transform; absolute positions include translation. Normal deltas use the same normal-matrix scale as the base,
  preserving blended directions under nonuniform transforms. Shared interleaved accessors are materialized before
  mutation, and normalized attributes retain their encoded values during compaction. A previous UV/contact source
  with different corrections cannot replace the visible surface. This is transport infrastructure; a full garment
  solver and persisted correction brush are still under development. Sampled morph keys alone do not prove
  clearance between keys, across clip transitions or after LOD simplification.
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
instead of reaching through nearby fingers or cloth. A stroke keeps to the sheet it began on until the button is let
go: each dab must meet the last dab over the surface, so skin poking out through it (a coat through a cape) is looked
past. The picked triangle remains an anchor even when the brush is too small to reach its corners. The last contact
is used rather than the whole stroke's history or the whole connected component: generated layers can join far away
at the shoulders. The layer tools can continue across a material boundary through the last contact's shared seam
vertices, while unrelated overlapping layers remain excluded. Follow, Cloth and Lift deliberately reach the cloth
layers beneath this surface, including separate skinned primitives. Those layers are projected onto the painted
sheet in shared original bind space and inherit its brush falloff, independently of their posed depth order.

Painting pauses playback so a stroke edits one pose. Picking and brush footprints use that stroke's starting surface;
changing weights cannot move the painted material away from subsequent cursor rays. Solving Lift and evaluating
surface safety always use current geometry. A new stroke picks the changed surface again. Material transitions
require a shared edge with surface on opposite sides, so a lining folded back from a common hem is not a continuation.
Dabs are spaced along the pointer path at 15% of the brush's
projected radius, including fast drags and the release point. Strength is the maximum blend in one stroke, from the
weights as that stroke began: overlapping dabs and high event rates do not compound it. Lift the pointer and start a
new stroke to build more. Mirror shares this maximum, so a weak dab cannot overwrite a stronger dab on the other
side. Twin coverage is resolved before applying a dab, independently of point iteration order. A partial mirrored
stroke blends from each side's own weights; it does not replace an asymmetric painted twin with the other side's
already-blended result. Nonpositive or nonfinite Strength is a no-op. Undo restores the weights, lifts, marked area and unsaved state from before the stroke. Empty gestures do not
take an undo slot.

Layer brush dabs collect pending proposals before changing any receiver. Shared targets map by bone name across
different joint palettes; a single pose guard evaluates all receiving meshes together. The covered body remains a
donor, and gear strokes write only the editable garment meshes. Original bind-frame conversion handles different
primitive transforms; physical reach does not depend on a primitive's local coordinate scale.

Surface queries use `three-mesh-bvh` on private posed/reference geometries with indirect triangle indexing. The
posed tree is refitted after skinning; source vertex/triangle numbering and the saved paint format stay intact.

*Start over* (beside Forget the painting and Forget the lifts) drops every painted weight and lift and rigs the body
afresh at once, so its weights are the auto-rig's again. Forgetting alone leaves the live rig's weights until the next
rig, so painting over several sessions only piled up with no way back (the designer, 2026-10-31).

- *Heal*: mark the problem skin; Heal refills its weights smoothly from the good skin round it (skin pulled by a wrong
  bone goes with what surrounds it). Physical seam copies share one neighbourhood across primitives; each mirrored
  side keeps its own authored boundary. It needs an unmarked boundary; an entirely selected island is left unchanged.
- *Add*, *Remove*, *Smooth* a chosen bone by hand.
- *Follow*: the brushed skin takes the weights of the skin it covers (looking in toward its nearest bone at rest: the
  trousers under a coat), or of the nearest bones where nothing is close under it, so the body pushes it (a hem the
  legs walk through). Covered cloth layers share the painted sheet's target field and brush falloff, but each blends
  from its own starting weights by Strength. Copying the already-blended outer result wholesale could fully rebind
  the lining at zero Strength or a nearly-zero brush edge; neither is allowed.
  The skin it reaches through to keeps its own weights. What it gives that a left bone and
  its right twin share (cloth between the legs) goes to the bone both hang from, the hips: blended between two legs
  that part, linear skinning drew the layers there together.
- *Cloth*: brush where clothing hangs over the legs and it is weighted as cloth from where it hangs at rest, nothing
  else: the hips at the waist blending down into the legs (0.95 by the knees, all its own side's leg over that leg),
  below the knee up to 0.6 of the shin, no arm (`tools/rigsmith/skirt_weights.py`'s robe in emberhold, as a
  brush). Cloth layers below the painted sheet share its target and falloff, while the covered body keeps its own.
  Shared left/right pulls go to their common parent, as in Follow, including after interpolation through layers.
  Strength is the same maximum blend per stroke as the other weight brushes.
- *Brush integrity*: weight and Lift strokes check the paused pose, percentage probes and 120 Hz samples of the playing
  clip on a private rig copy (long clips use at most 240 regular intervals). Each sample resets the private action,
  so visiting the clip end cannot pause subsequent samples. Changes that reverse a face relative to its baseline,
  reduce area below a quarter of the rest area, or grow edges beyond twice
  their rest length are limited locally. Existing violations have a 2% tolerance so one damaged triangle does not
  disable the whole brush; mirrored points share their limits. Weight and shape baselines stay fixed through the
  stroke. This catches both rest-pose paint that eats into the cloth early in a bend and a posed Lift whose inverse
  skinning would amplify the correction into a long spike at rest. Finite rest-space triangle correspondences also
  constrain the signed separation between neighbouring layers, including different meshes: two intact sheets can cross without
  flipping any of their own triangles. A positive gap retains at least a quarter of its rest separation, unless it
  already has less; existing intersections may improve but cannot materially worsen. Gaps use world units and
  preserve the original side under reflected transforms. Reference bones and mirror planes use the original bind
  frame, so changing stage scale after binding does not change the identified layers. Baseline face metrics and
  unchanged posed points are cached through local limit iterations. The actual finite triangles also check new
  intersections with nonadjacent faces, including read-only body primitives and folds outside the original layer
  stack. Each existing intersecting face pair is exempt; it does not disable checks against other faces. Material
  seam aliases count as shared physical points. A private BVH preserves the source indices, with a fixed stroke
  baseline and refreshed candidate positions after earlier dabs. Contact queries share immutable topology and
  pose-independent weight/reference caches, update exact triangle bounds with changed points, and reject adjacent
  or disjoint candidates before decoding triangles. Ill-conditioned triangles retain the conservative finite
  predicate's behavior. `ContactBVH` traverses live views of the public version-1 BVH serialization in the stock
  leaf order; an unfamiliar layout falls back to the library's shapecast. Refit bounds, indirect source addresses,
  numerical broad-phase padding and pair-specific baseline exemptions stay unchanged. The panel distinguishes contact limits from other
  surface limits. These checks do not enforce a uniform thickness or continuously sweep between samples. It is a
  sampled integrity check, not proof of collision-free cloth or a substitute for an animation collision solver.
  The normal-reversal limit is conservative: a large coherent 3D rotation may be limited even without a physical
  self-intersection. Repair commands have their own explicit transactions rather than a brush clip snapshot.
  Interactive dragging checks the paused pose on each dab; release checks the accumulated stroke against the full
  sampled clip. The preview remains visible while cooperative pose/triangle checks yield to the editor. Candidate
  evaluation uses the exact stroke source; final commit restores its raw attributes before applying limits as one
  transaction, including coupled weight/shape edits and different primitives. Undo remains one exact stroke.
  The user can cancel a pending check; discard/reload invalidates its generation so a late result cannot change a
  newer painter. A failed check restores only its own stroke. Direct synchronous and asynchronous callers use the
  same constraint evaluator. The 120 Hz probes include verified contacts missed between the earlier 60 Hz probes;
  they still do not prove continuous collision freedom. Long clips retain the 240 regular interval work bound.
  Direct engine callers retain per-dab clip validation unless they explicitly request `deferClip` and finish `end()`.
  Save and other edit commands are unavailable during a drag. Deferred painting cannot be serialized or marked
  saved before release, so a second pointer or keyboard command cannot bypass the full-clip check.
- *Protect*: paint points that must keep their weights and Lift positions; Alt-drag removes protection. Cyan marks
  the protected points over the Weights view, including their UV aliases. Physical seam copies are pinned together;
  Mirror repeats the protection gesture but cannot make a later weight or shape brush write a protected twin.
  Protected points remain available as donors. This also applies to Heal and Copy side. Protection and Clear
  protection have exact Undo, independent of geometry edits, and cannot change during a pending clip check.
  The mask belongs to the loaded painter: it survives `saved()` on that painter but is not exported or stored in
  the weight/shape sidecars, and a new model load/painter clears it. Protection alone does not enable Save.
  Use it at fused clothing/body boundaries: a geodesic footprint can walk across a shared source edge from lining
  onto trousers, and the automatic rest-layer test does not certify garment ownership there. A source point shared
  with protected body faces must stay fixed on both sides of that seam; it cannot move only its cloth triangles.
- *Bone*: the brushed skin moves with only the bone under the brush, every other pull dropped (a face a hood drags, a
  buckle): the bone already moving most of the skin where the stroke begins, named in the panel as you hover.
- Seams never part (their vertices are one point); four bones a vertex. *Mirror left and right* repeats the brush on
  the other side too, swapping its target bones and using each side's own source; middle-line targets are averaged. *Left → right* /
  *Right → left* set the whole other side from one (skin with no twin stays as it is).
- Layer strokes synchronize material-boundary copies with compatible original positions, bone bindings and weights.
  They share target/coverage and local limits, and Lift shares the rest correction in bind space. A seam that touches
  a read-only mesh is pinned. Coincident surfaces with different bindings remain independent. Mirror also reaches
  opposite-side primitives with matching reference points and swaps the source target by bone name.
- Add/Remove/Smooth/Bone operate across compatible seam and mirror aliases from each recipient's own weights,
  with palette mapping by bone name and shared maximum coverage. Smooth uses the physical neighbourhood across
  material boundaries; the Bone brush holds its target by name across the stroke. Missing bones or read-only seam
  copies pin the shared point. Mark/erase use the same writable aliases. Explicit Copy Side freezes the chosen
  side's weights, maps them across primitives, and preserves positive tiny influences already present in the source.
- Save writes actual float weights into the rig and keeps them (`weight_edits.json`): every re-rig puts them back;
  the brush no longer rounds influences to five decimal places before saving. A body Save submits weights and Lift
  in one file job and increments the rig revision once, so saving Lift cannot reload away unsaved weight strokes.
  The candidate rig and both records are staged before publication; observed filesystem failures restore the old
  bytes, or retain recovery backups when restoration also fails. The painter checkpoints only a successful job.
  Its loaded rig revision prevents a stale editor from overwriting a newer rig. Canonical Lift origins are shared
  by the GLB and sidecar, including legacy saves with intermediate `from` positions. Forget drops saved painting.
- Start over waits for each deletion job to finish before starting the next or re-rigging; it does not submit
  competing jobs against the same character file lock.
  The Rig button warns first when painted weights exist, and the server checks the paint still maps onto the model
  before it starts.

Gear has its own painted weights (`garments/<id>/weights.json`): skin gear by bone name, pulled gear by `PropRoot` and
`pull:<handle id>` (which parts follow a pull).

Brush and constraint implementation references:

- [three-mesh-bvh sculpt example](https://github.com/gkjohnson/three-mesh-bvh/blob/master/example/sculpt.js): local
  queries, spaced strokes and refitting. The runtime dependency is MIT licensed; Rigsmith's stroke implementation
  retains residual spacing between input events and adds surface tracking and bounded strength.
- [Blender cloth brush](https://github.com/blender/blender/blob/main/source/blender/editors/sculpt_paint/mesh/sculpt_cloth.cc)
  and [automasking](https://github.com/blender/blender/blob/main/source/blender/editors/sculpt_paint/mesh/sculpt_automasking.cc):
  references for local brush influence and cloth constraints; no Blender source is copied into Rigsmith.
- [PositionBasedDynamics](https://github.com/InteractiveComputerGraphics/PositionBasedDynamics) (MIT) and
  [Ten Minute Physics 14–15](https://matthias-research.github.io/pages/tenMinutePhysics/): stretch/bend and collision
  constraint references. These are not currently installed as a runtime cloth solver.

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
