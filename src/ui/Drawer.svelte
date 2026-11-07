<script lang="ts">
  import type { Snippet } from 'svelte'
  import { X } from '@lucide/svelte'
  import IconButton from './IconButton.svelte'

  // A panel that slides over the edge of whatever positioned box holds it (the library and the catalog over the
  // viewport's left, the activity on the right). The scrim behind it, Escape and its close button close it; without
  // `scrim` what is behind stays usable (previewing clips on the character while the library is open). It takes the
  // focus when it opens and gives it back when it closes.
  interface Props {
    open: boolean
    onclose: () => void
    side?: 'left' | 'right'
    title: string
    width?: string
    scrim?: boolean
    /** Buttons in its header, before the close button. */
    actions?: Snippet
    children: Snippet
    testid?: string
  }
  let { open, onclose, side = 'left', title, width = 'min(420px, 92%)', scrim = true, actions, children, testid }: Props = $props()

  function holdFocus (node: HTMLElement) {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!node.contains(document.activeElement)) node.focus({ preventScroll: true })
    return {
      destroy () {
        // (only when the focus was in it, or went nowhere: not when the user moved on)
        const now = document.activeElement
        if (before?.isConnected === true && (now === null || now === document.body || node.contains(now))) before.focus({ preventScroll: true })
      },
    }
  }

  function onkeydown (event: KeyboardEvent): void {
    if (open && event.key === 'Escape' && !event.defaultPrevented) onclose()
  }
</script>

<svelte:window {onkeydown} />

{#if open}
  {#if scrim}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="scrim" onclick={onclose}></div>
  {/if}
  <aside data-testid={testid} class="drawer {side}" style:width aria-label={title} tabindex="-1" use:holdFocus>
    <header>
      <h2>{title}</h2>
      <div class="actions">
        {@render actions?.()}
        <IconButton label="Close" hint="Close (Esc)" size="sm" onclick={onclose}><X size={15} /></IconButton>
      </div>
    </header>
    <div class="body">{@render children()}</div>
  </aside>
{/if}

<style>
  .scrim { position: absolute; inset: 0; z-index: 40; background: rgb(10 11 14 / 45%); animation: fade var(--med) ease-out; }
  .drawer {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 41;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-1);
    box-shadow: 0 0 40px rgb(0 0 0 / 45%), 0 0 0 1px var(--line-strong);
  }
  .drawer:focus, .drawer:focus-visible { outline: none; }
  .left { left: 0; animation: from-left var(--med) var(--ease); }
  .right { right: 0; animation: from-right var(--med) var(--ease); }
  header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 44px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--line); }
  h2 { margin: 0; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; align-items: center; gap: 4px; }
  .body { flex: 1; min-height: 0; overflow: auto; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes from-left { from { transform: translateX(-24px); opacity: 0; } }
  @keyframes from-right { from { transform: translateX(24px); opacity: 0; } }
</style>
