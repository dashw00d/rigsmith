<script lang="ts">
  // The Clip strip (docs/motion-plan.md §11): the pieces the slot playing is built from, where they play (a slot playing
  // its clip whole: one piece). Drag a piece's ends to trim it or let it out, its body to put it elsewhere in the order,
  // the diamond on its top left to blend it in over the piece before; the clip's own start and end (the bright grips at
  // the strip's ends) to make the clip longer (a held pose: real time to key) or shorter. Click to select (Delete or the
  // cross takes a piece out, with what is keyed on it). Every gesture is one command batch, one undo
  // (src/state/pieces.svelte.ts).
  import { X } from '@lucide/svelte'
  import type { TimelineView } from '../lanes.ts'
  import { clipPieces, type ShownPiece } from '../../../state/pieces.svelte.ts'
  import { timeline } from '../../../state/timeline.svelte.ts'
  import { tooltip } from '../../../ui/tooltip.ts'

  let { view }: { view: TimelineView } = $props()

  const p = $derived(timeline.playing)
  const shown = $derived(clipPieces.shown(p))
  const busy = $derived(p?.baked === null)
  $effect(() => { if (p !== null) void clipPieces.measure(p) })

  type Drag =
    | { kind: 'move', id: string, x0: number, dx: number }
    | { kind: 'trim', id: string, edge: 'start' | 'end', x0: number, dx: number, free: boolean }
    | { kind: 'blend', id: string, x0: number, dx: number }
    | { kind: 'end' | 'start', x0: number, dx: number, free: boolean }
  let drag = $state.raw<Drag | null>(null)

  const dvOf = (dx: number): number => view.fromX(dx) - view.fromX(0)
  /** A drag in played phase, snapped to frames unless free. */
  const snapped = (dx: number, free = false): number => (free ? dvOf(dx) : Math.round(dvOf(dx) * view.frames) / view.frames)
  const px = (v: number): string => `${view.toX(v)}px`
  const seconds = (dv: number): string => `${dv >= 0 ? '+' : '−'}${Math.abs(dv * view.duration).toFixed(2)} s`

  function down (e: PointerEvent, d: Drag, select?: string): void {
    if (e.button !== 0 || busy || p === null) return
    e.stopPropagation(); e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (select !== undefined) timeline.select([{ track: 'pieces', id: select, u: 0 }], e.shiftKey ? 'add' : 'set')
    drag = d
  }
  function move (e: PointerEvent): void {
    const d = drag
    if (d === null) return
    drag = { ...d, dx: e.clientX - d.x0, ...('free' in d ? { free: e.altKey } : {}) } as Drag
  }
  function up (): void {
    const d = drag
    drag = null
    if (d === null || p === null || Math.abs(d.dx) < 3) return
    switch (d.kind) {
      case 'end': void clipPieces.endTo(p, 1 + snapped(d.dx, d.free)); break
      case 'start': void clipPieces.startTo(p, snapped(d.dx, d.free)); break
      case 'trim': void clipPieces.trim(p, d.id, d.edge, snapped(d.dx, d.free)); break
      case 'blend': {
        const s = shown.find(x => x.piece.id === d.id)
        if (s !== undefined) void clipPieces.blend(p, d.id, Math.max(0, (s.blendTo - s.from + dvOf(d.dx)) * view.duration))
        break
      }
      case 'move': {
        // (where its middle was let go, among the others' middles)
        const s = shown.find(x => x.piece.id === d.id)
        if (s === undefined) break
        const mid = (s.from + s.to) / 2 + dvOf(d.dx)
        const others = shown.filter(x => x.piece.id !== d.id)
        const index = others.filter(x => (x.from + x.to) / 2 < mid).length
        if (index !== s.index) void clipPieces.move(p, d.id, index)
        break
      }
    }
  }

  /** Where a piece shows while a drag of it is under way. */
  function placeOf (s: ShownPiece): { from: number, to: number, blendTo: number } {
    const d = drag
    let { from, to, blendTo } = s
    if (d?.kind === 'move' && d.id === s.piece.id) { const dv = dvOf(d.dx); from += dv; to += dv; blendTo += dv }
    if (d?.kind === 'trim' && d.id === s.piece.id) {
      if (d.edge === 'start') from = Math.min(to - 1 / view.frames, from + snapped(d.dx, d.free))
      else to = Math.max(from + 1 / view.frames, to + snapped(d.dx, d.free))
    }
    if (d?.kind === 'blend' && d.id === s.piece.id) blendTo = Math.min(to, Math.max(from, blendTo + dvOf(d.dx)))
    if (d?.kind === 'end' && s === shown.at(-1)) to = Math.max(from + 1 / view.frames, to + snapped(d.dx, d.free))
    if (d?.kind === 'start' && s === shown[0]) from = Math.min(to - 1 / view.frames, from + snapped(d.dx, d.free))
    return { from, to, blendTo }
  }

  const near = (v: number, w: number): boolean => Math.abs(view.toX(v) - view.toX(w)) < 4
  const kindText = (s: ShownPiece): string => s.piece.kind === 'hold' ? 'A held pose: the pose where the piece before ends (real time: key it)'
    : s.piece.kind === 'slot' ? `${s.label} as it plays (its timing and keys)` : `The library clip ${s.label}`
  const range = (s: ShownPiece): string => s.piece.kind === 'hold' ? `${(s.piece.to - s.piece.from).toFixed(2)} s` : `${s.piece.from.toFixed(2)}–${s.piece.to.toFixed(2)} s of it`
</script>

<div class="strip" role="presentation" onpointermove={move} onpointerup={up} onpointercancel={() => { drag = null }}>
  {#each shown as s (s.piece.id)}
    {@const at = placeOf(s)}
    {@const on = timeline.isSelected('pieces', s.piece.id)}
    <div class="piece {s.piece.kind}" class:on class:dragging={drag !== null && 'id' in drag && drag.id === s.piece.id} style:left={px(at.from)} style:width={`${Math.max(4, view.toX(at.to) - view.toX(at.from))}px`}
      role="button" tabindex="-1" aria-label={`${s.label}, ${range(s)}`}
      use:tooltip={`${kindText(s)}: ${range(s)}${s.whole ? '. Drag the clip\'s ends to make it longer (a held pose) or shorter; + appends another clip' : '. Drag it to reorder, its ends to trim it'}`}
      onpointerdown={(e) => down(e, { kind: 'move', id: s.piece.id, x0: e.clientX, dx: 0 }, s.piece.id)}>
      {#if at.blendTo > at.from + 1e-9}<span class="blend" style:width={`${view.toX(at.blendTo) - view.toX(at.from)}px`}></span>{/if}
      <span class="name">{s.label}</span>
      {#if !near(at.from, 0) || shown.length > 1 && s.index > 0}
        <span class="grip start" role="presentation" use:tooltip={'Trim (or let out) its start'} onpointerdown={(e) => down(e, { kind: 'trim', id: s.piece.id, edge: 'start', x0: e.clientX, dx: 0, free: e.altKey }, s.piece.id)}></span>
      {/if}
      {#if !near(at.to, 1) || s !== shown.at(-1)}
        <span class="grip end" role="presentation" use:tooltip={'Trim (or let out) its end'} onpointerdown={(e) => down(e, { kind: 'trim', id: s.piece.id, edge: 'end', x0: e.clientX, dx: 0, free: e.altKey }, s.piece.id)}></span>
      {/if}
      {#if s.index > 0}
        <button class="diamond" style:left={`${view.toX(at.blendTo) - view.toX(at.from)}px`} aria-label={`Blend into ${s.label}`}
          use:tooltip={`Blend in over ${((s.blendTo - s.from) * view.duration).toFixed(2)} s: drag`} onpointerdown={(e) => down(e, { kind: 'blend', id: s.piece.id, x0: e.clientX, dx: 0 }, s.piece.id)}></button>
      {/if}
      {#if on && !s.whole}
        <button class="remove" aria-label={`Remove ${s.label}`} use:tooltip={'Remove it (what is keyed on it goes with it; Ctrl+Z brings it back)'}
          onpointerdown={(e) => e.stopPropagation()} onclick={() => { if (p !== null) void clipPieces.remove(p, [s.piece.id]) }}><X size={9} /></button>
      {/if}
    </div>
  {/each}
  <button class="edge start" aria-label="The clip's start" use:tooltip={'The clip\'s start: drag left for a held pose before it, right to cut its start'}
    onpointerdown={(e) => down(e, { kind: 'start', x0: e.clientX, dx: 0, free: e.altKey })}></button>
  <button class="edge end" style:left={px(1)} aria-label="The clip's end" use:tooltip={'The clip\'s end: drag right to make it longer (the last pose held, to key), left to cut it'}
    onpointerdown={(e) => down(e, { kind: 'end', x0: e.clientX, dx: 0, free: e.altKey })}></button>
  {#if drag !== null && (drag.kind === 'end' || drag.kind === 'start' || drag.kind === 'trim') && Math.abs(drag.dx) >= 3}
    <span class="readout" style:left={`${Math.min(view.width - 60, Math.max(0, (drag.kind === 'start' ? 0 : view.toX(1)) + drag.dx))}px`}>{seconds(snapped(drag.dx, drag.free))}</span>
  {/if}
</div>

<style>
  .strip { position: relative; height: 15px; }
  .piece { position: absolute; top: 1px; height: 13px; border-radius: 3px; background: rgb(142 162 255 / 32%); box-shadow: inset 0 0 0 1px rgb(142 162 255 / 45%); cursor: grab; overflow: hidden; display: flex; align-items: center; }
  .piece.slot { background: rgb(107 211 138 / 28%); box-shadow: inset 0 0 0 1px rgb(107 211 138 / 50%); }
  .piece.hold { background: repeating-linear-gradient(45deg, rgb(240 190 90 / 38%) 0 3px, rgb(240 190 90 / 14%) 3px 6px); box-shadow: inset 0 0 0 1px rgb(240 190 90 / 50%); }
  .piece.on { box-shadow: inset 0 0 0 1px var(--text-1); }
  .piece.dragging { opacity: 0.75; z-index: 2; cursor: grabbing; }
  .piece:hover { filter: brightness(1.2); }
  .name { position: relative; padding: 0 6px; font-size: 9.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
  .blend { position: absolute; top: 0; bottom: 0; left: 0; background: linear-gradient(to right, rgb(0 0 0 / 35%), transparent); pointer-events: none; }
  .grip { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; z-index: 1; }
  .grip.start { left: 0; }
  .grip.end { right: 0; }
  .grip:hover { background: rgb(255 255 255 / 30%); }
  .diamond { position: absolute; top: -1px; width: 7px; height: 7px; margin-left: -3.5px; padding: 0; border: 1px solid rgb(0 0 0 / 50%); background: var(--text-2); transform: rotate(45deg); cursor: ew-resize; z-index: 2; }
  .diamond:hover { background: var(--text-1); }
  .remove { position: absolute; right: 7px; top: 1px; width: 11px; height: 11px; padding: 0; border: 0; border-radius: 2px; display: grid; place-items: center; background: var(--bg-3); color: var(--text-1); z-index: 2; }
  .remove:hover { background: var(--danger); }
  .edge { position: absolute; top: 0; width: 6px; height: 15px; padding: 0; border: 0; border-radius: 2px; background: var(--accent); cursor: ew-resize; z-index: 3; }
  .edge.start { left: 0; }
  .edge.end { margin-left: -6px; }
  .edge:hover { filter: brightness(1.3); }
  .readout { position: absolute; top: -1px; padding: 0 4px; border-radius: 3px; background: var(--bg-4, #333); color: var(--text-1); font-size: 9.5px; font-variant-numeric: tabular-nums; pointer-events: none; z-index: 4; }
</style>
