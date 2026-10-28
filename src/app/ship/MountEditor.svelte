<script lang="ts">
  // Mount: the horse he rides (picking one seats him on it, worked out from the two bodies, and makes it his unit's
  // ridden companion; Nothing gets him off), the bone he sits on, the seat placed with the gizmo, the bones held still in
  // it (any of his bones) and their pose, his size on the horse (from the game's heights), and the horse's coat and gear
  // for him. Every change is a mount command (src/state/mount.svelte.ts).
  import { Armchair, Crosshair, Footprints, Move3d, RefreshCw, Rotate3d, X } from '@lucide/svelte'
  import { phaseOf } from '../../model/select.ts'
  import { LOWER_BODY } from '../../engine/mount.ts'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { seat } from '../../state/mount.svelte.ts'
  import { ship } from '../../state/ship.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import NumberField from '../../ui/NumberField.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Select from '../../ui/Select.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let { character }: { character: Character } = $props()

  const m = $derived(character.mount)
  const rigged = $derived(phaseOf(character).phase === 'rigged')
  const onStage = $derived(seat.rider !== null && viewer.shownId === character.id)
  const horse = $derived(m === undefined ? null : app.byId(m.character))
  const horses = $derived(seat.horses(character))
  const rideOptions = $derived([
    { value: '', label: 'Nothing (on foot)' },
    ...horses.map(h => ({ value: h.id, label: h.name })),
    ...(m !== undefined && !horses.some(h => h.id === m.character) ? [{ value: m.character, label: `${horse?.name ?? m.character} (not rigged)` }] : []),
  ])
  // (the horse on stage under him: its bones are where the seat can hang)
  const horseShown = $derived(viewer.mount !== null && m !== undefined && viewer.mount.character.id === m.character)
  const horseBones = $derived(horseShown ? seat.horseBones() : [])
  const boneOptions = $derived((m === undefined || horseBones.includes(m.bone) ? horseBones : [m.bone, ...horseBones]).map(b => ({ value: b, label: b })))
  const bones = $derived(onStage ? seat.bones() : [])
  const holdable = $derived(m === undefined ? [] : bones.filter(b => !m.freeze.includes(b)))
  const legsHeld = $derived(m === undefined || LOWER_BODY.filter(b => bones.includes(b)).every(b => m.freeze.includes(b)))
  const size = $derived(seat.size(character))
  const target = $derived(seat.target)
  const moves = $derived(target !== null && seat.moves(target))
  const skins = $derived(horse?.look.skins ?? [])
  const horseGear = $derived(horse?.gear ?? [])
  const modes: Array<{ value: 'translate' | 'rotate', label: string, icon: typeof Move3d }> = [
    { value: 'translate', label: 'Move', icon: Move3d },
    { value: 'rotate', label: 'Turn', icon: Rotate3d },
  ]

  // (the pickers that act: drawn anew after each pick, so one refused or asked off shows what is)
  let picks = $state(0)
  async function ride (id: string): Promise<void> {
    picks++
    if (id === '' && m !== undefined) {
      const units = ship.unitsOf(character.id).filter(u => u.role === 'unit' && u.ours.companion?.ridden === true).map(u => u.name)
      const ok = await app.confirm({
        title: `Get ${character.name} off ${horse?.name ?? 'the horse'}?`,
        body: `His seat goes (Undo in Activity brings it back)${units.length > 0 ? `, and ${units.join(', ')} no longer ${units.length === 1 ? 'rides' : 'ride'} it in the game` : ''}.`,
        confirm: 'Get off',
      })
      if (!ok) return
    }
    await seat.ride(character, id === '' ? null : id)
    picks++
  }
  async function again (horseId: string): Promise<void> {
    const ok = await app.confirm({
      title: 'Seat him anew?',
      body: 'His place on the horse, the bones held and their pose are worked out again from the two bodies (Undo in Activity brings the old seat back).',
      confirm: 'Seat him anew',
    })
    if (ok) await seat.ride(character, horseId)
  }
  const aim = (t: 'seat' | `bone:${string}`): void => { seat.aim(target === t ? null : t) }
  const k = (v: number): string => String(Math.round(v * 1000) / 1000)
</script>

{#if character.skeleton.template !== 'human'}
  <p class="faint small">Only a human rides: pick the horse on its rider's page.</p>
{:else if !rigged}
  <p class="faint small">Rig {character.name} first: the seat is worked out from his skeleton and the horse's.</p>
{:else}
  <Field label="Rides" hint="Picking a horse seats him on it and makes it his unit's horse in the game" group>
    <div class="with">
      {#key picks}
        <Select options={rideOptions} value={m?.character ?? ''} size="sm" label="Horse" disabled={!onStage || seat.busy !== null} onchange={ride} />
      {/key}
      {#if m !== undefined}
        <span use:tooltip={'Seat him anew, worked out from the two bodies (his held bones and their pose too)'}>
          <Button size="sm" variant="ghost" icon disabled={!onStage || seat.busy !== null} onclick={() => again(m.character)} aria-label="Seat him anew"><RefreshCw size={13} /></Button>
        </span>
      {/if}
    </div>
  </Field>
  {#if seat.busy !== null}<p class="faint small">{seat.busy}…</p>{/if}
  {#if horses.length === 0 && m === undefined}
    <p class="faint small">No horse to ride: rig a creature on the horse template first.</p>
  {/if}

  {#if m !== undefined}
    <Field label="Sits on" hint="The horse's bone the seat hangs from">
      <Select options={boneOptions} value={m.bone} size="sm" label="Horse bone" disabled={!horseShown} onchange={(b) => seat.update(character, { bone: b })} />
    </Field>

    {#if size !== null}
      {#if size.from === 'game'}
        <p class="faint small">His size on the horse comes from the game: him {size.rider}, the horse {size.horse} tall (×{k(size.k)} in its space).</p>
      {:else}
        <Field label="Size" hint="No game heights for both (make him a unit that rides this horse): his size in the horse's space">
          <NumberField value={m.scale ?? 1} onchange={(v) => seat.setScale(character, v)} min={0.05} max={20} step={0.05} digits={3} label="Size on the horse" />
        </Field>
      {/if}
    {/if}

    <div class="row">
      <Button size="sm" variant={target === 'seat' ? 'primary' : 'secondary'} disabled={!horseShown} onclick={() => aim('seat')} aria-pressed={target === 'seat'}><Armchair size={13} /> Place him</Button>
      <span use:tooltip={'His held bones as the clip playing has them at this frame (play a seated clip, pause on the frame)'}>
        <Button size="sm" variant="ghost" disabled={!seat.canTakePose} onclick={() => seat.takePose(character)}>Take the pose playing</Button>
      </span>
    </div>
    {#if target !== null}
      {#if moves}
        <Segmented options={modes} value={seat.mode} size="sm" label="Gizmo" onchange={(v) => seat.setMode(v)} />
      {/if}
      <p class="faint small">{target === 'seat' ? 'Drag him onto the horse.' : `Turn ${target.slice(5)} into the seat.`} Letting go saves it.</p>
    {/if}

    <div class="held-head">
      <span class="faint small">Held still in the seat</span>
      {#if !legsHeld}<button class="link" onclick={() => seat.holdLegs(character)}><Footprints size={11} /> Hips and legs</button>{/if}
    </div>
    <div class="held" role="group" aria-label="Held bones">
      {#each m.freeze as b (b)}
        <span class="chip" class:aimed={target === `bone:${b}`}>
          <button class="name" disabled={!onStage || !bones.includes(b)} onclick={() => aim(`bone:${b}`)} aria-pressed={target === `bone:${b}`} use:tooltip={'Shape it with the gizmo'}>
            <Crosshair size={10} /> {b}
          </button>
          <button class="x" onclick={() => seat.hold(character, b, false)} aria-label="Let {b} play" use:tooltip={`Let ${b} play with the clip`}><X size={10} /></button>
        </span>
      {/each}
      {#if holdable.length > 0}
        {#key picks}
          <Select options={holdable.map(b => ({ value: b, label: b }))} value={null} placeholder="+ hold a bone" size="sm" label="Hold a bone" onchange={(b) => { picks++; void seat.hold(character, b, true) }} />
        {/key}
      {/if}
    </div>
    <p class="faint small">The rest of him plays his clips (with his gear, hands and keys) over the horse's clip of the same name.</p>

    {#if horse !== null && (skins.length > 0 || m.skin !== undefined)}
      <Field label="Its coat" hint="The horse's look for him">
        <Select options={[{ value: '', label: 'Its own' }, ...skins.map(s => ({ value: s.name, label: s.name }))]} value={m.skin ?? ''} size="sm" label="Horse coat"
          onchange={(v) => seat.setSkin(character, v === '' ? null : v)} />
      </Field>
    {/if}
    {#if horse !== null && horseGear.length > 0}
      <div class="gear" role="group" aria-label="The horse's gear">
        <span class="faint small">Its gear for him</span>
        {#each horseGear as g (g.id)}
          <Toggle label={g.name} checked={m.gear?.includes(g.id) === true} onchange={(on) => seat.wear(character, g.id, on)} />
        {/each}
        <p class="note small">Shown here only: the game export leaves the horse's gear out (it never had it).</p>
      </div>
    {/if}
  {/if}
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .with { display: flex; align-items: center; gap: 4px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .held-head { display: flex; align-items: center; justify-content: space-between; }
  .held { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 4px 0 6px; border-radius: 11px; border: 1px solid var(--line-strong); font-size: 11.5px; color: var(--text-2); }
  .chip.aimed { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong); }
  .name { border: 0; background: transparent; padding: 0; color: inherit; font-size: inherit; display: inline-flex; align-items: center; gap: 3px; cursor: pointer; }
  .name:disabled { cursor: default; opacity: 0.6; }
  .x { border: 0; background: transparent; color: var(--text-4); display: grid; place-items: center; padding: 0; width: 14px; height: 14px; cursor: pointer; }
  .x:hover { color: var(--danger); }
  .gear { display: flex; flex-direction: column; gap: 4px; }
  .note { color: var(--warn); }
  .link { border: 0; background: transparent; padding: 0; color: var(--accent-strong); font-size: 11.5px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; }
  .link:hover { text-decoration: underline; }
</style>
