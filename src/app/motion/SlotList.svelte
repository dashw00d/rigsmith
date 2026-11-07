<script lang="ts">
  // The character's clips: the names its game unit plays (each filled by a slot, or empty) and the trials kept beside
  // them. Slots are known by id, so renaming or reordering never loses which is which. A row plays its clip and shows
  // its adjustments; its loop, in place and speed are saved settings (what the game gets). Arm a row, then press a
  // library card's button to fill it; or preview a card and press Use.
  import { Crosshair, Footprints, GripVertical, Play, Repeat, Trash2, X } from '@lucide/svelte'
  import type { Character, Slot } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { slotByName } from '../../model/select.ts'
  import { clipSlots } from '../../model/stances.ts'
  import { folkOf } from '../../model/folk.ts'
  import { stance } from '../../state/stance.svelte.ts'
  import { app } from '../../state/app.svelte.ts'
  import Chips from '../../ui/Chips.svelte'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import TextField from '../../ui/TextField.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { clipLabel, isTrial, speedOptions, variantOf, type Target } from './rules.ts'
  import AddVariant from './variants/AddVariant.svelte'
  import { VARIED } from '../../model/variants.ts'

  let { character }: { character: Character } = $props()

  const stanceId = $derived(stance.current(character.id))
  const activeStance = $derived(folkOf(character).stances.find(s => s.id === stanceId))
  const game = $derived(slots.game)
  const names = $derived(slots.names)
  const trials = $derived(character.clips.filter(s => isTrial(s, names)))
  // (a game clip's variants, "Attack 2": listed under it; the game picks one of them at random)
  const variants = (name: string): Slot[] => character.clips.filter(s => variantOf(s.name, names) === name)
  const playingId = $derived(animator.playing?.kind === 'slot' ? animator.playing.slotId : null)
  // (a library clip previewed now: a slot can take it)
  const previewing = $derived(animator.playing?.kind === 'library' && animator.playing.library !== null ? animator.playing : null)
  let problems = $state<Record<string, string>>({})
  let dragging = $state<string | null>(null)

  const target = (slot: Slot | undefined, name: string): Target => ({ slotId: slot?.id ?? null, name })

  async function rename (s: Slot, name: string): Promise<void> {
    const problem = await slots.rename(character, s.id, name)
    const rest = Object.fromEntries(Object.entries(problems).filter(([id]) => id !== s.id))
    problems = problem === null ? rest : { ...rest, [s.id]: problem }
  }

  async function use (t: Target): Promise<void> {
    const p = previewing
    if (p?.library == null) return
    await slots.fill(character, t, p.library, { inPlace: p.inPlace })
  }

  async function drop (onto: string): Promise<void> {
    const moved = dragging
    dragging = null
    if (moved === null || moved === onto) return
    const ids = character.clips.map(s => s.id)
    // (dragged down: it goes after the row it was dropped on; up: before it)
    const before = ids.indexOf(moved) < ids.indexOf(onto) ? ids[ids.indexOf(onto) + 1] ?? null : onto
    await slots.reorder(character, moved, before)
  }
</script>

{#snippet controls(s: Slot)}
  <IconButton label="Loops" hint={s.loop ? 'Saved setting: loops' : 'Saved setting: plays once'} size="sm" active={s.loop} onclick={() => slots.update(character, s.id, { loop: !s.loop })}><Repeat size={13} /></IconButton>
  <IconButton label="In place" hint={s.inPlace ? 'Saved setting: in place (root motion removed)' : 'Saved setting: root motion kept'} size="sm" active={s.inPlace}
    onclick={() => slots.update(character, s.id, { inPlace: !s.inPlace })}><Footprints size={13} /></IconButton>
  <select class="speed mono" value={String(s.speed)} aria-label="Speed of {s.name}" use:tooltip={'Saved setting: speed'}
    onchange={(e) => slots.update(character, s.id, { speed: Number(e.currentTarget.value) })}>
    {#each speedOptions(s.speed) as v (v)}<option value={String(v)}>{v}×</option>{/each}
  </select>
{/snippet}

{#snippet arm(slot: Slot | undefined, name: string)}
  {@const on = slots.isArmed(slot?.id ?? null, name)}
  <IconButton label="Fill {name} from the library" hint={on ? 'Armed: a library card’s button fills it' : 'Fill it from the library'} size="sm" active={on}
    onclick={() => slots.arm(target(slot, name))}><Crosshair size={13} /></IconButton>
{/snippet}

{#if game !== null}
  <div class="group">
    <h4>In the game: {game.unit}{game.role === 'companion' ? ' (its companion)' : ''}</h4>
    <ul class="set">
      {#each names as name (name)}
        {@const s = slotByName(character, name)}
        {@const playable = clipSlots(character, stanceId, name)}
        <li class="slot-row" class:playing={s !== undefined && playingId === s.id} class:selected={s !== undefined && slots.selectedId === s.id}
          class:armed={slots.isArmed(s?.id ?? null, name)} class:empty={s === undefined}>
          <div class="line">
            <IconButton label="Play {name}" size="sm" disabled={playable.length === 0} onclick={() => { if (playable[0] !== undefined) void slots.play(character, playable[0].id) }}><Play size={12} /></IconButton>
            <button class="slot" disabled={playable.length === 0} onclick={() => { if (playable[0] !== undefined) void slots.play(character, playable[0].id) }}>{name}</button>
            {#if s !== undefined}{@render controls(s)}{/if}
            {#if previewing !== null}
              <button class="use" onclick={() => use(target(s, name))} use:tooltip={`Use ${previewing.label} for ${name}`}>Use</button>
            {/if}
            {@render arm(s, name)}
            {#if s !== undefined}<IconButton label="Empty {name}" size="sm" variant="danger" onclick={() => slots.remove(character, s.id)}><X size={13} /></IconButton>{/if}
          </div>
          {#if activeStance !== undefined}
            <div class="stance-override" data-testid="motion-stance-row" data-id={name}>
              <span>{activeStance.clips[name] === undefined ? '↩ base' : `plays: ${playable.map(slot => slot.name).join(', ')}`}</span>
              <details><summary data-testid="motion-override-open">Override</summary>
                <Chips testid="motion-override-slots" label="Slots for {name}" options={character.clips.map(slot => ({ value: slot.id, label: slot.name }))} value={activeStance.clips[name] ?? []}
                  onchange={(ids) => { void app.do(character.id, { type: 'folk.stance.clip', id: activeStance.id, clip: name, slots: ids.length ? ids : null }) }} />
              </details>
              {#if activeStance.clips[name] !== undefined}<Button size="sm" variant="ghost" onclick={() => { void app.do(character.id, { type: 'folk.stance.clip', id: activeStance.id, clip: name, slots: null }) }}>Clear</Button>{/if}
            </div>
          {/if}
          <div class="sub">
            <span class="clip" use:tooltip={s?.note ?? s?.clip.id ?? 'No clip yet'}>{s !== undefined ? clipLabel(s.clip) : 'empty'}</span>
            {#if s !== undefined && VARIED.includes(name)}<AddVariant {character} {name} {names} />{/if}
          </div>
        </li>
        {#each variants(name) as v (v.id)}
          <li class="slot-row variant" class:playing={playingId === v.id} class:selected={slots.selectedId === v.id}>
            <div class="line">
              <IconButton label="Play {v.name}" size="sm" onclick={() => { void slots.play(character, v.id) }}><Play size={12} /></IconButton>
              <button class="slot" onclick={() => { void slots.play(character, v.id) }} use:tooltip={`A variant of ${name}: the game picks one of them at random`}>{v.name}</button>
              {@render controls(v)}
              <IconButton label="Remove {v.name}" size="sm" variant="danger" onclick={() => slots.remove(character, v.id)}><Trash2 size={13} /></IconButton>
            </div>
            <span class="clip" use:tooltip={v.note ?? v.clip.id}>{clipLabel(v.clip)}</span>
          </li>
        {/each}
      {/each}
    </ul>
  </div>
{/if}

<div class="group">
  <div class="group-head">
    <h4>{game !== null ? 'Trials' : 'Clips'}</h4>
    {#if game === null && character.clips.length > 0}
      <Button size="sm" variant="ghost" onclick={() => slots.clear(character)}>Remove all</Button>
    {/if}
  </div>
  {#if trials.length === 0}
    <EmptyState compact title={game !== null ? 'No trials' : 'No clips yet'}
      body={`Open the library and click a card to preview it on ${character.name}; its + button ${game !== null ? 'keeps it here to compare (the game doesn’t get these)' : 'adds it here'}.`} />
  {:else}
    <ul class="set">
      {#each trials as s (s.id)}
        <li class:playing={playingId === s.id} class:selected={slots.selectedId === s.id} class:armed={slots.isArmed(s.id, s.name)} class:dragging={dragging === s.id}
          draggable="true" ondragstart={() => { dragging = s.id }} ondragend={() => { dragging = null }}
          ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); void drop(s.id) }}>
          <div class="line">
            <span class="grip" aria-hidden="true"><GripVertical size={13} /></span>
            <IconButton label="Play {s.name}" size="sm" onclick={() => slots.play(character, s.id)}><Play size={12} /></IconButton>
            <span class="name"><TextField size="sm" label="Name of {s.name}" value={s.name} oncommit={(v) => rename(s, v)} /></span>
            {@render controls(s)}
            {#if previewing !== null}
              <button class="use" onclick={() => use(target(s, s.name))} use:tooltip={`Use ${previewing.label} for ${s.name}`}>Use</button>
            {/if}
            {@render arm(s, s.name)}
            <IconButton label="Remove {s.name}" size="sm" variant="danger" onclick={() => slots.remove(character, s.id)}><Trash2 size={13} /></IconButton>
          </div>
          {#if problems[s.id]}<span class="problem" role="alert">{problems[s.id]}</span>{/if}
          <span class="clip" use:tooltip={s.note ?? s.clip.id}>{clipLabel(s.clip)}</span>
        </li>
      {/each}
    </ul>
    <p class="faint small">{game !== null ? 'Kept here to compare: play one, then Use it for a clip the game plays. Drag to reorder.' : 'Names become the animation names in the game. Drag to reorder.'}</p>
  {/if}
</div>

<style>
  .stance-override { margin-left: 28px; font-size: 11px; color: var(--text-2); }
  .stance-override summary { cursor: pointer; }
  .group { display: flex; flex-direction: column; gap: 4px; }
  .group + .group { margin-top: 10px; }
  .group-head { display: flex; align-items: center; justify-content: space-between; }
  h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--text-2); }
  .set { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; flex-direction: column; padding: 2px 4px 3px; border-radius: var(--r-1); border: 1px solid transparent; }
  li:hover { background: var(--bg-2); }
  li.selected { background: var(--bg-2); border-color: var(--line-strong); }
  li.playing { background: var(--accent-soft); border-color: rgb(142 162 255 / 30%); }
  li.armed { border-color: var(--accent); }
  li.dragging { opacity: 0.4; }
  .line { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .sub { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
  .sub .clip { min-width: 0; }
  .grip { color: var(--text-4); cursor: grab; display: grid; }
  .slot { flex: 1; min-width: 0; text-align: left; border: 0; background: transparent; padding: 0 4px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .slot:disabled { color: var(--text-2); cursor: default; }
  li.empty .slot { color: var(--text-2); }
  li.variant { margin-left: 14px; }
  .name { flex: 1; min-width: 0; }
  .clip { padding-left: 28px; font-size: 11px; color: var(--text-3); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li.empty .clip { color: var(--text-4); font-style: italic; }
  .problem { padding-left: 28px; font-size: 11px; color: var(--danger); }
  .use { height: 22px; padding: 0 7px; border-radius: 5px; border: 1px solid var(--accent); background: transparent; color: var(--accent-strong); font-size: 11px; font-weight: 600; flex: none; }
  .use:hover { background: var(--accent); color: var(--accent-ink); }
  .speed { height: 24px; border-radius: 5px; border: 1px solid var(--line); background: var(--bg-1); font-size: 11px; padding: 0 2px; flex: none; }
  .small { font-size: 12px; margin: 2px 0 0; }
</style>
