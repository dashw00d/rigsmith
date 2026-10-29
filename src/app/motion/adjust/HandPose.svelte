<script lang="ts">
  // A hand posed in this clip: which hand, which pose (the hands area's picker), and when (the whole clip, or windows).
  // One that belongs to a carried piece's handle (a bow let go of) is that hand's, and only while it carries the piece.
  import type { Adjustment, Character, HandPoseRef, Side, Slot, Window } from '../../../state/api.ts'
  import { adjust } from '../../../state/adjust.svelte.ts'
  import { animator } from '../../../state/animator.svelte.ts'
  import { carriedBy, gearById } from '../../../model/select.ts'
  import Field from '../../../ui/Field.svelte'
  import Segmented from '../../../ui/Segmented.svelte'
  import Toggle from '../../../ui/Toggle.svelte'
  import HandPoseSelect from '../../hands/HandPoseSelect.svelte'
  import { handWindows } from '../rules.ts'
  import Windows from './Windows.svelte'

  let { character, clipSlot: slot, adjustment: a }: { character: Character, clipSlot: Slot, adjustment: Extract<Adjustment, { kind: 'handPose' }> } = $props()

  const tied = $derived(a.gear === undefined ? undefined : gearById(character, a.gear))
  const carried = $derived(carriedBy(character, a.hand))
  const others = $derived(adjust.shown(slot.id, handWindows(slot, a.hand, a.id)))
  const editing = $derived(animator.playing?.editing === true)
  const set = (patch: Record<string, unknown>): void => { void adjust.update(character, slot.id, a.id, patch) }
</script>

<div class="pose">
  <Field label="Hand" group hint={tied !== undefined ? `The hand carrying ${tied.name}` : undefined}>
    {#if tied !== undefined}
      <span class="fixed">{a.hand}</span>
    {:else}
      <Segmented size="sm" label="Hand" value={a.hand} onchange={(v: Side) => set({ hand: v })}
        options={[{ value: 'Left', label: 'Left' }, { value: 'Right', label: 'Right' }]} />
    {/if}
  </Field>
  <Field label="Pose" group>
    <HandPoseSelect {character} side={a.hand} value={a.pose} onchange={(v: HandPoseRef | undefined) => set({ pose: v ?? 'default' })} />
  </Field>
  {#if tied !== undefined || carried !== undefined}
    <Toggle checked={tied !== undefined} label={`Only while it carries ${(tied ?? carried)?.name}`}
      hint={tied !== undefined ? 'It goes with that piece: off its hand, or removed, it goes too' : undefined}
      onchange={(on) => set({ gear: on ? carried?.id ?? null : null })} />
  {/if}
  <Field label="When" stack hint={editing ? 'Finish editing the clip to change when' : undefined}>
    <Windows windows={a.windows === undefined ? undefined : adjust.shown(slot.id, a.windows)} whole frames={adjust.frames(slot.id)} playhead={adjust.playhead(slot.id)} {others} disabled={editing}
      onchange={(next: Window[] | undefined) => set({ windows: next ?? null })} />
  </Field>
</div>

<style>
  .pose { display: flex; flex-direction: column; gap: 6px; }
  .fixed { font-size: 12px; color: var(--text-2); }
</style>
