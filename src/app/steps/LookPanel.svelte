<script lang="ts">
  // The Look step (DESIGN.md §5 #5, §7): the texture the character wears is its source's own with the look's layers
  // laid over it. The layers (switch, move, remove: each undoable), the hole scan and its fill, and projection
  // painting (mask, capture, repaint, keep as a layer).
  import { onDestroy } from 'svelte'
  import { Wand } from '@lucide/svelte'
  import { api, type Character, type Job } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { painter } from '../../state/painter.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Layers from '../look/Layers.svelte'
  import Painting from '../look/Painting.svelte'
  import { ago, scanLines } from '../look/text.ts'

  let { character }: { character: Character } = $props()

  const active = (j: Job): boolean => j.status === 'queued' || j.status === 'running'
  const filling = $derived(app.jobs.find(j => j.characterId === character.id && j.kind === 'texture' && active(j)))
  const scan = $derived(character.look.scan)
  const lines = $derived(scanLines(scan, character.look.layers))
  const hasFill = $derived(character.look.layers.some(l => l.kind === 'fill'))
  const animation = $derived(character.source.kind === 'animation')

  async function fill (): Promise<void> {
    try {
      await api.fillTexture(character.id)
    } catch (error) {
      app.toast('error', `Not filled: ${(error as Error).message}`)
    }
  }

  // (another character shown without the guard being asked, e.g. this one deleted: painting is over)
  $effect(() => {
    if (painter.active && painter.characterId !== character.id) painter.stop()
  })
  onDestroy(() => { painter.stop() })
</script>

<Section title="Layers">
  <Layers {character} />
</Section>

<Section title="Holes">
  <p class="faint small">AI texture generators leave magenta where they couldn't see the surface. Filling paints those spots from the colours round them on the model (in 3D, so UV seams don't bleed), as a layer at the bottom.</p>
  {#if scan !== undefined && filling === undefined}
    <ul class="scan" aria-label="Last scan">
      {#each lines as line (line.image)}
        <li><span class="mono">{line.image}</span><span class={line.tone}>{line.text}</span></li>
      {/each}
      {#if lines.length === 0}<li class="faint">The source has no images to scan.</li>{/if}
    </ul>
    <p class="faint small">Scanned {ago(scan.at)}.</p>
  {/if}
  <Button variant={hasFill ? 'secondary' : 'primary'} block loading={filling !== undefined} disabled={filling !== undefined || animation} onclick={() => { void fill() }}>
    {#if filling === undefined}<Wand size={15} />{/if}
    {filling !== undefined ? (filling.status === 'queued' ? 'Queued' : filling.message || 'Filling') : hasFill ? 'Find and fill holes again' : 'Find and fill holes'}
  </Button>
  {#if hasFill}<p class="faint small">A new fill replaces the last one on that image (undo brings it back).</p>{/if}
</Section>

<Section title="Projection painting">
  <Painting {character} />
</Section>

<style>
  .small { font-size: 12px; margin: 0; }
  .scan { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
  .scan li { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
  .scan .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: var(--text-2); }
  .ok { color: var(--ok); flex: none; }
  .warn { color: var(--warn); flex: none; }
  .muted { color: var(--text-3); flex: none; }
</style>
