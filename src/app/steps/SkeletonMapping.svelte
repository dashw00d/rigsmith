<script lang="ts">
  import { onMount } from 'svelte'
  import { CircleCheck, Save, Sparkles, TriangleAlert } from '@lucide/svelte'
  import { api, type Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import { prettyBone } from '../../engine/mixamo.ts'
  import { autoMapToMixamo, coverage, MAP_GROUPS, skeletonRecords, type BoneMap } from '../../engine/presets/skeletonMap.ts'
  import Button from '../../ui/Button.svelte'

  let { character }: { character: Character } = $props()

  let presets = $state<Array<{ name: string, map: BoneMap }>>([])
  let presetName = $state('')
  let open = $state(false)
  const bones = $derived.by(() => {
    void viewer.character
    return viewer.character === null ? [] : skeletonRecords(viewer.character.root).map(b => b.name)
  })
  const map = $derived((character.boneMap ?? {}) as BoneMap)
  const cov = $derived(coverage(map))

  onMount(() => {
    void api.skeletonPresets().then(p => { presets = p })
  })

  // First time we see this rig: map it automatically.
  $effect(() => {
    if (character.boneMap === undefined && viewer.character !== null && bones.length > 0) void save(autoMapToMixamo(skeletonRecords(viewer.character.root)))
  })

  async function save (next: BoneMap): Promise<void> {
    await app.update(character.id, { boneMap: next })
    animator.rebind()
  }

  async function savePreset (): Promise<void> {
    const name = presetName.trim()
    if (name === '') return
    await api.saveSkeletonPreset(name, map)
    presets = await api.skeletonPresets()
    presetName = ''
    app.toast('ok', `Saved skeleton preset "${name}"`)
  }

  async function applyPreset (name: string): Promise<void> {
    const preset = presets.find(p => p.name === name)
    if (preset === undefined) return
    // Keep only bones this rig actually has.
    const available = new Set(bones)
    await save(Object.fromEntries(Object.entries(preset.map).filter(([, t]) => available.has(t))))
  }
</script>

<div class="mapping">
  <div class="status" class:ok={cov.mapped === cov.total}>
    {#if cov.mapped === cov.total}<CircleCheck size={15} />{:else}<TriangleAlert size={15} />{/if}
    <span><strong>{cov.mapped} of {cov.total}</strong> core bones mapped to Mixamo</span>
    <button class="link" onclick={() => { open = !open }}>{open ? 'Hide' : 'Edit'}</button>
  </div>
  <p class="faint small">Library animations drive this skeleton through the map. Its own bones and skin weights stay exactly as imported.</p>

  {#if open}
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={() => viewer.character && save(autoMapToMixamo(skeletonRecords(viewer.character.root)))}><Sparkles size={13} /> Auto-map</Button>
      {#if presets.length > 0}
        <select onchange={(e) => { void applyPreset((e.target as HTMLSelectElement).value); (e.target as HTMLSelectElement).value = '' }}>
          <option value="">Apply preset…</option>
          {#each presets as p}<option value={p.name}>{p.name}</option>{/each}
        </select>
      {/if}
    </div>
    {#each MAP_GROUPS as group}
      <div class="group">
        <span class="group-label">{group.label}</span>
        {#each group.bones as bone}
          <label class="row" class:missing={!map[bone]}>
            <span>{prettyBone(bone)}</span>
            <select value={map[bone] ?? ''} onchange={(e) => save({ ...map, [bone]: (e.target as HTMLSelectElement).value })}>
              <option value="">(none)</option>
              {#each bones as b}<option value={b}>{b}</option>{/each}
            </select>
          </label>
        {/each}
      </div>
    {/each}
    <div class="preset">
      <input placeholder="Preset name, e.g. Tripo humanoid" bind:value={presetName} onkeydown={(e) => { if (e.key === 'Enter') void savePreset() }} />
      <Button size="sm" disabled={presetName.trim() === ''} onclick={savePreset}><Save size={13} /> Save preset</Button>
    </div>
  {/if}
</div>

<style>
  .mapping { display: flex; flex-direction: column; gap: 8px; }
  .status { display: flex; align-items: center; gap: 8px; color: var(--warn); }
  .status.ok { color: var(--ok); }
  .status span { flex: 1; color: var(--text-1); }
  .link { border: 0; background: none; color: var(--accent-strong); padding: 0; }
  .small { font-size: 12px; margin: 0; }
  .actions { display: flex; gap: 6px; align-items: center; }
  .group { display: flex; flex-direction: column; gap: 3px; }
  .group-label { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
  .row { display: grid; grid-template-columns: 90px 1fr; gap: 8px; align-items: center; font-size: 12px; }
  .row.missing span { color: var(--warn); }
  select { height: 26px; min-width: 0; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 12px; padding: 0 4px; }
  .preset { display: flex; gap: 6px; margin-top: 4px; }
  .preset input { flex: 1; min-width: 0; height: 26px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-1); padding: 0 8px; font-size: 12px; }
</style>
