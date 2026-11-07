<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { Character, ClothCut, ClothLayer } from '../../model/types.ts'
  import { limbGroups, type RegionInfo } from '../../engine/clothcut.ts'
  import { app } from '../../state/app.svelte.ts'
  import { assets } from '../../state/assets.svelte.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import { cutGroup, dropRegion, groupRule } from './clothdraft.ts'
  import { previewCut } from './clothpreview.ts'

  let { character, layer, regions }: { character: Character, layer: ClothLayer, regions: RegionInfo[] } = $props()
  const groups = $derived(limbGroups(regions))
  let draft = $state<ClothCut | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const cut = $derived(draft ?? layer.cut ?? {})
  onDestroy(() => { clearTimeout(timer) })

  function change (next: ClothCut): void {
    draft = next
    if (!Object.values(dress.worn(character).layers ?? {}).includes(layer.id)) dress.setLayer(character, layer.slots[0], layer.id)
    clearTimeout(timer)
    timer = setTimeout(() => { void previewCut(character, layer.id, next).catch(error => { app.toast('error', `Cloth preview: ${(error as Error).message}`) }) }, 120)
  }
  function commit (): void {
    clearTimeout(timer)
    const next = draft
    draft = null
    if (next !== null && JSON.stringify(next) !== JSON.stringify(layer.cut ?? {})) void app.do(character.id, { type: 'look.cloth.update', id: layer.id, patch: { cut: next } })
  }
  function setHeight (regions: number[], value: number): void {
    const rule = groupRule(cut, regions)
    change(cutGroup(cut, regions, value, rule.feather))
  }
  function setFeather (regions: number[], value: number): void {
    const rule = groupRule(cut, regions)
    change(cutGroup(cut, regions, rule.y, value))
  }
</script>

<div class="cut" data-testid="look-cloth-cut" data-id={layer.id}>
  {#if groups.length === 0}<p class="muted">Load a body with named shirt and trousers regions to edit cuts.</p>{/if}
  {#each groups as group (group.name)}
    {@const rule = groupRule(cut, group.regions)}
    <div class="limb">
      <label>{group.name} height <output>{rule.y.toFixed(2)}</output>
        <input type="range" min="0" max="1" step="0.01" value={rule.y} aria-label="{layer.name} {group.name} height"
          oninput={(event) => setHeight(group.regions, Number(event.currentTarget.value))} onchange={commit} />
      </label>
      <label>Feather <output>{rule.feather.toFixed(2)}</output>
        <input type="range" min="0" max="0.15" step="0.01" value={rule.feather} aria-label="{layer.name} {group.name} feather"
          oninput={(event) => setFeather(group.regions, Number(event.currentTarget.value))} onchange={commit} />
      </label>
    </div>
  {/each}
  {#if regions.length > 0}
    <details><summary>Dropped regions</summary>
      <div class="regions">
        {#each regions as region (region.id)}
          <label><input type="checkbox" checked={cut.drop?.includes(region.id) === true} onchange={(event) => { change(dropRegion(cut, region.id, event.currentTarget.checked)); commit() }} /> {region.id} {region.material}</label>
        {/each}
      </div>
    </details>
  {/if}
  {#if layer.trim}<details><summary>Trim mask</summary><img src={assets.asset(character, layer.trim)} alt="Trim mask for {layer.name}" /></details>{/if}
</div>

<style>
  .cut { display: flex; flex-direction: column; gap: 6px; }
  .limb { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  label { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; color: var(--text-2); font-size: 11px; }
  input[type='range'] { width: 100%; }
  output { margin-left: auto; font-variant-numeric: tabular-nums; }
  details { font-size: 11px; color: var(--text-2); }
  summary { cursor: pointer; }
  .regions { max-height: 120px; overflow: auto; display: grid; grid-template-columns: 1fr 1fr; }
  img { width: 100%; max-height: 160px; object-fit: contain; background: var(--bg-2); }
  .muted { margin: 0; color: var(--text-3); font-size: 11px; }
</style>
