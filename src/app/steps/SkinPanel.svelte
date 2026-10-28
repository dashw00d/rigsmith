<script lang="ts">
  // The Skin step: the rig's result. What the last rig decided and why, the weight lock (hand-fixed weights no rig or
  // brush may change until it is taken off), the deformation tests, the weight view and the body's weight painting.
  // Placing joints and rigging are the Skeleton step's; this step says so when there is no rig to look at.
  import { ArrowRight, Lock, LockOpen, Square, Wrench } from '@lucide/svelte'
  import { phaseOf } from '../../model/select.ts'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import TextField from '../../ui/TextField.svelte'
  import DeformationTests from '../skin/DeformationTests.svelte'
  import RigReport from '../skin/RigReport.svelte'
  import WeightChips from '../skin/WeightChips.svelte'
  import WeightPaintPanel from '../skin/WeightPaintPanel.svelte'

  let { character }: { character: Character } = $props()

  const job = $derived(app.jobFor(character.id))
  const phase = $derived(phaseOf(character, job ?? null))
  const hasRig = $derived(character.files.rigged !== undefined)
  const locked = $derived(character.skin.locked)
  const reason = $derived(character.skin.lockReason)

  let reasonText = $state('')
  let reasonFor = ''
  $effect(() => { if (character.id !== reasonFor) { reasonFor = character.id; reasonText = '' } })

  async function lock (): Promise<void> {
    const why = reasonText.trim()
    const done = await app.do(character.id, { type: 'skin.lock', locked: true, ...(why !== '' ? { reason: why } : {}) })
    if (done !== null) reasonText = ''
  }

  async function unlock (): Promise<void> {
    const ok = await app.confirm({
      title: 'Unlock the weights?',
      body: `${reason !== undefined ? `They were locked: ${reason}. ` : ''}Unlocked, a re-rig or painting can replace them.`,
      confirm: 'Unlock',
      danger: true,
    })
    if (ok) await app.do(character.id, { type: 'skin.lock', locked: false })
  }
</script>

{#if phase.phase === 'animation-only'}
  <Section><p class="muted small">This file holds only an animation: there is no body to skin. Add it to the library from the Motion step.</p></Section>
{:else if phase.phase === 'importing'}
  <Section><p class="muted small">Wait for the import to finish.</p></Section>
{:else}
  {#if phase.phase === 'error'}
    <Section title="Skin">
      <p class="muted small">The import failed: {phase.label}. Import it again from the Import step.</p>
      <Button size="sm" variant="ghost" onclick={() => app.go('import')}>Go to Import <ArrowRight size={13} /></Button>
    </Section>
  {:else if phase.phase === 'needs-conversion'}
    <Section title="Skin">
      <p class="muted small">It was rigged elsewhere: its weights aren't Rigsmith's. Convert it to the Rigsmith rig and rig it in the Skeleton step; its skin shows here then.</p>
      <Button size="sm" variant="ghost" onclick={() => app.go('skeleton')}>Go to Skeleton <ArrowRight size={13} /></Button>
    </Section>
  {:else if phase.phase === 'rigging'}
    <Section title="Skin">
      <p class="busy small">{job?.message || 'Rigging'}</p>
      <p class="faint small">The weights are checked on the deformation tests before the new rig replaces {hasRig ? 'the current one, which stays until then' : 'nothing'}.</p>
      {#if job !== undefined}<Button size="sm" variant="ghost" onclick={() => app.cancelJob(job.id)}><Square size={11} /> Cancel</Button>{/if}
    </Section>
  {:else if phase.phase === 'needs-rig'}
    <Section title="Skin">
      <p class="muted small">{hasRig
        ? 'Its skeleton is no longer the one the rig was built on (another template or finger level): rig it again in the Skeleton step.'
        : 'Not rigged yet: place its joints and rig it in the Skeleton step.'}</p>
      <Button size="sm" variant="ghost" onclick={() => app.go('skeleton')}>Go to Skeleton <ArrowRight size={13} /></Button>
    </Section>
  {:else}
    <Section title="Rig">
      <RigReport {character} />
      <Button variant="primary" block onclick={() => app.go('motion')}>Pick animations <ArrowRight size={15} /></Button>
      <Button variant="ghost" block onclick={() => app.go('skeleton')}><Wrench size={14} /> Adjust joints and re-rig</Button>
    </Section>
  {/if}

  {#if hasRig || locked}
    <Section title="Lock">
      {#if locked}
        <div class="card">
          <strong><Lock size={13} /> Weights locked{reason !== undefined ? `: ${reason}` : ''}</strong>
          <span class="muted">No rig, painting or tool can change the body's weights until they are unlocked.</span>
        </div>
        <Button size="sm" variant="ghost" onclick={unlock}><LockOpen size={13} /> Unlock</Button>
      {:else}
        <p class="faint small">Lock weights fixed by hand, so nothing replaces them by mistake: a re-rig, painting and the weight tools are refused while it is on.</p>
        <div class="row">
          <div class="grow"><TextField size="sm" label="Why it is locked" placeholder="Why (optional)" maxlength={120} bind:value={reasonText} /></div>
          <Button size="sm" onclick={lock}><Lock size={13} /> Lock</Button>
        </div>
      {/if}
    </Section>
  {/if}

  {#if phase.phase === 'rigged'}
    <Section title="Deformation tests">
      <DeformationTests {character} />
    </Section>
    <Section title="Weights view">
      <WeightChips {character} />
    </Section>
    <WeightPaintPanel {character} />
  {/if}
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .busy { color: var(--accent-strong); }
  .row { display: flex; gap: 6px; align-items: center; }
  .grow { flex: 1; min-width: 0; }
  .card { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: var(--r-2); background: var(--bg-2); border: 1px solid var(--line-strong); }
  .card strong { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .card span { font-size: 12px; }
</style>
