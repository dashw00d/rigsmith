# Rigsmith rigging, weights, and naturalization handoff

Updated 2026-10-27. Work stopped at the user's request: “okay lets wrap up and create a handoff doc.” The ongoing quality goal is being paused, not declared complete. Resume implementation or expensive audits only when the user resumes the work.

The pipeline has substantial verified improvements, but automatic rigging, weight painting, and animation naturalization are **not perfect or world class across the library**. The latest hand solver passes its source-relative checks in 15 completed cases; 13 cases remain unfinished, and a comparison with the previous solver exposes six regressed Berserker frames.

## Checkout and saved state

- Repository: `/home/ryan/dev/games/rigsmith`, branch `main`, HEAD `b371ef9`.
- All implementation changes are uncommitted. No commit, PR, deployment, or game export was made for this work. Preserve the modified **and untracked** source files; `git diff` alone omits important new modules and tests.
- `workspace/` is Git-ignored and contains the live library, recovery copies, numerical reports, screenshots, and experiment scripts. A source commit alone will not preserve this evidence or the applied library weights.
- Earlier stages applied accepted rig/weight improvements. The final hand stages did not publish another rig or animation. The four custom clips remain intact.
- The final preservation check confirms all 17 live `rigged.glb` hashes match the accepted baseline, all saved joint/region/finger placement fields remain unchanged, and saved `weight_edits.json` files remain byte-identical. See [preservation.json](workspace/audits/2026-10-27-hand-search/preservation.json).
- All three final audit workers and their owned Node children were stopped. A subsequent `/proc` scan found no matching jobs: [stop record](workspace/audits/2026-10-27-hand-search/stopped-for-handoff.json), [final process check](workspace/audits/2026-10-27-hand-search/handoff-stop-check.json). Recorded PIDs are historical; verify command lines before acting on any PID later.
- Agent-created browser tabs were closed. The existing app on port 5180 was left running. The native test edit was discarded, Archer restored, and the search cleared. Temporary `src/__audit-hand-search.html` is absent.

## Implementation map

| Area | Changes and primary files |
|---|---|
| Body and hand placement | Marker/fingertip editing, chain fitting, finger-level changes, saved-placement consistency, and nonfinite/coincident connected-marker errors. See `src/state/paint.svelte.ts`, `src/engine/weightpaint.ts`, `server/api.ts`, `blender/autorig/skeleton.py`. |
| Automatic weights | Fixed heat triangle-area indexing; recovered Blender native heat per disconnected surface; regional/native/previous-skin selection; coherent island substitutions; strain and extreme-deformation validation before and after optimization. See `blender/autorig/{rig,weights}.py`, `server/skinopt.ts`, `tools/skin_opt/{optimize.py,validate.ts,selection.ts}`, `tools/lib/deformation.ts`. |
| Painting and persistence | Posed-surface brush distances, healing/removal fixes, paint transfer through vertex reorder/seams/small repairs, previous-skin comparison, and transactional publication/rollback. See `server/weights.ts`, `src/engine/weightpaint.ts`, `tools/lib/skintransfer.ts`, `tools/skin_opt/painting.ts`. |
| Body naturalization | Complete source-pose reset, source-relative elbow allowances, monotone interpolation, spherical limit boundaries, continuous capsule endcaps, grounded support, yielding private solves, and cancellation restoration. See `src/engine/{posespace,limits,bodycollide,retarget}.ts`, `src/state/clipedit.svelte.ts`. |
| Actual surface diagnostics | Refitted BVH triangle crossings and signed winding/covered-surface queries on actual deformed vertices. See new `src/engine/surfacecontact.ts`, `tools/lib/surface.ts`, `tools/dev/verify_surfaces.ts`. |
| Finger naturalization | Endpoint-preserving correction, constant pad tilt, constant free uncurl, and the latest clearance-aware varying uncurl trajectory. See new `src/engine/handcontacts.ts`, its tests, and `tools/dev/verify_hands.ts`. |
| User-facing integration | Progress/cancel states, including “Checking finger trajectory”; protected grips and authored finger tracks. See `src/state/clipedit.svelte.ts`, `src/app/animate/EditPanel.svelte`, `README.md`, `docs/animating.md`. |

The new hand/surface/transfer/selection modules and several test/verifier files are currently untracked. Inspect `git status --short` before moving, committing, or cleaning the checkout. No applicable `AGENTS.md` was found during this work.

## Latest hand solver behavior

The latest evidence root is [workspace/audits/2026-10-27-hand-search/](workspace/audits/2026-10-27-hand-search/).

The solver first tries the earlier endpoint-preserving and constant corrections. If those fail and a free finger has a nonzero tip allowance, it samples uncurl toward the actual local bind pose at amounts `0, .02, .04, .06, .08, .1`. It retains the contiguous safe interval from zero, searches a smooth trajectory with motion weights `10, 100, 1000`, and re-solves after pruning unsafe intervals. Accepted varying trajectories report mode `clearance`. Failed candidates retain the original finger tracks.

Coverage uses three probes per hand triangle, positive signed winding above 0.5, and **bind-space area weights**. Every accepted sample must avoid increased covered area. Increased crossing length is allowed only when covered area decreases in that same hand/sample. This is sampled covered surface, not penetration depth or volume.

Coverage trials reuse the exact winding field outside a moving patch's swept bounds only when the patch boundary remains stationary. Seam cancellation requires identical posed positions. Open or separating boundaries fall back to full queries. Float64 fields, threshold-near probes, interleaved pose snapshots, and cache/full-query agreement have regression coverage.

The final code checks both stored poses and the midpoints of the actual float32 quaternion tracks using Three.js interpolation. Previously accepted finger tracks are included in subsequent midpoint source poses. Unsafe intermediate poses constrain both neighboring trajectory choices; a failed whole-finger candidate is rejected. This guard applies to the earlier correction modes as well.

Free relaxation is bounded to 10 degrees per joint and the smaller of 0.4% of character height or 8% of finger-chain length, with small numerical tolerances. The strict public API defaults to zero tip allowance; the editor opts in for free fingers. Endpoint-preserving redistribution retains its separate 35-degree joint bound and strict tip tolerance. Whole-finger RMS and peak angular-acceleration guards remain in place.

Prop carriers, attachments, authored fists, enabled grip scripts, and explicit finger keys remain protected. Nonfinger tracks pass through unchanged by the hand stage. Cancellation restores the source hierarchy and previous edit. The standalone library verifier intentionally tests bare-body free hands; it does not reproduce equipped editor grip protection.

## Latest verification and its limits

| Check | Result | Evidence under `2026-10-27-hand-search/` |
|---|---|---|
| Full test suite | 201 tests / 28 files passed | `tests-final.log` |
| Svelte check | 0 errors, 0 warnings | `check.log` |
| Tools TypeScript, changed-source ESLint | Passed | `types.log`, `lint.log` |
| Production build | Passed; output `index-DxYOd0rJ.js` | `build.log` |
| Current hand library audit | **15 / 28 completed; 15 passed; 2,223 stored/midpoint poses** | `results.json`, `library/*.json` |
| Current native editor | Huntress Grab And Slam completed, Ready to save, playback advanced frame 6 to 124; protected left bow hand retained | `native-verification.json` |
| Saved library preservation | 17 / 17 rigs, placements, and paint records unchanged in this hand pass | `preservation.json` |

The final small verifier change makes `--midpoints` imply coverage measurement even without `--free`; it does not change the solver or these batch cases, which already use `--free`. The full suite/build were run before that verifier-only change. Repository-wide ESLint is **not** clean: earlier full lint runs found unrelated existing errors; changed-source checks passed.

Of the completed cases, seven Grab And Slam cases accepted corrections with 2.76–28.30% aggregate covered-area reduction; eight Punching cases improved by 5.07–39.64%. These percentages sum stored-frame measurements, not midpoint measurements. All completed cases have zero source-relative covered-area/contact regressions at stored and midpoint samples.

**Previous-version regression:** Berserker Grab And Slam has greater right-hand covered area than the preceding clearance solver at frames **17, 21, 22, 23, 127, 128**. The largest difference is approximately `0.0001168691` square world units at frame 22. These frames still pass against the original source, and the whole clip improves substantially. Nevertheless, `passed: true` does not mean the new solver dominates the preceding solver frame by frame. Inspect `previousCoverageRegressions` in `results.json` before accepting the final quality claim. No other completed case has that comparison regression.

The remaining 13 cases are explicitly listed in `results.json`:

| Character | Unfinished clips |
|---|---|
| Raider | Grab And Slam |
| Scout | Punching |
| Seer | Grab And Slam |
| Siege Engineer, Skirmisher, Spearman, Villager, Warrior | Grab And Slam and Punching for each |

Current completed-case median solve times were **342.45 seconds for Grab And Slam** and **29.79 seconds for Punching**, under three concurrent audit workers. Berserker Grab took 579.98 seconds to solve. Audit totals additionally include independent replay. These are not interactive latency acceptance results; performance remains a major issue.

The verifier independently checks source-relative coverage, contact, tip positions, nonfinger tracks, and stored-frame per-finger RMS acceleration. Its external tip gate uses the global height allowance; the solver itself additionally enforces each finger's shorter chain-length bound. Midpoint acceleration, all-time collision freedom, and the complete rendered/editor pipeline are not certified by these numerical reports.

Native screenshots: [Huntress frame 84](workspace/audits/2026-10-27-hand-search/huntress-native-frame84.jpg), [frame 28](workspace/audits/2026-10-27-hand-search/huntress-native-frame28.jpg). No naturalized test clip was saved. T3 snapshots timed out twice; native verification continued in Brave, and all temporary tabs were closed.

### Do not mix preliminary and current evidence

- `library-frame-only/`, `*-frame-only.jpg`, and `native-verification-frame-only.json` predate the midpoint guard. An independent Skirmisher replay found six midpoint coverage increases, so stored-frame success alone was insufficient.
- `skirmisher-experiment.json` and `skirmisher-fast.json` produced identical stored-frame tracks/metrics; the cached variant reduced total audit time from 447.46 to 317.15 seconds. This comparison **does not measure the final midpoint solver**.
- `skirmisher-fast-subframes.json` records the six failures. The later `skirmisher-midpoint-subframes.json` found none across 128 midpoints, but its source preflight started just before the final per-chain midpoint tip bound was tightened. It is diagnostic evidence, not the missing current-code Skirmisher library case.
- `skirmisher-comparison-*-frame-only.jpg` and its independent face-centroid measurements use different probes/weighting from the production metric and an older output. Do not present them as final midpoint results.
- Earlier crossing-only hand reports were superseded when shorter intersection contours were found to bury more hand surface. Their supersession notes must accompany reuse.

## Earlier completed stages and recovery evidence

These are historical stage results, not a rerun of every earlier audit against the latest code. Their old statements that the goal remains active are superseded by this user-requested pause.

| Stage | Verified work and evidence |
|---|---|
| Initial rigging repair | All 17 rigs rebuilt; placement/hand editing exercised through the real UI; finite normalized weights/seams/joints verified; 3,189 painted values preserved. [Rigging report](workspace/audits/2026-10-27-rigging/REPORT.md). |
| Painting and initial polish | Surface-aware brush, disconnected heat recovery, isolated 17-model rebuild and applied weight improvements. [Polish report](workspace/audits/2026-10-27-polish/REPORT.md). |
| Latest applied weight refinement | 11 live characters improved, six retained their then-current skins, including three horses. 360 model/motion cases, 2,880 sampled poses, 17-model structural checks, all 3,189 painted values preserved. Recovery originals in `2026-10-27-refine/all-before/`; accepted candidates and guarded application records retained. [Refinement report](workspace/audits/2026-10-27-refine/REPORT.md). |
| Body motion refinement | 154 cases / 16,856 frames; all finite/hand/floor gates pass, aggregate RMS acceleration below source in all 154. Worst hand error 0.993 mm, floor error 0.199 mm. Approximate contacts still flag 31 cases / 164 frames. [Motion report](workspace/audits/2026-10-27-motion/REPORT.md). |
| Transfer and actual surfaces | All 17 previous-skin comparisons complete; painted-address remapping and rollback verified. Isolated Skirmisher rebuild improves average strain by 11.53%, but crossing length regresses at Grab frame 100; **not published**. [Surface report](workspace/audits/2026-10-27-surfaces/REPORT.md). |
| Earlier finger stages | Crossing-based correction, performance work, and then covered-area acceptance. [Hand report](workspace/audits/2026-10-27-hands/REPORT.md), [speed report](workspace/audits/2026-10-27-hand-speed/REPORT.md), [clearance report](workspace/audits/2026-10-27-hand-clearance/REPORT.md). The last completed 28-case run belongs to the preceding clearance implementation and had no midpoint checks. |

Do not rerun historical `apply.ts` scripts as routine setup. They are guarded application records for particular baselines. `tools/skin_opt/validate.ts` can modify candidate weights; copy candidates before experimenting. Do not overwrite live rigs, saved painting, placements, or custom clips to reproduce an audit.

## Resume priorities

1. Read this file, `git status --short`, and current `results.json`. Confirm no old workers remain. Preserve the dirty/untracked implementation and ignored evidence before reorganizing work.
2. Investigate the six Berserker previous-version regressions with native geometry views. Determine whether the current global improvement warrants the local tradeoff or tighten candidate comparison; do not erase the regression by changing the reporting baseline.
3. Finish the 13 missing current-code cases. Recheck affected completed cases if source changes. Review failures individually; batch completion and a JSON file's existence are not acceptance.
4. Reduce hand-solver cost while retaining exact-query fallback and output validation. Exact posed-state memoization was only a possible next experiment, **not implemented or proven**. Earlier crossing-only/cache timings must not be reused as current latency claims.
5. Verify final Skirmisher geometry and native playback after its current-code audit completes. Preserve enabled grip protections; its real editor can protect both hands, so editor timing may omit free-hand solving.
6. Add stronger temporal/region/contact acceptance where justified. Stored frames plus midpoints still leave unsampled times. Winding coverage is orientation-dependent, wrists can be open, and crossing diagnostics omit coplanar/shared-vertex contacts. Hand regions currently derive from skin weights.
7. Continue the original broader goal: production weight-selection contact guards, the unpublished Skirmisher rerig, Seer's layered cloth/body intersections and deep-pose creases, wider animation/prop coverage, horses, and native visual acceptance across the library. Weight strain and aggregate acceleration alone do not establish natural motion or good deformation.

### Reproduction commands

Run from `/home/ryan/dev/games/rigsmith`. These are continuation instructions; no jobs were restarted for this handoff.

```sh
# Cheap report refresh; no solver execution.
python3 workspace/audits/2026-10-27-hand-search/aggregate.py

# One current read-only case; use a fresh output path when comparing variants.
node tools/dev/verify_hands.ts /var/tmp/skirmisher-current.json skirmisher-19c713 mixamo-Grab_And_Slam --free --coverage --midpoints

# Final library batch: run index 0, 1, and 2 in separate owned terminals/workers.
python3 workspace/audits/2026-10-27-hand-search/batch.py 0
python3 workspace/audits/2026-10-27-hand-search/batch.py 1
python3 workspace/audits/2026-10-27-hand-search/batch.py 2

# Checks after substantive changes.
npm test
npm run check
npx tsc --noEmit -p tools/tsconfig.json
npm run build
git diff --check

# Python checks when rig/weight code changes.
.venv/bin/python -m unittest discover -s tools/skin_opt -p test_quality.py
python3 -m unittest discover -s blender/autorig -p test_heat.py
```

`batch.py` limits each child to 1,800 seconds and skips any existing result JSON without inspecting its `passed` field. All 15 existing final results pass, but this behavior matters after a failed rerun. Interrupted cases may have logs without JSON; these are rerun. Tool-owned long-running parents previously timed out while children survived; use owned persistent terminals or tracked detached workers, retain PIDs, and inspect/stop their actual children when wrapping up. Never stop the user's existing Vite service as audit cleanup.

`tools/dev/verify_naturalize.ts --dense` and `tools/dev/verify_surfaces.ts` have reproduction examples in the motion/surface reports. Broader checks can be expensive. Run the relevant checks after changes, then inspect actual app playback rather than inferring visual quality from numeric passes.
