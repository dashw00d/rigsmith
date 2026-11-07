<script lang="ts">
  import { untrack } from 'svelte'
  import type { Character } from '../../state/api.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import { isFolk } from '../../engine/folk.ts'
  import Section from '../../ui/Section.svelte'
  import GearSection from '../gear/GearSection.svelte'
  import FolkPanel from '../gear/FolkPanel.svelte'
  import ClassSection from '../gear/ClassSection.svelte'
  import SetsPanel from '../gear/SetsPanel.svelte'
  import PoseSection from '../gear/PoseSection.svelte'
  import PieceSection from '../gear/PieceSection.svelte'
  import HandsPanel from '../hands/HandsPanel.svelte'
  let { character }: { character: Character } = $props()
  let highlight = $state<string | null>(null)
  $effect(() => {
    const to = hands.focus
    if (to === null || to.step !== 'gear') return
    untrack(() => { hands.focus = null; gearState.select(to.gear); highlight = to.handle ?? null })
  })
  $effect(() => {
    if (highlight === null) return
    const t = setTimeout(() => { highlight = null }, 2500)
    return () => { clearTimeout(t) }
  })
</script>

<GearSection {character} />
{#if isFolk(character) || (character.look.skins ?? []).length > 0 || (character.look.clothes ?? []).length > 0}
  <Section title="Dynamic character"><FolkPanel {character} /></Section>
{/if}
{#if isFolk(character)}<SetsPanel {character} />{/if}
<ClassSection {character} />
<PoseSection {character} />
<PieceSection {character} {highlight} />
<HandsPanel {character} />
