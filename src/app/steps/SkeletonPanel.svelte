<script lang="ts">
  // The Skeleton step: which skeleton the character is built on (a person, a horse, other creatures), where its joints
  // are, and rigging it. The generators (the import's detection, a template fit, a finger trace, a conversion) write
  // the detected joints; what the user places (the marker board, the 3D joints: two cameras on the same thing, one
  // Mirror toggle) goes on top as placements, which a generator sets aside rather than drops (DESIGN.md §2.2). A model
  // rigged elsewhere is converted first. The rig's result is the Skin step's.
  import { ArrowRight, CircleCheck, Lock, RotateCcw, Sparkles, Square, TriangleAlert } from '@lucide/svelte'
  import { BONES_AT } from '../../engine/mixamo.ts'
  import { jointOf, keysOf } from '../../engine/markers.ts'
  import { jointLabel, skeletonSpec, templateInfo, TEMPLATES } from '../../engine/templates.ts'
  import { jointsOf, phaseOf } from '../../model/select.ts'
  import type { Character, FingerLevel, StaleOverride } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { GENERATORS, placeable, skeleton } from '../../state/skeleton.svelte.ts'
  import { tooltip } from '../../ui/tooltip.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import JointChips from '../skeleton/JointChips.svelte'
  import SkeletonMapping from '../skeleton/SkeletonMapping.svelte'
  import { changedSinceRig, placedJoints } from '../skeleton/joints.ts'

  let { character }: { character: Character } = $props()

  const FINGERS: Array<{ value: FingerLevel, label: string, hint: string }> = [
    { value: 'none', label: 'None', hint: `No finger bones: the hand moves as one piece (${BONES_AT.none} bones)` },
    { value: 'one', label: '1', hint: `One chain curls the fingers and thumb together (${BONES_AT.one} bones)` },
    { value: 'two', label: '2', hint: `Mixamo's mitten: the thumb, and one chain for the four fingers (${BONES_AT.two} bones)` },
    { value: 'full', label: 'All', hint: `A chain for each finger (${BONES_AT.full} bones)` },
  ]
  const PRESETS: Record<string, string> = { mixamo: 'Mixamo', tripo: 'Tripo', rigify: 'Rigify', unreal: 'Unreal' }
  const SUPPORTED = TEMPLATES.filter(t => t.status === 'supported')
  const OTHERS = TEMPLATES.filter(t => t.status === 'experimental')

  const job = $derived(app.jobFor(character.id))
  const phase = $derived(phaseOf(character, job ?? null))
  const s = $derived(character.skeleton)
  const human = $derived(s.template === 'human')
  const info = $derived(templateInfo(s.template))
  /** A generator of this character's joints running (or queued). */
  const generating = $derived(job !== undefined && GENERATORS.includes(job.kind))
  const rigging = $derived(phase.phase === 'rigging')
  const busy = $derived(generating || rigging)
  const joints = $derived(jointsOf(character))
  const jointCount = $derived(Object.keys(joints).length)
  const spec = $derived(skeletonSpec(character))
  const placed = $derived(placedJoints(character).length)
  const stale = $derived(s.stale ?? [])
  const changed = $derived(changedSinceRig(character))
  const changes = $derived(changed === null ? [] : [
    ...(changed.moved.length > 0 ? [`${changed.moved.length} moved`] : []),
    ...(changed.added.length > 0 ? [`${changed.added.length} added`] : []),
    ...(changed.removed.length > 0 ? [`${changed.removed.length} gone`] : []),
  ])
  const locked = $derived(character.skin.locked && character.files.rigged !== undefined)
  const painted = $derived(character.skin.painted ?? 0)

  // ---- template ----
  async function choose (template: string): Promise<void> {
    if (busy || template === s.template) return
    await skeleton.setTemplate(character, template)
  }

  // ---- markers ----
  const board = $derived(skeleton.boardFor(character))
  const set = $derived(board?.set ?? null)
  // (one row per marker, a pair once; a marker whose joint the skeleton lacks says so)
  const legend = $derived(set === null ? [] : set.markers.map(def => ({
    def,
    placed: def.joint === undefined || keysOf(set).some(k => k.def.id === def.id && joints[jointOf(def, k.side) ?? ''] !== undefined),
  })))
  const tips = $derived(legend.filter(l => l.def.view === 'hand' && l.placed))
  const onBody = $derived(skeleton.board && skeleton.boardView === 'body')
  const onHands = $derived(skeleton.board && skeleton.boardView !== 'body')
  const canPlace = $derived(placeable(character) && jointCount > 0 && !generating)

  function toggleBoard (view: 'body' | 'hands'): void {
    if (view === 'body' ? onBody : onHands) skeleton.closeBoard()
    else skeleton.openBoard(view === 'body' ? 'body' : skeleton.boardView === 'left' ? 'left' : 'right')
  }

  // ---- fingers ----
  // (the level asked for while its trace runs; back to the character's when it ends, whichever way)
  let asked = $state<FingerLevel | null>(null)
  const level = $derived(asked ?? s.fingerLevel)
  async function setLevel (next: FingerLevel, redetect = false): Promise<void> {
    if (busy || (next === s.fingerLevel && !redetect)) return
    // (a new level changes the rig's bones, which locked weights refuse; detecting again at this level doesn't)
    if (locked && next !== s.fingerLevel) return
    asked = next
    try {
      await skeleton.setFingers(character, next, redetect)
    } finally {
      asked = null
    }
  }

  // ---- set-aside placements ----
  const fits = (o: StaleOverride): boolean => o.template === s.template && (s.template !== 'human' || o.level === s.fingerLevel)
  const madeAt = (o: StaleOverride): string => o.template !== s.template ? `made on the ${templateInfo(o.template).label.toLowerCase()} skeleton` : `made at finger level ${FINGERS.find(f => f.value === o.level)?.label ?? o.level}`
  async function stalePick (action: 'restore' | 'discard', joints?: string[]): Promise<void> {
    await app.do(character.id, { type: 'skeleton.stale', action, ...(joints !== undefined ? { joints } : {}) })
  }

  // ---- rig ----
  async function rig (): Promise<void> {
    if (locked || busy) return
    if (painted > 0) {
      const ok = await app.confirm({
        title: 'Rig again over painted weights?',
        body: `${painted} painted ${painted === 1 ? 'point carries' : 'points carry'} over to the new rig where its surface still matches. If any can't, the rig stops and the current one stays.`,
        confirm: 'Rig',
      })
      if (!ok) return
    }
    await app.rig(character.id)
  }
</script>

{#if character.source.kind === 'animation'}
  <Section><p class="muted small">This file only holds an animation: there is no body to put a skeleton in. Add it to the library from the Motion step.</p></Section>
{:else if phase.phase === 'importing'}
  <Section><p class="muted small">Wait for the import to finish: its joints are detected then.</p></Section>
{:else if phase.phase === 'needs-conversion'}
  <Section title="Rigged elsewhere">
    <div class="card warn">
      <strong>Its own skeleton{character.source.rigPreset !== undefined && PRESETS[character.source.rigPreset] !== undefined ? ` (${PRESETS[character.source.rigPreset]})` : ''}: convert it to the Rigsmith rig</strong>
      <span class="muted">{character.source.stats?.bones ?? 0} bones. Converting keeps the mesh and takes the joints from its skeleton (where they start, and what Reset goes back to). Then you can adjust them and rig it here, which replaces its weights.</span>
    </div>
    {#if character.source.rigPreset !== 'mixamo'}<SkeletonMapping {character} />{/if}
    <Button variant="primary" size="lg" block loading={generating} disabled={busy} onclick={() => skeleton.convert(character)}>
      {#if !generating}<Sparkles size={15} />{/if}{generating ? (job?.message ?? 'Converting') : 'Convert to the Rigsmith rig'}
    </Button>
    <p class="faint small">Not a person? Put it on a creature's skeleton instead:</p>
    <div class="chips">
      {#each TEMPLATES.filter(t => t.id !== 'human') as t (t.id)}
        <button class="chip" disabled={busy} onclick={() => choose(t.id)}>{t.label}{#if t.status === 'experimental'}<span class="faint"> · experimental</span>{/if}</button>
      {/each}
    </div>
  </Section>
{:else}
  <Section title="Skeleton">
    <div class="chips">
      {#each SUPPORTED as t (t.id)}
        <button class="chip" class:active={s.template === t.id} disabled={busy || locked} onclick={() => choose(t.id)}>{t.label}</button>
      {/each}
    </div>
    <details class="others" open={info.status === 'experimental'}>
      <summary>Other creatures</summary>
      <div class="chips">
        {#each OTHERS as t (t.id)}
          <button class="chip" class:active={s.template === t.id} disabled={busy || locked} onclick={() => choose(t.id)}>{t.label}</button>
        {/each}
      </div>
      <p class="faint small">Experimental: plain heat weights, no markers and no deformation tests.</p>
    </details>
    {#if locked}<p class="faint small"><Lock size={11} /> Its weights are locked, so its skeleton stays this one.</p>{/if}
    {#if generating && job?.kind === 'template'}<p class="busy small">{job.message}</p>{/if}
    {#if !human}
      <div class="row">
        <p class="faint small grow">The {info.label.toLowerCase()} skeleton fitted to the model. Drag joints that are off{board !== null ? ', or place its markers' : ''}.</p>
        <Button size="sm" variant="ghost" disabled={busy} onclick={() => skeleton.refit(character)}><RotateCcw size={13} /> Fit again</Button>
      </div>
    {/if}
    {#if character.status === 'error' && character.error}<div class="warn-line"><TriangleAlert size={14} /><span>{character.error.split('\n')[0]}</span></div>{/if}
  </Section>

  <Section title="Joints">
    {#if jointCount === 0}
      <p class="faint small">{human ? 'No joints were found when it was imported. Rigging looks for them again on the mesh; or put it on a creature\'s skeleton.' : 'No joints yet: fit the template again.'}</p>
    {:else}
      <p class="faint small">Markers on a flat view place the whole skeleton at once; the 3D joints in the viewport fine-tune each one. Both change the same joints, and only those you move count as placed.</p>
      <Toggle label="Mirror left and right" hint="Moving one side moves its partner; the middle stays on the middle" checked={skeleton.mirror} onchange={(on) => { skeleton.setMirror(on) }} />

      {#if set !== null}
        <span class="group-label">Markers{set.view === 'side' ? ', from the side (the near legs; the far ones follow)' : ', from the front'}</span>
        <div class="legend">
          {#each legend.filter(l => l.def.view !== 'hand') as { def, placed: has } (def.id)}
            <button class="legend-row" class:active={skeleton.board && skeleton.marker === def.id} disabled={!canPlace} use:tooltip={def.hint ?? def.label}
              onclick={() => { skeleton.openBoard('body', def.id) }}>
              <span class="swatch" style="background: {def.color}">{def.letter ?? ''}</span>{def.label}{#if !has}<span class="faint"> · no joint</span>{/if}
            </button>
          {/each}
        </div>
        <div class="row">
          <Button variant={onBody ? 'ghost' : 'primary'} block disabled={!canPlace} onclick={() => { toggleBoard('body') }}>{onBody ? 'Done with markers' : 'Place markers'}</Button>
          {#if s.markers !== undefined}<Button size="sm" variant="ghost" disabled={busy} onclick={() => skeleton.restartMarkers(character)} title="Seed the markers again from the joints as they are"><RotateCcw size={13} /> Start again</Button>{/if}
        </div>
        {#if tips.length > 0}
          <span class="group-label">Finger tips, on a view of each hand</span>
          <div class="legend">
            {#each tips as { def } (def.id)}
              <button class="legend-row" class:active={onHands && skeleton.marker === def.id} disabled={!canPlace}
                onclick={() => { skeleton.openBoard(skeleton.boardView === 'left' ? 'left' : 'right', def.id) }}>
                <span class="swatch" style="background: {def.color}">{def.letter ?? ''}</span>{def.label}
              </button>
            {/each}
          </div>
          <Button block variant={onHands ? 'ghost' : 'secondary'} disabled={!canPlace} onclick={() => { toggleBoard('hands') }}>{onHands ? 'Done with finger tips' : 'Place finger tips'}</Button>
        {/if}
      {:else}
        <p class="faint small">The {info.label.toLowerCase()} has no markers: drag its joints in the viewport.</p>
      {/if}

      <span class="group-label">Joints in 3D: pick one, or drag it in the viewport</span>
      <JointChips {character} />

      <div class="row">
        <span class="faint small grow">{placed === 0 ? 'Every joint is where it was detected.' : `${placed} ${placed === 1 ? 'joint' : 'joints'} placed by hand.`}</span>
        {#if placed > 0 || s.markers !== undefined || stale.length > 0}
          <Button size="sm" variant="ghost" disabled={busy} onclick={() => skeleton.reset(character)}><RotateCcw size={13} /> Reset</Button>
        {/if}
      </div>
    {/if}
  </Section>

  {#if stale.length > 0}
    <Section title="Set aside">
      <p class="faint small">Placements a change to the skeleton set aside, kept so they aren't lost: restore them where they were made, or let them go.</p>
      <ul class="stale">
        {#each stale as o, i (`${o.joint}:${i}`)}
          <li>
            <span class="grow">
              <strong>{jointLabel(o.joint)}</strong>{#if spec.side(o.joint) !== 'center'}<span class="faint"> · {spec.side(o.joint)}</span>{/if}
              <span class="faint small block">{o.reason}; {madeAt(o)}</span>
            </span>
            <Button size="sm" variant="ghost" disabled={!fits(o) || busy} title={fits(o) ? 'Place it again where it was' : `Switch back to restore it (${madeAt(o)})`} onclick={() => stalePick('restore', [o.joint])}>Restore</Button>
            <Button size="sm" variant="ghost" disabled={busy} onclick={() => stalePick('discard', [o.joint])}>Discard</Button>
          </li>
        {/each}
      </ul>
      {#if stale.length > 1}
        <div class="row">
          {#if stale.some(fits)}<Button size="sm" disabled={busy} onclick={() => stalePick('restore')}>Restore all that fit</Button>{/if}
          <Button size="sm" variant="ghost" disabled={busy} onclick={() => stalePick('discard')}>Discard all</Button>
        </div>
      {/if}
    </Section>
  {/if}

  {#if human}
    <Section title="Fingers">
      <!-- (a disabled fieldset disables the picker's buttons) -->
      <fieldset class="levels" disabled={locked}>
        <Segmented options={FINGERS} value={level} label="Finger bones" onchange={(v) => { void setLevel(v) }} />
      </fieldset>
      <p class="faint small">{FINGERS.find(f => f.value === level)?.hint}. A change traces every finger from the mesh again; clips with more fingers still play.</p>
      {#if locked}<p class="faint small"><Lock size={11} /> Its weights are locked, so its finger level stays this one.</p>{/if}
      {#if generating && job?.kind === 'fingers'}<p class="busy small">{job.message}</p>{/if}
      {#if s.fingerLevel !== 'none'}
        <Button size="sm" variant="ghost" disabled={busy || jointCount === 0} onclick={() => setLevel(s.fingerLevel, true)}><RotateCcw size={13} /> Detect fingers again</Button>
        <p class="faint small">Traces each finger from the mesh again, the rest of the skeleton as it is. Fingers you placed by hand are set aside, not lost.</p>
      {/if}
    </Section>
  {/if}

  <Section title="Rig">
    {#if locked}
      <div class="card lock">
        <strong><Lock size={13} /> Weights locked{character.skin.lockReason ? `: ${character.skin.lockReason}` : ''}</strong>
        <span class="muted">Rigging again would replace them. Unlock them in the Skin step first.</span>
      </div>
      <Button size="sm" variant="ghost" onclick={() => app.go('skin')}>Go to Skin <ArrowRight size={13} /></Button>
    {:else if changes.length > 0}
      <div class="warn-line"><TriangleAlert size={14} /><span>The skeleton changed since the last rig ({changes.join(', ')}). Rig again to use it.</span></div>
    {:else if phase.phase === 'rigged'}
      <div class="ok-line"><CircleCheck size={14} /><span>Rigged on this skeleton.</span>
        <Button size="sm" variant="ghost" onclick={() => app.go('skin')}>Check the skin <ArrowRight size={13} /></Button></div>
    {/if}
    <Button variant="primary" size="lg" block loading={rigging} disabled={locked || busy || character.status === 'importing'} onclick={rig}>
      {#if !rigging}<Sparkles size={15} />{/if}
      {rigging ? (job?.message || 'Rigging') : character.skin.report !== undefined ? 'Rig again' : 'Rig character'}
    </Button>
    {#if rigging && job !== undefined}
      <Button size="sm" variant="ghost" onclick={() => app.cancelJob(job.id)}><Square size={11} /> Cancel</Button>
    {/if}
    <p class="faint small center">Builds the rig on these joints and checks its weights on the deformation tests before it replaces the last one.{painted > 0 ? ` ${painted} painted ${painted === 1 ? 'point carries' : 'points carry'} over.` : ''}</p>
  </Section>
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .block { display: block; }
  .center { text-align: center; }
  .grow { flex: 1; min-width: 0; }
  .busy { color: var(--accent-strong); }
  .row { display: flex; gap: 6px; align-items: center; }
  .card { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: var(--r-2); }
  .card span { font-size: 12px; }
  .card strong { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .card.warn { background: var(--warn-soft, rgb(255 190 90 / 10%)); border: 1px solid rgb(255 190 90 / 25%); }
  .card.warn strong { color: var(--warn); }
  .card.lock { background: var(--bg-2); border: 1px solid var(--line-strong); }
  .warn-line, .ok-line { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; }
  .warn-line { color: var(--warn); }
  .ok-line { color: var(--ok); align-items: center; }
  .ok-line span { flex: 1; }
  .warn-line :global(svg), .ok-line :global(svg) { flex: none; margin-top: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    height: 26px;
    padding: 0 10px;
    border-radius: 13px;
    border: 1px solid var(--line-strong);
    background: var(--bg-2);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
  }
  .chip:hover:not(:disabled) { color: var(--text-1); border-color: var(--text-4); }
  .chip:disabled { opacity: 0.55; }
  .chip.active { background: var(--accent-soft); color: var(--accent-strong); border-color: rgb(142 162 255 / 40%); opacity: 1; }
  .levels { border: 0; margin: 0; padding: 0; min-width: 0; }
  .levels:disabled { opacity: 0.55; }
  .others summary { cursor: pointer; font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
  .others { display: flex; flex-direction: column; gap: 6px; }
  .group-label { font-size: 11.5px; color: var(--text-3); }
  .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; }
  .legend-row { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--text-2); font-size: 12px; padding: 2px 0; text-align: left; }
  .legend-row:disabled { opacity: 0.55; }
  .legend-row.active { color: var(--accent-strong); }
  .swatch { width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center; font-size: 9px; font-weight: 700; color: #111; flex: none; }
  .stale { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .stale li { display: flex; align-items: center; gap: 4px; font-size: 12px; }
</style>
