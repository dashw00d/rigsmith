<script lang="ts">
  // In the game: the unit this character is (Rigsmith's own list, server/game.ts), edited here and saved at once, and
  // Export, the one way Rigsmith writes into the game's repo (the unit's entry in its units.json, then its build).
  import { CircleCheck, Gamepad2, Plus, Send, X } from '@lucide/svelte'
  import { api, type Character, type GameStatus, type UnitSpec } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let { character }: { character: Character } = $props()

  let status = $state<GameStatus | null>(null)
  let newName = $state('')
  let newClip = $state('')
  $effect(() => { void app.gameBeat; void character.id; void api.game().then(s => { status = s }) })

  // the units it is: as the unit, or the companion (a horse) of each
  const mine = $derived(status === null ? [] : Object.entries(status.units).filter(([, u]) => u.ours !== null && (u.ours.character === character.id || u.ours.companion?.character === character.id)))
  const job = $derived(app.jobs.find(j => j.kind === 'export' && (j.status === 'queued' || j.status === 'running')) ?? null)
  const lastJob = $derived(app.jobs.find(j => j.kind === 'export' && (j.status === 'done' || j.status === 'failed')) ?? null)

  async function save (name: string, entry: UnitSpec | null): Promise<void> {
    try { status = await api.putUnit(name, entry) } catch (error) { app.toast('error', (error as Error).message) }
  }
  function patch (name: string, change: Partial<UnitSpec>): void {
    const u = status?.units[name]?.ours
    if (u == null) return
    const next: UnitSpec = { ...u, ...change }
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete (next as Record<string, unknown>)[k]
    void save(name, next)
  }
  async function create (): Promise<void> {
    const name = newName.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    if (name === '' || status?.units[name]?.ours != null) { app.toast('error', name === '' ? 'Name the unit' : `There is a unit ${name} already`); return }
    await save(name, { character: character.id, height: 2.0, budget: 8000, tex: 1024, draft: true, clips: ['Idle', 'Walk', 'Run', 'Attack', 'Die'] })
    newName = ''
  }
  async function exportUnit (name: string): Promise<void> {
    try { await api.exportUnits([name]) } catch (error) { app.toast('error', (error as Error).message) }
  }
  const num = (e: Event): number => Number((e.target as HTMLInputElement).value)
</script>

<Section title="In the game">
  {#if status === null}
    <p class="faint small">Reading the units…</p>
  {:else if mine.length === 0}
    <p class="faint small">{character.name} isn't a game unit. Make it one (a draft: in the game only when you export it):</p>
    <div class="row">
      <input placeholder="unit name, e.g. knight" bind:value={newName} onkeydown={(e) => { if (e.key === 'Enter') void create() }} aria-label="Unit name" />
      <Button size="sm" onclick={create}><Plus size={13} /> Make it a unit</Button>
    </div>
  {:else}
    {#each mine as [name, u] (name)}
      {@const ours = u.ours!}
      {@const asUnit = ours.character === character.id}
      <div class="unit">
        <div class="head">
          <Gamepad2 size={14} />
          <strong class="mono">{name}</strong>
          <span class="faint">{asUnit ? '' : `· its ${ours.companion?.prefix?.replace(/_$/, '').toLowerCase() ?? 'companion'}`}</span>
          <span class="state" class:changed={u.differs}>{u.game === null ? 'not in the game yet' : u.differs ? 'changed here' : 'as in the game'}</span>
        </div>
        {#if asUnit}
          <div class="grid">
            <label use:tooltip={'Its height in the game (metres, soles to the top of the head)'}>Height <input type="number" step="0.05" value={ours.height} onchange={(e) => patch(name, { height: num(e) })} /></label>
            <label use:tooltip={'Its triangle budget (the nearest level of detail; the export simplifies past it)'}>Budget <input type="number" step="100" value={ours.budget} onchange={(e) => patch(name, { budget: num(e) })} /></label>
          </div>
          <div class="clips">
            <span class="faint small">Plays</span>
            {#each ours.clips as clip (clip)}
              <span class="chip">{clip}<button class="x" onclick={() => patch(name, { clips: ours.clips.filter(c => c !== clip) })} aria-label="Drop {clip}"><X size={10} /></button></span>
            {/each}
            <input class="add" placeholder="+ clip" bind:value={newClip} onkeydown={(e) => { if (e.key === 'Enter' && newClip.trim() !== '') { patch(name, { clips: [...ours.clips, newClip.trim()] }); newClip = '' } }} aria-label="Add a clip name" />
          </div>
          <Toggle label="Draft" hint="Built only when exported by name (the game's build skips it)" checked={ours.draft === true} onchange={(v) => patch(name, { draft: v ? true : undefined })} />
          {#if ours.companion}
            <div class="grid">
              <label>Rides / leads
                <select value={ours.companion.character} onchange={(e) => patch(name, { companion: { ...ours.companion!, character: (e.target as HTMLSelectElement).value } })}>
                  {#each app.characters.filter(c => c.template !== undefined && c.template !== 'human') as c}<option value={c.id}>{c.name}</option>{/each}
                </select>
              </label>
              <label>Its height <input type="number" step="0.05" value={ours.companion.height} onchange={(e) => patch(name, { companion: { ...ours.companion!, height: num(e) } })} /></label>
            </div>
          {/if}
        {/if}
        <Button variant="primary" block loading={job !== null} onclick={() => exportUnit(name)}>
          {#if job === null}<Send size={14} />{/if} {job !== null ? (job.message || 'Exporting') : `Export ${name} to the game`}
        </Button>
      </div>
    {/each}
    <p class="faint small">Changes here stay in Rigsmith. Export writes this unit into the game ({status.repo}): its entry in units.json, its model and maps, the holds check. Then open Godot to re-import.</p>
    {#if lastJob && job === null}
      <div class="done" class:failed={lastJob.status === 'failed'}><CircleCheck size={14} /><span>{lastJob.status === 'failed' ? lastJob.error : lastJob.message}</span></div>
    {/if}
  {/if}
</Section>

<style>
  .small { font-size: 12px; margin: 0; }
  .row { display: flex; gap: 6px; }
  .row input { flex: 1; }
  input, select { height: 26px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 12px; padding: 0 6px; }
  .unit { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: var(--r-2); background: var(--bg-0); }
  .head { display: flex; align-items: center; gap: 6px; }
  .state { margin-left: auto; font-size: 11px; color: var(--ok); }
  .state.changed { color: var(--warn); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .grid label { display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--text-3); }
  .grid input, .grid select { width: 100%; }
  .clips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 4px 0 8px; border-radius: 11px; border: 1px solid var(--line-strong); font-size: 11.5px; color: var(--text-2); }
  .x { border: 0; background: transparent; color: var(--text-4); display: grid; place-items: center; padding: 0; width: 14px; height: 14px; }
  .x:hover { color: var(--danger); }
  .add { width: 70px; height: 22px; border-radius: 11px; }
  .done { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: var(--ok); }
  .done.failed { color: var(--danger); }
  .done span { color: var(--text-2); overflow-wrap: anywhere; }
</style>
