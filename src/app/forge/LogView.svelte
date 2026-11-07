<script lang="ts">
  // A job's log as it runs: the last lines its events carried (about four times a second), and the whole log.txt of
  // its attempt once it has one.
  import type { QueueJob } from '../../../server/forge/types.ts'
  import { forge } from '../../state/forge.svelte.ts'

  interface Props { job: QueueJob }
  let { job }: Props = $props()

  const tail = $derived(forge.live[job.id]?.logTail ?? [])
</script>

<div class="log">
  {#if tail.length > 0}
    <pre>{tail.join('\n')}</pre>
  {:else}
    <p class="empty">{job.status === 'queued' ? 'Not started yet' : 'No lines since the board opened'}</p>
  {/if}
  {#if job.attempt !== undefined}
    <a href={forge.fileUrl(job.item, job.stage, job.attempt, 'log.txt')} target="_blank" rel="noreferrer">The whole log ({job.attempt})</a>
  {/if}
</div>

<style>
  .log { display: flex; flex-direction: column; gap: 6px; padding: 8px 0 4px; }
  pre { margin: 0; max-height: 220px; overflow: auto; padding: 8px; border-radius: var(--r-1); background: var(--bg-0); color: var(--text-2); font: 11px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { margin: 0; font-size: 11.5px; color: var(--text-3); }
  a { font-size: 11.5px; color: var(--accent); }
</style>
