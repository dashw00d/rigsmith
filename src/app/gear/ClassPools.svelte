<script lang="ts">
  import type { Character, Pool, PoolItem, UnitKind } from '../../model/types.ts'
  import { kindsOf, poolsOf } from '../../model/folk.ts'
  import { app } from '../../state/app.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Note from '../../ui/Note.svelte'
  import NumberField from '../../ui/NumberField.svelte'
  import Select from '../../ui/Select.svelte'
  import { copyPoolFor, usePool } from '../classes/edit.ts'

  let { character, kind }: { character: Character, kind: UnitKind } = $props()
  const steps = ['skin', 'bottom', 'top', 'over', 'hair', 'beard', 'accessory']
  let expanded = $state<string[]>([])
  function options (step: string): Pool[] {
    return poolsOf(character).filter(p => p.kind === (['bottom', 'top', 'over'].includes(step) ? 'cloth' : step) && (p.kind !== 'cloth' || p.slot === undefined || p.slot === step))
  }
  function selected (k: UnitKind, step: string): Pool | undefined {
    const list = options(step)
    return k.pools?.[step] === undefined ? list[0] : list.find(p => p.id === k.pools![step])
  }
  function candidates (pool: Pool): Array<{ ref: string, name: string }> {
    if (pool.kind === 'skin') return (character.look.skins ?? []).map(s => ({ ref: s.name, name: s.name }))
    if (pool.kind === 'cloth') return (character.look.cloth ?? []).filter(l => !pool.slot || l.slots.includes(pool.slot)).map(l => ({ ref: l.id, name: l.name }))
    return character.gear.filter(g => pool.kind === 'accessory' ? g.role !== 'hair' && g.role !== 'beard' : g.role === pool.kind).map(g => ({ ref: g.id, name: g.name }))
  }
  function shared (pool: Pool): string[] {
    return kindsOf(character).filter(k => k.id !== kind.id && steps.some(step => selected(k, step)?.id === pool.id)).map(k => k.name)
  }
  function items (pool: Pool, next: PoolItem[]): void { void app.do(character.id, { type: 'folk.pool.items', id: pool.id, items: next }) }
  function toggle (pool: Pool, ref: string, checked: boolean): void {
    items(pool, checked ? [...pool.items, { ref }] : pool.items.filter(item => item.ref !== ref))
  }
  function weight (pool: Pool, ref: string, value: number): void {
    items(pool, pool.items.map(item => item.ref === ref ? { ...item, weight: value } : item))
  }
</script>
{#each steps as step (step)}
  {@const pool = selected(kind, step)}
  <div class="pool" data-testid="class-pool-{step}">
    <div class="line">
      <span>{step}</span>
      <Select label="{step} pool" value={kind.pools?.[step] ?? ''} options={[{ value: '', label: 'Default' }, ...options(step).map(p => ({ value: p.id, label: `${p.name} (${p.items.length})` }))]} onchange={(v) => { void app.do(character.id, usePool(kind, step, v || null)) }} />
      {#if pool}<Button size="sm" data-testid="class-pool-expand-{step}" aria-expanded={expanded.includes(step)} onclick={() => { expanded = expanded.includes(step) ? expanded.filter(x => x !== step) : [...expanded, step] }}>Edit</Button>{/if}
    </div>
    {#if pool && expanded.includes(step)}
      {@const users = shared(pool)}
      {#if users.length}<Note>Shared with {users.join(', ')}. <Button size="sm" onclick={() => { void app.do(character.id, copyPoolFor(character, kind, pool.id)) }}>Make a copy for {kind.name}</Button></Note>{/if}
      {#each candidates(pool) as item (item.ref)}
        {@const selectedItem = pool.items.find(x => x.ref === item.ref)}
        <div class="item">
          <label><input type="checkbox" data-testid="class-pool-item" data-id={item.ref} checked={selectedItem !== undefined} onchange={e => toggle(pool, item.ref, e.currentTarget.checked)} /> {item.name}</label>
          {#if selectedItem}<NumberField label="Weight for {item.name}" value={selectedItem.weight ?? 1} min={0} max={10} step={0.1} onchange={v => weight(pool, item.ref, v)} />{/if}
        </div>
      {/each}
    {/if}
  </div>
{/each}
<style>
  .pool { display: grid; gap: 6px; } .line, .item { display: flex; align-items: center; gap: 6px; } .line span, .item label { flex: 1; } .line span { text-transform: capitalize; }
</style>
