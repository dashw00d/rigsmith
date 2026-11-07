<script lang="ts">
  import { Dices, RotateCcw } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { wardrobe } from './wardrobe.svelte.ts'
  let { character }: { character: Character } = $props()
  const changed = $derived(dress.differs(character))
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
</script>
  <div class="actions">
    <Button size="sm" variant="ghost" keys="dress.randomize" onclick={() => { wardrobe.randomize(character) }} title="A new unit as the game would dress it (R): the locked slots kept">
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
<style>
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-top: 2px; }
  .uid { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-3); }
  .uid input { width: 58px; height: 24px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-1); font: inherit; font-variant-numeric: tabular-nums; }
  .uid input:focus { outline: none; border-color: var(--accent); }
  .edited { font-size: 10.5px; color: var(--warn, #e0b252); }
</style>
