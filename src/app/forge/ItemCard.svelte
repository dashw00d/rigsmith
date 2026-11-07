<script lang="ts">
  // One item at one stage: the picture of the attempt shown (picked, else the newest), what it waits for, the live
  // progress while it runs, its attempts, and what can be done here (run, approve; a pick gate opens the pick).
  import { Check, Play, Images } from '@lucide/svelte'
  import type { ForgeStage, ItemView, StageView } from '../../../server/forge/types.ts'
  import { forge } from '../../state/forge.svelte.ts'
  import Badge from '../../ui/Badge.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import AttemptStrip from './AttemptStrip.svelte'
  import { cardState, formatEta, shownAttempt, STATE_LABEL, STATE_TONE, thumbOf } from './board.ts'

  interface Props { item: ItemView, stage: ForgeStage, view: StageView, focused: boolean, onfocus: () => void, onpick: () => void }
  let { item, stage, view, focused, onfocus, onpick }: Props = $props()

  const jobs = $derived(forge.jobsFor(item.id, stage.id))
  const state = $derived(cardState(stage, view, jobs))
  const shown = $derived(shownAttempt(view))
  const thumb = $derived(shown === null ? null : thumbOf(shown))
  const running = $derived(jobs.find(j => j.status === 'running'))
  const live = $derived(running === undefined ? undefined : forge.live[running.id])
  const why = $derived(state === 'blocked' ? view.blocked : state === 'stale' ? shown?.stale.join('; ') : state === 'failed' ? view.attempts.at(-1)?.error : null)
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="card {state}" class:focused onclick={onfocus} aria-current={focused ? 'true' : undefined}>
  <div class="thumb">
    {#if thumb !== null && shown !== null}
      <img src={forge.fileUrl(item.id, stage.id, shown.id, thumb)} alt="{item.name}, {stage.label} {shown.id}" loading="lazy" />
    {:else}
      <span class="none">{shown === null ? '—' : shown.outputs.length} {shown === null ? '' : 'files'}</span>
    {/if}
  </div>
  <div class="row">
    <span class="name" title={item.name}>{item.name}</span>
    <span use:tooltip={why ?? STATE_LABEL[state]}><Badge tone={STATE_TONE[state]} dot={state === 'running'}>{STATE_LABEL[state]}</Badge></span>
  </div>
  {#if running !== undefined}
    <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={running.progress}>
      <i style:width="{Math.round(running.progress * 100)}%"></i>
    </div>
    <p class="message" title={running.message}>{running.message}{#if formatEta(live?.eta) !== null} · {formatEta(live?.eta)} left{/if}</p>
  {:else if why !== null && why !== undefined}
    <p class="message why" title={why}>{why}</p>
  {/if}
  <div class="row">
    <AttemptStrip item={item.id} stage={stage.id} {view} />
    <span class="actions">
      {#if state === 'pick'}
        <IconButton label="Pick one" hint="Pick one of the attempts (1-4)" size="sm" onclick={(e) => { e.stopPropagation(); onpick() }}><Images size={14} /></IconButton>
      {/if}
      {#if state === 'approve'}
        <IconButton label="Approve" hint="Approve the one picked (A)" size="sm" onclick={(e) => { e.stopPropagation(); void forge.approve(item.id, stage.id) }}><Check size={14} /></IconButton>
      {/if}
      <IconButton label="Run" hint={`Run ${stage.label}${(stage.variants ?? 1) > 1 ? ` (${stage.variants} attempts)` : ''} (R)`} size="sm"
        disabled={view.blocked !== null} onclick={(e) => { e.stopPropagation(); void forge.run(item.id, stage.id) }}><Play size={14} /></IconButton>
    </span>
  </div>
</div>

<style>
  .card { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); cursor: default; }
  .card.focused { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .card.blocked, .card.empty { opacity: 0.75; }
  .thumb { aspect-ratio: 3 / 2; border-radius: var(--r-1); background: var(--bg-0); display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .thumb img { width: 100%; height: 100%; object-fit: contain; }
  .none { color: var(--text-4); font-size: 11px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
  .name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; gap: 2px; flex: none; }
  .progress { height: 3px; border-radius: 2px; background: var(--bg-4); overflow: hidden; }
  .progress i { display: block; height: 100%; background: var(--accent); transition: width var(--med) var(--ease); }
  .message { margin: 0; font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .why { color: var(--text-3); }
  .stale .why { color: var(--warn); }
  .failed .why { color: var(--danger); }
</style>
