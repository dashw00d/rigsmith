<script lang="ts">
  // "Other ways to wear it": a piece rides one bone unless it is worn on the skin (each vertex moves like the skin under
  // it: clothing) or pinned to one spot of the skin (a buckle, a pouch; with its own animation, a mechanism). Changing
  // the way replaces how it follows the body whole (gear.attach), keeping where it sits.
  import { Bone, Crosshair, MapPin, Shirt } from '@lucide/svelte'
  import type { Character, Gear, GearAttach, SkinPolicy } from '../../state/api.ts'
  import { gearAnimations, POLICIES } from '../../engine/garments.ts'
  import { gear as gearState, type WearKind } from '../../state/gear.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Select from '../../ui/Select.svelte'
  import Toggle from '../../ui/Toggle.svelte'

  let { character, gear }: { character: Character, gear: Gear } = $props()

  const KINDS: Array<{ value: WearKind, label: string, icon: typeof Bone, hint: string }> = [
    { value: 'bone', label: 'On a bone', icon: Bone, hint: 'Rigid on one bone: a weapon, a tool, a shield, a helmet' },
    { value: 'skin', label: 'On the skin', icon: Shirt, hint: 'Each vertex moves like the skin under it: clothing' },
    { value: 'spot', label: 'On a spot', icon: MapPin, hint: 'Pinned to one spot of the skin, moving without bending: a buckle, a pouch' },
  ]
  const a = $derived(gear.attach)
  const skin = $derived(a.kind === 'skin' ? a : null)
  const spot = $derived(a.kind === 'spot' ? a : null)
  const picking = $derived(gearState.picking?.kind === 'spot' && gearState.picking.gear === gear.id)

  // a spot piece's own animations (a mechanism's), from its model
  let clips = $state<string[]>([])
  $effect(() => {
    const url = spot === null || gear.status !== 'ready' ? null : gearState.urlOf(character, gear)
    const id = gear.id
    clips = []
    if (url === null) return
    let live = true
    gearAnimations(url).then(list => { if (live && gear.id === id) clips = list }, () => {})
    return () => { live = false }
  })

  function setSkin (change: Partial<Extract<GearAttach, { kind: 'skin' }>>): void {
    void gearState.setAttach(character, gear, change)
  }
</script>

<details open={a.kind !== 'bone'}>
  <summary>Other ways to wear it</summary>
  <div class="body">
    <Segmented options={KINDS} value={a.kind} size="sm" label="How it follows the body" onchange={(k) => gearState.setKind(character, gear, k)} />
    <p class="hint">{KINDS.find(k => k.value === a.kind)?.hint}</p>
    {#if skin !== null}
      <Field label="Follows">
        <Select size="sm" options={POLICIES.map(p => ({ value: p.id, label: p.label }))} value={skin.policy} label="Follows"
          onchange={(policy: SkinPolicy) => setSkin({ policy })} />
      </Field>
      <p class="hint">{POLICIES.find(p => p.id === skin.policy)?.hint}</p>
      <Toggle label="Hide the body under it" hint="Skin it covers is hidden so it can't poke through (here only: the game keeps the body whole)"
        checked={skin.hideBody === true} onchange={(on) => setSkin({ hideBody: on ? true : undefined })} />
    {:else if spot !== null}
      <Field label="Pinned to" group>
        <span class="value">{spot.anchor !== undefined ? 'the spot picked' : 'the skin nearest its middle'}</span>
      </Field>
      <div class="row">
        <Button size="sm" variant={picking ? 'primary' : 'secondary'} onclick={() => (picking ? gearState.stopPicking() : gearState.pickSpot(character, gear))}>
          <Crosshair size={12} /> {picking ? 'Click the body… (Esc)' : 'Pick the spot'}
        </Button>
        {#if spot.anchor !== undefined}
          <Button size="sm" variant="ghost" onclick={() => gearState.setAttach(character, gear, { anchor: undefined })}>Use the nearest skin</Button>
        {/if}
      </div>
      {#if clips.length > 0}
        <Field label="Its own animation">
          <Select size="sm" options={[{ value: '', label: 'None (still)' }, ...clips.map(c => ({ value: c, label: c }))]} value={spot.animation ?? ''}
            label="Its own animation" onchange={(v) => gearState.setAttach(character, gear, { animation: v === '' ? undefined : v })} />
        </Field>
        {#if spot.animation !== undefined}
          <p class="hint">Playing, it rides the spot's leading bone, its own parts moving inside it. The game gets it still.</p>
        {/if}
      {/if}
    {/if}
  </div>
</details>

<style>
  details { border-top: 1px solid var(--line); padding-top: 8px; }
  summary { cursor: pointer; font-size: 12.5px; color: var(--text-2); }
  summary:hover { color: var(--text-1); }
  .body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
  .hint { margin: 0; font-size: 12px; color: var(--text-3); }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  .value { font-size: 12.5px; color: var(--text-2); }
</style>
