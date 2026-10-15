<script lang="ts">
  import { onMount } from 'svelte'
  import { Check, Plus, Repeat } from '@lucide/svelte'
  import type { LibraryClip } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { SPRITE_FRAMES } from '../../engine/PreviewRenderer.ts'
  import { tooltip } from '../../ui/tooltip.ts'

  let { clip, added, playing }: { clip: LibraryClip, added: boolean, playing: boolean } = $props()
  let sheet = $state<string | null>(null)
  let failed = $state(false)
  let node: HTMLDivElement

  let visible = $state(false)

  onMount(() => {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      observer.disconnect()
      visible = true
    }, { rootMargin: '200px' })
    observer.observe(node)
    return () => { observer.disconnect() }
  })

  // (Re)request the sprite sheet when the card becomes visible or the preview subject changes.
  $effect(() => {
    void animator.previewVersion
    if (!visible) return
    let cancelled = false
    const url = clip.url
    animator.sprite(url).then(result => { if (!cancelled) { sheet = result; failed = result === null } }, () => { if (!cancelled) failed = true })
    return () => { cancelled = true }
  })

  const duration = $derived(clip.duration < 10 ? clip.duration.toFixed(1) : Math.round(clip.duration).toString())
  const named = $derived(clip.nameSource !== 'provisional')

  async function add (e: MouseEvent): Promise<void> {
    e.stopPropagation()
    const c = app.selected
    if (c === null) return
    if (added) {
      await app.update(c.id, { animations: c.animations.filter(a => a.clipId !== clip.id) })
      return
    }
    const entry = { clipId: clip.id, url: clip.url, name: clip.name, inPlace: clip.inPlace || clip.category === 'locomotion', loop: clip.loop, speed: 1 }
    await app.update(c.id, { animations: [...c.animations, entry] })
  }
</script>

<div class="card" class:playing class:added bind:this={node} role="button" tabindex="0"
  onclick={() => animator.playLibrary(clip)} onkeydown={(e) => { if (e.key === 'Enter') animator.playLibrary(clip) }}>
  <div class="preview" style={sheet ? `--sheet: url(${sheet}); --frames: ${SPRITE_FRAMES}` : ''} class:ready={sheet !== null}>
    {#if sheet === null && !failed}<div class="shimmer"></div>{/if}
    <span class="time mono">{duration}s</span>
    {#if clip.loop}<span class="loop" use:tooltip={'Loops seamlessly'}><Repeat size={11} /></span>{/if}
    <button class="add" class:on={added} onclick={add} aria-label={added ? 'Remove from set' : 'Add to set'} use:tooltip={added ? 'In this character’s set (click to remove)' : 'Add to set'}>
      {#if added}<Check size={14} strokeWidth={3} />{:else}<Plus size={15} />{/if}
    </button>
  </div>
  <div class="label">
    <span class="name" class:provisional={!named}>{clip.name}</span>
  </div>
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    border-radius: var(--r-2);
    background: var(--bg-2);
    border: 1px solid var(--line);
    overflow: hidden;
    cursor: pointer;
    transition: border-color var(--fast), transform var(--fast), box-shadow var(--fast);
    outline: none;
  }
  .card:hover { border-color: var(--line-strong); transform: translateY(-1px); box-shadow: 0 8px 22px -12px rgb(0 0 0 / 70%); }
  .card:focus-visible { border-color: var(--accent); }
  .card.playing { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .preview {
    position: relative;
    aspect-ratio: 1;
    background:
      var(--sheet, none) 33.3% 0 / calc(var(--frames, 1) * 100%) 100% no-repeat,
      radial-gradient(circle at 50% 35%, #232a3b, #14171e 75%);
  }
  .preview.ready { background-position: 33.3% 0, 0 0; }
  .card:hover .preview.ready { animation: play 1.4s steps(var(--frames)) infinite; }
  @keyframes play { from { background-position: 0 0, 0 0; } to { background-position: calc(var(--frames) * 100% / (var(--frames) - 1)) 0, 0 0; } }
  .shimmer { position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, rgb(255 255 255 / 4%) 50%, transparent 70%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }
  .time { position: absolute; left: 6px; bottom: 6px; font-size: 10.5px; padding: 1px 5px; border-radius: 4px; background: rgb(10 11 14 / 70%); color: var(--text-2); }
  .loop { position: absolute; left: 6px; top: 6px; color: var(--text-3); display: grid; }
  .add {
    position: absolute;
    right: 6px;
    top: 6px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 0;
    display: grid;
    place-items: center;
    background: rgb(10 11 14 / 70%);
    color: var(--text-1);
    opacity: 0;
    transition: opacity var(--fast), background var(--fast), transform var(--fast);
  }
  .card:hover .add, .add.on, .card:focus-within .add { opacity: 1; }
  .add:hover { transform: scale(1.08); background: var(--accent); color: var(--accent-ink); }
  .add.on { background: var(--ok); color: #06140d; }
  .label { padding: 7px 8px 8px; min-height: 40px; }
  .name { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; font-weight: 550; line-height: 1.3; }
  .name.provisional { color: var(--text-2); font-weight: 450; }
</style>
