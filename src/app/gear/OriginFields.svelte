<script lang="ts">
  // A piece's origin (Gear.origin): the point it turns about, where the gizmo sits, what its keys turn round in clips.
  // A file modelled in place on a character has it at the character's feet; put it on the piece: its middle, where a
  // hand holds it, its base, or anywhere by dragging the yellow dot. Nothing moves (one undo each).
  import { Crosshair, RotateCcw } from '@lucide/svelte'
  import type { Character, Gear } from '../../state/api.ts'
  import { gear as gearState, type OriginAt } from '../../state/gear.svelte.ts'
  import Button from '../../ui/Button.svelte'

  let { character, gear }: { character: Character, gear: Gear } = $props()

  const placing = $derived(gearState.placingOrigin === gear.id)
  const moved = $derived(gear.origin !== undefined)
  const hand = $derived(gearState.inHand(gear))
  const choices = $derived<Array<{ at: OriginAt, label: string, hint: string }>>([
    { at: 'middle', label: 'Middle', hint: 'The middle of it as it sits' },
    { at: 'grip', label: 'Grip', hint: hand ? 'Where the hand holds it' : 'Where a hand holds it (a grip handle), else the middle of its handle end' },
    { at: 'base', label: 'Base', hint: 'The middle of its bottom as it sits' },
  ])
  let busy = $state<string | null>(null)

  async function set (at: OriginAt | null): Promise<void> {
    busy = at ?? 'file'
    try {
      await gearState.setOrigin(character, gear, at)
    } finally {
      busy = null
    }
  }

  function onkeydown (event: KeyboardEvent): void {
    if (!placing || (event.key !== 'Escape' && event.key !== 'Enter')) return
    gearState.placeOrigin(null)
    event.preventDefault()
  }
</script>

<svelte:window {onkeydown} />

<div class="origin" role="group" aria-label="Origin">
  <span class="label">Origin</span>
  <div class="row">
    {#each choices as c (c.at)}
      <Button size="sm" title={c.hint} disabled={placing} loading={busy === c.at} onclick={() => set(c.at)}>{c.label}</Button>
    {/each}
    <Button size="sm" variant={placing ? 'primary' : 'secondary'} title="Drag the origin with the gizmo; the piece stays where it is"
      onclick={() => gearState.placeOrigin(placing ? null : gear.id)}><Crosshair size={12} /> {placing ? 'Done' : 'Drag'}</Button>
  </div>
  <p class="hint">
    {#if placing}
      Drag the yellow dot; the piece stays where it is. Enter or Esc when done.
    {:else if moved}
      What it turns about and the gizmo sits on (moved off its file's).
    {:else}
      What it turns about and the gizmo sits on: its file's own.
    {/if}
  </p>
  {#if moved && !placing}
    <Button size="sm" variant="ghost" loading={busy === 'file'} onclick={() => set(null)} title="Back to the origin its file has (nothing moves)">
      <RotateCcw size={12} /> Its file's origin</Button>
  {/if}
</div>

<style>
  .origin { display: flex; flex-direction: column; gap: 6px; }
  .label { font-size: 12px; color: var(--text-3); }
  .row { display: flex; flex-wrap: wrap; gap: 4px; }
  .hint { margin: 0; font-size: 12px; color: var(--text-3); }
  .origin :global(.btn.ghost) { align-self: flex-start; }
</style>
