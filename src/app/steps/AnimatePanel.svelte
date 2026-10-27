<script lang="ts">
  import { ArrowRight, Copy, Crosshair, Footprints, GripVertical, Play, Repeat, Trash2, X } from '@lucide/svelte'
  import type { AnimationEntry, Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import ScriptsPanel from '../animate/ScriptsPanel.svelte'
  import TunePanel from '../animate/TunePanel.svelte'
  import EditPanel from '../animate/EditPanel.svelte'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let { character }: { character: Character } = $props()

  $effect(() => { void app.gameBeat; void slots.load(character.id) })

  const rigged = $derived(character.status === 'rigged')
  const others = $derived(app.characters.filter(c => c.id !== character.id && c.status === 'rigged'))
  const game = $derived(slots.game)
  const names = $derived(game?.clips ?? [])
  // (the set's entries the game doesn't name: clips being tried, kept in Rigsmith)
  const trials = $derived(character.animations.map((a, i) => ({ a, i })).filter(x => !names.includes(x.a.name)))
  const filled = (slot: string): { a: AnimationEntry, i: number } | null => {
    const i = character.animations.findIndex(a => a.name === slot)
    return i < 0 ? null : { a: character.animations[i], i }
  }
  // A library clip playing now (not an entry, nor the editor's unsaved edit): a slot can take it.
  const previewing = $derived(animator.current !== null && animator.current.entry === null && animator.current.clipId !== 'fists' && animator.current.edited !== true ? animator.current : null)
  const label = (a: AnimationEntry): string => a.clipId.replace(/^(mixamo|custom|human|horse)-/, '').replace(/[_-]+/g, ' ')
  let dragIndex = $state<number | null>(null)

  async function save (animations: AnimationEntry[]): Promise<void> {
    await app.update(character.id, { animations })
  }

  async function patch (index: number, change: Partial<AnimationEntry>): Promise<void> {
    const next = character.animations.map((a, i) => (i === index ? { ...a, ...change } : a))
    await save(next)
    if (animator.current?.entry === index) animator.playEntry(next[index], index)
  }

  async function remove (index: number): Promise<void> {
    await save(character.animations.filter((_, i) => i !== index))
    if (animator.current?.entry === index) animator.stop()
  }

  async function drop (index: number): Promise<void> {
    if (dragIndex === null || dragIndex === index) return
    const next = [...character.animations]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(index, 0, moved)
    dragIndex = null
    await save(next)
  }

  async function copyToAll (): Promise<void> {
    for (const other of others) await app.update(other.id, { animations: character.animations.map(a => ({ ...a })) })
    app.toast('ok', `Copied ${character.animations.length} animations to ${others.length} characters`)
  }

  function useForSlot (slot: string): void {
    if (previewing === null) return
    void slots.fill(slot, { clipId: previewing.clipId, url: previewing.url.startsWith('/animations/') || previewing.url.startsWith('/files/library/creatures/') ? previewing.url : undefined, inPlace: animator.inPlace, loop: animator.loop, propPaths: previewing.propPaths })
  }
</script>

{#snippet controls(entry: AnimationEntry, i: number)}
  <button class="flag" class:on={entry.loop} aria-label={`Loop ${entry.name}`} aria-pressed={entry.loop} onclick={() => patch(i, { loop: !entry.loop })} use:tooltip={entry.loop ? 'Saved setting: loops' : 'Saved setting: plays once'}><Repeat size={13} /></button>
  <button class="flag" class:on={entry.inPlace} aria-label={`In place ${entry.name}`} aria-pressed={entry.inPlace} onclick={() => patch(i, { inPlace: !entry.inPlace })} use:tooltip={entry.inPlace ? 'Saved setting: in place (root motion removed)' : 'Saved setting: root motion kept'}><Footprints size={13} /></button>
  <select class="speed mono" value={String(entry.speed)} onchange={(e) => patch(i, { speed: Number((e.target as HTMLSelectElement).value) })} aria-label={`Saved speed for ${entry.name}`}>
    {#each [...new Set([0.5, 0.6, 0.75, 0.8, 1, 1.25, 1.5, 2, entry.speed])].sort((a, b) => a - b) as s}<option value={String(s)}>{s}×</option>{/each}
  </select>
{/snippet}

{#if !rigged}
  <Section>
    <p class="muted">Rig this character first, then pick its animations.</p>
    <Button variant="primary" block onclick={() => { app.step = 'rig' }}>Go to Rig</Button>
  </Section>
{:else}
  <EditPanel />
  {#if game}
    <Section title="In the game: {game.unit}{game.role === 'companion' ? ' (its companion)' : ''}">
      <p class="faint small">The clips the game plays. Fill one from the library: arm it (<Crosshair size={11} />) and press a card's
        button, or play a card and press Use.</p>
      <ul class="set">
        {#each names as slot (slot)}
          {@const e = filled(slot)}
          <li class="slot-row" class:playing={e !== null && animator.current?.entry === e.i} class:armed={slots.armed === slot} class:empty={e === null}>
            <button class="play" disabled={e === null} onclick={() => { if (e !== null) animator.playEntry(e.a, e.i) }} aria-label="Play {slot}"><Play size={12} /></button>
            <span class="slot">{slot}</span>
            <span class="clip" title={e?.a.note ?? e?.a.clipId ?? 'No clip yet'}>{e !== null ? label(e.a) : 'empty'}</span>
            {#if e !== null}{@render controls(e.a, e.i)}{/if}
            {#if previewing !== null}
              <button class="use" onclick={() => useForSlot(slot)} use:tooltip={`Use ${previewing.name} for ${slot}`}>Use</button>
            {/if}
            <button class="flag" class:on={slots.armed === slot} aria-label={`Fill ${slot} from library`} aria-pressed={slots.armed === slot} onclick={() => { slots.armed = slots.armed === slot ? null : slot }}
              use:tooltip={slots.armed === slot ? 'Armed: a library card fills it' : 'Fill from the library'}><Crosshair size={13} /></button>
            {#if e !== null}<button class="del" onclick={() => slots.clear(slot)} aria-label="Empty {slot}"><X size={13} /></button>{/if}
          </li>
        {/each}
      </ul>
    </Section>
  {/if}

  <Section title={game !== null ? 'Trials' : 'Animation set'}>
    {#snippet action()}
      {#if game === null && character.animations.length > 0}
        <Button size="sm" variant="ghost" onclick={() => save([])} aria-label="Clear set"><X size={13} /> Clear</Button>
      {/if}
    {/snippet}
    {#if trials.length === 0}
      <div class="empty">
        <strong>{game !== null ? 'No trials' : 'No animations yet'}</strong>
        <span class="faint">Click a card to preview it on {character.name}. Press <kbd>+</kbd> on a card to {game !== null ? 'keep it here to compare (the game doesn’t get these)' : 'add it here'}.</span>
      </div>
    {:else}
      <ul class="set">
        {#each trials as { a: entry, i } (entry.clipId + i)}
          <li class:playing={animator.current?.entry === i} class:dragging={dragIndex === i}
            draggable="true" ondragstart={() => { dragIndex = i }} ondragend={() => { dragIndex = null }}
            ondragover={(e) => e.preventDefault()} ondrop={() => drop(i)}>
            <span class="grip"><GripVertical size={13} /></span>
            <button class="play" onclick={() => animator.playEntry(entry, i)} aria-label="Play {entry.name}"><Play size={12} /></button>
            <input class="name" value={entry.name} aria-label="Animation name" title={entry.note ?? entry.clipId}
              onchange={(e) => patch(i, { name: (e.target as HTMLInputElement).value.trim() || entry.name })} />
            {@render controls(entry, i)}
            <button class="del" onclick={() => remove(i)} aria-label="Remove {entry.name}"><Trash2 size={13} /></button>
          </li>
        {/each}
      </ul>
      <p class="faint small">{game !== null ? 'Kept here to compare; play one, then Use it for a slot.' : 'Names become the animation names in Godot. Drag to reorder.'}</p>
    {/if}
  </Section>

  {#if character.animations.length > 0}
    <TunePanel {character} />
    <ScriptsPanel {character} />
  {/if}

  {#if game === null && others.length > 0 && character.animations.length > 0}
    <Section>
      <Button variant="ghost" block onclick={copyToAll}><Copy size={14} /> Use this set on {others.length} other rigged character{others.length === 1 ? '' : 's'}</Button>
    </Section>
  {/if}

  <Section>
    <Button variant="primary" size="lg" block disabled={character.animations.length === 0} onclick={() => { app.step = 'export' }}>
      Export <ArrowRight size={15} />
    </Button>
  </Section>
{/if}

<style>
  .empty { display: flex; flex-direction: column; gap: 4px; padding: 14px; border: 1px dashed var(--line-strong); border-radius: var(--r-2); }
  .empty span { font-size: 12.5px; }
  kbd { font-family: var(--mono); font-size: 11px; padding: 0 4px; border-radius: 4px; background: var(--bg-3); border: 1px solid var(--line-strong); }
  .set { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 4px;
    border-radius: var(--r-1);
    border: 1px solid transparent;
  }
  li:hover { background: var(--bg-2); }
  li.playing { background: var(--accent-soft); border-color: rgb(142 162 255 / 30%); }
  li.armed { border-color: var(--accent); }
  li.empty .slot { color: var(--text-2); }
  li.dragging { opacity: 0.4; }
  .grip { color: var(--text-4); cursor: grab; display: grid; }
  .play, .flag, .del { width: 24px; height: 24px; border-radius: 5px; border: 0; background: transparent; color: var(--text-3); display: grid; place-items: center; flex: none; }
  .play:disabled { opacity: 0.3; }
  .play:hover:not(:disabled), .flag:hover { background: var(--bg-4); color: var(--text-1); }
  .flag.on { color: var(--accent-strong); }
  .del:hover { color: var(--danger); background: var(--danger-soft); }
  .slot { width: 62px; flex: none; font-weight: 600; }
  .slot-row { flex-wrap: wrap; }
  .slot-row .slot { width: auto; flex: 1; }
  .slot-row .clip { order: 1; flex-basis: 100%; padding-left: 28px; font-size: 11px; }
  .clip { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-2); }
  li.empty .clip { color: var(--text-4); font-style: italic; }
  .use { height: 22px; padding: 0 7px; border-radius: 5px; border: 1px solid var(--accent); background: transparent; color: var(--accent-strong); font-size: 11px; font-weight: 600; flex: none; }
  .use:hover { background: var(--accent); color: var(--accent-ink); }
  .name { flex: 1; min-width: 0; height: 24px; padding: 0 6px; border-radius: 5px; border: 1px solid transparent; background: transparent; font-weight: 500; }
  .name:hover { border-color: var(--line-strong); }
  .name:focus { outline: none; border-color: var(--accent); background: var(--bg-1); }
  .speed { height: 24px; border-radius: 5px; border: 1px solid var(--line); background: var(--bg-1); font-size: 11px; padding: 0 2px; }
  .small { font-size: 12px; margin: 0; }
</style>
