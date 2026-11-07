<script lang="ts">
  // The Forge (docs/dressing-plan.md Phase 4), over the workspace while it is open: a set's items through its
  // pipeline, a column a stage and a card an item, each card's attempts and what it waits for; a batch run (every item
  // through to the first gate), publish, and the queue. Keys: J/K items, H/L (or the arrows) stages, 1-4 pick, R run,
  // A approve, Q the queue.
  import { Anvil, ListOrdered, Plus, Send, FastForward } from '@lucide/svelte'
  import { forge } from '../../state/forge.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import Select from '../../ui/Select.svelte'
  import TextField from '../../ui/TextField.svelte'
  import PickGate from './PickGate.svelte'
  import QueueDrawer from './QueueDrawer.svelte'
  import StageColumn from './StageColumn.svelte'

  const board = $derived(forge.board)
  const set = $derived(forge.set)
  const pipeline = $derived(forge.pipeline)
  const pipelines = $derived(Object.values(board?.config?.pipelines ?? {}))
  const active = $derived((board?.queue ?? []).filter(j => j.status === 'queued' || j.status === 'running').length)

  let making = $state(false)
  let setName = $state('')
  let setPipeline = $state<string | null>(null)
  let itemName = $state('')
  let itemSpec = $state('')
  let picking = $state<{ item: string, stage: string } | null>(null)

  async function makeSet (): Promise<void> {
    const p = setPipeline ?? pipelines[0]?.id
    if (setName.trim() === '' || p === undefined) return
    await forge.createSet(setName.trim(), p)
    setName = ''
    making = false
  }

  async function addItem (): Promise<void> {
    if (itemName.trim() === '') return
    let spec: Record<string, unknown> = {}
    if (itemSpec.trim() !== '') {
      try { spec = JSON.parse(itemSpec) as Record<string, unknown> } catch { return }
    }
    await forge.addItem(itemName.trim(), spec)
    itemName = ''
    itemSpec = ''
  }

  const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

  function onkeydown (e: KeyboardEvent): void {
    if (!forge.open || picking !== null || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return
    const k = e.key.toLowerCase()
    const act = (fn: () => void): void => { e.preventDefault(); fn() }
    if (k === 'j' || e.key === 'ArrowDown') act(() => { forge.move(1, 0) })
    else if (k === 'k' || e.key === 'ArrowUp') act(() => { forge.move(-1, 0) })
    else if (k === 'l' || e.key === 'ArrowRight') act(() => { forge.move(0, 1) })
    else if (k === 'h' || e.key === 'ArrowLeft') act(() => { forge.move(0, -1) })
    else if (/^[1-4]$/.test(e.key)) act(() => { void forge.pickNth(Number(e.key)) })
    else if (k === 'r') act(() => { void forge.runFocused() })
    else if (k === 'a') act(() => { void forge.approveFocused() })
    else if (k === 'q') act(() => { forge.queueOpen = !forge.queueOpen })
  }
</script>

<svelte:window {onkeydown} />

<div class="forge" role="region" aria-label="Forge">
  <header>
    <span class="title"><Anvil size={15} /> Forge</span>
    {#if board?.config}
      {#if (board.sets.length ?? 0) > 0}
        <Select size="sm" label="Set" width="200px" value={set?.id ?? null}
          options={board.sets.map(s => ({ value: s.id, label: `${s.name} (${s.items.length})`, group: board.config?.pipelines[s.pipeline]?.label ?? s.pipeline }))}
          onchange={(v) => { forge.setId = v; forge.focus = null }} />
      {/if}
      {#if making}
        <span class="form">
          <TextField size="sm" label="Set name" placeholder="Gael hats" bind:value={setName} oncommit={() => { void makeSet() }} autoselect />
          <Select size="sm" label="Pipeline" value={setPipeline ?? pipelines[0]?.id ?? null} options={pipelines.map(p => ({ value: p.id, label: p.label }))} onchange={(v) => { setPipeline = v }} />
          <Button size="sm" variant="primary" onclick={() => { void makeSet() }}>Make</Button>
          <Button size="sm" variant="ghost" onclick={() => { making = false }}>Cancel</Button>
        </span>
      {:else}
        <Button size="sm" variant="ghost" onclick={() => { making = true }}><Plus size={14} /> New set</Button>
      {/if}
      <span class="grow"></span>
      {#if set !== null && pipeline !== null}
        <Button size="sm" onclick={() => { void forge.runAll(pipeline.stages[0].id) }} disabled={set.items.length === 0}
          title="Every item's {pipeline.stages[0].label}, then on to the first gate"><FastForward size={14} /> Run all to the gate</Button>
        <Button size="sm" onclick={() => { void forge.publish() }} disabled={set.items.length === 0}
          title="The finished items into the game and the character"><Send size={14} /> Publish</Button>
      {/if}
    {/if}
    <Button size="sm" variant={forge.queueOpen ? 'secondary' : 'ghost'} onclick={() => { forge.queueOpen = !forge.queueOpen }}>
      <ListOrdered size={14} /> Queue{active > 0 ? ` (${active})` : ''}
    </Button>
  </header>

  {#if forge.error !== null && !board?.config}
    <EmptyState icon={Anvil} title="No Forge for this game" body={forge.error} />
    {#if board?.problems}<ul class="problems">{#each board.problems as p (p)}<li>{p}</li>{/each}</ul>{/if}
  {:else if board === null}
    <div class="grow"></div>
  {:else if set === null}
    <EmptyState icon={Anvil} title="No sets yet" body="A set is a batch of items made the same way: ten Gael hats, the Norse boots." />
  {:else if pipeline === null}
    <EmptyState icon={Anvil} title="Its pipeline is gone" body="The game's forge.json no longer has the {set.pipeline} pipeline." />
  {:else}
    <div class="add">
      <TextField size="sm" label="New {pipeline.item}" placeholder="New {pipeline.item}" bind:value={itemName} oncommit={() => { void addItem() }} />
      <TextField size="sm" label="Its spec (JSON)" placeholder={'{"culture": "Gaels", "pieces": {"HAT": "..."}}'} mono bind:value={itemSpec} />
      <Button size="sm" onclick={() => { void addItem() }} disabled={itemName.trim() === ''}><Plus size={14} /> Add</Button>
    </div>
    {#if set.items.length === 0}
      <EmptyState compact title="No {pipeline.item}s in {set.name} yet" body="Add one above: its spec is what the stages are given." />
    {:else}
      <div class="columns">
        {#each pipeline.stages as stage, i (stage.id)}
          <StageColumn {set} {stage} index={i} onpick={(item, st) => { picking = { item, stage: st } }} />
        {/each}
      </div>
    {/if}
  {/if}

  {#if picking !== null && set !== null}
    <PickGate {set} item={picking.item} stage={picking.stage} onclose={() => { picking = null }} />
  {/if}
  <QueueDrawer />
</div>

<style>
  .forge { position: absolute; inset: 0; z-index: 30; display: flex; flex-direction: column; min-height: 0; background: var(--bg-0); }
  header { flex: none; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--line); background: var(--bg-1); }
  .title { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; font-size: 13px; margin-right: 6px; }
  .form { display: inline-flex; align-items: center; gap: 6px; }
  .grow { flex: 1; }
  .add { flex: none; display: grid; grid-template-columns: 200px minmax(0, 420px) auto; gap: 6px; padding: 10px 12px 0; }
  .columns { flex: 1; min-height: 0; display: flex; gap: 10px; padding: 10px 12px 0; overflow-x: auto; }
  .problems { margin: 0 auto; max-width: 640px; color: var(--warn); font-size: 12px; }
</style>
