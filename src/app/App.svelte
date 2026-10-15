<script lang="ts">
  import { onMount } from 'svelte'
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

  // Every character gets a list thumbnail, opened or not.
  $effect(() => { thumbnails.ensure(app.characters) })

  onMount(() => {
    app.start().then(() => { ready = true }).catch((e: Error) => { failed = e.message })
  })

  const wideLeft = $derived(app.step === 'animate' || app.step === 'outfit')
</script>

<div class="app">
  <TopBar />
  {#if failed}
    <div class="fatal">
      <h2>Can't reach the local server</h2>
      <p class="muted">{failed}</p>
      <p class="faint">Start it with <span class="mono">npm run dev</span> in the project folder.</p>
    </div>
  {:else}
    <div class="body" class:wide-left={wideLeft}>
      <aside class="left">
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
      <aside class="right">{#if ready}<Inspector />{/if}</aside>
    </div>
  {/if}
  <Toasts />
  <DropOverlay />
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 272px minmax(0, 1fr) 328px;
    transition: grid-template-columns var(--med) var(--ease);
  }
  .body.wide-left { grid-template-columns: minmax(440px, 40%) minmax(0, 1fr) 328px; }
  .left, .right { min-height: 0; background: var(--bg-1); display: flex; flex-direction: column; }
  .left { border-right: 1px solid var(--line); }
  .right { border-left: 1px solid var(--line); overflow: auto; }
  .center { position: relative; min-width: 0; }
  .placeholder { flex: 1; }
  .fatal { margin: auto; text-align: center; }
  .fatal h2 { font-weight: 600; margin: 0 0 6px; }
</style>
