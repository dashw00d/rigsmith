<script lang="ts">
  // The keys sheet (`?`): every key in the registry (src/ui/shortcuts.ts) by its group, the ones that apply now
  // bright, and the viewport's and timeline's own keys. Escape or a click outside closes it.
  import { onDestroy } from 'svelte'
  import { X } from '@lucide/svelte'
  import { keyLabel, onShortcuts, shortcuts, type Shortcut } from '../ui/shortcuts.ts'
  import IconButton from '../ui/IconButton.svelte'
  import { wardrobe } from './gear/wardrobe.svelte.ts'

  // (the registry isn't reactive: read again when it changes and when the sheet opens)
  let beat = $state(0)
  onDestroy(onShortcuts(() => { beat++ }))
  const OTHERS: Array<[string, string, string]> = [
    ['Viewport', 'F', 'Frame the character'],
    ['Timeline', 'Space', 'Play or pause'],
    ['Timeline', ', .', 'A frame back or on (Shift: 10)'],
    ['Motion', 'G R K B', 'Move, rotate, key, solve'],
  ]
  const groups = $derived.by(() => {
    void beat; void wardrobe.keysOpen
    const m = new Map<string, Shortcut[]>()
    const seen = new Set<string>()
    for (const s of shortcuts()) {
      // (one line per action: the newest registration wins, as it does for the key)
      if (seen.has(s.keys)) continue
      seen.add(s.keys)
      m.set(s.group, [...(m.get(s.group) ?? []), s])
    }
    return [...m]
  })
</script>

<svelte:window onkeydown={(e) => { if (wardrobe.keysOpen && e.key === 'Escape') { e.preventDefault(); wardrobe.keysOpen = false } }} />

{#if wardrobe.keysOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => { wardrobe.keysOpen = false }}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="sheet" role="dialog" aria-label="Keys" tabindex="-1" onclick={(e) => { e.stopPropagation() }}>
      <header><h2>Keys</h2><IconButton size="sm" label="Close" hint="Close (Esc)" onclick={() => { wardrobe.keysOpen = false }}><X size={14} /></IconButton></header>
      <div class="cols">
        {#each groups as [g, list] (g)}
          <section>
            <h3>{g}</h3>
            {#each list as s (s.id)}
              <div class="line" class:off={s.when !== undefined && !s.when()}>
                <span class="label">{s.label}</span>
                <span class="keys">{#each keyLabel(s.keys) as k, i (i)}<kbd>{k}</kbd>{/each}</span>
              </div>
            {/each}
          </section>
        {/each}
        <section>
          <h3>Elsewhere</h3>
          {#each OTHERS as [where, k, what] (where + k)}
            <div class="line"><span class="label">{what} <span class="where">{where}</span></span><span class="keys"><kbd>{k}</kbd></span></div>
          {/each}
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: rgb(10 11 14 / 55%); animation: fade var(--med) ease-out; }
  .sheet { width: min(720px, calc(100% - 32px)); max-height: calc(100% - 64px); overflow: auto; border-radius: var(--r-3, 12px); background: var(--bg-1); box-shadow: var(--shadow-pop), 0 0 0 1px var(--line-strong); }
  .sheet:focus { outline: none; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 10px 10px 8px 18px; border-bottom: 1px solid var(--line); }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .cols { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 6px 24px; padding: 12px 18px 18px; }
  h3 { margin: 8px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-3); }
  .line { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 3px 0; font-size: 12.5px; }
  .line.off { opacity: 0.45; }
  .where { color: var(--text-3); font-size: 11px; }
  .keys { display: inline-flex; gap: 3px; flex: none; }
  kbd { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 5px; border: 1px solid var(--line-strong); border-bottom-width: 2px; background: var(--bg-2); color: var(--text-1); font: 600 11px/18px var(--font); text-align: center; }
  @keyframes fade { from { opacity: 0; } }
</style>
