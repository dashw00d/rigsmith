<script lang="ts">
  import type { Character, OutfitSet } from '../../model/types.ts'
  import type { Command } from '../../model/command-types.ts'
  import { newId } from '../../model/ids.ts'
  import { folkTags } from '../../model/commands/folk.ts'
  import { app } from '../../state/app.svelte.ts'
  import { classes } from '../../state/classes.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Chips from '../../ui/Chips.svelte'
  import TextField from '../../ui/TextField.svelte'
  import { contextMenu, type MenuItem } from '../../ui/contextmenu.ts'
  import { addPiecesCommands, GRANTS, wornBy } from './sets.ts'

  let { character, set }: { character: Character, set: OutfitSet } = $props()
  const editable = $derived(character.folk !== undefined)
  const kinds = $derived(wornBy(character, set))
  let tag = $state('')
  const run = (command: Command | Command[]): void => { void app.do(character.id, command) }
  function rename (name: string): void {
    const next = name.trim()
    if (next !== '' && next !== set.name) run({ type: 'folk.set.update', id: set.id, patch: { name: next } })
  }
  function addTags (value: string): void {
    try {
      const next = folkTags([...set.tags, ...value.toLowerCase().split(/[\s,]+/).filter(Boolean)], 'tags')
      tag = ''
      if (next.join('\0') !== set.tags.join('\0')) run({ type: 'folk.set.update', id: set.id, patch: { tags: next } })
    } catch (error) { app.toast('error', error instanceof Error ? error.message : String(error)) }
  }
  async function remove (): Promise<void> {
    if (await app.confirm({ title: `Delete ${set.name}?`, body: 'The set is removed from its classes. Its pieces remain. Undo brings the set back.', confirm: 'Delete', danger: true })) run({ type: 'folk.set.remove', id: set.id })
  }
  function menu (): MenuItem[] {
    return [
      { label: 'Duplicate', disabled: !editable, run: () => { run({ type: 'folk.set.duplicate', id: set.id, newId: newId() }) } },
      { label: 'Delete', disabled: !editable, danger: true, run: () => { void remove() } },
    ]
  }
  function drop (event: DragEvent): void {
    event.preventDefault()
    if (!editable) return
    const id = event.dataTransfer?.getData('application/x-rigsmith-gear') ?? ''
    const commands = addPiecesCommands(character, set.id, [id])
    if (commands.length > 0) run(commands)
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
<div class="set-row" role="group" aria-label="Set {set.name}" tabindex="0" data-testid="sets-row" data-id={set.id}
  use:contextMenu={menu} ondragover={(e) => { if (editable && e.dataTransfer?.types.includes('application/x-rigsmith-gear')) e.preventDefault() }} ondrop={drop}>
  <div class="title">
    <TextField label="Set name {set.name}" value={set.name} disabled={!editable} size="sm" oncommit={rename} />
    <span class="count">{set.pieces.length} {set.pieces.length === 1 ? 'piece' : 'pieces'}</span>
  </div>
  {#if set.tags.length > 0}
    <Chips label="Tags for {set.name}" options={set.tags.map(t => ({ value: t, label: t, disabled: !editable }))} value={set.tags}
      onchange={(tags) => run({ type: 'folk.set.update', id: set.id, patch: { tags } })} />
  {/if}
  <TextField label="Add tags to {set.name}" placeholder="Add tags, e.g. culture:gael" bind:value={tag} disabled={!editable} size="sm" oncommit={addTags} />
  <Chips label="Grants for {set.name}" testid="sets-grants" options={GRANTS.map(g => ({ value: g, label: g, disabled: !editable }))}
    value={set.grants} onchange={(grants) => run({ type: 'folk.set.update', id: set.id, patch: { grants } })} />
  {#if kinds.length > 0}
    <div class="worn"><span>Worn by</span>{#each kinds as kind (kind.id)}<Button size="sm" variant="ghost" data-testid="sets-kind" data-id={kind.id} onclick={() => { void classes.openClass(character.id, kind.id) }}>{kind.name}</Button>{/each}</div>
  {/if}
</div>

<style>
  .set-row { display: flex; flex-direction: column; gap: 5px; padding: 8px; border: 1px solid var(--line); border-radius: var(--r-2); }
  .set-row:focus-visible { outline: 1px solid var(--accent); }
  .title, .worn { display: flex; align-items: center; gap: 6px; }
  .title :global(input) { flex: 1; }
  .count, .worn > span { color: var(--text-3); font-size: 11px; white-space: nowrap; }
  .worn { flex-wrap: wrap; }
</style>
