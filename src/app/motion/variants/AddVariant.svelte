<script lang="ts">
  // "+ variant" on a game clip's row (src/model/variants.ts): one more take of that clip for the game to pick from at
  // random, `Attack 2`, `Attack 3`..., made by copying the clip's slot as it is (one slot.copy: one undo) and played at
  // once to work on. A variant is an ordinary slot: remove it to drop it. Mounted by the slot list on each filled game
  // clip row: <AddVariant {character} name={gameName} names={gameNames} />.
  import { Copy } from '@lucide/svelte'
  import type { Character } from '../../../model/types.ts'
  import { newId } from '../../../model/ids.ts'
  import { slotByName } from '../../../model/select.ts'
  import { nextVariantName, variantsOf } from '../../../model/variants.ts'
  import { app } from '../../../state/app.svelte.ts'
  import { slots } from '../../../state/slots.svelte.ts'
  import { tooltip } from '../../../ui/tooltip.ts'

  let { character, name, names }: { character: Character, name: string, names: readonly string[] } = $props()

  const slot = $derived(slotByName(character, name))
  const variants = $derived(variantsOf(character, name, names))
  const next = $derived(nextVariantName(character, name))
  let adding = $state(false)

  async function add (): Promise<void> {
    if (slot === undefined || adding) return
    adding = true
    const id = newId()
    try {
      const entry = await app.do(character.id, { type: 'slot.copy', from: slot.id, name: next, newId: id }, `${next}: a variant of ${name}`)
      if (entry !== null) {
        const now = app.byId(character.id)
        if (now !== null) await slots.play(now, id)
      }
    } finally {
      adding = false
    }
  }

  const hint = $derived(variants.length === 0
    ? `Add ${next}: a copy of ${name} to change; the game picks one of them at random`
    : `Add ${next} (the game picks at random among ${[name, ...variants.map(v => v.name)].join(', ')})`)
</script>

{#if slot !== undefined}
  <button class="variant" disabled={adding} onclick={add} aria-label="Add a variant of {name}" use:tooltip={hint}>
    <Copy size={11} />{#if variants.length > 0}<span class="count mono">{variants.length + 1}</span>{:else}<span>variant</span>{/if}
  </button>
{/if}

<style>
  .variant { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 5px; border: 0; border-radius: 5px; background: transparent; color: var(--text-3); font-size: 10.5px; }
  .variant:hover:not(:disabled) { color: var(--text-1); background: var(--bg-3); }
  .variant:disabled { opacity: 0.4; }
  .count { font-size: 10px; }
</style>
