<script lang="ts">
  // A handle held in this clip (a bowstring drawn): which pull handle, and when. Find plays the clip and holds it from
  // when the pulling hand first reaches the strand to the blow (or a full draw); windows can be set by hand too.
  import { Search } from '@lucide/svelte'
  import type { Adjustment, Character, Slot, Window } from '../../../state/api.ts'
  import { adjust, pullHandles } from '../../../state/adjust.svelte.ts'
  import { animator } from '../../../state/animator.svelte.ts'
  import Button from '../../../ui/Button.svelte'
  import Field from '../../../ui/Field.svelte'
  import Select from '../../../ui/Select.svelte'
  import Windows from './Windows.svelte'

  let { character, clipSlot: slot, adjustment: a }: { character: Character, clipSlot: Slot, adjustment: Extract<Adjustment, { kind: 'handleHold' }> } = $props()

  // (a handle another hold of this clip has is not offered again)
  const taken = $derived(new Set(slot.adjustments.flatMap(x => (x.kind === 'handleHold' && x.id !== a.id ? [`${x.gear}/${x.handle}`] : []))))
  const options = $derived(pullHandles(character).filter(p => !taken.has(`${p.gear}/${p.handle}`)).map(p => ({ value: `${p.gear}/${p.handle}`, label: p.label })))
  const editing = $derived(animator.playing?.editing === true)
  const set = (patch: Record<string, unknown>): void => { void adjust.update(character, slot.id, a.id, patch) }

  function pick (value: string): void {
    const [gear, handle] = value.split('/')
    set({ gear, handle })
  }
</script>

<div class="hold">
  <Field label="Handle">
    <Select size="sm" label="Handle" value={`${a.gear}/${a.handle}`} {options} onchange={pick} />
  </Field>
  <Field label="Held" stack hint={editing ? 'Finish editing the clip to change when' : undefined}>
    <Windows windows={adjust.shown(slot.id, a.windows)} frames={adjust.frames(slot.id)} playhead={adjust.playhead(slot.id)} disabled={editing}
      onchange={(next: Window[] | undefined) => set({ windows: next ?? [] })} />
  </Field>
  <div class="row">
    <Button size="sm" loading={adjust.busy !== null} disabled={adjust.busy !== null || editing} onclick={() => adjust.findHolds(character, slot.id, a.id)}
      title="Play the clip and hold it from when the hand reaches the strand to the blow (or a full draw)"><Search size={12} /> Find</Button>
  </div>
</div>

<style>
  .hold { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; gap: 6px; }
</style>
