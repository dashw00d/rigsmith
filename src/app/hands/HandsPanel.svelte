<script lang="ts">
  // What each hand does and why (DESIGN.md §5), in the Gear and Motion steps. For the slot playing (with nothing
  // playing: what every clip starts from), each hand's layers from src/engine/hands.ts, bottom to top with their
  // reasons, the one closing the hand at the playhead lit as it plays, and where each is changed; the pose each hand is
  // held in through every clip. Then the character's named hand poses and the one open to shape.
  import { untrack } from 'svelte'
  import { ArrowUpRight } from '@lucide/svelte'
  import type { Character, Side } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import { slotById } from '../../model/select.ts'
  import { handAt, handLayers, refLabel, type HandLayer } from '../../engine/hands.ts'
  import Badge from '../../ui/Badge.svelte'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import Section from '../../ui/Section.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import HandPoseEditor from './HandPoseEditor.svelte'
  import HandPoseSelect from './HandPoseSelect.svelte'
  import HandPosesList from './HandPosesList.svelte'
  import { framesOf } from '../motion/rules.ts'
  import { fingerKeys, layerLinks, layerText, SIDES, sourceLabel } from './text.ts'

  let { character }: { character: Character } = $props()

  const human = $derived(character.skeleton.template === 'human')
  const fingered = $derived(character.skeleton.fingerLevel !== 'none')
  const open = $derived(hands.opened(character))

  // What plays, field by field (the playhead moving changes none of these).
  const playing = $derived(animator.playing?.characterId === character.id ? animator.playing : null)
  const slotId = $derived(playing?.slotId ?? null)
  const baked = $derived(playing?.baked ?? null)
  const shownLabel = $derived(playing === null ? null : playing.label)
  const slot = $derived(slotId === null ? undefined : slotById(character, slotId))
  /** A clip with a playhead to follow (else every clip: the layers that hold throughout). */
  const timed = $derived(slot !== undefined || baked !== null)
  const context = $derived(slot !== undefined ? `Playing ${slot.name}` : baked !== null
    ? `Previewing ${shownLabel ?? 'a clip'}` : shownLabel !== null ? `${shownLabel} · what every clip starts from`
      : 'Nothing playing: what every clip starts from')

  const layers = $derived.by((): Record<Side, HandLayer[]> => {
    // (a slot, or the slot the editor's clip is an edit of, as the character is now, so a change shows before it
    // replays; a library clip as it was baked)
    if (slot !== undefined) return { Left: handLayers(character, slot, 'Left'), Right: handLayers(character, slot, 'Right') }
    if (baked !== null) return baked.hands
    return { Left: handLayers(character, null, 'Left'), Right: handLayers(character, null, 'Right') }
  })
  // (keys on finger joints come after every layer, so they win over all of them)
  const keyed = $derived({ Left: fingerKeys(slot, 'Left'), Right: fingerKeys(slot, 'Right') })
  // Windows in frames of the clip as it plays (within one ridden cycle, as the timeline counts them) once it is baked;
  // else as parts of the clip (nothing playing, still baking, or the editor's clip, whose frames may not be the slot's).
  const frames = $derived(baked !== null && animator.duration > 0 ? framesOf(animator.duration, playing?.cycles ?? 1) : null)

  interface Won { index: number, weight: number }
  const winner = (list: HandLayer[], u: number): Won => {
    const at = handAt(list, u)
    return { index: at.layer === null ? -1 : list.indexOf(at.layer), weight: Math.round(at.weight * 20) / 20 }
  }
  let won = $state<Record<Side, Won>>({ Left: { index: -1, weight: 0 }, Right: { index: -1, weight: 0 } })

  // The winning layer at the playhead, followed frame by frame (set only when it changes).
  $effect(() => {
    const now = layers; const follow = timed
    const update = (phase: number): void => {
      // (the phase is the slot's own, within one cycle of a ridden loop: what hand windows are phases of)
      const u = follow ? phase : 0
      const next = { Left: winner(now.Left, u), Right: winner(now.Right, u) }
      const was = untrack(() => won)
      if (SIDES.some(s => next[s].index !== was[s].index || next[s].weight !== was[s].weight)) won = next
    }
    untrack(() => { update(animator.playing?.phase ?? 0) })
    return animator.onTick(phase => { update(phase) })
  })

  function nowText (list: HandLayer[], w: Won): string {
    // (`won` follows the playhead a tick behind: after a change of character or clip it may name a layer the new list
    // doesn't have, for one render)
    const layer = w.index < 0 ? undefined : list[w.index]
    if (layer === undefined) return 'the clip\'s own hand'
    const ref = layer.ref
    const label = ref === 'clip' ? 'the clip\'s own hand' : refLabel(character, ref, hands.shared)
    return w.weight < 1 ? `${label} (easing)` : label
  }

  const layerKey = (l: HandLayer): string => `${l.source}:${l.gear ?? ''}:${l.handle ?? ''}:${l.adjustment ?? ''}`
</script>

{#if human}
  <Section title="Hands">
    {#snippet action()}
      <span use:tooltip={'The character at rest, each hand closed as every clip closes it'}>
        <Button size="sm" variant="ghost" disabled={hands.view === null || !fingered} onclick={() => hands.showRest(character)}>Show at rest</Button>
      </span>
    {/snippet}
    {#if !fingered}
      <p class="faint small">{character.name}'s hands have no finger joints (Skeleton → fingers), so nothing can close them.</p>
    {:else}
      <p class="context">{context}</p>
      {#each SIDES as side (side)}
        {@const list = layers[side]}
        {@const w = won[side]}
        {@const k = keyed[side]}
        <div class="hand" class:left={side === 'Left'}>
          <div class="head">
            <span class="dot" aria-hidden="true"></span>
            <strong>{side} hand</strong>
            <span class="now">{nowText(list, w)}</span>
          </div>
          {#if list.length > 0}
            <ol aria-label="{side} hand: what closes it, bottom to top">
              {#each list as layer, i (layerKey(layer))}
                {@const t = layerText(character, layer, hands.shared, frames)}
                <li class:win={w.index === i} style:--weight={w.index === i ? w.weight : 0}>
                  <Badge tone={w.index === i ? 'accent' : 'muted'}>{sourceLabel(layer)}</Badge>
                  <span class="what">
                    {t.reason}{#if t.pose !== null}<span class="faint"> · {t.pose}</span>{/if}
                    {#if t.when !== null}<span class="when">{t.when}</span>{/if}
                  </span>
                  {#each layerLinks(layer, slot?.id ?? null) as link (link.label)}
                    <button class="link" use:tooltip={link.hint} onclick={() => hands.reveal(link.to)}>{link.label}<ArrowUpRight size={11} /></button>
                  {/each}
                </li>
              {/each}
            </ol>
          {/if}
          {#if k !== null}
            <p class="keys">
              <Badge tone="warn">Keys</Badge>
              <span class="what">{k.fingers.join(', ')} keyed in this slot, over all of these</span>
              {#if slot !== undefined}
                <button class="link" use:tooltip={'The slot\'s keys, in Motion'}
                  onclick={() => hands.reveal({ step: 'motion', slot: slot.id, adjustment: k.adjustment })}>Motion<ArrowUpRight size={11} /></button>
              {/if}
            </p>
          {/if}
          <Field label="Held in every clip" hint="Whatever it carries; a slot's own pose and a pull drawn still win">
            <HandPoseSelect {character} {side} value={character.hands.hold?.[side]} unsetLabel="Not held"
              onchange={(v) => hands.hold(character, side, v)} />
          </Field>
        </div>
      {/each}
      <p class="faint small">Listed bottom to top: a later row wins over the ones before it while it applies.</p>
    {/if}
  </Section>
  {#if fingered}
    <Section title="Hand poses">
      <HandPosesList {character} />
      {#if open !== null}<HandPoseEditor {character} pose={open} />{/if}
    </Section>
  {/if}
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .context { margin: 0; font-size: 12px; color: var(--text-2); }
  .hand { --side: var(--side-right); display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--line); }
  .hand.left { --side: var(--side-left); }
  .head { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--side); flex: none; }
  .now { margin-left: auto; color: var(--text-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ol { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .keys { display: flex; align-items: center; gap: 6px; margin: 0; padding: 0 0 0 2px; font-size: 12px; }
  li { position: relative; display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 8px; border-radius: var(--r-1); font-size: 12px; }
  li.win { background: var(--accent-soft); }
  li.win::before { content: ''; position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; background: var(--accent); opacity: var(--weight); }
  .what { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; }
  .when { color: var(--text-3); font-family: var(--mono); font-size: 11px; }
  .link { display: inline-flex; align-items: center; gap: 2px; border: 0; background: transparent; padding: 2px 4px; border-radius: 4px; color: var(--accent); font-size: 11.5px; cursor: pointer; }
  .link:hover, .link:focus-visible { background: var(--bg-3); color: var(--accent-strong); }
</style>
