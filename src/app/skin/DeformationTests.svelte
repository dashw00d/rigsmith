<script module lang="ts">
  /** A deformation test: a clip picked for how hard it works a rig's joints (static/templates/tests.json). */
  export interface RigTest { id: string, name: string, url?: string }

  let tests: Promise<Record<string, RigTest[]>> | null = null
  /** The tests per template, loaded once. */
  function load (): Promise<Record<string, RigTest[]>> {
    tests ??= fetch('./templates/tests.json')
      .then(async r => { if (!r.ok) throw new Error(`tests: ${r.status}`); return await r.json() as Record<string, RigTest[]> })
      .catch(() => { tests = null; return {} })
    return tests
  }
</script>

<script lang="ts">
  // The deformation tests: clips that work the rig's joints hard (arms overhead, a deep squat, fists, a horse's gaits),
  // played on it in place and looped, to look for creases, candy-wrapping and skin left behind. The same clips the rig
  // job checks its weights on.
  import { Square } from '@lucide/svelte'
  import { templateInfo } from '../../engine/templates.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import type { Character } from '../../state/api.ts'

  let { character }: { character: Character } = $props()

  let all = $state<Record<string, RigTest[]> | null>(null)
  $effect(() => { void load().then(t => { all = t }) })
  const list = $derived(all?.[character.skeleton.template] ?? [])
  const playing = $derived(animator.playing?.kind === 'test' && animator.playing.characterId === character.id ? animator.playing : null)
</script>

{#if all === null}
  <p class="faint small">Loading the tests…</p>
{:else if list.length === 0}
  <p class="faint small">There are no deformation tests for the {templateInfo(character.skeleton.template).label.toLowerCase()} yet.</p>
{:else}
  <div class="chips">
    {#each list as t (t.id)}
      <button class="chip" class:active={playing?.ref?.id === t.id} onclick={() => { void animator.playTest(t) }}>{t.name}</button>
    {/each}
    {#if playing !== null}<button class="chip" onclick={() => { void animator.stop() }}><Square size={10} /> Stop</button>{/if}
  </div>
  <p class="faint small">Watch the joints for creases, candy-wrapping and skin left behind; pause and scrub on the timeline to look closer, or to paint on that frame.</p>
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
