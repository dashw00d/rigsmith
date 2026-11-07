<script lang="ts">
  // Every piece of a dynamic character, grouped by set (a piece in several sets under each; the rest last), each group
  // collapsible (remembered per character). Click picks a piece (and wears its set, so it is on stage), Ctrl toggles,
  // Shift takes the run; the bulk bar acts on all picked at once, each action one command batch (one undo, a toast to
  // take it back): tags, move to a set, hide the body under them, delete. Double-click renames (not the game's own
  // pieces: their names are the game's contract). Rows off screen are skipped by the browser (content-visibility).
  import { onDestroy, tick, untrack } from 'svelte'
  import { ChevronDown, EyeOff, Trash2, X } from '@lucide/svelte'
  import type { Command } from '../../model/command-types.ts'
  import type { Character, Gear } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import { setsOf } from '../../model/folk.ts'
  import { fromGame } from './text.ts'
  import IconButton from '../../ui/IconButton.svelte'
  import { register } from '../../ui/shortcuts.ts'
  import { tooltip } from '../../ui/tooltip.ts'
  import { contextMenu } from '../../ui/contextmenu.ts'
  import { addPieceToSet, buildGearMenu } from './menu.ts'
  import { wardrobe } from './wardrobe.svelte.ts'
  import { cleanTag, label, moveCommands, partOf, pieceGroups, selectClick } from './wardrobe.ts'

  let { character }: { character: Character } = $props()

  let search = $state('')
  const groups = $derived(pieceGroups(character, search))
  const order = $derived(groups.flatMap(g => (wardrobe.isCollapsed(character.id, g.set ?? '') && search === '' ? [] : g.pieces.map(p => p.id))))
  const byId = $derived(new Map(character.gear.map(g => [g.id, g])))
  const picked = $derived(wardrobe.picked.filter(id => byId.has(id)))
  const pickedGear = $derived(picked.map(id => byId.get(id)!))
  const sets = $derived([...setsOf(character)].sort((a, b) => a.name.localeCompare(b.name)))
  const tagsOnPicked = $derived([...new Set(pickedGear.flatMap(g => g.tags ?? []))].sort())
  const skinPicked = $derived(pickedGear.filter(g => g.attach.kind === 'skin'))
  const allHide = $derived(skinPicked.length > 0 && skinPicked.every(g => g.attach.kind === 'skin' && g.attach.hideBody === true))

  let renaming = $state<string | null>(null)
  let renameText = $state('')
  let tagText = $state('')
  let busy = $state(false)

  function click (e: MouseEvent, g: Gear, set: string | null): void {
    const next = selectClick(picked, wardrobe.anchor, order, g.id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey })
    wardrobe.picked = next.selected
    wardrobe.anchor = next.anchor
    if (next.selected.length === 1) {
      gearState.select(g.id)
      wardrobe.update(character.id, { selected: g.id })
      // (on stage to look at: its set worn)
      if (set !== null) wardrobe.set(character, 'outfit', set)
    }
  }

  async function batch (commands: Command[], text: string): Promise<void> {
    if (commands.length === 0 || busy) return
    busy = true
    try { await wardrobe.run(character, commands, text) } finally { busy = false }
  }

  function addTag (): void {
    const t = cleanTag(tagText)
    if (t === null) { if (tagText.trim() !== '') app.toast('info', 'A tag is a short lower-case word (letters, digits, -)'); return }
    tagText = ''
    void batch(pickedGear.filter(g => !(g.tags ?? []).includes(t)).map(g => ({ type: 'gear.update', id: g.id, patch: { tags: [...(g.tags ?? []), t] } })),
      `Tagged ${pickedGear.length} ${t}`)
  }

  function dropTag (t: string): void {
    void batch(pickedGear.filter(g => (g.tags ?? []).includes(t)).map(g => {
      const rest = (g.tags ?? []).filter(x => x !== t)
      return { type: 'gear.update', id: g.id, patch: { tags: rest.length > 0 ? rest : null } }
    }), `${t} taken off ${pickedGear.length}`)
  }

  function moveTo (setId: string): void {
    const s = sets.find(x => x.id === setId)
    if (s === undefined) return
    void batch(moveCommands(character, picked, setId), `${picked.length} moved into ${label(s.name)}`)
  }

  function hideBody (on: boolean): void {
    void batch(skinPicked.flatMap((g): Command[] => g.attach.kind === 'skin' && (g.attach.hideBody === true) !== on ? [{ type: 'gear.attach', id: g.id, attach: { ...g.attach, hideBody: on } }] : []),
      on ? `${skinPicked.length} hide the body under them` : `${skinPicked.length} hide nothing`)
  }

  async function remove (): Promise<void> {
    const n = picked.length
    const ok = await app.confirm({
      title: `Delete ${n === 1 ? pickedGear[0].name : `${n} pieces`}?`,
      body: 'Keys and holds on them in this character\'s clips go too. Undo brings it all back.', confirm: 'Delete', danger: true,
    })
    if (!ok) return
    if (gearState.selected !== null && picked.includes(gearState.selected)) gearState.select(null)
    const ids = [...picked]
    wardrobe.picked = []
    await batch(ids.map(id => ({ type: 'gear.remove', id })), `${n} deleted`)
  }

  function startRename (g: Gear): void {
    if (fromGame(g)) { app.toast('info', `${g.name} is the game's own piece: its name is what the game knows it by`); return }
    renaming = g.id
    renameText = g.name
  }

  async function finishRename (g: Gear, keep: boolean): Promise<void> {
    const name = renameText.trim()
    renaming = null
    if (keep && name !== '' && name !== g.name) await wardrobe.run(character, [{ type: 'gear.update', id: g.id, patch: { name } }], `${g.name} renamed ${name}`)
  }

  function rowMenu (g: Gear, set: string | null) {
    const shown = gearState.shownOnStage(character, g)
    const select = (): void => {
      wardrobe.picked = [g.id]
      wardrobe.anchor = g.id
      gearState.select(g.id)
      wardrobe.update(character.id, { selected: g.id })
      if (set !== null) wardrobe.set(character, 'outfit', set)
    }
    return buildGearMenu({
      shown, renameable: !fromGame(g),
      sets: sets.map(s => ({ id: s.id, name: s.name, contains: s.pieces.includes(g.id) })),
      select,
      toggle: () => {
        if (!shown && set !== null) wardrobe.set(character, 'outfit', set)
        if (!shown && (g.role === 'hair' || g.role === 'beard')) wardrobe.set(character, g.role, g.id)
        void gearState.setShown(character, g, !shown)
      },
      rename: () => { startRename(g) },
      addToSet: id => { const command = addPieceToSet(character, id, g.id); if (command !== null) void wardrobe.run(character, [command], `${g.name} added to a set`) },
      tag: () => { wardrobe.picked = [g.id]; void tick().then(() => { document.querySelector<HTMLInputElement>('[aria-label="Add a tag to them"]')?.focus() }) },
      remove: () => { void gearState.remove(character, g) },
    })
  }

  function focusSelect (node: HTMLInputElement): void { node.focus(); node.select() }

  const off = register(
    { id: 'pieces.delete', keys: 'delete', label: 'Delete the picked pieces', group: 'Pieces', when: () => picked.length > 0 && renaming === null, run: () => { void remove() } },
    { id: 'pieces.all', keys: 'ctrl+a', label: 'Pick every piece listed', group: 'Pieces', when: () => order.length > 0, run: () => { wardrobe.picked = [...order] } },
  )
  onDestroy(off)

  // (the first time: every set folded but the one worn, so the list opens short and on what is on stage)
  $effect(() => {
    const id = character.id
    untrack(() => {
      if (wardrobe.view(id).collapsed !== undefined) return
      const worn = dress.worn(character).outfit
      wardrobe.setCollapsed(id, pieceGroups(character).map(g => g.set ?? '').filter(k => k !== worn))
    })
  })

  const allCollapsed = $derived(groups.every(g => wardrobe.isCollapsed(character.id, g.set ?? '')))
</script>

<div class="pieces">
  <div class="tools">
    <input class="search" type="search" placeholder="Search pieces, tags, sets" bind:value={search} aria-label="Search pieces" />
    <button class="link" onclick={() => { wardrobe.setCollapsed(character.id, allCollapsed ? [] : groups.map(g => g.set ?? '')) }}>{allCollapsed ? 'Expand all' : 'Collapse all'}</button>
  </div>

  {#if picked.length > 0}
    <div class="bulk" role="toolbar" aria-label="The picked pieces">
      <div class="bulk-row">
        <strong>{picked.length} picked</strong>
        <span class="grow"></span>
        <select aria-label="Move into a set" disabled={busy} onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; if (v !== '') moveTo(v) }}>
          <option value="">Move into…</option>
          {#each sets as s (s.id)}<option value={s.id}>{label(s.name)}</option>{/each}
        </select>
        {#if skinPicked.length > 0}
          <IconButton size="sm" active={allHide} label={allHide ? 'Stop hiding the body under them' : 'Hide the body under them'} disabled={busy} onclick={() => { hideBody(!allHide) }}><EyeOff size={13} /></IconButton>
        {/if}
        <IconButton size="sm" variant="danger" label="Delete them (Del)" disabled={busy} onclick={() => { void remove() }}><Trash2 size={13} /></IconButton>
        <IconButton size="sm" label="Pick none" onclick={() => { wardrobe.picked = [] }}><X size={13} /></IconButton>
      </div>
      <div class="bulk-row tags">
        {#each tagsOnPicked as t (t)}
          <span class="tag">{t}<button aria-label="Take {t} off them" disabled={busy} onclick={() => { dropTag(t) }}><X size={10} /></button></span>
        {/each}
        <input class="tag-input" placeholder="+ tag" bind:value={tagText} aria-label="Add a tag to them" disabled={busy}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }} />
      </div>
    </div>
  {/if}

  {#each groups as group (group.set ?? '')}
    {@const key = group.set ?? ''}
    {@const shut = search === '' && wardrobe.isCollapsed(character.id, key)}
    <button class="group" aria-expanded={!shut} onclick={() => { wardrobe.toggleGroup(character.id, key) }}>
      <ChevronDown size={12} class={shut ? 'shut' : ''} />
      <span class="gname">{group.set === null ? 'In no set' : label(group.set)}</span>
      <span class="count">{group.pieces.length}</span>
    </button>
    {#if !shut}
      <ul>
        {#each group.pieces as g (g.id)}
          {@const part = partOf(g)}
          <li class:picked={picked.includes(g.id)} class:selected={gearState.selected === g.id}>
            {#if renaming === g.id}
              <input class="rename" bind:value={renameText} use:focusSelect aria-label="New name"
                onkeydown={(e) => { if (e.key === 'Enter') void finishRename(g, true); else if (e.key === 'Escape') { e.preventDefault(); void finishRename(g, false) } }}
                onblur={() => { void finishRename(g, true) }} />
            {:else}
              <button class="row" data-testid="wardrobe-piece-row" data-id={g.id} use:contextMenu={() => rowMenu(g, group.set)} onclick={(e) => { click(e, g, group.set) }} ondblclick={() => { startRename(g) }}
                aria-pressed={picked.includes(g.id)} use:tooltip={fromGame(g) ? `${g.name} (the game's own piece)` : `${g.name}: double-click to rename`}>
                <span class="name">{g.name}</span>
                {#if part !== null}<span class="part">{part}</span>{/if}
                {#each g.tags ?? [] as t (t)}<span class="tag small">{t}</span>{/each}
                {#if g.attach.kind === 'skin' && g.attach.hideBody === true}<span class="hides" use:tooltip={'Hides the body under it'}><EyeOff size={11} /></span>{/if}
                {#if g.status !== 'ready'}<span class="state">{g.status}</span>{/if}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
</div>

<style>
  .pieces { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px 16px 14px; }
  .tools { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .search { flex: 1; height: 28px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-1); font: inherit; font-size: 12.5px; }
  .search:focus, .tag-input:focus, .rename:focus { outline: none; border-color: var(--accent); }
  .link { border: 0; background: transparent; color: var(--text-3); font-size: 11.5px; padding: 0; white-space: nowrap; }
  .link:hover { color: var(--text-1); }
  .bulk { position: sticky; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; margin-bottom: 6px; border-radius: var(--r-2); background: var(--bg-3); box-shadow: 0 4px 14px rgb(0 0 0 / 35%); }
  .bulk-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 12px; }
  .bulk select { height: 24px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-1); font: inherit; font-size: 11.5px; }
  .grow { flex: 1; }
  .tag { display: inline-flex; align-items: center; gap: 2px; height: 20px; padding: 0 3px 0 7px; border-radius: 10px; background: var(--bg-2); border: 1px solid var(--line); font-size: 11px; color: var(--text-2); }
  .tag button { display: grid; place-items: center; width: 14px; height: 14px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--text-3); }
  .tag button:hover { background: var(--bg-4); color: var(--text-1); }
  .tag.small { height: 16px; padding: 0 5px; font-size: 10px; }
  .tag-input { width: 80px; height: 22px; padding: 0 7px; border-radius: 10px; border: 1px dashed var(--line-strong); background: transparent; color: var(--text-1); font: inherit; font-size: 11px; }
  .group { display: flex; align-items: center; gap: 5px; margin-top: 6px; padding: 3px 2px; border: 0; background: transparent; color: var(--text-3); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; text-align: left; }
  .group:hover { color: var(--text-1); }
  .group :global(.shut) { transform: rotate(-90deg); }
  .gname { flex: 1; }
  .count { font-variant-numeric: tabular-nums; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  li { border-radius: var(--r-1); border: 1px solid transparent; content-visibility: auto; contain-intrinsic-size: auto 28px; }
  li:hover { background: var(--bg-2); }
  li.picked { background: var(--accent-soft); border-color: rgb(142 162 255 / 30%); }
  li.selected .name { color: var(--accent); }
  .row { width: 100%; display: flex; align-items: center; gap: 5px; padding: 5px 8px; border: 0; background: transparent; color: inherit; text-align: left; user-select: none; }
  .name { flex: 1; min-width: 0; font-weight: 550; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .part { font-size: 11px; color: var(--text-3); }
  .hides { display: inline-flex; color: var(--text-3); }
  .state { font-size: 11px; color: var(--warn, #e0b252); }
  .rename { width: 100%; height: 28px; padding: 0 8px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-1); font: inherit; font-size: 12.5px; }
</style>
