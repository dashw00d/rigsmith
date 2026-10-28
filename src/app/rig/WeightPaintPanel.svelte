<script lang="ts">
  // Fix weights: paint on the body as it stands (pause a test clip on the frame that shows the problem).
  // src/state/paint.svelte.ts, src/engine/weightpaint.ts.
  import { onDestroy } from 'svelte'
  import { Anchor, ArrowUpFromLine, Brush, Eraser, FlipHorizontal2, Layers, Paintbrush, RotateCcw, Save, Sparkles, Waves } from '@lucide/svelte'
  import type { Character, Garment } from '../../state/api.ts'
  import { api } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { paint, type PaintTool } from '../../state/paint.svelte.ts'
  import { PROP_ROOT, pullBoneName } from '../../engine/pulls.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  // (garment: paint one clothing piece of the character, in the Outfit step; else its body)
  let { character, garment = null }: { character: Character, garment?: Garment | null } = $props()

  // (a prop with pulls is painted between its own bone and its pulls': rigid or pulled; else the body's bones)
  const pulled = $derived(garment !== null && garment.mode === 'rigid' && (garment.pulls ?? []).length > 0)
  const bones = $derived(pulled ? [PROP_ROOT, ...(garment!.pulls ?? []).map(p => pullBoneName(garment!.name, p))]
    : viewer.character?.skeleton?.bones.map(b => b.name).filter(n => !/end|leaf|tip$/i.test(n)) ?? [])
  const boneLabel = (b: string): string => b === PROP_ROOT ? 'Rigid (the prop itself)'
    : pulled ? `Pulled by ${(garment!.pulls ?? []).find(p => pullBoneName(garment!.name, p) === b)?.name ?? b}` : b
  // (a bone of another rig left from before: the first of these)
  $effect(() => { if (paint.active && paint.bone !== null && !bones.includes(paint.bone) && bones.length > 0) paint.bone = bones[pulled ? 1 : 0] })
  $effect(() => { void viewer.character; paint.sync() })
  $effect(() => { if (paint.active && paint.bone === null && bones.length > 0) paint.bone = bones[0] })
  onDestroy(() => paint.setActive(false))
  // (another garment picked while painting: paint that one)
  $effect(() => { const id = garment?.id ?? null; if (paint.active && paint.garment !== id) paint.setActive(true, id) })

  const tools: Array<{ id: PaintTool, label: string, hint: string }> = [
    { id: 'area', label: 'Heal', hint: 'Mark the problem skin (Alt to unmark), then Heal: its weights refilled smoothly from the good skin round it (skin pulled by a wrong bone goes with what surrounds it)' },
    { id: 'add', label: 'Add', hint: 'Give the brushed skin more of the bone' },
    { id: 'remove', label: 'Remove', hint: 'Take the bone off the brushed skin (its share goes to its other bones)' },
    { id: 'smooth', label: 'Smooth', hint: "Blend the brushed skin's weights with its neighbours'" },
    { id: 'follow', label: 'Follow', hint: 'Make the brushed skin move with what is under it: the skin it covers (the legs under a coat), or the nearest bones where nothing is close under it. For hems and cloth the body should push' },
    { id: 'lift', label: 'Lift', hint: 'Push the brushed skin out off the skin under it, to the gap below: a cape off the body it follows, so the body and the lining stop showing through. Its inner side goes out with it. Works on the body as it stands (pause on the frame that shows it); saved with the weights and kept through re-rigs' },
    { id: 'rigid', label: 'Bone', hint: 'Paint the brushed skin onto the one bone under the brush, dropping pulls from cloth and bones around it. The bone is the one that already moves most of the skin where you start the stroke (shown below as you hover): start on the face for the head. For a face a hood drags, buckles, plates' },
  ]
  // (Lift changes the body's shape: not a garment's)
  const shown = $derived(garment === null ? tools : tools.filter(t => t.id !== 'lift'))
  async function forgetLifts (): Promise<void> {
    const r = await api.forgetShape(character.id)
    app.toast('ok', `Lifts forgotten: ${r.restored} vertices put back where they were`)
  }
  async function forget (): Promise<void> {
    if (garment !== null) {
      await api.forgetGarmentWeights(character.id, garment.id)
      app.toast('ok', `${garment.name}'s painted weights forgotten: it takes the body's again`)
      return
    }
    await api.forgetWeights(character.id)
    app.toast('ok', 'Painted weights forgotten: the next rig makes them afresh')
  }
</script>

<Section title="Fix weights">
  <Button block variant={paint.active ? 'ghost' : undefined} onclick={() => paint.setActive(!paint.active, garment?.id ?? null)}>
    <Paintbrush size={14} /> {paint.active ? 'Done painting' : garment !== null ? `Paint ${garment.name}'s weights` : 'Paint weights'}
  </Button>
  {#if paint.active}
    <p class="faint small">Pause a test clip on the frame that shows the problem, then paint on the body. The brush follows the surface. Leave good skin unmarked around an area to heal it. Left-drag on the body paints; off it the camera turns.</p>
    <div class="tools">
      {#each shown as t}
        <button class:on={paint.tool === t.id} onclick={() => { paint.tool = t.id; paint.refreshView() }} use:tooltip={t.hint}>
          {#if t.id === 'area'}<Sparkles size={12} />{:else if t.id === 'add'}<Brush size={12} />{:else if t.id === 'remove'}<Eraser size={12} />{:else if t.id === 'follow'}<Layers size={12} />{:else if t.id === 'rigid'}<Anchor size={12} />{:else if t.id === 'lift'}<ArrowUpFromLine size={12} />{:else}<Waves size={12} />{/if} {t.label}
        </button>
      {/each}
    </div>
    {#if paint.tool === 'rigid'}
      <p class="faint small">Bone under the brush: <strong>{paint.boneUnder ?? '–'}</strong></p>
    {/if}
    {#if paint.tool === 'add' || paint.tool === 'remove'}
      <label class="field">Bone
        <select value={paint.bone ?? ''} onchange={(e) => { paint.bone = (e.target as HTMLSelectElement).value; paint.refreshView() }}>
          {#each bones as b}<option value={b}>{boneLabel(b)}</option>{/each}
        </select>
      </label>
    {/if}
    {#if paint.tool === 'lift'}
      <label class="field" use:tooltip={'How far clear of the skin under it the brushed skin ends (a share of the height: 1% is about 2 cm on a man)'}>Gap <input type="range" min="0.002" max="0.04" step="0.001" bind:value={paint.gap} /></label>
    {/if}
    <Toggle label="Mirror left and right" checked={paint.mirror} onchange={(on: boolean) => paint.setMirror(on)} />
    <label class="field">Brush <input type="range" min="0.01" max="0.15" step="0.005" bind:value={paint.radius} /></label>
    {#if paint.tool !== 'area'}<label class="field">Strength <input type="range" min="0.05" max="1" step="0.05" bind:value={paint.strength} /></label>{/if}
    {#if paint.tool === 'area'}
      <div class="row">
        <Button size="sm" variant="primary" disabled={paint.marked === 0 || paint.busy} onclick={() => paint.heal()}><Sparkles size={13} /> Heal {paint.marked > 0 ? `${paint.marked} points` : 'the area'}</Button>
        <Button size="sm" variant="ghost" disabled={paint.marked === 0} onclick={() => paint.clearArea()}>Clear</Button>
      </div>
    {/if}
    <div class="row">
      <span use:tooltip={"Set the whole right side from the left (each point from its mirror twin, LeftArm for RightArm), the middle evened between them"}><Button size="sm" variant="ghost" disabled={paint.busy} onclick={() => paint.copySide(1)}><FlipHorizontal2 size={13} /> Left → right</Button></span>
      <span use:tooltip={'Set the whole left side from the right'}><Button size="sm" variant="ghost" disabled={paint.busy} onclick={() => paint.copySide(-1)}><FlipHorizontal2 size={13} /> Right → left</Button></span>
    </div>
    <div class="row">
      <Button size="sm" variant="ghost" onclick={() => paint.undo()}><RotateCcw size={13} /> Undo</Button>
      <Button size="sm" variant="primary" disabled={paint.edited === 0 || paint.busy} onclick={() => paint.save()}><Save size={13} /> Save {paint.edited > 0 ? `${paint.edited} points` : ''}</Button>
    </div>
    {#if garment !== null}
      <p class="faint small">Only {garment.name} is painted; the body under it is there for Follow to take from. Saved weights are kept with it{garment.painted ? ` (${garment.painted} vertices)` : ''} and laid over what it takes from the body. <button class="link" onclick={forget}>Forget the painting</button></p>
    {:else}
      <p class="faint small">Saved weights and lifts go into the rig and are put back after a re-rig. <button class="link" onclick={forget}>Forget the painting</button> · <button class="link" onclick={forgetLifts}>Forget the lifts</button></p>
    {/if}
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
