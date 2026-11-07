<script lang="ts" generics="T extends string">
  interface Option { value: T, label: string, disabled?: boolean, hint?: string }
  interface Props { options: Option[], value?: T[], label: string, testid?: string, onchange?: (value: T[]) => void }
  let { options, value = $bindable([]), label, testid, onchange }: Props = $props()
  function toggle (item: T): void {
    value = value.includes(item) ? value.filter(v => v !== item) : [...value, item]
    onchange?.(value)
  }
</script>

<div class="chips" role="group" aria-label={label} data-testid={testid}>
  {#each options as option (option.value)}
    <button type="button" data-id={option.value} aria-pressed={value.includes(option.value)} disabled={option.disabled} title={option.hint}
      onclick={() => { toggle(option.value) }}>{option.label}</button>
  {/each}
</div>

<style>
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  button { min-height: 24px; padding: 2px 9px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  button:hover:not(:disabled) { background: var(--bg-3); color: var(--text-1); }
  button[aria-pressed='true'] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-strong); }
  button:disabled { opacity: .5; }
</style>
