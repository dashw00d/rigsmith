<script lang="ts">
  // The weight view: the viewport in Weights mode, every bone's area in its colour, or one bone's influence picked
  // here (a person's bones by part of the body, a creature's by limb: the skeleton's own, src/model/skeletons.ts).
  import { skeletonSpec } from '../../engine/templates.ts'
  import type { Character } from '../../state/api.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Segmented from '../../ui/Segmented.svelte'
  import { boneLabel, weightChips } from './bones.ts'

  let { character }: { character: Character } = $props()

  let side = $state<'left' | 'right'>('left')
  /** The bone shown (null: every bone). */
  let shown = $state<string | null>(null)
  let shownFor = ''
  $effect(() => { if (character.id !== shownFor) { shownFor = character.id; shown = null } })

  const groups = $derived(weightChips(character, side))
  const spec = $derived(skeletonSpec(character))
  const names = $derived(new Set(spec.bones.map(([b]) => b)))
  const sided = $derived(spec.bones.some(([b]) => spec.side(b) !== 'center'))

  function show (bone: string | null): void {
    shown = bone
    viewer.setMode('weights')
    viewer.character?.setHighlightBone(bone)
  }
</script>

<div class="weights">
  <p class="faint small">The viewport in Weights: every bone's area in its colour, or one bone's influence.</p>
  <div class="row">
    <button class="chip" class:active={viewer.mode === 'weights' && shown === null} onclick={() => { show(null) }}>Every bone</button>
    {#if viewer.mode === 'weights'}<button class="chip" onclick={() => { shown = null; viewer.character?.setHighlightBone(null); viewer.setMode('shaded') }}>Back to shaded</button>{/if}
    <span class="grow"></span>
    {#if sided}<Segmented size="sm" label="Side" options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} bind:value={side} />{/if}
  </div>
  {#each groups as group (group.label)}
    <div class="group">
      <span class="group-label">{group.label}</span>
      <div class="chips">
        {#each group.bones as bone (bone)}
          <button class="chip" class:active={viewer.mode === 'weights' && shown === bone} title={boneLabel(bone, names)} onclick={() => { show(shown === bone ? null : bone) }}>{boneLabel(bone, names).split(' · ')[0]}</button>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .weights { display: flex; flex-direction: column; gap: 10px; }
  .small { font-size: 12px; margin: 0; }
  .row { display: flex; gap: 4px; align-items: center; }
  .grow { flex: 1; }
  .group { display: flex; flex-direction: column; gap: 6px; }
  .group-label { font-size: 11.5px; color: var(--text-3); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
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
