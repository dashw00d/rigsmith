<script lang="ts">
  import type { Character, Skin } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { assets } from '../../state/assets.svelte.ts'
  import Chips from '../../ui/Chips.svelte'
  import TextField from '../../ui/TextField.svelte'
  import Note from '../../ui/Note.svelte'
  import Button from '../../ui/Button.svelte'
  import { bare } from '../../state/bare.svelte.ts'
  import SkinSheet from './SkinSheet.svelte'

  let { character }: { character: Character } = $props()
  let sheet = $state(false)
  const common = ['female', 'beardless', 'elderly']
  function update (skin: Skin, patch: { name?: string, tags?: string[] | null, hair?: string | null }): void {
    void app.do(character.id, { type: 'look.skin.update', name: skin.name, patch })
  }
</script>

{#if (character.look.skins ?? []).length === 0}
  <Note>No skins on this character.</Note>
{:else}
  <Button size="sm" onclick={() => { sheet = true }}>All skins</Button>
  <Button size="sm" disabled={bare.busy} onclick={() => { void bare.make(character, character.look.skins ?? []) }}>Make all bare</Button>
  {#if bare.busy}<p role="status">Making {bare.label} bare: {Math.round(bare.progress * 100)}%</p>{/if}
  <div class="skins">
    {#each character.look.skins ?? [] as skin (skin.file)}
      <div class="skin" data-testid="look-skin-row" data-id={skin.name}>
        <img src={assets.asset(character, skin.file)} alt="" loading="lazy" decoding="async" />
        <div class="fields">
          <TextField size="sm" label="Skin name {skin.name}" value={skin.name} oncommit={(name) => update(skin, { name })} />
          <Chips label="Tags for {skin.name}" options={[...new Set([...common, ...(skin.tags ?? [])])].map(value => ({ value, label: value }))}
            value={skin.tags ?? []} onchange={(tags) => update(skin, { tags })} />
          <TextField size="sm" label="Add tag to {skin.name}" placeholder="Add tag" oncommit={(tag) => { const value = tag.trim(); if (value) update(skin, { tags: [...new Set([...(skin.tags ?? []), value])] }) }} />
          <label>Hair colour <input aria-label="Hair colour picker for {skin.name}" type="color" value={skin.hair ?? '#584432'} onchange={(e) => update(skin, { hair: e.currentTarget.value })} /></label>
          <TextField size="sm" label="Hair colour for {skin.name}" value={skin.hair ?? ''} placeholder="#rrggbb" oncommit={(hair) => update(skin, { hair: hair === '' ? null : hair })} />
          <Button size="sm" disabled={bare.busy} onclick={() => { void bare.make(character, [skin]) }}>Make bare</Button>
          {#if skin.bare}<span data-testid="look-bare-badge">Bare</span>{/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .skins { display: flex; flex-direction: column; gap: 10px; }
  .skin { display: flex; gap: 8px; }
  img { width: 48px; height: 48px; object-fit: contain; background: var(--bg-2); }
  .fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  label { font-size: 12px; display: flex; align-items: center; gap: 6px; }
  input[type='color'] { width: 36px; height: 24px; padding: 0; }
</style>

{#if sheet}<SkinSheet {character} onclose={() => { sheet = false }} />{/if}
