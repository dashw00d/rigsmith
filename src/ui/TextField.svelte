<script lang="ts">
  import { onMount } from 'svelte'

  // A line (or with `multiline`, a box) of text. `value` follows the typing; `oncommit` hears it once it is meant:
  // Enter (Ctrl+Enter in a box) or leaving the field, when it changed. Escape takes back the typing.
  interface Props {
    value?: string
    oncommit?: (value: string) => void
    placeholder?: string
    /** Its accessible name when no Field labels it. */
    label?: string
    disabled?: boolean
    size?: 'sm' | 'md'
    type?: 'text' | 'search'
    multiline?: boolean
    rows?: number
    mono?: boolean
    maxlength?: number
    /** Take the focus with the text selected on mount (an inline rename). */
    autoselect?: boolean
  }
  let {
    value = $bindable(''), oncommit, placeholder, label, disabled = false, size = 'md', type = 'text', multiline = false, rows = 3,
    mono = false, maxlength, autoselect = false,
  }: Props = $props()

  let node = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  // (the text when the field took the focus, or when last committed)
  let start = ''

  onMount(() => { if (autoselect && node !== null) { node.focus(); node.select() } })

  function commit (): void {
    if (value === start) return
    start = value
    oncommit?.(value)
  }

  function onkeydown (event: KeyboardEvent): void {
    if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape' && value !== start) {
      // (taken back here, so a drawer or dialog around it stays open)
      event.preventDefault()
      value = start
    }
  }
</script>

{#if multiline}
  <textarea
    bind:this={node}
    bind:value
    class="text {size}"
    class:mono
    {rows}
    {placeholder}
    {disabled}
    {maxlength}
    aria-label={label}
    onfocus={() => { start = value }}
    onblur={commit}
    {onkeydown}
  ></textarea>
{:else}
  <input
    bind:this={node}
    bind:value
    class="text {size}"
    class:mono
    {type}
    {placeholder}
    {disabled}
    {maxlength}
    aria-label={label}
    onfocus={() => { start = value }}
    onblur={commit}
    {onkeydown}
  />
{/if}

<style>
  .text {
    width: 100%;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--r-1);
    border: 1px solid var(--line-strong);
    background: var(--bg-1);
    transition: border-color var(--fast);
  }
  textarea.text { height: auto; padding: 6px 8px; resize: vertical; line-height: 1.4; }
  .text.sm { height: 24px; font-size: 12px; padding: 0 6px; }
  textarea.text.sm { height: auto; padding: 4px 6px; }
  .text::placeholder { color: var(--text-4); }
  .text:focus, .text:focus-visible { outline: none; border-color: var(--accent); }
  .text:disabled { opacity: 0.5; }
</style>
