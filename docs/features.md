# Rigsmith features: what we need, what we have, where it goes

2026-11-06. Rigsmith's scope is assembling characters. Making and fixing parts moves to a separate gear tool
(/hq/projects/dev/games/GEAR_TOOL_HANDOFF.md). The UI stays as it is and is extended: today's layout is a top bar
(steps Import, Skeleton, Skin, Gear, Look, Motion, Ship; drawers Library, Catalog, Wardrobe, Activity; the Forge
button), the Characters list on the left, the step's panel on the right with sections. (A full redesign was mocked
up for later: rigsmith-agents/ui-mockups/.)

Status: **ok** works · **broken** there but doesn't work · **no UI** the data/engine exists, nothing to click ·
**missing** not built · **partial** works with the stated limits · **remove** leaves Rigsmith.

Updated after Extend waves 1–5a. The listed UI is implemented unless a limit is called out; acceptance and
performance gaps remain below. The follow-up legacy retirement (wave 5b) is not complete.

## Characters and dynamic classes

| Feature | Status | Where |
|---|---|---|
| Character list (bodies) | ok | Left sidebar |
| Sort, group, search the character list | ok | Left sidebar: a search box + sort (name, updated) + group (by kind of body) |
| Dynamic classes (villager, spearman, archer…) as their own list | ok | Left sidebar: a second tab **Characters \| Dynamic classes** |
| A class's sets and their weights ("this set is for spearmen") | ok | Dynamic classes tab → class opens in the Gear step's new **Class** section: sets with weight sliders, add/remove |
| A class's pools (which skins, clothes, hair it may get) | ok | Same Class section, Pools list |
| Which classes wear a set (seen from the set) | ok | Gear step → set row → "worn by" chips |
| Culture input when previewing (norse/gael/order) | ok | Dynamic character section: a culture select beside Randomize |
| Copy sets/classes to another body | missing | Later |

## Sets, pieces and dressing (Gear step)

| Feature | Status | Where |
|---|---|---|
| Select a piece | ok | Gear section list + click in the viewport |
| Shown/hidden toggle on a piece | ok (preview only) | Gear section list eye: preview only, shows/hides on stage |
| Bind with Cancel | ok | Fitting bar: Cancel beside Bind, Esc |
| Sets as first-class (pieces, tags, grants) | ok | Gear step: a **Sets** section: list by culture, rename, tags, covers-hair/face, add/remove pieces (drag a piece onto a set) |
| Browse sets/skins/clothes/hair with thumbnails, search, filters | ok | Wardrobe drawer, opened from a visible button in the Gear and Dynamic character sections |
| Swatch pickers with locks; ruled-out choices say why | ok | Dynamic character section |
| Randomize as the game picks; Unit # | ok | Dynamic character section |
| Browsing never edits the character; "Make default" saves | ok | Dynamic character section |
| Crowd view (8/12/24 units) | ok | Viewport toolbar button "Crowd" |
| Pieces list: grouped, search, multi-select, bulk tag/move/hide/delete | ok, inside the Wardrobe drawer | Also reachable from the Gear section header |
| Coverage view (which body regions a piece hides, %) | ok (largest single piece per region) | Viewport toolbar toggle "Coverage" + piece inspector rows |
| Body hiding under gear by seam regions | ok | Automatic |
| Female shape on gear | ok | Automatic from the skin |
| Pose, handles, painted weights for a piece | ok | Gear step sections Pose / Handles / Weights |

## Clothes and skins (Look step)

| Feature | Status | Where |
|---|---|---|
| Clothes as layers in slots bottom / top / over | ok in Rigsmith; game acceptance pending | Look step: new **Clothes** section: one row per layer, slot chips, order |
| Shorts: cut a bottoms layer at a height | partial (bare-leg visual acceptance pending) | Clothes section → layer → cut height slider per limb + preview |
| Bare skins (needed for shorts) | ok (CPU fill; art polish belongs to the gear tool) | Look step → Skins: "Make bare" job per skin (uses the gear tool's painter later) |
| A layer previewed across all 24 skins | ok | Clothes section → "All skins" contact sheet in the viewport |
| Skins: rename, tag (female/beardless/elderly), hair colour | ok | Look step: new **Skins** section |
| Clan colour on each layer's trims | ok (mask view) | Clothes section → layer → trim mask view |
| Texture layers, holes, projection painting | ok | Look step (stays) |

## Motion

| Feature | Status | Where |
|---|---|---|
| Clips, slots, timeline, adjustments, hands, events | ok | Motion step |
| Stances: a set swaps clips (shield idle/attack) | ok in Rigsmith/export; game playback pending | Motion step: **Stance** picker at the top of the slot list + per-slot "override for stance" |
| Preview motion dressed as a set/class | ok | Motion step: "Dressed as" select (uses the dress state) |
| Clip library: sort, group, filter, search | ok (culture tagging remains a follow-up) | Library drawer: search + sort (name, length, recent) + group (category, source) + filters (culture, loop, rig) + a dense list view |

## Ship (export)

| Feature | Status | Where |
|---|---|---|
| Export units to the game, checks, build record | ok | Ship step |
| A unit spec says its dynamic class | ok | Ship step → unit card → Class select |
| Manifest with the pick program and goldens the game reproduces | partial (game golden needs verification) | Automatic |
| Atomic, skip-unchanged writes | ok | Automatic |

## Parts coming in from the gear tool

| Feature | Status | Where |
|---|---|---|
| Incoming finished parts, clothes, hair: accept into a set, see what's new | ok | A new **Incoming** drawer (badge with the count in the top bar) |
| Replace a piece's model keeping its placement | ok (old paint restored by undo before repaint) | Incoming → "replace" |
| Forge board, generation stages | removed (2026-11-06) | The gear tool owns generation; the Forge server (GPU lane, store, queue) stays until it takes it |

## Jobs, speed, caches, QoL

| Feature | Status | Where |
|---|---|---|
| One GPU queue (rig, skin optimizer, Qwen paint) | ok | Activity drawer: list with progress, reorder, cancel |
| No stale caches (files by content hash, server pushes changes) | ok | Automatic |
| Dressing clicks instant (outfit, skin, randomize) | partial (Randomize exceeds 50 ms) | Automatic |
| Character load without stalls | partial (first load exceeds 150 ms) | Viewer, Stage |
| Speed budgets enforced (`npm run perf`) | partial (runner reports failed budgets) | Run before merging |
| Undo/redo everywhere, with a toast | partial (horse coat rename across riders remains open; Motion has its own) | Ctrl+Z / Ctrl+Shift+Z |
| Visible keyboard hints (not just a `?` sheet) | partial | Hint chips on every button that has a key |
| Search in every list | ok for the requested lists | Character list, Gear list, Library, Sets, Classes |
| Right-click menus on rows | partial (available on sets) | Gear list, sets, classes, library |
| Remembered per-character view state | ok | Automatic |
| Every UI change opened in a real browser before merge | process | Done check for every change |

## Open acceptance and follow-ups

- Confirm cut seams and bare legs visually; uncut layers skip cut padding. The game still needs per-slot bare-base
  composition and validation of the manifest's golden picks and baked stance playback.
- Resolve Randomize and load budgets from measured profiles. Horse coat renames need an atomic rider transaction and
  linked undo. Mask versions are retained until collection can coordinate with in-flight saves.
- Shared sets across bodies, clip culture tagging, and retirement of the compatibility fields remain future work.
