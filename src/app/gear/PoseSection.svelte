<script lang="ts">
  import type { Character } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import Section from '../../ui/Section.svelte'
  import Select from '../../ui/Select.svelte'
  let { character }: { character: Character } = $props()
  const pose = $derived(gearState.pose)
  const poses = $derived([
    { value: 'rest', label: 'Rest' }, { value: 'fists', label: 'Rest, fists closed' },
    ...character.clips.map(s => ({ value: s.id, label: s.name, group: 'Clips' })),
    ...(pose === 'other' ? [{ value: 'other', label: animator.playing?.label ?? 'Playing', group: 'Playing' }] : []),
  ])
</script>

<Section title="Pose">
  <Select size="sm" options={poses} value={pose} label="Pose" onchange={(v) => { if (v !== 'other') void gearState.setPose(character, v) }} />
  <p class="note">Look at the gear in a clip as the game plays it. Pause on a frame (Space; , and . step) and drag the gizmo there.</p>
</Section>


<style>.note { margin: 0; font-size: 12px; color: var(--text-3); display: flex; align-items: center; gap: 4px; }</style>
