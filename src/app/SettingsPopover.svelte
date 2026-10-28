<script lang="ts">
  // Settings: the game's repo, where Ship writes units (its tools/rigsmith/units.json and build). Saved once when it
  // changes (Enter, leaving the field, or closing this), then checked: whether the game's units are found there.
  import { onDestroy } from 'svelte'
  import { FolderGit2 } from '@lucide/svelte'
  import { api } from '../state/api.ts'
  import { app } from '../state/app.svelte.ts'
  import Popover from '../ui/Popover.svelte'
  import TextField from '../ui/TextField.svelte'

  let { onclose }: { onclose: () => void } = $props()

  let draft = $state(app.settings?.gameRepo ?? '')
  let saving = $state(false)
  let check = $state<{ ok: boolean, text: string } | null>(null)
  // (what was saved last: the same path again is not saved again)
  let saved = app.settings?.gameRepo ?? ''

  async function look (): Promise<void> {
    try {
      const game = await api.game()
      const units = Object.values(game.units).filter(u => u.game !== null).length
      check = units > 0
        ? { ok: true, text: `Found the game: ${units} ${units === 1 ? 'unit' : 'units'} in tools/rigsmith/units.json` }
        : { ok: false, text: `No game units there: is ${game.repo} the game's folder (with tools/rigsmith/units.json)?` }
    } catch (error) {
      check = { ok: false, text: `Couldn't read the game's units: ${(error as Error).message}` }
    }
  }

  async function save (value: string): Promise<void> {
    const next = value.trim()
    if (next === '') { check = { ok: false, text: 'Give the folder of the game\'s repo.' }; return }
    if (next === saved || saving) return
    saving = true
    try {
      await app.saveSettings({ gameRepo: next })
      saved = next
      draft = app.settings?.gameRepo ?? next
      app.gameBeat++
      await look()
    } catch (error) {
      check = { ok: false, text: `Not saved: ${(error as Error).message}` }
    } finally {
      saving = false
    }
  }

  void look()
  // (closed by a click outside before the field let go of the focus: the typing is still saved)
  onDestroy(() => { if (draft.trim() !== saved && draft.trim() !== '') void save(draft) })
</script>

<Popover {onclose} width={380} align="right">
  <div class="body">
    <div class="title"><FolderGit2 size={14} /> Game repo</div>
    <p class="faint">The game's folder (Emberhold). Ship writes its units and builds them there.</p>
    <TextField bind:value={draft} mono label="Game repo" placeholder="~/dev/games/emberhold" oncommit={save} disabled={saving} />
    {#if check !== null}<p class="check" class:bad={!check.ok} role="status">{check.text}</p>{/if}
  </div>
</Popover>

<style>
  .body { padding: 14px; display: flex; flex-direction: column; gap: 6px; }
  .title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  p { margin: 0 0 4px; font-size: 12px; }
  .check { margin: 2px 0 0; color: var(--ok); overflow-wrap: anywhere; }
  .check.bad { color: var(--warn); }
</style>
