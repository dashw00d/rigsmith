<script lang="ts">
  import { app } from '../state/app.svelte.ts'
  import Button from './Button.svelte'

  // The question app.confirm() asked, mounted once by App. Modal: the keyboard stays in it (Tab goes round its
  // buttons), Escape or a click outside answers no, Enter answers yes (unless a button has the focus, which then does
  // what it says). Focus goes back where it was afterwards.
  const id = $props.id()
  const question = $derived(app.confirming)
  let box = $state<HTMLDivElement | null>(null)
  let returnTo: HTMLElement | null = null

  $effect(() => {
    if (question !== null && box !== null) {
      if (returnTo === null && document.activeElement instanceof HTMLElement) returnTo = document.activeElement
      box.querySelector<HTMLElement>('[data-confirm]')?.focus()
    } else if (question === null && returnTo !== null) {
      if (returnTo.isConnected) returnTo.focus()
      returnTo = null
    }
  })

  // (on the window, capturing: while it is open no key reaches anything else)
  function onkeydown (event: KeyboardEvent): void {
    if (question === null || box === null) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      app.answer(false)
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement && box.contains(event.target))) {
      event.preventDefault()
      app.answer(true)
    } else if (event.key === 'Tab') {
      const items = [...box.querySelectorAll<HTMLElement>('button:not(:disabled)')]
      const at = items.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus()
    }
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if question !== null}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(event) => { if (event.target === event.currentTarget) app.answer(false) }}>
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="{id}-title" aria-describedby={question.body ? `${id}-body` : undefined} bind:this={box}>
      <h2 id="{id}-title">{question.title}</h2>
      {#if question.body}<p id="{id}-body">{question.body}</p>{/if}
      <div class="actions">
        <Button variant="ghost" onclick={() => { app.answer(false) }}>{question.cancel ?? 'Cancel'}</Button>
        <Button variant={question.danger ? 'danger' : 'primary'} data-confirm onclick={() => { app.answer(true) }}>{question.confirm ?? 'OK'}</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 900;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--overlay);
    animation: fade var(--fast) ease-out;
  }
  .dialog {
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 18px 18px 14px;
    border-radius: var(--r-3);
    background: var(--bg-2);
    box-shadow: var(--shadow-pop);
    animation: pop var(--med) var(--ease);
  }
  h2 { margin: 0; font-size: 14.5px; font-weight: 650; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--text-2); white-space: pre-line; overflow-wrap: anywhere; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(0.98); } }
</style>
