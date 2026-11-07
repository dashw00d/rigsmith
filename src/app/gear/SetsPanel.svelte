<script lang="ts">
  import type { Character } from '../../model/types.ts'
  import Note from '../../ui/Note.svelte'
  import Section from '../../ui/Section.svelte'
  import SetRow from './SetRow.svelte'
  import { setsByCulture } from './sets.ts'
  let { character }: { character: Character } = $props()
  const groups = $derived(setsByCulture(character))
</script>

<Section title="Sets" testid="sets-section">
  {#if character.folk === undefined}<Note>These legacy sets must be migrated before editing.</Note>{/if}
  {#if groups.length === 0}
    <Note>No sets yet.</Note>
  {:else}
    <Note>Drag a piece here, or use Add to set in its menu. Right-click a set for more actions.</Note>
    {#each groups as group (group.culture ?? '')}
      <div class="group" data-testid="sets-culture" data-id={group.culture ?? 'none'}>
        <strong>{group.culture ?? 'No culture'}</strong>
        {#each group.sets as set (set.id)}<SetRow {character} {set} />{/each}
      </div>
    {/each}
  {/if}
</Section>
<style>
  .group { display: flex; flex-direction: column; gap: 6px; }
  strong { font-size: 11px; color: var(--text-3); text-transform: uppercase; }
</style>
