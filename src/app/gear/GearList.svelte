<script lang="ts">
  // The character's gear, grouped by swap set (one piece of a set shows at a time): each piece's name, where it is
  // worn, where it came from, and its import state; show or hide it, remove it (asked first), pick it to open it.
  import { CircleAlert, Eye, EyeOff, LoaderCircle, Trash2 } from '@lucide/svelte'
  import type { Character, Gear } from '../../state/api.ts'
  import { meshNameOf, SWAPPED } from '../../engine/contract.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import Badge from '../../ui/Badge.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { fromGame, originOf, swapGroups, wearText } from './text.ts'
  import { app } from '../../state/app.svelte.ts'
  import { setsOf as modelSets } from '../../model/folk.ts'
  import { contextMenu } from '../../ui/contextmenu.ts'
  import { addPieceToSet, buildGearMenu, gearListMatches } from './menu.ts'
  import { cleanTag } from './wardrobe.ts'
  import { untrack } from 'svelte'
  import { wardrobe } from './wardrobe.svelte.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import { setsWith } from '../../state/dressing.ts'

  let { character }: { character: Character } = $props()

  // Restore once per character. A later explicit deselection is also remembered.
  $effect(() => {
    const id = character.id
    untrack(() => {
      const want = wardrobe.view(id).selected ?? null
      if (gearState.selectionFor !== id || gearState.selected === null) {
        gearState.select(want !== null && character.gear.some(g => g.id === want) ? want : null)
      }
    })
  })
  $effect(() => {
    const selected = gearState.selected
    const owner = gearState.selectionFor
    const id = character.id
    untrack(() => {
      if (owner === id && selected !== (wardrobe.view(id).selected ?? null)) wardrobe.update(id, { selected })
    })
  })

  // (a dynamic character: only the outfit and the hair and beard on stage are listed; the Folk pickers switch them)
  const listed = $derived(character.gear.filter(g => {
    const sets = setsWith(character, g)
    if (sets.length > 0) return sets.includes(dress.worn(character).outfit ?? '') || dress.of(character.id)?.off?.includes(g.id) === true
    if (g.role !== undefined) return gearState.shownOnStage(character, g) || dress.of(character.id)?.off?.includes(g.id) === true
    return true
  }))
  let search = $state('')
  let editing = $state<{ id: string, kind: 'rename' | 'tag' } | null>(null)
  let draft = $state('')
  const groups = $derived(swapGroups(listed.filter(g => gearListMatches(character, g, search))))

  function edit (g: Gear, kind: 'rename' | 'tag'): void {
    editing = { id: g.id, kind }
    draft = kind === 'rename' ? g.name : ''
  }
  function focusSelect (node: HTMLInputElement): void { node.focus(); node.select() }
  async function finishEdit (g: Gear, keep: boolean): Promise<void> {
    if (editing?.id !== g.id) return
    const kind = editing.kind
    const value = draft.trim()
    editing = null
    if (!keep || value === '') return
    if (kind === 'rename') { await gearState.rename(character, g, value); return }
    const tag = cleanTag(value)
    if (tag === null) { app.toast('info', 'A tag is a short lower-case word (letters, digits, -)'); return }
    if (!(g.tags ?? []).includes(tag)) await app.do(character.id, { type: 'gear.update', id: g.id, patch: { tags: [...(g.tags ?? []), tag] } })
  }
  function menu (g: Gear) {
    return buildGearMenu({
      shown: gearState.shownOnStage(character, g), renameable: !fromGame(g),
      sets: modelSets(character).map(s => ({ id: s.id, name: s.name, contains: s.pieces.includes(g.id) })),
      select: () => { gearState.select(g.id) },
      toggle: () => { void gearState.toggleShown(character, g) },
      rename: () => { edit(g, 'rename') }, tag: () => { edit(g, 'tag') },
      addToSet: id => { const command = addPieceToSet(character, id, g.id); if (command !== null) void app.do(character.id, command) },
      remove: () => { void gearState.remove(character, g) },
    })
  }

  function hiddenHint (g: Gear): string {
    if (gearState.shownOnStage(character, g)) return g.swapSet !== undefined ? `Shown (showing another of ${g.swapSet} hides it)` : 'Shown'
    if (setsWith(character, g).length > 0 || g.role !== undefined) return 'Hidden in this preview'
    // (the game swaps its Gear*, Head* and Wear* pieces itself: they go into the export hidden)
    return SWAPPED.test(meshNameOf(g)) ? 'Hidden here; the game still gets it and switches it itself' : 'Hidden: not shown, not exported'
  }
</script>

{#if listed.length > 6 || search !== ''}
  <input class="search" type="search" aria-label="Search gear" data-testid="gear-search" placeholder="Search gear, sets, tags" bind:value={search} />
{/if}
{#each groups as group (group.set ?? '')}
  {#if group.set !== null}
    <div class="set-head" use:tooltip={'A swap set: showing one of it hides the others'}>{group.set} <span class="count">{group.gear.length}</span></div>
  {/if}
  <ul>
    {#each group.gear as g (g.id)}
      {@const origin = originOf(g)}
      {@const shown = gearState.shownOnStage(character, g)}
      <li class:selected={gearState.selected === g.id} class:hidden={!shown}>
        {#if editing?.id === g.id}
          <input class="edit" aria-label={editing.kind === 'rename' ? 'New name' : 'Add a tag'} bind:value={draft} use:focusSelect
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void finishEdit(g, true) } else if (e.key === 'Escape') { e.preventDefault(); void finishEdit(g, false) } }}
            onblur={() => { void finishEdit(g, true) }} />
        {:else}
        <button class="row" use:contextMenu={() => menu(g)} data-testid="gear-row" data-id={g.id} data-hidden={!shown} onclick={() => gearState.select(gearState.selected === g.id ? null : g.id)} aria-pressed={gearState.selected === g.id}>
          <span class="name">{g.name}</span>
          <span class="detail">
            {#if g.status === 'importing'}<LoaderCircle size={12} class="spin" /> importing
            {:else if g.status === 'error'}<span class="failed" use:tooltip={g.error ?? 'The import failed'}><CircleAlert size={12} /> failed</span>
            {:else}{wearText(g)}{/if}
          </span>
        </button>
        {/if}
        {#if origin !== 'upload'}
          <span class="origin" use:tooltip={origin === 'game' ? `The game's own part (${g.from})` : 'From the catalog'}>
            <Badge tone={origin === 'game' ? 'accent' : 'muted'}>{origin}</Badge>
          </span>
        {/if}
        <IconButton size="sm" data-testid="gear-eye" data-id={g.id} label="{shown ? 'Hide' : 'Show'} {g.name}" hint={hiddenHint(g)}
          onclick={() => gearState.toggleShown(character, g)}>
          {#if !shown}<EyeOff size={13} />{:else}<Eye size={13} />{/if}
        </IconButton>
        <IconButton size="sm" variant="danger" label="Remove {g.name}" onclick={() => gearState.remove(character, g)}><Trash2 size={13} /></IconButton>
      </li>
    {/each}
  </ul>
{/each}

<style>
  .search, .edit { height: 28px; padding: 0 8px; border-radius: var(--r-1); border: 1px solid var(--line); background: var(--bg-2); color: var(--text-1); font: inherit; font-size: 12px; }
  .search { width: 100%; }
  .edit { flex: 1; min-width: 0; }
  ul { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; gap: 2px; padding-right: 4px; border-radius: var(--r-1); border: 1px solid transparent; }
  li:hover { background: var(--bg-2); }
  li.selected { background: var(--accent-soft); border-color: rgb(142 162 255 / 30%); }
  li.hidden .name { color: var(--text-3); }
  .row { flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px; border: 0; background: transparent; text-align: left; color: inherit; }
  .name { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { flex: none; display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--text-3); }
  .failed { display: inline-flex; gap: 4px; align-items: center; color: var(--danger); }
  .origin { display: inline-flex; }
  .set-head { margin: 8px 0 2px; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); }
  .count { margin-left: 4px; }
</style>
