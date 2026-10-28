<script lang="ts">
  // The character's named hand poses: new ones (the default grip, a blank hand, the fist of a clip, a hand off the frame
  // shown), each opened to shape, shared with every character or deleted; and the shared ones it hasn't got yet.
  import { Hand, Plus, Trash2, Users } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import { DEFAULT_FIST, FISTS } from '../../engine/hands.ts'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import Select from '../../ui/Select.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { sourceText } from './text.ts'

  let { character }: { character: Character } = $props()

  const poses = $derived(hands.poses(character))
  const others = $derived(hands.shared.filter(p => !poses.some(x => x.id === p.id)))
  const openId = $derived(hands.editing?.character === character.id ? hands.editing.pose : null)
  // (fists are measured on the rig on stage)
  const onStage = $derived(hands.view !== null)
  const fistOptions = FISTS.map(([id, name]) => ({ value: id, label: name }))
  let fist = $state<string | null>(null)

  function fromFist (id: string): void {
    fist = null
    void hands.addFist(character, id)
  }
</script>

<div class="new">
  <span use:tooltip={'The default fist, closed round a shaft as a Mixamo grip closes it'}>
    <Button size="sm" disabled={!onStage} onclick={() => hands.addFist(character, DEFAULT_FIST, 'Grip')}><Plus size={12} /> Grip</Button>
  </span>
  <span use:tooltip={'Fingers straight, as at rest'}>
    <Button size="sm" variant="ghost" onclick={() => hands.addBlank(character)}><Plus size={12} /> Blank</Button>
  </span>
  <Select size="sm" options={fistOptions} bind:value={fist} onchange={fromFist} placeholder="From a fist…" label="New pose from a clip's fist" disabled={!onStage} />
</div>
<div class="take">
  <span class="faint small">Take from the frame shown</span>
  <Button size="sm" variant="ghost" disabled={animator.playing === null} onclick={() => hands.capture(character, 'Left')}><Hand size={12} /> Left</Button>
  <Button size="sm" variant="ghost" disabled={animator.playing === null} onclick={() => hands.capture(character, 'Right')}><Hand size={12} /> Right</Button>
</div>

{#if poses.length === 0}
  <EmptyState compact icon={Hand} title="No hand poses yet"
    body="A hand carrying gear closes into the default fist until something says otherwise. Grip adds that fist here to shape." />
{:else}
  <ul>
    {#each poses as p (p.id)}
      <li class:selected={p.id === openId}>
        <button class="row" aria-expanded={p.id === openId} onclick={() => hands.open(character, p.id === openId ? null : p.id)}>
          <span class="name">{p.name}</span>
          <span class="faint small">{sourceText(character, p)}</span>
        </button>
        <IconButton size="sm" label={hands.isShared(p.id) ? `Stop sharing ${p.name}` : `Share ${p.name}`} active={hands.isShared(p.id)}
          hint={hands.isShared(p.id) ? 'Shared with every character (click to stop)' : 'Share with every character'}
          onclick={() => hands.share(character, p.id, !hands.isShared(p.id))}><Users size={13} /></IconButton>
        <IconButton size="sm" variant="danger" label="Delete {p.name}" onclick={() => hands.remove(character, p.id)}><Trash2 size={13} /></IconButton>
      </li>
    {/each}
  </ul>
{/if}

{#if others.length > 0}
  <span class="faint small">Shared by other characters</span>
  <ul>
    {#each others as p (p.id)}
      <li>
        <span class="row"><span class="name faint">{p.name}</span></span>
        <IconButton size="sm" label="Add {p.name} to {character.name}" onclick={() => hands.useShared(character, p.id)}><Plus size={13} /></IconButton>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .new, .take { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .take .small { margin-right: auto; }
  ul { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; gap: 2px; padding-right: 4px; border-radius: var(--r-1); border: 1px solid transparent; }
  li:hover { background: var(--bg-2); }
  li.selected { background: var(--accent-soft); border-color: rgb(142 162 255 / 30%); }
  .row { flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px; border: 0; background: transparent; color: inherit; text-align: left; }
  button.row { cursor: pointer; }
  .row .small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name { font-weight: 550; white-space: nowrap; }
</style>
