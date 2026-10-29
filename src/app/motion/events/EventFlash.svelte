<script lang="ts">
  // The names of the events the playhead just crossed, flashed over the character (a viewport overlay the events
  // state puts up while the Events lane is shown): what the game would do there, as the preview plays it.
  import { events } from '../../../state/events.svelte.ts'
  import { labelOf } from './vocabulary.ts'
</script>

<div class="event-flash" aria-live="polite">
  {#each events.flashes as f (f.key)}
    <span class="flash" class:hit={f.name === 'hit'} class:step={f.name.startsWith('step')}>{labelOf(f.name)}</span>
  {/each}
</div>

<style>
  .event-flash {
    position: absolute;
    top: 18%;
    left: 50%;
    z-index: 3;
    display: flex;
    gap: 6px;
    transform: translateX(-50%);
    pointer-events: none;
  }
  .flash {
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--bg-2);
    box-shadow: var(--shadow-pop);
    color: var(--text-1);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
    animation: flash 700ms var(--ease) forwards;
  }
  .flash.hit { background: var(--warn); color: var(--accent-ink); }
  .flash.step { color: var(--text-2); font-weight: 500; }
  @keyframes flash {
    0% { opacity: 0; transform: translateY(6px) scale(0.92); }
    15% { opacity: 1; transform: translateY(0) scale(1); }
    70% { opacity: 1; }
    100% { opacity: 0; transform: translateY(-6px); }
  }
</style>
