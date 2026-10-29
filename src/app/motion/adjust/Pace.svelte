<script lang="ts">
  // Pace: retimed so its planted foot covers ground as fast as another clip's (a carry at the walk's pace), measured on
  // that clip as it plays (its speed and blow timing).
  import type { Character, Slot } from '../../../state/api.ts'
  import type { Row } from '../rules.ts'
  import { adjust } from '../../../state/adjust.svelte.ts'
  import Field from '../../../ui/Field.svelte'
  import Select from '../../../ui/Select.svelte'

  let { character, clipSlot: slot, adjustment: a }: { character: Character, clipSlot: Slot, adjustment: Extract<Row, { kind: 'pace' }> } = $props()

  const options = $derived(character.clips.filter(s => s.id !== slot.id).map(s => ({ value: s.id, label: s.name })))
  const report = $derived(adjust.playingSlot(slot.id)?.baked?.report[a.id] as { retimed?: number, missing?: boolean } | undefined)
</script>

<Field label="Like" hint={report?.retimed !== undefined ? `Played ${report.retimed}× as fast` : 'Its feet as fast as this clip’s'}>
  <Select size="sm" label="Pace like" value={a.like} {options} onchange={(v) => adjust.update(character, slot.id, a.id, { like: v })} />
</Field>
