<script lang="ts">
  import { onMount } from 'svelte'
  import { isFolkCharacter, kindsOf, kindSets, setsOf } from '../../model/folk.ts'
  import type { Character, UnitKind } from '../../model/types.ts'
  import { app } from '../../state/app.svelte.ts'
  import { assets } from '../../state/assets.svelte.ts'
  import { classes } from '../../state/classes.svelte.ts'
  import { ship } from '../../state/ship.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import TextField from '../../ui/TextField.svelte'
  import { contextMenu } from '../../ui/contextmenu.ts'
  import { addClass } from './edit.ts'
  let { query }: { query: string } = $props()
  let adding = $state<string | null>(null)
  let draft = $state('')
  let renaming = $state<string | null>(null)
  let name = $state('')
  const bodies = $derived(app.characters.filter(c => isFolkCharacter(c) && (c.name.toLowerCase().includes(query.trim().toLowerCase()) || c.id.toLowerCase().includes(query.trim().toLowerCase()) || kindsOf(c).some(k => k.name.toLowerCase().includes(query.trim().toLowerCase()) || k.id.toLowerCase().includes(query.trim().toLowerCase())))))
  onMount(() => { void ship.load() })
  function matches (c: Character, k: UnitKind): boolean {
    const q = query.trim().toLowerCase()
    return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || k.name.toLowerCase().includes(q) || k.id.toLowerCase().includes(q)
  }
  function setSummary (c: Character, k: UnitKind): string {
    if (!Array.isArray(k.sets) && k.sets.query.length === 0) return 'Every set'
    return `${kindSets(setsOf(c), k).length} of ${setsOf(c).length} sets`
  }
  async function add (c: Character): Promise<void> {
    const value = draft.trim(); if (!value) return
    const result = await app.do(c.id, addClass(c, value)); if (result !== null) { adding = null; draft = '' }
  }
  async function rename (c: Character, k: UnitKind): Promise<void> {
    const value = name.trim(); renaming = null
    if (value && value !== k.name) await app.do(c.id, { type: 'folk.kind.update', id: k.id, patch: { name: value } })
  }
  async function remove (c: Character, k: UnitKind): Promise<void> {
    if (!await app.confirm({ title: `Remove ${k.name}?`, body: 'The class can be restored with Undo.', confirm: 'Remove', danger: true })) return
    const entry = await app.do(c.id, { type: 'folk.kind.remove', id: k.id })
    if (entry !== null) app.toast('ok', `Removed ${k.name}`, 8000, { label: 'Undo', run: () => { void app.undo(c.id, entry.seq) } })
  }
</script>
<div class="bodies">
  {#each bodies as c (c.id)}
    <section>
      <div class="body">
        {#if c.files.thumbnail}<img src={assets.thumbnail(c)} alt="" />{/if}
        <div><strong>{c.name}</strong><div class="faint">Dynamic character</div></div>
      </div>
      {#if c.folk === undefined}<p class="faint">Not migrated</p>{:else}
        {#each kindsOf(c).filter(k => matches(c, k)) as k (k.id)}
          {@const units = ship.unitsOf(c.id).filter(u => u.role === 'unit' && u.ours.folk?.kind === k.id)}
          <div class="row">
            <button class="open" use:contextMenu={() => [
              { label: 'Open class', run: () => { void classes.openClass(c.id, k.id) } },
              { label: 'Rename', run: () => { renaming = `${c.id}:${k.id}`; name = k.name } },
              { label: 'Remove', danger: true, run: () => { void remove(c, k) } },
            ]} data-testid="class-row" data-id={`${c.id}:${k.id}`} data-kind={k.id} onclick={() => classes.openClass(c.id, k.id)}><strong>{k.name}</strong><small>{setSummary(c, k)}{units.length ? ` · ${units.map(u => u.name).join(', ')}` : ''}</small></button>
            <Button size="sm" variant="ghost" onclick={() => { renaming = `${c.id}:${k.id}`; name = k.name }}>Rename</Button>
            <Button size="sm" variant="ghost" data-testid="class-remove" data-id={`${c.id}:${k.id}`} onclick={() => remove(c, k)}>Remove</Button>
          </div>
          {#if renaming === `${c.id}:${k.id}`}<TextField label="Class name" bind:value={name} autoselect oncommit={() => rename(c, k)} />{/if}
        {/each}
        {#if adding === c.id}
          <TextField label="New class name" placeholder="Use the game's unit id" bind:value={draft} autoselect oncommit={() => add(c)} />
          <Button size="sm" onclick={() => add(c)}>Create class</Button>
        {:else}<Button size="sm" variant="ghost" onclick={() => { adding = c.id; draft = '' }}>Add class</Button>{/if}
      {/if}
    </section>
  {/each}
  {#if bodies.length === 0}<p class="faint">No dynamic characters match.</p>{/if}
</div>
<style>
  .bodies { overflow: auto; flex: 1; padding: 8px 12px; } section { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .body { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; } img { width: 36px; height: 36px; object-fit: cover; border-radius: 5px; }
  .faint, small { font-size: 11px; } .row { display: flex; align-items: center; } .open { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: start; border: 0; background: transparent; text-align: left; padding: 6px; } small { color: var(--text-3); }
</style>
