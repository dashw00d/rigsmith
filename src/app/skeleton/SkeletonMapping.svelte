<script lang="ts">
  // A rigged import's own skeleton mapped onto the Mixamo names (skeleton.boneMap): library clips play on it through
  // the map before it is converted, and the conversion reads its joints by those names. Mapped automatically the first
  // time the panel sees it; edited by hand, from a saved preset, or saved as one for the next model with that rig.
  import { onMount, untrack } from 'svelte'
  import { CircleCheck, Save, Sparkles, TriangleAlert } from '@lucide/svelte'
  import { api, type Character, type SkeletonPreset } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import { prettyBone } from '../../engine/mixamo.ts'
  import { autoMapToMixamo, coverage, MAP_GROUPS, skeletonRecords, type BoneMap } from '../../engine/presets/skeletonMap.ts'
  import Button from '../../ui/Button.svelte'

  let { character }: { character: Character } = $props()

  let presets = $state.raw<SkeletonPreset[]>([])
  let presetName = $state('')
  let open = $state(false)
  // (the loaded model's own bones, by their names in the file)
  const bones = $derived(viewer.character === null ? [] : skeletonRecords(viewer.character.root).map(b => b.name))
  const map = $derived((character.skeleton.boneMap ?? {}) as BoneMap)
  const cov = $derived(coverage(map))

  onMount(() => {
    void api.skeletonPresets().then(p => { presets = p }, () => { /* (none to offer) */ })
  })

  // The first time a character's rig shows here, unmapped: mapped automatically (once; the user's edits stand).
  const tried = new Set<string>()
  $effect(() => {
    const id = character.id
    if (character.skeleton.boneMap !== undefined || viewer.character === null || bones.length === 0 || tried.has(id)) return
    tried.add(id)
    const records = skeletonRecords(viewer.character.root)
    untrack(() => { void save(autoMapToMixamo(records), 'skeleton mapped automatically') })
  })

  // (the animator plays clips through the new map on its own: it follows the bone map)
  async function save (next: BoneMap, what?: string): Promise<void> {
    await app.do(character.id, { type: 'skeleton.boneMap', boneMap: next }, what)
  }

  function autoMap (): void {
    if (viewer.character === null) return
    void save(autoMapToMixamo(skeletonRecords(viewer.character.root)))
  }

  async function savePreset (): Promise<void> {
    const name = presetName.trim()
    if (name === '') return
    try {
      await api.saveSkeletonPreset(name, $state.snapshot(map))
      presets = await api.skeletonPresets()
      presetName = ''
      app.toast('ok', `Saved the mapping as "${name}"`)
    } catch (error) {
      app.toast('error', `Not saved: ${(error as Error).message}`)
    }
  }

  async function applyPreset (name: string): Promise<void> {
    const preset = presets.find(p => p.name === name)
    if (preset === undefined) return
    // (only bones this rig has)
    const available = new Set(bones)
    await save(Object.fromEntries(Object.entries(preset.map).filter(([, b]) => available.has(b))))
  }
</script>

<div class="mapping">
  <div class="status" class:ok={cov.mapped === cov.total}>
    {#if cov.mapped === cov.total}<CircleCheck size={15} />{:else}<TriangleAlert size={15} />{/if}
    <span><strong>{cov.mapped} of {cov.total}</strong> core bones mapped</span>
    <button class="link" onclick={() => { open = !open }}>{open ? 'Hide' : 'Edit'}</button>
  </div>
  <p class="faint small">Library clips play on its own skeleton through this map, and converting reads its joints by it. Its bones and weights stay as imported.</p>

  {#if open}
    <div class="actions">
      <Button size="sm" variant="ghost" disabled={viewer.character === null} onclick={autoMap}><Sparkles size={13} /> Map automatically</Button>
      {#if presets.length > 0}
        <select aria-label="Apply a saved mapping" onchange={(e) => { void applyPreset(e.currentTarget.value); e.currentTarget.value = '' }}>
          <option value="">Apply a saved one…</option>
          {#each presets as p (p.name)}<option value={p.name}>{p.name}</option>{/each}
        </select>
      {/if}
    </div>
    {#each MAP_GROUPS as group (group.label)}
      <div class="group">
        <span class="group-label">{group.label}</span>
        {#each group.bones as bone (bone)}
          <label class="row" class:missing={!map[bone]}>
            <span>{prettyBone(bone)}</span>
            <select value={map[bone] ?? ''} onchange={(e) => { void save({ ...map, [bone]: e.currentTarget.value }) }}>
              <option value="">(none)</option>
              {#each bones as b (b)}<option value={b}>{b}</option>{/each}
            </select>
          </label>
        {/each}
      </div>
    {/each}
    <div class="preset">
      <input placeholder="Save as, e.g. Tripo humanoid" bind:value={presetName} onkeydown={(e) => { if (e.key === 'Enter') void savePreset() }} />
      <Button size="sm" disabled={presetName.trim() === ''} onclick={savePreset}><Save size={13} /> Save</Button>
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
  .row { display: grid; grid-template-columns: 110px 1fr; gap: 8px; align-items: center; font-size: 12px; }
  .row.missing span { color: var(--warn); }
  select { height: 26px; min-width: 0; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 12px; padding: 0 4px; }
  .preset { display: flex; gap: 6px; margin-top: 4px; }
  .preset input { flex: 1; min-width: 0; height: 26px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-1); padding: 0 8px; font-size: 12px; }
</style>
