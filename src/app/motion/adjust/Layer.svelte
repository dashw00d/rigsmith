<script lang="ts">
  // A layer: another clip played on part of the body (src/engine/layers.ts): what it plays (one of the character's other
  // clips as it plays, or a library clip found by search), on which parts (a preset or parts ticked), when (the whole
  // clip, or windows: its content starts over at each window's start, `offset` seconds in), faded in and out, held at
  // its end or looped. A clip that would end up playing this one is left out (a clip can't play itself).
  import { untrack } from 'svelte'
  import type { Adjustment, BodyPart, Character, Slot, Window } from '../../../state/api.ts'
  import { api, type LibraryClip } from '../../../state/api.ts'
  import { adjust, wouldCycle } from '../../../state/adjust.svelte.ts'
  import { BODY_PARTS } from '../../../model/types.ts'
  import Field from '../../../ui/Field.svelte'
  import NumberField from '../../../ui/NumberField.svelte'
  import Select from '../../../ui/Select.svelte'
  import TextField from '../../../ui/TextField.svelte'
  import Toggle from '../../../ui/Toggle.svelte'
  import { clipLabel, clipRefOf, MASK_PRESETS, maskPreset } from '../rules.ts'
  import Windows from './Windows.svelte'

  type Layer = Extract<Adjustment, { kind: 'layer' }>
  let { character, clipSlot: slot, adjustment: a }: { character: Character, clipSlot: Slot, adjustment: Layer } = $props()

  const set = (patch: Record<string, unknown>): void => { void adjust.update(character, slot.id, a.id, patch) }

  const LIBRARY = '(library)'
  const others = $derived(character.clips.filter(o => o.id !== slot.id && !wouldCycle(character, slot, o.id)))
  const playing = $derived(a.play.kind === 'slot' ? a.play.slot : LIBRARY)
  const options = $derived([
    ...others.map(o => ({ value: o.id, label: o.name, group: 'Its clips, as they play' })),
    { value: LIBRARY, label: a.play.kind === 'clip' ? `${clipLabel(a.play.clip)} (library)` : 'A library clip…', group: 'Library' },
  ])

  const PART_LABEL: Record<BodyPart, string> = { hips: 'Hips', torso: 'Torso', head: 'Head', leftArm: 'Left arm', rightArm: 'Right arm', leftLeg: 'Left leg', rightLeg: 'Right leg' }
  const preset = $derived(maskPreset(a.mask))
  function tick (part: BodyPart, on: boolean): void {
    const next = BODY_PARTS.filter(p => (p === part ? on : a.mask.includes(p)))
    if (next.length > 0) set({ mask: next })
  }

  // (a library search, for this character's skeleton, when a library clip is wanted)
  let searching = $state(untrack(() => a.play.kind === 'clip'))
  let query = $state('')
  let found = $state.raw<LibraryClip[]>([])
  let token = 0
  $effect(() => {
    if (!searching) return
    const q = query
    const t = ++token
    const timer = setTimeout(() => {
      void api.library({ q, size: 8, rig: character.skeleton.template }).then(page => { if (t === token) found = page.clips }).catch(() => { if (t === token) found = [] })
    }, 180)
    return () => { clearTimeout(timer) }
  })
</script>

<div class="layer">
  <Field label="Plays" group>
    <Select size="sm" label="What it plays" value={playing} {options}
      onchange={(v) => { if (v === LIBRARY) searching = true; else { searching = false; set({ play: { kind: 'slot', slot: v } }) } }} />
  </Field>
  {#if searching}
    <div class="search">
      <TextField size="sm" type="search" bind:value={query} placeholder="Search the library" label="Search the library" />
      {#each found as clip (clip.id)}
        <button class="hit" onclick={() => { set({ play: { kind: 'clip', clip: clipRefOf(clip) } }) }}>{clip.name}</button>
      {/each}
    </div>
  {/if}
  <Field label="On" group>
    <Select size="sm" label="Which parts" value={preset}
      options={[...MASK_PRESETS.map(m => ({ value: m.value, label: m.label })), { value: 'custom', label: 'Parts ticked below' }]}
      onchange={(v) => { const m = MASK_PRESETS.find(x => x.value === v); if (m !== undefined) set({ mask: m.parts }) }} />
  </Field>
  <div class="parts">
    {#each BODY_PARTS as part (part)}
      <label><input type="checkbox" checked={a.mask.includes(part)} onchange={(e) => { tick(part, e.currentTarget.checked) }} /> {PART_LABEL[part]}</label>
    {/each}
  </div>
  <Field label="When" stack>
    <Windows windows={a.windows === undefined ? undefined : adjust.shown(slot.id, a.windows)} whole frames={adjust.frames(slot.id)} playhead={adjust.playhead(slot.id)}
      onchange={(next: Window[] | undefined) => set({ windows: next ?? null })} />
  </Field>
  <div class="row">
    <Field label="From" group hint="s into it">
      <NumberField size="sm" width="72px" value={a.offset ?? 0} min={0} step={0.05} digits={2} unit="s" label="Starts this far into what it plays" onchange={(v) => set({ offset: v > 0 ? v : null })} />
    </Field>
    {#if a.windows !== undefined}
      <Field label="Fade" group>
        <NumberField size="sm" width="72px" value={a.fade ?? 0} min={0} max={5} step={0.05} digits={2} unit="s" label="Fade" onchange={(v) => set({ fade: v > 0 ? v : null })} />
      </Field>
    {/if}
  </div>
  <Toggle checked={a.loop === true} label="Loop it" hint="Past its end it starts over (else it holds its last pose)" onchange={(on) => set({ loop: on ? true : null })} />
</div>

<style>
  .layer { display: flex; flex-direction: column; gap: 6px; }
  .search { display: flex; flex-direction: column; gap: 3px; }
  .hit { text-align: left; height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .hit:hover { background: var(--bg-3); color: var(--text-1); }
  .parts { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 2px 8px; font-size: 12px; color: var(--text-2); }
  .parts label { display: flex; align-items: center; gap: 4px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
</style>
