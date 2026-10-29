<script lang="ts">
  // The Events track (docs/motion-plan.md §9 C1), mounted by the timeline with its TimelineView (src/app/motion/lanes.ts):
  // a row per name the slot's events have, each event a diamond (a moment) or a bar (a span) where it plays. Add one at
  // the playhead from the menu (the game's built-ins, the character's own names, or a name typed), or double-click a
  // row to add that name there; "Add footsteps" lays the steps the feet make. Click selects (Shift adds, Ctrl or Cmd
  // toggles) and moves the playhead there; drag moves the selection, on frames (Alt: free); a span's ends drag on their
  // own; Delete takes the selection off. The hit is the blow: while the fit measures it, it shows hollow, and moving it
  // picks it by hand (the Time track edits the same event). Each row's speaker mutes its preview here only.
  import { Footprints, Plus, Volume2, VolumeX } from '@lucide/svelte'
  import { events } from '../../../state/events.svelte.ts'
  import { app } from '../../../state/app.svelte.ts'
  import { tooltip } from '../../../ui/tooltip.ts'
  import type { SelectedItem, TimelineView } from '../lanes.ts'
  import { addEvent, MEASURED_HIT, measuredHit, moveEdge, moveEvents, playedEvents, removeEvents, type PlayedEvent } from './edit.ts'
  import { BUILT_INS, canonical, defaultsFor, labelOf, nameProblem, rowsOf, vocabulary } from './vocabulary.ts'

  let { view }: { view: TimelineView } = $props()

  interface Drag { kind: 'move' | 'start' | 'end', ids: string[], grabbed: string, x0: number, x: number, free: boolean, moved: boolean }
  let drag = $state<Drag | null>(null)
  let lane = $state<HTMLDivElement | null>(null)
  let menu = $state(false)
  let typed = $state('')
  let footBusy = $state(false)
  let anchor = $state<HTMLSpanElement | null>(null)
  let menuEl = $state<HTMLDivElement | null>(null)

  // (the menu is fixed over the page, above the Add button, or under it with no room above: the timeline's tracks
  // scroll and would cut it off)
  $effect(() => {
    if (menuEl === null || anchor === null) return
    menuEl.style.left = '0px'; menuEl.style.top = '0px'
    const origin = menuEl.getBoundingClientRect(); const a = anchor.getBoundingClientRect()
    const above = a.top - origin.height - 6
    menuEl.style.left = `${a.left - origin.left}px`
    menuEl.style.top = `${(above >= 4 ? above : a.bottom + 6) - origin.top}px`
  })
  $effect(() => {
    if (!menu) return
    const away = (e: PointerEvent): void => { if (anchor !== null && !anchor.contains(e.target as Node)) menu = false }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') menu = false }
    window.addEventListener('pointerdown', away); window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  })

  const c = $derived(view.character)
  const slot = $derived(view.slot)
  const measured = $derived(measuredHit(view.baked?.cut))
  const all = $derived(playedEvents(slot, view, measured))
  const rows = $derived(rowsOf(slot.events ?? [], measured !== null && !(slot.events ?? []).some(e => e.name === 'hit' && e.to === undefined)))
  const selected = $derived(new Set(events.selected(view)))
  const off = $derived((slot.muted ?? []).includes('events'))
  const words = $derived(vocabulary(c))
  const typedName = $derived(canonical(c, typed))
  const hasHit = $derived((slot.events ?? []).some(e => e.name === 'hit' && e.to === undefined))

  // (heard while the lane is up; the character's own sounds listed)
  $effect(() => events.watch(() => view))
  $effect(() => { void events.loadOwn(c.id) })

  const px = (e: PointerEvent | MouseEvent): number => (lane === null ? 0 : e.clientX - lane.getBoundingClientRect().left)
  const frameOf = (t: number): number => Math.round(t * view.frames)

  /** Where an event shows now: as stored, or where the drag has it. */
  function shown (e: PlayedEvent): { t: number, to?: number } {
    const d = drag
    if (d === null || !d.moved || !d.ids.includes(e.id)) return { t: e.t, to: e.to }
    const at = view.snap(view.fromX(d.x), d.free)
    if (d.kind === 'start') return { t: Math.min(at, (e.to ?? 1) - 1e-3), to: e.to }
    if (d.kind === 'end') return { t: e.t, to: Math.max(at, e.t + 1e-3) }
    const lead = all.find(x => x.id === d.grabbed) ?? e
    const moving = all.filter(x => d.ids.includes(x.id))
    let delta = view.snap(lead.t + view.fromX(d.x) - view.fromX(d.x0), d.free) - lead.t
    delta = Math.min(1 - Math.max(...moving.map(x => x.to ?? x.t)), Math.max(-Math.min(...moving.map(x => x.t)), delta))
    return { t: e.t + delta, to: e.to === undefined ? undefined : e.to + delta }
  }

  const item = (e: PlayedEvent): SelectedItem => ({ track: 'events', id: e.id, u: e.measured === true ? view.toSource(e.t) : (slot.events ?? []).find(x => x.id === e.id)?.u ?? view.toSource(e.t) })

  function grab (e: PointerEvent, ev: PlayedEvent, kind: Drag['kind'] = 'move'): void {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    lane?.focus()
    // (as it was before this click changes it)
    const was = new Set(selected)
    let ids: string[]
    if (e.shiftKey) { view.select([item(ev)], 'add'); ids = [...was, ev.id] }
    else if (e.ctrlKey || e.metaKey) {
      view.select([item(ev)], 'toggle')
      if (was.has(ev.id)) return
      ids = [...was, ev.id]
    } else if (!was.has(ev.id) || kind !== 'move') { view.select([item(ev)], 'set'); ids = [ev.id] }
    else ids = [...was]
    const x = px(e)
    drag = { kind, ids: kind === 'move' ? ids : [ev.id], grabbed: ev.id, x0: x, x, free: e.altKey, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  function move (e: PointerEvent): void {
    const d = drag
    if (d === null) return
    const x = px(e)
    drag = { ...d, x, free: e.altKey, moved: d.moved || Math.abs(x - d.x0) > 2 }
  }

  async function drop (e: PointerEvent): Promise<void> {
    const d = drag
    drag = null
    if (d === null) return
    const ev = all.find(x => x.id === d.grabbed)
    if (!d.moved) {
      if (ev !== undefined) view.seek(d.kind === 'end' ? ev.to ?? ev.t : ev.t)
      return
    }
    const free = e.altKey
    const at = view.fromX(px(e))
    const commands = d.kind === 'move'
      ? moveEvents(slot, d.ids, d.grabbed, at - view.fromX(d.x0), view, { free, measured })
      : moveEdge(slot, d.grabbed, d.kind, at, view, { free, minimum: 1 / Math.max(1, view.frames) })
    await events.run(view, commands)
  }

  /** An event of `name` at a played phase (a built-in span lasts a fifth of the clip, inside it). */
  async function add (name: string, played: number, free = false): Promise<void> {
    if (name === 'hit' && hasHit) { app.toast('info', 'The clip has its hit: move it instead'); return }
    const span = BUILT_INS[name as keyof typeof BUILT_INS]?.span === true ? 0.2 : undefined
    const cmd = addEvent(slot, name, played, view, { span, free, defaults: defaultsFor(c, slot, name) })
    if (await events.run(view, [cmd]) && cmd.type === 'slot.event.add') {
      view.select([{ track: 'events', id: cmd.event.id, u: cmd.event.u }], 'set')
    }
  }

  async function pick (name: string): Promise<void> {
    menu = false
    typed = ''
    await add(name, view.playhead)
  }

  async function footsteps (): Promise<void> {
    footBusy = true
    try {
      const n = await events.addFootsteps(view)
      if (n === null) app.toast('info', 'No feet to find steps on (or the clip is still baking)')
      else app.toast(n > 0 ? 'ok' : 'info', n > 0 ? `${n} footstep${n === 1 ? '' : 's'} added` : 'No new footsteps: the feet hardly lift, or every step has its event')
    } finally {
      footBusy = false
    }
  }

  function keydown (e: KeyboardEvent): void {
    if (e.target !== lane) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
      e.preventDefault()
      void events.run(view, removeEvents(slot, [...selected]))
      view.select([], 'set')
    } else if (e.key === 'Escape') {
      view.select([], 'set')
    }
  }

  function rowDblclick (e: MouseEvent, name: string): void {
    if (e.target !== e.currentTarget) return
    void add(name, view.fromX(px(e)), e.altKey)
  }

  const title = (ev: PlayedEvent): string => {
    const s = shown(ev)
    const where = s.to === undefined ? `frame ${frameOf(s.t)}` : `frames ${frameOf(s.t)}-${frameOf(s.to)}`
    if (ev.measured === true) return `The blow, measured, at ${where}: drag it to pick it by hand`
    return `${labelOf(ev.name)} at ${where}${ev.sound !== undefined ? ` · ${ev.sound.replace(/^(mix|file):(sounds\/)?/, '')}` : ''}`
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="events-lane" class:off bind:this={lane} tabindex="0" role="group" aria-label="Events" onkeydown={keydown}
  onpointermove={move} onpointerup={e => { void drop(e) }} onpointercancel={() => { drag = null }}>
  <div class="head" style:width="{view.width}px">
    {#if off}<span class="faint">Off: the game gets none of them</span>{/if}
    <span class="menu-anchor" bind:this={anchor}>
      <button type="button" class="chip" aria-haspopup="menu" aria-expanded={menu} onclick={() => { menu = !menu }} use:tooltip={'Add an event at the playhead'}>
        <Plus size={13} /> Add
      </button>
      {#if menu}
        <div class="menu" role="menu" bind:this={menuEl}>
          {#each words as w (w.name)}
            <button type="button" role="menuitem" class="item" disabled={w.name === 'hit' && hasHit} onclick={() => { void pick(w.name) }}
              use:tooltip={w.builtIn ? BUILT_INS[w.name as keyof typeof BUILT_INS].hint : `Used ${w.uses} time${w.uses === 1 ? '' : 's'} on ${c.name}`}>
              <span>{labelOf(w.name)}</span>{#if w.builtIn && labelOf(w.name) !== w.name}<span class="faint mono">{w.name}</span>{/if}
            </button>
          {/each}
          <form class="own" onsubmit={e => { e.preventDefault(); if (typedName !== null) void pick(typedName) }}>
            <input type="text" placeholder="Name your own…" maxlength="32" bind:value={typed} aria-label="An event name of your own" />
            {#if typed.trim() !== ''}
              <span class="hint" class:bad={typedName === null}>{typedName === null ? nameProblem(typed) : typedName !== typed.trim() ? `as ${typedName}` : 'Enter adds it'}</span>
            {/if}
          </form>
        </div>
      {/if}
    </span>
    <button type="button" class="chip" disabled={footBusy || view.baked === null} onclick={() => { void footsteps() }}
      use:tooltip={'A step event wherever a foot comes down in the clip as it plays (none where one is already)'}>
      <Footprints size={13} /> Add footsteps
    </button>
  </div>
  {#each rows as name (name)}
    {@const muted = events.isMuted(c.id, name)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="row" style:width="{view.width}px" ondblclick={e => { rowDblclick(e, name) }}>
      <span class="tag" class:muted>
        {labelOf(name)}
        <button type="button" class="mute" aria-pressed={muted} aria-label={muted ? `Hear ${name} in the preview` : `Mute ${name} in the preview`}
          onclick={() => { events.setMuted(c.id, name, !muted) }} use:tooltip={muted ? 'Muted in the preview (the game still gets it)' : 'Mute in the preview (the game still gets it)'}>
          {#if muted}<VolumeX size={11} />{:else}<Volume2 size={11} />{/if}
        </button>
      </span>
      {#each all.filter(x => x.name === name) as ev (ev.id)}
        {@const s = shown(ev)}
        {#if s.to !== undefined}
          <div class="span" class:selected={selected.has(ev.id)} style:left="{view.toX(s.t)}px" style:width="{Math.max(4, view.toX(s.to) - view.toX(s.t))}px"
            role="button" tabindex="-1" aria-label={title(ev)} use:tooltip={title(ev)} onpointerdown={e => { grab(e, ev) }}>
            <span class="edge start" role="presentation" onpointerdown={e => { grab(e, ev, 'start') }}></span>
            <span class="edge end" role="presentation" onpointerdown={e => { grab(e, ev, 'end') }}></span>
          </div>
        {:else}
          <div class="mark" class:selected={selected.has(ev.id)} class:measured={ev.measured === true} class:hit={ev.name === 'hit'} class:sound={ev.sound !== undefined}
            style:left="{view.toX(s.t)}px" role="button" tabindex="-1" aria-label={title(ev)} use:tooltip={title(ev)} onpointerdown={e => { grab(e, ev) }}></div>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="row empty" style:width="{view.width}px">
      <span class="faint">No events: add one at the playhead{view.baked !== null ? ', or let Add footsteps find the steps' : ''}</span>
    </div>
  {/each}
  {#if drag?.moved === true}
    {@const ev = all.find(x => x.id === drag?.grabbed)}
    {#if ev !== undefined}
      {@const s = shown(ev)}
      <span class="readout" style:left="{view.toX(drag.kind === 'end' ? s.to ?? s.t : s.t)}px">{frameOf(drag.kind === 'end' ? s.to ?? s.t : s.t)}</span>
    {/if}
  {/if}
</div>

<style>
  .events-lane {
    position: relative;
    outline: none;
    user-select: none;
    font-size: 11px;
  }
  .events-lane:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-soft); }
  .events-lane.off .row { opacity: 0.45; }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
  }
  .faint { color: var(--text-3); }
  .mono { font-family: var(--mono); font-size: 10.5px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--r-1);
    background: var(--bg-3);
    color: var(--text-2);
    font: inherit;
    cursor: pointer;
  }
  .chip:hover:not(:disabled) { background: var(--bg-4); color: var(--text-1); }
  .chip:disabled { opacity: 0.5; cursor: default; }
  .menu-anchor { position: relative; }
  .menu {
    position: fixed;
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: 220px;
    max-height: 320px;
    overflow: auto;
    padding: 4px;
    border-radius: var(--r-2);
    background: var(--bg-2);
    box-shadow: var(--shadow-pop);
    animation: pop var(--med) var(--ease);
  }
  @keyframes pop { from { opacity: 0; } }
  .item {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--r-1);
    background: none;
    color: var(--text-1);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .item:hover:not(:disabled) { background: var(--bg-3); }
  .item:disabled { color: var(--text-4); cursor: default; }
  .own { display: flex; flex-direction: column; gap: 3px; padding: 6px 4px 2px; border-top: 1px solid var(--line); margin-top: 4px; }
  .own input {
    height: 24px;
    padding: 0 7px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-1);
    background: var(--bg-1);
    color: var(--text-1);
    font: inherit;
    font-size: 12px;
  }
  .own input:focus { outline: none; border-color: var(--accent); }
  .hint { color: var(--text-3); font-size: 10.5px; padding-left: 2px; }
  .hint.bad { color: var(--danger); }
  .row {
    position: relative;
    height: 20px;
    border-top: 1px solid var(--line);
  }
  .row.empty { display: flex; align-items: center; }
  .tag {
    position: absolute;
    left: 2px;
    top: 3px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 3px 0 5px;
    height: 14px;
    border-radius: 4px;
    background: rgb(16 18 23 / 70%);
    color: var(--text-3);
    font-size: 10px;
    pointer-events: none;
  }
  .tag.muted { color: var(--text-4); }
  .mute {
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    pointer-events: auto;
  }
  .mute:hover { color: var(--text-1); }
  .mark {
    position: absolute;
    top: 5px;
    z-index: 1;
    width: 9px;
    height: 9px;
    margin-left: -4.5px;
    transform: rotate(45deg);
    border-radius: 2px;
    background: var(--text-2);
    cursor: grab;
  }
  .mark.sound { background: var(--ok); }
  .mark.hit { background: var(--warn); }
  .mark.measured { background: transparent; box-shadow: inset 0 0 0 1.5px var(--warn); }
  .mark.selected { background: var(--accent-strong); box-shadow: 0 0 0 2px var(--accent-soft); }
  .span {
    position: absolute;
    top: 5px;
    z-index: 1;
    height: 10px;
    border-radius: 3px;
    background: rgb(164 170 186 / 35%);
    box-shadow: inset 0 0 0 1px var(--text-3);
    cursor: grab;
  }
  .span.selected { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent-strong); }
  .edge { position: absolute; top: -2px; bottom: -2px; width: 6px; cursor: ew-resize; }
  .edge.start { left: -3px; }
  .edge.end { right: -3px; }
  .readout {
    position: absolute;
    top: 2px;
    z-index: 2;
    transform: translateX(-50%) translateY(-100%);
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--bg-4);
    color: var(--text-1);
    font-family: var(--mono);
    font-size: 10px;
    pointer-events: none;
  }
</style>
