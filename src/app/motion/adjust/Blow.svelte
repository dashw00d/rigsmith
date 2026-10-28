<script lang="ts">
  // Blow timing: an attack cut so its blow lands where the game times hits (0.45 of it). The blow is found (a hand's
  // fastest moment) or set to the frame shown; a blow later than where it must land costs its start (cut) or its end
  // is held. A window keeps only that many seconds round the blow.
  import type { Adjustment, Character, Slot } from '../../../state/api.ts'
  import { adjust } from '../../../state/adjust.svelte.ts'
  import Button from '../../../ui/Button.svelte'
  import Field from '../../../ui/Field.svelte'
  import NumberField from '../../../ui/NumberField.svelte'
  import Select from '../../../ui/Select.svelte'
  import { blowPhase, frameOf, lateness } from '../rules.ts'

  type Blow = Extract<Adjustment, { kind: 'blowTiming' }>
  let { character, clipSlot: slot, adjustment: a }: { character: Character, clipSlot: Slot, adjustment: Blow } = $props()

  const playing = $derived(adjust.playingSlot(slot.id))
  const frames = $derived(adjust.frames(slot.id))
  const cut = $derived(a.enabled ? playing?.baked?.cut : undefined)
  const late = $derived(lateness(a, cut))
  const blowAt = $derived.by(() => {
    if (cut !== undefined && frames !== null) return `frame ${frameOf(blowPhase(cut), frames)} of ${frames}`
    if (a.blowU !== undefined) return `${Math.round(a.blowU * 100)}% into the clip`
    return null
  })
  const set = (patch: Record<string, unknown>): void => { void adjust.update(character, slot.id, a.id, patch) }
</script>

<div class="blow">
  <Field label="Lands at" hint="Where in the clip the game times the hit">
    <NumberField value={Math.round(a.at * 100)} min={5} max={95} step={5} unit="%" size="sm" label="Lands at" onchange={(v) => set({ at: v / 100 })} />
  </Field>
  <Field label="The blow" hint={a.blowU !== undefined ? 'Set by hand' : 'Found: the hand’s fastest moment'} group>
    {#if a.blowU !== undefined}
      <Button size="sm" variant="ghost" onclick={() => set({ blowU: null })} title="Find it instead: the hand's fastest moment">Find it</Button>
    {:else}
      <Select size="sm" label="Hand" value={a.hand ?? 'RightHand'} onchange={(v) => set({ hand: v })}
        options={[{ value: 'RightHand', label: 'Right hand' }, { value: 'LeftHand', label: 'Left hand' }]} />
    {/if}
  </Field>
  <div class="row">
    {#if blowAt !== null}<span class="faint at">At {blowAt}</span>{/if}
    <Button size="sm" disabled={playing === null} onclick={() => adjust.blowHere(character, slot.id, a.id)}
      title={playing !== null ? 'The blow is the frame shown (pause on it first)' : 'Play this clip and pause on its blow first'}>Set to this frame</Button>
  </div>
  {#if late !== null}
    <Field label="A late blow" hint={late}>
      <Select size="sm" label="A late blow" value={a.late ?? 'cut'} onchange={(v) => set({ late: v === 'hold' ? 'hold' : null })}
        options={[{ value: 'cut', label: 'Cut the start' }, { value: 'hold', label: 'Hold the end' }]} />
    </Field>
  {/if}
  <Field label="Window" hint="Keep only this long round the blow (empty: all of it)">
    <NumberField value={a.window ?? null} min={0} step={0.1} digits={2} unit="s" size="sm" label="Window" onchange={(v) => set({ window: v > 0 ? v : null })} />
  </Field>
</div>

<style>
  .blow { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .at { font-size: 12px; flex: 1; }
</style>
