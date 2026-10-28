<script lang="ts">
  // The Motion step (DESIGN.md §5.6): the clip editor; the character's clips (the game unit's slots and the trials),
  // each with its saved speed, loop and in place; the selected clip's adjustments; what each hand does (the hands
  // area's panel); copying the whole set to other characters. The library opens over the viewport from here.
  import { untrack } from 'svelte'
  import { ArrowRight, LibraryBig } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { adjust } from '../../state/adjust.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { phaseOf, slotById } from '../../model/select.ts'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import Section from '../../ui/Section.svelte'
  import EditPanel from '../editor/EditPanel.svelte'
  import HandsPanel from '../hands/HandsPanel.svelte'
  import AdjustmentStack from '../motion/AdjustmentStack.svelte'
  import CopySet from '../motion/CopySet.svelte'
  import SlotList from '../motion/SlotList.svelte'

  let { character }: { character: Character } = $props()

  // (its game slots, and again whenever the game's units change: slots.load reads app.gameBeat)
  $effect(() => { void slots.load(character.id) })
  // (another character: nothing keyed or opened of the last one's)
  $effect(() => {
    void character.id
    untrack(() => { adjust.target = null; adjust.open = null })
  })

  const phase = $derived(phaseOf(character, app.jobFor(character.id)))
  const rigged = $derived(phase.phase === 'rigged')
  const selected = $derived(slotById(character, slots.selectedId ?? ''))
  const libraryOpen = $derived(app.drawer === 'library')

  // (what plays shows its adjustments: a slot played from anywhere, the timeline or another step)
  $effect(() => {
    const p = animator.playing
    if (p === null || p.kind !== 'slot' || p.editing || p.characterId !== character.id || p.slotId === null) return
    const id = p.slotId
    untrack(() => { if (slots.selectedId !== id) slots.select(id) })
  })

  // (a hands panel link to the adjustment that times a layer: shown here)
  $effect(() => {
    const focus = hands.focus
    if (focus?.step !== 'motion') return
    untrack(() => {
      hands.focus = null
      if (slotById(character, focus.slot) === undefined) return
      slots.select(focus.slot)
      adjust.open = focus.adjustment
    })
  })

  const blocked = $derived.by((): { title: string, body: string, step: 'import' | 'skeleton' | 'skin' } | null => {
    switch (phase.phase) {
      case 'rigged': return null
      case 'importing': return { title: 'Still importing', body: 'Its clips can be picked once it is rigged.', step: 'import' }
      case 'rigging': return { title: 'Rigging', body: 'Its clips can be picked once the rig is done.', step: 'skin' }
      case 'animation-only': return { title: 'This file holds animation only', body: 'There is no body here to play clips on.', step: 'import' }
      case 'needs-conversion': return { title: 'Convert it first', body: 'Its rig is foreign: put it on the Rigsmith rig in Skeleton, then pick its clips.', step: 'skeleton' }
      case 'error': return { title: 'It failed', body: phase.label, step: 'import' }
      default: return { title: 'Rig this character first', body: phase.label === 'Needs rig again' ? 'Its skeleton changed since it was rigged: rig it again, then pick its clips.' : 'Rig it, then pick its clips.', step: 'skeleton' }
    }
  })
  const STEP_LABEL = { import: 'Import', skeleton: 'Skeleton', skin: 'Skin' } as const
</script>

{#if !rigged && blocked !== null}
  <Section>
    <EmptyState title={blocked.title} body={blocked.body}>
      {#snippet action()}<Button size="sm" onclick={() => app.go(blocked?.step ?? 'skeleton')}>Go to {STEP_LABEL[blocked?.step ?? 'skeleton']}</Button>{/snippet}
    </EmptyState>
  </Section>
{:else}
  <EditPanel {character} />

  <Section title="Clips">
    {#snippet action()}
      <Button size="sm" variant={libraryOpen ? 'secondary' : 'ghost'} aria-pressed={libraryOpen} onclick={() => app.toggleDrawer('library')}>
        <LibraryBig size={13} /> Library
      </Button>
    {/snippet}
    <SlotList {character} />
  </Section>

  {#if selected !== undefined}
    <Section title="Changes to {selected.name}">
      <AdjustmentStack {character} clipSlot={selected} />
    </Section>
  {/if}

  <HandsPanel {character} />

  <CopySet {character} />

  <Section>
    <Button variant="primary" block disabled={character.clips.length === 0} onclick={() => app.go('ship')}>Ship <ArrowRight size={15} /></Button>
  </Section>
{/if}
