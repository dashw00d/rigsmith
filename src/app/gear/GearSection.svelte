<script lang="ts">
  import { Library, Shirt, Sword, Upload } from '@lucide/svelte'
  import { phaseOf } from '../../model/select.ts'
  import { MODEL_FILE, type Character, type GearKind } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import Section from '../../ui/Section.svelte'
  import { isFolk } from '../../engine/folk.ts'
  import GearList from './GearList.svelte'
  import { wardrobe } from './wardrobe.svelte.ts'
  let { character }: { character: Character } = $props()
  const rigged = $derived(phaseOf(character).phase === 'rigged')
  let input = $state<HTMLInputElement>()
  let kind = $state<GearKind>('bone')
  let uploading = $state(false)
  function choose (k: GearKind): void { kind = k; input?.click() }
  async function picked (): Promise<void> {
    const files = [...(input?.files ?? [])].filter(f => MODEL_FILE.test(f.name))
    if (input !== undefined) input.value = ''
    if (files.length === 0) return
    uploading = true
    try { await gearState.upload(character, files, kind) } finally { uploading = false }
  }
</script>

<Section title="Gear">
  {#snippet action()}
    <div class="adds">
      {#if isFolk(character)}
        <Button size="sm" data-testid="wardrobe-button" keys="dress.wardrobe" variant={app.drawer === 'wardrobe' ? 'primary' : 'ghost'} onclick={() => app.toggleDrawer('wardrobe')}><Shirt size={13} /> Wardrobe</Button>
      {/if}
      <Button size="sm" variant={app.drawer === 'wardrobe' && wardrobe.tab(character.id) === 'props' ? 'primary' : 'ghost'} onclick={() => { wardrobe.setTab(character.id, 'props'); app.drawer = 'wardrobe' }}
        title="Weapons, shields and tools that come with Rigsmith"><Library size={13} /> Catalog</Button>
      <Button size="sm" variant="ghost" loading={uploading} onclick={() => choose('bone')} title="Your own model (FBX, GLB, OBJ, DAE or ZIP), on a bone">
        <Upload size={13} /> Upload</Button>
    </div>
  {/snippet}
  <input bind:this={input} type="file" accept=".fbx,.glb,.gltf,.obj,.dae,.zip" hidden multiple onchange={picked} />
  {#if !rigged}
    <p class="note">Gear shows on {character.name} once it is rigged (Skeleton step).</p>
  {/if}
  {#if character.gear.length === 0}
    <EmptyState icon={Sword} compact title="No gear yet" body="Add a weapon, shield or tool from the catalog, or upload your own model." />
  {:else}
    <GearList {character} />
  {/if}
  <details class="more">
    <summary>Other ways to wear it</summary>
    <div class="more-body">
      <Button size="sm" variant="ghost" onclick={() => choose('skin')} title="Each vertex moves like the skin under it (a coat, a cape)">
        <Upload size={13} /> Clothing, on the skin</Button>
      <Button size="sm" variant="ghost" onclick={() => choose('spot')} title="Pinned to one spot of the skin, moving without bending (a buckle, a pouch)">
        <Upload size={13} /> A part, pinned to a spot</Button>
    </div>
  </details>
</Section>


<style>
  .adds { display: flex; gap: 2px; }
  .adds :global(button) { padding-inline: 5px; gap: 4px; }
  .note { margin: 0; font-size: 12px; color: var(--text-3); display: flex; align-items: center; gap: 4px; }
  .more summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
  .more summary:hover { color: var(--text-1); }
  .more-body { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
</style>
