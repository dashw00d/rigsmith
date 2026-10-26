<script lang="ts">
  import { ArrowRight, FlipHorizontal2, RotateCcw, Sparkles, Square, TriangleAlert, Wrench } from '@lucide/svelte'
  import { animator } from '../../state/animator.svelte.ts'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import { groups, hierarchy, prettyBone, type FingerLevel } from '../../engine/mixamo.ts'
  import { BODY_TYPES, fitTemplate, loadTemplate } from '../../engine/templates.ts'
  import { api } from '../../state/api.ts'
  import SkeletonMapping from './SkeletonMapping.svelte'
  import WeightPaintPanel from '../rig/WeightPaintPanel.svelte'
  import { markerBoard } from '../../state/markers.svelte.ts'
  import { jointOf, keysOf } from '../../engine/markers.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Toggle from '../../ui/Toggle.svelte'

  let { character }: { character: Character } = $props()

  const fingerOptions: Array<{ value: FingerLevel, label: string, hint: string }> = [
    { value: 'none', label: 'None', hint: 'No finger bones; the hand moves as one piece (25 bones)' },
    { value: 'one', label: '1', hint: 'One chain curls all fingers and the thumb together (33 bones)' },
    { value: 'two', label: '2', hint: "Mixamo's mitten: thumb plus one chain for all four fingers (41 bones)" },
    { value: 'full', label: 'All', hint: 'Every finger traced from the mesh (65 bones)' },
  ]
  let fingers = $state<FingerLevel>('full')
  $effect(() => { fingers = (character.fingers ?? 'full') as FingerLevel })
  let mirror = $state(viewer.mirror)

  const job = $derived(app.jobFor(character.id))
  const template = $derived(character.template ?? 'human')
  const human = $derived(template === 'human')
  let choosing = $state(false)

  async function chooseBody (id: string, force = false): Promise<void> {
    if (!force && id === template && character.kind === 'mesh') return
    try {
      let joints
      if (id !== 'human') {
        const box = viewer.character?.box
        if (box === undefined) throw new Error('The model is still loading')
        // Fit along the mesh's own skeleton (legs on their columns, tail along the tail); the plain
        // bounding-box fit when the mesh doesn't read as that kind of body.
        joints = (await api.fitTemplate(character.id, id).catch(() => null))?.joints ?? fitTemplate(await loadTemplate(id), box)
      } else if (character.kind === 'rigged') {
        await convert()
        choosing = false
        return
      }
      app.upsert(await api.setTemplate(character.id, id, joints))
      choosing = false
      viewer.resetEditor()
    } catch (error) {
      app.toast('error', (error as Error).message)
    }
  }
  /** A rigged import onto Rigsmith's own rig: the joints read off its skeleton (Mixamo names, or the mapping's), the
   * finger level it has, then the mesh flow (markers, Rig). */
  async function convert (): Promise<void> {
    try {
      const rest = viewer.character?.rest
      if (rest == null) throw new Error('The model is still loading')
      const joints: Record<string, [number, number, number]> = {}
      for (const [b] of hierarchy('full')) {
        const r = rest.bones.get(b)
        if (r !== undefined) joints[b] = r.worldPosition.toArray().map(v => Math.round(v * 1e5) / 1e5) as [number, number, number]
      }
      const core = ['Hips', 'Spine', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot']
      const missing = core.filter(b => joints[b] === undefined)
      if (missing.length > 0) throw new Error(`Its skeleton doesn't name ${missing.join(', ')}: map them above first`)
      const has = (f: string): boolean => ['Left', 'Right'].every(side => [1, 2, 3].every(i => joints[`${side}Hand${f}${i}`] !== undefined))
      const level: FingerLevel = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].every(has) ? 'full' : has('Thumb') && has('Index') ? 'two' : has('Index') ? 'one' : 'none'
      app.upsert(await api.setTemplate(character.id, 'human', joints, level))
      viewer.resetEditor()
      app.toast('ok', `${character.name}: joints from its skeleton (${Object.keys(joints).length}); place the markers, then Rig character`)
    } catch (error) {
      app.toast('error', (error as Error).message)
    }
  }
  const rigging = $derived(character.status === 'rigging' || job?.kind === 'rig')
  const testing = $derived(animator.current?.test === true)
  let testSets = $state<Record<string, Array<{ id: string, name: string, url?: string }>>>({})
  $effect(() => { void fetch('/templates/tests.json').then(async r => await r.json()).then(j => { testSets = j as typeof testSets }) })
  const tests = $derived(testSets[template] ?? [])
  $effect(() => { void character.template; void character.fingers; void markerBoard.load(character) })
  // (the legend: one row per marker; a pair once)
  // (a marker is missing when its joint isn't in the skeleton: a person's markers need the detected joints)
  const legend = $derived(markerBoard.set === null ? [] : markerBoard.set.markers.map(def => ({ def, placed: def.joint === undefined || keysOf(markerBoard.set!).some(k => k.def.id === def.id && character.joints?.[jointOf(def, k.side) ?? ''] !== undefined) })))
  // (finger tips: a person's at a finger level with fingers; the ones its level has)
  const fingerMarkers = $derived(legend.filter(l => l.def.view === 'hand' && l.placed))
  async function resetMarkers (): Promise<void> {
    markerBoard.open = false
    await app.update(character.id, { markers: null as unknown as undefined })
    markerBoard.open = true
  }
  const jointGroups = $derived(groups(fingers))

  async function setFingers (value: FingerLevel): Promise<void> {
    await app.update(character.id, { fingers: value })
    viewer.resetEditor()
  }

  async function resetJoints (): Promise<void> {
    if (character.autoJoints === undefined) return
    await app.update(character.id, { joints: character.autoJoints, jointsEdited: false })
    viewer.editor?.setJoints(character.autoJoints)
  }

  // Back to the joints (markers, the 3D editor) of a rigged character; the rig stays until the next one replaces it.
  // (a mode of this panel: the character stays rigged, so a save from here doesn't flip the panel back)
  let adjustingFor = ''
  $effect(() => { if (character.id !== adjustingFor) { adjustingFor = character.id; viewer.adjusting = false } })
  $effect(() => { if (rigging) viewer.adjusting = false })
  function adjust (): void {
    viewer.adjusting = true
    viewer.resetEditor()
  }
</script>

{#if character.kind === 'animation'}
  <Section><p class="muted">This file only contains an animation. Add it to the library from the Animate step.</p></Section>
{:else if character.kind === 'rigged'}
  <Section title="Skeleton">
    <div class="warn-card">
      <strong>Rigged elsewhere{character.rigPreset === 'mixamo' ? ' (Mixamo)' : ''}: convert it to the Rigsmith rig</strong>
      <span class="muted">{character.stats?.bones ?? 0} bones. Its weights don't match Rigsmith's; converting keeps the mesh, takes the joints from its skeleton (where they start, and what Reset goes back to), then you place the markers and rig it here.</span>
    </div>
    {#if character.rigPreset !== 'mixamo'}<SkeletonMapping {character} />{/if}
    <Button variant="primary" size="lg" block onclick={convert}><Sparkles size={15} /> Convert to the Rigsmith rig</Button>
    <p class="faint small">Not a person? Rig it with a template instead:</p>
    <div class="bodies">
      {#each BODY_TYPES.filter(b => b.id !== 'human') as b}<button class="bone-chip" onclick={() => chooseBody(b.id)}>{b.label}</button>{/each}
    </div>
  </Section>
{:else if character.status === 'rigged' && !rigging && !viewer.adjusting}
  <Section title="Rig">
    <div class="ok-card">
      <strong>Rigged with the {human ? 'Mixamo' : BODY_TYPES.find(b => b.id === template)?.label.toLowerCase()} skeleton</strong>
      <span class="muted">{character.rigReport ? `${character.rigReport.seconds.toFixed(1)}s · ` : ''}{human ? fingerOptions.find(f => f.value === fingers)?.hint : `${character.stats?.bones ?? 0} bones`}</span>
    </div>
    {#each character.rigReport?.warnings ?? [] as w}<div class="warn"><TriangleAlert size={14} /><span>{w}</span></div>{/each}
    <Button variant="primary" size="lg" block onclick={() => { app.step = 'animate' }}>Pick animations <ArrowRight size={15} /></Button>
  </Section>
  <Section title="Check deformation">
    <span class="group-label">Test the rig: clips that work its joints hard</span>
    <div class="bone-grid">
      {#each tests as t (t.id)}
        <button class="bone-chip" class:active={animator.current?.clipId === t.id} onclick={() => animator.playTest(t)}>{t.name}</button>
      {/each}
      {#if testing}<button class="bone-chip" onclick={() => animator.stop()}><Square size={10} /> Stop</button>{/if}
    </div>
    {#if tests.length === 0}<p class="faint small">No test clips for this body type yet (static/templates/tests.json).</p>{/if}
    <p class="faint small">Watch the joints for creases, candy-wrapping and skin left behind; pause and scrub on the timeline.</p>
    <p class="faint small">Switch the viewport to <strong>Weights</strong> to see each bone's area{human ? ', or click a joint name to see its influence' : ''}.</p>
    <div class="bone-grid" class:hidden={!human}>
      {#each ['Head', 'Spine2', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'] as bone}
        <button class="bone-chip" onclick={() => { viewer.setMode('weights'); viewer.character?.setHighlightBone(bone) }}>{prettyBone(bone)}</button>
      {/each}
      <button class="bone-chip" onclick={() => viewer.character?.setHighlightBone(null)}>All</button>
    </div>
  </Section>
  {#if character.kind === 'mesh'}<WeightPaintPanel {character} />{/if}
  <Section>
    <Button variant="ghost" block onclick={adjust}><Wrench size={14} /> Adjust joints and re-rig</Button>
  </Section>
{:else}
  <Section title="Body type">
    <div class="bodies">
      {#each BODY_TYPES as b}<button class="bone-chip" class:active={template === b.id} onclick={() => chooseBody(b.id)}>{b.label}</button>{/each}
    </div>
    {#if !human}<p class="faint small">The {BODY_TYPES.find(b => b.id === template)?.label.toLowerCase()} skeleton was scaled to the model's bounds. Drag joints onto the body; its animations come with it.</p>{/if}
  </Section>

  <Section title="Markers">
    <p class="faint small">Place a few markers on one flat view of the model ({markerBoard.set?.view === 'side' ? 'from the side: the near legs, the far ones follow' : 'from the front'}); every joint follows them. They start where the {human ? 'detected joints' : 'fitted template'} put them: move the ones that are off.</p>
    {#if markerBoard.missing}<p class="faint small">{markerBoard.missing}</p>{/if}
    {#if markerBoard.set}
      <div class="legend">
        {#each legend.filter(l => l.def.view !== 'hand') as { def, placed }}
          <button class="legend-row" class:active={markerBoard.selected === def.id} onclick={() => { markerBoard.selected = def.id; markerBoard.view = 'body'; markerBoard.open = true }}>
            <span class="swatch" style="background: {def.color}">{def.letter ?? ''}</span>{def.label}{#if !placed}<span class="faint"> · no joint</span>{/if}
          </button>
        {/each}
      </div>
      {#if markerBoard.set.view === 'front'}<Toggle label="Mirror left and right" bind:checked={markerBoard.mirror} />{/if}
      <div class="row">
        <Button variant={markerBoard.open && markerBoard.view === 'body' ? 'ghost' : 'primary'} block onclick={() => { const on = !(markerBoard.open && markerBoard.view === 'body'); markerBoard.view = 'body'; markerBoard.open = on }}>{markerBoard.open && markerBoard.view === 'body' ? 'Done with markers' : 'Place markers'}</Button>
        {#if character.markers}<Button size="sm" variant="ghost" onclick={resetMarkers}><RotateCcw size={13} /> Start again</Button>{/if}
      </div>
      {#if fingerMarkers.length > 0}
        <span class="group-label">Finger tips, on a view of each hand</span>
        <div class="legend">
          {#each fingerMarkers as { def, placed }}
            <button class="legend-row" class:active={markerBoard.selected === def.id} onclick={() => { markerBoard.selected = def.id; markerBoard.view = markerBoard.view === 'left' ? 'left' : 'right'; markerBoard.open = true }}>
              <span class="swatch" style="background: {def.color}">{def.letter ?? ''}</span>{def.label}{#if !placed}<span class="faint"> · no joint</span>{/if}
            </button>
          {/each}
        </div>
        <Button block variant={markerBoard.open && markerBoard.view !== 'body' ? 'ghost' : undefined} onclick={() => { const on = !(markerBoard.open && markerBoard.view !== 'body'); markerBoard.view = 'right'; markerBoard.open = on }}>{markerBoard.open && markerBoard.view !== 'body' ? 'Done with fingers' : 'Place finger markers'}</Button>
      {/if}
    {/if}
  </Section>

  <Section title="Fine-tune joints">
    <p class="faint small">Every joint, in 3D, for what the markers don't reach: drag one in the viewport. With mirroring on, the right side follows the left.</p>
    <Toggle label="Mirror left and right" bind:checked={mirror} onchange={(v) => viewer.setMirror(v)} />
    <div class="groups" class:hidden={!human}>
      {#each jointGroups as group}
        <div class="group">
          <span class="group-label">{group.label}</span>
          <div class="bone-grid">
            {#each group.bones as bone}
              <button class="bone-chip" class:active={viewer.selectedJoint === bone} onclick={() => viewer.editor?.select(bone)}>{prettyBone(bone)}</button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
    {#if character.jointsEdited && human}
      <Button size="sm" variant="ghost" onclick={resetJoints}><RotateCcw size={13} /> Reset to detected joints</Button>
    {:else if !human}
      <Button size="sm" variant="ghost" onclick={() => chooseBody(template, true)}><RotateCcw size={13} /> Refit template</Button>
    {/if}
  </Section>

  {#if human}
    <Section title="Fingers">
      <Segmented options={fingerOptions} bind:value={fingers} onchange={setFingers} />
      <p class="faint small">{fingerOptions.find(f => f.value === fingers)?.hint}. Animations with more fingers still play; missing finger bones are ignored.</p>
    </Section>
  {/if}

  <Section>
    <Button variant="primary" size="lg" block loading={rigging} disabled={character.joints === undefined} onclick={() => app.rig(character.id)}>
      {#if !rigging}<Sparkles size={15} />{/if}
      {rigging ? (job?.message ?? 'Rigging') : 'Rig character'}
    </Button>
    <p class="faint small center">Builds the skeleton and skin weights in Blender, about 5 seconds.</p>
  </Section>
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .center { text-align: center; }
  .ok-card { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: var(--r-2); background: var(--ok-soft); border: 1px solid rgb(95 211 154 / 20%); }
  .ok-card strong { color: var(--ok); font-weight: 600; }
  .ok-card span { font-size: 12px; }
  .warn-card { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: var(--r-2); background: var(--warn-soft, rgb(255 190 90 / 10%)); border: 1px solid rgb(255 190 90 / 25%); }
  .warn-card strong { color: var(--warn); font-weight: 600; }
  .warn-card span { font-size: 12px; }
  .warn { display: flex; gap: 8px; align-items: flex-start; color: var(--warn); font-size: 12.5px; }
  .warn :global(svg) { flex: none; margin-top: 2px; }
  .groups { display: flex; flex-direction: column; gap: 10px; }
  .groups.hidden, .bone-grid.hidden { display: none; }
  .bodies { display: flex; flex-wrap: wrap; gap: 4px; }
  .group { display: flex; flex-direction: column; gap: 6px; }
  .group-label { font-size: 11.5px; color: var(--text-3); }
  .bone-grid { display: flex; flex-wrap: wrap; gap: 4px; }
  .bone-chip {
    height: 24px;
    padding: 0 8px;
    border-radius: 12px;
    border: 1px solid var(--line-strong);
    background: var(--bg-2);
    color: var(--text-2);
    font-size: 11.5px;
    font-weight: 500;
  }
  .bone-chip:hover { color: var(--text-1); border-color: var(--text-4); }
  .bone-chip.active { background: var(--accent-soft); color: var(--accent-strong); border-color: rgb(142 162 255 / 40%); }
  .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; }
  .legend-row { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--text-2); font-size: 12px; padding: 2px 0; text-align: left; }
  .legend-row.active { color: var(--accent-strong); }
  .swatch { width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center; font-size: 9px; font-weight: 700; color: #111; flex: none; }
  .row { display: flex; gap: 6px; align-items: center; }
</style>
