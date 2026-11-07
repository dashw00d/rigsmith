<script lang="ts">
  import { Check, Plus, Repeat } from '@lucide/svelte'
  import type { LibraryIndexRow } from '../../../server/library.ts'
  import type { Character, LibraryClip } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { contextMenu } from '../../ui/contextmenu.ts'
  import { cardAction } from './rules.ts'

  let { clip, character, uses, resolve }: { clip: LibraryIndexRow, character: Character | null, uses: number, resolve: (clip: LibraryIndexRow) => Promise<LibraryClip> } = $props()
  const compatible = $derived(character !== null && (character.skeleton.template ?? 'human') === clip.rig)
  const action = $derived(character === null ? null : cardAction(character, clip.id, slots.names, slots.armed))
  async function play (): Promise<void> { try { if (compatible) await animator.playLibrary(await resolve(clip)) } catch { /* resolve reports the error */ } }
  async function press (e?: MouseEvent): Promise<void> {
    e?.stopPropagation()
    if (!character || !action || !compatible) return
    let full: LibraryClip
    try { full = await resolve(clip) } catch { return }
    if (action.kind === 'fill') await slots.fill(character, action.target, full)
    else if (action.kind === 'remove') await slots.removeTrials(character, action.trials, clip.name)
    else await slots.addTrial(character, full)
  }
</script>

<div class="clip" use:contextMenu={() => [{ label: 'Preview', disabled: !compatible, run: () => { void play() } }, { label: action?.kind === 'remove' ? 'Remove trials' : action?.kind === 'fill' ? 'Fill slot' : 'Add as a trial', disabled: !compatible || action === null, run: () => { void press() } }]} data-testid="lib-clip" data-id={clip.id} data-loop={clip.loop} data-uses={uses} data-duration={clip.duration} role="button" tabindex="0" aria-label="Preview {clip.name}"
  onclick={play} onpointerenter={play} onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void play() } }}>
  <span class="name">{clip.name}</span><span class="category">{clip.category}</span><span>{clip.duration.toFixed(1)}s</span>
  <span class="loop" aria-label={clip.loop ? 'Loop' : 'One shot'}>{#if clip.loop}<Repeat size={12} />{/if}</span><span>{uses || ''}</span>
  <button class="add" aria-label={action?.kind === 'fill' ? 'Fill slot' : action?.kind === 'remove' ? 'Remove trials' : 'Add as a trial'}
    disabled={!compatible || action === null} title={!compatible ? `Requires ${clip.rig} rig` : 'Add or remove this clip'} onclick={press}>
    {#if action?.kind === 'remove'}<Check size={13} />{:else}<Plus size={13} />{/if}
  </button>
</div>

<style>
  .clip { box-sizing: border-box; height: 30px; display: grid; grid-template-columns: minmax(80px, 1fr) 72px 42px 16px 20px 24px; gap: 5px; align-items: center; padding: 0 8px; font-size: 11px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .clip:hover { background: var(--bg-2); }
  .name, .category { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .category { color: var(--text-3); }
  .add { border: 0; border-radius: 50%; width: 22px; height: 22px; display: grid; place-items: center; background: var(--bg-3); color: var(--text-1); }
  .add:disabled { opacity: .35; }
</style>
