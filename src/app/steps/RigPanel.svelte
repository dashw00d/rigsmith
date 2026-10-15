<script lang="ts">
  import { ArrowRight, FlipHorizontal2, RotateCcw, Sparkles, TriangleAlert, Wrench } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import { groups, prettyBone, type FingerLevel } from '../../engine/mixamo.ts'
  import { BODY_TYPES, fitTemplate, loadTemplate } from '../../engine/templates.ts'
  import { api } from '../../state/api.ts'
  import SkeletonMapping from './SkeletonMapping.svelte'
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
        joints = fitTemplate(await loadTemplate(id), box)
      } else if (character.autoJoints === undefined && character.kind !== 'mesh') {
        throw new Error('Humanoid re-rigging of an already rigged import is not supported yet; pick a creature template or re-import the unrigged mesh')
      }
      app.upsert(await api.setTemplate(character.id, id, joints))
      choosing = false
      viewer.resetEditor()
    } catch (error) {
      app.toast('error', (error as Error).message)
    }
  }
  const rigging = $derived(character.status === 'rigging' || job?.kind === 'rig')
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

  async function adjust (): Promise<void> {
    // Back to the mesh with joint markers; the previous rig stays until the next one replaces it.
    await app.update(character.id, { joints: character.joints })
    character.status = 'ready'
    viewer.resetEditor()
  }
</script>

{#if character.kind === 'animation'}
  <Section><p class="muted">This file only contains an animation. Add it to the library from the Animate step.</p></Section>
{:else if character.kind === 'rigged'}
  <Section title="Skeleton">
    <div class="ok-card">
      <strong>{character.rigPreset === 'mixamo' ? 'Mixamo skeleton detected' : 'Existing skeleton kept'}</strong>
      <span class="muted">{character.stats?.bones ?? 0} bones. Its skin weights are preserved exactly as imported.</span>
    </div>
    {#if character.rigPreset !== 'mixamo'}
      <SkeletonMapping {character} />
      <p class="faint small">Not a humanoid, or the mapping can't fit? Re-rig it with a template instead.</p>
      {#if choosing}
        <div class="bodies">
          {#each BODY_TYPES.filter(b => b.id !== 'human') as b}<button class="bone-chip" onclick={() => chooseBody(b.id)}>{b.label}</button>{/each}
        </div>
      {:else}
        <Button block onclick={() => { choosing = true }}>Re-rig with a template</Button>
      {/if}
    {/if}
    <Button variant="primary" size="lg" block onclick={() => { app.step = 'animate' }}>Pick animations <ArrowRight size={15} /></Button>
  </Section>
{:else if character.status === 'rigged' && !rigging}
  <Section title="Rig">
    <div class="ok-card">
      <strong>Rigged with the {human ? 'Mixamo' : BODY_TYPES.find(b => b.id === template)?.label.toLowerCase()} skeleton</strong>
      <span class="muted">{character.rigReport ? `${character.rigReport.seconds.toFixed(1)}s · ` : ''}{human ? fingerOptions.find(f => f.value === fingers)?.hint : `${character.stats?.bones ?? 0} bones`}</span>
    </div>
    {#each character.rigReport?.warnings ?? [] as w}<div class="warn"><TriangleAlert size={14} /><span>{w}</span></div>{/each}
    <Button variant="primary" size="lg" block onclick={() => { app.step = 'animate' }}>Pick animations <ArrowRight size={15} /></Button>
  </Section>
  <Section title="Check deformation">
    <p class="faint small">Switch the viewport to <strong>Weights</strong> to see each bone's area{human ? ', or click a joint name to see its influence' : ''}. Play an animation in the Animate step to check it in motion.</p>
    <div class="bone-grid" class:hidden={!human}>
      {#each ['Head', 'Spine2', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'] as bone}
        <button class="bone-chip" onclick={() => { viewer.setMode('weights'); viewer.character?.setHighlightBone(bone) }}>{prettyBone(bone)}</button>
      {/each}
      <button class="bone-chip" onclick={() => viewer.character?.setHighlightBone(null)}>All</button>
    </div>
  </Section>
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

  <Section title="Joints">
    <p class="faint small">{human ? 'Joints were placed automatically. ' : ''}Drag any marker to adjust it. With mirroring on, the right side follows the left.</p>
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
</style>
