<script lang="ts">
  // The skeleton's joints as chips, a person's by part of the body and a creature's by limb: one side's while mirroring
  // (its partner follows), either side's otherwise. A chip picks the joint in the viewport (it grows there and its name
  // shows). A joint placed by hand is marked, and the picked one can go back to where it was detected.
  import { RotateCcw } from '@lucide/svelte'
  import { jointLabel, skeletonSpec } from '../../engine/templates.ts'
  import type { Character } from '../../state/api.ts'
  import { skeleton } from '../../state/skeleton.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import { jointChips } from './joints.ts'

  let { character }: { character: Character } = $props()

  let side = $state<'left' | 'right'>('left')
  const shownSide = $derived(skeleton.mirror ? 'left' : side)
  const groups = $derived(jointChips(character, shownSide))
  const spec = $derived(skeletonSpec(character))
  const placed = (j: string): boolean => character.skeleton.overrides[j] !== undefined
  // (while mirroring, a right-side joint picked in the viewport lights its left chip)
  const picked = $derived(skeleton.joint === null ? null : skeleton.mirror && spec.side(skeleton.joint) === 'right' ? spec.mirror(skeleton.joint) : skeleton.joint)
  /** The picked joint and, mirroring, its partner: what "back to detected" takes back. */
  const pair = $derived(skeleton.joint === null ? [] : [...new Set([skeleton.joint, ...(skeleton.mirror ? [spec.mirror(skeleton.joint)] : [])])])
  const pairPlaced = $derived(pair.some(placed))
</script>

<div class="chips">
  {#if !skeleton.mirror}
    <Segmented size="sm" label="Side" options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} bind:value={side} />
  {/if}
  {#each groups as group (group.label)}
    <div class="group">
      <span class="group-label">{group.label}</span>
      <div class="grid">
        {#each group.bones as bone (bone)}
          <button class="chip" class:active={picked === bone} class:placed={placed(bone) || (skeleton.mirror && placed(spec.mirror(bone)))}
            disabled={!skeleton.editing} onclick={() => { skeleton.pick(picked === bone ? null : bone) }}>{jointLabel(bone)}</button>
        {/each}
      </div>
    </div>
  {/each}
  {#if skeleton.joint !== null}
    <div class="picked">
      <span><strong>{jointLabel(skeleton.joint)}</strong>{#if spec.side(skeleton.joint) !== 'center'}<span class="faint"> · {spec.side(skeleton.joint)}</span>{/if}
        <span class="faint">{pairPlaced ? ' · placed by hand' : ' · where it was detected'}</span></span>
      {#if pairPlaced}
        <Button size="sm" variant="ghost" onclick={() => { void skeleton.unplace(character, pair) }}><RotateCcw size={13} /> Back to detected</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .chips { display: flex; flex-direction: column; gap: 10px; }
  .group { display: flex; flex-direction: column; gap: 6px; }
  .group-label { font-size: 11.5px; color: var(--text-3); }
  .grid { display: flex; flex-wrap: wrap; gap: 4px; }
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
  .chip:hover:not(:disabled) { color: var(--text-1); border-color: var(--text-4); }
  .chip:disabled { opacity: 0.5; }
  /* (a joint placed by hand: a dot before its name) */
  .chip.placed::before { content: ''; display: inline-block; width: 5px; height: 5px; margin: 0 5px 1px 0; border-radius: 50%; background: var(--accent); vertical-align: middle; }
  .chip.active { background: var(--accent-soft); color: var(--accent-strong); border-color: rgb(142 162 255 / 40%); }
  .picked { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
</style>
