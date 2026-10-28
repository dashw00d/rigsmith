# Handoff

Updated 2026-10-28.

## The rebuild

Rigsmith is being reworked onto one character document (schema 2), commands with a journal and undo, one bake shared
by the viewer and the game export, and seven steps (Import, Skeleton, Skin, Gear, Look, Motion, Ship). Read, in order:

1. [docs/rebuild/PLAN.md](docs/rebuild/PLAN.md): what Rigsmith is, what was redundant, the plan in phases, the open
   questions.
2. [docs/rebuild/DESIGN.md](docs/rebuild/DESIGN.md): the binding design (decisions, the document, file ownership by
   area, module APIs, behaviour fixes, the contract's change log in §11).
3. The seven inventories beside them (`docs/rebuild/inventory-*.md`): every control and behaviour of the tool before
   the rebuild, by area, so nothing is lost.

The rebuild was written in a sandbox checkout (`/home/ryan/dev/games/rigsmith-rebuild`, branch `rebuild`) with a private
copy of the workspace, while the owner kept using the real tool. Characters migrate to schema 2 the first time the
server reads them (or all at once with `npm run migrate`; `npm run migrate:check` proves each still means what it
meant). Still open for the owner (DESIGN.md §10): whether a rider's horse gear should ship, and porting the game repo's
scripts off the deprecated v1 API.

How the rig, the weights and naturalization work is now [docs/rigging.md](docs/rigging.md) (moved out of the README).

## Paused: hand and surface naturalization

On 2026-10-27 the rigging, weights and naturalization work was paused at the owner's request, not declared complete.
Automatic rigging, weight painting and naturalization have verified improvements but are **not world class across the
library**. Resume implementation or expensive audits only when the owner resumes the work.

The evidence lives in the owner's live workspace (`/home/ryan/dev/games/rigsmith/workspace/`, gitignored and not
copied into the sandbox):

| What | Where (under `workspace/audits/`) |
|---|---|
| The latest hand solver: results, per-case reports, preservation check, stop records, screenshots | `2026-10-27-hand-search/` (`results.json`, `library/*.json`, `preservation.json`, `native-verification.json`, `aggregate.py`, `batch.py`) |
| Earlier finger stages | `2026-10-27-hands/REPORT.md`, `2026-10-27-hand-speed/REPORT.md`, `2026-10-27-hand-clearance/REPORT.md` |
| Rigging repair, painting polish, weight refinement (with recovery originals in `all-before/`) | `2026-10-27-rigging/REPORT.md`, `2026-10-27-polish/REPORT.md`, `2026-10-27-refine/REPORT.md` |
| Body motion and actual surfaces | `2026-10-27-motion/REPORT.md`, `2026-10-27-surfaces/REPORT.md` |

Don't mix preliminary and current evidence: `library-frame-only/`, `*-frame-only.jpg` and
`native-verification-frame-only.json` predate the midpoint guard; `skirmisher-experiment.json`, `skirmisher-fast.json`
and `skirmisher-midpoint-subframes.json` are diagnostics, not the missing current-code Skirmisher case; earlier
crossing-only hand reports were superseded (their supersession notes must go with any reuse). Don't rerun the
historical `apply.ts` scripts in the audit folders: they are guarded application records for particular baselines.
`tools/skin_opt/validate.ts` can modify candidate weights; copy candidates first. Never overwrite live rigs, painted
weights, placements or custom clips to reproduce an audit.

### Unfinished work

1. **Berserker regression.** Grab And Slam has more right-hand covered area than the previous clearance solver at
   frames 17, 21, 22, 23, 127 and 128 (largest about 0.000117 square units, frame 22). They still pass against the
   source and the whole clip improves, but `passed: true` doesn't mean the new solver beats the previous one frame by
   frame. Inspect `previousCoverageRegressions` in `results.json` with native geometry views; don't erase it by
   changing the reporting baseline.
2. **13 cases not run** on the current code (15 of 28 done, all passing):

   | Character | Unfinished clips |
   |---|---|
   | Raider | Grab And Slam |
   | Scout | Punching |
   | Seer | Grab And Slam |
   | Siege Engineer, Skirmisher, Spearman, Villager, Warrior | Grab And Slam and Punching for each |

   `batch.py` limits each child to 1,800 s and skips any existing result JSON without reading its `passed` field.
   Review failures one by one; a JSON file existing is not acceptance.
3. **Speed.** Median solve times were 342 s (Grab And Slam) and 30 s (Punching) under three workers; Berserker Grab took
   580 s. Cut the hand solver's cost while keeping the exact-query fallback and output validation (posed-state
   memoization is an idea, not implemented or proven).
4. **Skirmisher**: verify its geometry and native playback after its current-code case runs, keeping the grip
   protections (its editor can protect both hands, so editor timing may skip free-hand solving).
5. **Stronger acceptance** where justified: stored frames plus midpoints still leave unsampled times; winding coverage
   depends on orientation, wrists can be open, crossing checks miss coplanar and shared-vertex contacts; hand regions
   come from skin weights.
6. **The broader goal**: contact guards in production weight selection, the unpublished Skirmisher re-rig (better
   strain, but a crossing regression at Grab frame 100), Seer's layered cloth and body intersections and deep-pose
   creases, wider animation and gear coverage, horses, and native visual acceptance across the library. Weight strain
   and aggregate acceleration alone don't establish natural motion or good deformation.

### Resuming

Run from the owner's checkout (`/home/ryan/dev/games/rigsmith`); no jobs were left running. Confirm no old workers
remain before starting any (verify command lines before acting on a recorded PID), and never stop the owner's Vite
service as audit cleanup.

```sh
python3 workspace/audits/2026-10-27-hand-search/aggregate.py          # cheap report refresh, no solving
node tools/dev/verify_hands.ts /var/tmp/skirmisher-current.json skirmisher-19c713 mixamo-Grab_And_Slam --free --coverage --midpoints
python3 workspace/audits/2026-10-27-hand-search/batch.py 0            # the library batch: 0, 1 and 2 in separate workers
npm test && npm run check && npm run test:python && npm run build   # (this branch's scripts)
```

Then look at the actual playback in the app rather than inferring visual quality from numeric passes.
