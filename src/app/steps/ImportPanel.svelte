<script lang="ts">
  import { ArrowRight, RotateCcw, Trash2, TriangleAlert } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { api } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import { viewer } from '../../state/viewer.svelte.ts'

  let { character }: { character: Character } = $props()

  const kindLabel = $derived(character.kind === 'mesh' && character.status === 'rigged'
    ? 'Auto-rigged'
    : { mesh: 'Unrigged mesh', rigged: 'Rigged character', animation: 'Animation only' }[character.kind ?? 'mesh'] ?? 'Unknown')
  const presetLabel = $derived({ mixamo: 'Mixamo', tripo: 'Tripo auto-rig', rigify: 'Rigify', unreal: 'Unreal mannequin', unknown: 'Unknown skeleton' }[character.rigPreset ?? ''] ?? null)
  let name = $state('')
  $effect(() => { name = character.name })

  async function rename (): Promise<void> {
    const next = name.trim()
    if (next !== '' && next !== character.name) await app.update(character.id, { name: next })
  }

  // Size and floor: measured on the model shown (its rest), changed in place (server: POST /fit)
  const shown = $derived(viewer.character !== null && !viewer.loading && app.selectedId === character.id ? viewer.character : null)
  const measured = $derived(shown === null ? null : { height: shown.box.max.y - shown.box.min.y, floor: shown.box.min.y })
  let heightInput = $state(0)
  $effect(() => { if (measured !== null) heightInput = Math.round(measured.height * 1000) / 1000 })
  let fitting = $state(false)
  async function fit (height?: number): Promise<void> {
    if (fitting) return
    fitting = true
    try {
      app.upsert(await api.fit(character.id, height))
      app.toast('ok', height === undefined ? `${character.name} is on the floor` : `${character.name} is ${height} tall now, on the floor`)
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally { fitting = false }
  }

  async function remove (): Promise<void> {
    if (!confirm(`Delete ${character.name}?\n\nIt's moved to workspace/trash, out of Rigsmith (put its folder back in workspace/characters to undo).`)) return
    await app.remove(character.id)
  }
</script>

<Section>
  <input class="title" bind:value={name} onblur={rename} onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label="Character name" />
  <div class="badges">
    {#if character.status === 'importing'}<span class="badge busy">Importing…</span>
    {:else}
      <span class="badge">{kindLabel}</span>
      {#if presetLabel}<span class="badge accent">{presetLabel}</span>{/if}
    {/if}
  </div>
  <div class="faint source mono">{character.source.originalName}</div>
</Section>

{#if character.stats}
  <Section title="Model">
    <dl>
      <dt>Triangles</dt><dd class="mono">{character.stats.triangles.toLocaleString()}</dd>
      <dt>Vertices</dt><dd class="mono">{character.stats.vertices.toLocaleString()}</dd>
      <dt>Height</dt><dd class="mono">{(measured?.height ?? character.stats.height).toFixed(3)} m</dd>
      <dt>Meshes</dt><dd class="mono">{character.stats.meshes}</dd>
      {#if character.stats.bones > 0}<dt>Bones</dt><dd class="mono">{character.stats.bones}</dd>{/if}
    </dl>
  </Section>
{/if}

{#if character.kind !== 'animation' && measured !== null}
  <Section title="Size">
    <div class="size">
      <label class="field">Height <input class="num" type="number" min="0.05" step="0.01" bind:value={heightInput} aria-label="Height" /> m</label>
      <Button size="sm" loading={fitting} disabled={fitting || !(heightInput > 0) || Math.abs(heightInput - measured.height) < 0.0005}
        onclick={() => fit(heightInput)}>Resize</Button>
    </div>
    {#if Math.abs(measured.floor) > 0.002}
      <div class="warn"><TriangleAlert size={14} /><span>Its lowest point is {Math.abs(measured.floor * 100).toFixed(1)} cm {measured.floor < 0 ? 'below' : 'above'} the floor.</span></div>
      <Button size="sm" variant="primary" loading={fitting} disabled={fitting} onclick={() => fit()}>Put it on the floor</Button>
    {/if}
    <p class="faint small">Resizing (or standing it on the floor) changes the files in place: a rigged character keeps its weights and
      painting, and its joints, markers and props follow. Later imports and rigs keep the size.</p>
  </Section>
{/if}

{#if character.error}
  <Section title="Problem">
    <div class="warn error"><TriangleAlert size={14} /><span>{character.error}</span></div>
  </Section>
{/if}

{#if character.rigReport?.warnings?.length}
  <Section title="Notes">
    {#each character.rigReport.warnings as w}<div class="warn"><TriangleAlert size={14} /><span>{w}</span></div>{/each}
  </Section>
{/if}

<Section>
  {#if character.status === 'rigged'}
    <Button variant="primary" size="lg" block onclick={() => { app.step = 'animate' }}>Pick animations <ArrowRight size={15} /></Button>
  {:else if character.kind === 'mesh' && character.status !== 'importing'}
    <Button variant="primary" size="lg" block onclick={() => { app.step = 'rig' }}>Rig this character <ArrowRight size={15} /></Button>
  {/if}
  <div class="row">
    <Button size="sm" variant="ghost" onclick={async () => { await api.reimport(character.id) }}><RotateCcw size={13} /> Re-import</Button>
    <Button size="sm" variant="danger" onclick={remove}><Trash2 size={13} /> Delete</Button>
  </div>
</Section>

<style>
  .size { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .field { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .num { width: 80px; height: 28px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-1); padding: 0 6px; }
  .title {
    width: 100%;
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.015em;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    background: transparent;
    padding: 2px 6px;
    margin: -2px -6px;
  }
  .title:hover { border-color: var(--line); }
  .title:focus { outline: none; border-color: var(--accent); background: var(--bg-2); }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; }
  .badge { font-size: 11.5px; font-weight: 550; padding: 3px 8px; border-radius: 10px; background: var(--bg-3); color: var(--text-2); }
  .badge.accent { background: var(--accent-soft); color: var(--accent-strong); }
  .badge.busy { background: var(--accent-soft); color: var(--accent-strong); }
  .source { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
  dt { color: var(--text-3); }
  dd { margin: 0; text-align: right; }
  .warn { display: flex; gap: 8px; align-items: flex-start; color: var(--warn); font-size: 12.5px; }
  .warn :global(svg) { flex: none; margin-top: 2px; }
  .warn.error { color: var(--danger); }
  .row { display: flex; justify-content: space-between; }
</style>
