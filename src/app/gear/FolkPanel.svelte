<script lang="ts">
  // A dynamic character (engine/folk.ts): one body every unit of a kind shares, dressed per unit. Swatches for each slot
  // of the dress on stage (a set, a skin, clothes, hair, a beard), each marked with what the game's pick engine
  // (engine/folkpick.ts) says of it under the rest of the dress: a choice it would never make is greyed, the reason in
  // its tooltip. Randomize draws a new unit from the engine (the locked slots kept), and the unit number shows exactly
  // the unit the game would dress with it. Browsing is the stage's own (state/dress.svelte.ts): nothing is saved,
  // journaled or undone until "Make default" makes the look on stage the character's own.
  import { Dices, Lock, LockOpen, RotateCcw, Shirt, ChevronLeft, ChevronRight, ChevronDown } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import type { DressField } from '../../state/dressing.ts'
  import { setsOf } from '../../model/folk.ts'
  import Button from '../../ui/Button.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import Thumb from './Thumb.svelte'
  import { wardrobe, worldFor } from './wardrobe.svelte.ts'
  import { categoryOf, choicesFor, label, type Category, type Choice } from './wardrobe.ts'

  let { character }: { character: Character } = $props()

  const world = $derived(worldFor(character))
  const worn = $derived(dress.worn(character))
  const changed = $derived(dress.differs(character))
  const choices = $derived({
    outfit: choicesFor(character, world, worn, 'outfit'),
    skin: choicesFor(character, world, worn, 'skin'),
    clothing: choicesFor(character, world, worn, 'clothing'),
    hair: choicesFor(character, world, worn, 'hair'),
    beard: choicesFor(character, world, worn, 'beard'),
  })
  const skins = $derived(new Map((character.look.skins ?? []).map(k => [k.name, k])))
  const setCategory = $derived(new Map(setsOf(character).map(s => [s.name, categoryOf(s)])))
  const categories = $derived([...new Set(setCategory.values())].sort())
  // (the category shown: the worn set's until another is picked)
  let browsing = $state<Category | null>(null)
  const category = $derived(browsing ?? (worn.outfit === null ? undefined : setCategory.get(worn.outfit)) ?? categories[0] ?? null)
  const setsShown = $derived(choices.outfit.filter(x => setCategory.get(x.value) === category))
  const unit = $derived(wardrobe.unit(character))
  let typed = $state('')
  $effect(() => { typed = unit === null ? '' : String(unit.uid) })

  let saving = $state(false)
  async function makeDefault (): Promise<void> {
    saving = true
    try { await dress.makeDefault(character) } finally { saving = false }
  }

  function showTyped (): void {
    const n = Number(typed)
    if (Number.isInteger(n) && n >= 0) wardrobe.showUnit(character, n)
    else typed = unit === null ? '' : String(unit.uid)
  }

  const hint = (x: Choice): string => (x.ok ? `${x.label}${x.share > 0 ? ` (${Math.round(x.share * 100)}% of units)` : ''}` : `${x.label}: ruled out, ${x.why ?? 'never picked'}`)
  const open = (section: string): boolean => !wardrobe.isClosed(character.id, section)
</script>

{#snippet lock(field: DressField)}
  {@const on = dress.locked(character.id, field)}
  <IconButton size="sm" active={on} label={on ? 'Kept by Randomize' : 'Randomize picks it'}
    onclick={() => { dress.toggleLock(character, field) }}>
    {#if on}<Lock size={12} />{:else}<LockOpen size={12} />{/if}
  </IconButton>
{/snippet}

{#snippet head(field: DressField, title: string, value: string, keys: string)}
  <div class="head">
    <button class="toggle" aria-expanded={open(field)} onclick={() => { wardrobe.toggleSection(character.id, field) }}>
      <ChevronDown size={12} class={open(field) ? '' : 'shut'} /> <span class="title">{title}</span>
      <span class="value">{value}</span>
    </button>
    <span class="keys" use:tooltip={`Keys: ${keys}`}>{keys}</span>
    {@render lock(field)}
  </div>
{/snippet}

{#snippet none(field: DressField)}
  <button class="chip" class:on={worn[field] === null} aria-pressed={worn[field] === null} onclick={() => { wardrobe.set(character, field, null) }}>None</button>
{/snippet}

<div class="folk">
  {#if choices.outfit.length > 0}
    <div class="slot">
      {@render head('outfit', 'Set', worn.outfit === null ? 'none' : label(worn.outfit), '[ ]')}
      {#if open('outfit')}
        <div class="cats" role="tablist" aria-label="Kind of set">
          {#each categories as k (k)}
            <button role="tab" aria-selected={category === k} class:active={category === k} onclick={() => { browsing = k }}>{k}</button>
          {/each}
        </div>
        <div class="chips">
          {#each setsShown as x (x.value)}
            <button class="chip" class:on={worn.outfit === x.value} class:out={!x.ok} aria-pressed={worn.outfit === x.value}
              use:tooltip={hint(x)} onclick={() => { wardrobe.set(character, 'outfit', x.value) }}>{x.label.replace(/^(arm|hat|hood|coif|hair) /, '')}</button>
          {/each}
          {@render none('outfit')}
        </div>
        <div class="row">
          <IconButton size="sm" label="Previous set" hint="Previous set ([)" onclick={() => { browsing = null; wardrobe.step(character, 'outfit', -1) }}><ChevronLeft size={13} /></IconButton>
          <IconButton size="sm" label="Next set" hint="Next set (])" onclick={() => { browsing = null; wardrobe.step(character, 'outfit', 1) }}><ChevronRight size={13} /></IconButton>
          <span class="grow"></span>
          <Button size="sm" variant={app.drawer === 'wardrobe' ? 'primary' : 'ghost'} onclick={() => { app.toggleDrawer('wardrobe') }} title="Every set, skin, clothes, hair, beard and piece, with pictures (W)">
            <Shirt size={13} /> Wardrobe</Button>
        </div>
      {/if}
    </div>
  {/if}

  {#if choices.skin.length > 0}
    <div class="slot">
      {@render head('skin', 'Skin', worn.skin === null ? 'its own' : choices.skin.find(x => x.value === worn.skin)?.label ?? worn.skin, 'Shift [ ]')}
      {#if open('skin')}
        <div class="swatches">
          {#each choices.skin as x (x.value)}
            {@const k = skins.get(x.value)}
            {@const tags = k?.tags ?? []}
            <button class="face" class:on={worn.skin === x.value} class:out={!x.ok} aria-pressed={worn.skin === x.value} aria-label={x.label}
              style:--ring={k?.hair ?? 'var(--line-strong)'} use:tooltip={`${hint(x)}${tags.length > 0 ? ` · ${tags.join(', ')}` : ''}`}
              onclick={() => { wardrobe.set(character, 'skin', x.value) }}>
              <Thumb {character} ask={{ kind: 'skin', name: x.value }}><span class="initial">{x.label.slice(0, 1)}</span></Thumb>
              {#if tags.includes('female')}<span class="mark f" aria-hidden="true">♀</span>{/if}
              {#if tags.includes('elderly')}<span class="mark e" aria-hidden="true">e</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if choices.clothing.length > 0}
    <div class="slot">
      {@render head('clothing', 'Clothes', worn.clothing === null ? "the skin's own" : label(worn.clothing), ', .')}
      {#if open('clothing')}
        <div class="swatches">
          {#each choices.clothing as x (x.value)}
            <button class="cloth" class:on={worn.clothing === x.value} class:out={!x.ok} aria-pressed={worn.clothing === x.value} aria-label={x.label}
              use:tooltip={hint(x)} onclick={() => { wardrobe.set(character, 'clothing', x.value) }}>
              <Thumb {character} ask={{ kind: 'clothes', name: x.value }}><span class="initial">{x.label.slice(0, 2)}</span></Thumb>
            </button>
          {/each}
          <button class="cloth none" class:on={worn.clothing === null} aria-pressed={worn.clothing === null} use:tooltip={"The skin's own"}
            onclick={() => { wardrobe.set(character, 'clothing', null) }}>–</button>
        </div>
      {/if}
    </div>
  {/if}

  {#each [['hair', 'Hair'], ['beard', 'Beard']] as const as [field, title] (field)}
    {#if choices[field].length > 0}
      <div class="slot">
        {@render head(field, title, worn[field] === null ? 'none' : choices[field].find(x => x.value === worn[field])?.label ?? '?', '')}
        {#if open(field)}
          <div class="chips">
            {@render none(field)}
            {#each choices[field] as x (x.value)}
              <button class="chip" class:on={worn[field] === x.value} class:out={!x.ok} aria-pressed={worn[field] === x.value}
                use:tooltip={hint(x)} onclick={() => { wardrobe.set(character, field, x.value) }}>{x.label}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}

  <div class="actions">
    <Button size="sm" variant="ghost" onclick={() => { wardrobe.randomize(character) }} title="A new unit as the game would dress it (R): the locked slots kept">
      <Dices size={13} /> Randomize</Button>
    <label class="uid" use:tooltip={unit?.changed === true ? 'Changed by hand since; Enter shows the unit again' : 'Exactly the unit the game dresses with this number'}>
      <span>Unit #</span>
      <input type="text" inputmode="numeric" bind:value={typed} size="6" aria-label="Unit number"
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); showTyped() } else if (e.key === 'Escape') typed = unit === null ? '' : String(unit.uid) }}
        onblur={() => { if (typed !== (unit === null ? '' : String(unit.uid))) showTyped() }} />
      {#if unit?.changed === true}<span class="edited">edited</span>{/if}
    </label>
    {#if changed}
      <Button size="sm" variant="ghost" onclick={() => { dress.reset(character) }} title="Back to the character's own look">
        <RotateCcw size={13} /> Its own</Button>
      <Button size="sm" variant="secondary" disabled={saving} onclick={makeDefault}
        title="Make this look the character's own: its thumbnail, and what the game shows a unit with no pick of its own (one undo)">
        Make default</Button>
    {/if}
  </div>
</div>

<style>
  .folk { display: flex; flex-direction: column; gap: 8px; }
  .slot { display: flex; flex-direction: column; gap: 5px; }
  .head { display: flex; align-items: center; gap: 4px; min-height: 22px; }
  .toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; padding: 0; border: 0; background: transparent; color: var(--text-2); text-align: left; font-size: 12px; }
  .toggle :global(.shut) { transform: rotate(-90deg); }
  .title { font-weight: 600; color: var(--text-1); }
  .value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
  .keys { font-size: 10.5px; color: var(--text-3); font-family: var(--mono, monospace); }
  .row { display: flex; align-items: center; gap: 4px; }
  .grow { flex: 1; }
  .cats { display: flex; flex-wrap: wrap; gap: 3px; }
  .cats button { height: 20px; padding: 0 7px; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--text-3); font-size: 11px; }
  .cats button:hover { color: var(--text-1); }
  .cats button.active { background: var(--bg-3); color: var(--text-1); border-color: var(--line-strong); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { height: 24px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-2); font-size: 11.5px; white-space: nowrap; }
  .chip:hover { border-color: var(--line-strong); color: var(--text-1); }
  .chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--text-1); }
  .out { opacity: 0.38; }
  .out:hover { opacity: 0.7; }
  .swatches { display: flex; flex-wrap: wrap; gap: 5px; }
  .face { position: relative; width: 34px; height: 34px; padding: 0; border-radius: 50%; border: 2px solid var(--ring); background: radial-gradient(circle at 50% 40%, #3a3f4c, #1b1e26); overflow: visible; }
  .face :global(.thumb) { border-radius: 50%; }
  .face.on { box-shadow: 0 0 0 2px var(--bg-1), 0 0 0 4px var(--accent); }
  .face:hover { transform: translateY(-1px); }
  .mark { position: absolute; display: grid; place-items: center; width: 13px; height: 13px; border-radius: 50%; font-size: 9px; font-weight: 700; line-height: 1; background: var(--bg-1); box-shadow: 0 0 0 1px var(--line-strong); pointer-events: none; }
  .mark.f { right: -4px; top: -4px; color: #f2a0c4; }
  .mark.e { right: -4px; bottom: -4px; color: var(--text-2); }
  .initial { font-size: 11px; font-weight: 600; color: var(--text-2); text-transform: uppercase; }
  .cloth { width: 38px; height: 38px; padding: 0; border-radius: 7px; border: 1px solid var(--line); background: var(--bg-2); overflow: hidden; color: var(--text-3); }
  .cloth:hover { border-color: var(--line-strong); }
  .cloth.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-top: 2px; }
  .uid { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-3); }
  .uid input { width: 58px; height: 24px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-1); font: inherit; font-variant-numeric: tabular-nums; }
  .uid input:focus { outline: none; border-color: var(--accent); }
  .edited { font-size: 10.5px; color: var(--warn, #e0b252); }
</style>
