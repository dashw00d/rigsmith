<script lang="ts">
  import type { Character } from '../../model/types.ts'
  import { setsOf } from '../../model/folk.ts'
  import { stanceOf } from '../../model/stances.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import { stance } from '../../state/stance.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { cultureOf } from '../gear/wardrobe.ts'
  import Select from '../../ui/Select.svelte'

  let { character }: { character: Character } = $props()
  const sets = $derived(setsOf(character))
  const worn = $derived(dress.worn(character).outfit)
  const selected = $derived(sets.find(s => s.name === worn)?.id ?? '')

  function choose (id: string): void {
    const set = sets.find(s => s.id === id)
    dress.wearOutfit(character, set?.name ?? null)
    stance.select(character.id, set === undefined ? null : stanceOf(character, set.id))
    void animator.refresh()
  }
</script>

<label class="dressed">
  <span>Dressed as</span>
  <Select label="Dressed as" testid="motion-dressed-as" size="sm" value={selected}
    options={[{ value: '', label: 'None' }, ...sets.map(set => ({ value: set.id, label: set.name, group: cultureOf(set.name, set.tags) ?? 'Other' }))]}
    onchange={choose} />
</label>

<style>
  .dressed { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--text-2); font-size: 12px; }
</style>
