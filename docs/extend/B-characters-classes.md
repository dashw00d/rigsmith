# Area B: characters list, dynamic classes, culture, Ship class

Words: the UI says **class**; the model says `UnitKind` (`Character.folk.kinds`). A class belongs to one **body**
(a dynamic character, e.g. `folk-v6-0ba482`); the same class name on another body is another class.

## Current state

- Sidebar: `src/app/CharacterList.svelte` has one list, a search box (`:18-24`, name or id only), rename/delete, "Auto-rig all". No tabs, sort or group. Mounted at `App.svelte:115-117`. `Character.updatedAt` exists (`types.ts:45`), unused by the list.
- Nothing in `src/app` reads `kindsOf`/`folk.kinds`. Commands exist and are tested: `folk.kind.add|update|sets|remove` (`commands/folk.ts:425-463`, patches `command-types.ts:154-159,178`).
- The real body `folk-v6-0ba482` has one kind `folk` (`sets: {query: []}`), 35 sets, 4 pools, 0 stances. **No set carries a `culture:` tag**; culture is only in names (`norse_a`, `gael_b`, `wardrobe.ts:13-27 cultureOf`).
- Gear step: "Dynamic character" section (`GearPanel.svelte:120-124`) wraps `FolkPanel.svelte`. Its actions row (`FolkPanel.svelte:167-184`) has Randomize and Unit #.
- **Preview ignores kind and culture.** `wardrobe.randomize` and `showUnit` call `pick(worldFor(c), uid, {fixed})` (`wardrobe.svelte.ts:128-142`): first kind, no `culture:` input. `choicesFor` (`wardrobe.ts:113`) calls `tagsAfter` without kind or inputs. The engine takes both (`folkpick.ts:69-77,155,257`; the set step matches on `culture`, `:41`).
- Ship: `UnitCard.svelte` edits height, budget, levels, clips, draft, companion through `ship.patch` (`ship.svelte.ts:97`, `undefined` deletes a key). `UnitSpec.folk = {kind?, pools?, outfits?, hair?}` exists (`unit.ts:25-30`); `KNOWN` (`UnitCard.svelte:44`) hides `folk` from "Also in its entry", so it can't be seen or set.
- Game: `UnitView.Folk.cs:126-133` picks the kind whose id equals the unit **def id**, else the first; the culture is the owner's.
- `window.__rigsmith` (`main.ts:17`) exposes `app, gear, animator, viewer, dress, assets, perf`: no `ship`, `wardrobe` or `pick`. UI parts exist: `ui/Tabs`, `Segmented`, `Select`, `Section`, `NumberField`.

## Architecture

**Where each thing lives**
- Document (journaled, undoable): `folk.kinds` via the existing commands. No new command or schema change.
- View state (localStorage, never the document): `src/state/classes.svelte.ts` (new): `tab: 'characters'|'classes'`, `view {sort:'name'|'updated', group:'none'|'body'}`, `openId` (the class open in the Gear step, per character), `openClass(characterId, kindId)` (select the body, `app.go('gear')`, set `openId`). Preview inputs `kind?`, `culture?` go in the wardrobe `ViewState` (`wardrobe.svelte.ts`).
- Unit's class: `units.json` `folk.kind` via `ship.patch`.

**Class section placement: the Gear step, after "Dynamic character", shown only while a class is open.** Why: the sets it weighs, the Wardrobe and the dressed viewport are in Gear; Look is textures; a new step breaks "extend, don't redesign". Opening a class also sets the preview class.

**Pure modules (vitest, no DOM)**
- `src/app/list.ts`: `searchCharacters(list, q)`, `sortCharacters(list, 'name'|'updated')` (updated: newest first), `groupCharacters(list, 'body')`. Groups: Dynamic (isFolk), Humanoid (`skeleton.template==='human'`), one per creature template, Not rigged.
- `src/model/classes.ts`: `kindsWearing(c, setId): UnitKind[]` (for area A's "worn by"), `kindSetRows(c, kind)` (sets with weight and matched-by), `cultures(c)`: `culture:*` tags, else `cultureOf` words with `tagged:false`.
- `src/app/classes/edit.ts`: command builders returning `Command[]`: `addClass(c, name)` (slug id, unique via `freeId`, `sets: {query: []}`), `weigh(c, kind, setId, w)`, `listSet`/`unlistSet`, `toQuery(tags)`, `toList(c, kind)` (lossless), `usePool(kind, step, poolId|null)`, `copyPoolFor(c, kind, poolId)`, `tagSetsByCulture(c)` (batch `folk.set.update` tags from names; shares code with area A's Sets editor).

**Contracts for other areas**
- A: `kindsWearing`; `wardrobe.ctx(c) → {kind?, tags}` (pick inputs for Crowd view and Wardrobe tiles).
- D: the Class section's Stance select lists `folk.stances`; D makes them.
- E: stable `data-testid`s: `class-tab`, `class-row` (+`data-kind`), `class-section`, `class-weight-<setId>`, `culture-select`, `kind-select`, `ship-class-select`; `__rigsmith.classes|ship|wardrobe|pick` (added in B1).
- Shared files: `GearPanel.svelte`, `FolkPanel.svelte`, `wardrobe.ts`, `wardrobe.svelte.ts` (A heavily), `main.ts` (E), `UnitCard.svelte`. `types.ts` and `App.svelte` stay untouched.

## Plan

Waves are suggestions; one task is one lane.

**B1: list helpers and class state** (wave 1). Files: `src/app/list.ts`, `src/model/classes.ts`, `src/state/classes.svelte.ts`, `main.ts` (adds `classes, ship, wardrobe, pick` to `__rigsmith`). Deps: none. Tests: `list.test.ts` (search, sort, groups for a folk/human/horse/unrigged mix), `classes.test.ts` (`kindsWearing` for list and query kinds, `cultures`). Check: `npx vitest run src/app/list.test.ts src/model/classes.test.ts && npx tsc --noEmit -p .`

**B2: pure class edits** (wave 1). Files: `src/app/classes/edit.ts` (+test). Deps: none. Tests run builders through `applyCommands` on a folk fixture: unique add id, weigh shows in `kindSets`, `toList` is lossless, `copyPoolFor` leaves other kinds on the old pool. Check: `npx vitest run src/app/classes/edit.test.ts`.

**B3: Ship Class select** (wave 1). Files: `UnitCard.svelte`, `ship/text.ts` (`classChoices(owner, spec)`, `classNote`), test. Deps: none. Select "Any" + the owner's kinds, shown when the owner `isFolk` and `row.role==='unit'`; writes `folk: {...spec.folk, kind}` (Any: drops only `kind`, drops `folk` if then empty); an id not in the kinds shows a danger chip like a missing clip; a warn note when the unit name differs from the kind id (game picks by def id); "Open class" link calls `classes.openClass`. E2E `ship-class`: Ship step, select "Spearman" in `ship-class-select`, assert `__rigsmith.ship.spec(unit).folk.kind === 'spearman'` and `folk.pools` kept; choose Any, assert `kind` gone. Check: `npx vitest run src/app/ship && npm run e2e -- ship-class`.

**B4: sidebar tabs, search, sort, group** (wave 2). Files: `CharacterList.svelte` (rows into `CharacterRows.svelte`), stub `ClassList.svelte`. Deps: B1. `Tabs` "Characters | Dynamic classes" (counts); search keeps name/id; sort and group are two small `Select`s, remembered; group headers collapse. Rig-all footer only on the Characters tab. E2E `character-list`: type "folk" in search, assert only matching `[data-testid=character-row]`; sort Updated, assert DOM order equals `app.characters` sorted by `updatedAt`; group by body, assert headers; reload, assert the choices persist. Check: `npm run e2e -- character-list`.

**B5: Dynamic classes tab** (wave 2). Files: `ClassList.svelte`, `ClassRow.svelte`. Deps: B1, B2, B4 (stub). One header per body (thumbnail, name, "dynamic character"), so a class reads as that body's; rows: name, "N of M sets" or "every set", units using it (from `ship.unitsOf`, `ship.load()` on mount). Add class (inline name + Enter), rename, remove (confirm, toast Undo), search. A body with `folk` undefined shows "Not migrated" and no Add. Click a row: `classes.openClass`. E2E `classes-tab`: click the tab, assert header "Folk V6" and row `folk`; add "Spearman", assert row and `folk.kinds` length 2; reload app state, remove it, assert gone and Undo toast restores; click row, assert step is Gear and `class-section` exists. Check: `npm run e2e -- classes-tab`.

**B6: Class section** (wave 2, after B2). Files: `src/app/gear/ClassSection.svelte`, `GearPanel.svelte` (one block). Deps: B1, B2. Contents: name, tags; **Wears**: `Segmented` Listed | By tags. Listed: rows (set, chips culture/category, weight `NumberField` 0-10, remove), "Add set" select; commit on release = one command = one undo. By tags: tag input (validated like `folkTags`), "matches 12 of 35" with the list. **Pools**: one row per program step (skin, bottom, top, over, hair, beard, accessory): Default or a pool; with item counts. **Stance**: Select (or "no stances yet"). Close button clears `openId`. E2E `class-sets`: open class, set the weight of one set to 0 through `class-weight-<setId>`, assert `folk.kinds[..].sets` entry weight 0; switch to By tags with `culture:norse`, assert the match count equals norse-tagged sets; Undo restores.

**B7: pool editing for a class** (wave 3). Files: `src/app/gear/ClassPools.svelte`. Deps: B6. Expands a pool row: item checkboxes and weights via `folk.pool.items`; if other classes use that pool, a notice "Shared with Villager" and "Make a copy for Spearman" (`copyPoolFor`). E2E `class-pools`: open class, copy the skin pool, uncheck one skin, then `Unit #` 1..200 via `__rigsmith.wardrobe.showUnit` never shows it, and the other class still can (assert with the pick engine in page: `__rigsmith.pick`).

**B8: culture and class in the preview** (wave 3, after A's `FolkPanel`/`wardrobe*` changes land). Files: `FolkPanel.svelte`, `wardrobe.svelte.ts` (`ctx`, `setKind`, `setCulture`; `randomize`/`showUnit` pass `{kind, tags:['culture:x']}`), `wardrobe.ts` (`choicesFor(..., ctx)`, `tagsAfter` with kind and inputs), `src/model/classes.ts`. Selects "Class" and "Culture" (Any + `cultures(c)`) sit beside Randomize (`kind-select`, `culture-select`); stored per character. Untagged sets (today's data): a hint and a "Tag N sets from their names" button (`tagSetsByCulture`, one undo). Tests: `wardrobe.test.ts`: culture `gael` over uids 1..300 never picks a `culture:norse` set; kind with a listed set never picks another; `choicesFor` marks norse sets out with "not culture:gael" under gael. E2E `culture-preview`: click "Tag sets from names", pick Culture gael, press Randomize 12 times, assert the pressed Set chip never starts with another culture's word; choose Class Spearman and assert the pressed set is in its list. Check: `npx vitest run src/app/gear && npm run e2e -- culture-preview`.

Every UI task also runs svelte-check and eslint on its files.

## Risks and open questions

1. **Kind id vs game def id.** The game picks by the unit's def id and ignores `spec.folk.kind` (`UnitView.Folk.cs:126`); the export uses `folk.kind` only to scope the file. A class named "Spearman" (`spearman`) works only for the def `spearman`. B3 warns; the designer decides whether the Add-class field should say "use the game's unit id" (planned: yes) or the game should read the spec's kind.
2. **Culture does nothing on today's data** (no `culture:` tags). B8's tag button fixes it; area A's Sets editor owns tags long term. Sets naming no culture (`arm_*`, `hat_*`) stay valid for all.
3. **Unmigrated bodies.** `folk.kind.add` on a character without `folk` would create an empty section and drop the legacy-derived sets. B5 hides Add there. This area adds no schema, so `migrate --dry-run --check` must equal the baseline.
4. **`updatedAt` noise.** Jobs bump it, so "Updated" order can jump; label it "Last changed".
5. **Tag-query classes** use each set's own weight; per-class weights need Listed mode (the UI says so and offers `toList`).
6. **Merge pressure** on `FolkPanel`, `wardrobe*.ts`, `GearPanel` from area A: B8 goes last; B6 mounts with one block in `GearPanel`.
7. Copying a class to another body is out (features.md "Later").
