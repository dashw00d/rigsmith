<script lang="ts">
  // The ground: the whole body raised or lowered through the clip so its feet meet the floor (the game gets the same
  // lift). Shown in cm of the unit's height in the game when it has one, else in % of the character's height. Auto
  // stands it by its flat feet (src/engine/ground.ts, measured as the clip bakes without this lift).
  import type { Adjustment, Character, Slot } from '../../../state/api.ts'
  import { adjust } from '../../../state/adjust.svelte.ts'
  import { slots } from '../../../state/slots.svelte.ts'
  import { heightOf, slotByName } from '../../../model/select.ts'
  import Button from '../../../ui/Button.svelte'
  import Field from '../../../ui/Field.svelte'
  import NumberField from '../../../ui/NumberField.svelte'
  import { cmPerUnit, liftFromShown, liftShown } from '../rules.ts'

  let { character, clipSlot: slot, adjustment }: { character: Character, clipSlot: Slot, adjustment: Extract<Adjustment, { kind: 'ground' }> } = $props()

  const height = $derived(heightOf(character))
  const perCm = $derived(cmPerUnit(slots.game?.height, height))
  const shown = $derived(liftShown(adjustment.lift, perCm, height))
  const riding = $derived(character.mount !== undefined)
  // (the clips the game plays that are filled, else every clip)
  const all = $derived.by(() => {
    const game = slots.names.flatMap(n => slotByName(character, n)?.id ?? [])
    return game.length > 0 ? game : character.clips.map(s => s.id)
  })
</script>

<div class="ground">
  <Field label="Lift" hint={perCm !== null ? 'cm in the game' : '% of its height'}>
    <NumberField value={shown} step={0.5} digits={1} unit={perCm !== null ? 'cm' : '%'} label="Lift" size="sm"
      onchange={(v) => adjust.setLift(character, slot.id, liftFromShown(v, perCm, height))} />
  </Field>
  <div class="row">
    <Button size="sm" disabled={adjust.busy !== null || riding} onclick={() => adjust.autoGround(character, slot.id)}
      title={riding ? 'He sits on his horse' : 'Stand it on the floor by its flat feet: where heel and toe are down together (its lowest point if it never plants one)'}>Auto</Button>
    {#if all.length > 1}
      <Button size="sm" variant="ghost" disabled={adjust.busy !== null || riding} onclick={() => adjust.autoGroundAll(character, all)}
        title={slots.names.length > 0 ? 'Every clip the game plays, stood on the floor by its flat feet' : 'Every clip, stood on the floor by its flat feet'}>All clips</Button>
    {/if}
  </div>
</div>

<style>
  .ground { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
