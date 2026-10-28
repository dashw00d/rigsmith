<script lang="ts">
  // A unit's last build: how the last export from here went (or why it failed, and whether the game's units.json was
  // put back), the strides the game's UnitView.cs takes by hand (each with a copy button), the holds check's
  // failures, every warning, the library audit's flags, the model it wrote, and the build's whole output.
  import { CircleCheck, CircleX, Copy, Ban } from '@lucide/svelte'
  import type { UnitBuildView } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import IconButton from '../../ui/IconButton.svelte'
  import { ago, auditFlags, strideEntry, strideValue, took } from './text.ts'

  let { unit, view }: { unit: string, view: UnitBuildView | null | undefined } = $props()

  let now = $state(Date.now())
  $effect(() => {
    const t = setInterval(() => { now = Date.now() }, 30_000)
    return () => { clearInterval(t) }
  })

  const last = $derived(view?.last ?? null)
  const record = $derived(view?.record ?? null)
  // (the record is this export's when it carries its run token; one from a build run elsewhere says so)
  const ours = $derived(last !== null && record !== null && record.run === last.run)
  const walk = $derived(last?.status === 'done' ? last.walkStride ?? null : record?.walkStride ?? null)
  const run = $derived(last?.status === 'done' ? last.runStride ?? null : record?.runStride ?? null)
  const warnings = $derived(last !== null ? last.warnings : record?.warnings ?? [])
  const audit = $derived(auditFlags(record))
  const tris = $derived(record?.triangles ?? null)

  async function copy (what: string, v: number): Promise<void> {
    const text = strideEntry(unit, v)
    try {
      await navigator.clipboard.writeText(text)
      app.toast('ok', `Copied ${text} (UnitView.cs ${what})`)
    } catch {
      app.toast('error', `Couldn't copy: ${text}`)
    }
  }
</script>

{#if view === undefined}
  <p class="faint small">Reading its last build…</p>
{:else if view === null || (last === null && record === null)}
  <p class="faint small">Not built yet.</p>
{:else}
  <div class="record">
    {#if last !== null}
      <div class="status {last.status}">
        {#if last.status === 'done'}<CircleCheck size={14} />{:else if last.status === 'failed'}<CircleX size={14} />{:else}<Ban size={14} />{/if}
        <span>
          {last.status === 'done' ? 'Exported' : last.status === 'failed' ? 'Failed' : 'Cancelled'} {ago(last.finishedAt, now)}
          <span class="faint">({took(last.at, last.finishedAt)}{last.by !== 'app' ? `, by ${last.by}` : ''})</span>
        </span>
      </div>
      {#if last.error !== undefined && last.status !== 'done'}<p class="error small">{last.error}</p>{/if}
      {#if last.status !== 'done'}
        <p class="faint small">{last.restored === true ? "The game's units.json is back as it was." : last.restored === false ? "The game's units.json could not be put back: see the server log." : ''}</p>
      {/if}
    {:else}
      <p class="faint small">Built outside Rigsmith's Ship step (the game's own build).</p>
    {/if}

    {#if walk !== null || run !== null}
      <div class="strides">
        {#if walk !== null}
          <span class="stride">Walk stride <strong class="mono">{strideValue(walk)}</strong>
            <IconButton label="Copy the walk stride" hint={`Copy ${strideEntry(unit, walk)} for UnitView.Stride`} size="sm" onclick={() => copy('Stride', walk)}><Copy size={12} /></IconButton></span>
        {/if}
        {#if run !== null}
          <span class="stride">Run stride <strong class="mono">{strideValue(run)}</strong>
            <IconButton label="Copy the run stride" hint={`Copy ${strideEntry(unit, run)} for UnitView.RunStride`} size="sm" onclick={() => copy('RunStride', run)}><Copy size={12} /></IconButton></span>
        {/if}
      </div>
      <p class="faint small">The game reads them from UnitView.cs: paste each into its Stride and RunStride.</p>
    {/if}

    {#if last !== null && last.holdsFailed.length > 0}
      <div class="list">
        <span class="label bad">Holds failed ({last.holdsFailed.length})</span>
        <ul>{#each last.holdsFailed as line, i (i)}<li class="mono">{line}</li>{/each}</ul>
      </div>
    {/if}
    {#if warnings.length > 0}
      <div class="list">
        <span class="label warn">Warnings ({warnings.length})</span>
        <ul>{#each warnings as line, i (i)}<li>{line}</li>{/each}</ul>
      </div>
    {/if}
    {#if audit.length > 0}
      <div class="list">
        <span class="label warn">Library audit</span>
        <ul>{#each audit as a, i (i)}<li><strong>{a.clip}</strong>: {a.text}</li>{/each}</ul>
      </div>
    {/if}

    {#if tris !== null && tris.lods.length > 0}
      <p class="faint small">Triangles {tris.lods.map(n => n.toLocaleString('en')).join(' / ')} (budget {tris.budget.toLocaleString('en')}, the source {tris.source.toLocaleString('en')})</p>
    {/if}
    {#if view.glb !== null}
      <p class="faint small"><span class="mono">{view.glb.file}</span> written {ago(view.glb.mtime, now)}{record !== null && last !== null && !ours ? '; its record is from another build' : ''}</p>
    {/if}
    {#if last !== null && last.log.length > 0}
      <details>
        <summary>The build's output ({last.log.length} lines)</summary>
        <pre>{last.log.join('\n')}</pre>
      </details>
    {/if}
  </div>
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .record { display: flex; flex-direction: column; gap: 6px; }
  .status { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: var(--text-1); }
  .status.done :global(svg) { color: var(--ok); }
  .status.failed :global(svg) { color: var(--danger); }
  .status.cancelled :global(svg) { color: var(--text-4); }
  .error { color: var(--danger); overflow-wrap: anywhere; }
  .strides { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--text-2); }
  .stride { display: inline-flex; align-items: center; gap: 4px; }
  .list { display: flex; flex-direction: column; gap: 2px; }
  .label { font-size: 11.5px; font-weight: 600; }
  .label.bad { color: var(--danger); }
  .label.warn { color: var(--warn); }
  ul { margin: 0; padding-left: 16px; font-size: 11.5px; color: var(--text-2); }
  li { overflow-wrap: anywhere; }
  details { font-size: 12px; color: var(--text-3); }
  summary { cursor: pointer; }
  pre { margin: 6px 0 0; padding: 8px; max-height: 240px; overflow: auto; border-radius: var(--r-1); background: var(--bg-0); font-family: var(--mono); font-size: 10.5px; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
