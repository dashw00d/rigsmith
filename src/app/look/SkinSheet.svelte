<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { Character, Skin } from '../../model/types.ts'
  import { OutfitThumbs, type ThumbSpec } from '../../engine/OutfitThumbs.ts'
  import { app } from '../../state/app.svelte.ts'
  import { assets } from '../../state/assets.svelte.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import { documentDress, shows } from '../../state/dressing.ts'
  import Button from '../../ui/Button.svelte'

  let { character, onclose }: { character: Character, onclose: () => void } = $props()
  let urls = $state<Record<string, string>>({})
  let error = $state('')
  const renderer = new OutfitThumbs()
  let stopped = false
  let running = false
  let idleId: number | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const made: string[] = []

  function focusSheet (node: HTMLElement) {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    node.focus({ preventScroll: true })
    const trap = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const controls = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      if (controls.length === 0) { event.preventDefault(); return }
      const first = controls[0]; const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    node.addEventListener('keydown', trap)
    return { destroy () { node.removeEventListener('keydown', trap); if (before?.isConnected === true) before.focus({ preventScroll: true }) } }
  }

  function spec (skin: Skin): ThumbSpec {
    const bodyFile = character.files.rigged ?? character.files.model
    const body = bodyFile === undefined ? null : assets.asset(character, bodyFile)
    if (body === null) throw new Error('The body model is not available')
    const worn = dress.worn(character)
    const own = documentDress(character)
    const pieces = character.gear.filter(g => g.status === 'ready' && g.model !== undefined && shows(character, g, worn, own, dress.of(character.id))).flatMap(g => {
      const url = assets.asset(character, g.model)
      return url === null ? [] : [{ gear: g, url, place: g.attach.place }]
    })
    const selected = new Set(Object.values(worn.layers ?? {}).filter((id): id is string => typeof id === 'string'))
    const layers = (character.look.cloth ?? []).filter(l => selected.has(l.id)).map(l => {
      const url = assets.asset(character, l.file)
      const mask = l.cut?.mask === undefined ? undefined : assets.asset(character, l.cut.mask)
      if (url === null || mask === null) throw new Error(`Cloth image unavailable: ${l.name}`)
      return { id: l.id, slots: l.slots, url, ...(l.cut !== undefined ? { cut: l.cut } : {}), ...(mask !== undefined ? { mask } : {}) }
    })
    const clothes = character.look.clothes?.find(k => k.name === worn.clothing)
    return {
      body, pieces, framing: 'body', skin: assets.asset(character, skin.file),
      bare: skin.bare === undefined ? null : assets.asset(character, skin.bare), previewBare: worn.bare === true,
      ...(worn.layers === undefined ? { clothes: clothes === undefined ? null : assets.asset(character, clothes.file) } : { layers }),
      long: worn.layers === undefined ? (clothes?.tags ?? []).includes('long-sleeves') : (character.look.cloth ?? []).some(l => selected.has(l.id) && l.shapes?.includes('long_sleeve') === true),
      female: (skin.tags ?? []).includes('female'), hair: skin.hair ?? null,
    }
  }
  function schedule (fn: () => void): void {
    if (typeof requestIdleCallback === 'function') idleId = requestIdleCallback(fn, { timeout: 1500 })
    else timeoutId = setTimeout(fn, 30)
  }
  async function render (skins: readonly Skin[], at: number): Promise<void> {
    if (stopped || at >= skins.length) return
    running = true
    try {
      const blob = await renderer.render(spec(skins[at]), true)
      if (!stopped) {
        const url = URL.createObjectURL(blob); made.push(url)
        urls = { ...urls, [skins[at].name]: url }
      }
    } catch (e) {
      if (!stopped) error = `Some skins could not be rendered: ${(e as Error).message}`
    } finally {
      running = false
      if (stopped) renderer.dispose()
      else schedule(() => { void render(skins, at + 1) })
    }
  }
  onMount(() => { schedule(() => { void render(character.look.skins ?? [], 0) }) })
  onDestroy(() => {
    stopped = true
    if (idleId !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId)
    clearTimeout(timeoutId)
    if (!running) renderer.dispose()
    for (const url of made) URL.revokeObjectURL(url)
  })
  function choose (skin: Skin): void {
    const current = app.byId(character.id)
    if (current !== null) dress.setSkin(current, skin.name)
    onclose()
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) onclose() }} />
<div class="backdrop">
  <div class="sheet" role="dialog" aria-modal="true" aria-label="All skins" data-testid="look-skin-sheet" tabindex="-1" use:focusSheet>
    <header><h2>All skins</h2><Button size="sm" onclick={onclose}>Close</Button></header>
    {#if error}<p role="status">{error}</p>{/if}
    <div class="grid">
      {#each character.look.skins ?? [] as skin (skin.name)}
        <button type="button" data-testid="look-skin-tile" data-id={skin.name} aria-label="Show skin {skin.name}" onclick={() => choose(skin)}>
          {#if urls[skin.name]}<img src={urls[skin.name]} alt="" />{:else}<span class="pending">Rendering…</span>{/if}
          <span>{skin.name}</span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 100; background: rgb(0 0 0 / 65%); display: grid; place-items: center; }
  .sheet { width: min(1000px, 92vw); max-height: 90vh; display: flex; flex-direction: column; background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: var(--r-2); box-shadow: 0 12px 48px #0008; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  h2 { margin: 0; font-size: 15px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; padding: 12px; overflow: auto; }
  button { min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: 4px; padding: 5px; background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--r-1); cursor: pointer; color: var(--text-1); }
  button:hover, button:focus-visible { border-color: var(--accent); }
  button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  img, .pending { width: 100%; aspect-ratio: 1; object-fit: contain; background: var(--bg-1); }
  .pending { display: grid; place-items: center; color: var(--text-3); }
  p { padding: 0 12px; color: var(--warn); font-size: 12px; }
</style>
