<script lang="ts">
  // A Wardrobe picture (thumbs.svelte.ts): asked for once it scrolls into view, the plain face (`children`, or a soft
  // fill) until it is made.
  import type { Snippet } from 'svelte'
  import type { Character } from '../../state/api.ts'
  import { inview, thumbs, type ThumbAsk } from './thumbs.svelte.ts'

  let { character, ask, children }: { character: Character, ask: ThumbAsk, children?: Snippet } = $props()

  let seen = $state(false)
  const url = $derived(seen ? thumbs.get(character, ask) : null)
</script>

<span class="thumb" use:inview={() => { seen = true }}>
  {#if url !== null}<img src={url} alt="" draggable="false" />{:else}{@render children?.()}{/if}
</span>

<style>
  .thumb { display: grid; place-items: center; width: 100%; height: 100%; overflow: hidden; }
  img { width: 100%; height: 100%; object-fit: cover; }
</style>
