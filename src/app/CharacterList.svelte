<script lang="ts">
  // The characters, always on the left: pick one, import more (the picker, or drop files anywhere), find one by name,
  // rename or delete one, rig every unrigged mesh at once. Each row says where the character stands (select.phaseOf,
  // with the job working on it).
  import { Pencil, Plus, Sparkles, Trash2, UserRound } from '@lucide/svelte'
  import { phaseOf } from '../model/select.ts'
  import type { Character } from '../state/api.ts'
  import { assets } from '../state/assets.svelte.ts'
  import { app } from '../state/app.svelte.ts'
  import Button from '../ui/Button.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import TextField from '../ui/TextField.svelte'
  import { tooltip } from '../ui/tooltip.ts'
  import { importFiles, removeCharacter, renameCharacter, rigEach } from './characters.ts'
  import { autoRiggable } from './status.ts'

  let input = $state<HTMLInputElement | null>(null)
  let query = $state('')

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? app.characters : app.characters.filter(c => c.name.toLowerCase().includes(q) || c.id.includes(q))
  })
  const riggable = $derived(app.characters.filter(c => autoRiggable(c, app.jobFor(c.id))))

  /** The character being renamed (its name field open in the list). */
  let renaming = $state<string | null>(null)
  let draft = $state('')
  function startRename (c: Character): void { renaming = c.id; draft = c.name }
  async function finishRename (c: Character, save: boolean): Promise<void> {
    if (renaming !== c.id) return
    renaming = null
    if (save) await renameCharacter(c, draft)
  }
  /** (the field takes the keys and is ready to type over) */
  function focusSelect (node: HTMLInputElement): void { node.focus(); node.select() }

  // Auto-rig all: how many were started and how many have finished, while a batch runs.
  let batch = $state<{ total: number, done: number } | null>(null)

  async function rigAll (): Promise<void> {
    const list = riggable
    const sure = await app.confirm({
      title: `Rig ${list.length} characters?`,
      body: `${list.map(c => c.name).join(', ')}.\n\nEach rigs in the background with the joints it has now; a few run at once.`,
      confirm: `Rig ${list.length}`,
    })
    if (!sure) return
    batch = { total: list.length, done: 0 }
    try {
      const { jobs, refused } = await rigEach(list)
      batch = { total: jobs.length, done: 0 }
      const failed: string[] = []
      await Promise.all(jobs.map(async ({ c, job }) => {
        const end = await app.jobDone(job.id)
        if (end.status !== 'done') failed.push(c.name)
        if (batch !== null) batch = { ...batch, done: batch.done + 1 }
      }))
      const rigged = jobs.length - failed.length
      const missed = [...refused, ...failed]
      if (missed.length === 0) app.toast('ok', `Rigged ${rigged} ${rigged === 1 ? 'character' : 'characters'}`)
      else app.toast('error', `Rigged ${rigged} of ${list.length}. Not rigged: ${missed.join(', ')}`)
    } finally {
      batch = null
    }
  }
</script>

<div class="list">
  <header>
    <h2>Characters <span class="count">{app.characters.length}</span></h2>
    <IconButton label="Import models" hint="Import models (or drop them anywhere)" onclick={() => input?.click()}><Plus size={15} /></IconButton>
    <input bind:this={input} type="file" multiple accept=".fbx,.glb,.gltf,.obj,.dae,.zip" hidden
      onchange={() => { if (input !== null) { void importFiles([...input.files ?? []]); input.value = '' } }} />
  </header>

  {#if app.characters.length > 0}
    <div class="search"><TextField testid="chars-search" type="search" size="sm" bind:value={query} placeholder="Find a character" label="Find a character" /></div>
  {/if}

  {#if app.characters.length === 0}
    <EmptyState icon={UserRound} title="Drop models anywhere" body="FBX, GLB, OBJ, DAE or a Tripo ZIP. Drop several at once: each imports in turn.">
      {#snippet action()}<Button size="sm" onclick={() => input?.click()}><Plus size={14} /> Import</Button>{/snippet}
    </EmptyState>
  {:else if shown.length === 0}
    <p class="none faint">No character's name has “{query.trim()}” in it.</p>
  {:else}
    <ul>
      {#each shown as c (c.id)}
        {@const job = app.jobFor(c.id)}
        {@const s = phaseOf(c, job)}
        <li class:selected={app.selectedId === c.id}>
          <button data-testid="chars-row" data-id={c.id} class="item" aria-current={app.selectedId === c.id ? 'true' : undefined} onclick={() => { void app.select(c.id) }}>
            <span class="thumb">
              {#if c.files.thumbnail}<img src={assets.thumbnail(c)} alt="" />{:else}<UserRound size={18} />{/if}
            </span>
            <span class="meta">
              <span class="name" ondblclick={(e) => { e.stopPropagation(); startRename(c) }} role="presentation">{c.name}</span>
              <span class="status {s.tone}" use:tooltip={s.tone === 'error' ? c.error ?? s.label : null}>
                {#if s.tone === 'busy'}<i class="pulse" aria-hidden="true"></i>{/if}
                <span>{s.label}</span>
              </span>
              {#if job?.status === 'running'}<span class="progress"><span style:width="{Math.round(job.progress * 100)}%"></span></span>{/if}
            </span>
          </button>
          {#if renaming === c.id}
            <input class="rename" bind:value={draft} use:focusSelect aria-label="Name of {c.name}"
              onkeydown={(e) => { if (e.key === 'Enter') void finishRename(c, true); else if (e.key === 'Escape') { e.preventDefault(); void finishRename(c, false) } }}
              onblur={() => finishRename(c, true)} />
          {:else}
            <span class="actions">
              <IconButton size="sm" label="Rename {c.name}" hint="Rename" onclick={() => { startRename(c) }}><Pencil size={12} /></IconButton>
              <IconButton size="sm" variant="danger" label="Delete {c.name}" hint="Delete" onclick={() => { void removeCharacter(c) }}><Trash2 size={13} /></IconButton>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if batch !== null}
    <footer><Button variant="primary" block loading>Rigging · {batch.done} of {batch.total} done</Button></footer>
  {:else if riggable.length > 1}
    <footer>
      <Button variant="primary" block onclick={rigAll}><Sparkles size={14} /> Auto-rig all {riggable.length}</Button>
    </footer>
  {/if}
</div>

<style>
  .list { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 10px 6px 16px; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .count { font-size: 11px; color: var(--text-3); background: var(--bg-3); border-radius: 8px; padding: 1px 7px; }
  .search { padding: 2px 12px 8px; }
  .none { margin: 8px 16px; font-size: 12px; }
  ul { list-style: none; margin: 0; padding: 0 8px 8px; overflow: auto; flex: 1; }
  li { position: relative; }
  .item {
    width: 100%;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 7px 8px;
    border: 1px solid transparent;
    border-radius: var(--r-2);
    background: transparent;
    text-align: left;
    transition: background var(--fast), border-color var(--fast);
  }
  .item:hover { background: var(--bg-2); }
  li.selected .item { background: var(--bg-3); border-color: var(--line-strong); }
  .thumb {
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 7px;
    background: radial-gradient(circle at 50% 30%, #222838, #12141a);
    display: grid;
    place-items: center;
    color: var(--text-3);
    overflow: hidden;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; }
  .status span { overflow: hidden; text-overflow: ellipsis; }
  .status.ok { color: var(--ok); }
  .status.warn { color: var(--warn); }
  .status.busy { color: var(--accent-strong); }
  .status.error { color: var(--danger); }
  .pulse { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.2s ease-in-out infinite; }
  .progress { display: block; height: 2px; background: var(--bg-4); border-radius: 2px; overflow: hidden; margin-top: 3px; }
  .progress span { display: block; height: 100%; background: var(--accent); transition: width var(--med); }
  /* (shown on hover, and whenever one of them has the keyboard's focus) */
  .actions { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); display: flex; gap: 2px; padding: 2px; border-radius: var(--r-1);
    background: var(--bg-2); opacity: 0; transition: opacity var(--fast); }
  li:hover .actions, .actions:focus-within { opacity: 1; }
  .rename { position: absolute; top: 6px; left: 58px; right: 8px; height: 26px; padding: 0 8px; font: inherit; font-weight: 550;
    border: 1px solid var(--accent); border-radius: 6px; background: var(--bg-1); color: var(--text-1); z-index: 1; }
  footer { padding: 10px 12px; border-top: 1px solid var(--line); }
  @keyframes pulse { 50% { opacity: 0.3; } }
</style>
