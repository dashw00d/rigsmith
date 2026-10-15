<script lang="ts">
  import { FolderOutput } from '@lucide/svelte'
  import { app } from '../state/app.svelte.ts'
  import Popover from '../ui/Popover.svelte'

  let { onclose }: { onclose: () => void } = $props()
  let exportDir = $state(app.settings?.exportDir ?? '')

  async function save (): Promise<void> {
    await app.saveSettings({ exportDir })
    app.toast('ok', 'Export folder saved')
  }
</script>

<Popover {onclose} width={360} align="right">
  <div class="body">
    <label for="export-dir"><FolderOutput size={14} /> Export folder</label>
    <p class="faint">Exports are written here, e.g. a folder inside your Godot project.</p>
    <input id="export-dir" class="mono" bind:value={exportDir} onkeydown={(e) => { if (e.key === 'Enter') void save() }} onblur={() => { void save() }} />
  </div>
</Popover>

<style>
  .body { padding: 14px; display: flex; flex-direction: column; gap: 6px; }
  label { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  p { margin: 0 0 4px; font-size: 12px; }
  input { height: 30px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-1); padding: 0 9px; }
  input:focus { outline: none; border-color: var(--accent); }
</style>
