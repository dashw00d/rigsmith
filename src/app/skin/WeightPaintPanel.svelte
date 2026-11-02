<script lang="ts">
  // Weight painting on the character as it stands (pause a test clip on the frame that shows the problem): its body
  // (the Skin step), or a gear piece worn on the skin or drawn by a pull (the Gear step). src/state/paint.svelte.ts,
  // src/engine/weightpaint.ts. The body's painting goes into the rig and is put back after every re-rig; a gear
  // piece's is kept beside it.
  import { onDestroy } from 'svelte'
  import { Anchor, ArrowUpFromLine, Brush, Eraser, FlipHorizontal2, Layers, Lock, Paintbrush, RotateCcw, Save, Sparkles, Waves } from '@lucide/svelte'
  import type { Character, Gear } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { paint, paintableGear, type PaintTool } from '../../state/paint.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import Section from '../../ui/Section.svelte'
  import Select from '../../ui/Select.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let { character, gear }: { character: Character, gear?: Gear } = $props()

  const target = $derived(gear?.id ?? null)
  /** Painting what this panel is about (this character's body, or this piece). */
  const mine = $derived(paint.active && paint.characterId === character.id && paint.gear === target)
  const pulled = $derived(gear !== undefined && paintableGear(gear) === 'pulled')
  // (the lock is the body's: a gear piece's own weights aren't the body's)
  const locked = $derived(gear === undefined && character.skin.locked)
  const painted = $derived(gear === undefined ? character.skin.painted ?? 0 : gear.painted ?? 0)
  const what = $derived(gear === undefined ? 'the body' : gear.name)
  /** What else is being painted, if something else is. */
  const elsewhere = $derived.by(() => {
    if (!paint.active || mine) return null
    const c = app.byId(paint.characterId)
    const g = paint.gear === null ? null : c?.gear.find(x => x.id === paint.gear)
    return g !== null && g !== undefined ? g.name : c?.id === character.id ? 'the body' : `${c?.name ?? 'another character'}'s body`
  })

  onDestroy(() => {
    // (the panel gone, by a step change the painting's guard agreed to, or the piece hidden or taken off)
    if (paint.active && paint.characterId === character.id && paint.gear === (gear?.id ?? null)) paint.stop()
  })

  const tools: Array<{ id: PaintTool, label: string, hint: string }> = [
    { id: 'area', label: 'Heal', hint: 'Mark the problem skin (Alt to unmark), then Heal: its weights refilled smoothly from the good skin round it (skin pulled by a wrong bone goes with what surrounds it)' },
    { id: 'add', label: 'Add', hint: 'Give the brushed skin more of the bone' },
    { id: 'remove', label: 'Remove', hint: 'Take the bone off the brushed skin (its share goes to its other bones)' },
    { id: 'smooth', label: 'Smooth', hint: "Blend the brushed skin's weights with its neighbours'" },
    { id: 'follow', label: 'Follow', hint: 'Make the brushed skin move with what is under it: the skin it covers (the legs under a coat), or the nearest bones where nothing is close under it. For hems and cloth the body should push' },
    { id: 'lift', label: 'Lift', hint: 'Push the brushed skin out off the skin under it, to the gap below: a cape off the body it follows, so the body and the lining stop showing through. Its inner side goes out with it. Works on the body as it stands (pause on the frame that shows it); saved with the weights and kept through re-rigs' },
    { id: 'rigid', label: 'Bone', hint: 'Paint the brushed skin onto the one bone under the brush, dropping pulls from cloth and bones around it. The bone is the one that already moves most of the skin where you start the stroke (shown below as you hover): start on the face for the head. For a face a hood drags, buckles, plates' },
  ]
  const boneName = (name: string | null): string => paint.bones.find(b => b.name === name)?.label ?? name ?? '–'

  async function toggle (): Promise<void> {
    if (mine) await paint.finish()
    else await paint.start(character, gear ?? null)
  }

  async function forgetLifts (): Promise<void> {
    const ok = await app.confirm({ title: 'Forget the lifts?', body: 'Every vertex the Lift brush moved goes back where it was.', confirm: 'Forget', danger: true })
    if (ok && await paint.forgetLifts(character)) app.toast('ok', 'Lifts forgotten: the skin is back where it was')
  }
  async function forget (): Promise<void> {
    const ok = await app.confirm({
      title: gear === undefined ? 'Forget the body\'s painting?' : `Forget ${gear.name}'s painting?`,
      body: gear === undefined
        ? `${painted} painted ${painted === 1 ? 'point' : 'points'}. The rig keeps their weights until the next rig, which then makes them afresh.`
        : `${painted} painted ${painted === 1 ? 'point' : 'points'}. It takes the weights it had before painting again.`,
      confirm: 'Forget',
      danger: true,
    })
    if (!ok) return
    if (await paint.forget(character, gear ?? null)) {
      app.toast('ok', gear === undefined ? 'Painting forgotten: the rig keeps those weights until the next rig' : `${gear.name}'s painting forgotten`)
    }
  }
</script>

<Section title={gear === undefined ? 'Paint weights' : 'Weights'}>
  {#if locked}
    <p class="faint small"><Lock size={11} /> The weights are locked: unlock them above to {mine ? 'save the painting' : 'paint'}.</p>
  {/if}
  {#if !locked || mine}
    {#if elsewhere !== null}<p class="faint small">Painting {elsewhere} now; starting here asks about its unsaved strokes first.</p>{/if}
    <Button block variant={mine ? 'ghost' : undefined} disabled={paint.busy} onclick={toggle}>
      <Paintbrush size={14} /> {mine ? 'Done painting' : gear !== undefined ? `Paint ${gear.name}'s weights` : 'Paint weights'}
    </Button>
  {/if}

  {#if mine}
    {#if paint.waiting}
      <p class="faint small">Waiting for {what} to be on stage…</p>
    {:else}
      <p class="faint small">Pause a test clip on the frame that shows the problem, then paint on {gear === undefined ? 'the body' : gear.name}. Left-drag on it paints; off it the camera turns.{gear !== undefined && !pulled ? ' The body under it is there for Follow to take from, not painted.' : ''}</p>
      <div class="tools">
        {#each (gear === undefined ? tools : tools.filter(t => t.id !== 'lift')) as t (t.id)}
          <button class:on={paint.tool === t.id} onclick={() => { paint.tool = t.id; paint.refreshView() }} use:tooltip={t.hint}>
            {#if t.id === 'area'}<Sparkles size={12} />{:else if t.id === 'add'}<Brush size={12} />{:else if t.id === 'remove'}<Eraser size={12} />{:else if t.id === 'follow'}<Layers size={12} />{:else if t.id === 'rigid'}<Anchor size={12} />{:else if t.id === 'lift'}<ArrowUpFromLine size={12} />{:else}<Waves size={12} />{/if} {t.label}
          </button>
        {/each}
      </div>
      {#if paint.tool === 'rigid'}
        <p class="faint small">Bone under the brush: <strong>{boneName(paint.boneUnder)}</strong></p>
      {/if}
      {#if paint.tool === 'add' || paint.tool === 'remove'}
        <Field label="Bone">
          <Select size="sm" width="190px" options={paint.bones.map(b => ({ value: b.name, label: b.label }))} value={paint.bone}
            onchange={(v) => { paint.bone = v; paint.refreshView() }} />
        </Field>
      {/if}
      {#if !pulled}
        <Toggle label="Mirror left and right" checked={paint.mirror} onchange={(on: boolean) => paint.setMirror(on)} />
      {/if}
      {#if paint.tool === 'lift'}
        <label class="field" use:tooltip={'How far clear of the skin under it the brushed skin ends (a share of the height: 1% is about 2 cm on a man)'}>Gap <input type="range" min="0.002" max="0.04" step="0.001" bind:value={paint.gap} /></label>
      {/if}
      <label class="field">Brush <input type="range" min="0.01" max="0.15" step="0.005" bind:value={paint.radius} /></label>
      {#if paint.tool !== 'area'}<label class="field">Strength <input type="range" min="0.05" max="1" step="0.05" bind:value={paint.strength} /></label>{/if}
      {#if paint.tool === 'area'}
        <div class="row">
          <Button size="sm" variant="primary" disabled={paint.marked === 0 || paint.busy} onclick={() => paint.heal()}><Sparkles size={13} /> Heal {paint.marked > 0 ? `${paint.marked} points` : 'the area'}</Button>
          <Button size="sm" variant="ghost" disabled={paint.marked === 0} onclick={() => paint.clearArea()}>Clear</Button>
        </div>
      {/if}
      {#if !pulled}
        <div class="row">
          <span use:tooltip={'Set the whole right side from the left (each point from its mirror twin, the left arm\'s bones for the right\'s), the middle evened between them'}><Button size="sm" variant="ghost" disabled={paint.busy} onclick={() => paint.copySide(1)}><FlipHorizontal2 size={13} /> Left → right</Button></span>
          <span use:tooltip={'Set the whole left side from the right'}><Button size="sm" variant="ghost" disabled={paint.busy} onclick={() => paint.copySide(-1)}><FlipHorizontal2 size={13} /> Right → left</Button></span>
        </div>
      {/if}
      <div class="row">
        <Button size="sm" variant="ghost" disabled={paint.busy} onclick={() => paint.undo()}><RotateCcw size={13} /> Undo</Button>
        <Button size="sm" variant="primary" loading={paint.busy} disabled={paint.edited === 0} onclick={() => paint.save()}><Save size={13} /> Save {paint.edited > 0 ? `${paint.edited} points` : ''}</Button>
      </div>
    {/if}
  {/if}

  <p class="faint small">
    {#if gear === undefined}
      {painted > 0 ? `${painted} ${painted === 1 ? 'point' : 'points'} painted by hand, put back after every rig.` : 'Nothing painted by hand yet.'} Saved painting goes into the rig.
    {:else}
      {painted > 0 ? `${painted} ${painted === 1 ? 'point' : 'points'} painted by hand.` : 'Nothing painted by hand yet.'} Its painting is kept with it, over the weights it takes {pulled ? 'from its pulls' : 'from the body'}.
    {/if}
    {#if painted > 0 && !locked}<button class="link" disabled={paint.busy} onclick={forget}>Forget the painting</button>{/if}
    {#if gear === undefined && !locked}<button class="link" disabled={paint.busy} onclick={forgetLifts}>Forget the lifts</button>{/if}
  </p>
</Section>

<style>
  .small { font-size: 12px; margin: 0; }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; }
  .tools button { display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 9px; border-radius: 13px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .tools button.on { border-color: var(--accent); color: var(--accent-strong); background: var(--accent-soft); }
  .field { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text-2); }
  .field input[type=range] { width: 160px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .link { border: 0; background: transparent; color: var(--accent-strong); padding: 0; font-size: 12px; }
  .link:disabled { opacity: 0.55; }
</style>
