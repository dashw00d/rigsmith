<script lang="ts">
  import type { Character } from '../../model/types.ts'
  import { folkOf } from '../../model/folk.ts'
  import Select from '../../ui/Select.svelte'
  let { character, value, onchange, label = 'Stance', testid = 'motion-stance-select' }: {
    character: Character, value: string | null, onchange: (value: string | null) => void, label?: string, testid?: string
  } = $props()
  const options = $derived([{ value: '', label: 'Base' }, ...folkOf(character).stances.map(s => ({ value: s.id, label: s.name }))])
</script>
<Select {label} {testid} {options} value={value ?? ''} onchange={(id) => onchange(id || null)} />
