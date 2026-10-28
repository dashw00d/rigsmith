<script lang="ts">
  // The name of the 3D joint under the pointer (else the one picked), beside it in the viewport: a viewport overlay
  // the skeleton state registers while the 3D joints are up.
  import { jointLabel } from '../../engine/templates.ts'
  import { skeleton } from '../../state/skeleton.svelte.ts'
</script>

{#if skeleton.label}
  {@const l = skeleton.label}
  <div class="joint-label {l.side}" style="transform: translate({l.x}px, {l.y}px)">
    {jointLabel(l.name)}{#if l.side !== 'center'}<span class="faint"> · {l.side}</span>{/if}
  </div>
{/if}

<style>
  .joint-label {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 3;
    margin: -34px 0 0 12px;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--bg-2);
    box-shadow: var(--shadow-pop);
    font-size: 11.5px;
    font-weight: 550;
    pointer-events: none;
    white-space: nowrap;
    border-left: 3px solid var(--side-center);
  }
  .joint-label.left { border-left-color: var(--side-left); }
  .joint-label.right { border-left-color: var(--side-right); }
</style>
