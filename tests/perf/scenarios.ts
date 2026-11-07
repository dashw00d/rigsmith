// What `npm run perf` (tools/perf.ts) does in the app, each measured for its longest main-thread task against
// tests/perf/budget.json: the first load of a character, then the clicks a designer makes most while dressing one
// (outfits, back to one just shown, skins, Randomize, the steps, another character and back). Statements run in the page
// with `r` (window.__rigsmith: app, gear, animator, viewer, dress, wardrobe, assets, perf) and `c` (the character selected).
import type { Scenario } from '../../tools/lib/profile.ts'

// (the character's outfits, sorted, and the one after the one on stage)
const sets = 'const sets = [...new Set(c.gear.flatMap(g => g.outfit !== undefined ? [g.outfit] : []))].sort()'
const nextSet = `${sets}; const now = r.dress.worn(c).outfit; const next = sets[(sets.indexOf(now) + 1) % sets.length]`
const skins = 'const skins = (c.look.skins ?? []).map(s => s.name); const at = skins.indexOf(r.dress.worn(c).skin)'

export const scenarios: Scenario[] = [
  { name: 'first load', kind: 'load' },
  { name: 'outfit: the next one', kind: 'click', action: `${nextSet}; if (next !== undefined) r.dress.wearOutfit(c, next)`, times: 4 },
  {
    name: 'outfit: back to the one before',
    kind: 'click',
    setup: `${nextSet}; if (next !== undefined) r.dress.wearOutfit(c, next)`,
    action: `${sets}; const now = r.dress.worn(c).outfit; const prev = sets[(sets.indexOf(now) - 1 + sets.length) % sets.length]; if (prev !== undefined) r.dress.wearOutfit(c, prev)`,
    times: 2,
  },
  { name: 'skin: the next one', kind: 'click', action: `${skins}; if (skins.length > 0) r.dress.setSkin(c, skins[(at + 1) % skins.length])`, times: 4 },
  {
    name: 'Randomize', kind: 'click',
    // The harness adds wardrobe to the dev hook; before integration, import the already-loaded UI module once.
    setup: 'r.wardrobe ??= (await import("/app/gear/wardrobe.svelte.ts")).wardrobe',
    action: 'r.wardrobe.randomize(c)', times: 6,
  },
  { name: 'step: Motion and back to Gear', kind: 'click', action: "await r.app.go('motion'); await new Promise(res => setTimeout(res, 300)); await r.app.go('gear')", times: 2 },
  {
    name: 'another character and back',
    kind: 'click',
    action: 'const other = r.app.characters.find(x => x.id !== c.id); if (other !== undefined) { await r.app.select(other.id); await new Promise(res => { const t = setInterval(() => { if (!r.viewer.loading && r.viewer.shownId === other.id) { clearInterval(t); res(null) } }, 50) }); await r.app.select(c.id) }',
  },
]
