<script lang="ts">
  // What happened and what is working, in one place (over the right side): the selected character's journal, newest
  // first (who, when, what; Undo on what can be taken back, Redo on an undo; a note anyone can leave, the app or a tool),
  // and every background job (progress, cancel, what went wrong, a click shows its character).
  import { untrack } from 'svelte'
  import { CircleAlert, CircleCheck, CircleX, Clock, LoaderCircle, Redo2, Send, Undo2 } from '@lucide/svelte'
  import { api, ApiError, type Job, type JournalEntry } from '../state/api.ts'
  import { app } from '../state/app.svelte.ts'
  import Button from '../ui/Button.svelte'
  import Drawer from '../ui/Drawer.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import Tabs from '../ui/Tabs.svelte'
  import TextField from '../ui/TextField.svelte'
  import { ago, clock, entityLabel, reversal, who } from './activity.ts'

  type Tab = 'history' | 'jobs'
  const TAB_KEY = 'rigsmith.activity'
  let tab = $state<Tab>(localStorage.getItem(TAB_KEY) === 'jobs' ? 'jobs' : 'history')
  $effect(() => { localStorage.setItem(TAB_KEY, tab) })

  const character = $derived(app.selected)
  // (only a change of character fetches the journal again, not each new copy of it)
  const characterId = $derived(app.selected?.id ?? null)
  const running = $derived(app.activeJobs.length)

  // ---- the journal ----

  const PAGE = 40
  let entries = $state.raw<JournalEntry[]>([])
  let loadedFor = $state<string | null>(null)
  let loadError = $state<string | null>(null)
  let shown = $state(PAGE)
  // (the entry being taken back, and why the last one wasn't)
  let undoing = $state<number | null>(null)
  let refused = $state<{ seq: number, text: string } | null>(null)
  let note = $state('')
  let sending = $state(false)

  $effect(() => {
    const id = characterId
    void app.journalBeat
    if (id === null) { entries = []; loadedFor = null; return }
    untrack(() => {
      if (loadedFor !== id) { entries = []; shown = PAGE; refused = null; loadError = null }
    })
    void api.journal(id, 300).then(list => {
      if (untrack(() => characterId) !== id) return
      entries = [...list].reverse()
      loadedFor = id
      loadError = null
    }, (error: unknown) => {
      if (untrack(() => characterId) === id) loadError = (error as Error).message
    })
  })

  async function takeBack (e: JournalEntry): Promise<void> {
    const c = character
    if (c === null || undoing !== null) return
    undoing = e.seq
    refused = null
    try {
      const { character: next, entry } = await api.undo(c.id, e.seq)
      app.upsert(next, entry)
    } catch (error) {
      const conflicts = error instanceof ApiError ? (error.body as { conflicts?: unknown } | null)?.conflicts : undefined
      const text = Array.isArray(conflicts) && conflicts.length > 0
        ? `Not taken back: ${conflicts.map(k => entityLabel(c, String(k))).join(', ')} changed since. Undo those changes first.`
        : `Not taken back: ${(error as Error).message}`
      refused = { seq: e.seq, text }
    } finally {
      undoing = null
    }
  }

  async function send (): Promise<void> {
    const c = character
    const text = note.trim()
    if (c === null || text === '' || sending) return
    sending = true
    try {
      await api.addNote(c.id, text)
      note = ''
    } catch (error) {
      app.toast('error', `The note wasn't kept: ${(error as Error).message}`)
    } finally {
      sending = false
    }
  }

  // ---- jobs ----

  // (the 'ago' times move on while the drawer is open)
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => { now = Date.now() }, 5000)
    return () => { clearInterval(timer) }
  })

  const nameOf = (id: string | undefined): string | null => (id === undefined ? null : app.byId(id)?.name ?? null)
  const live = (j: Job): boolean => j.status === 'queued' || j.status === 'running'

  async function show (j: Job): Promise<void> {
    if (j.characterId === undefined || app.byId(j.characterId) === null) return
    await app.select(j.characterId)
  }
</script>

<Drawer open side="right" title="Activity" width="min(380px, 94%)" scrim={false} onclose={() => { app.drawer = null }}>
  <div class="tabs">
    <Tabs size="sm" label="Activity" bind:value={tab} tabs={[
      { id: 'history', label: 'History' },
      { id: 'jobs', label: 'Jobs', count: running > 0 ? running : undefined },
    ]} />
  </div>

  {#if tab === 'history'}
    {#if character === null}
      <EmptyState compact title="No character" body="Pick a character to see what was done to it." />
    {:else}
      <p class="whose">{character.name}'s history</p>
      <form class="note" onsubmit={(e) => { e.preventDefault(); void send() }}>
        <TextField size="sm" bind:value={note} label="A note in its history" placeholder="A note in its history" maxlength={4000} disabled={sending} />
        <Button size="sm" type="submit" disabled={note.trim() === '' || sending} loading={sending} aria-label="Add the note"><Send size={12} /></Button>
      </form>
      {#if loadError !== null}
        <p class="problem">Its history didn't load: {loadError}</p>
      {:else if loadedFor === character.id && entries.length === 0}
        <p class="faint small">Nothing yet. Changes show here as they are made, here or by a tool.</p>
      {:else}
        <ul class="journal">
          {#each entries.slice(0, shown) as e (e.seq)}
            {@const back = reversal(e)}
            <li class:note={e.note === true} class:undone={e.undoneBy !== undefined}>
              <div class="meta">
                <span class="who" class:tool={e.by !== 'app'}>{who(e.by)}</span>
                <span class="faint mono">{clock(e.at, new Date(now))}</span>
                {#if e.undoneBy !== undefined}<span class="tag">taken back</span>{/if}
                {#if back !== null}
                  <button class="back" disabled={undoing !== null} onclick={() => takeBack(e)} aria-label="{back === 'undo' ? 'Undo' : 'Redo'}: {e.changes[0] ?? e.what}">
                    {#if undoing === e.seq}<LoaderCircle size={12} class="spin" />{:else if back === 'undo'}<Undo2 size={12} />{:else}<Redo2 size={12} />{/if}
                    {back === 'undo' ? 'Undo' : 'Redo'}
                  </button>
                {/if}
              </div>
              {#each e.changes as line, i (i)}<div class="change">{line}</div>{/each}
              {#if e.changes.length === 0}<div class="change faint">{e.what}</div>{/if}
              {#if refused?.seq === e.seq}<div class="problem" role="alert">{refused.text}</div>{/if}
            </li>
          {/each}
        </ul>
        {#if entries.length > shown}<button class="more" onclick={() => { shown += PAGE * 2 }}>Show older ({entries.length - shown} more)</button>{/if}
      {/if}
    {/if}
  {:else}
    {#if app.jobs.length === 0}
      <EmptyState compact title="No jobs yet" body="Imports, rigs, texture work and exports run here, in the background." />
    {:else}
      <ul class="jobs">
        {#each app.jobs as j (j.id)}
          {@const owner = nameOf(j.characterId)}
          <li class:failed={j.status === 'failed'}>
            <span class="icon {j.status}">
              {#if j.status === 'running'}<LoaderCircle size={14} class="spin" />
              {:else if j.status === 'queued'}<Clock size={14} />
              {:else if j.status === 'done'}<CircleCheck size={14} />
              {:else if j.status === 'cancelled'}<CircleX size={14} />
              {:else}<CircleAlert size={14} />{/if}
            </span>
            <div class="text">
              <div class="label">
                {#if owner !== null}
                  <button class="link" onclick={() => show(j)} aria-label="Show {owner}">{j.label}</button>
                {:else}{j.label}{/if}
              </div>
              <div class="msg faint" class:error={j.status === 'failed'}>
                {j.status === 'failed' ? j.error ?? j.message : j.message} · {ago(j.finishedAt ?? j.createdAt, now)}
              </div>
              {#if j.status === 'running'}<div class="bar"><div style:width="{Math.round(j.progress * 100)}%"></div></div>{/if}
            </div>
            {#if live(j)}
              <Button size="sm" variant="ghost" disabled={j.message === 'Cancelling'} onclick={() => app.cancelJob(j.id)}>Cancel</Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</Drawer>

<style>
  .tabs { padding: 8px 12px 0; position: sticky; top: 0; background: var(--bg-1); z-index: 1; }
  .whose { margin: 10px 16px 0; font-size: 12px; font-weight: 600; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { display: flex; gap: 6px; padding: 6px 12px 6px; }
  .small { font-size: 12px; margin: 8px 16px; }
  .problem { margin: 4px 0 0; font-size: 12px; color: var(--danger); overflow-wrap: anywhere; }
  p.problem { margin: 8px 16px; }
  ul { list-style: none; margin: 0; padding: 6px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
  .journal li { font-size: 12px; border-left: 2px solid var(--line-strong); padding-left: 8px; }
  .journal li.note { border-left-color: var(--accent); }
  .journal li.undone .change { color: var(--text-3); text-decoration: line-through; text-decoration-color: var(--text-4); }
  .meta { display: flex; gap: 8px; align-items: center; margin-bottom: 2px; min-height: 20px; }
  .who { font-weight: 600; color: var(--text-2); }
  .who.tool { color: var(--accent-strong); }
  .mono { font-size: 11px; }
  .tag { font-size: 10.5px; color: var(--text-3); background: var(--bg-3); border-radius: 6px; padding: 0 6px; }
  .back { margin-left: auto; display: flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--bg-2); color: var(--text-2); font-size: 11px; }
  .back:hover:not(:disabled) { color: var(--text-1); border-color: var(--accent); }
  .back:disabled { opacity: 0.5; }
  .change { color: var(--text-2); overflow-wrap: anywhere; }
  .more { margin: 0 16px 14px; border: 0; background: transparent; color: var(--accent-strong); padding: 0; font-size: 12px; }
  .jobs { gap: 2px; padding: 6px 8px 12px; }
  .jobs li { display: flex; gap: 10px; align-items: flex-start; padding: 8px; border-radius: var(--r-1); }
  .jobs li:hover { background: var(--bg-2); }
  .icon { padding-top: 1px; color: var(--text-3); }
  .icon.running { color: var(--accent); }
  .icon.done { color: var(--ok); }
  .icon.failed { color: var(--danger); }
  .text { flex: 1; min-width: 0; }
  .label { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link { border: 0; padding: 0; background: transparent; font-weight: 500; text-align: left; }
  .link:hover { color: var(--accent-strong); text-decoration: underline; }
  .msg { font-size: 11.5px; overflow-wrap: anywhere; }
  .msg.error { color: var(--danger); }
  .bar { margin-top: 6px; height: 3px; background: var(--bg-4); border-radius: 2px; overflow: hidden; }
  .bar div { height: 100%; background: var(--accent); transition: width var(--med); }
</style>
