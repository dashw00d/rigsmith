<script lang="ts">
  // The character's own animations in the Skin step, as the game plays them (the slot's clip, speed and
  // adjustments): the deformation tests only exercise the joints, and the weights have to hold up in the clips the
  // character actually plays. Pause and scrub on the timeline to paint on a frame, as with a test.
  import { Square } from '@lucide/svelte'
  import { animator } from '../../state/animator.svelte.ts'
  import type { Character } from '../../state/api.ts'

  let { character }: { character: Character } = $props()

  const playing = $derived(animator.playing?.kind === 'slot' && animator.playing.characterId === character.id ? animator.playing : null)
</script>

{#if character.clips.length === 0}
  <p class="faint small">No animations yet: fill its slots in the Motion step.</p>
{:else}
  <div class="chips">
    {#each character.clips as s (s.id)}
      <button class="chip" class:active={playing?.slotId === s.id} onclick={() => { void animator.playSlot(character, s.id) }}>{s.name}</button>
    {/each}
    {#if playing !== null}<button class="chip" onclick={() => { void animator.stop() }}><Square size={10} /> Stop</button>{/if}
  </div>
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border-radius: 12px;
    border: 1px solid var(--line-strong);
    background: var(--bg-2);
    color: var(--text-2);
    font-size: 11.5px;
    font-weight: 500;
  }
  .chip:hover { color: var(--text-1); border-color: var(--text-4); }
  .chip.active { background: var(--accent-soft); color: var(--accent-strong); border-color: rgb(142 162 255 / 40%); }
</style>
