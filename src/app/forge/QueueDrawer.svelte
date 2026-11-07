<script lang="ts">
  // The Forge's queue: what runs (its progress, ETA and log), what waits in order (moved up or down, cancelled), what
  // finished; and the GPU lane (who has it, who waits and why).
  import { ChevronDown, ChevronUp, ScrollText, X } from '@lucide/svelte'
  import { forge } from '../../state/forge.svelte.ts'
  import Drawer from '../../ui/Drawer.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import { formatEta, queueOrder } from './board.ts'
  import LogView from './LogView.svelte'

  const jobs = $derived(queueOrder(forge.board?.queue ?? []).slice(0, 80))
  const gpu = $derived(forge.gpu)
</script>

<Drawer open={forge.queueOpen} onclose={() => { forge.queueOpen = false }} side="right" title="Forge queue" scrim={false}>
  {#if gpu !== null}
    <section class="gpu">
      <h3>GPU</h3>
      <p>{gpu.holder !== null ? `${gpu.holder.label} has it` : 'Free'}</p>
      {#each gpu.waiting as w (w.id)}<p class="wait">{w.label}: {w.why}</p>{/each}
    </section>
  {/if}
  {#if jobs.length === 0}
    <p class="empty">Nothing queued.</p>
  {/if}
  <ol class="jobs">
    {#each jobs as job (job.id)}
      {@const live = forge.live[job.id]}
      <li class={job.status}>
        <div class="row">
          <span class="label" title={job.label}>{job.label}</span>
          <span class="actions">
            {#if job.status === 'queued'}
              <IconButton label="Earlier" size="sm" onclick={() => { void forge.nudge(job.id, -1) }}><ChevronUp size={14} /></IconButton>
              <IconButton label="Later" size="sm" onclick={() => { void forge.nudge(job.id, 1) }}><ChevronDown size={14} /></IconButton>
            {/if}
            {#if job.status !== 'queued'}
              <IconButton label="Log" size="sm" active={forge.logJob === job.id} onclick={() => { forge.logJob = forge.logJob === job.id ? null : job.id }}><ScrollText size={14} /></IconButton>
            {/if}
            {#if job.status === 'queued' || job.status === 'running'}
              <IconButton label="Cancel" variant="danger" size="sm" onclick={() => { void forge.cancel(job.id) }}><X size={14} /></IconButton>
            {/if}
          </span>
        </div>
        {#if job.status === 'running'}
          <div class="progress"><i style:width="{Math.round(job.progress * 100)}%"></i></div>
        {/if}
        <p class="message">{job.error ?? job.message}{#if job.status === 'running' && formatEta(live?.eta) !== null} · {formatEta(live?.eta)} left{/if}</p>
        {#if forge.logJob === job.id}<LogView {job} />{/if}
      </li>
    {/each}
  </ol>
</Drawer>

<style>
  .gpu { padding: 10px 16px; border-bottom: 1px solid var(--line); }
  h3 { margin: 0 0 4px; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); }
  .gpu p { margin: 2px 0; font-size: 12px; }
  .gpu .wait { color: var(--text-3); }
  .empty { padding: 16px; color: var(--text-3); font-size: 12px; }
  .jobs { margin: 0; padding: 0; list-style: none; }
  li { padding: 8px 12px 8px 16px; border-bottom: 1px solid var(--line); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .label { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; gap: 2px; flex: none; }
  .progress { height: 3px; margin: 4px 0; border-radius: 2px; background: var(--bg-4); overflow: hidden; }
  .progress i { display: block; height: 100%; background: var(--accent); }
  .message { margin: 2px 0 0; font-size: 11.5px; color: var(--text-3); overflow-wrap: anywhere; }
  .failed .message { color: var(--danger); }
  .done .label, .cancelled .label, .interrupted .label { color: var(--text-2); font-weight: 500; }
</style>
