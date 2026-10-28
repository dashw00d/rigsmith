<script lang="ts">
  // Parts of a clip, shown as everywhere ("20–50%, 80–100%") and typed so or as phases ("0.2-0.5"), or set from the frame
  // shown: from here to the end, or let go here. One parser (src/engine/clipedit.ts parseWindows): a typo is said, never
  // dropped quietly.
  import { ArrowLeftToLine, ArrowRightToLine } from '@lucide/svelte'
  import type { Window } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { fromHere, parseWindows, toHere, windowsText } from '../../engine/clipedit.ts'
  import IconButton from '../../ui/IconButton.svelte'
  import TextField from '../../ui/TextField.svelte'

  interface Props {
    label: string
    value: Window[]
    onchange: (windows: Window[]) => void
    /** What "from here" does, in words (default: from the frame shown to the end). */
    fromLabel?: string
    toLabel?: string
    disabled?: boolean
  }
  let { label, value, onchange, fromLabel = 'From the frame shown to the end', toLabel = 'Up to the frame shown', disabled = false }: Props = $props()

  let text = $state('')
  let error = $state<string | null>(null)
  $effect(() => { text = windowsText(value); error = null })

  /** The frame shown, as a phase of the clip playing. */
  function here (): number {
    return animator.duration > 0 ? Math.round(Math.min(1, Math.max(0, animator.time / animator.duration)) * 1000) / 1000 : 0
  }

  function commit (typed: string): void {
    const w = parseWindows(typed)
    if (w === null) { error = 'Type parts of the clip like 20–50%, 80–100% (or 0.2-0.5)'; return }
    error = null
    onchange(w)
  }
</script>

<div class="windows">
  <span class="label">{label}</span>
  <div class="row">
    <TextField size="sm" mono {label} placeholder="never" {disabled} bind:value={text} oncommit={commit} />
    <IconButton size="sm" label={`${label}: ${fromLabel.toLowerCase()}`} hint={fromLabel} {disabled} onclick={() => { onchange(fromHere(value, here())) }}><ArrowRightToLine size={13} /></IconButton>
    <IconButton size="sm" label={`${label}: ${toLabel.toLowerCase()}`} hint={toLabel} disabled={disabled || value.length === 0} onclick={() => { onchange(toHere(value, here())) }}><ArrowLeftToLine size={13} /></IconButton>
  </div>
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</div>

<style>
  .windows { display: flex; flex-direction: column; gap: 3px; }
  .label { color: var(--text-3); font-size: 11.5px; }
  .row { display: flex; align-items: center; gap: 4px; }
  .row :global(input) { flex: 1; min-width: 0; }
  .error { color: var(--danger); font-size: 11.5px; }
</style>
