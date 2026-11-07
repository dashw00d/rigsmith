<script lang="ts">
  import { untrack } from 'svelte'
  import { Dices, RotateCcw } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import { classes } from '../../state/classes.svelte.ts'
  import { kindsOf } from '../../model/folk.ts'
  import { cultures } from '../../model/classes.ts'
  import { tagSetsByCulture } from '../classes/edit.ts'
  import Select from '../../ui/Select.svelte'
  import Button from '../../ui/Button.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { wardrobe } from './wardrobe.svelte.ts'
  let { character }: { character: Character } = $props()
  const changed = $derived(dress.differs(character))
  const unit = $derived(wardrobe.unit(character))
  const context = $derived(wardrobe.ctx(character))
  const kinds = $derived(kindsOf(character))
  const cultureOptions = $derived(cultures(character))
  const tagCommands = $derived(character.folk === undefined ? [] : tagSetsByCulture(character))
  let openedKey = ''
  $effect(() => {
    const id = character.id
    const opened = classes.openId
    const key = `${id}:${opened ?? ''}`
    if (key === openedKey) return
    openedKey = key
    if (opened !== null) untrack(() => { wardrobe.setKind(character, opened) })
  })
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
</script>
  <div class="actions">
    <Button size="sm" variant="ghost" keys="dress.randomize" onclick={() => { wardrobe.randomize(character) }} title="A new unit as the game would dress it (R): the locked slots kept">
      <Dices size={13} /> Randomize</Button>
    <label class="picker"><span>Class</span><Select label="Class" testid="kind-select" size="sm" value={context.kind ?? ''}
      options={[{ value: '', label: 'Any' }, ...kinds.map(k => ({ value: k.id, label: k.name }))]}
      onchange={(value) => { wardrobe.setKind(character, value || null) }} /></label>
    <label class="picker"><span>Culture</span><Select label="Culture" testid="culture-select" size="sm" value={context.tags[0]?.slice('culture:'.length) ?? ''}
      options={[{ value: '', label: 'Any' }, ...cultureOptions.map(x => ({ value: x.value, label: x.value }))]}
      onchange={(value) => { wardrobe.setCulture(character, value || null) }} /></label>
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
  {#if tagCommands.length > 0}
    <div class="tag-hint">Some sets have culture in their names but no culture tag.
      <Button size="sm" variant="ghost" onclick={() => { void wardrobe.run(character, tagCommands, 'Sets tagged from names') }}>Tag {tagCommands.length} sets from their names</Button>
    </div>
  {/if}
<style>
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-top: 2px; }
  .picker { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-3); }
  .tag-hint { color: var(--text-3); font-size: 11px; }
  .uid { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-3); }
  .uid input { width: 58px; height: 24px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-1); font: inherit; font-variant-numeric: tabular-nums; }
  .uid input:focus { outline: none; border-color: var(--accent); }
  .edited { font-size: 10.5px; color: var(--warn, #e0b252); }
</style>
