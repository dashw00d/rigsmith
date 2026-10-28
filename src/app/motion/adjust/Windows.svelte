<script lang="ts">
  // When an adjustment applies: windows of the clip as it plays (phases; shown as its frames while it plays), each set
  // from the playhead (Start here, End here) or added at it. `whole`: no windows means the whole clip. `others`: windows
  // the same hand's other poses take, which these may not overlap.
  import { ArrowLeftToLine, ArrowRightToLine, Plus, X } from '@lucide/svelte'
  import type { Window } from '../../../state/api.ts'
  import { app } from '../../../state/app.svelte.ts'
  import { adjust } from '../../../state/adjust.svelte.ts'
  import Button from '../../../ui/Button.svelte'
  import IconButton from '../../../ui/IconButton.svelte'
  import { addWindow, moveEdge, overlapping, windowText } from '../rules.ts'

  interface Props {
    windows: Window[] | undefined
    whole?: boolean
    frames: number | null
    playhead: number | null
    others?: Window[]
    disabled?: boolean
    onchange: (next: Window[] | undefined) => void
  }
  let { windows, whole = false, frames, playhead, others = [], disabled = false, onchange }: Props = $props()

  const list = $derived(windows ?? [])
  const away = $derived(playhead === null ? 'Play this clip and stop on a frame to set it from there' : undefined)

  function send (next: Window[] | null | undefined): void {
    if (next === null) { app.toast('error', 'No room there: windows may not be empty or overlap'); return }
    if (next !== undefined && overlapping([...next, ...others])) { app.toast('error', 'The hand is posed then already by another pose of this clip'); return }
    onchange(next)
  }

  function edge (i: number, which: 0 | 1): void {
    if (playhead !== null) send(moveEdge(list, i, which, playhead))
  }

  function drop (i: number): void {
    const next = list.filter((_, k) => k !== i)
    send(next.length === 0 && whole ? undefined : next)
  }
</script>

<div class="windows">
  {#if windows === undefined}
    <div class="row">
      <span class="when">The whole clip</span>
      <Button size="sm" variant="ghost" disabled={disabled || others.length > 0} onclick={() => send(addWindow([], playhead ?? 0))}>Only part of it</Button>
    </div>
  {:else}
    {#if list.length === 0}<p class="faint none">Never (no window yet)</p>{/if}
    {#each list as w, i (i)}
      <div class="row">
        <button class="when link mono" disabled={playhead === null} onclick={() => adjust.seekPhase(w[0])} title={playhead === null ? undefined : 'Show its start'}>{windowText(w, frames)}</button>
        <IconButton label="Start here" hint={away ?? 'Start it at the frame shown'} size="sm" disabled={disabled || playhead === null} onclick={() => edge(i, 0)}><ArrowLeftToLine size={13} /></IconButton>
        <IconButton label="End here" hint={away ?? 'End it at the frame shown'} size="sm" disabled={disabled || playhead === null} onclick={() => edge(i, 1)}><ArrowRightToLine size={13} /></IconButton>
        <IconButton label="Remove this window" size="sm" variant="danger" {disabled} onclick={() => drop(i)}><X size={13} /></IconButton>
      </div>
    {/each}
    <div class="row">
      <Button size="sm" variant="ghost" disabled={disabled || playhead === null} title={away} onclick={() => { if (playhead !== null) send(addWindow(list, playhead)) }}><Plus size={12} /> Window here</Button>
      {#if whole && others.length === 0}<Button size="sm" variant="ghost" {disabled} onclick={() => send(undefined)}>Whole clip</Button>{/if}
    </div>
  {/if}
</div>

<style>
  .windows { display: flex; flex-direction: column; gap: 2px; }
  .row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .when { flex: 1; min-width: 0; font-size: 12px; color: var(--text-2); }
  .link { border: 0; background: transparent; padding: 0; text-align: left; color: var(--accent-strong); }
  .link:disabled { color: var(--text-2); cursor: default; }
  .none { margin: 0; font-size: 12px; }
</style>
