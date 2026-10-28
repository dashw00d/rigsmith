<script lang="ts">
  // Model files dropped anywhere on the page are imported as characters (one after another); the first is shown as soon
  // as it is in. A step's own drop target that takes the files (calls preventDefault) keeps them.
  import { Upload } from '@lucide/svelte'
  import { importFiles } from './characters.ts'

  let depth = $state(0)
  const active = $derived(depth > 0)

  function hasFiles (e: DragEvent): boolean {
    return e.dataTransfer?.types.includes('Files') ?? false
  }
</script>

<svelte:window
  ondragenter={(e) => { if (hasFiles(e)) { e.preventDefault(); depth++ } }}
  ondragleave={(e) => { if (hasFiles(e)) depth = Math.max(0, depth - 1) }}
  ondragover={(e) => { if (hasFiles(e)) e.preventDefault() }}
  ondrop={(e) => {
    if (!hasFiles(e)) return
    depth = 0
    // (a drop target of a step's own took them: gear uploads)
    if (e.defaultPrevented) return
    e.preventDefault()
    void importFiles([...(e.dataTransfer?.files ?? [])])
  }}
/>

{#if active}
  <div class="overlay">
    <div class="card">
      <div class="icon"><Upload size={26} /></div>
      <strong>Drop to import</strong>
      <span class="muted">FBX, GLB, OBJ, DAE, or Tripo ZIPs: meshes, rigged characters, animations</span>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: grid;
    place-items: center;
    background: rgb(10 11 14 / 70%);
    backdrop-filter: blur(6px);
    pointer-events: none;
    animation: fade var(--fast);
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 40px 56px;
    border: 2px dashed var(--accent);
    border-radius: 20px;
    background: var(--accent-soft);
    text-align: center;
  }
  .icon { color: var(--accent-strong); margin-bottom: 6px; }
  strong { font-size: 17px; }
  @keyframes fade { from { opacity: 0; } }
</style>
