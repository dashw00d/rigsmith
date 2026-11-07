<script lang="ts">
  // The Wardrobe (the Catalog drawer's pattern, from the Gear step, W): a dynamic character's sets, skins, clothes,
  // hair, beards and pieces as tiles with pictures (thumbs.svelte.ts: drawn offscreen while idle, kept by content
  // hash), searched and filtered by chips (culture, category, body part, tag). Resting the pointer on a tile shows it on
  // stage in the dress state (taken back when the pointer leaves), a click keeps it. A tile the pick engine would never
  // give a unit dressed as now is greyed, the reason in its tooltip. The Pieces tab is the pieces list (PiecesList).
  import { untrack } from 'svelte'
  import { Search } from '@lucide/svelte'
  import { app } from '../../state/app.svelte.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import type { DressField } from '../../state/dressing.ts'
  import { isFolk } from '../../engine/folk.ts'
  import Drawer from '../../ui/Drawer.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import PiecesList from './PiecesList.svelte'
  import Thumb from './Thumb.svelte'
  import { thumbs, type ThumbAsk } from './thumbs.svelte.ts'
  import { wardrobe, worldFor } from './wardrobe.svelte.ts'
  import { chipsOf, choicesFor, matches, NO_FILTER, TABS, tilesOf, type Choice, type Filter, type Tab } from './wardrobe.ts'

  const character = $derived(app.selected)
  const folk = $derived(character !== null && isFolk(character))
  const tab = $derived(character === null ? 'sets' : wardrobe.tab(character.id))
  const FIELD: Record<Exclude<Tab, 'pieces'>, DressField> = { sets: 'outfit', skins: 'skin', clothes: 'clothing', hair: 'hair', beards: 'beard' }
  const field = $derived(tab === 'pieces' ? null : FIELD[tab])
  const tiles = $derived(character === null || tab === 'pieces' ? [] : tilesOf(character, tab))
  const chips = $derived(chipsOf(tiles))
  const shown = $derived(tiles.filter(t => matches(t, wardrobe.filter)))
  // (the dress the tiles are judged under: the one kept, not a hover's)
  const pinned = $derived(character === null ? null : wardrobe.pinned(character))
  const rules = $derived(character === null || field === null || pinned === null ? new Map<string, Choice>()
    : new Map(choicesFor(character, worldFor(character), pinned, field).map(x => [x.value, x])))
  const counts = $derived(character === null ? {} : Object.fromEntries(TABS.map(t => [t.id, t.id === 'pieces' ? character.gear.filter(g => g.role === undefined).length : tilesOf(character, t.id).length])))

  // (a new tab or character: its own chips)
  $effect(() => { void tab; void character?.id; untrack(() => { wardrobe.filter = { ...NO_FILTER, search: wardrobe.filter.search } }) })
  // (closing: what waits to be drawn is let go, a hover's preview taken back)
  $effect(() => () => { thumbs.drop(); const c = untrack(() => app.selected); if (c !== null) wardrobe.unpreview(c) })

  function toggle (group: keyof Omit<Filter, 'search'>, v: string): void {
    const now = wardrobe.filter[group]
    wardrobe.filter = { ...wardrobe.filter, [group]: now.includes(v) ? now.filter(x => x !== v) : [...now, v] }
  }

  const ask = (value: string): ThumbAsk => (tab === 'sets' ? { kind: 'set', name: value } : tab === 'skins' ? { kind: 'skin', name: value }
    : tab === 'clothes' ? { kind: 'clothes', name: value } : { kind: tab === 'hair' ? 'hair' : 'beard', id: value })
  const groups: Array<[keyof Omit<Filter, 'search'>, string]> = [['cultures', 'Culture'], ['categories', 'Kind'], ['parts', 'Body part'], ['tags', 'Tag']]
</script>

<Drawer open={app.drawer === 'wardrobe'} onclose={() => app.toggleDrawer('wardrobe')} title="Wardrobe" scrim={false} width="min(560px, 94%)">
  {#if character === null || !folk}
    <EmptyState title="Not a dynamic character" body="The Wardrobe dresses a dynamic character: one body, dressed per unit." compact />
  {:else}
    {@const c = character}
    <div class="top">
      <div class="tabs" role="tablist" aria-label="What to look at">
        {#each TABS as t (t.id)}
          <button role="tab" aria-selected={tab === t.id} class:active={tab === t.id} onclick={() => { wardrobe.setTab(c.id, t.id) }}>
            {t.label} <span class="n">{counts[t.id]}</span></button>
        {/each}
      </div>
      {#if tab !== 'pieces'}
        <label class="search"><Search size={13} />
          <input type="search" placeholder="Search" value={wardrobe.filter.search} aria-label="Search"
            oninput={(e) => { wardrobe.filter = { ...wardrobe.filter, search: e.currentTarget.value } }} /></label>
        {#each groups as [g, name] (g)}
          {#if chips[g].length > 1}
            <div class="chips" aria-label={name}>
              <span class="cname">{name}</span>
              {#each chips[g] as [v, n] (v)}
                <button class:active={wardrobe.filter[g].includes(v)} aria-pressed={wardrobe.filter[g].includes(v)} onclick={() => { toggle(g, v) }}>{v} <span class="n">{n}</span></button>
              {/each}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
    {#if tab === 'pieces'}
      <PiecesList character={c} />
    {:else if field !== null}
      {@const f = field}
      {@const worn = dress.worn(c)}
      <div class="grid" class:faces={tab === 'skins' || tab === 'hair' || tab === 'beards'} onpointerleave={() => { wardrobe.unpreview(c) }} role="listbox" aria-label={TABS.find(t => t.id === tab)?.label} tabindex="-1">
        {#each shown as t (t.value)}
          {@const rule = rules.get(t.value)}
          {@const on = pinned?.[f] === t.value}
          <button class="tile" class:on class:out={rule !== undefined && !rule.ok} class:showing={worn[f] === t.value && !on} role="option" aria-selected={on}
            use:tooltip={rule !== undefined && !rule.ok ? `${t.label}: ruled out, ${rule.why ?? ''}` : t.label}
            onpointerenter={() => { wardrobe.preview(c, { [f]: t.value }, tab === 'sets' ? 260 : 120) }}
            onclick={() => { wardrobe.pin(c, { [f]: t.value }) }}>
            <span class="pic"><Thumb character={c} ask={ask(t.value)}><span class="initial">{t.label.slice(0, 2)}</span></Thumb></span>
            <span class="name">{t.label}</span>
            {#if t.badges.length > 0}
              <span class="badges">{#each t.badges as b (b)}<span class="badge">{b}</span>{/each}</span>
            {/if}
          </button>
        {:else}
          <p class="none">Nothing matches.</p>
        {/each}
      </div>
    {/if}
  {/if}
</Drawer>

<style>
  .top { position: sticky; top: 0; z-index: 3; display: flex; flex-direction: column; gap: 7px; padding: 10px 14px 10px 16px; border-bottom: 1px solid var(--line); background: var(--bg-1); }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; }
  .tabs button, .chips button { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--line-strong); background: transparent; color: var(--text-2); font-size: 12px; font-weight: 500; }
  .chips button { height: 22px; padding: 0 8px; font-size: 11.5px; border-color: var(--line); }
  .tabs button:hover, .chips button:hover { color: var(--text-1); }
  .tabs button.active, .chips button.active { background: var(--text-1); color: var(--bg-0); border-color: var(--text-1); }
  .n { opacity: 0.6; font-variant-numeric: tabular-nums; }
  .search { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-3); }
  .search:focus-within { border-color: var(--accent); }
  .search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text-1); font: inherit; font-size: 12.5px; }
  .search input:focus { outline: none; }
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .cname { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-3); margin-right: 2px; min-width: 64px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 9px; padding: 12px 14px 16px 16px; }
  .grid.faces { grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); }
  .grid:focus { outline: none; }
  .tile { display: flex; flex-direction: column; padding: 0; border-radius: var(--r-2); border: 1px solid var(--line); background: var(--bg-2); overflow: hidden; text-align: left; transition: border-color var(--fast), transform var(--fast); content-visibility: auto; contain-intrinsic-size: auto 170px; }
  .tile:hover { border-color: var(--line-strong); transform: translateY(-1px); }
  .tile.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .tile.showing { border-color: rgb(142 162 255 / 50%); border-style: dashed; }
  .tile.out { opacity: 0.4; }
  .tile.out:hover { opacity: 0.75; }
  .pic { aspect-ratio: 1; background: radial-gradient(circle at 50% 40%, #262c3c, #14171e 75%); }
  .initial { font-size: 16px; font-weight: 600; color: var(--text-3); text-transform: uppercase; }
  .name { padding: 6px 8px 2px; font-size: 12px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badges { display: flex; flex-wrap: wrap; gap: 3px; padding: 2px 7px 7px; }
  .badge { height: 16px; padding: 0 5px; border-radius: 8px; background: var(--bg-3); color: var(--text-3); font-size: 10px; line-height: 16px; white-space: nowrap; }
  .none { grid-column: 1 / -1; margin: 8px 0; font-size: 12.5px; color: var(--text-3); }
</style>
