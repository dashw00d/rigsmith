<script lang="ts">
  interface Props { checked: boolean, label: string, hint?: string, onchange?: (checked: boolean) => void }
  let { checked = $bindable(), label, hint, onchange }: Props = $props()
</script>

<label class="toggle">
  <span class="text">
    <span>{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <input type="checkbox" bind:checked onchange={() => onchange?.(checked)} />
  <span class="track" aria-hidden="true"><span class="thumb"></span></span>
</label>

<style>
  .toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; padding: 4px 0; }
  .text { display: flex; flex-direction: column; gap: 1px; }
  .hint { color: var(--text-3); font-size: 11.5px; }
  input { position: absolute; opacity: 0; pointer-events: none; }
  .track {
    flex: none;
    width: 30px;
    height: 18px;
    border-radius: 10px;
    background: var(--bg-4);
    border: 1px solid var(--line-strong);
    position: relative;
    transition: background var(--fast), border-color var(--fast);
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-2);
    transition: transform var(--med) var(--ease), background var(--fast);
  }
  input:checked + .track { background: var(--accent); border-color: var(--accent); }
  input:checked + .track .thumb { transform: translateX(12px); background: var(--accent-ink); }
  input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
