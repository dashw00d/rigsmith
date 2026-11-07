<script lang="ts">
  // The frame (DESIGN.md §5): the top bar; the characters on the left, always (a drawer on a narrow window); the
  // viewport in the middle, with the clip library or the gear catalog sliding over its left edge; the step's inspector
  // on the right; the activity drawer over the right side. The confirm dialog, keys sheet, toasts and drop target
  // are mounted here once, and the
  // registered keys (src/ui/shortcuts.ts) are run from here.
  import { onMount } from 'svelte'
  import { PanelLeft, PanelRight, RefreshCw } from '@lucide/svelte'
  import { phaseOf } from '../model/select.ts'
  import { app } from '../state/app.svelte.ts'
  import { thumbnails } from '../state/thumbnails.svelte.ts'
  import Badge from '../ui/Badge.svelte'
  import Button from '../ui/Button.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import ActivityDrawer from './ActivityDrawer.svelte'
  import CharacterList from './CharacterList.svelte'
  import DropOverlay from './DropOverlay.svelte'
  import Inspector from './Inspector.svelte'
  import Toasts from './Toasts.svelte'
  import TopBar from './TopBar.svelte'
  import Viewport from './Viewport.svelte'
  import CatalogDrawer from './gear/CatalogDrawer.svelte'
  import WardrobeDrawer from './gear/WardrobeDrawer.svelte'
  import CrowdView from './gear/CrowdView.svelte'
  import { wardrobe } from './gear/wardrobe.svelte.ts'
  import { isFolk } from '../engine/folk.ts'
  import { registerAppKeys } from './gear/keys.ts'
  import KeysSheet from './KeysSheet.svelte'
  import { runShortcut } from '../ui/shortcuts.ts'
  import LibraryDrawer from './motion/LibraryDrawer.svelte'

  let ready = $state(false)
  let starting = $state(false)
  let failed = $state<string | null>(null)
  let width = $state(1280)
  let leftDocked = $state(true)
  let rightDocked = $state(true)
  let leftDrawer = $state(false)
  let rightDrawer = $state(false)
  const compact = $derived(width < 1100)
  const narrow = $derived(width < 760)
  const leftShown = $derived(compact ? leftDrawer : leftDocked)
  const rightShown = $derived(narrow ? rightDrawer : rightDocked)
  const selected = $derived(app.selected)
  const phase = $derived(selected === null ? null : phaseOf(selected, app.jobFor(selected.id)))

  function toggleLeft (): void {
    if (compact) { leftDrawer = !leftDrawer; rightDrawer = false } else leftDocked = !leftDocked
  }

  function toggleRight (): void {
    if (narrow) { rightDrawer = !rightDrawer; leftDrawer = false } else rightDocked = !rightDocked
  }

  // (picking a character in the list drawer closes it: the list was opened to pick one)
  $effect(() => { void app.selectedId; if (compact) leftDrawer = false })

  // Every character gets a list thumbnail, opened or not.
  $effect(() => { thumbnails.ensure(app.characters) })

  async function start (): Promise<void> {
    if (starting) return
    starting = true
    failed = null
    try {
      await app.start()
      ready = true
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error)
    } finally {
      starting = false
    }
  }

  onMount(() => { void start() })
  // (the keys anyone can see in the sheet, `?`: dressing, undo and redo; src/ui/shortcuts.ts)
  onMount(registerAppKeys)

  function onkeydown (e: KeyboardEvent): void {
    if (e.key === 'Escape' && !e.defaultPrevented) { leftDrawer = false; rightDrawer = false; return }
    if (ready) runShortcut(e)
  }
</script>

<svelte:window bind:innerWidth={width} {onkeydown} />

<div class="app">
  <TopBar />
  {#if failed !== null}
    <div class="fatal" role="alert">
      <h2>Can't reach the local server</h2>
      <p class="muted">{failed}</p>
      <p class="faint">Start it with <span class="mono">npm run dev</span> in the project folder, then try again.</p>
      <Button variant="primary" loading={starting} onclick={start}><RefreshCw size={14} /> Try again</Button>
    </div>
  {:else}
    <div class="strip">
      <button class:active={leftShown} aria-expanded={leftShown} aria-controls="workspace-characters" onclick={toggleLeft}><PanelLeft size={15} /> Characters</button>
      <span class="current">
        {#if selected !== null && phase !== null}
          <span class="name">{selected.name}</span>
          <Badge tone={phase.tone} dot={phase.tone === 'busy'}>{phase.label}</Badge>
        {:else if ready}
          <span class="faint">No character selected</span>
        {/if}
      </span>
      <button class:active={rightShown} aria-expanded={rightShown} aria-controls="workspace-inspector" onclick={toggleRight}><PanelRight size={15} /> Inspector</button>
    </div>
    <div class="body" class:left-hidden={!leftShown} class:right-hidden={!rightShown}>
      {#if (compact && leftDrawer) || (narrow && rightDrawer)}
        <button class="scrim" aria-label="Close panel" onclick={() => { leftDrawer = false; rightDrawer = false }}></button>
      {/if}
      <aside id="workspace-characters" class="left" class:drawer={compact} aria-label="Characters" aria-hidden={!leftShown} inert={!leftShown}>
        {#if ready}<CharacterList />{:else}<div class="placeholder"></div>{/if}
      </aside>
      <main class="center">
        <Viewport />
        {#if ready && wardrobe.crowdOpen && app.step === 'gear' && selected !== null && isFolk(selected)}<CrowdView character={selected} />{/if}
        {#if ready && app.drawer === 'library'}<LibraryDrawer />{/if}
        {#if ready && app.drawer === 'catalog'}<CatalogDrawer />{/if}
        {#if ready && app.drawer === 'wardrobe'}<WardrobeDrawer />{/if}
      </main>
      <aside id="workspace-inspector" class="right" class:drawer={narrow} aria-label="Inspector" aria-hidden={!rightShown} inert={!rightShown}>
        {#if ready}<Inspector />{/if}
      </aside>
      {#if ready && app.drawer === 'activity'}<ActivityDrawer />{/if}
    </div>
  {/if}
  <ConfirmDialog />
  <KeysSheet />
  <Toasts />
  <DropOverlay />
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; }
  .body {
    --left-width: 272px;
    --right-width: 340px;
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: var(--left-width) minmax(0, 1fr) var(--right-width);
  }
  .body.left-hidden { --left-width: 0px; }
  .body.right-hidden { --right-width: 0px; }
  .left, .right { min-width: 0; min-height: 0; background: var(--bg-1); display: flex; flex-direction: column; overflow: hidden; }
  .left { grid-column: 1; grid-row: 1; border-right: 1px solid var(--line); }
  .right { grid-column: 3; grid-row: 1; border-left: 1px solid var(--line); overflow: auto; }
  .left-hidden .left, .right-hidden .right { visibility: hidden; border: 0; }
  .drawer { position: absolute; top: 0; bottom: 0; z-index: 21; box-shadow: var(--shadow-pop); }
  .left.drawer { left: 0; width: min(300px, calc(100% - 32px)); }
  .right.drawer { right: 0; width: min(340px, calc(100% - 32px)); }
  .scrim { position: absolute; inset: 0; z-index: 20; border: 0; background: rgb(0 0 0 / 45%); }
  .center { grid-column: 2; grid-row: 1; position: relative; min-width: 0; min-height: 0; overflow: hidden; }
  .strip { height: 34px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--bg-1); }
  .strip button { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text-3); font-size: 12px; white-space: nowrap; }
  .strip button:hover { color: var(--text-1); }
  .strip button.active { background: var(--bg-3); color: var(--text-1); border-color: var(--line); }
  .current { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12px; }
  .current .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .placeholder { flex: 1; }
  .fatal { margin: auto; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 4px; max-width: 460px; padding: 24px; }
  .fatal h2 { font-weight: 600; margin: 0 0 6px; }
  .fatal p { margin: 0 0 8px; overflow-wrap: anywhere; }
  @media (max-width: 1099px) { .body { --left-width: 0px; } }
  @media (max-width: 759px) { .body { --right-width: 0px; } .strip { gap: 5px; padding: 0 6px; } }
</style>
