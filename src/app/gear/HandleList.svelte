<script lang="ts">
  // Where hands hold a bone piece (src/model/types.ts Handle): its carry handle (the hand it rides, closed on it in
  // every clip), grips for another hand, and pulls (a point another bone draws: a bowstring). When a pull is held is
  // each slot's own (a Handle hold adjustment, in Motion): listed here, changed there.
  import { Crosshair, Plus, Trash2 } from '@lucide/svelte'
  import { handSide } from '../../model/select.ts'
  import type { Character, Gear, Handle, Side } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import Select from '../../ui/Select.svelte'
  import TextField from '../../ui/TextField.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import HandPoseSelect from '../hands/HandPoseSelect.svelte'
  import { boneChoices, boneLabel, handlesInOrder, holdsOf } from './text.ts'

  interface Props {
    character: Character
    gear: Gear
    /** A handle to bring into view (the Hands panel's link to it). */
    highlight?: string | null
  }
  let { character, gear, highlight = null }: Props = $props()

  const list = $derived(handlesInOrder(gear))
  const carried = $derived(gear.attach.kind === 'bone' ? handSide(gear.attach.bone) : null)
  const worn = $derived(gearState.isWorn(gear.id))
  const pulls = $derived(list.filter(h => h.kind === 'pull'))
  const bones = $derived(boneChoices(character))
  // (a piece carried in one hand is gripped by the other)
  const other = $derived<Side>(carried === 'Right' ? 'Left' : 'Right')
  const SIDES: Side[] = ['Left', 'Right']

  const HANDS: Array<{ value: '' | Side, label: string }> = [
    { value: '', label: 'Either hand' }, { value: 'Left', label: 'Left hand' }, { value: 'Right', label: 'Right hand' },
  ]

  const picking = (h: Handle): boolean => gearState.picking?.kind === 'pull' && gearState.picking.handle === h.id
  function pick (h: Handle): void {
    if (picking(h)) gearState.stopPicking()
    else gearState.pickPull(character, gear, h)
  }

  function rename (h: Handle, text: string): void {
    const name = text.trim()
    if (name !== '' && name !== h.name) void gearState.updateHandle(character, gear, h, { name })
  }

  // (brought into view when the Hands panel links to it)
  function reveal (node: HTMLElement, on: boolean) {
    const go = (now: boolean): void => { if (now) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
    go(on)
    return { update: go }
  }
</script>

{#each list as h (h.id)}
  <div class="handle" class:lit={highlight === h.id} use:reveal={highlight === h.id}>
    {#if h.kind === 'carry'}
      <div class="head">
        <strong>Carried</strong>
        <span class="faint">in the {h.hand ?? carried ?? ''} hand</span>
      </div>
      <Field label="Its hand" hint="Closed on it in every clip, unless a slot opens it">
        <HandPoseSelect {character} side={h.hand} value={h.pose} onchange={(v) => gearState.updateHandle(character, gear, h, { pose: v ?? null })} />
      </Field>
      <Toggle label="Held exactly" hint="In the editor the hand stays at its hold, without slipping along it"
        checked={h.exact === true} onchange={(on) => gearState.updateHandle(character, gear, h, { exact: on ? true : null })} />
      {#if h.place !== undefined}
        <div class="row">
          <span class="faint small">Held where the editor put the hand</span>
          <Button size="sm" variant="ghost" onclick={() => gearState.updateHandle(character, gear, h, { place: null })}>Use its placement</Button>
        </div>
      {/if}
    {:else}
      <div class="head">
        <TextField size="sm" value={h.name} label="{h.kind === 'grip' ? 'Grip' : 'Pull'} name" oncommit={(v) => rename(h, v)} />
        <span class="kind">{h.kind}</span>
        <IconButton size="sm" variant="danger" label="Remove {h.name}" onclick={() => gearState.removeHandle(character, gear, h)}><Trash2 size={13} /></IconButton>
      </div>
      {#if h.kind === 'grip'}
        <Field label="For">
          <Select size="sm" options={HANDS} value={h.hand ?? ''} label="For which hand"
            onchange={(v) => gearState.updateHandle(character, gear, h, { hand: v === '' ? null : v })} />
        </Field>
        <Field label="Its hand" hint="What the hand closes to on it">
          <HandPoseSelect {character} side={h.hand} value={h.pose} unsetLabel="As the hand is held" onchange={(v) => gearState.updateHandle(character, gear, h, { pose: v ?? null })} />
        </Field>
        <Toggle label="Held exactly" hint="In the editor the hand stays at the grip, without slipping along it"
          checked={h.exact === true} onchange={(on) => gearState.updateHandle(character, gear, h, { exact: on ? true : null })} />
        {#if h.place === undefined}<p class="faint small">Not placed yet: the editor places it when a hand takes hold.</p>{/if}
      {:else if h.pull !== undefined}
        {@const pull = h.pull}
        {@const holds = holdsOf(character, gear.id, h.id)}
        <Field label="Drawn by">
          <Select size="sm" options={(bones.includes(pull.bone) ? bones : [pull.bone, ...bones]).map(b => ({ value: b, label: boneLabel(b) }))}
            value={pull.bone} label="Drawn by" onchange={(b) => gearState.setPullBone(character, gear, h, b)} />
        </Field>
        {#if handSide(pull.bone) !== null}
          <Field label="Its hand" hint="While it draws">
            <HandPoseSelect {character} side={handSide(pull.bone) ?? undefined} value={h.pose} unsetLabel="No change"
              onchange={(v) => gearState.updateHandle(character, gear, h, { pose: v ?? null })} />
          </Field>
        {/if}
        <div class="row">
          <Button size="sm" variant={picking(h) ? 'primary' : 'secondary'} disabled={!worn} onclick={() => pick(h)}>
            <Crosshair size={12} /> {picking(h) ? 'Click the piece… (Esc)' : 'Pick its point'}
          </Button>
        </div>
        <div class="holds">
          <span class="faint small">Held in</span>
          {#if holds.length === 0}
            <span class="faint small">no slot yet:</span>
            <button class="link" onclick={() => app.go('motion')} use:tooltip={'Add a Handle hold to a slot in Motion'}>set it in Motion</button>
          {:else}
            {#each holds as hold (hold.adjustment)}
              <button class="link" class:off={!hold.enabled} use:tooltip={hold.enabled ? 'Change it in Motion' : 'Turned off; change it in Motion'}
                onclick={() => hands.reveal({ step: 'motion', slot: hold.slot.id, adjustment: hold.adjustment })}>
                {hold.slot.name} <span class="mono">{hold.when}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/each}

<div class="adds">
  {#if carried !== null}
    <Button size="sm" disabled={!worn} onclick={() => gearState.addGrip(character, gear, other)}
      title="A grip where the {other.toLowerCase()} hand is on it now (pause a clip on a frame where it holds it)"><Plus size={13} /> {other} hand grip</Button>
  {:else}
    {#each SIDES as side (side)}
      <Button size="sm" disabled={!worn} onclick={() => gearState.addGrip(character, gear, side)}
        title="A grip where the {side.toLowerCase()} hand is on it now (pause a clip on a frame where it holds it)"><Plus size={13} /> {side} hand grip</Button>
    {/each}
  {/if}
  <Button size="sm" disabled={!worn} onclick={() => gearState.addPull(character, gear)}><Plus size={13} /> Pull</Button>
</div>
{#if pulls.length === 0}
  <p class="faint small">A pull is a point of it another hand draws while a slot holds it: a bowstring. It starts on its longest, thinnest part,
    which bends there; paint below which parts follow it.</p>
{/if}

<style>
  .handle { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: 1px solid var(--line); border-radius: var(--r-1); transition: background var(--med); }
  .handle:first-child { border-top: 0; padding-top: 0; }
  .handle.lit { background: var(--accent-soft); }
  .head { display: flex; align-items: center; gap: 6px; }
  .head :global(input) { flex: 1; min-width: 0; }
  .kind { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .holds { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
  .link { border: 0; background: transparent; padding: 0; color: var(--accent-strong); font-size: 12px; text-align: left; }
  .link.off { color: var(--text-3); text-decoration: line-through; }
  .adds { display: flex; flex-wrap: wrap; gap: 6px; }
  .small { font-size: 12px; margin: 0; }
  .faint { color: var(--text-3); }
  .mono { font-family: var(--mono); font-size: 11px; }
</style>
