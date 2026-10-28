<script lang="ts">
  // A socket's hand pose: one of the character's hand poses (Rig → Hand poses, 'pose:<id>'), a fist as a Mixamo grip
  // closes it (its clip id), the clip's own hand ('open'), or the default ('').
  import { app } from '../../state/app.svelte.ts'
  import { FISTS } from '../../state/animator.svelte.ts'
  import { handPoses } from '../../state/handposes.svelte.ts'

  let { value = '', onchange, defaultLabel = 'Default fist', open = true, label = 'Hand pose' }: {
    value?: string, onchange: (value: string) => void, defaultLabel?: string, open?: boolean, label?: string
  } = $props()
  const poses = $derived(app.selected?.handPoses ?? [])
  // (shared by other characters: picking one puts it on this one too)
  const shared = $derived((app.settings?.handPoses ?? []).filter(p => !poses.some(x => x.id === p.id)))
  async function pick (v: string): Promise<void> {
    if (v.startsWith('pose:') && shared.some(p => `pose:${p.id}` === v)) await handPoses.useShared(v.slice(5))
    onchange(v)
  }
  const known = $derived(value === '' || value === 'open' || poses.some(p => `pose:${p.id}` === value) || shared.some(p => `pose:${p.id}` === value) || FISTS.some(([id]) => id === value))
</script>

<select {value} onchange={(e) => { void pick((e.target as HTMLSelectElement).value) }} aria-label={label}>
  <option value="">{defaultLabel}</option>
  {#if open}<option value="open">Open (as the clip has it)</option>{/if}
  {#if poses.length > 0}
    <optgroup label="Hand poses (Rig)">
      {#each poses as p (p.id)}<option value={`pose:${p.id}`}>{p.name}</option>{/each}
    </optgroup>
  {/if}
  {#if shared.length > 0}
    <optgroup label="Shared hand poses">
      {#each shared as p (p.id)}<option value={`pose:${p.id}`}>{p.name}</option>{/each}
    </optgroup>
  {/if}
  <optgroup label="Fists (as a clip closes them)">
    {#each FISTS as [id, name] (id)}<option value={id}>{name}</option>{/each}
  </optgroup>
  {#if !known}<option value={value}>{value.startsWith('pose:') ? 'A deleted pose' : value.replace(/^mixamo-/, '')}</option>{/if}
</select>

<style>
  select { height: 28px; max-width: 190px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 6px; font-size: 12px; }
</style>
