<script lang="ts">
  // This character's whole set of clips copied onto others of the same skeleton (asked first, listing them): fresh
  // ids, adjustments that name gear mapped onto their gear of the same name, what has no match there dropped and
  // journaled on them. Each one's own set is replaced (Undo in its Activity brings it back).
  import { Copy } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { phaseOf } from '../../model/select.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'

  let { character }: { character: Character } = $props()

  const others = $derived(app.characters.filter(c => c.id !== character.id && c.skeleton.template === character.skeleton.template &&
    phaseOf(c).phase === 'rigged'))
  let chosen = $state<string[]>([])
  let busy = $state(false)
  const targets = $derived(others.filter(c => chosen.includes(c.id)))

  function flip (id: string, on: boolean): void {
    chosen = on ? [...chosen.filter(x => x !== id), id] : chosen.filter(x => x !== id)
  }

  async function copy (): Promise<void> {
    busy = true
    try {
      if (await slots.copyTo(character, targets) > 0) chosen = []
    } finally {
      busy = false
    }
  }
</script>

{#if others.length > 0 && character.clips.length > 0}
  <Section>
  <details class="copy">
    <summary><Copy size={13} /> Copy this set to other characters</summary>
    <p class="faint small">Their own clips are replaced by these {character.clips.length}, adjustments included (gear by its name).</p>
    <div class="list" role="group" aria-label="Characters to copy to">
      {#each others as c (c.id)}
        <label class="who">
          <input type="checkbox" checked={chosen.includes(c.id)} onchange={(e) => flip(c.id, e.currentTarget.checked)} />
          <span>{c.name}</span>
          <span class="faint">{c.clips.length} clip{c.clips.length === 1 ? '' : 's'}</span>
        </label>
      {/each}
    </div>
    <div class="row">
      <Button size="sm" variant="ghost" onclick={() => { chosen = chosen.length === others.length ? [] : others.map(c => c.id) }}>{chosen.length === others.length ? 'None' : 'All'}</Button>
      <Button size="sm" disabled={targets.length === 0 || busy} loading={busy} onclick={copy}>Copy to {targets.length || ''} {targets.length === 1 ? 'character' : 'characters'}</Button>
    </div>
  </details>
  </Section>
{/if}

<style>
  .copy { display: flex; flex-direction: column; gap: 6px; }
  summary { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-2); font-size: 12.5px; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--text-1); }
  .small { margin: 6px 0 4px; font-size: 12px; }
  .list { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow: auto; }
  .who { display: flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 2px 0; }
  .who span:nth-child(2) { flex: 1; }
  .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
</style>
