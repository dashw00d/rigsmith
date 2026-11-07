<script lang="ts">
  // The character's gear, grouped by swap set (one piece of a set shows at a time): each piece's name, where it is
  // worn, where it came from, and its import state; show or hide it, remove it (asked first), pick it to open it.
  import { CircleAlert, Eye, EyeOff, LoaderCircle, Trash2 } from '@lucide/svelte'
  import type { Character, Gear } from '../../state/api.ts'
  import { meshNameOf, SWAPPED } from '../../engine/contract.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import Badge from '../../ui/Badge.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { originOf, swapGroups, wearText } from './text.ts'
  import { untrack } from 'svelte'
  import { wardrobe } from './wardrobe.svelte.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import { setsWith } from '../../state/dressing.ts'

  let { character }: { character: Character } = $props()

  // Restore once per character. A later explicit deselection is also remembered.
  $effect(() => {
    const id = character.id
    untrack(() => {
      const want = wardrobe.view(id).selected ?? null
      if (gearState.selectionFor !== id || gearState.selected === null) {
        gearState.select(want !== null && character.gear.some(g => g.id === want) ? want : null)
      }
    })
  })
  $effect(() => {
    const selected = gearState.selected
    const owner = gearState.selectionFor
    const id = character.id
    untrack(() => {
      if (owner === id && selected !== (wardrobe.view(id).selected ?? null)) wardrobe.update(id, { selected })
    })
  })

  // (a dynamic character: only the outfit and the hair and beard on stage are listed; the Folk pickers switch them)
  const listed = $derived(character.gear.filter(g => {
    const sets = setsWith(character, g)
    if (sets.length > 0) return sets.includes(dress.worn(character).outfit ?? '') || dress.of(character.id)?.off?.includes(g.id) === true
    if (g.role !== undefined) return gearState.shownOnStage(character, g) || dress.of(character.id)?.off?.includes(g.id) === true
    return true
  }))
  const groups = $derived(swapGroups(listed))

  function hiddenHint (g: Gear): string {
    if (gearState.shownOnStage(character, g)) return g.swapSet !== undefined ? `Shown (showing another of ${g.swapSet} hides it)` : 'Shown'
    // (the game swaps its Gear*, Head* and Wear* pieces itself: they go into the export hidden)
    return SWAPPED.test(meshNameOf(g)) ? 'Hidden here; the game still gets it and switches it itself' : 'Hidden: not shown, not exported'
  }
</script>

{#each groups as group (group.set ?? '')}
  {#if group.set !== null}
    <div class="set-head" use:tooltip={'A swap set: showing one of it hides the others'}>{group.set} <span class="count">{group.gear.length}</span></div>
  {/if}
  <ul>
    {#each group.gear as g (g.id)}
      {@const origin = originOf(g)}
      {@const shown = gearState.shownOnStage(character, g)}
      <li class:selected={gearState.selected === g.id} class:hidden={!shown}>
        <button class="row" data-testid="gear-row" data-id={g.id} data-hidden={!shown} onclick={() => gearState.select(gearState.selected === g.id ? null : g.id)} aria-pressed={gearState.selected === g.id}>
          <span class="name">{g.name}</span>
          <span class="detail">
            {#if g.status === 'importing'}<LoaderCircle size={12} class="spin" /> importing
            {:else if g.status === 'error'}<span class="failed" use:tooltip={g.error ?? 'The import failed'}><CircleAlert size={12} /> failed</span>
            {:else}{wearText(g)}{/if}
          </span>
        </button>
        {#if origin !== 'upload'}
          <span class="origin" use:tooltip={origin === 'game' ? `The game's own part (${g.from})` : 'From the catalog'}>
            <Badge tone={origin === 'game' ? 'accent' : 'muted'}>{origin}</Badge>
          </span>
        {/if}
        <IconButton size="sm" data-testid="gear-eye" data-id={g.id} label="{shown ? 'Hide' : 'Show'} {g.name}" hint={hiddenHint(g)}
          onclick={() => gearState.toggleShown(character, g)}>
          {#if !shown}<EyeOff size={13} />{:else}<Eye size={13} />{/if}
        </IconButton>
        <IconButton size="sm" variant="danger" label="Remove {g.name}" onclick={() => gearState.remove(character, g)}><Trash2 size={13} /></IconButton>
      </li>
    {/each}
  </ul>
{/each}

<style>
  ul { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; gap: 2px; padding-right: 4px; border-radius: var(--r-1); border: 1px solid transparent; }
  li:hover { background: var(--bg-2); }
  li.selected { background: var(--accent-soft); border-color: rgb(142 162 255 / 30%); }
  li.hidden .name { color: var(--text-3); }
  .row { flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px; border: 0; background: transparent; text-align: left; color: inherit; }
  .name { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { flex: none; display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--text-3); }
  .failed { display: inline-flex; gap: 4px; align-items: center; color: var(--danger); }
  .origin { display: inline-flex; }
  .set-head { margin: 8px 0 2px; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); }
  .count { margin-left: 4px; }
</style>
