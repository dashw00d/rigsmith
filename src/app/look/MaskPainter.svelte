<script lang="ts">
  // The mask brush's circle over the viewport, registered by the painter as a viewer overlay while it paints. The mask
  // itself is painted on the model (src/state/painter.svelte.ts, src/engine/surfacemask.ts), so this takes no input:
  // drags reach the stage, and off the model they turn the camera.
  import type { painter as Painter } from '../../state/painter.svelte.ts'

  let { painter }: { painter: typeof Painter } = $props()
</script>

{#if painter.cursor !== null && painter.attached}
  <div class="cursor" class:smart={painter.tool === 'smart'} class:erase={painter.tool === 'erase'} style:left="{painter.cursor.x}px" style:top="{painter.cursor.y}px" style:width="{painter.brush}px" style:height="{painter.brush}px"></div>
{/if}

<style>
  .cursor { position: absolute; z-index: 2; transform: translate(-50%, -50%); border-radius: 50%; border: 1.5px solid var(--text-1); box-shadow: 0 0 0 1px rgb(0 0 0 / 50%); pointer-events: none; }
  .cursor.erase { border-style: dashed; }
  .cursor.smart::after { content: ''; position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px; border-radius: 50%; background: var(--text-1); }
</style>
