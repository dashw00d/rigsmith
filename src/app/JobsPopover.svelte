<script lang="ts">
  import { CircleAlert, CircleCheck, LoaderCircle, Clock } from '@lucide/svelte'
  import { app } from '../state/app.svelte.ts'
  import Popover from '../ui/Popover.svelte'

  let { onclose }: { onclose: () => void } = $props()
  const recent = $derived(app.jobs.slice(0, 12))

  function ago (t: number): string {
    const s = Math.round((Date.now() - t) / 1000)
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
  }
</script>

<Popover {onclose} width={320} align="right">
  <div class="head">Background jobs</div>
  {#if recent.length === 0}
    <p class="empty faint">Nothing yet. Imports and rigs run here in Blender, in the background.</p>
  {:else}
    <ul>
      {#each recent as job (job.id)}
        <li>
          <span class="icon {job.status}">
            {#if job.status === 'running'}<LoaderCircle size={14} class="spin" />
            {:else if job.status === 'queued'}<Clock size={14} />
            {:else if job.status === 'done'}<CircleCheck size={14} />
            {:else}<CircleAlert size={14} />{/if}
          </span>
          <div class="text">
            <div class="label">{job.label}</div>
            <div class="msg faint">{job.status === 'failed' ? job.error : job.message} · {ago(job.createdAt)}</div>
            {#if job.status === 'running'}<div class="bar"><div style="width: {Math.round(job.progress * 100)}%"></div></div>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</Popover>

<style>
  .head { padding: 10px 12px; font-weight: 600; border-bottom: 1px solid var(--line); }
  .empty { padding: 12px; margin: 0; }
  ul { list-style: none; margin: 0; padding: 4px; max-height: 360px; overflow: auto; }
  li { display: flex; gap: 10px; padding: 8px; border-radius: var(--r-1); }
  li:hover { background: var(--bg-3); }
  .icon { padding-top: 1px; color: var(--text-3); }
  .icon.running { color: var(--accent); }
  .icon.done { color: var(--ok); }
  .icon.failed { color: var(--danger); }
  .text { flex: 1; min-width: 0; }
  .label { font-weight: 500; }
  .msg { font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { margin-top: 6px; height: 3px; background: var(--bg-4); border-radius: 2px; overflow: hidden; }
  .bar div { height: 100%; background: var(--accent); transition: width var(--med); }
</style>
