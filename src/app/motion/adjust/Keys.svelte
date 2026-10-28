<script lang="ts">
  // Keys: turns on bones (and the pelvis's moves), moves and turns of gear from where it is placed, at frames of the
  // clip as it plays. Pick what to key, pause on a frame and drag the gizmo: letting go keys it there. Between keys it
  // blends; a loop's keys wrap round, a one-shot's hold before the first and after the last.
  import { onDestroy } from 'svelte'
  import { Anchor, KeyRound, Move3d, Rotate3d, Trash2 } from '@lucide/svelte'
  import type { Adjustment, Character, ClipKey, Slot } from '../../../state/api.ts'
  import { app } from '../../../state/app.svelte.ts'
  import { adjust } from '../../../state/adjust.svelte.ts'
  import { animator } from '../../../state/animator.svelte.ts'
  import { gearNode } from '../../../engine/geom.ts'
  import Button from '../../../ui/Button.svelte'
  import Field from '../../../ui/Field.svelte'
  import IconButton from '../../../ui/IconButton.svelte'
  import Select from '../../../ui/Select.svelte'
  import { frameOf, keysOf, keyText, targetOf } from '../rules.ts'

  let { character, clipSlot: slot, adjustment: a }: { character: Character, clipSlot: Slot, adjustment: Extract<Adjustment, { kind: 'keys' }> } = $props()

  const view = $derived(animator.view)
  const playing = $derived(adjust.playingSlot(slot.id))
  const frames = $derived(adjust.frames(slot.id))
  const playhead = $derived(adjust.playhead(slot.id))
  const bones = $derived(view?.rest?.order.filter(b => view.bones.has(b)) ?? [])
  // (gear on a bone that is on stage; catalog gear not yet placed in rest space has no keys of its own)
  const pieces = $derived(character.gear.filter(g => g.attach.kind === 'bone' && g.attach.legacyFrame === undefined &&
    view?.root.getObjectByName(gearNode(g)) !== undefined))
  const options = $derived([
    { value: '', label: 'Nothing' },
    ...pieces.map(g => ({ value: `gear:${g.id}`, label: g.name, group: 'Gear' })),
    ...bones.map(b => ({ value: `bone:${b}`, label: b, group: 'Bones' })),
  ])
  const keys = $derived(adjust.target === null ? [] : keysOf(a, adjust.target))
  const keyed = $derived([
    ...pieces.filter(g => (a.gear?.[g.id]?.length ?? 0) > 0).map(g => ({ target: `gear:${g.id}`, name: g.name, count: a.gear![g.id].length })),
    ...Object.entries(a.bones ?? {}).filter(([, k]) => k.length > 0).map(([n, k]) => ({ target: `bone:${n}`, name: n, count: k.length })),
  ])
  const moves = $derived(adjust.moves(adjust.target))
  const targetName = $derived.by(() => {
    const t = adjust.target === null ? null : targetOf(adjust.target)
    if (t === null) return ''
    return t.kind === 'gear' ? character.gear.find(g => g.id === t.name)?.name ?? 'gear' : t.name
  })

  // (the gizmo on what is keyed while this clip plays here, in the Motion step)
  $effect(() => {
    void adjust.target; void adjust.mode; void playing; void character
    adjust.show(character, slot.id, app.step === 'motion' && a.enabled)
  })
  onDestroy(() => { adjust.hide() })

  function go (k: ClipKey): void { adjust.seekPhase(k.u) }
</script>

<div class="keys">
  {#if !a.enabled}<p class="faint note">Switched off: its keys don’t play. Switch it on to key.</p>{/if}
  <Field label="Key">
    <Select size="sm" label="What to key" value={adjust.target ?? ''} {options} onchange={(v) => { adjust.target = v === '' ? null : v }} />
  </Field>

  {#if adjust.target !== null}
    <div class="row">
      <Button size="sm" variant={adjust.mode === 'rotate' ? 'secondary' : 'ghost'} aria-pressed={adjust.mode === 'rotate'} onclick={() => { adjust.mode = 'rotate' }}><Rotate3d size={13} /> Turn</Button>
      <Button size="sm" variant={adjust.mode === 'translate' ? 'secondary' : 'ghost'} aria-pressed={adjust.mode === 'translate'} disabled={!moves} onclick={() => { adjust.mode = 'translate' }}
        title={moves ? undefined : 'Only gear and the pelvis move; bones turn'}><Move3d size={13} /> Move</Button>
      <span class="faint mono frame">{playhead !== null && frames !== null ? `frame ${frameOf(playhead, frames)} / ${frames}` : 'not playing'}</span>
    </div>
    <p class="faint note">
      {playing === null ? 'Play this clip and pause on a frame to key it.' : 'Pause on a frame (Space; , and . step) and drag the gizmo: letting go keys it there.'}
      Between keys it blends; {slot.loop ? 'round the loop' : 'before the first and after the last it holds'}.
    </p>
    <div class="row">
      <Button size="sm" disabled={playing === null || !a.enabled} onclick={() => adjust.commit(character.id, slot.id)} title="Key it as it stands at this frame"><KeyRound size={12} /> Key here</Button>
      <Button size="sm" disabled={playing === null || !a.enabled} onclick={() => adjust.noChangeHere(character, slot.id)}
        title="A key with no change: the clip as it is at this frame (keeps a tweak from spreading past it)"><Anchor size={12} /> No change here</Button>
    </div>
    {#if keys.length > 0}
      <ul class="list">
        {#each keys as k (k.u)}
          <li>
            <button class="go mono" disabled={playing === null} onclick={() => go(k)}>{frames !== null ? `frame ${frameOf(k.u, frames)}` : `${Math.round(k.u * 100)}%`}</button>
            <span class="faint">{keyText(k)}</span>
            <IconButton label="Delete this key" size="sm" variant="danger" onclick={() => adjust.setKeys(character, slot.id, adjust.target!, ks => ks.filter(x => x.u !== k.u))}><Trash2 size={12} /></IconButton>
          </li>
        {/each}
      </ul>
      <Button size="sm" variant="ghost" onclick={() => adjust.setKeys(character, slot.id, adjust.target!, () => [])}>Clear {targetName}</Button>
    {/if}
  {/if}

  {#if keyed.length > 0}
    <p class="faint note">Keyed: {#each keyed as k, i (k.target)}<button class="link" onclick={() => { adjust.target = k.target }}>{k.name} ({k.count})</button>{i < keyed.length - 1 ? ', ' : ''}{/each}</p>
  {/if}
</div>

<style>
  .keys { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .frame { margin-left: auto; font-size: 11px; }
  .note { margin: 0; font-size: 12px; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .list li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .list li .faint { flex: 1; }
  .go, .link { border: 0; background: transparent; color: var(--accent-strong); font-size: 12px; padding: 0; }
  .go:disabled { color: var(--text-2); cursor: default; }
</style>
