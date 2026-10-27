<script lang="ts">
  import { onMount } from 'svelte'
  import { PanelLeft, PanelRight } from '@lucide/svelte'
  import { app } from '../state/app.svelte.ts'
  import { thumbnails } from '../state/thumbnails.svelte.ts'
  import TopBar from './TopBar.svelte'
  import CharacterList from './CharacterList.svelte'
  import Viewport from './Viewport.svelte'
  import Inspector from './Inspector.svelte'
  import Library from './animate/Library.svelte'
  import PropCatalog from './outfit/PropCatalog.svelte'
  import Toasts from './Toasts.svelte'
  import DropOverlay from './DropOverlay.svelte'

  let ready = $state(false)
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
  const leftLabel = $derived(app.step === 'animate' ? 'Library' : app.step === 'outfit' ? 'Props' : 'Characters')

  function toggleLeft (): void {
    if (compact) { leftDrawer = !leftDrawer; rightDrawer = false }
    else leftDocked = !leftDocked
  }

  function toggleRight (): void {
    if (narrow) { rightDrawer = !rightDrawer; leftDrawer = false }
    else rightDocked = !rightDocked
  }

  // Every character gets a list thumbnail, opened or not.
  $effect(() => { thumbnails.ensure(app.characters) })

  onMount(() => {
    app.start().then(() => { ready = true }).catch((e: Error) => { failed = e.message })
  })

  const wideLeft = $derived(app.step === 'animate' || app.step === 'outfit')
</script>

<svelte:window bind:innerWidth={width} onkeydown={(e) => { if (e.key === 'Escape') { leftDrawer = false; rightDrawer = false } }} />

<div class="app">
  <TopBar />
  {#if failed}
    <div class="fatal">
      <h2>Can't reach the local server</h2>
      <p class="muted">{failed}</p>
      <p class="faint">Start it with <span class="mono">npm run dev</span> in the project folder.</p>
    </div>
  {:else}
    <div class="workspace-tools">
      <button class:active={leftShown} aria-expanded={leftShown} aria-controls="workspace-library" onclick={toggleLeft}><PanelLeft size={15} /> {leftLabel}</button>
      <select aria-label="Character" value={app.selectedId ?? ''} disabled={!ready || app.characters.length === 0}
        onchange={(e) => { app.selectedId = e.currentTarget.value }}>
        {#if app.characters.length === 0}<option value="">No characters</option>{/if}
        {#each app.characters as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
      </select>
      <button class:active={rightShown} aria-expanded={rightShown} aria-controls="workspace-inspector" onclick={toggleRight}><PanelRight size={15} /> Inspector</button>
    </div>
    <div class="body" class:wide-left={wideLeft} class:left-hidden={!leftShown} class:right-hidden={!rightShown}>
      {#if (compact && leftDrawer) || (narrow && rightDrawer)}
        <button class="scrim" aria-label="Close panel" onclick={() => { leftDrawer = false; rightDrawer = false }}></button>
      {/if}
      <aside id="workspace-library" class="left" class:drawer={compact} aria-label={leftLabel} aria-hidden={!leftShown} inert={!leftShown}>
        {#if !ready}
          <div class="placeholder"></div>
        {:else if app.step === 'animate'}
          <Library />
        {:else if app.step === 'outfit'}
          <PropCatalog />
        {:else}
          <CharacterList />
        {/if}
      </aside>
      <main class="center"><Viewport /></main>
      <aside id="workspace-inspector" class="right" class:drawer={narrow} aria-label="Inspector" aria-hidden={!rightShown} inert={!rightShown}>{#if ready}<Inspector />{/if}</aside>
    </div>
  {/if}
  <Toasts />
  <DropOverlay />
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; }
  .body {
    --left-width: 272px;
    --right-width: 328px;
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: var(--left-width) minmax(0, 1fr) var(--right-width);
  }
  .body.wide-left { --left-width: clamp(300px, 28vw, 440px); }
  .body.left-hidden { --left-width: 0px; }
  .body.right-hidden { --right-width: 0px; }
  .left, .right { min-width: 0; min-height: 0; background: var(--bg-1); display: flex; flex-direction: column; overflow: hidden; }
  .left { grid-column: 1; border-right: 1px solid var(--line); }
  .right { grid-column: 3; border-left: 1px solid var(--line); overflow: auto; }
  .left-hidden .left, .right-hidden .right { visibility: hidden; border: 0; }
  .drawer { position: absolute; top: 0; bottom: 0; z-index: 21; box-shadow: var(--shadow-pop); }
  .left.drawer { left: 0; width: min(440px, calc(100% - 32px)); }
  .right.drawer { right: 0; width: min(328px, calc(100% - 32px)); }
  .scrim { position: absolute; inset: 0; z-index: 20; border: 0; background: rgb(0 0 0 / 45%); }
  .center { grid-column: 2; grid-row: 1; position: relative; min-width: 0; }
  .workspace-tools { height: 38px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--bg-1); }
  .workspace-tools button { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text-3); font-size: 12px; white-space: nowrap; }
  .workspace-tools button.active { background: var(--bg-3); color: var(--text-1); border-color: var(--line); }
  .workspace-tools select { min-width: 0; width: 240px; height: 26px; margin: 0 auto; padding: 0 6px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--bg-2); font-size: 12px; text-overflow: ellipsis; }
  .placeholder { flex: 1; }
  .fatal { margin: auto; text-align: center; }
  .fatal h2 { font-weight: 600; margin: 0 0 6px; }
  @media (max-width: 1099px) { .body, .body.wide-left { --left-width: 0px; } }
  @media (max-width: 759px) { .body { --right-width: 0px; } .workspace-tools { gap: 5px; padding: 0 6px; } }
</style>
