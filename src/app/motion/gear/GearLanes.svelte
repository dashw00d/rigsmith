<script lang="ts">
  // One gear piece's strips in the timeline (src/app/motion/lanes.ts): Held by, a segment per holder (who carries it
  // from each switch on: its Gear bone first), and Shown, its hidden spans. Split the Held-by strip at the playhead,
  // drag a boundary (frames; Alt free), pick a segment and set its holder in the inspector; hide from the playhead,
  // drag a hidden span or its edges. Every gesture is one slot.gear.update (one undo); Delete takes out the selected
  // boundary or span. Drawn in played phases, stored in source time (view.toPlayed / toSource).
  import { Eye, EyeOff, Scissors } from '@lucide/svelte'
  import { app } from '../../../state/app.svelte.ts'
  import type { GearTrack } from '../../../model/types.ts'
  import { tooltip } from '../../../ui/tooltip.ts'
  import type { TimelineView } from '../lanes.ts'
  import { boneName, hiddenOf, moveBoundary, moveEdge, moveSpan, segmentsOf, splitAt, toggleFrom, unhide, type Held, type Shown } from './strips.ts'

  let { view, gear }: { view: TimelineView, gear: string } = $props()

  const piece = $derived(view.character.gear.find(g => g.id === gear))
  const track = $derived(view.slot.gear?.[gear])
  // (while a drag is under way, what it would write; else what is stored)
  let draftHeld = $state<Held | null>(null)
  let draftShown = $state<Shown | null>(null)
  const held = $derived(draftHeld ?? track?.heldBy ?? [])
  const shown = $derived(draftShown ?? track?.shown ?? [])
  const segments = $derived(piece === undefined ? [] : segmentsOf(piece, held, view.toPlayed))
  const spans = $derived(hiddenOf(shown))
  const muted = $derived((view.slot.muted ?? []).some(m => m === 'gear' || m === `gear:${gear}`))
  const busy = $derived(view.baked === null)
  const playheadU = $derived(view.toSource(view.playhead))
  const canSplit = $derived(piece !== undefined && piece.attach.kind === 'bone' && view.playhead > 0 && view.playhead < 1 && splitAt(piece, held, playheadU) !== null)
  const hiddenNow = $derived(spans.some(s => playheadU >= s.from - 1e-9 && playheadU < s.to))
  let heldBody = $state<HTMLDivElement>()
  let shownBody = $state<HTMLDivElement>()

  const isSelected = (trackName: string, id: string): boolean => view.selection.some(s => s.track === trackName && s.id === id)
  const frameText = (played: number): string => `frame ${Math.round(Math.min(1, Math.max(0, played)) * view.frames)}`
  const clampX = (played: number): number => view.toX(Math.min(1, Math.max(0, played)))
  const sourceAt = (e: PointerEvent, body: HTMLDivElement | undefined): number => {
    const rect = body?.getBoundingClientRect()
    const x = rect === undefined ? 0 : (e.clientX - rect.left) * (view.width / Math.max(rect.width, 1))
    return view.toSource(Math.min(1, Math.max(0, view.snap(view.fromX(x), e.altKey))))
  }

  async function write (patch: { heldBy?: Held | null, shown?: Shown | null }): Promise<void> {
    const p: { heldBy?: GearTrack['heldBy'] | null, shown?: GearTrack['shown'] | null } = {}
    if (patch.heldBy !== undefined) p.heldBy = patch.heldBy === null || patch.heldBy.length === 0 ? null : patch.heldBy
    if (patch.shown !== undefined) p.shown = patch.shown === null || patch.shown.length === 0 ? null : patch.shown
    await app.do(view.character.id, { type: 'slot.gear.update', slot: view.slot.id, gear, patch: p })
  }

  function split (): void {
    if (piece === undefined) return
    const next = splitAt(piece, held, playheadU)
    if (next === null) return
    void write({ heldBy: next })
    const index = next.findIndex(x => Math.abs(x.u - playheadU) < 1e-9)
    view.select([{ track: `held:${gear}`, id: String(index), u: playheadU }], 'set')
  }

  function toggleShown (): void { void write({ shown: toggleFrom(shown, playheadU) }) }

  /** A drag: `move` turns the pointer's source moment into the draft; let go, the draft is written once. */
  function drag (e: PointerEvent, body: HTMLDivElement | undefined, move: (u: number) => void, done: () => void): void {
    if (busy || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const target = e.currentTarget as HTMLElement
    // (a pointer that is gone already can't be captured: the drag still follows it while it is over the strip)
    try { target.setPointerCapture(e.pointerId) } catch { /* nothing to capture */ }
    let moved = false
    const onMove = (ev: PointerEvent): void => { moved = true; move(sourceAt(ev, body)) }
    const onUp = (): void => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      if (moved) done()
      draftHeld = null; draftShown = null
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  function dragBoundary (e: PointerEvent, index: number): void {
    const stored = track?.heldBy ?? []
    view.select([{ track: `held:${gear}`, id: String(index), u: stored[index].u }], e.shiftKey ? 'add' : 'set')
    drag(e, heldBody, u => { draftHeld = moveBoundary(stored, index, u) }, () => { if (draftHeld !== null) void write({ heldBy: draftHeld }) })
  }

  function dragSpan (e: PointerEvent, i: number, part: 'from' | 'to' | 'body'): void {
    const stored = track?.shown ?? []
    const span = hiddenOf(stored)[i]
    view.select([{ track: `shown:${gear}`, id: String(i), u: span.from }], e.shiftKey ? 'add' : 'set')
    const grab = sourceAt(e, shownBody)
    drag(e, shownBody, u => {
      draftShown = part === 'body' ? moveSpan(stored, i, u - grab) : moveEdge(stored, i, part, u)
    }, () => { if (draftShown !== null) void write({ shown: draftShown }) })
  }

  function pickSegment (e: MouseEvent, index: number, from: number): void {
    view.select([{ track: `held:${gear}`, id: String(index), u: view.toSource(from) }], e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set')
  }

  function onKey (e: KeyboardEvent): void {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    const boundaries = view.selection.filter(s => s.track === `held:${gear}`).map(s => Number(s.id)).filter(i => i >= 0)
    const hidden = view.selection.filter(s => s.track === `shown:${gear}`).map(s => Number(s.id))
    if (boundaries.length === 0 && hidden.length === 0) return
    e.preventDefault()
    const patch: { heldBy?: Held, shown?: Shown } = {}
    if (boundaries.length > 0) patch.heldBy = (track?.heldBy ?? []).filter((_, i) => !boundaries.includes(i))
    if (hidden.length > 0) patch.shown = [...hidden].sort((a, b) => b - a).reduce((s, i) => unhide(s, i), track?.shown ?? [])
    void write(patch)
    view.select([], 'set')
  }

  const toneOf = (bone: string): string => (/^Left/.test(bone) ? 'left' : /^Right/.test(bone) ? 'right' : 'center')
  const howText: Record<string, string> = { gear: 'as placed in Gear', place: 'at a pinned place', handle: 'on its handle', placed: 'as placed in Gear', free: 'where it was (no pop)' }
</script>

{#if piece !== undefined}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="lanes" class:muted onkeydown={onKey} tabindex="-1" role="group" aria-label="{piece.name}: held by and shown">
    <div class="lane">
      <span class="label">
        Held by
        <button class="tool" disabled={!canSplit || busy} onclick={split} aria-label="Change hands at the playhead" use:tooltip={`Change hands at ${frameText(view.playhead)} (split the strip here)`}><Scissors size={11} /></button>
      </span>
      <div class="body" bind:this={heldBody} style:width="{view.width}px">
        {#each segments as s (s.index)}
          {@const selected = isSelected(`held:${gear}`, String(s.index))}
          <button class="segment {toneOf(s.bone)}" class:selected class:first={s.index === -1} style:left="{clampX(s.from)}px" style:width="{Math.max(1, clampX(s.to) - clampX(s.from))}px"
            disabled={busy} onclick={(e) => pickSegment(e, s.index, s.from)} aria-label="{boneName(s.bone)} from {frameText(s.from)}"
            use:tooltip={`${boneName(s.bone)} ${howText[s.how]}, ${frameText(s.from)} to ${frameText(s.to)}`}>
            <span class="text">{boneName(s.bone)}</span>
          </button>
        {/each}
        {#each segments as s (s.index)}
          {#if s.index >= 0 && s.from > 0}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="boundary" class:selected={isSelected(`held:${gear}`, String(s.index))} style:left="{clampX(s.from)}px"
              onpointerdown={(e) => dragBoundary(e, s.index)} use:tooltip={`Changes hands at ${frameText(s.from)}: drag (Alt: between frames)`}></div>
          {/if}
        {/each}
        <div class="playhead" style:left="{clampX(view.playhead)}px"></div>
      </div>
    </div>
    <div class="lane">
      <span class="label">
        Shown
        <button class="tool" disabled={busy || view.playhead >= 1} onclick={toggleShown} aria-label={hiddenNow ? 'Show from the playhead' : 'Hide from the playhead'}
          use:tooltip={hiddenNow ? `Show it again from ${frameText(view.playhead)}` : `Hide it from ${frameText(view.playhead)}`}>
          {#if hiddenNow}<Eye size={11} />{:else}<EyeOff size={11} />{/if}
        </button>
      </span>
      <div class="body shown-body" bind:this={shownBody} style:width="{view.width}px">
        {#each spans as s, i (s.start)}
          {@const from = view.toPlayed(s.from)}
          {@const to = s.to === Infinity ? 1 : view.toPlayed(s.to)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="hidden" class:selected={isSelected(`shown:${gear}`, String(i))} style:left="{clampX(from)}px" style:width="{Math.max(2, clampX(to) - clampX(from))}px"
            onpointerdown={(e) => dragSpan(e, i, 'body')} use:tooltip={`Hidden ${frameText(from)} to ${s.to === Infinity ? 'the end' : frameText(to)}: drag it or its edges`}>
            <div class="edge from" onpointerdown={(e) => dragSpan(e, i, 'from')}></div>
            {#if s.to !== Infinity}<div class="edge to" onpointerdown={(e) => dragSpan(e, i, 'to')}></div>{/if}
          </div>
        {/each}
        <div class="playhead" style:left="{clampX(view.playhead)}px"></div>
      </div>
    </div>
  </div>
{/if}

<style>
  .lanes { display: flex; flex-direction: column; gap: 2px; outline: none; }
  .lanes.muted { opacity: 0.45; }
  .lane { position: relative; display: flex; align-items: center; height: 16px; }
  /* (in the timeline's label column, left of the lane: the strip's x is the lane's, as the ruler's) */
  .label { position: absolute; right: calc(100% + 6px); width: 72px; display: flex; align-items: center; justify-content: space-between; gap: 2px; padding-right: 5px; font-size: 10px; color: var(--text-3); white-space: nowrap; }
  .tool { width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--text-3); display: grid; place-items: center; }
  .tool:hover:not(:disabled) { color: var(--text-1); background: var(--bg-3); }
  .tool:disabled { opacity: 0.35; }
  .body { position: relative; flex: none; height: 12px; border-radius: 3px; background: var(--bg-2); }
  .segment { position: absolute; top: 0; height: 12px; padding: 0 4px; border: 0; border-left: 1px solid var(--bg-1); border-radius: 3px; overflow: hidden;
    background: color-mix(in srgb, var(--side-center) 30%, transparent); color: var(--text-2); font-size: 9.5px; line-height: 12px; text-align: left; }
  .segment.left { background: color-mix(in srgb, var(--side-left) 32%, transparent); }
  .segment.right { background: color-mix(in srgb, var(--side-right) 32%, transparent); }
  .segment.first { background: var(--bg-3); }
  .segment:hover:not(:disabled), .segment.selected { color: var(--text-1); box-shadow: inset 0 0 0 1px var(--accent); }
  .segment .text { white-space: nowrap; pointer-events: none; }
  .boundary { position: absolute; top: -2px; width: 7px; height: 16px; margin-left: -3.5px; cursor: ew-resize; touch-action: none; }
  .boundary::after { content: ''; position: absolute; left: 3px; top: 0; bottom: 0; width: 1.5px; border-radius: 1px; background: var(--text-2); }
  .boundary:hover::after, .boundary.selected::after { background: var(--accent-strong); width: 2px; }
  .hidden { position: absolute; top: 0; height: 12px; border-radius: 3px; cursor: grab; touch-action: none;
    background: repeating-linear-gradient(135deg, var(--bg-4) 0 3px, transparent 3px 6px); box-shadow: inset 0 0 0 1px var(--line-strong); }
  .hidden.selected, .hidden:hover { box-shadow: inset 0 0 0 1px var(--accent); }
  .edge { position: absolute; top: 0; bottom: 0; width: 5px; cursor: ew-resize; }
  .edge.from { left: -2px; }
  .edge.to { right: -2px; }
  .playhead { position: absolute; top: -2px; bottom: -2px; width: 1px; background: var(--text-2); pointer-events: none; }
</style>
