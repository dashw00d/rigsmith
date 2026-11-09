<script lang="ts">
  // A posture: the body turned from how the clip holds it (src/engine/posture.ts): what turns (lean, twist, nod, arms
  // out...), by how many degrees (+ is the way the part's hint says), when (the whole clip, or windows, faded in and out
  // over a few tenths of a second). Each change is one command; the slider commits when it is let go.
  import type { Adjustment, Character, Slot, Window } from '../../../state/api.ts'
  import { adjust } from '../../../state/adjust.svelte.ts'
  import Field from '../../../ui/Field.svelte'
  import NumberField from '../../../ui/NumberField.svelte'
  import Select from '../../../ui/Select.svelte'
  import { POSTURE_OPTIONS } from '../rules.ts'
  import Windows from './Windows.svelte'

  type Posture = Extract<Adjustment, { kind: 'posture' }>
  let { character, clipSlot: slot, adjustment: a }: { character: Character, clipSlot: Slot, adjustment: Posture } = $props()

  const option = $derived(POSTURE_OPTIONS.find(o => o.value === a.part) ?? POSTURE_OPTIONS[0])
  const set = (patch: Record<string, unknown>): void => { void adjust.update(character, slot.id, a.id, patch) }
  // (the slider shows its value while dragged; the command goes when it is let go)
  let dragged = $state<number | null>(null)
  const shown = $derived(dragged ?? a.amount)
</script>

<div class="posture">
  <Field label="Turns" group>
    <Select size="sm" label="What turns" value={a.part} options={POSTURE_OPTIONS.map(o => ({ value: o.value, label: o.label, group: o.group }))}
      onchange={(v) => set({ part: v })} />
  </Field>
  <Field label="Amount" group hint={`+ ${option.plus}`}>
    <div class="amount">
      <input type="range" min="-45" max="45" step="0.5" value={shown} aria-label="Degrees"
        oninput={(e) => { dragged = Number(e.currentTarget.value) }}
        onchange={(e) => { const v = Number(e.currentTarget.value); dragged = null; set({ amount: v }) }} />
      <NumberField size="sm" width="64px" value={a.amount} min={-90} max={90} step={1} digits={1} unit="°" label="Degrees" onchange={(v) => set({ amount: v })} />
    </div>
  </Field>
  <Field label="When" stack>
    <Windows windows={a.windows === undefined ? undefined : adjust.shown(slot.id, a.windows)} whole frames={adjust.frames(slot.id)} playhead={adjust.playhead(slot.id)}
      onchange={(next: Window[] | undefined) => set({ windows: next ?? null })} />
  </Field>
  {#if a.windows !== undefined}
    <Field label="Fade" group hint="in and out at each window's ends">
      <NumberField size="sm" width="72px" value={a.fade ?? 0} min={0} max={5} step={0.05} digits={2} unit="s" label="Fade" onchange={(v) => set({ fade: v > 0 ? v : null })} />
    </Field>
  {/if}
</div>

<style>
  .posture { display: flex; flex-direction: column; gap: 6px; }
  .amount { display: flex; align-items: center; gap: 6px; }
  .amount input[type=range] { flex: 1; min-width: 80px; accent-color: var(--accent); }
</style>
