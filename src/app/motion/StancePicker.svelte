<script lang="ts">
  import type { Character } from '../../model/types.ts'
  import { newId } from '../../model/ids.ts'
  import { folkOf } from '../../model/folk.ts'
  import { app } from '../../state/app.svelte.ts'
  import { stance } from '../../state/stance.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Select from '../../ui/Select.svelte'
  import TextField from '../../ui/TextField.svelte'
  import StanceSelect from './StanceSelect.svelte'
  let { character }: { character: Character } = $props()
  const id = $derived(stance.current(character.id))
  const current = $derived(folkOf(character).stances.find(s => s.id === id))
  let name = $state('')
  async function add (): Promise<void> {
    const n = name.trim()
    if (!n) return
    const next = newId()
    if (await app.do(character.id, { type: 'folk.stance.add', stance: { id: next, name: n, clips: {} } }) !== null) { stance.select(character.id, next); name = '' }
  }
</script>
<div class="picker">
  <StanceSelect {character} value={id} onchange={(next) => stance.select(character.id, next)} />
  <div class="new"><TextField label="New stance name" size="sm" bind:value={name} placeholder="New stance" oncommit={() => {}} /><Button size="sm" onclick={() => { void add() }} disabled={!name.trim()}>New</Button></div>
  {#if current !== undefined}
    <TextField label="Stance name" size="sm" value={current.name} oncommit={(name) => { void app.do(character.id, { type: 'folk.stance.update', id: current.id, patch: { name } }) }} />
    <Select label="Stance overlay" testid="motion-stance-overlay" options={[{ value: '', label: 'No overlay' }, ...character.clips.map(s => ({ value: s.id, label: s.name }))]} value={current.overlay ?? ''} onchange={(value) => { void app.do(character.id, { type: 'folk.stance.update', id: current.id, patch: { overlay: value || null } }) }} />
    <Button size="sm" variant="danger" onclick={async () => { if (await app.do(character.id, { type: 'folk.stance.remove', id: current.id }) !== null) stance.select(character.id, null) }}>Delete stance</Button>
  {/if}
</div>
<style>
  .picker { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
  .new { display: flex; gap: 4px; }
</style>
