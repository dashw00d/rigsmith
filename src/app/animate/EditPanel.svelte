<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Move3d, PencilRuler, Rotate3d, Save, Sparkles, Trash2, Wand2, X } from '@lucide/svelte'
  import { animator, FISTS } from '../../state/animator.svelte.ts'
  import { clipEdit } from '../../state/clipedit.svelte.ts'
  import { prettyBone } from '../../engine/mixamo.ts'
  import { allowsShortcut } from '../../ui/shortcuts.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let name = $state('')
  let wasEditing = false
  let seconds = $state<number | undefined>(1)
  const validLength = $derived(seconds !== undefined && Number.isFinite(seconds) && seconds >= 0.2 && seconds <= 20)
  const busy = $derived(clipEdit.busy !== null)
  const bones = $derived([...(animator.character?.bones.keys() ?? [])].sort())
  const target = $derived(clipEdit.prop !== null ? `prop:${clipEdit.prop}` : clipEdit.selected !== null ? `bone:${clipEdit.selected}` : '')
  const keyHere = $derived.by(() => {
    void animator.time
    const u = clipEdit.phase()
    const bones = Object.entries(clipEdit.keys).filter(([b, ks]) => clipEdit.prop === null && (clipEdit.selected === null || clipEdit.selected === b) && ks.some(k => Math.abs(k.u - u) < 1e-4)).length
    const props = Object.entries(clipEdit.paths).filter(([p, x]) => clipEdit.selected === null && (clipEdit.prop === null || clipEdit.prop === p) && x.keys.some(k => Math.abs(k.u - u) < 1e-4)).length
    return bones + props
  })
  const keyedBones = $derived(Object.keys(clipEdit.keys).length)
  $effect(() => {
    const c = animator.current
    if (clipEdit.active && (c === null || c.edited !== true || c.clipId !== clipEdit.base?.clipId)) clipEdit.stop()
  })
  $effect(() => {
    if (!clipEdit.active) name = ''
    else if (!wasEditing) name = clipEdit.held ? 'New clip' : `${clipEdit.base?.name ?? 'Clip'} edit`
    wasEditing = clipEdit.active
  })
  onDestroy(() => { clipEdit.stop() })

  function selectTarget (value: string): void {
    if (value.startsWith('prop:')) clipEdit.selectProp(value.slice(5))
    else if (value.startsWith('bone:')) clipEdit.select(value.slice(5))
    else { clipEdit.select(null); clipEdit.selectProp(null) }
  }

  function onKey (e: KeyboardEvent): void {
    if (!clipEdit.active || busy || !allowsShortcut(e)) return
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clipEdit.deleteHere() }
    if (e.key === 'Escape') { clipEdit.select(null); clipEdit.selectProp(null) }
    if (e.key.toLowerCase() === 'g') clipEdit.setGizmo('move')
    if (e.key.toLowerCase() === 'r') clipEdit.setGizmo('rotate')
  }
</script>

<svelte:window onkeydown={onKey} />

<Section title="Edit animation">
  {#if busy}<p class="status small" role="status"><span class="spinner"></span>{clipEdit.busy}…</p>{/if}
  <fieldset disabled={busy} aria-label="Animation editing tools">
    {#if !clipEdit.active}
      <p class="faint small">Edit the playing clip, or hold its current pose to start a new animation. Save creates a new library clip.</p>
      <Button block disabled={animator.current === null || animator.current.url === ''} onclick={() => clipEdit.start()}>
        <PencilRuler size={14} /> {animator.current === null ? 'Play a clip to edit it' : 'Edit playing clip'}
      </Button>
      <div class="pose-start">
        <label class="field">Length <input class="num" aria-label="New clip length in seconds" type="number" min="0.2" max="20" step="0.1" bind:value={seconds} aria-invalid={!validLength} /> s</label>
        <Button size="sm" disabled={animator.current === null || animator.current.url === '' || !validLength} onclick={() => clipEdit.startFromPose(seconds!)}><Sparkles size={13} /> New clip from this frame</Button>
      </div>
      {#if !validLength}<p class="invalid small">Choose a length from 0.2 to 20 seconds.</p>{/if}
    {:else}
      <div class="row">
        <div class="seg" role="group" aria-label="Gizmo">
          <button aria-pressed={clipEdit.gizmo === 'move'} class:on={clipEdit.gizmo === 'move'} onclick={() => clipEdit.setGizmo('move')} use:tooltip={'Move (G)'}><Move3d size={13} /> Move</button>
          <button aria-pressed={clipEdit.gizmo === 'rotate'} class:on={clipEdit.gizmo === 'rotate'} onclick={() => clipEdit.setGizmo('rotate')} use:tooltip={'Rotate (R)'}><Rotate3d size={13} /> Rotate</button>
        </div>
        {#if clipEdit.gizmo === 'rotate'}
          <div class="seg" role="group" aria-label="Rotation axes">
            <button aria-pressed={clipEdit.space === 'local'} class:on={clipEdit.space === 'local'} onclick={() => clipEdit.setSpace('local')}>Local</button>
            <button aria-pressed={clipEdit.space === 'world'} class:on={clipEdit.space === 'world'} onclick={() => clipEdit.setSpace('world')}>World</button>
          </div>
        {/if}
      </div>
      <label class="field">Target
        <select aria-label="Edit target" value={target} onchange={(e) => selectTarget(e.currentTarget.value)}>
          <option value="">Select a joint or prop…</option>
          {#if clipEdit.props.length > 0}<optgroup label="Props">{#each clipEdit.props as p (p.name)}<option value={`prop:${p.name}`}>{p.name}</option>{/each}</optgroup>{/if}
          <optgroup label="Joints">{#each bones as bone (bone)}<option value={`bone:${bone}`}>{prettyBone(bone)}</option>{/each}</optgroup>
        </select>
      </label>
      <p class="faint small">{keyedBones} bones keyed · {clipEdit.phases.length} keyed frames. Drag a joint or prop, then release to key this frame.</p>
      <div class="row">
        <Button size="sm" variant="ghost" disabled={keyHere === 0} onclick={() => clipEdit.deleteHere()}><Trash2 size={13} /> Delete keys here</Button>
        <Button size="sm" variant="ghost" disabled={!clipEdit.hasKeys} onclick={() => clipEdit.clear()} title="Remove all joint and prop path keys">Clear all keys</Button>
      </div>
      <Toggle label="Joint limits" hint="Keep poses within the rig’s motion ranges" checked={clipEdit.limitsOn} onchange={(on: boolean) => clipEdit.setLimits(on)} />
      {#if clipEdit.held}
        <label class="field">Length <input class="num" aria-label="Clip length in seconds" type="number" min="0.2" max="20" step="0.1" value={clipEdit.length} onchange={(e) => { clipEdit.setLength(e.currentTarget.valueAsNumber); e.currentTarget.value = String(clipEdit.length) }} /> s</label>
      {/if}
      {#if clipEdit.prop !== null}
        {@const p = clipEdit.props.find(x => x.name === clipEdit.prop)}
        {#if p}
          <div class="propbox">
            <div class="row"><strong class="small">{p.name}</strong><button class="iconbtn" onclick={() => clipEdit.selectProp(null)} aria-label="Deselect prop"><X size={13} /></button></div>
            <Toggle label="Prop leads the body" hint="Hands follow its path; the body follows the hands" checked={clipEdit.paths[p.name]?.locked ?? false} onchange={(on: boolean) => clipEdit.setLocked(p.name, on)} />
            <Toggle label="Move entire path" hint="Apply gizmo changes to every frame" checked={clipEdit.propMoves === 'every'} onchange={(on: boolean) => { clipEdit.propMoves = on ? 'every' : 'frame' }} />
            {#if p.sockets.length > 0}
              <span class="muted small">Grip sockets</span>
              {#each ['Left', 'Right'] as side}
                {@const hand = side as 'Left' | 'Right'}
                <label class="field small">{hand} hand
                  <select aria-label={`${hand} grip socket`} value={clipEdit.attachments.find(a => a.hand === hand && a.prop === p.name)?.socket ?? ''}
                    onchange={(e) => { if (e.currentTarget.value) void clipEdit.attach(hand, p.name, e.currentTarget.value); else clipEdit.detach(hand) }}>
                    <option value="">{p.bone === `${hand}Hand` ? 'Outfit placement' : 'Free'}</option>
                    {#each p.sockets as socket (socket.id)}<option value={socket.id} disabled={clipEdit.attachments.some(a => a.hand !== hand && a.prop === p.name && a.socket === socket.id)}>{socket.name}</option>{/each}
                  </select>
                </label>
              {/each}
            {/if}
            {#each clipEdit.handsOn(p.name) as h (h.hand)}
              <div class="row socket">
                <span class="small">{h.hand} fist{h.carries ? ' · carrier' : ''}</span>
                <select class="fist" value={clipEdit.fistClip(h.hand)} onchange={(e) => clipEdit.setFist(h.hand, e.currentTarget.value)} use:tooltip={'Finger pose for this character in every clip'} aria-label={`${h.hand} fist`}>
                  {#each FISTS as [id, label] (id)}<option value={id}>{label}</option>{/each}
                  {#if !FISTS.some(([id]) => id === clipEdit.fistClip(h.hand))}<option value={clipEdit.fistClip(h.hand)}>{clipEdit.fistClip(h.hand).replace(/^mixamo-/, '')}</option>{/if}
                </select>
                {#if h.socket !== null}<button class="iconbtn" onclick={() => clipEdit.release(h.hand, p.name)} use:tooltip={'Remove this grip socket from the character'} aria-label={`Delete ${h.hand.toLowerCase()} grip socket`}><Trash2 size={12} /></button>{/if}
              </div>
            {:else}
              <p class="faint small">Drag a hand onto the prop to create a grip socket.</p>
            {/each}
            <p class="faint small">Grip sockets and fist choices are shared by this character’s clips.</p>
          </div>
        {/if}
      {/if}
      {#if clipEdit.natural}
        <div class="row">
          <Button size="sm" onclick={() => clipEdit.naturalize()}><Wand2 size={13} /> {clipEdit.naturalized ? 'Naturalize again' : 'Naturalize'}</Button>
          {#if clipEdit.naturalized}<span class="faint small" role="status">Ready to save</span>{/if}
        </div>
      {/if}
      <label class="field">Name <input aria-label="New clip name" bind:value={name} /></label>
      <div class="row">
        <Button size="sm" variant="primary" disabled={!clipEdit.canSave || name.trim() === ''} onclick={() => clipEdit.save(name.trim())}><Save size={13} /> Save new clip</Button>
        <Button size="sm" variant="ghost" onclick={() => clipEdit.stop()}><X size={13} /> Finish editing</Button>
      </div>
      <p class="faint small">{clipEdit.canSave ? 'Saved clips appear in Library → Custom. The source clip is preserved.' : 'Make a pose change or naturalize the motion to save a new clip.'}</p>
    {/if}
  </fieldset>
  <details class="tips">
    <summary>Editing tips and shortcuts</summary>
    <p>Scrub to a frame, then drag a joint or prop to add a key. Hands and feet reach; other joints turn their bones. Use the target list to select hidden joints and props.</p>
    <p><kbd>G</kbd> move · <kbd>R</kbd> rotate · <kbd>Delete</kbd> remove keys here · <kbd>Esc</kbd> deselect · <kbd>Space</kbd> play/pause · <kbd>,</kbd> / <kbd>.</kbd> step a frame.</p>
    <p>Loop, In place and Mirror are in the timeline. Choose In place and Mirror before editing. Naturalize smooths the motion while keeping keyed poses and hands on props; repeat it to go further. Editing again rebuilds the motion from your keys.</p>
    <p>Moving a prop keys its path and makes it lead. Turning on “Prop leads the body” or attaching a hand fits the path to the body. Drag a hand onto the prop to create a grip; select the hand to adjust it along the prop.</p>
  </details>
</Section>

<style>
  fieldset { min-width: 0; margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 10px; }
  .small { font-size: 12px; margin: 0; }
  .status { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 7px; padding: 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--bg-1); color: var(--accent-strong); }
  .spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .invalid { color: var(--danger); }
  .row { display: flex; gap: 6px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .pose-start { display: flex; flex-direction: column; gap: 8px; }
  .field { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
  .propbox { display: flex; flex-direction: column; gap: 7px; padding: 9px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent-soft); }
  .socket { padding: 4px 0; border-top: 1px solid var(--line); }
  .fist { max-width: 145px; height: 24px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 11px; padding: 0 3px; margin-left: auto; }
  .iconbtn { width: 22px; height: 22px; border: 0; border-radius: 5px; background: transparent; color: var(--text-3); display: grid; place-items: center; }
  .iconbtn:hover { background: var(--bg-3); color: var(--text-1); }
  .seg { display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--bg-2); border: 1px solid var(--line); }
  .seg button { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: var(--text-2); font-size: 12px; }
  .seg button.on { background: var(--accent-soft); color: var(--accent-strong); }
  .field input.num { flex: none; width: 64px; }
  .field input, .field select { flex: 1; min-width: 0; height: 28px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 6px; }
  button:disabled { cursor: default; opacity: 0.4; }
  .tips { color: var(--text-3); font-size: 12px; }
  summary { cursor: pointer; color: var(--text-2); }
  .tips p { margin: 8px 0 0; }
  kbd { font: inherit; color: var(--text-1); }
</style>
