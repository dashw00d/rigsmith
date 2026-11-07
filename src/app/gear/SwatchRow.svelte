<script lang="ts">
  import type { Character } from '../../state/api.ts'
  import { tooltip } from '../../ui/tooltip.ts'
  import Thumb from './Thumb.svelte'
  import { wardrobe } from './wardrobe.svelte.ts'
  import type { Choice } from './wardrobe.ts'
  let { character, field, choices, value, hint }: { character: Character, field: 'skin' | 'clothing', choices: Choice[], value: string | null, hint: (x: Choice) => string } = $props()
  const skins = $derived(new Map((character.look.skins ?? []).map(k => [k.name, k])))
</script>
{#if field === 'skin'}
        <div class="swatches">
          {#each choices as x (x.value)}
            {@const k = skins.get(x.value)}
            {@const tags = k?.tags ?? []}
            <button class="face" class:on={value === x.value} class:out={!x.ok} aria-pressed={value === x.value} aria-label={x.label}
              style:--ring={k?.hair ?? 'var(--line-strong)'} use:tooltip={`${hint(x)}${tags.length > 0 ? ` · ${tags.join(', ')}` : ''}`}
              onclick={() => { wardrobe.set(character, 'skin', x.value) }}>
              <Thumb {character} ask={{ kind: 'skin', name: x.value }}><span class="initial">{x.label.slice(0, 1)}</span></Thumb>
              {#if tags.includes('female')}<span class="mark f" aria-hidden="true">♀</span>{/if}
              {#if tags.includes('elderly')}<span class="mark e" aria-hidden="true">e</span>{/if}
            </button>
          {/each}
        </div>
{:else}
        <div class="swatches">
          {#each choices as x (x.value)}
            <button class="cloth" class:on={value === x.value} class:out={!x.ok} aria-pressed={value === x.value} aria-label={x.label}
              use:tooltip={hint(x)} onclick={() => { wardrobe.set(character, 'clothing', x.value) }}>
              <Thumb {character} ask={{ kind: 'clothes', name: x.value }}><span class="initial">{x.label.slice(0, 2)}</span></Thumb>
            </button>
          {/each}
          <button class="cloth none" class:on={value === null} aria-pressed={value === null} use:tooltip={"The skin's own"}
            onclick={() => { wardrobe.set(character, 'clothing', null) }}>–</button>
        </div>
{/if}

<style>
  .swatches { display: flex; flex-wrap: wrap; gap: 5px; }
  .face { position: relative; width: 34px; height: 34px; padding: 0; border-radius: 50%; border: 2px solid var(--ring); background: radial-gradient(circle at 50% 40%, #3a3f4c, #1b1e26); overflow: visible; }
  .face :global(.thumb) { border-radius: 50%; }
  .face.on { box-shadow: 0 0 0 2px var(--bg-1), 0 0 0 4px var(--accent); }
  .face:hover { transform: translateY(-1px); }
  .mark { position: absolute; display: grid; place-items: center; width: 13px; height: 13px; border-radius: 50%; font-size: 9px; font-weight: 700; line-height: 1; background: var(--bg-1); box-shadow: 0 0 0 1px var(--line-strong); pointer-events: none; }
  .mark.f { right: -4px; top: -4px; color: #f2a0c4; }
  .mark.e { right: -4px; bottom: -4px; color: var(--text-2); }
  .initial { font-size: 11px; font-weight: 600; color: var(--text-2); text-transform: uppercase; }
  .cloth { width: 38px; height: 38px; padding: 0; border-radius: 7px; border: 1px solid var(--line); background: var(--bg-2); overflow: hidden; color: var(--text-3); }
  .cloth:hover { border-color: var(--line-strong); }
  .cloth.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .out { opacity: 0.38; } .out:hover { opacity: 0.7; }
</style>
