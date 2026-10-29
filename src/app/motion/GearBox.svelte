<script lang="ts">
  // A piece of gear selected in Motion (clicked in the viewport or its timeline row): whether it leads the body in this
  // clip (slot.ik.lead), what its gizmo moves, and each hand on it: the handle it holds in this clip (slot.ik.hands),
  // how it closes on it, and the pulls on the piece. Handles and hand poses are the character's (every clip); which
  // hand holds what, and when, is this clip's (the Hands track's bars).
  import { Trash2, X } from '@lucide/svelte'
  import type { Character, Side, Slot } from '../../model/types.ts'
  import { pose } from '../../state/pose.svelte.ts'
  import { handSide } from '../../model/select.ts'
  import { prettyBone } from '../../engine/mixamo.ts'
  import HandPoseSelect from '../hands/HandPoseSelect.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import Select from '../../ui/Select.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let { character, slot, gear }: { character: Character, slot: Slot, gear: string } = $props()

  const SIDES: Side[] = ['Left', 'Right']
  const p = $derived(pose.pieceOf(gear))
  const leads = $derived(pose.leading(slot, gear))
  const busy = $derived(pose.busy !== null)
  const inHand = $derived(pose.inHand || !leads)
</script>

{#if p !== undefined}
  <div class="gearbox">
    <div class="row">
      <strong class="small">{p.name}</strong>
      <span class="faint small">on {prettyBone(p.bone)}</span>
      <span class="spacer"></span>
      <IconButton size="sm" label="Deselect" hint="Deselect (Esc)" onclick={() => pose.selectGear(null)}><X size={13} /></IconButton>
    </div>
    <Toggle label="Leads the body" hint={pose.natural ? `In ${slot.name}: the hands on it follow its path; turning it on fits the path to the body` : 'Gear leads the body only on a person'}
      checked={leads} disabled={busy || (!pose.natural && !leads)} onchange={(on) => { void pose.setLeading(gear, on) }} />
    {#if leads}
      <Toggle label="Moves in the hand" hint={`Dragging it moves it where ${prettyBone(p.bone)} holds it; whatever holds it stays`} checked={pose.inHand} onchange={(on) => { pose.inHand = on }} />
    {/if}
    <Toggle label={inHand ? 'In every clip' : 'Move entire path'}
      hint={inHand ? `The gizmo changes how it sits on ${prettyBone(p.bone)} in every clip (its placement). Off: a key on this frame` : 'The gizmo moves every frame of its path. Off: a key on this frame'}
      checked={pose.moves === 'every'} onchange={(on) => { pose.moves = on ? 'every' : 'frame' }} />

    {#each SIDES as hand (hand)}
      {@const carries = pose.carries(hand, gear)}
      {@const on = slot.ik?.hands.find(a => a.hand === hand && a.gear === gear)}
      {@const choices = pose.handleChoices(slot, hand, gear)}
      {@const handle = on === undefined ? undefined : p.gear.handles.find(h => h.id === on.handle)}
      {#if carries || on !== undefined || choices.length > 0}
        <div class="hand">
          <div class="row">
            <span class="small">{hand} hand{carries ? ' · carries it' : ''}</span>
            <Select size="sm" label={`${hand} hand's handle on ${p.name}`} value={on?.handle ?? ''} disabled={busy}
              options={[{ value: '', label: carries ? 'As placed' : 'Not on it' }, ...choices.map(h => ({ value: h.id, label: h.name, disabled: h.taken }))]}
              onchange={(v) => { if (v === '') void pose.detach(hand); else void pose.attach(hand, gear, v) }} />
          </div>
          {#if handle !== undefined && handle.kind === 'grip'}
            <div class="row">
              <Toggle label="Exactly here" hint="The hand stays on this spot (no give or slide on the shaft)" checked={handle.exact === true} onchange={(x) => { void pose.setExact(gear, handle.id, x) }} />
              <IconButton size="sm" variant="danger" label={`Remove ${handle.name}`} hint="Take this grip handle off the gear (every clip)" onclick={() => { void pose.removeHandle(gear, handle.id) }}><Trash2 size={12} /></IconButton>
            </div>
          {/if}
          {#if carries || on !== undefined}
            <div class="row" use:tooltip={pose.handPoseHint(slot, hand, gear)}>
              <span class="small faint">Hand pose</span>
              <HandPoseSelect {character} side={hand} value={pose.handPoseOf(slot, hand, gear)} unsetLabel={pose.handPoseSet(slot, hand, gear) ? 'As its other layers have it' : undefined}
                onchange={(v) => { void pose.setHandPose(slot, hand, gear, v) }} />
            </div>
          {/if}
        </div>
      {/if}
    {/each}
    {#if p.gear.handles.every(h => h.kind !== 'grip')}<p class="faint small">Let a free hand go on its shaft to make a grip there and hold it.</p>{/if}

    {#each pose.pullsOn(gear) as pull (pull.id)}
      {@const side = pull.hand ?? handSide(pull.pull?.bone ?? '')}
      <div class="hand">
        <div class="row">
          <span class="small">{side !== null ? `${side} hand` : prettyBone(pull.pull?.bone ?? '')} · pulls {pull.name}</span>
          {#if side !== null}
            <span use:tooltip={'Its pose while it holds the pull, in every clip'}>
              <HandPoseSelect {character} {side} value={pull.pose} unsetLabel="As the hand is" onchange={(v) => { void pose.setPullPose(gear, pull.id, v) }} />
            </span>
          {/if}
        </div>
      </div>
    {/each}
    <p class="faint small">When a hand holds it, lets go, or draws a pull is this clip's: the bars in the timeline's Hands track.</p>
  </div>
{/if}

<style>
  .gearbox { display: flex; flex-direction: column; gap: 7px; padding: 9px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent-soft); }
  .hand { display: flex; flex-direction: column; gap: 5px; padding: 6px 0 2px; border-top: 1px solid var(--line); }
  .row { display: flex; gap: 6px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .small { font-size: 12px; margin: 0; }
</style>
