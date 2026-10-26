<script lang="ts">
  // Fix weights: paint on the body as it stands (pause a test clip on the frame that shows the problem).
  // src/state/paint.svelte.ts, src/engine/weightpaint.ts.
  import { onDestroy } from 'svelte'
  import { Brush, Eraser, Paintbrush, RotateCcw, Save, Sparkles, Waves } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { api } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { paint, type PaintTool } from '../../state/paint.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let { character }: { character: Character } = $props()

  const bones = $derived(viewer.character?.skeleton?.bones.map(b => b.name).filter(n => !/end|leaf|tip$/i.test(n)) ?? [])
  $effect(() => { void viewer.character; paint.sync() })
  $effect(() => { if (paint.active && paint.bone === null && bones.length > 0) paint.bone = bones[0] })
  onDestroy(() => paint.setActive(false))

  const tools: Array<{ id: PaintTool, label: string, hint: string }> = [
    { id: 'area', label: 'Heal', hint: 'Mark the problem skin (Alt to unmark), then Heal: its weights refilled smoothly from the good skin round it (skin pulled by a wrong bone goes with what surrounds it)' },
    { id: 'add', label: 'Add', hint: 'Give the brushed skin more of the bone' },
    { id: 'remove', label: 'Remove', hint: 'Take the bone off the brushed skin (its share goes to its other bones)' },
    { id: 'smooth', label: 'Smooth', hint: "Blend the brushed skin's weights with its neighbours'" },
  ]
  async function forget (): Promise<void> {
    await api.forgetWeights(character.id)
    app.toast('ok', 'Painted weights forgotten: the next rig makes them afresh')
  }
</script>

<Section title="Fix weights">
  <Button block variant={paint.active ? 'ghost' : undefined} onclick={() => paint.setActive(!paint.active)}>
    <Paintbrush size={14} /> {paint.active ? 'Done painting' : 'Paint weights'}
  </Button>
  {#if paint.active}
    <p class="faint small">Pause a test clip on the frame that shows the problem, then paint on the body. Left-drag on the body paints; off it the camera turns.</p>
    <div class="tools">
      {#each tools as t}
        <button class:on={paint.tool === t.id} onclick={() => { paint.tool = t.id; paint.refreshView() }} use:tooltip={t.hint}>
          {#if t.id === 'area'}<Sparkles size={12} />{:else if t.id === 'add'}<Brush size={12} />{:else if t.id === 'remove'}<Eraser size={12} />{:else}<Waves size={12} />{/if} {t.label}
        </button>
      {/each}
    </div>
    {#if paint.tool === 'add' || paint.tool === 'remove'}
      <label class="field">Bone
        <select value={paint.bone ?? ''} onchange={(e) => { paint.bone = (e.target as HTMLSelectElement).value; paint.refreshView() }}>
          {#each bones as b}<option value={b}>{b}</option>{/each}
        </select>
      </label>
    {/if}
    <label class="field">Brush <input type="range" min="0.01" max="0.15" step="0.005" bind:value={paint.radius} /></label>
    {#if paint.tool !== 'area'}<label class="field">Strength <input type="range" min="0.05" max="1" step="0.05" bind:value={paint.strength} /></label>{/if}
    {#if paint.tool === 'area'}
      <div class="row">
        <Button size="sm" variant="primary" disabled={paint.marked === 0 || paint.busy} onclick={() => paint.heal()}><Sparkles size={13} /> Heal {paint.marked > 0 ? `${paint.marked} points` : 'the area'}</Button>
        <Button size="sm" variant="ghost" disabled={paint.marked === 0} onclick={() => paint.clearArea()}>Clear</Button>
      </div>
    {/if}
    <div class="row">
      <Button size="sm" variant="ghost" onclick={() => paint.undo()}><RotateCcw size={13} /> Undo</Button>
      <Button size="sm" variant="primary" disabled={paint.edited === 0 || paint.busy} onclick={() => paint.save()}><Save size={13} /> Save {paint.edited > 0 ? `${paint.edited} points` : ''}</Button>
    </div>
    <p class="faint small">Saved weights go into the rig and are put back after a re-rig. <button class="link" onclick={forget}>Forget the painting</button></p>
  {/if}
</Section>

<style>
  .small { font-size: 12px; margin: 0; }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; }
  .tools button { display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 9px; border-radius: 13px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .tools button.on { border-color: var(--accent); color: var(--accent-strong); background: var(--accent-soft); }
  .field { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text-2); }
  .field select { max-width: 180px; height: 26px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 12px; }
  .field input[type=range] { width: 160px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .link { border: 0; background: transparent; color: var(--accent-strong); padding: 0; font-size: 12px; }
</style>
