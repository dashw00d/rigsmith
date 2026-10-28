<script lang="ts">
  // The clip editor (DESIGN.md §4.7, embedded by the Motion step): open what plays (a slot as it plays or its clip
  // alone, a library clip) or hold its frame as a new clip; pose it in the viewport and key it; gear leads the body or
  // moves in the hand, hands take its handles; naturalize; save to the slot or as a library clip. A clip made here opens
  // again as the edit it was made from (its record). The edit lives in src/state/clipedit.svelte.ts until it is saved;
  // leaving with unsaved edits asks first.
  import { onDestroy } from 'svelte'
  import { FolderOpen, Move3d, PencilRuler, Redo2, Rotate3d, Save, Sparkles, Trash2, Undo2, WandSparkles, X } from '@lucide/svelte'
  import type { Character, Side } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { clipEdit } from '../../state/clipedit.svelte.ts'
  import { handSide, slotById } from '../../model/select.ts'
  import { editNameOf } from '../../engine/clipedit.ts'
  import { prettyBone } from '../../engine/mixamo.ts'
  import HandPoseSelect from '../hands/HandPoseSelect.svelte'
  import WindowsField from './WindowsField.svelte'
  import { editorAction, editorKeyAllowed } from './keys.ts'
  import Badge from '../../ui/Badge.svelte'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import NumberField from '../../ui/NumberField.svelte'
  import Section from '../../ui/Section.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Select from '../../ui/Select.svelte'
  import TextField from '../../ui/TextField.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let { character }: { character: Character } = $props()

  const SIDES: Side[] = ['Left', 'Right']

  let name = $state('')
  let wasEditing = false
  let seconds = $state(1)
  const validLength = $derived(Number.isFinite(seconds) && seconds >= 0.2 && seconds <= 20)
  const busy = $derived(clipEdit.busy !== null)
  const editing = $derived(clipEdit.active && clipEdit.characterId === character.id)

  // (what plays, and whether it can be opened)
  const now = $derived(animator.playing)
  const here = $derived(now !== null && now.characterId === character.id && !now.editing && now.kind !== 'clip')
  const playingSlot = $derived(here && now?.kind === 'slot' ? slotById(character, now.slotId ?? '') ?? null : null)
  const canOpen = $derived(here && !animator.loading && !busy)
  const adjusted = $derived(playingSlot !== null && (playingSlot.speed !== 1 || playingSlot.adjustments.some(a => a.enabled)))
  // (a clip made here plays: the edit it was made from opens again when its record is there and isn't a held frame's)
  const madeId = $derived.by(() => {
    const ref = here ? playingSlot?.clip ?? now?.ref ?? null : null
    return ref !== null && ref.id.startsWith('custom-') ? ref.id : null
  })
  let recorded = $state<string | null>(null)
  $effect(() => {
    const id = madeId
    recorded = null
    if (id === null) return
    let current = true
    void clipEdit.recordOf(id).then(r => { if (current && r !== null && r.making?.mode !== 'held') recorded = id })
    return () => { current = false }
  })
  const canReopen = $derived(madeId !== null && recorded === madeId)
  // (without the pose model gear moves in the hand: it can't lead)
  const inHand = $derived(clipEdit.inHand || !clipEdit.natural)

  const bones = $derived([...(animator.view?.bones.keys() ?? [])].sort())
  const target = $derived(clipEdit.gear !== null ? `gear:${clipEdit.gear}` : clipEdit.selected !== null ? `bone:${clipEdit.selected}` : '')
  const targets = $derived([
    { value: '', label: 'Nothing selected' },
    ...clipEdit.pieces.map(p => ({ value: `gear:${p.id}`, label: p.name, group: 'Gear' })),
    ...bones.map(b => ({ value: `bone:${b}`, label: prettyBone(b), group: 'Joints' })),
  ])
  const keysHere = $derived.by(() => {
    void animator.time; void clipEdit.keys; void clipEdit.paths; void clipEdit.selected; void clipEdit.gear
    return clipEdit.active ? clipEdit.keysHere() : 0
  })
  const keyedBones = $derived(Object.values(clipEdit.keys).filter(ks => ks.length > 0).length)
  const piece = $derived(clipEdit.gear === null ? undefined : clipEdit.pieceOf(clipEdit.gear))
  const modeText = $derived(clipEdit.mode === 'held' ? 'a new clip' : clipEdit.mode === 'alone' ? 'the clip alone' : clipEdit.slot !== null ? 'as it plays' : 'as it previews')

  $effect(() => {
    const on = editing
    if (!on) name = ''
    else if (!wasEditing) name = clipEdit.held ? 'New clip' : editNameOf(clipEdit.base?.label ?? 'Clip')
    wasEditing = on
  })
  onDestroy(() => { clipEdit.stop() })

  function selectTarget (value: string): void {
    if (value.startsWith('gear:')) clipEdit.selectGear(value.slice(5))
    else if (value.startsWith('bone:')) clipEdit.select(value.slice(5))
    else { clipEdit.select(null); clipEdit.selectGear(null) }
  }

  function onKey (e: KeyboardEvent): void {
    if (!editing || busy || !editorKeyAllowed(e)) return
    const action = editorAction(e)
    if (action === null) return
    e.preventDefault()
    if (action === 'undo') clipEdit.undo()
    else if (action === 'redo') clipEdit.redo()
    else if (action === 'delete') clipEdit.deleteHere()
    else if (action === 'deselect') { clipEdit.select(null); clipEdit.selectGear(null) }
    else clipEdit.setGizmo(action)
  }

  function pullSide (bone: string | undefined, hand: Side | undefined): Side | null {
    return hand ?? handSide(bone ?? '')
  }
</script>

<svelte:window onkeydown={onKey} />

<Section title="Edit animation">
  {#if busy}<p class="status small" role="status"><span class="spinner"></span>{clipEdit.busy}…</p>{/if}
  {#if clipEdit.naturalizing}<Button size="sm" variant="ghost" onclick={() => { clipEdit.cancelNaturalize() }}>Cancel naturalization</Button>{/if}
  <fieldset disabled={busy} aria-label="Animation editing tools">
    {#if !editing}
      <p class="faint small">Edit the clip playing, or hold its frame to start a new clip.</p>
      {#if playingSlot !== null}
        <div class="row">
          <span use:tooltip={adjusted ? `${playingSlot.name} with its speed, timing, hands, ground and keys: saving bakes them in` : `${playingSlot.name} as it plays`}>
            <Button size="sm" variant="primary" disabled={!canOpen} onclick={() => { void clipEdit.start('plays') }}><PencilRuler size={13} /> Edit as it plays</Button>
          </span>
          <span use:tooltip={'The clip without the slot’s speed or adjustments: saving keeps them'}>
            <Button size="sm" disabled={!canOpen} onclick={() => { void clipEdit.start('alone') }}>Edit the clip alone</Button>
          </span>
        </div>
      {:else}
        <Button block disabled={!canOpen} onclick={() => { void clipEdit.start('plays') }}>
          <PencilRuler size={14} /> {here ? 'Edit this clip' : 'Play a clip to edit it'}
        </Button>
      {/if}
      {#if canReopen}
        <span use:tooltip={'The clip it was made from, with the keys and gear paths it was made of: saving to the slot goes over it again'}>
          <Button size="sm" disabled={!canOpen} onclick={() => { void clipEdit.reopen() }}><FolderOpen size={13} /> Open the edit it was made from</Button>
        </span>
      {/if}
      <div class="row">
        <NumberField size="sm" label="New clip length" value={seconds} min={0.2} max={20} step={0.1} unit="s" onchange={(v) => { seconds = v }} />
        <Button size="sm" disabled={!canOpen || !validLength} onclick={() => { void clipEdit.startFromPose(seconds) }}><Sparkles size={13} /> New clip from this frame</Button>
      </div>
      {#if !validLength}<p class="invalid small">Choose a length from 0.2 to 20 seconds.</p>{/if}
    {:else}
      <div class="row">
        <span class="small">Editing <strong>{clipEdit.held ? 'a new clip' : clipEdit.base?.label}</strong></span>
        <Badge tone={clipEdit.unsaved ? 'warn' : 'muted'}>{clipEdit.unsaved ? 'unsaved' : modeText}</Badge>
      </div>
      <div class="row">
        <div class="tools">
          <IconButton size="sm" label="Undo" hint="Undo (Ctrl+Z)" disabled={!clipEdit.canUndo} onclick={() => { clipEdit.undo() }}><Undo2 size={14} /></IconButton>
          <IconButton size="sm" label="Redo" hint="Redo (Ctrl+Shift+Z)" disabled={!clipEdit.canRedo} onclick={() => { clipEdit.redo() }}><Redo2 size={14} /></IconButton>
        </div>
        <Segmented size="sm" label="Gizmo" value={clipEdit.gizmo} onchange={(v) => { clipEdit.setGizmo(v) }}
          options={[{ value: 'move', label: 'Move', icon: Move3d, hint: 'Move (G)' }, { value: 'rotate', label: 'Rotate', icon: Rotate3d, hint: 'Rotate (R)' }]} />
        {#if clipEdit.gizmo === 'rotate'}
          <Segmented size="sm" label="Rotation axes" value={clipEdit.space} onchange={(v) => { clipEdit.setSpace(v) }}
            options={[{ value: 'local', label: 'Local' }, { value: 'world', label: 'World' }]} />
        {/if}
      </div>
      <Field label="Target">
        <Select size="sm" label="Edit target" value={target} options={targets} onchange={selectTarget} />
      </Field>
      <p class="faint small">{keyedBones} {keyedBones === 1 ? 'joint' : 'joints'} keyed · {clipEdit.phases.length} keyed frames. Drag a joint or gear, then let go to key this frame.</p>
      <div class="row">
        <Button size="sm" variant="ghost" disabled={keysHere === 0} onclick={() => { clipEdit.deleteHere() }}><Trash2 size={13} /> Delete keys here</Button>
        <Button size="sm" variant="ghost" disabled={!clipEdit.hasKeys} onclick={() => { void clipEdit.clearAll() }}>Clear all keys</Button>
      </div>
      <Toggle label="Joint limits" hint="Keep poses within the rig’s range of motion" checked={clipEdit.limitsOn} onchange={(on) => { clipEdit.setLimits(on) }} />
      {#if clipEdit.held}
        <Field label="Length">
          <NumberField size="sm" label="Clip length" value={clipEdit.length} min={0.2} max={20} step={0.1} unit="s" onchange={(v) => { clipEdit.setLength(v) }} />
        </Field>
      {/if}

      {#if piece !== undefined}
        {@const p = piece}
        <div class="gearbox">
          <div class="row">
            <strong class="small">{p.name}</strong>
            <IconButton size="sm" label="Deselect" onclick={() => { clipEdit.selectGear(null) }}><X size={13} /></IconButton>
          </div>
          {#if clipEdit.natural}
            <Toggle label="Leads the body" hint="The hands on it follow its path; the body follows the hands" checked={clipEdit.paths[p.id]?.locked ?? false}
              onchange={(on) => { void clipEdit.setLocked(p.id, on) }} />
            <Toggle label="Moves in the hand" hint={`Dragging it moves it where ${prettyBone(p.bone)} holds it; whatever holds it stays`} checked={clipEdit.inHand}
              onchange={(on) => { clipEdit.inHand = on }} />
          {:else}
            <p class="faint small">Gear leads the body only on a person: here it moves in the hand.</p>
          {/if}
          <Toggle label={inHand ? 'In every clip' : 'Move entire path'}
            hint={inHand ? `How it sits on ${prettyBone(p.bone)} in every clip (its placement). Off: this frame only, tweened between keys` : 'The gizmo moves every frame of its path. Off: a key on this frame'}
            checked={clipEdit.moves === 'every'} onchange={(on) => { clipEdit.moves = on ? 'every' : 'frame' }} />

          {#each SIDES as hand (hand)}
            {@const carries = clipEdit.carries(hand, p.id)}
            {@const on = clipEdit.attachments.find(a => a.hand === hand && a.gear === p.id)}
            {@const choices = clipEdit.handleChoices(hand, p.id)}
            {@const handle = on === undefined ? undefined : p.gear.handles.find(h => h.id === on.handle)}
            {#if carries || on !== undefined || choices.length > 0}
              <div class="hand">
                <div class="row">
                  <span class="small">{hand} hand{carries ? ' · carries it' : ''}</span>
                  <Select size="sm" label={`${hand} hand's handle on ${p.name}`} value={on?.handle ?? ''}
                    options={[{ value: '', label: carries ? 'As placed' : 'Not on it' }, ...choices.map(h => ({ value: h.id, label: h.name, disabled: h.taken }))]}
                    onchange={(v) => { if (v === '') clipEdit.detach(hand); else void clipEdit.attach(hand, p.id, v) }} />
                </div>
                {#if handle !== undefined && handle.kind === 'grip'}
                  <div class="row">
                    <Toggle label="Exactly here" hint="The hand stays on this spot (no give or slide on the shaft)" checked={handle.exact === true}
                      onchange={(x) => { clipEdit.setExact(p.id, handle.id, x) }} />
                    <IconButton size="sm" variant="danger" label={`Remove ${handle.name}`} hint="Take this grip handle off the gear" onclick={() => { clipEdit.removeHandle(p.id, handle.id) }}><Trash2 size={12} /></IconButton>
                  </div>
                {/if}
                {#if carries || on !== undefined}
                  <div class="row" use:tooltip={clipEdit.handPoseHint(hand, p.id)}>
                    <span class="small faint">Hand pose</span>
                    <HandPoseSelect {character} side={hand} value={clipEdit.handPoseOf(hand, p.id)} unsetLabel={clipEdit.handPoseSet(hand, p.id) ? 'As its other layers have it' : undefined}
                      onchange={(v) => { clipEdit.setHandPose(hand, p.id, v) }} />
                  </div>
                {/if}
                {#if carries}
                  <WindowsField label={clipEdit.slot !== null ? `Opens in ${clipEdit.slot.name}` : 'Opens in this clip'} value={clipEdit.openWindows(p.id)} disabled={!clipEdit.windowsEditable}
                    fromLabel="Open from the frame shown to the end" toLabel="Closed again from the frame shown" onchange={(w) => { clipEdit.setOpen(p.id, w) }} />
                {/if}
              </div>
            {/if}
          {/each}
          {#if p.gear.handles.every(h => h.kind !== 'grip')}<p class="faint small">Let a free hand go on it to make a grip handle.</p>{/if}

          {#each clipEdit.pullsOn(p.id) as pull (pull.id)}
            {@const side = pullSide(pull.pull?.bone, pull.hand)}
            <div class="hand">
              <div class="row">
                <span class="small">{side !== null ? `${side} hand` : prettyBone(pull.pull?.bone ?? '')} · pulls {pull.name}</span>
                {#if side !== null}
                  <span use:tooltip={'Its pose while it holds the pull, in every clip'}>
                    <HandPoseSelect {character} {side} value={pull.pose} unsetLabel="As the hand is" onchange={(v) => { clipEdit.setPullPose(p.id, pull.id, v) }} />
                  </span>
                {/if}
              </div>
              <WindowsField label={clipEdit.slot !== null ? `Held in ${clipEdit.slot.name}` : 'Held in this clip'} value={clipEdit.pullHolds(p.id, pull.id)} disabled={!clipEdit.windowsEditable}
                fromLabel="Held from the frame shown to the end" toLabel="Let go at the frame shown" onchange={(w) => { clipEdit.setPullHolds(p.id, pull.id, w) }} />
            </div>
          {/each}
          <p class="faint small">
            Handles and hand poses are this character’s, for every clip (a pull’s point is set in Gear); where a hand opens or holds a pull is
            {clipEdit.slot !== null ? `${clipEdit.slot.name}’s` : 'a slot’s'}{clipEdit.windowsEditable ? '' : ', set while editing a slot as it plays'}. They change at once; discarding the edit offers to undo them.
          </p>
        </div>
      {/if}

      {#if clipEdit.natural}
        <div class="row">
          <Button size="sm" onclick={() => { void clipEdit.naturalize() }}><WandSparkles size={13} /> {clipEdit.naturalized ? 'Naturalize again' : 'Naturalize'}</Button>
          {#if clipEdit.naturalized}<span class="faint small" role="status">Ready to save</span>{/if}
        </div>
      {/if}
      <Field label="Name">
        <TextField size="sm" label="Clip name" bind:value={name} maxlength={80} />
      </Field>
      <div class="row">
        {#if clipEdit.slot !== null && !clipEdit.held}
          <Button size="sm" variant="primary" disabled={!clipEdit.canSave || name.trim() === ''} onclick={() => { void clipEdit.saveToSlot(name.trim()) }}>
            <Save size={13} /> Save to {clipEdit.slot.name}
          </Button>
        {/if}
        <Button size="sm" variant={clipEdit.slot !== null && !clipEdit.held ? 'secondary' : 'primary'} disabled={!clipEdit.canSave || name.trim() === ''}
          onclick={() => { void clipEdit.saveAsClip(name.trim()) }}><Save size={13} /> Save as a library clip</Button>
        <Button size="sm" variant="ghost" onclick={() => { void clipEdit.finish() }}><X size={13} /> Finish</Button>
      </div>
      <p class="faint small">
        {#if !clipEdit.canSave}
          Make a pose change or naturalize the motion to save.
        {:else if clipEdit.slot !== null && !clipEdit.held}
          Save to {clipEdit.slot.name}: it plays the edit, a new clip (one you made before that only {clipEdit.slot.name} plays is saved over){clipEdit.mode === 'plays' ? '; its speed, timing and keys are baked in' : '; its speed and adjustments stay'}.
          Save as a library clip: a copy under Library → Custom, {clipEdit.slot.name} unchanged.
        {:else}
          Saved clips appear under Library → Custom; the clip it came from stays as it is.
        {/if}
      </p>
    {/if}
  </fieldset>
  <details class="tips">
    <summary>Editing tips and shortcuts</summary>
    <p>Scrub to a frame, then drag a joint or gear to key it. Hands and feet reach; other joints turn their bones. Use the target list to select hidden joints and gear. Hold Shift while dragging the hips to move them freely.</p>
    <p><kbd>G</kbd> move · <kbd>R</kbd> rotate · <kbd>Delete</kbd> remove keys here · <kbd>Esc</kbd> deselect · <kbd>Ctrl+Z</kbd> undo · <kbd>Ctrl+Shift+Z</kbd> redo · <kbd>Space</kbd> play/pause · <kbd>,</kbd> / <kbd>.</kbd> step a frame.</p>
    <p>Loop is in the timeline; choose In place and Mirror before editing. Naturalize smooths the motion while keeping keyed poses and hands on gear; repeat it to go further. Any later change builds the motion again from your keys.</p>
    <p>Moving gear keys its path and makes it lead (with “Moves in the hand” on, it moves in the hand instead: this frame, tweened; or in every clip, its placement). Turning on “Leads the body” or putting a hand on it fits the path to the body. Let a free hand go on gear to grip it there; select the hand to slide it along.</p>
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
  .tools { display: flex; gap: 2px; }
  .gearbox { display: flex; flex-direction: column; gap: 7px; padding: 9px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent-soft); }
  .hand { display: flex; flex-direction: column; gap: 5px; padding: 6px 0 2px; border-top: 1px solid var(--line); }
  .tips { color: var(--text-3); font-size: 12px; }
  summary { cursor: pointer; color: var(--text-2); }
  .tips p { margin: 8px 0 0; }
  kbd { font: inherit; color: var(--text-1); }
</style>
