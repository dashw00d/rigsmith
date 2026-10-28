<script lang="ts">
  // Step 1, Import (DESIGN.md §5): what the upload was (source, kind, stats), its size (one height: what the import
  // measured, select.heightOf) and whether it stands on the floor, what the import noticed, and the character's name.
  // Resize and re-import run as jobs on the server; delete is the list's (src/app/characters.ts).
  import { ArrowDownToLine, ArrowRight, RotateCcw, Trash2, TriangleAlert } from '@lucide/svelte'
  import { heightOf, phaseOf } from '../../model/select.ts'
  import { api, type Character } from '../../state/api.ts'
  import { app, type Step } from '../../state/app.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Badge from '../../ui/Badge.svelte'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import NumberField from '../../ui/NumberField.svelte'
  import Section from '../../ui/Section.svelte'
  import TextField from '../../ui/TextField.svelte'
  import { removeCharacter, renameCharacter } from '../characters.ts'
  import { hasOwnRig, kindLabel, presetLabel } from '../status.ts'

  let { character }: { character: Character } = $props()

  const job = $derived(app.jobFor(character.id))
  const phase = $derived(phaseOf(character, job))
  const preset = $derived(presetLabel(character.source.rigPreset))
  const stats = $derived(character.source.stats)
  const height = $derived(heightOf(character))

  let name = $state('')
  $effect(() => { name = character.name })

  // ---- size ----

  let wanted = $state<number | null>(null)
  $effect(() => { wanted = Math.round(height * 1000) / 1000 })
  // (where its lowest point is: measured on the model on show, at rest)
  const floor = $derived(viewer.shownId === character.id && viewer.character !== null && !viewer.loading ? viewer.character.box.min.y : null)
  const offFloor = $derived(floor !== null && Math.abs(floor) > 0.002)
  const sizable = $derived(character.source.kind !== 'animation' && character.files.model !== undefined && phase.phase !== 'importing')

  // (what is being asked of the server from here)
  let working = $state<'resize' | 'floor' | 'reimport' | null>(null)
  const busy = $derived(job !== undefined || working !== null)

  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  async function fit (to?: number): Promise<void> {
    if (busy) return
    working = to === undefined ? 'floor' : 'resize'
    const who = character.name
    try {
      const started = await api.fit(character.id, to)
      const end = await app.jobDone(started.id)
      // (a failure is toasted by the app with the job's reason)
      if (end.status === 'done') app.toast('ok', to === undefined ? `${who} stands on the floor` : `${who} is ${to} m tall now, on the floor`)
    } catch (error) {
      app.toast('error', `${who} wasn't resized: ${reason(error)}`)
    } finally {
      working = null
    }
  }

  async function reimport (): Promise<void> {
    if (busy) return
    const c = character
    const placed = Object.keys(c.skeleton.overrides).length
    const sure = await app.confirm({
      title: `Import ${c.name} again?`,
      body: [
        `Its model is made again from ${c.source.originalName}, at its size${c.skeleton.template === 'human' && c.source.kind === 'mesh' ? ', and its joints are detected again' : ''}.`,
        placed > 0 ? `The ${placed} ${placed === 1 ? 'joint' : 'joints'} you placed ${placed === 1 ? 'is' : 'are'} kept.` : '',
        hasOwnRig(c) ? 'Its rig stays as it is (rig it again in Skeleton to follow a changed model).' : '',
      ].filter(line => line !== '').join(' '),
      confirm: 'Import again',
    })
    if (!sure) return
    working = 'reimport'
    try {
      const started = await api.reimport(c.id)
      const end = await app.jobDone(started.id)
      if (end.status === 'done') app.toast('ok', `${c.name} imported again`)
    } catch (error) {
      app.toast('error', `${c.name} wasn't imported again: ${reason(error)}`)
    } finally {
      working = null
    }
  }

  // ---- what next ----

  const next = $derived.by((): { step: Step, label: string } | null => {
    switch (phase.phase) {
      case 'rigged': return { step: 'motion', label: 'Pick its clips' }
      case 'needs-rig': return { step: 'skeleton', label: character.status === 'rigged' ? 'Rig it again' : 'Place its skeleton and rig it' }
      case 'needs-conversion': return { step: 'skeleton', label: 'Convert its rig' }
      default: return null
    }
  })

  const size = (bytes: number): string => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
</script>

<Section>
  <div class="title"><TextField bind:value={name} label="Character name" oncommit={(v) => { void renameCharacter(character, v) }} /></div>
  <div class="badges">
    <Badge tone={phase.tone} dot={phase.tone === 'busy'}>{phase.label}</Badge>
    {#if phase.phase !== 'importing'}
      <Badge>{kindLabel(character)}</Badge>
      {#if preset !== null}<Badge tone="accent">{preset}</Badge>{/if}
    {/if}
  </div>
  <div class="source faint mono" title={character.source.originalName}>{character.source.originalName} · {size(character.source.bytes)}</div>
</Section>

{#if stats !== undefined}
  <Section title="Model">
    <dl>
      <dt>Triangles</dt><dd class="mono">{stats.triangles.toLocaleString()}</dd>
      <dt>Vertices</dt><dd class="mono">{stats.vertices.toLocaleString()}</dd>
      <dt>Height</dt><dd class="mono">{height.toFixed(3)} m</dd>
      <dt>Meshes</dt><dd class="mono">{stats.meshes}</dd>
      {#if stats.bones > 0}<dt>Bones in the file</dt><dd class="mono">{stats.bones}</dd>{/if}
      {#if Math.abs(character.source.scale - 1) > 1e-6}<dt>Against the file</dt><dd class="mono">×{character.source.scale.toFixed(3)}</dd>{/if}
    </dl>
  </Section>
{/if}

{#if sizable}
  <Section title="Size">
    <div class="size">
      <Field label="Height">
        <NumberField value={wanted} onchange={(v) => { wanted = v }} min={0.05} max={100} step={0.01} digits={3} unit="m" label="Height" disabled={busy} />
      </Field>
      <Button size="sm" loading={working === 'resize'} disabled={busy || wanted === null || !(wanted > 0) || Math.abs(wanted - height) < 0.0005}
        onclick={() => { if (wanted !== null) void fit(wanted) }}>Resize</Button>
    </div>
    {#if offFloor && floor !== null}
      <div class="warn"><TriangleAlert size={14} /><span>Its lowest point is {Math.abs(floor * 100).toFixed(1)} cm {floor < 0 ? 'below' : 'above'} the floor.</span></div>
      <Button size="sm" variant="primary" loading={working === 'floor'} disabled={busy} onclick={() => fit()}><ArrowDownToLine size={13} /> Put it on the floor</Button>
    {/if}
    <p class="faint small">Resizing changes its files in place: a rig keeps its weights and painting, and its joints, markers and gear
      follow. Later imports and rigs keep the size.</p>
  </Section>
{/if}

{#if character.error}
  <Section title="Problem">
    <div class="warn error" role="alert"><TriangleAlert size={14} /><span>{character.error}</span></div>
  </Section>
{/if}

{#if character.source.warnings.length > 0}
  <Section title="Noticed on import">
    {#each character.source.warnings as w, i (i)}<div class="warn"><TriangleAlert size={14} /><span>{w}</span></div>{/each}
  </Section>
{/if}

<Section>
  {#if next !== null}
    <Button variant="primary" size="lg" block onclick={() => { void app.go(next.step) }}>{next.label} <ArrowRight size={15} /></Button>
  {/if}
  {#if job !== undefined}<p class="faint small">{job.label} is {job.status === 'queued' ? 'waiting' : 'working'}: the buttons below wait for it.</p>{/if}
  <div class="row">
    <Button size="sm" variant="ghost" loading={working === 'reimport'} disabled={busy || phase.phase === 'importing'} onclick={reimport}><RotateCcw size={13} /> Import again</Button>
    <Button size="sm" variant="danger" onclick={() => { void removeCharacter(character) }}><Trash2 size={13} /> Delete</Button>
  </div>
</Section>

<style>
  .title :global(input) { height: 32px; font-size: 17px; font-weight: 650; letter-spacing: -0.015em; border-color: transparent; background: transparent; padding: 0 6px; margin: 0 -6px; width: calc(100% + 12px); }
  .title :global(input:hover) { border-color: var(--line); }
  .title :global(input:focus) { border-color: var(--accent); background: var(--bg-2); }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; }
  .source { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
  dt { color: var(--text-3); }
  dd { margin: 0; text-align: right; }
  .size { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .size :global(.field) { flex: 1; }
  .warn { display: flex; gap: 8px; align-items: flex-start; color: var(--warn); font-size: 12.5px; }
  .warn :global(svg) { flex: none; margin-top: 2px; }
  .warn span { overflow-wrap: anywhere; }
  .warn.error { color: var(--danger); }
  .small { font-size: 12px; margin: 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
</style>
