<script lang="ts">
  import type { Character, ClothLayer, ClothSlot } from '../../model/types.ts'
  import { CLOTH_SLOTS } from '../../model/types.ts'
  import { newId } from '../../model/ids.ts'
  import { clothBody } from '../../engine/folkview.ts'
  import { app } from '../../state/app.svelte.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Chips from '../../ui/Chips.svelte'
  import TextField from '../../ui/TextField.svelte'
  import Note from '../../ui/Note.svelte'
  import ClothCutEditor from './ClothCutEditor.svelte'
  import { duplicateCut } from './clothdraft.ts'

  let { character }: { character: Character } = $props()
  const layers = $derived(character.look.cloth ?? [])
  const regions = $derived.by(() => viewer.shownId === character.id && viewer.character !== null && viewer.character.bodySkinned.length > 0 ? clothBody(viewer.character.bodySkinned).list : [])
  const worn = $derived(dress.worn(character))
  const chosen = $derived(new Set(Object.values(worn.layers ?? {}).filter((id): id is string => typeof id === 'string')))
  const skin = $derived(character.look.skins?.find(s => s.name === worn.skin))
  const missingBare = $derived(skin !== undefined && skin.bare === undefined && layers.some(l => chosen.has(l.id) && l.cut !== undefined))

  function reorder (id: string, direction: number): void {
    const ids = layers.map(l => l.id); const from = ids.indexOf(id); const to = from + direction
    if (from < 0 || to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    void app.do(character.id, { type: 'look.cloth.reorder', ids })
  }
  async function duplicate (layer: ClothLayer, kind: 'shorts' | 'sleeves'): Promise<void> {
    const copy = duplicateCut(layer, newId(), kind, regions)
    if (copy.cut?.below === undefined || copy.cut.below.length === 0) { app.toast('error', 'No matching body regions for this cut'); return }
    if (await app.do(character.id, { type: 'look.cloth.add', layer: copy }) !== null) {
      const live = app.byId(character.id)
      if (live !== null) dress.setLayer(live, copy.slots[0], copy.id)
    }
  }
  function slots (layer: ClothLayer, value: ClothSlot[]): void {
    if (value.length > 0) void app.do(character.id, { type: 'look.cloth.update', id: layer.id, patch: { slots: value } })
  }
</script>

{#if layers.length === 0}
  <Note>No cloth layers on this character.</Note>
{:else}
  <label class="bare"><input type="checkbox" checked={worn.bare === true} onchange={(event) => dress.setBare(character, event.currentTarget.checked)} /> Preview bare skin</label>
  {#if missingBare}<Note tone="warn">This skin has no bare version. Cut areas will show its painted clothes; use Make bare first.</Note>{/if}
  <div class="list">
    {#each layers as layer, index (layer.id)}
      <div class="layer" data-testid="look-cloth-row" data-id={layer.id}>
        <TextField size="sm" label="Cloth name {layer.name}" value={layer.name} oncommit={(name) => { if (name.trim() !== '' && name !== layer.name) void app.do(character.id, { type: 'look.cloth.update', id: layer.id, patch: { name } }) }} />
        <Chips label="Slots for {layer.name}" options={CLOTH_SLOTS.map(value => ({ value, label: value, disabled: layer.slots.length === 1 && layer.slots.includes(value) }))} value={layer.slots} onchange={(value) => slots(layer, value)} />
        <div class="buttons">
          <Button size="sm" onclick={() => dress.setLayer(character, layer.slots[0], chosen.has(layer.id) ? null : layer.id)}>{chosen.has(layer.id) ? 'Take off' : 'Wear'}</Button>
          <Button size="sm" disabled={index === 0} onclick={() => reorder(layer.id, -1)}>Up</Button>
          <Button size="sm" disabled={index === layers.length - 1} onclick={() => reorder(layer.id, 1)}>Down</Button>
          <Button size="sm" onclick={() => { void app.do(character.id, { type: 'look.cloth.remove', id: layer.id }) }}>Remove</Button>
        </div>
        <div class="buttons">
          <Button size="sm" onclick={() => { void duplicate(layer, 'shorts') }}>Duplicate as shorts</Button>
          <Button size="sm" onclick={() => { void duplicate(layer, 'sleeves') }}>Duplicate as short sleeves</Button>
        </div>
        <details><summary data-testid="look-cloth-edit">Cut and trim</summary><ClothCutEditor {character} {layer} {regions} /></details>
      </div>
    {/each}
  </div>
{/if}

<style>
  .list { display: flex; flex-direction: column; gap: 10px; }
  .layer { display: flex; flex-direction: column; gap: 5px; border-bottom: 1px solid var(--line); padding-bottom: 9px; }
  .buttons { display: flex; flex-wrap: wrap; gap: 4px; }
  .bare, summary { color: var(--text-2); font-size: 12px; }
  .bare { display: flex; align-items: center; gap: 6px; }
  summary { cursor: pointer; margin-bottom: 5px; }
</style>
