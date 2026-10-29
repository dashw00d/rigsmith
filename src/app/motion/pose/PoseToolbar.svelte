<script lang="ts">
  // The pose tools, in the timeline's toolbar (src/app/motion/lanes.ts): copy the pose at the playhead (the selected
  // Body tracks, or every bone) and paste it, or its mirror, at another moment; the tween slider (between the keys
  // round the playhead, or push from / relax toward them), shown live on the character while dragging and keyed on
  // release; onion skins; the ease of the selected keys' spans; range edit (a change at the playhead spread over a
  // range with a falloff); a loop's seam, and closing it. Each edit is one slot.keys.set (one undo). The work is
  // ./tools.ts's; the numbers src/model/posetools.ts's.
  //
  // Shortcuts (docs/motion-plan.md §10, so the timeline's leave them): Ctrl+Shift+C (or Ctrl+Alt+C) copy, Ctrl+Shift+V
  // paste, Ctrl+Alt+V paste mirrored, Alt+O onion skins on and off. Not while typing in a field.
  import { onDestroy } from 'svelte'
  import { Brackets, Check, ChevronDown, ClipboardPaste, Copy, FlipHorizontal2, Ghost, Repeat2 } from '@lucide/svelte'
  import type { TimelineView } from '../lanes.ts'
  import type { KeyTrack } from '../../../model/command-types.ts'
  import type { Ease } from '../../../model/types.ts'
  import { EASES, selectionRange, selectedBones, selectedKeys, SEAM_EPS } from '../../../model/posetools.ts'
  import { OnionSkins } from '../../../engine/onion.ts'
  import type { Stage } from '../../../engine/Stage.ts'
  import { app } from '../../../state/app.svelte.ts'
  import { animator } from '../../../state/animator.svelte.ts'
  import { tooltip } from '../../../ui/tooltip.ts'
  import Popover from '../../../ui/Popover.svelte'
  import Segmented from '../../../ui/Segmented.svelte'
  import NumberField from '../../../ui/NumberField.svelte'
  import Button from '../../../ui/Button.svelte'
  import * as tools from './tools.ts'
  import type { TweenMode } from './tools.ts'
  import { poseTools } from './pose.svelte.ts'

  let { view }: { view: TimelineView } = $props()

  const rest = $derived(animator.view?.rest ?? null)
  const ready = $derived(view.baked !== null && rest !== null)
  const picked = $derived(selectedBones(view.selection))
  const keysPicked = $derived(selectedKeys(view.selection))
  const scope = $derived(picked.length === 0 ? 'every bone' : picked.length === 1 ? picked[0] : `${picked.length} bones`)

  let open = $state<'onion' | 'ease' | 'range' | 'seam' | 'tween' | null>(null)
  const toggle = (what: NonNullable<typeof open>): void => { open = open === what ? null : what }

  // ---- a word after an action -----------------------------------------------------------------------------------------
  let said = $state('')
  let saidTimer: ReturnType<typeof setTimeout> | undefined
  function say (text: string): void {
    said = text
    clearTimeout(saidTimer)
    saidTimer = setTimeout(() => { said = '' }, 1800)
  }

  async function commit (writes: KeyTrack[], what: string, done?: string): Promise<boolean> {
    if (writes.length === 0) { say('Nothing to change'); return false }
    const entry = await app.do(view.character.id, tools.keysCommand(view, writes), what)
    if (entry !== null && done !== undefined) say(done)
    return entry !== null
  }
  const tracksText = (n: number): string => (n === 1 ? '1 bone' : `${n} bones`)

  // ---- copy and paste -------------------------------------------------------------------------------------------------
  function copy (): void {
    if (!ready) return
    const clip = tools.copyAt(view, rest!)
    if (clip === null) { say('Nothing to copy'); return }
    poseTools.clipboard = clip
    say(`Copied ${tracksText(clip.bones)}`)
  }

  function paste (mirror: boolean): void {
    const clip = poseTools.clipboard
    if (!ready || clip === null) return
    const writes = tools.pasteWrites(view, rest!, clip, mirror)
    void commit(writes, mirror ? 'paste pose mirrored' : 'paste pose', `Pasted${mirror ? ' mirrored' : ''} on ${tracksText(writes.length)}`)
  }

  // ---- the tween slider -----------------------------------------------------------------------------------------------
  const restValue = (): number => (poseTools.tweenMode === 'tween' ? 0.5 : 0)
  let amount = $state(0.5)
  let dragging = false
  let pending: KeyTrack[] = []

  function previewTween (): void {
    if (!ready) return
    if (!dragging) {
      dragging = true
      animator.setPlaying(false)
      animator.holding = true
    }
    pending = tools.tweenWrites(view, poseTools.tweenMode, amount)
    for (const [node, v] of tools.previewOf(view, rest!, pending)) {
      node.quaternion.fromArray(v.q)
      if (v.p !== undefined) node.position.fromArray(v.p)
    }
  }

  function endTween (keep: boolean): void {
    if (!dragging) return
    dragging = false
    const writes = pending
    pending = []
    const label = poseTools.tweenMode === 'tween' ? `Tweened ${Math.round(amount * 100)}%` : `${poseTools.tweenMode === 'push' ? 'Pushed' : 'Relaxed'} ${Math.round(amount * 100)}%`
    amount = restValue()
    if (keep && writes.length > 0) {
      void commit(writes, `${poseTools.tweenMode} pose`, `${label} on ${tracksText(writes.length)}`).finally(() => { animator.holding = false })
    } else {
      animator.holding = false
      animator.seek(animator.time)
      if (keep) say('No keys round the playhead')
    }
  }

  const TWEEN_MODES: Array<[TweenMode, string, string]> = [
    ['tween', 'Tween', 'Between the previous key (left) and the next (right)'],
    ['push', 'Push', 'Away from the inbetween of the keys round it: more of the pose'],
    ['relax', 'Relax', 'Toward the inbetween of the keys round it: smoother'],
  ]

  function setMode (mode: TweenMode): void {
    poseTools.tweenMode = mode
    amount = restValue()
  }

  // ---- onion skins ----------------------------------------------------------------------------------------------------
  let onion: OnionSkins | null = null
  let onionStage: Stage | null = null

  /** The keys round the playhead, as seconds of the baked clip: the selected bones', else every keyed bone's. */
  function keyTimes (): number[] {
    const b = view.baked
    if (b === null) return []
    const only = picked.length > 0 ? new Set(picked) : null
    return Object.entries(b.boneKeys).filter(([bone]) => only === null || only.has(bone)).flatMap(([, ks]) => ks.map(k => k.u * b.clip.duration))
  }

  $effect(() => {
    const o = poseTools.onion
    const stage = animator.stage; const cv = animator.view; const baked = view.baked
    const at = view.playhead
    if (!o.on || stage === null || cv === null || baked === null) { onion?.hide(); return }
    if (onion === null || onionStage !== stage) {
      onion?.dispose()
      onion = new OnionSkins(stage)
      onionStage = stage
    }
    onion.show(cv, baked.clip, at * baked.clip.duration, { before: o.before, after: o.after, step: o.step, keys: o.atKeys ? keyTimes() : undefined, loop: view.slot.loop })
  })

  onDestroy(() => {
    onion?.dispose()
    clearTimeout(saidTimer)
    if (dragging) endTween(false)
  })

  // ---- ease -----------------------------------------------------------------------------------------------------------
  const EASE_TEXT: Record<Ease, { label: string, hint: string, path: string }> = {
    smooth: { label: 'Smooth', hint: 'Through the key without stopping (the default)', path: 'M2 14 C6 14 7 2 14 2' },
    linear: { label: 'Linear', hint: 'Straight to the next key at an even rate', path: 'M2 14 L14 2' },
    ease: { label: 'Ease', hint: 'Eases out of this key and into the next, stopping at both', path: 'M2 14 C9 14 7 2 14 2' },
    step: { label: 'Step', hint: 'Holds this key\'s value, then jumps to the next', path: 'M2 14 H10 V2 H14' },
    hold: { label: 'Hold', hint: 'The bone held entirely: the clip\'s own motion stopped here until the next key', path: 'M2 9 H14 M2 6 V12 M14 6 V12' },
  }
  const ease = $derived(keysPicked.length === 0 ? null : tools.selectedEase(view))
  function setEase (e: Ease): void {
    open = null
    const writes = tools.easeWrites(view, e)
    void commit(writes, `ease ${e}`, `${EASE_TEXT[e].label} on ${keysPicked.length === 1 ? '1 key' : `${keysPicked.length} keys`}`)
  }

  // ---- range edit -----------------------------------------------------------------------------------------------------
  const selRange = $derived(selectionRange(view.selection))
  const range = $derived(poseTools.range !== null && poseTools.range.slot === view.slot.id ? poseTools.range : null)
  const frameAt = (u: number): number => Math.round(Math.min(1, Math.max(0, view.toPlayed(u))) * view.frames)
  function setRange (): void {
    if (selRange === null) return
    poseTools.range = { slot: view.slot.id, range: selRange, before: tools.snapshot(view) }
    say(`Range: frames ${frameAt(selRange[0])}–${frameAt(selRange[1])}`)
  }
  async function spread (): Promise<void> {
    if (range === null) return
    const writes = tools.spreadWrites(view, range, poseTools.falloff)
    if (writes === null) { say('Put the playhead inside the range'); return }
    if (writes.length === 0) { say('Nothing changed at the playhead since the range was set'); return }
    const was = range
    if (await commit(writes, 'spread over range', `Spread over frames ${frameAt(was.range[0])}–${frameAt(was.range[1])}`)) {
      // (what the next change is measured against: the track as the spread left it)
      poseTools.range = { ...was, before: { ...was.before, ...Object.fromEntries(writes.flatMap(w => ('bone' in w ? [[w.bone, w.keys]] : []))) } }
    }
  }

  // ---- the loop's seam ------------------------------------------------------------------------------------------------
  const seam = $derived(ready && view.slot.loop ? tools.seamOf(view, rest!) : null)
  const seamDeg = $derived(seam?.worst == null ? 0 : seam.worst.angle * 180 / Math.PI)
  const seamTop = $derived(seam === null ? [] : Object.entries(seam.bones).filter(([, a]) => a > SEAM_EPS).sort((a, b) => b[1] - a[1]).slice(0, 5))
  function matchEnds (): void {
    open = null
    const writes = tools.matchWrites(view, rest!)
    void commit(writes, 'match the loop\'s ends', `Ends matched on ${tracksText(writes.length)}`)
  }
  function blend (): void {
    open = null
    const writes = tools.blendWrites(view, rest!, poseTools.blendFrames, poseTools.falloff)
    void commit(writes, 'blend across the loop\'s seam', `Seam blended on ${tracksText(writes.length)}`)
  }

  // ---- shortcuts ------------------------------------------------------------------------------------------------------
  function typing (e: KeyboardEvent): boolean {
    return e.target instanceof Element && e.target.closest('input:not([type="range"]), select, textarea, [contenteditable]:not([contenteditable="false"])') !== null
  }
  function onKey (e: KeyboardEvent): void {
    if (e.defaultPrevented || typing(e)) return
    if (e.key === 'Escape' && dragging) { e.preventDefault(); endTween(false); return }
    const ctrl = e.ctrlKey || e.metaKey
    let act: (() => void) | null = null
    if (ctrl && (e.shiftKey || e.altKey) && e.code === 'KeyC') act = copy
    else if (ctrl && e.shiftKey && !e.altKey && e.code === 'KeyV') act = () => { paste(false) }
    else if (ctrl && e.altKey && !e.shiftKey && e.code === 'KeyV') act = () => { paste(true) }
    else if (e.altKey && !ctrl && !e.shiftKey && e.code === 'KeyO') act = () => { poseTools.setOnion({ on: !poseTools.onion.on }) }
    if (act === null) return
    e.preventDefault()
    act()
  }
</script>

<svelte:window onkeydown={onKey} onpointerup={() => { endTween(true) }} />

<div class="pose-tools" role="toolbar" aria-label="Pose tools">
  <div class="group">
    <button class="tool" disabled={!ready} onclick={copy} aria-label="Copy pose"
      use:tooltip={`Copy the pose at the playhead: ${scope} (Ctrl+Shift+C)`}><Copy size={14} /></button>
    <button class="tool" disabled={!ready || poseTools.clipboard === null} onclick={() => { paste(false) }} aria-label="Paste pose"
      use:tooltip={poseTools.clipboard === null ? 'Paste a copied pose at the playhead (Ctrl+Shift+V)' : `Paste ${tracksText(poseTools.clipboard.bones)} from ${poseTools.clipboard.from} at the playhead (Ctrl+Shift+V)`}><ClipboardPaste size={14} /></button>
    <button class="tool" disabled={!ready || poseTools.clipboard === null} onclick={() => { paste(true) }} aria-label="Paste pose mirrored"
      use:tooltip={'Paste mirrored: left for right, each turn reflected across the body\'s middle (Ctrl+Alt+V)'}><FlipHorizontal2 size={14} /></button>
  </div>

  <div class="group tween">
    <div class="anchor">
      <button class="mode" disabled={!ready} onclick={() => { toggle('tween') }} aria-label="Tween mode" aria-expanded={open === 'tween'}
        use:tooltip={'Tween between the keys round the playhead, or push the pose away from them, or relax it toward them'}>
        {poseTools.tweenMode === 'tween' ? 'Tween' : poseTools.tweenMode === 'push' ? 'Push' : 'Relax'}<ChevronDown size={11} />
      </button>
      {#if open === 'tween'}
        <Popover width={240} onclose={() => { open = null }}>
          <div class="menu">
            {#each TWEEN_MODES as [mode, label, hint] (mode)}
              <button class="item" class:on={poseTools.tweenMode === mode} onclick={() => { setMode(mode); open = null }}>
                <span class="check">{#if poseTools.tweenMode === mode}<Check size={12} />{/if}</span>
                <span class="text"><b>{label}</b><small>{hint}</small></span>
              </button>
            {/each}
          </div>
        </Popover>
      {/if}
    </div>
    <input class="slider" type="range" min="0" max="1" step="0.01" disabled={!ready}
      aria-label={poseTools.tweenMode === 'tween' ? 'Tween between the neighbouring keys' : poseTools.tweenMode === 'push' ? 'Push from the neighbouring keys' : 'Relax toward the neighbouring keys'}
      use:tooltip={`Drag: ${poseTools.tweenMode === 'tween' ? 'favour the previous key (left) or the next (right)' : poseTools.tweenMode === 'push' ? 'exaggerate the pose' : 'smooth the pose'} on ${picked.length === 0 ? 'every keyed bone' : scope}; shown as you drag, keyed when you let go (Esc cancels)`}
      value={amount} oninput={(e) => { amount = +e.currentTarget.value; previewTween() }} onchange={() => { endTween(true) }} />
    <span class="value mono">{Math.round(amount * 100)}</span>
  </div>

  <div class="group">
    <button class="tool" class:active={poseTools.onion.on} disabled={rest === null} onclick={() => { poseTools.setOnion({ on: !poseTools.onion.on }) }}
      aria-label="Onion skins" aria-pressed={poseTools.onion.on}
      use:tooltip={`Onion skins: ghosts of the pose ${poseTools.onion.atKeys ? 'at the keys round the playhead' : `every ${poseTools.onion.step} frames round it`} (Alt+O)`}><Ghost size={14} /></button>
    <div class="anchor">
      <button class="more" onclick={() => { toggle('onion') }} aria-label="Onion skin settings" aria-expanded={open === 'onion'}>
        <span class="mono">{poseTools.onion.before}·{poseTools.onion.after}</span><ChevronDown size={11} />
      </button>
      {#if open === 'onion'}
        <Popover width={250} onclose={() => { open = null }}>
          <div class="panel">
            <div class="row"><span class="lbl before">Before</span><NumberField size="sm" width="56px" value={poseTools.onion.before} min={0} max={8} label="Ghosts before" onchange={v => { poseTools.setOnion({ before: Math.round(v), on: true }) }} /></div>
            <div class="row"><span class="lbl after">After</span><NumberField size="sm" width="56px" value={poseTools.onion.after} min={0} max={8} label="Ghosts after" onchange={v => { poseTools.setOnion({ after: Math.round(v), on: true }) }} /></div>
            <div class="row"><span class="lbl">Show</span>
              <Segmented size="sm" label="Ghosts at" value={poseTools.onion.atKeys ? 'keys' : 'frames'}
                options={[{ value: 'frames', label: 'Frames', hint: 'Every few frames round the playhead' }, { value: 'keys', label: 'Keys', hint: 'At the keys round the playhead (the selected bones\', else every key)' }]}
                onchange={v => { poseTools.setOnion({ atKeys: v === 'keys', on: true }) }} />
            </div>
            {#if !poseTools.onion.atKeys}
              <div class="row"><span class="lbl">Every</span><NumberField size="sm" width="56px" value={poseTools.onion.step} min={1} max={30} unit="fr" label="Frames between ghosts" onchange={v => { poseTools.setOnion({ step: Math.round(v), on: true }) }} /></div>
            {/if}
          </div>
        </Popover>
      {/if}
    </div>
  </div>

  <div class="group">
    <div class="anchor">
      <button class="tool wide" disabled={keysPicked.length === 0} onclick={() => { toggle('ease') }} aria-label="Ease of the selected keys" aria-expanded={open === 'ease'}
        use:tooltip={keysPicked.length === 0 ? 'Ease: select keys on the timeline to set how their spans tween' : `Ease of the span after ${keysPicked.length === 1 ? 'the selected key' : `the ${keysPicked.length} selected keys`}${ease === 'mixed' ? ' (mixed)' : ''}`}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d={EASE_TEXT[ease === null || ease === 'mixed' ? 'smooth' : ease].path} /></svg>
        <ChevronDown size={11} />
      </button>
      {#if open === 'ease'}
        <Popover width={280} onclose={() => { open = null }}>
          <div class="menu">
            {#each EASES as e (e)}
              <button class="item" class:on={ease === e} onclick={() => { setEase(e) }}>
                <svg class="curve" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d={EASE_TEXT[e].path} /></svg>
                <span class="text"><b>{EASE_TEXT[e].label}</b><small>{EASE_TEXT[e].hint}</small></span>
                <span class="check">{#if ease === e}<Check size={12} />{/if}</span>
              </button>
            {/each}
          </div>
        </Popover>
      {/if}
    </div>

    <div class="anchor">
      <button class="tool wide" class:active={range !== null} disabled={!ready} onclick={() => { toggle('range') }} aria-label="Range edit" aria-expanded={open === 'range'}
        use:tooltip={range === null ? 'Range edit: spread a change at the playhead over a range, fading out at its ends' : `Range edit: frames ${frameAt(range.range[0])}–${frameAt(range.range[1])}, ${poseTools.falloff}`}>
        <Brackets size={14} />{#if range !== null}<span class="mono small">{frameAt(range.range[0])}–{frameAt(range.range[1])}</span>{/if}
      </button>
      {#if open === 'range'}
        <Popover width={290} onclose={() => { open = null }}>
          <div class="panel">
            {#if range === null}
              <p class="note">Select keys on the timeline across the range you want (box select), then set it. Change the pose at a moment inside it and spread the change.</p>
              <Button size="sm" variant="primary" disabled={selRange === null} onclick={setRange}>
                {selRange === null ? 'Select keys across a range' : `Set range: frames ${frameAt(selRange[0])}–${frameAt(selRange[1])}`}
              </Button>
            {:else}
              <div class="row"><span class="lbl">Frames</span><span class="mono">{frameAt(range.range[0])}–{frameAt(range.range[1])}</span>
                <span class="spacer"></span>
                {#if selRange !== null}<button class="link" onclick={setRange}>Set to selection</button>{/if}
              </div>
              <div class="row"><span class="lbl">Falloff</span>
                <Segmented size="sm" label="Falloff" bind:value={poseTools.falloff}
                  options={[{ value: 'smooth', label: 'Smooth', hint: 'Eases out toward the range\'s ends' }, { value: 'linear', label: 'Linear', hint: 'Falls off evenly toward the range\'s ends' }]} />
              </div>
              <p class="note">Pose at the playhead (inside the range), then spread: what changed there since the range was set reaches the whole range, all of it at the playhead, none at the ends.</p>
              <div class="row buttons">
                <Button size="sm" variant="primary" onclick={() => { void spread() }}>Spread change</Button>
                <Button size="sm" variant="ghost" onclick={() => { poseTools.range = null; open = null }}>Clear range</Button>
              </div>
            {/if}
          </div>
        </Popover>
      {/if}
    </div>
  </div>

  {#if seam !== null}
    <div class="group anchor">
      <button class="seam" class:warn={seamDeg >= 2} class:good={seamDeg < 0.5} onclick={() => { toggle('seam') }} aria-expanded={open === 'seam'}
        use:tooltip={`Where the loop wraps round, the last frame jumps to the first by up to ${seamDeg.toFixed(2)}°${seam.worst !== null ? ` (${seam.worst.bone})` : ''}`}>
        <Repeat2 size={13} /><span class="mono">seam {seamDeg < 0.05 ? '0' : seamDeg.toFixed(1)}°</span>
      </button>
      {#if open === 'seam'}
        <Popover width={290} align="right" onclose={() => { open = null }}>
          <div class="panel">
            {#if seamTop.length === 0}
              <p class="note">The loop meets itself: no bone jumps at the seam.</p>
            {:else}
              <ul class="jumps">
                {#each seamTop as [bone, a] (bone)}
                  <li><span>{bone}</span><span class="mono">{(a * 180 / Math.PI).toFixed(2)}°</span></li>
                {/each}
              </ul>
              <p class="note">On {picked.length === 0 ? 'every bone that jumps' : `the selected bones that jump (${scope})`}.</p>
              <div class="row buttons">
                <Button size="sm" variant="secondary" onclick={matchEnds}>Match ends</Button>
                <span class="faint" use:tooltip={'The last frame keyed to the first; the correction tweens in from the key before'}>last frame = first</span>
              </div>
              <div class="row buttons">
                <Button size="sm" variant="secondary" onclick={blend}>Blend</Button>
                <span class="faint">over</span>
                <NumberField size="sm" width="52px" value={poseTools.blendFrames} min={1} max={30} unit="fr" label="Frames each side" onchange={v => { poseTools.blendFrames = Math.round(v) }} />
                <span class="faint" use:tooltip={'Half the jump taken off each side of the seam, fading out over these frames (the range falloff\'s shape)'}>each side</span>
              </div>
            {/if}
          </div>
        </Popover>
      {/if}
    </div>
  {/if}

  {#if said !== ''}<span class="said" role="status">{said}</span>{/if}
</div>

<style>
  .pose-tools { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; min-width: 0; font-size: 11.5px; color: var(--text-2); }
  .group { display: flex; align-items: center; gap: 1px; padding: 0 4px; border-left: 1px solid var(--line); }
  .group:first-child { border-left: none; padding-left: 0; }
  .anchor { position: relative; display: flex; align-items: center; }
  .tool, .more, .mode, .seam {
    display: inline-flex; align-items: center; justify-content: center; gap: 3px; height: 24px; min-width: 24px; padding: 0 5px;
    border: 1px solid transparent; border-radius: var(--r-1); background: transparent; color: var(--text-2);
    transition: background var(--fast), color var(--fast);
  }
  .tool:hover:not(:disabled), .more:hover, .mode:hover:not(:disabled), .seam:hover { background: var(--bg-3); color: var(--text-1); }
  .tool:disabled, .mode:disabled { opacity: 0.4; cursor: default; }
  .tool.active { background: var(--accent-soft); color: var(--accent-strong); }
  .tool.wide { padding: 0 4px; }
  .more { padding: 0 3px; color: var(--text-3); }
  .mode { font-size: 11px; color: var(--text-2); width: 50px; justify-content: space-between; }
  svg path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .slider { width: 92px; accent-color: var(--accent); margin: 0 4px; }
  .value { width: 22px; text-align: right; color: var(--text-3); font-size: 10.5px; }
  .mono { font-family: var(--mono); }
  .small { font-size: 10px; }
  .seam { gap: 4px; color: var(--text-2); }
  .seam.good { color: var(--ok); }
  .seam.warn { color: var(--warn); }
  .said { color: var(--text-3); font-size: 11px; white-space: nowrap; animation: fade-in var(--med) var(--ease); }
  .menu { display: flex; flex-direction: column; padding: 4px; }
  .item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: none; border-radius: var(--r-1); background: transparent; color: var(--text-1); text-align: left; }
  .item:hover { background: var(--bg-3); }
  .item.on .curve { color: var(--accent-strong); }
  .item .text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .item small { color: var(--text-3); font-size: 10.5px; line-height: 1.3; }
  .check { width: 12px; flex: none; color: var(--accent-strong); display: inline-flex; }
  .panel { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .row.buttons { gap: 6px; }
  .lbl { width: 52px; color: var(--text-3); }
  .lbl.before { color: #ff9466; }
  .lbl.after { color: #5cc4ff; }
  .spacer { flex: 1; }
  .note { margin: 0; color: var(--text-3); font-size: 11px; line-height: 1.4; }
  .faint { color: var(--text-3); font-size: 11px; }
  .link { border: none; background: none; padding: 0; color: var(--accent-strong); font-size: 11px; }
  .jumps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .jumps li { display: flex; justify-content: space-between; color: var(--text-2); }
  @keyframes fade-in { from { opacity: 0; } }
</style>
