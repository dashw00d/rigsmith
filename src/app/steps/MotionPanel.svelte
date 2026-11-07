<script lang="ts">
  // The Motion step (docs/motion-plan.md §9 B): the character's clips (the game unit's slots, their variants and the
  // trials), each with its saved speed, loop and in place; the clip playing posed in the viewport and edited in the
  // timeline under it (no editor to open: every edit is a command, Ctrl+Z the journal's undo); the inspector of what is
  // selected and Save as; the clip's settings (ground, timing, hand poses and holds); what each hand does (the hands
  // area's panel); copying the whole set to other characters. The library opens over the viewport from here.
  import { onDestroy, untrack } from 'svelte'
  import { ArrowRight, LibraryBig } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { adjust } from '../../state/adjust.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import { pose } from '../../state/pose.svelte.ts'
  import { timeline } from '../../state/timeline.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { phaseOf, slotById } from '../../model/select.ts'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import Section from '../../ui/Section.svelte'
  import HandsPanel from '../hands/HandsPanel.svelte'
  import AdjustmentStack from '../motion/AdjustmentStack.svelte'
  import CopySet from '../motion/CopySet.svelte'
  import SelectionInspector from '../motion/SelectionInspector.svelte'
  import SlotList from '../motion/SlotList.svelte'
  import StancePicker from '../motion/StancePicker.svelte'
  import DressedAs from '../motion/DressedAs.svelte'
  import { isFolk } from '../../engine/folk.ts'
  import { motionAction, motionKeyAllowed } from '../motion/keys.ts'

  let { character }: { character: Character } = $props()

  // (its game slots, and again whenever the game's units change: slots.load reads app.gameBeat)
  $effect(() => { void slots.load(character.id) })
  // (another character: nothing keyed or opened of the last one's)
  $effect(() => {
    void character.id
    untrack(() => { adjust.open = null; pose.select(null); pose.selectGear(null) })
  })

  const phase = $derived(phaseOf(character, app.jobFor(character.id)))
  const rigged = $derived(phase.phase === 'rigged')
  const selected = $derived(slotById(character, slots.selectedId ?? ''))
  const libraryOpen = $derived(app.drawer === 'library')

  // (what plays shows its adjustments: a slot played from anywhere, the timeline or another step)
  $effect(() => {
    const p = animator.playing
    if (p === null || p.kind !== 'slot' || p.characterId !== character.id || p.slotId === null) return
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

  // (the joints on stage for the clip playing, while this step shows; taken off when it goes)
  $effect(() => {
    void animator.playing; void animator.view; void animator.stage; void pose.shown; void pose.limitsOn
    const p = animator.playing
    void p?.baked
    untrack(() => { pose.sync(character, rigged) })
  })
  onDestroy(() => { pose.drop() })

  function onKey (e: KeyboardEvent): void {
    if (!rigged || !motionKeyAllowed(e)) return
    const action = motionAction(e)
    if (action === null) return
    const playing = timeline.playing?.character.id === character.id
    // (undo works whatever plays; the rest acts on the clip playing)
    if (action !== 'undo' && action !== 'redo' && !playing) return
    if (action === 'deselect' && timeline.selection.length === 0 && pose.selected === null && pose.gear === null) return
    if ((action === 'copy' || action === 'duplicate') && !timeline.copyable) return
    if (action.startsWith('nudge') && timeline.selection.length === 0) return
    // (F frames the character, the viewport's, unless the pointer is over the timeline)
    if ((action === 'fit' || action === 'fitSelection') && !timeline.hovered) return
    if (pose.busy !== null && action !== 'undo' && action !== 'redo') return
    e.preventDefault()
    switch (action) {
      case 'undo': void timeline.undo(character); break
      case 'redo': void timeline.redo(character); break
      case 'delete': timeline.remove(); break
      case 'deselect': if (timeline.selection.length > 0) timeline.clear(); else { pose.select(null); pose.selectGear(null) } break
      case 'move': pose.setGizmo('move'); break
      case 'rotate': pose.setGizmo('rotate'); break
      case 'duplicate': timeline.duplicate(); break
      case 'copy': { const n = timeline.copy(); if (n > 0) app.toast('info', `${n} copied: Ctrl+V puts ${n === 1 ? 'it' : 'them'} at the playhead`, 2500) } break
      case 'paste': timeline.paste(); break
      case 'all': timeline.selectAll(); break
      case 'key': void pose.keyHere(); break
      case 'solve': void pose.solveBody(); break
      case 'fit': timeline.fit(); break
      case 'fitSelection': timeline.fitSelection(); break
      case 'regionStart': timeline.regionAt('start'); break
      case 'regionEnd': timeline.regionAt('end'); break
      case 'regionClear': timeline.clearRegion(); break
      case 'nudgeBack': timeline.nudge(-1); break
      case 'nudgeOn': timeline.nudge(1); break
      case 'nudgeBack10': timeline.nudge(-10); break
      case 'nudgeOn10': timeline.nudge(10); break
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if !rigged && blocked !== null}
  <Section>
    <EmptyState title={blocked.title} body={blocked.body}>
      {#snippet action()}<Button size="sm" onclick={() => app.go(blocked?.step ?? 'skeleton')}>Go to {STEP_LABEL[blocked?.step ?? 'skeleton']}</Button>{/snippet}
    </EmptyState>
  </Section>
{:else}
  <Section title="Clips">
    {#snippet action()}
      <Button size="sm" variant={libraryOpen ? 'secondary' : 'ghost'} aria-pressed={libraryOpen} onclick={() => app.toggleDrawer('library')}>
        <LibraryBig size={13} /> Library
      </Button>
    {/snippet}
    {#if isFolk(character)}<DressedAs {character} />{/if}
    <StancePicker {character} />
    <SlotList {character} />
  </Section>

  <Section title={timeline.playing?.character.id === character.id ? `Editing ${timeline.playing.slot.name}` : 'Editing'}>
    <SelectionInspector {character} />
  </Section>

  {#if selected !== undefined}
    <Section title="{selected.name}: ground, timing and hands">
      <AdjustmentStack {character} clipSlot={selected} />
    </Section>
  {/if}

  <HandsPanel {character} />

  <CopySet {character} />

  <Section>
    <Button variant="primary" block disabled={character.clips.length === 0} onclick={() => app.go('ship')}>Ship <ArrowRight size={15} /></Button>
  </Section>
{/if}
