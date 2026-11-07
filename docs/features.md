# Rigsmith features: what we need, what we have, where it goes

2026-11-06. Rigsmith's scope is assembling characters. Making and fixing parts moves to a separate gear tool
(/hq/projects/dev/games/GEAR_TOOL_HANDOFF.md). The UI stays as it is and is extended: today's layout is a top bar
(steps Import, Skeleton, Skin, Gear, Look, Motion, Ship; drawers Library, Catalog, Wardrobe, Activity; a Forge
button), the Characters list on the left, the step's panel on the right with sections. (A full redesign was mocked
up for later: rigsmith-agents/ui-mockups/.)

Status: **ok** works · **broken** there but doesn't work · **no UI** the data/engine exists, nothing to click ·
**missing** not built · **remove** leaves Rigsmith.

## Characters and dynamic classes

| Feature | Status | Where |
|---|---|---|
| Character list (bodies) | ok | Left sidebar |
| Sort, group, search the character list | missing | Left sidebar: a search box + sort (name, updated) + group (by kind of body) |
| Dynamic classes (villager, spearman, archer…) as their own list | no UI (`folk.kind.*` commands exist) | Left sidebar: a second tab **Characters \| Dynamic classes** |
| A class's sets and their weights ("this set is for spearmen") | no UI | Dynamic classes tab → class opens in the Gear step's new **Class** section: sets with weight sliders, add/remove |
| A class's pools (which skins, clothes, hair it may get) | no UI | Same Class section, Pools list |
| Which classes wear a set (seen from the set) | missing | Gear step → set row → "worn by" chips |
| Culture input when previewing (norse/gael/order) | no UI (engine supports it) | Dynamic character section: a culture select beside Randomize |
| Copy sets/classes to another body | missing | Later |

## Sets, pieces and dressing (Gear step)

| Feature | Status | Where |
|---|---|---|
| Select a piece | **broken** (regression) | Gear section list + click in the viewport |
| Shown/hidden toggle on a piece | **broken** (regression: edits the document while the stage follows the dress state) | Gear section list eye: preview only, shows/hides on stage |
| Bind with Cancel | **broken** (no Cancel) | Fitting bar: Cancel beside Bind, Esc |
| Sets as first-class (pieces, tags, grants) | ok (schema 5) / no UI for editing | Gear step: a **Sets** section: list by culture, rename, tags, covers-hair/face, add/remove pieces (drag a piece onto a set) |
| Browse sets/skins/clothes/hair with thumbnails, search, filters | ok, hidden behind W | Wardrobe drawer, opened from a visible button in the Gear and Dynamic character sections |
| Swatch pickers with locks; ruled-out choices say why | ok | Dynamic character section |
| Randomize as the game picks; Unit # | ok | Dynamic character section |
| Browsing never edits the character; "Make default" saves | ok | Dynamic character section |
| Crowd view (8/12/24 units) | ok, hidden behind C | Viewport toolbar button "Crowd" |
| Pieces list: grouped, search, multi-select, bulk tag/move/hide/delete | ok, inside the Wardrobe drawer | Also reachable from the Gear section header |
| Coverage view (which body regions a piece hides, %) | missing (only a CLI) | Viewport toolbar toggle "Coverage" + piece inspector rows |
| Body hiding under gear by seam regions | ok | Automatic |
| Female shape on gear | ok | Automatic from the skin |
| Pose, handles, painted weights for a piece | ok | Gear step sections Pose / Handles / Weights |

## Clothes and skins (Look step)

| Feature | Status | Where |
|---|---|---|
| Clothes as layers in slots bottom / top / over | no UI (`look.cloth.*` exists; the game draws 3 layers) | Look step: new **Clothes** section: one row per layer, slot chips, order |
| Shorts: cut a bottoms layer at a height | no UI (cut data exists) | Clothes section → layer → cut height slider per limb + preview |
| Bare skins (needed for shorts) | missing | Look step → Skins: "Make bare" job per skin (uses the gear tool's painter later) |
| A layer previewed across all 24 skins | missing | Clothes section → "All skins" contact sheet in the viewport |
| Skins: rename, tag (female/beardless/elderly), hair colour | missing | Look step: new **Skins** section |
| Clan colour on each layer's trims | ok in the game; no UI | Clothes section → layer → trim mask view |
| Texture layers, holes, projection painting | ok | Look step (stays) |

## Motion

| Feature | Status | Where |
|---|---|---|
| Clips, slots, timeline, adjustments, hands, events | ok | Motion step |
| Stances: a set swaps clips (shield idle/attack) | no UI, no bake (`folk.stance.*` exists) | Motion step: **Stance** picker at the top of the slot list + per-slot "override for stance" |
| Preview motion dressed as a set/class | missing | Motion step: "Dressed as" select (uses the dress state) |
| Clip library: sort, group, filter, search | **missing** (no organization) | Library drawer: search + sort (name, length, recent) + group (category, source) + filters (culture, loop, rig) + a dense list view |

## Ship (export)

| Feature | Status | Where |
|---|---|---|
| Export units to the game, checks, build record | ok | Ship step |
| A unit spec says its dynamic class | no UI (`folk: {kind}` exists) | Ship step → unit card → Class select |
| Manifest with the pick program and goldens the game reproduces | ok | Automatic |
| Atomic, skip-unchanged writes | ok | Automatic |

## Parts coming in from the gear tool

| Feature | Status | Where |
|---|---|---|
| Incoming finished parts, clothes, hair: accept into a set, see what's new | missing | A new **Incoming** drawer (badge with the count in the top bar) |
| Replace a piece's model keeping its placement | ok (server) | Incoming → "replace" |
| Forge board, generation stages | **remove** | Top-bar Forge button goes; the gear tool owns generation (its backend can move there) |

## Jobs, speed, caches, QoL

| Feature | Status | Where |
|---|---|---|
| One GPU queue (rig, skin optimizer, Qwen paint) | ok | Activity drawer: list with progress, reorder, cancel |
| No stale caches (files by content hash, server pushes changes) | ok | Automatic |
| Dressing clicks instant (outfit, skin, randomize) | ok (0 ms) | Automatic |
| Character load without stalls | partial (1.5 s first load, 0.4 s switch in headless) | Viewer, Stage |
| Speed budgets enforced (`npm run perf`) | ok | Run before merging |
| Undo/redo everywhere, with a toast | ok (not in Motion, which has its own) | Ctrl+Z / Ctrl+Shift+Z |
| Visible keyboard hints (not just a `?` sheet) | partial | Hint chips on every button that has a key |
| Search in every list | partial (Wardrobe only) | Character list, Gear list, Library, Sets, Classes |
| Right-click menus on rows | missing | Gear list, sets, classes, library |
| Remembered per-character view state | ok | Automatic |
| Every UI change opened in a real browser before merge | process | Done check for every change |

## Order (proposed)

1. The three regressions: piece selection, Shown toggle, Cancel beside Bind.
2. Make what exists visible: Wardrobe and Crowd buttons, key hints, search in the Gear list.
3. Dynamic classes tab + Class section (sets with weights, pools, culture) + "worn by" on sets + Ship's class select.
4. Library organization (search, sort, group, filters, list view).
5. Clothes section (layers, slots, shorts cut, all-skins preview) + Skins section + bare skins.
6. Coverage view.
7. Stances in Motion + "Dressed as".
8. Incoming drawer; remove the Forge button.
9. Character-load stalls.
