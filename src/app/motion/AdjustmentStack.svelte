<script lang="ts">
  // A slot's settings over its clip, in the order the bake applies them (src/engine/bake.ts: speed, blow timing, pace,
  // hands, ground), whatever order they were added in (its keys are the timeline's). Each can be switched off (kept, not played), opened to edit, or
  // removed; Add offers what the slot can take one more of. Every change is one command, undoable in Activity. Ground,
  // posture and layer rows have a weight (how much of it plays); Solo plays the slot with only that one on, in the viewer
  // only (docs/motion-plan.md §12.4).
  import { ArrowDownToLine, ChevronDown, ChevronRight, Footprints, Hand, Headphones, KeyRound, Layers, PersonStanding, Plus, Swords, Trash2, Waypoints, Volume2 } from '@lucide/svelte'
  import type { Component } from 'svelte'
  import type { Character, Slot } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { adjust, pullHandles } from '../../state/adjust.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { heightOf } from '../../model/select.ts'
  import { refLabel } from '../../engine/hands.ts'
  import IconButton from '../../ui/IconButton.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { addableKinds, adjustmentText, cmPerUnit, FIT, inBakeOrder, KIND_HINT, KIND_LABEL, liftShown, PACE, rowsOf, WEIGHTED, type RowKind } from './rules.ts'
  import Blow from './adjust/Blow.svelte'
  import Ground from './adjust/Ground.svelte'
  import HandPose from './adjust/HandPose.svelte'
  import Hold from './adjust/Hold.svelte'
  import Layer from './adjust/Layer.svelte'
  import Pace from './adjust/Pace.svelte'
  import Posture from './adjust/Posture.svelte'

  let { character, clipSlot: slot }: { character: Character, clipSlot: Slot } = $props()

  const ICON: Record<RowKind, Component> = { blowTiming: Swords, pace: Footprints, handPose: Hand, handleHold: Waypoints, ground: ArrowDownToLine, keys: KeyRound, posture: PersonStanding, layer: Layers }

  const items = $derived(inBakeOrder(rowsOf(slot)).filter(a => a.kind !== 'keys'))
  const frames = $derived(adjust.frames(slot.id))
  const height = $derived(heightOf(character))
  const perCm = $derived(cmPerUnit(slots.game?.height, height))
  const addable = $derived(addableKinds(slot, { otherSlots: character.clips.length - 1, pulls: pullHandles(character).length }).filter(k => k !== 'keys'))
  const report = $derived(adjust.playingSlot(slot.id)?.baked?.report ?? null)

  const lift = (v: number): string => `lift ${liftShown(v, perCm, height)} ${perCm !== null ? 'cm' : '%'}`
  const pose = (ref: Parameters<typeof refLabel>[1]): string => refLabel(character, ref, app.settings?.handPoses)
  const missing = (id: string): boolean => (report?.[id] as { missing?: boolean } | undefined)?.missing === true

  function toggle (id: string): void {
    adjust.open = adjust.open === id ? null : id
  }

  // (the solo playing in this slot, if any; the blow fit and pace are its time, not adjustments to solo)
  const soloed = $derived(animator.solo?.slotId === slot.id ? animator.solo.id : null)
  const soloable = (id: string): boolean => id !== FIT && id !== PACE
  function solo (id: string): void {
    if (soloed !== id && adjust.playingSlot(slot.id) === null) void slots.play(character, slot.id)
    animator.setSolo(slot.id, soloed === id ? null : id)
  }

  // (a weight slider shows its value while dragged and commits when let go)
  let dragging = $state<{ id: string, value: number } | null>(null)
  const weightOf = (a: { id: string, weight?: number }): number => (dragging?.id === a.id ? dragging.value : a.weight ?? 1)
</script>

<div class="stack">
  {#if items.length === 0}
    <p class="faint empty">It plays as the clip is (at its speed). Add a change on top of it:</p>
  {:else}
    <ul>
      {#each items as a (a.id)}
        {@const Icon = ICON[a.kind]}
        <li class:off={!a.enabled} class:open={adjust.open === a.id}>
          <div class="head">
            <button class="title" aria-expanded={adjust.open === a.id} onclick={() => toggle(a.id)}>
              {#if adjust.open === a.id}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
              <Icon size={13} />
              <span class="kind">{KIND_LABEL[a.kind]}</span>
              <span class="what" class:warn={missing(a.id)}>{missing(a.id) ? 'the clip it follows is gone' : adjustmentText(character, a, { frames, lift, pose })}</span>
            </button>
            {#if soloable(a.id)}
              <button class="solo" class:on={soloed === a.id} aria-pressed={soloed === a.id} aria-label="Solo {KIND_LABEL[a.kind].toLowerCase()}" onclick={() => { solo(a.id) }}
                use:tooltip={soloed === a.id ? 'Soloed: only this one plays (here only; the game gets them all). Click to play them all again' : 'Solo: play the clip with only this one on (here only, nothing is saved)'}><Headphones size={12} /></button>
            {/if}
            <label class="switch" use:tooltip={a.enabled ? 'On: it plays (switch off to keep it without playing it)' : 'Off: kept, not played'}>
              <input type="checkbox" checked={a.enabled} aria-label="{KIND_LABEL[a.kind]} on" onchange={(e) => adjust.setEnabled(character, slot.id, a.id, e.currentTarget.checked)} />
              <span class="track" aria-hidden="true"><span class="thumb"></span></span>
            </label>
            <IconButton label="Remove {KIND_LABEL[a.kind].toLowerCase()}" size="sm" variant="danger" onclick={() => adjust.remove(character, slot.id, a.id)}><Trash2 size={13} /></IconButton>
          </div>
          {#if WEIGHTED.includes(a.kind)}
            <div class="weight" use:tooltip={'How much of it plays: 100% all of it, 0% none'}>
              <input type="range" min="0" max="1" step="0.05" value={weightOf(a)} aria-label="{KIND_LABEL[a.kind]} weight"
                oninput={(e) => { dragging = { id: a.id, value: Number(e.currentTarget.value) } }}
                onchange={(e) => { const v = Number(e.currentTarget.value); dragging = null; void adjust.update(character, slot.id, a.id, { weight: v >= 1 ? null : v }) }} />
              <span class="mono">{Math.round(weightOf(a) * 100)}%</span>
            </div>
          {/if}
          {#if adjust.open === a.id}
            <div class="body">
              {#if a.kind === 'ground'}<Ground {character} clipSlot={slot} adjustment={a} />
              {:else if a.kind === 'blowTiming'}<Blow {character} clipSlot={slot} adjustment={a} />
              {:else if a.kind === 'pace'}<Pace {character} clipSlot={slot} adjustment={a} />
              {:else if a.kind === 'handPose'}<HandPose {character} clipSlot={slot} adjustment={a} />
              {:else if a.kind === 'handleHold'}<Hold {character} clipSlot={slot} adjustment={a} />
              {:else if a.kind === 'posture'}<Posture {character} clipSlot={slot} adjustment={a} />
              {:else if a.kind === 'layer'}<Layer {character} clipSlot={slot} adjustment={a} />{/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if addable.length > 0}
    <div class="add">
      <span class="faint"><Plus size={12} /> Add</span>
      {#each addable as kind (kind)}
        {@const Icon = ICON[kind]}
        <button disabled={adjust.busy !== null} onclick={() => adjust.add(character, slot.id, kind)} use:tooltip={KIND_HINT[kind]}><Icon size={12} /> {KIND_LABEL[kind]}</button>
      {/each}
      <!-- (events and their sounds live on the timeline's Events row: this opens its menu there, at the playhead) -->
      <button onclick={() => { window.dispatchEvent(new CustomEvent('rigsmith:add-event')) }} use:tooltip={'An event at the playhead (a hit, a swing, a step, a name of your own) and its sound: on the timeline’s Events row'}><Volume2 size={12} /> Event or sound</button>
    </div>
  {/if}
</div>

<style>
  .stack { display: flex; flex-direction: column; gap: 6px; }
  .empty { margin: 0; font-size: 12px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { border: 1px solid var(--line); border-radius: var(--r-1); background: var(--bg-1); }
  li.open { border-color: var(--line-strong); }
  li.off .title { opacity: 0.55; }
  .head { display: flex; align-items: center; gap: 4px; padding: 2px 4px 2px 2px; }
  .title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 4px; border: 0; background: transparent; color: var(--text-2); text-align: left; border-radius: 4px; }
  .title:hover { background: var(--bg-3); color: var(--text-1); }
  .kind { font-weight: 600; color: var(--text-1); font-size: 12px; flex: none; }
  .what { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--text-3); }
  .what.warn { color: var(--warn); }
  .body { padding: 6px 10px 10px; border-top: 1px solid var(--line); }
  .switch { position: relative; display: grid; place-items: center; cursor: pointer; padding: 0 2px; }
  .switch input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; }
  .track { width: 26px; height: 15px; border-radius: 8px; background: var(--bg-4); border: 1px solid var(--line-strong); position: relative; transition: background var(--fast); }
  .thumb { position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; border-radius: 50%; background: var(--text-2); transition: transform var(--med) var(--ease); }
  .switch input:checked + .track { background: var(--accent); border-color: var(--accent); }
  .switch input:checked + .track .thumb { transform: translateX(11px); background: var(--accent-ink); }
  .switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .solo { display: grid; place-items: center; width: 22px; height: 22px; border: 0; border-radius: 4px; background: transparent; color: var(--text-3); }
  .solo:hover { background: var(--bg-3); color: var(--text-1); }
  .solo.on { background: var(--accent-soft); color: var(--accent-strong); }
  .weight { display: flex; align-items: center; gap: 6px; padding: 0 8px 4px 26px; font-size: 11px; color: var(--text-3); }
  .weight input { flex: 1; min-width: 60px; accent-color: var(--accent); }
  .weight .mono { width: 32px; text-align: right; }
  .add { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
  .add span { display: flex; align-items: center; gap: 3px; font-size: 12px; }
  .add button { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .add button:hover:not(:disabled) { background: var(--bg-3); color: var(--text-1); }
  .add button:disabled { opacity: 0.4; }
</style>
