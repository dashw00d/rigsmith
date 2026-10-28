<script lang="ts">
  // The Ship step (DESIGN.md §5 #7): the character as a game unit and its way into the game. Its unit (made here as a
  // draft; height with the scale room, budget, levels, the clips the game plays, draft, companion), its seat when it
  // rides (Mount), the checks the game's rules make before an export, Export to the game (a job: the unit's entry into
  // the game's units.json, then its build, put back as it was if the build fails or is cancelled), the last build and
  // the game repo it all goes to. Units live in Rigsmith's own list (src/state/ship.svelte.ts); the seat is the
  // character's mount (src/state/mount.svelte.ts).
  import { untrack } from 'svelte'
  import { FolderGit2, Gamepad2, LoaderCircle, Plus, Send } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { ship } from '../../state/ship.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import Section from '../../ui/Section.svelte'
  import TextField from '../../ui/TextField.svelte'
  import BuildRecord from '../ship/BuildRecord.svelte'
  import Checks from '../ship/Checks.svelte'
  import MountEditor from '../ship/MountEditor.svelte'
  import UnitCard from '../ship/UnitCard.svelte'
  import { unitNameOf } from '../ship/text.ts'

  let { character }: { character: Character } = $props()

  // (read again whenever the game's units change: load() and build() read app.gameBeat)
  $effect(() => { void ship.load() })
  const rows = $derived(ship.unitsOf(character.id))
  $effect(() => { for (const r of rows) void ship.build(r.name) })

  // ---- making a unit (its name first offered from the character's) ----
  const characterId = $derived(character.id)
  let newName = $state('')
  $effect(() => { void characterId; newName = untrack(() => unitNameOf(character.name)) })
  let making = $state(false)
  async function make (): Promise<void> {
    making = true
    try {
      await ship.create(character, newName)
    } finally {
      making = false
    }
  }

  // ---- the game repo ----
  const repo = $derived(app.settings?.gameRepo ?? '')
  let editingRepo = $state(false)
  let repoDraft = $state('')
  async function saveRepo (value: string): Promise<void> {
    const next = value.trim()
    editingRepo = false
    if (next === '' || next === repo) return
    try {
      await app.saveSettings({ gameRepo: next })
      app.gameBeat++
    } catch (error) {
      app.toast('error', `Not saved: ${(error as Error).message}`)
    }
  }
</script>

{#if ship.status === null}
  <Section>
    {#if ship.error !== null}
      <p class="error small">Couldn't read the game's units: {ship.error}</p>
      <Button size="sm" onclick={() => { app.gameBeat++ }}>Try again</Button>
    {:else}
      <p class="faint small"><LoaderCircle size={12} class="spin" /> Reading the game's units…</p>
    {/if}
  </Section>
{:else}
  {#if rows.length === 0}
    <Section title="Game unit">
      <EmptyState compact icon={Gamepad2} title="Not a game unit" body="Make {character.name} one: a draft the game builds only once you export it." />
      <div class="make">
        <TextField bind:value={newName} placeholder="unit name, e.g. knight" label="Unit name" size="sm" mono />
        <Button size="sm" variant="primary" loading={making} disabled={unitNameOf(newName) === ''} onclick={make}><Plus size={13} /> Make it a unit</Button>
      </div>
    </Section>
  {/if}

  {#each rows as row (row.name)}
    <Section title={row.role === 'unit' ? 'Game unit' : 'Companion'}>
      <UnitCard {character} {row} />
    </Section>
  {/each}

  {#if character.skeleton.template === 'human'}
    <Section title="Mount">
      <MountEditor {character} />
    </Section>
  {/if}

  {#each rows as row (row.name)}
    {@const checks = ship.checks(row.name)}
    {@const job = ship.jobOf(row.name)}
    {@const other = ship.exporting}
    <Section title={rows.length > 1 ? `Checks · ${row.name}` : 'Checks'}>
      <Checks {checks} />
    </Section>
    <Section title={rows.length > 1 ? `Export · ${row.name}` : 'Export'}>
      {#if job === null}
        <Button variant="primary" block disabled={repo === ''} onclick={() => ship.export(row.name, checks)}><Send size={14} /> Export {row.name} to the game</Button>
        {#if other !== null}<p class="faint small">Another export is running ({other.label}): this one waits for it.</p>{/if}
      {:else}
        <div class="job" role="status">
          <div class="bar"><span style="width: {Math.round((job.status === 'queued' ? 0 : job.progress) * 100)}%"></span></div>
          <div class="line">
            <span class="message">{job.status === 'queued' ? 'Waiting for the export before it' : job.message || 'Exporting'}</span>
            <Button size="sm" variant="ghost" onclick={() => ship.cancel(row.name)}>Cancel</Button>
          </div>
        </div>
      {/if}
      <p class="faint small">Writes {row.name}'s entry into the game's units.json, then runs the game's build for it (model, maps, the holds
        check). If the build fails or is cancelled, units.json goes back as it was. Then re-import in Godot.</p>
      <BuildRecord unit={row.name} view={ship.builds[row.name]} />
    </Section>
  {/each}

  <Section title="Game repo">
    <div class="repo">
      <FolderGit2 size={14} />
      {#if editingRepo}
        <TextField bind:value={repoDraft} oncommit={saveRepo} label="Game repo" placeholder="~/dev/games/emberhold" size="sm" mono autoselect />
        <Button size="sm" variant="ghost" onclick={() => { editingRepo = false }}>Done</Button>
      {:else}
        <span class="mono path">{repo === '' ? 'not set' : repo}</span>
        <Button size="sm" variant="ghost" onclick={() => { repoDraft = repo; editingRepo = true }}>Change</Button>
      {/if}
    </div>
    <p class="faint small">The game's folder (Emberhold): Export writes its units and runs its build there; the scale room reads its models.</p>
  </Section>
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .error { color: var(--danger); }
  .make { display: flex; gap: 6px; align-items: center; }
  .make > :global(:first-child) { flex: 1; }
  .job { display: flex; flex-direction: column; gap: 6px; }
  .bar { height: 4px; border-radius: 2px; background: var(--bg-0); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.2s; }
  .line { display: flex; align-items: center; gap: 8px; }
  .message { flex: 1; font-size: 12px; color: var(--text-2); overflow-wrap: anywhere; }
  .repo { display: flex; align-items: center; gap: 6px; color: var(--text-2); }
  .repo > :global(:nth-child(2)) { flex: 1; }
  .path { font-size: 11.5px; word-break: break-all; }
  :global(.spin) { animation: spin 1s linear infinite; vertical-align: -2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
