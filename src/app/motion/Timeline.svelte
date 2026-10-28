<script lang="ts">
  // The timeline docked under the viewport while anything plays (the animator registers it). One frame numbering
  // everywhere: frames of the clip as it plays (its speed, blow cut and pace in it), 30 a second, counted within one
  // cycle of a ridden loop. Under the bar, lanes for the playing slot's adjustments as baked: each hand's poses and
  // pulls (windows), the handles held, the keys and the blow; while the editor is open, its keys. Loop, mirror, speed
  // (and a library preview's in place) are the preview's only: nothing they change is saved or exported.
  import { ChevronLeft, ChevronRight, FlipHorizontal2, Footprints, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward, Swords } from '@lucide/svelte'
  import type { Side, Window } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { adjust } from '../../state/adjust.svelte.ts'
  import { clipEdit } from '../../state/clipedit.svelte.ts'
  import { slotById } from '../../model/select.ts'
  import { tooltip } from '../../ui/tooltip.ts'
  import { allowsShortcut } from '../../ui/shortcuts.ts'
  import {
    blowPhase, cycleAt, frameOf, framesOf, keysOf, lateness, overCycles, phasesOverCycles, speedOptions, targetOf, timeAt, windowsText,
  } from './rules.ts'

  let scrubbing = $state(false)
  let wasRunning = false

  const now = $derived(animator.playing)
  const character = $derived(now === null ? null : app.byId(now.characterId))
  const editing = $derived(now?.editing === true)
  const slot = $derived(now?.kind === 'slot' && character !== null ? slotById(character, now.slotId ?? '') : undefined)
  const baked = $derived(editing ? null : now?.baked ?? null)
  const cycles = $derived(Math.max(1, now?.cycles ?? 1))
  const duration = $derived(animator.duration)
  const frames = $derived(framesOf(duration, cycles))
  const at = $derived(duration > 0 ? Math.min(1, Math.max(0, animator.time / duration)) : 0)
  const cycle = $derived(cycleAt(at, cycles))
  const frame = $derived(frameOf(now?.phase ?? 0, frames))
  const busy = $derived(clipEdit.busy !== null || animator.loading)
  const kind = $derived(editing ? 'Editing' : now?.kind === 'library' ? 'Preview' : now?.kind === 'test' ? 'Rig test' : null)

  interface Bar { from: number, to: number, title: string, adjustment?: string }
  interface Mark { at: number, title: string, target?: string, adjustment?: string }
  interface Lane { key: string, label: string, bars: Bar[], marks: Mark[], blow?: boolean }

  // (the playing slot's adjustments as it was baked: windows and keys are phases of one cycle, laid over every cycle)
  const lanes = $derived.by((): Lane[] => {
    if (slot === undefined || baked === null || character === null) return []
    const out: Lane[] = []
    for (const side of ['Left', 'Right'] as Side[]) {
      const layers = baked.hands[side].filter(l => l.source === 'slot' || l.source === 'pull')
      if (layers.length === 0) continue
      out.push({
        key: `hand-${side}`, label: `${side} hand`, marks: [],
        bars: layers.flatMap(l => overCycles(l.windows ?? [[0, 1]], cycles).map(([from, to]) => ({
          from, to, title: `${l.reason}: ${windowsText(l.windows, frames)}`, adjustment: l.adjustment,
        }))),
      })
    }
    for (const a of slot.adjustments) {
      if (!a.enabled || a.kind !== 'handleHold') continue
      const g = character.gear.find(x => x.id === a.gear)
      const h = g?.handles.find(x => x.id === a.handle)
      const label = `${g?.name ?? 'Gear'} · ${h?.name ?? 'handle'}`
      out.push({
        key: `hold-${a.id}`, label, marks: [],
        bars: overCycles(a.windows, cycles).map(([from, to]) => ({ from, to, title: `Held: ${windowsText(a.windows, frames)}`, adjustment: a.id })),
      })
    }
    const keys = slot.adjustments.find(a => a.enabled && a.kind === 'keys')
    if (keys?.kind === 'keys') {
      const targets = [
        ...Object.keys(keys.bones ?? {}).map(n => ({ target: `bone:${n}`, name: n })),
        ...Object.keys(keys.gear ?? {}).map(id => ({ target: `gear:${id}`, name: character.gear.find(g => g.id === id)?.name ?? 'gear' })),
      ]
      const marks = targets.flatMap(t => keysOf(keys, t.target).flatMap(k => phasesOverCycles([k.u], cycles).map(u => ({
        at: u, title: `${t.name}: key at frame ${frameOf(k.u, frames)}`, target: t.target, adjustment: keys.id,
      }))))
      if (marks.length > 0) out.push({ key: 'keys', label: 'Keys', bars: [], marks })
    }
    const blow = slot.adjustments.find(a => a.enabled && a.kind === 'blowTiming')
    if (baked.cut !== undefined && blow?.kind === 'blowTiming') {
      const u = blowPhase(baked.cut)
      const late = lateness(blow, baked.cut)
      out.push({
        key: 'blow', label: 'Blow', bars: [], blow: true,
        marks: phasesOverCycles([u], cycles).map(x => ({ at: x, title: `The blow, at frame ${frameOf(u, frames)}${late === null ? '' : ` · ${late}`}`, adjustment: blow.id })),
      })
    }
    return out
  })

  function seek (time: number): void {
    animator.setPlaying(false)
    const t = Math.max(0, Math.min(duration, time))
    animator.seek(clipEdit.active ? clipEdit.snapTime(t) : t)
  }

  /** A frame of the cycle shown. */
  function seekFrame (value: number): void {
    if (!Number.isFinite(value)) return
    seek(timeAt(Math.max(0, Math.min(frames, Math.round(value))) / frames, cycle, cycles, duration))
  }

  /** A part of the whole clip playing (all its cycles). */
  const seekAt = (u: number): void => { seek(u * duration) }

  function seekFrom (e: PointerEvent, bar: HTMLElement): void {
    const r = bar.getBoundingClientRect()
    if (r.width > 0) seekAt(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)))
  }

  function finishScrub (): void {
    if (!scrubbing) return
    scrubbing = false
    if (wasRunning) animator.setPlaying(true)
  }

  function togglePlay (): void {
    animator.setPlaying(!animator.running)
    if (!animator.running && clipEdit.active) animator.seek(clipEdit.snapTime(animator.time))
  }

  function jumpKey (direction: number): void {
    const keys = clipEdit.phases.filter(k => (direction > 0 ? frameOf(k, frames) > frame : frameOf(k, frames) < frame))
    const next = direction > 0 ? keys[0] : keys.at(-1)
    if (next !== undefined) seek(next * duration)
  }

  /** A lane's window or mark: show its start, and open what made it in the adjustments stack. */
  function pick (u: number, adjustment?: string, target?: string): void {
    seekAt(u)
    if (adjustment !== undefined) adjust.open = adjustment
    if (target !== undefined) adjust.target = target
  }

  function sliderKey (e: KeyboardEvent): void {
    if (busy) return
    const amount = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seekFrame(frame - amount)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seekFrame(frame + amount)
    else if (e.key === 'Home') seek(0)
    else if (e.key === 'End') seek(duration)
    else if (e.key === ' ') togglePlay()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  function onKey (e: KeyboardEvent): void {
    if (!allowsShortcut(e) || now === null || busy) return
    if (e.key === ' ') { e.preventDefault(); togglePlay() }
    if (e.key === ',' || e.key === '.') {
      e.preventDefault()
      seekFrame(frame + (e.key === '.' ? 1 : -1))
    }
  }

  const pct = (u: number): string => `${u * 100}%`
  const span = (w: Window): string => `${Math.max(0.4, (w[1] - w[0]) * 100)}%`
  const isTarget = (t: string | undefined): boolean => t !== undefined && t === adjust.target && targetOf(t) !== null
</script>

<svelte:window onkeydown={onKey} onblur={finishScrub} />

{#if now !== null}
  <div class="timeline" aria-label="Playback">
    <div class="heading">
      <span class="name" title={now.label}>{now.label}</span>
      {#if kind !== null}<span class="kind">{kind}</span>{/if}
      <span class="spacer"></span>
      {#if cycles > 1}<span class="faint cycle" use:tooltip={'A ridden loop: his clip plays this many times to one of the horse\'s'}>cycle {cycle + 1} of {cycles}</span>{/if}
      <label class="readout mono">
        <input aria-label="Frame" type="number" min="0" max={frames} step="1" value={frame} disabled={busy} onchange={(e) => seekFrame(e.currentTarget.valueAsNumber)} />
        <span class="faint">/ {frames}</span>
      </label>
    </div>

    <div class="track" class:laned={lanes.length > 0 || (clipEdit.active && clipEdit.phases.length > 0)}>
      <div class="bar" role="slider" tabindex="0" aria-label="Frame" aria-valuemin="0" aria-valuemax={frames} aria-valuenow={frame} aria-valuetext={`Frame ${frame} of ${frames}`} aria-disabled={busy}
        onkeydown={sliderKey}
        onpointerdown={(e) => { if (busy || e.button !== 0) return; e.preventDefault(); scrubbing = true; wasRunning = animator.running; e.currentTarget.setPointerCapture(e.pointerId); seekFrom(e, e.currentTarget) }}
        onpointermove={(e) => { if (scrubbing) seekFrom(e, e.currentTarget) }}
        onpointerup={finishScrub} onpointercancel={finishScrub} onlostpointercapture={finishScrub}>
        <div class="fill" style:width={pct(at)}></div>
        <div class="knob" style:left={pct(at)}></div>
      </div>

      {#each lanes as lane (lane.key)}
        <div class="lane" class:blow={lane.blow}>
          <span class="lane-label" title={lane.label}>{#if lane.blow}<Swords size={10} />{/if}{lane.label}</span>
          <div class="lane-body">
            {#each lane.bars as b, i (i)}
              <button class="window" class:open={b.adjustment !== undefined && adjust.open === b.adjustment} style:left={pct(b.from)} style:width={span([b.from, b.to])}
                aria-label={b.title} use:tooltip={b.title} disabled={busy} onclick={() => pick(b.from, b.adjustment)}></button>
            {/each}
            {#each lane.marks as m, i (i)}
              <button class="mark" class:blow-mark={lane.blow} class:mine={isTarget(m.target)} style:left={pct(m.at)} aria-label={m.title} use:tooltip={m.title}
                disabled={busy} onclick={() => pick(m.at, m.adjustment, m.target)}></button>
            {/each}
            <div class="playhead" style:left={pct(at)}></div>
          </div>
        </div>
      {/each}

      {#if clipEdit.active && clipEdit.phases.length > 0}
        <div class="lane">
          <span class="lane-label">Edits</span>
          <div class="lane-body">
            {#each clipEdit.phases as u (u)}
              <button class="mark edit" class:mine={clipEdit.selectedPhases.some(x => Math.abs(x - u) < 1e-4)} style:left={pct(u)} aria-label={`Key at frame ${frameOf(u, frames)}`}
                disabled={busy} onclick={() => seek(u * duration)} use:tooltip={`Key at frame ${frameOf(u, frames)}`}></button>
            {/each}
            <div class="playhead" style:left={pct(at)}></div>
          </div>
        </div>
      {/if}
    </div>

    <div class="controls">
      <div class="transport" role="group" aria-label="Transport">
        <button disabled={busy} onclick={() => seek(0)} aria-label="First frame" use:tooltip={'First frame'}><SkipBack size={14} /></button>
        <button disabled={busy || (frame === 0 && cycle === 0)} onclick={() => seekFrame(frame - 1)} aria-label="Previous frame" use:tooltip={'Previous frame (,)'}><StepBack size={14} /></button>
        <button class="play" disabled={busy} onclick={togglePlay} aria-label={animator.running ? 'Pause' : 'Play'} use:tooltip={animator.running ? 'Pause (Space)' : 'Play (Space)'}>
          {#if animator.running}<Pause size={15} />{:else}<Play size={15} />{/if}
        </button>
        <button disabled={busy || (frame === frames && cycle === cycles - 1)} onclick={() => seekFrame(frame + 1)} aria-label="Next frame" use:tooltip={'Next frame (.)'}><StepForward size={14} /></button>
        <button disabled={busy} onclick={() => seek(duration)} aria-label="Last frame" use:tooltip={'Last frame'}><SkipForward size={14} /></button>
      </div>
      {#if clipEdit.active && clipEdit.phases.length > 0}
        <div class="key-nav">
          <button disabled={busy || !clipEdit.phases.some(u => frameOf(u, frames) < frame)} onclick={() => jumpKey(-1)} aria-label="Previous key"><ChevronLeft size={12} /> Key</button>
          <span class="faint">{clipEdit.phases.length} keyed</span>
          <button disabled={busy || !clipEdit.phases.some(u => frameOf(u, frames) > frame)} onclick={() => jumpKey(1)} aria-label="Next key">Key <ChevronRight size={12} /></button>
        </div>
      {/if}
      <div class="preview" role="group" aria-label="Preview only">
        <span class="faint preview-label" use:tooltip={'How it plays here only: nothing these change is saved or exported'}>Preview</span>
        <button class:on={animator.loop} disabled={busy} aria-label="Loop the preview" aria-pressed={animator.loop}
          onclick={() => { if (clipEdit.active) clipEdit.setLoop(!animator.loop); else animator.setLoop(!animator.loop) }}
          use:tooltip={now.kind === 'slot' ? 'Loop the preview (the clip\'s own loop is its saved setting)' : 'Loop the preview'}><Repeat size={14} /></button>
        {#if now.kind === 'library'}
          <button class:on={now.inPlace} disabled={busy} aria-pressed={now.inPlace} aria-label="Preview in place" onclick={() => animator.setInPlace(!now.inPlace)}
            use:tooltip={'Preview in place (root motion removed); a clip filled from it keeps this'}><Footprints size={14} /></button>
        {/if}
        <button class:on={animator.mirror} disabled={editing || busy} aria-pressed={animator.mirror} aria-label="Mirror the preview" onclick={() => animator.setMirror(!animator.mirror)}
          use:tooltip={editing ? 'Finish editing to mirror' : 'Mirror left and right (preview only)'}><FlipHorizontal2 size={14} /></button>
        <select class="mono" value={String(animator.speed)} disabled={busy} onchange={(e) => animator.setSpeed(Number(e.currentTarget.value))} aria-label="Preview speed"
          use:tooltip={'Preview speed (the clip\'s own speed is its saved setting)'}>
          {#each speedOptions(animator.speed) as s (s)}<option value={String(s)}>{s}×</option>{/each}
        </select>
      </div>
    </div>
  </div>
{/if}

<style>
  .timeline { display: flex; flex-direction: column; gap: 5px; padding: 8px 14px 10px; background: var(--bg-1); border-top: 1px solid var(--line); container-type: inline-size; }
  .heading { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
  .name { min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kind { flex: none; padding: 1px 6px; border-radius: 4px; background: var(--bg-3); color: var(--text-2); font-size: 10.5px; font-weight: 600; }
  .spacer { flex: 1; }
  .cycle { font-size: 11px; white-space: nowrap; }
  .readout { display: flex; align-items: center; gap: 5px; flex: none; }
  .readout input { width: 46px; height: 24px; padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg-2); text-align: right; appearance: textfield; }
  .readout input::-webkit-inner-spin-button { appearance: none; }
  .track { display: flex; flex-direction: column; gap: 2px; }
  .bar { position: relative; height: 18px; cursor: pointer; touch-action: none; margin: 0 5px; }
  .laned .bar { margin-left: 77px; }
  .bar::before, .fill { content: ''; position: absolute; left: 0; right: 0; top: 8px; height: 3px; border-radius: 2px; background: var(--bg-4); pointer-events: none; }
  .fill { right: auto; background: var(--accent); }
  .knob { position: absolute; top: 4px; width: 11px; height: 11px; margin-left: -5.5px; border-radius: 50%; background: var(--text-1); box-shadow: 0 1px 4px rgb(0 0 0 / 50%); pointer-events: none; }
  .lane { display: flex; align-items: center; gap: 0; height: 14px; }
  .lane-label { width: 72px; flex: none; display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 5px; }
  .lane-body { position: relative; flex: 1; height: 10px; margin: 0 5px; border-radius: 3px; background: var(--bg-2); }
  .window { position: absolute; top: 0; height: 10px; padding: 0; border: 0; border-radius: 3px; background: rgb(142 162 255 / 45%); }
  .window:hover:not(:disabled), .window.open { background: var(--accent); }
  .mark { position: absolute; top: 1px; width: 8px; height: 8px; margin-left: -4px; padding: 0; border: 1px solid rgb(0 0 0 / 50%); background: var(--warn); transform: rotate(45deg); border-radius: 1px; }
  .mark.mine { background: var(--side-right); }
  .mark.blow-mark { width: 3px; height: 12px; top: -1px; margin-left: -1.5px; transform: none; border: 0; background: var(--danger); }
  .mark.edit { background: var(--warn); }
  .playhead { position: absolute; top: -2px; bottom: -2px; width: 1px; background: var(--text-2); pointer-events: none; }
  .controls { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: 6px; }
  .transport, .preview, .key-nav { display: flex; gap: 2px; align-items: center; flex: none; }
  .controls button { width: 26px; height: 28px; border-radius: 6px; border: 0; background: transparent; color: var(--text-3); display: grid; place-items: center; }
  .controls button:hover:not(:disabled) { color: var(--text-1); background: var(--bg-3); }
  .controls button.on { color: var(--accent-strong); }
  .controls .play { width: 32px; height: 32px; margin: 0 2px; border-radius: 50%; background: var(--text-1); color: var(--bg-0); }
  .controls .play:hover:not(:disabled) { background: #fff; color: var(--bg-0); }
  button:disabled { opacity: 0.35; cursor: default; }
  .preview { padding-left: 8px; border-left: 1px solid var(--line); }
  .preview-label { font-size: 10.5px; margin-right: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  select { width: 62px; height: 26px; margin-left: 4px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 11px; }
  .key-nav { font-size: 10.5px; gap: 6px; }
  .key-nav button { width: auto; display: flex; align-items: center; gap: 2px; padding: 0 4px; font-size: inherit; color: var(--text-2); }
  @container (max-width: 420px) { .controls { justify-content: center; } .lane-label { width: 52px; } .laned .bar { margin-left: 57px; } }
</style>
