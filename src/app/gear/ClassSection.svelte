<script lang="ts">
  import type { Character, UnitKind } from '../../model/types.ts'
  import { folkTags } from '../../model/commands/folk.ts'
  import { kindSetRows } from '../../model/classes.ts'
  import { kindsOf, poolsOf, setsOf } from '../../model/folk.ts'
  import { app } from '../../state/app.svelte.ts'
  import { classes } from '../../state/classes.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Chips from '../../ui/Chips.svelte'
  import Note from '../../ui/Note.svelte'
  import NumberField from '../../ui/NumberField.svelte'
  import Section from '../../ui/Section.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Select from '../../ui/Select.svelte'
  import TextField from '../../ui/TextField.svelte'
  import { listSet, toList, toQuery, unlistSet, usePool, weigh } from '../classes/edit.ts'
  let { character }: { character: Character } = $props()
  const kind = $derived(kindsOf(character).find(k => k.id === classes.openId))
  const rows = $derived(kind === undefined ? [] : kindSetRows(character, kind))
  const all = $derived(setsOf(character))
  const steps = ['skin', 'bottom', 'top', 'over', 'hair', 'beard', 'accessory']
  const update = (command: Parameters<typeof app.do>[1]): void => { void app.do(character.id, command) }
  function tags (value: string, k: UnitKind, query: boolean): void {
    try {
      const parsed = folkTags(value.split(/[\s,]+/).filter(Boolean), 'tags')
      update(query ? { type: 'folk.kind.sets', id: k.id, sets: toQuery(parsed) } : { type: 'folk.kind.update', id: k.id, patch: { tags: parsed } })
    } catch (error) { app.toast('error', error instanceof Error ? error.message : String(error)) }
  }
</script>
{#if kind !== undefined}
  <Section title="Class" testid="class-section">
    {#snippet action()}<Button size="sm" variant="ghost" onclick={() => classes.close()}>Close</Button>{/snippet}
    <strong>{kind.name}</strong>
    <TextField label="Class tags" value={kind.tags.join(', ')} oncommit={(v) => tags(v, kind, false)} placeholder="Class tags" />
    <strong>Wears</strong>
    <Segmented label="Sets mode" size="sm" value={Array.isArray(kind.sets) ? 'list' : 'query'} options={[{ value: 'list', label: 'Listed' }, { value: 'query', label: 'By tags' }]} onchange={(v) => { if ((v === 'list') !== Array.isArray(kind.sets)) update({ type: 'folk.kind.sets', id: kind.id, sets: v === 'list' ? toList(character, kind) : toQuery([]) }) }} />
    {#if Array.isArray(kind.sets)}
      {#each rows as row (row.set.id)}
        <div class="set"><div class="setname"><span>{row.set.name}</span><Chips label="Set tags" options={row.set.tags.map(t => ({ value: t, label: t, disabled: true }))} value={row.set.tags} /></div><NumberField label="Weight for {row.set.name}" testid="class-weight-{row.set.id}" value={row.weight} min={0} max={10} step={0.1} onchange={(v) => update(weigh(character, kind, row.set.id, v))} /><Button size="sm" variant="ghost" onclick={() => update(unlistSet(character, kind, row.set.id))}>Remove</Button></div>
      {/each}
      <Select label="Add set" value={null} placeholder="Add set" options={all.filter(s => !rows.some(r => r.set.id === s.id)).map(s => ({ value: s.id, label: s.name }))} onchange={(id) => update(listSet(character, kind, id))} />
    {:else}
      <TextField label="Set query tags" testid="class-query" value={kind.sets.query.join(', ')} oncommit={(v) => tags(v, kind, true)} placeholder="culture:norse" />
      <Note>Matches {rows.length} of {all.length} sets. Set weights apply; switch to Listed for class-specific weights.</Note>
      {#each rows as row (row.set.id)}<span class="faint">{row.set.name}</span>{/each}
    {/if}
    <strong>Pools</strong>
    {#each steps as step (step)}
      {@const options = poolsOf(character).filter(p => p.kind === (['bottom', 'top', 'over'].includes(step) ? 'cloth' : step) && (p.kind !== 'cloth' || p.slot === undefined || p.slot === step))}
      <div class="pool"><span>{step}</span><Select label="{step} pool" value={kind.pools?.[step] ?? ''} options={[{ value: '', label: 'Default' }, ...options.map(p => ({ value: p.id, label: `${p.name} (${p.items.length})` }))]} onchange={(v) => update(usePool(kind, step, v || null))} /></div>
    {/each}
    <strong>Stance</strong>
    {#if (character.folk?.stances.length ?? 0) === 0}<Note>No stances yet.</Note>{:else}
      <Select label="Class stance" value={kind.stance ?? ''} options={[{ value: '', label: 'None' }, ...character.folk!.stances.map(s => ({ value: s.id, label: s.name }))]} onchange={(v) => update({ type: 'folk.kind.update', id: kind.id, patch: { stance: v || null } })} />
    {/if}
  </Section>
{/if}
<style>
  .set, .pool { display: flex; gap: 6px; align-items: center; } .setname { flex: 1; min-width: 0; } .pool span { flex: 1; text-transform: capitalize; } .faint { font-size: 12px; }
</style>
