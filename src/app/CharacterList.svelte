<script lang="ts">
  import { Bone, Plus, Sparkles, UserRound } from '@lucide/svelte'
  import { fileUrl, type Character } from '../state/api.ts'
  import { app } from '../state/app.svelte.ts'
  import Button from '../ui/Button.svelte'
  import { tooltip } from '../ui/tooltip.ts'

  let input: HTMLInputElement

  const unrigged = $derived(app.characters.filter(c => c.kind === 'mesh' && c.status === 'ready'))

  function status (c: Character): { text: string, tone: 'ok' | 'warn' | 'busy' | 'error' | 'idle' } {
    const job = app.jobFor(c.id)
    if (job !== undefined) return { text: job.status === 'queued' ? 'Queued' : job.message, tone: 'busy' }
    switch (c.status) {
      case 'importing': return { text: 'Importing', tone: 'busy' }
      case 'rigging': return { text: 'Rigging', tone: 'busy' }
      case 'error': return { text: c.error ?? 'Error', tone: 'error' }
      case 'rigged': return { text: c.kind === 'rigged' ? `Rigged · ${c.rigPreset ?? 'custom'}` : `Rigged · ${c.stats?.vertices ?? 0} verts`, tone: 'ok' }
      default: return c.kind === 'animation' ? { text: 'Animation file', tone: 'idle' } : { text: 'Needs rig', tone: 'warn' }
    }
  }

  async function rigAll (): Promise<void> {
    for (const c of unrigged) await app.rig(c.id)
    app.toast('info', `Rigging ${unrigged.length} characters in the background`)
  }
</script>

<div class="list">
  <header>
    <h2>Characters <span class="count">{app.characters.length}</span></h2>
    <Button size="sm" variant="ghost" icon onclick={() => input.click()} aria-label="Import models">
      <Plus size={15} />
    </Button>
    <input bind:this={input} type="file" multiple accept=".fbx,.glb,.gltf,.obj,.dae,.zip" hidden
      onchange={() => { void app.importFiles([...input.files ?? []]); input.value = '' }} />
  </header>

  {#if app.characters.length === 0}
    <button class="empty" onclick={() => input.click()}>
      <div class="glyph"><UserRound size={22} /></div>
      <strong>Drop models anywhere</strong>
      <span class="faint">FBX, GLB, OBJ or Tripo ZIP. Drop a dozen at once; they import in parallel.</span>
    </button>
  {:else}
    <ul>
      {#each app.characters as c (c.id)}
        {@const s = status(c)}
        {@const job = app.jobFor(c.id)}
        <li>
          <button class="item" class:selected={app.selectedId === c.id} onclick={() => { app.selectedId = c.id }}>
            <div class="thumb">
              {#if c.files.thumbnail}<img src={fileUrl(c, c.files.thumbnail)} alt="" />{:else}<UserRound size={18} />{/if}
            </div>
            <div class="meta">
              <div class="name">{c.name}</div>
              <div class="status {s.tone}" use:tooltip={s.tone === 'error' ? s.text : null}>
                {#if s.tone === 'ok'}<Bone size={11} />{/if}
                <span>{s.text}</span>
              </div>
              {#if job?.status === 'running'}<div class="progress"><div style="width: {Math.round(job.progress * 100)}%"></div></div>{/if}
            </div>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if unrigged.length > 1}
    <footer>
      <Button variant="primary" block onclick={rigAll}><Sparkles size={14} /> Auto-rig all {unrigged.length}</Button>
    </footer>
  {/if}
</div>

<style>
  .list { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 8px 16px; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .count { font-size: 11px; color: var(--text-3); background: var(--bg-3); border-radius: 8px; padding: 1px 7px; }
  ul { list-style: none; margin: 0; padding: 0 8px 8px; overflow: auto; flex: 1; }
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
  .item.selected { background: var(--bg-3); border-color: var(--line-strong); }
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
  .progress { height: 2px; background: var(--bg-4); border-radius: 2px; overflow: hidden; margin-top: 3px; }
  .progress div { height: 100%; background: var(--accent); transition: width var(--med); }
  .empty {
    margin: 8px 12px;
    padding: 28px 18px;
    border: 1.5px dashed var(--line-strong);
    border-radius: var(--r-3);
    background: transparent;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
    transition: border-color var(--fast), background var(--fast);
  }
  .empty:hover { border-color: var(--accent); background: var(--accent-soft); }
  .glyph { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--bg-3); color: var(--text-2); margin-bottom: 4px; }
  .empty span { font-size: 12px; max-width: 200px; }
  footer { padding: 10px 12px; border-top: 1px solid var(--line); }
</style>
