<script lang="ts">
  // "+ Append" on the Clip strip (docs/motion-plan.md §11): another clip put after the clip as it plays, blended in. Pick
  // one of the character's other clips (as each plays: its timing and keys) or search the library (its search, for this
  // character's skeleton), then the part of it (seconds) and the blend; it comes in as a piece of its own to trim, blend,
  // reorder or remove. A clip that would end up playing this one is left out (a clip can't play itself).
  import { Plus } from '@lucide/svelte'
  import { api, type LibraryClip } from '../../../state/api.ts'
  import { clipPieces } from '../../../state/pieces.svelte.ts'
  import type { Playing } from '../../../state/timeline.svelte.ts'
  import { newId } from '../../../model/ids.ts'
  import { DEFAULT_BLEND, playsItself } from '../../../model/pieces.ts'
  import type { Piece } from '../../../model/types.ts'
  import { tooltip } from '../../../ui/tooltip.ts'
  import { clipRefOf } from '../rules.ts'

  let { p }: { p: Playing } = $props()

  let open = $state(false)
  let query = $state('')
  let found = $state.raw<LibraryClip[]>([])
  let searching = $state(false)
  let chosen = $state.raw<{ piece: Piece, label: string, length: number | null } | null>(null)
  let from = $state(0)
  let to = $state(1)
  let blend = $state(DEFAULT_BLEND)
  let anchor = $state<HTMLSpanElement | null>(null)
  let panel = $state<HTMLDivElement | null>(null)
  let token = 0

  const others = $derived(p.character.clips.filter(s => s.id !== p.slot.id && !playsItself(p.character, p.slot.id, [{ id: 'x', kind: 'slot', slot: s.id, from: 0, to: 1 }]))
    .filter(s => query.trim() === '' || s.name.toLowerCase().includes(query.trim().toLowerCase())))
  const rig = $derived(p.character.skeleton.template)

  async function search (): Promise<void> {
    const t = ++token
    searching = true
    try {
      const page = await api.library({ q: query, size: 12, rig })
      if (t === token) found = page.clips
    } catch { if (t === token) found = [] } finally { if (t === token) searching = false }
  }
  let debounce: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    if (!open) return
    void query
    clearTimeout(debounce)
    debounce = setTimeout(() => { void search() }, 180)
    return () => { clearTimeout(debounce) }
  })

  async function pick (piece: Piece, label: string): Promise<void> {
    chosen = { piece, label, length: null }
    from = 0; to = 1; blend = DEFAULT_BLEND
    const length = await clipPieces.contentSeconds(p.character, p.slot, piece)
    if (chosen?.piece !== piece) return
    chosen = { piece, label, length }
    to = Math.round((length ?? 1) * 1000) / 1000
  }
  const pickSlot = (id: string, name: string): Promise<void> => pick({ id: newId(), kind: 'slot', slot: id, from: 0, to: 1 }, name)
  const pickClip = (c: LibraryClip): Promise<void> => pick({ id: newId(), kind: 'clip', clip: clipRefOf(c), from: 0, to: 1 }, c.name)

  async function add (): Promise<void> {
    if (chosen === null || !(to > from)) return
    const ok = await clipPieces.append(p, { ...chosen.piece, from: Math.max(0, from), to }, blend)
    if (ok) { open = false; chosen = null }
  }

  // (the panel is fixed over the page beside the button: the tracks scroll and would cut it off)
  $effect(() => {
    if (panel === null || anchor === null) return
    panel.style.left = '0px'; panel.style.top = '0px'
    const origin = panel.getBoundingClientRect(); const a = anchor.getBoundingClientRect()
    const above = a.top - origin.height - 6
    panel.style.left = `${a.left - origin.left}px`
    panel.style.top = `${(above >= 4 ? above : a.bottom + 6) - origin.top}px`
  })
  $effect(() => {
    if (!open) return
    const away = (e: PointerEvent): void => { if (anchor !== null && !anchor.contains(e.target as Node)) open = false }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') open = false }
    window.addEventListener('pointerdown', away); window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  })
</script>

<span class="anchor" bind:this={anchor}>
  <button class="tiny icon" class:on={open} aria-label="Append a clip" aria-expanded={open} use:tooltip={'Append: another clip (or a part of it) after this one, blended in'}
    onclick={() => { open = !open; chosen = null }}><Plus size={11} /></button>
  {#if open}
    <div class="panel" role="dialog" aria-label="Append a clip" bind:this={panel}>
      {#if chosen === null}
        <input class="search" type="search" placeholder="Search clips…" bind:value={query} aria-label="Search clips" />
        {#if others.length > 0}
          <div class="head">{p.character.name}'s clips, as they play</div>
          {#each others as s (s.id)}
            <button class="item" onclick={() => { void pickSlot(s.id, s.name) }}>{s.name}<span class="faint">{s.clip.id.replace(/^(mixamo|custom)-/, '').replace(/_/g, ' ')}</span></button>
          {/each}
        {/if}
        <div class="head">Library{searching ? ' …' : ''}</div>
        {#each found as c (c.id)}
          <button class="item" onclick={() => { void pickClip(c) }}>{c.name}<span class="faint">{c.description ?? c.category ?? ''}</span></button>
        {:else}
          {#if !searching}<p class="faint small">No clip matches.</p>{/if}
        {/each}
      {:else}
        <div class="head">{chosen.label}{chosen.length !== null ? ` · ${chosen.length.toFixed(2)} s` : ''}</div>
        <div class="fields">
          <label>From <input type="number" min="0" step="0.05" bind:value={from} /> s</label>
          <label>to <input type="number" min="0" step="0.05" bind:value={to} /> s</label>
          <label>Blend <input type="number" min="0" step="0.05" bind:value={blend} /> s</label>
        </div>
        <div class="actions">
          <button class="text" onclick={() => { chosen = null }}>Back</button>
          <button class="primary" disabled={!(to > from)} onclick={() => { void add() }}>Append</button>
        </div>
      {/if}
    </div>
  {/if}
</span>

<style>
  .anchor { position: relative; display: inline-flex; }
  .tiny { flex: none; height: 15px; padding: 0; border-radius: 3px; border: 0; background: transparent; color: var(--text-3); }
  .tiny.icon { display: grid; place-items: center; width: 16px; }
  .tiny:hover, .tiny.on { color: var(--text-1); background: var(--bg-3); }
  .panel { position: fixed; z-index: 50; width: 260px; max-height: 300px; overflow-y: auto; padding: 6px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--bg-1); box-shadow: 0 8px 28px rgb(0 0 0 / 45%); display: flex; flex-direction: column; gap: 2px; }
  .search { height: 24px; padding: 0 8px; border-radius: 5px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-1); font-size: 11.5px; }
  .head { margin: 6px 4px 2px; font-size: 10px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; }
  .item { display: flex; flex-direction: column; align-items: flex-start; gap: 0; padding: 4px 6px; border: 0; border-radius: 5px; background: transparent; color: var(--text-1); font-size: 11.5px; text-align: left; }
  .item:hover { background: var(--bg-3); }
  .item .faint { font-size: 10px; color: var(--text-3); }
  .fields { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px; font-size: 11px; color: var(--text-2); }
  .fields input { width: 54px; height: 22px; margin: 0 2px; padding: 0 4px; border-radius: 4px; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-1); font-variant-numeric: tabular-nums; }
  .actions { display: flex; justify-content: flex-end; gap: 6px; padding: 4px; }
  .actions button { height: 24px; padding: 0 10px; border-radius: 5px; border: 0; font-size: 11.5px; }
  .actions .text { background: transparent; color: var(--text-2); }
  .actions .primary { background: var(--accent); color: var(--bg-0); font-weight: 600; }
  .actions button:disabled { opacity: 0.4; }
  .small { font-size: 11px; margin: 4px; }
</style>
