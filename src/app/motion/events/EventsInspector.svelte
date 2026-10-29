<script lang="ts">
  // The selected events (docs/motion-plan.md §9 C1), shown by the timeline's inspector when the selection is events:
  // one event's name (from the character's vocabulary or typed), its frame (and a span's end), its sound (one of the
  // game's, each with a play button, or a file dropped here, kept with the character), the sound's volume and pitch,
  // and the bone it happens at (a release: where the projectile leaves from); several at once share a sound or go
  // together. Frames are the clip's as it plays; every change is one command, stored against the source clip.
  import { Play, Trash2, Upload, X } from '@lucide/svelte'
  import type { ClipEvent } from '../../../model/types.ts'
  import type { EventPatch } from '../../../model/command-types.ts'
  import { events } from '../../../state/events.svelte.ts'
  import Field from '../../../ui/Field.svelte'
  import IconButton from '../../../ui/IconButton.svelte'
  import NumberField from '../../../ui/NumberField.svelte'
  import Select from '../../../ui/Select.svelte'
  import Toggle from '../../../ui/Toggle.svelte'
  import type { TimelineView } from '../lanes.ts'
  import { addEvent, MEASURED_HIT, measuredHit, removeEvents, toggleSpan } from './edit.ts'
  import { BUILT_INS, boneNames, canonical, isBuiltIn, labelOf, nameProblem, vocabulary } from './vocabulary.ts'

  let { view }: { view: TimelineView } = $props()

  let search = $state('')
  let rename = $state('')
  let over = $state(false)
  let input = $state<HTMLInputElement | null>(null)

  const c = $derived(view.character)
  const slot = $derived(view.slot)
  const ids = $derived(events.selected(view))
  const chosen = $derived((slot.events ?? []).filter(e => ids.includes(e.id)))
  const one = $derived(chosen.length === 1 ? chosen[0] : null)
  const measured = $derived(ids.includes(MEASURED_HIT) ? measuredHit(view.baked?.cut) : null)
  const words = $derived(vocabulary(c))
  const bones = $derived(boneNames(c))
  const hasHit = $derived((slot.events ?? []).some(e => e.name === 'hit' && e.to === undefined))
  const own = $derived(events.own[c.id] ?? [])
  const game = $derived(events.game)
  const found = $derived.by(() => {
    const q = search.trim().toLowerCase()
    const list = game?.sounds.filter(s => s.files.length > 0 && !s.family) ?? []
    return (q === '' ? list : list.filter(s => s.id.includes(q) || s.cat.includes(q))).slice(0, 60)
  })

  $effect(() => { void events.loadGame() })
  $effect(() => { void events.loadOwn(c.id) })
  $effect(() => { rename = one?.name ?? '' })

  const frameOf = (u: number): number => Math.round(view.toPlayed(u) * view.frames)
  const sourceAt = (frame: number): number => Math.max(0, view.toSource(Math.min(1, Math.max(0, frame / Math.max(1, view.frames)))))
  const soundLabel = (sound: string | undefined): string => (sound === undefined ? 'No sound' : sound.replace(/^mix:/, '').replace(/^file:sounds\//, ''))

  async function patch (e: ClipEvent, p: EventPatch): Promise<void> {
    await events.run(view, [{ type: 'slot.event.update', slot: slot.id, id: e.id, patch: p }])
  }

  /** The sound set on every event chosen. */
  async function setSound (sound: string | null): Promise<void> {
    await events.run(view, chosen.map(e => ({ type: 'slot.event.update', slot: slot.id, id: e.id, patch: { sound } })))
    if (sound !== null && one !== null) void events.play(c.id, sound, { volume: one.volume, pitch: one.pitch })
  }

  async function dropped (files: FileList | null | undefined): Promise<void> {
    const file = files?.[0]
    if (file === undefined) return
    const sound = await events.drop(c.id, file)
    if (sound !== null) await setSound(sound)
  }

  async function commitName (): Promise<void> {
    if (one === null) return
    const name = canonical(c, rename)
    if (name === null || name === one.name) { rename = one.name; return }
    if (name === 'hit' && (hasHit || one.to !== undefined)) { rename = one.name; return }
    await patch(one, { name })
  }

  async function pickBlow (frame: number): Promise<void> {
    const cmd = addEvent(slot, 'hit', frame / Math.max(1, view.frames), view)
    if (await events.run(view, [cmd]) && cmd.type === 'slot.event.add') view.select([{ track: 'events', id: cmd.event.id, u: cmd.event.u }], 'set')
  }

  async function remove (): Promise<void> {
    await events.run(view, removeEvents(slot, chosen.map(e => e.id)))
    view.select([], 'set')
  }

  const nameOptions = $derived(words.filter(w => !(w.name === 'hit' && (hasHit || one?.to !== undefined) && one?.name !== 'hit'))
    .map(w => ({ value: w.name, label: labelOf(w.name), group: w.builtIn ? 'The game reads' : `${c.name}'s own` })))
  const boneOptions = $derived([{ value: '', label: 'None' }, ...bones.map(b => ({ value: b, label: b }))])
</script>

<div class="events-inspector">
  {#if measured !== null && chosen.length === 0}
    <p class="lead">The blow, measured at frame {Math.round(measured * view.frames)} (the hand's fastest moment).</p>
    <Field label="Pick it by hand" hint="A hit event at this frame: the fit lands it">
      <NumberField value={Math.round(measured * view.frames)} min={0} max={view.frames} step={1} digits={0} label="The blow's frame" onchange={f => { void pickBlow(f) }} />
    </Field>
  {:else if one !== null}
    <div class="title">
      <strong>{labelOf(one.name)}</strong>
      {#if isBuiltIn(one.name)}<span class="faint">{BUILT_INS[one.name].hint}</span>{/if}
    </div>
    <Field label="Name">
      <Select options={nameOptions} value={one.name} size="sm" width="150px" label="Its name" onchange={name => { void patch(one, { name }) }} />
    </Field>
    <Field label="Rename" hint={nameProblem(rename) ?? (canonical(c, rename) !== rename.trim() ? `as ${canonical(c, rename)}` : undefined)}>
      <input class="text" type="text" maxlength="32" bind:value={rename} aria-label="A name of your own"
        onkeydown={e => { if (e.key === 'Enter') void commitName(); if (e.key === 'Escape') rename = one.name }} onblur={() => { void commitName() }} />
    </Field>
    <Field label={one.to === undefined ? 'Frame' : 'From frame'}>
      <NumberField value={frameOf(one.u)} min={0} max={view.frames} step={1} digits={0} label="Its frame" onchange={f => { void patch(one, { u: sourceAt(f) }) }} />
    </Field>
    {#if one.to !== undefined}
      <Field label="To frame">
        <NumberField value={frameOf(one.to)} min={frameOf(one.u) + 1} max={view.frames} step={1} digits={0} label="Its last frame" onchange={f => { void patch(one, { to: sourceAt(f) }) }} />
      </Field>
    {/if}
    {#if one.name !== 'hit'}
      <Toggle checked={one.to !== undefined} label="Lasts" hint="A span from one frame to another, not a moment" onchange={() => { void events.run(view, toggleSpan(slot, one.id, view)) }} />
    {/if}
  {:else if chosen.length > 1}
    <p class="lead">{chosen.length} events: {[...new Set(chosen.map(e => labelOf(e.name)))].join(', ')}</p>
  {/if}

  {#if chosen.length > 0}
    <div class="sound" class:over role="group" aria-label="Sound"
      ondragover={e => { e.preventDefault(); over = true }} ondragleave={() => { over = false }}
      ondrop={e => { e.preventDefault(); over = false; void dropped(e.dataTransfer?.files) }}>
      <div class="sound-head">
        <span class="label">Sound</span>
        <span class="current" class:none={one?.sound === undefined}>{one !== null ? soundLabel(one.sound) : [...new Set(chosen.map(e => soundLabel(e.sound)))].join(', ')}</span>
        {#if one?.sound !== undefined}
          <IconButton label="Play it" size="sm" onclick={() => { void events.play(c.id, one.sound, { volume: one.volume, pitch: one.pitch }) }}><Play size={13} /></IconButton>
        {/if}
        {#if chosen.some(e => e.sound !== undefined)}
          <IconButton label="No sound" size="sm" onclick={() => { void setSound(null) }}><X size={13} /></IconButton>
        {/if}
      </div>
      <input class="text search" type="search" placeholder={game?.found === false ? "The game's mix table isn't there (Settings: the game's repo)" : "The game's sounds: search"}
        bind:value={search} aria-label="Search the game's sounds" disabled={game?.found === false} />
      <ul class="list">
        {#each found as s (s.id)}
          <li class:on={chosen.every(e => e.sound === `mix:${s.id}`)}>
            <button type="button" class="pick" onclick={() => { void setSound(`mix:${s.id}`) }}>{s.id}<span class="faint"> · {s.cat}</span></button>
            <IconButton label="Hear {s.id}" size="sm" onclick={() => { void events.play(c.id, `mix:${s.id}`) }}><Play size={12} /></IconButton>
          </li>
        {:else}
          <li class="faint">{game === null ? (events.gameError ?? 'Loading…') : 'None found'}</li>
        {/each}
      </ul>
      {#if own.length > 0}
        <span class="label sub">{c.name}'s own</span>
        <ul class="list own">
          {#each own as f (f.file)}
            <li class:on={chosen.every(e => e.sound === f.sound)}>
              <button type="button" class="pick" onclick={() => { void setSound(f.sound) }}>{f.file}</button>
              <IconButton label="Hear {f.file}" size="sm" onclick={() => { void events.play(c.id, f.sound) }}><Play size={12} /></IconButton>
            </li>
          {/each}
        </ul>
      {/if}
      <button type="button" class="drop" onclick={() => input?.click()}>
        <Upload size={13} /> Drop a WAV, OGG or MP3 here, or choose one
      </button>
      <input bind:this={input} type="file" accept=".wav,.ogg,.mp3,audio/*" hidden onchange={e => { void dropped((e.currentTarget as HTMLInputElement).files) }} />
    </div>
    {#if one !== null}
      <Field label="Volume" hint={one.sound === undefined ? 'Of its sound' : `${Math.round(20 * Math.log10(one.volume ?? 1))} dB`}>
        <input type="range" min="0.1" max="2" step="0.05" value={one.volume ?? 1} aria-label="Volume"
          onchange={e => { const v = Number((e.currentTarget as HTMLInputElement).value); void patch(one, { volume: Math.abs(v - 1) < 1e-6 ? null : v }) }} />
      </Field>
      <Field label="Pitch" hint={`${(one.pitch ?? 1).toFixed(2)}×`}>
        <input type="range" min="0.5" max="2" step="0.05" value={one.pitch ?? 1} aria-label="Pitch"
          onchange={e => { const v = Number((e.currentTarget as HTMLInputElement).value); void patch(one, { pitch: Math.abs(v - 1) < 1e-6 ? null : v }) }} />
      </Field>
      <Field label="At bone" hint={one.name === 'release' ? 'Where the projectile leaves from' : 'Where it happens (the sound plays there)'}>
        <Select options={boneOptions} value={one.bone ?? ''} size="sm" width="150px" label="Its bone" onchange={b => { void patch(one, { bone: b === '' ? null : b }) }} />
      </Field>
    {/if}
    <div class="actions">
      <button type="button" class="delete" onclick={() => { void remove() }}><Trash2 size={13} /> {chosen.length === 1 ? 'Delete it' : `Delete ${chosen.length}`}</button>
    </div>
  {/if}
</div>

<style>
  .events-inspector { display: flex; flex-direction: column; gap: 10px; font-size: 12.5px; }
  .title { display: flex; flex-direction: column; gap: 2px; }
  .title strong { color: var(--text-1); font-size: 13px; }
  .lead { margin: 0; color: var(--text-2); }
  .faint { color: var(--text-3); font-size: 11.5px; }
  .label { color: var(--text-2); font-size: 12.5px; }
  .label.sub { font-size: 11.5px; color: var(--text-3); }
  .text {
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-1);
    background: var(--bg-1);
    color: var(--text-1);
    font: inherit;
    width: 150px;
  }
  .text:focus { outline: none; border-color: var(--accent); }
  .text.search { width: 100%; }
  .sound {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: var(--r-2);
    background: var(--bg-1);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .sound.over { box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-soft); }
  .sound-head { display: flex; align-items: center; gap: 6px; }
  .current { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-1); font-family: var(--mono); font-size: 11.5px; }
  .current.none { color: var(--text-3); font-family: var(--font); }
  .list { list-style: none; margin: 0; padding: 0; max-height: 160px; overflow: auto; display: flex; flex-direction: column; }
  .list.own { max-height: 90px; }
  .list li { display: flex; align-items: center; justify-content: space-between; gap: 4px; border-radius: var(--r-1); }
  .list li.on { background: var(--accent-soft); }
  .pick {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    border: 0;
    background: none;
    color: var(--text-1);
    font-family: var(--mono);
    font-size: 11.5px;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .list li:hover:not(.on) { background: var(--bg-3); }
  .drop, .delete {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 8px;
    border: 1px dashed var(--line-strong);
    border-radius: var(--r-1);
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .drop:hover { color: var(--text-1); border-color: var(--text-3); }
  .actions { display: flex; justify-content: flex-end; }
  .delete { border: 0; color: var(--danger); }
  .delete:hover { background: var(--danger-soft); }
  input[type='range'] { width: 150px; accent-color: var(--accent); }
</style>
