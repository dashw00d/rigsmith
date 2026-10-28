<script lang="ts">
  // Which pose a hand takes (DESIGN.md §4.7): the default fist, the clip's own hand, one of the character's hand poses,
  // a shared one, or the fist a library clip closes. Picking a shared pose puts it on the character first, so what
  // refers to it always finds it there. Used for handles (Gear), a slot's hand pose (Motion), the editor and hands.hold.
  import type { Character, HandPoseRef, Side } from '../../state/api.ts'
  import { FISTS } from '../../engine/hands.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import Select from '../../ui/Select.svelte'
  import { refKey, refOf } from './text.ts'

  interface Props {
    character: Character
    value: HandPoseRef | undefined
    onchange: (value: HandPoseRef | undefined) => void
    /** The choice for no pose set (absent: there is none, and unset reads as the default fist). */
    unsetLabel?: string
    /** The hand it is for (its accessible name). */
    side?: Side
    disabled?: boolean
    size?: 'sm' | 'md'
  }
  let { character, value, onchange, unsetLabel, side, disabled = false, size = 'sm' }: Props = $props()

  const mine = $derived(character.hands.poses)
  // (shared by other characters and not on this one yet)
  const shared = $derived(hands.shared.filter(p => !mine.some(x => x.id === p.id)))
  const current = $derived(value === undefined && unsetLabel === undefined ? 'default' : refKey(value))

  type Option = { value: string, label: string, group?: string }
  const options = $derived.by(() => {
    const out: Option[] = []
    if (unsetLabel !== undefined) out.push({ value: '', label: unsetLabel })
    out.push({ value: 'default', label: 'Default fist' }, { value: 'clip', label: 'Open (the clip\'s own hand)' })
    for (const p of mine) out.push({ value: `pose:${p.id}`, label: p.name, group: 'Hand poses' })
    for (const p of shared) out.push({ value: `pose:${p.id}`, label: p.name, group: 'Shared hand poses' })
    for (const [id, name] of FISTS) out.push({ value: `fist:${id}`, label: name, group: 'Fists from clips' })
    // (what it holds now, even when it is none of those: a pose since deleted, another clip's fist)
    if (!out.some(o => o.value === current)) {
      const ref = refOf(current)
      const label = ref !== undefined && typeof ref === 'object' ? ('pose' in ref ? 'A deleted pose' : `${ref.fist.replace(/^mixamo-/, '')} fist`) : current
      out.push({ value: current, label })
    }
    return out
  })

  function pick (key: string): void {
    const ref = refOf(key)
    if (ref !== undefined && typeof ref === 'object' && 'pose' in ref && shared.some(p => p.id === ref.pose)) void hands.useShared(character, ref.pose)
    onchange(ref)
  }
</script>

<Select {size} {options} value={current} onchange={pick} {disabled} width="190px"
  label={side === undefined ? 'Hand pose' : `${side} hand pose`} />
