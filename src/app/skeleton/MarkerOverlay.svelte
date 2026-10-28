<script lang="ts">
  // The marker board as a viewport overlay (the skeleton state registers it while the board is open): the selected
  // character's board, built afresh for another character, another body or a model loaded again.
  import { app } from '../../state/app.svelte.ts'
  import { skeleton } from '../../state/skeleton.svelte.ts'
  import MarkerBoard from './MarkerBoard.svelte'

  const character = $derived(app.selected)
  const board = $derived(character === null ? null : skeleton.boardFor(character))
</script>

{#if character !== null && board !== null && skeleton.view !== null}
  {#key `${character.id}|${board.name}|${skeleton.view.root.uuid}`}
    <MarkerBoard {character} view={skeleton.view} set={board.set} setName={board.name} parents={board.parents} />
  {/key}
{/if}
