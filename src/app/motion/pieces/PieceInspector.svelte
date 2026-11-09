<script lang="ts">
  // A piece of the clip selected on the Clip strip (docs/motion-plan.md §11): what it plays, the part of it (seconds of
  // its content; a held pose: how long it holds), its blend in over the piece before, and Remove (what is keyed on it
  // goes with it; Ctrl+Z brings it back). Each change is one undo.
  import { Footprints, Trash2 } from '@lucide/svelte'
  import { clipPieces } from '../../../state/pieces.svelte.ts'
  import type { Playing } from '../../../state/timeline.svelte.ts'
  import NumberField from '../../../ui/NumberField.svelte'
  import Button from '../../../ui/Button.svelte'
  import { tooltip } from '../../../ui/tooltip.ts'

  let { p, id }: { p: Playing, id: string } = $props()

  const s = $derived(clipPieces.shown(p).find(x => x.piece.id === id) ?? null)
  const content = $derived(s === null ? undefined : clipPieces.contentOf(p, s.piece))
  const n = $derived(clipPieces.now(p))
  const blend = $derived(s === null || n === null ? 0 : (s.piece.blend ?? 0) / Math.max(1e-9, n.perPlayed))
  const moving = $derived(s !== null && s.piece.kind !== 'hold')
  const before = $derived(s === null || s.index === 0 ? undefined : n?.pieces[s.index - 1])
  let matching = $state(false)
  const what = $derived(s === null ? '' : s.piece.kind === 'hold' ? 'Held pose' : s.piece.kind === 'slot' ? 'Clip, as it plays' : 'Library clip')
</script>

{#if s !== null}
  <div class="box">
    <div class="row">
      <strong class="small">{s.label}</strong>
      <span class="faint small">{what} · piece {s.index + 1} of {n?.pieces.length ?? 1}</span>
      <span class="spacer"></span>
      {#if !s.whole}
        <Button size="sm" icon onclick={() => { void clipPieces.remove(p, [id]) }} aria-label="Remove the piece"><Trash2 size={13} /></Button>
      {/if}
    </div>
    {#if s.piece.kind === 'hold'}
      <div class="row">
        <span class="small">Holds</span>
        <NumberField size="sm" value={s.piece.to - s.piece.from} min={1 / 30} step={0.05} digits={2} unit="s"
          onchange={(v) => { void clipPieces.update(p, id, { to: s.piece.from + v }) }} />
        <span class="faint small" use:tooltip={'The pose where the piece before ends (the first: where the next begins). Key it like any other time'}>the pose where the piece before ends</span>
      </div>
    {:else}
      <div class="row">
        <span class="small">Plays</span>
        <NumberField size="sm" value={s.piece.from} min={0} max={s.piece.to - 1 / 30} step={0.05} digits={2} unit="s" onchange={(v) => { void clipPieces.update(p, id, { from: v }) }} />
        <span class="small">to</span>
        <NumberField size="sm" value={s.piece.to} min={s.piece.from + 1 / 30} max={content} step={0.05} digits={2} unit="s" onchange={(v) => { void clipPieces.update(p, id, { to: v }) }} />
        {#if content !== undefined}<span class="faint small">of {content.toFixed(2)} s</span>{/if}
      </div>
    {/if}
    {#if s.index > 0}
      <div class="row">
        <span class="small" use:tooltip={'How long it cross-fades in over the end of the piece before (0: a cut)'}>Blend in</span>
        <NumberField size="sm" value={blend} min={0} step={0.05} digits={2} unit="s" onchange={(v) => { void clipPieces.blend(p, id, v) }} />
        {#if moving && before?.kind !== 'hold'}
          <Button size="sm" variant="ghost" disabled={matching} onclick={async () => { matching = true; try { await clipPieces.matchFeet(p, id) } finally { matching = false } }}
            title="Start it where its feet carry on the stride of the piece before (the same foot as far through its step), keeping its length">
            <Footprints size={13} /> Match feet</Button>
        {/if}
      </div>
    {/if}
    <p class="faint small">Its keys, events and hand bars stay on it: trimming, moving or blending it never slides them.</p>
  </div>
{/if}

<style>
  .box { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px; background: var(--bg-2); }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .small { font-size: 11.5px; }
  p { margin: 0; }
</style>
