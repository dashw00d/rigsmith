<script lang="ts">
  import { app } from '../state/app.svelte.ts'
  import ImportPanel from './steps/ImportPanel.svelte'
  import RigPanel from './steps/RigPanel.svelte'
  import OutfitPanel from './steps/OutfitPanel.svelte'
  import TexturePanel from './steps/TexturePanel.svelte'
  import AnimatePanel from './steps/AnimatePanel.svelte'
  import ExportPanel from './steps/ExportPanel.svelte'
  import HistoryPanel from './HistoryPanel.svelte'
</script>

{#if app.selected === null}
  <div class="none">
    <p class="faint">Import a character to see its details here.</p>
  </div>
{:else if app.step === 'import'}
  <ImportPanel character={app.selected} />
{:else if app.step === 'rig'}
  <RigPanel character={app.selected} />
{:else if app.step === 'outfit'}
  <OutfitPanel character={app.selected} />
{:else if app.step === 'texture'}
  <TexturePanel character={app.selected} />
{:else if app.step === 'animate'}
  <AnimatePanel character={app.selected} />
{:else}
  <ExportPanel character={app.selected} />
{/if}
{#if app.selected !== null}
  <HistoryPanel character={app.selected} />
{/if}

<style>
  .none { padding: 24px 16px; }
</style>
