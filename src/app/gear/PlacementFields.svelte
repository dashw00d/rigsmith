<script lang="ts">
  // Where a piece sits: the gizmo's mode, and the same placement as numbers (one placement: dragging the gizmo and
  // typing both send gear.place). In the character's rest space: position in its units, turns in degrees, one size.
  import { Move3d, Rotate3d, RotateCcw, Scale3d } from '@lucide/svelte'
  import type { Character, Gear, Vec3 } from '../../state/api.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import { gizmo, type GizmoMode } from '../../state/gizmo.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import NumberField from '../../ui/NumberField.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import { allowsShortcut } from '../../ui/shortcuts.ts'

  let { character, gear }: { character: Character, gear: Gear } = $props()

  const modes: Array<{ value: GizmoMode, label: string, icon: typeof Move3d, hint: string }> = [
    { value: 'translate', label: 'Move', icon: Move3d, hint: 'Move it (W)' },
    { value: 'rotate', label: 'Turn', icon: Rotate3d, hint: 'Turn it (E)' },
    { value: 'scale', label: 'Size', icon: Scale3d, hint: 'Size it (R)' },
  ]
  // (a piece still in the old catalog frame has no rest-space placement until its rig is on stage to convert it)
  const legacy = $derived(gear.attach.kind === 'bone' && gear.attach.legacyFrame === 'grip' && !gearState.isWorn(gear.id))
  const place = $derived.by(() => { void gearState.worn; return gearState.placeOf(gear) })
  const AXES = ['X', 'Y', 'Z'] as const

  function set (key: 'position' | 'rotation', i: number, v: number): void {
    const next = [...place[key]] as Vec3
    next[i] = v
    void gearState.place(character, gear, { [key]: next })
  }

  function onkeydown (event: KeyboardEvent): void {
    // (the gizmo's keys, as in other 3D tools; not while typing)
    if (!allowsShortcut(event) || gizmo.target === null) return
    const mode = ({ w: 'translate', e: 'rotate', r: 'scale' } as Record<string, GizmoMode | undefined>)[event.key.toLowerCase()]
    if (mode !== undefined) { gizmo.mode = mode; event.preventDefault() }
  }
</script>

<svelte:window {onkeydown} />

{#if legacy}
  <p class="note">Kept as the old catalog placed it until {character.name}'s rig is on stage.</p>
{:else}
  <Segmented options={modes} value={gizmo.mode} size="sm" label="Gizmo" onchange={(m) => { gizmo.mode = m }} />
  <div class="xyz" role="group" aria-label="Placement">
    <span class="label">Position</span>
    {#each AXES as axis, i (axis)}
      <NumberField size="sm" width="100%" step={0.01} digits={4} value={place.position[i]} label="Position {axis}" onchange={(v) => set('position', i, v)} />
    {/each}
    <span class="label">Turn</span>
    {#each AXES as axis, i (axis)}
      <NumberField size="sm" width="100%" step={5} digits={1} unit="°" value={place.rotation[i]} label="Turn {axis}" onchange={(v) => set('rotation', i, v)} />
    {/each}
    <span class="label">Size</span>
    <div class="wide">
      <NumberField size="sm" width="100%" step={0.05} min={0.001} digits={3} value={place.scale} label="Size" onchange={(v) => gearState.place(character, gear, { scale: v })} />
    </div>
  </div>
  {#if gear.catalog !== undefined}
    <Button size="sm" variant="ghost" onclick={() => gearState.resetPlacement(character, gear)}><RotateCcw size={13} /> Back to the catalog's placement</Button>
  {/if}
{/if}

<style>
  .xyz { display: grid; grid-template-columns: 62px repeat(3, minmax(0, 1fr)); gap: 6px; align-items: center; }
  .label { font-size: 12px; color: var(--text-3); }
  .wide { grid-column: span 3; }
  .note { margin: 0; font-size: 12px; color: var(--text-3); }
</style>
