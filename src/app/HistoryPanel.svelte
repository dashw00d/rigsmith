<script lang="ts">
  // The character's journal (server/journal.ts): every change, made here or by a tool (an agent's), in plain words,
  // newest first; and a note anyone can leave for the other.
  import { History, Send } from '@lucide/svelte'
  import type { Character, JournalEntry } from '../state/api.ts'
  import { api } from '../state/api.ts'
  import { app } from '../state/app.svelte.ts'
  import Section from '../ui/Section.svelte'

  let { character }: { character: Character } = $props()

  let open = $state(localStorage.getItem('rigsmith.history') === 'open')
  let entries = $state<JournalEntry[]>([])
  let text = $state('')
  let showAll = $state(false)

  $effect(() => {
    void character.updatedAt; void app.journalBeat
    const id = character.id
    if (!open) return
    void api.journal(id, 300).then(e => { if (id === character.id) entries = e.reverse() })
  })

  function toggle (): void {
    open = !open
    localStorage.setItem('rigsmith.history', open ? 'open' : 'closed')
  }
  async function send (): Promise<void> {
    const note = text.trim()
    if (note === '') return
    text = ''
    await api.addNote(character.id, note)
  }
  const when = (at: string): string => {
    const d = new Date(at)
    const today = new Date().toDateString() === d.toDateString()
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const shown = $derived(showAll ? entries : entries.slice(0, 25))
</script>

<Section>
  <button class="head" onclick={toggle} aria-expanded={open}><History size={12} /> History <span class="faint">{open ? '−' : '+'}</span></button>
  {#if open}
    <form class="note" onsubmit={(e) => { e.preventDefault(); void send() }}>
      <input bind:value={text} placeholder="A note in the history (for the agent, or yourself)" aria-label="Note" />
      <button type="submit" class="icon" disabled={text.trim() === ''} aria-label="Add note"><Send size={12} /></button>
    </form>
    {#if entries.length === 0}
      <p class="faint small">Nothing yet: changes show here as they are made, here or by a tool.</p>
    {:else}
      <ul>
        {#each shown as e (e.at + e.by + e.changes[0])}
          <li class:note={e.note === true}>
            <div class="meta"><span class="who" class:agent={e.by !== 'app'}>{e.by === 'app' ? 'you' : e.by}</span><span class="faint mono">{when(e.at)}</span></div>
            {#each e.changes as c}<div class="change">{c}</div>{/each}
          </li>
        {/each}
      </ul>
      {#if entries.length > shown.length}<button class="link" onclick={() => { showAll = true }}>Show all {entries.length}</button>{/if}
    {/if}
  {/if}
</Section>

<style>
  .head { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-3); }
  .note { display: flex; gap: 4px; }
  .note input { flex: 1; height: 26px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 12px; padding: 0 6px; }
  .icon { width: 26px; height: 26px; border: 1px solid var(--line-strong); border-radius: 5px; background: var(--bg-2); color: var(--text-2); display: grid; place-items: center; }
  .icon:disabled { opacity: 0.4; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow-y: auto; }
  li { font-size: 12px; border-left: 2px solid var(--line-strong); padding-left: 6px; }
  li.note { border-left-color: var(--accent); }
  .meta { display: flex; gap: 8px; align-items: baseline; margin-bottom: 2px; }
  .who { font-weight: 600; color: var(--text-2); }
  .who.agent { color: var(--accent-strong); }
  .mono { font-size: 11px; }
  .change { color: var(--text-2); overflow-wrap: anywhere; }
  .small { font-size: 12px; margin: 0; }
  .link { border: 0; background: transparent; color: var(--accent-strong); padding: 0; font-size: 12px; align-self: flex-start; }
</style>
