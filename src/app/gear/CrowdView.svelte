<script lang="ts">
  // The crowd (C): 8, 12 or 24 units of a dynamic character side by side over the viewport, each dressed as the game's
  // pick engine dresses that unit number, the clip on stage playing on all of them out of step (src/engine/crowd.ts).
  // R draws them all again, a click draws that one again, Alt-click puts it on stage (the dress state: exactly that
  // unit). Its pieces come in while the page is idle, a piece at a time.
  import { onDestroy, onMount, untrack } from 'svelte'
  import { Dices, X } from '@lucide/svelte'
  import type { Character, Gear } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { app } from '../../state/app.svelte.ts'
  import { asset } from '../../state/assets.svelte.ts'
  import { clothOf, pick, setsOf } from '../../engine/folkpick.ts'
  import { Crowd, type UnitLook } from '../../engine/crowd.ts'
  import Button from '../../ui/Button.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import { register } from '../../ui/shortcuts.ts'
  import { wardrobe, worldFor } from './wardrobe.svelte.ts'
  import { newUid } from './wardrobe.ts'

  let { character }: { character: Character } = $props()

  const SIZES = [8, 12, 24] as const
  const size = $derived(wardrobe.view(character.id).crowd ?? 12)
  let uids = $state<number[]>([])
  let hovered = $state<number | null>(null)
  let canvas = $state<HTMLCanvasElement>()
  let box = $state<HTMLDivElement>()
  let crowd: Crowd | null = null

  // (as many units as the size, the ones there kept)
  $effect(() => {
    const n = size
    untrack(() => { uids = Array.from({ length: n }, (_, i) => uids[i] ?? newUid()) })
  })

  function lookOf (c: Character, uid: number): UnitLook {
    const p = pick(worldFor(c), uid)
    const byId = new Map(c.gear.map(g => [g.id, g]))
    const set = setsOf(c).find(s => s.id === p.picks.set)
    const ids = [...(set?.pieces ?? []), p.picks.hair, p.picks.beard].filter((id): id is string => id !== null && id !== undefined)
    const pieces = ids.flatMap(id => {
      const g: Gear | undefined = byId.get(id)
      const url = g?.status === 'ready' ? asset(c, g.model) : null
      return g === undefined || url === null ? [] : [{ gear: g, url }]
    })
    const skin = (c.look.skins ?? []).find(k => k.name === p.picks.skin)
    const layer = clothOf(c).find(l => l.id === p.layers[0])
    return {
      uid, set: set?.id ?? null, pieces,
      skin: skin === undefined ? null : asset(c, skin.file), clothes: layer === undefined ? null : asset(c, layer.file),
      long: p.shapes.includes('long_sleeve'), hair: skin?.hair ?? null, female: p.shapes.includes('female'),
    }
  }

  const looks = $derived(uids.map(uid => lookOf(character, uid)))
  const body = $derived(asset(character, character.files.rigged ?? character.files.model))

  onMount(() => {
    if (canvas === undefined || box === undefined) return
    crowd = new Crowd(canvas)
    const fit = (): void => { const r = box!.getBoundingClientRect(); crowd?.resize(r.width, r.height) }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => { ro.disconnect() }
  })
  onDestroy(() => { crowd?.dispose(); crowd = null })

  // (the body first, then the units on it, then the clip: each when it changes)
  let loaded = $state<string | null>(null)
  $effect(() => {
    const url = body
    if (url === null) return
    untrack(() => { void crowd?.setBody(url).then(() => { loaded = url }) })
  })
  $effect(() => { if (loaded !== null) { const l = looks; untrack(() => { crowd?.setUnits(l); crowd?.setClip(animator.clip) }) } })
  $effect(() => { const clip = animator.clip; if (loaded !== null) untrack(() => { crowd?.setClip(clip) }) })

  function rerollAll (): void { uids = uids.map(() => newUid()) }

  function onclick (e: MouseEvent): void {
    const i = crowd?.unitAt(e.clientX, e.clientY) ?? null
    if (i === null) return
    if (e.altKey) {
      wardrobe.showUnit(character, uids[i])
      app.toast('ok', `Unit #${uids[i]} on stage`, 2500)
      return
    }
    uids = uids.map((u, k) => (k === i ? newUid() : u))
  }

  function onpointermove (e: PointerEvent): void {
    const i = crowd?.unitAt(e.clientX, e.clientY) ?? null
    hovered = i === null ? null : uids[i] ?? null
  }

  const close = (): void => { wardrobe.crowdOpen = false }
  onDestroy(register(
    { id: 'crowd.reroll', keys: 'r', label: 'Crowd: draw every unit again', group: 'Crowd', when: () => wardrobe.crowdOpen, run: rerollAll },
  ))
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) close() }} />

<div class="crowd" bind:this={box}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <canvas bind:this={canvas} {onclick} {onpointermove} onpointerleave={() => { hovered = null }}></canvas>
  <div class="bar">
    <strong>Crowd</strong>
    <div class="sizes" role="radiogroup" aria-label="How many">
      {#each SIZES as n (n)}
        <button role="radio" aria-checked={size === n} class:active={size === n} onclick={() => { wardrobe.update(character.id, { crowd: n }) }}>{n}</button>
      {/each}
    </div>
    <Button size="sm" variant="ghost" onclick={rerollAll} title="Every unit drawn again (R)"><Dices size={13} /> Again</Button>
    <span class="hint">{hovered !== null ? `Unit #${hovered}: click draws it again, Alt-click puts it on stage` : 'Click a unit to draw it again; Alt-click puts it on stage'}</span>
    <IconButton size="sm" label="Close" hint="Close (C, Esc)" onclick={close}><X size={14} /></IconButton>
  </div>
</div>

<style>
  .crowd { position: absolute; inset: 0; z-index: 30; background: #14171e; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .bar { position: absolute; left: 12px; right: 12px; top: 10px; display: flex; align-items: center; gap: 8px; padding: 5px 6px 5px 12px; border-radius: var(--r-2); background: rgb(20 23 30 / 85%); box-shadow: 0 0 0 1px var(--line); font-size: 12px; }
  .sizes { display: flex; gap: 2px; }
  .sizes button { height: 22px; min-width: 30px; padding: 0 7px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--text-2); font-size: 11.5px; }
  .sizes button.active { background: var(--text-1); color: var(--bg-0); border-color: var(--text-1); }
  .hint { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
</style>
