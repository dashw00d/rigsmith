<script lang="ts">
  // One library clip: its sprite (played on the character), its badges, and the round button, whose meaning follows
  // what is armed (src/app/motion/rules.ts cardAction): an armed slot is filled with it; trials of it are taken out
  // (asked first); otherwise it is added as a trial. A clip a slot plays is never taken out from here.
  import { onMount } from 'svelte'
  import { Check, CircleQuestionMark, Plus, Repeat, TriangleAlert } from '@lucide/svelte'
  import type { Character, LibraryClip } from '../../state/api.ts'
  import type { LibraryIndexRow } from '../../../server/library.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { contextMenu } from '../../ui/contextmenu.ts'
  import { SPRITE_FRAMES } from '../../engine/PreviewRenderer.ts'
  import { tooltip } from '../../ui/tooltip.ts'
  import { cardAction, usesOf } from './rules.ts'

  let { clip, character, resolve }: { clip: LibraryIndexRow, character: Character | null, resolve: (clip: LibraryIndexRow) => Promise<LibraryClip> } = $props()
  const compatible = $derived(character !== null && (character.skeleton.template ?? 'human') === clip.rig)
  let sheet = $state<string | null>(null)
  let failed = $state(false)
  let visible = $state(false)
  let node: HTMLDivElement

  onMount(() => {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      observer.disconnect()
      visible = true
    }, { rootMargin: '200px' })
    observer.observe(node)
    return () => { observer.disconnect() }
  })

  // (asked again when it comes into view, and when previews are made for another character)
  $effect(() => {
    void animator.previewVersion
    if (!visible) return
    let cancelled = false
    animator.sprite(clip.url).then(result => { if (!cancelled) { sheet = result; failed = result === null } }, () => { if (!cancelled) failed = true })
    return () => { cancelled = true }
  })

  const playing = $derived(animator.playing?.kind === 'library' && animator.playing.library?.id === clip.id)
  const uses = $derived(character === null ? { slots: [], trials: [] } : usesOf(character, clip.id, slots.names))
  const action = $derived(character === null ? null : cardAction(character, clip.id, slots.names, slots.armed))
  const duration = $derived(clip.duration < 10 ? clip.duration.toFixed(1) : Math.round(clip.duration).toString())
  const named = $derived(clip.nameSource !== 'provisional')
  const uncertain = $derived(clip.nameSource === 'motion-candidate')
  // (Mixamo's description, when it says more than the name: "Walking" -> "Walking With A Briefcase")
  const description = $derived(clip.description !== undefined && clip.description.toLowerCase() !== clip.name.toLowerCase() ? clip.description : '')
  const detail = $derived([description, undefined].filter(Boolean).join(' · '))
  const hint = $derived.by(() => {
    if (detail === '' && !uncertain) return null
    const alternatives = ([] as string[]).filter(n => n !== clip.name)
    const unsure = uncertain ? ` · Uncertain name${alternatives.length > 0 ? `; could also be ${[...new Set(alternatives)].join(', ')}` : ''}` : ''
    return `${clip.name}${detail === '' ? '' : ` — ${detail}`}${unsure}`
  })
  // (the library audit: the motion contradicts the name, an idle named "Carrying", a seated "Talking")
  const warning = $derived((clip.problems ?? []).length > 0 ? `Doesn’t move as its name says: ${(clip.problems ?? []).map(p => p.motion).join('; ')}` : null)
  const slotNames = $derived(uses.slots.map(s => s.name))
  const button = $derived.by(() => {
    if (action === null) return null
    if (action.kind === 'fill') return { label: `Fill ${action.target.name}`, hint: `Fill ${action.target.name} with this clip` }
    if (action.kind === 'remove') return { label: 'Remove its trials', hint: `Kept as ${action.trials.map(s => s.name).join(', ')} (click to remove)` }
    return { label: 'Add as a trial', hint: slotNames.length > 0 ? `Add as a trial (${slotNames.join(', ')} already plays it)` : 'Add as a trial' }
  })

  async function press (e?: MouseEvent): Promise<void> {
    e?.stopPropagation()
    if (character === null || action === null || !compatible) return
    let full: LibraryClip
    try { full = await resolve(clip) } catch { return }
    if (action.kind === 'fill') await slots.fill(character, action.target, full)
    else if (action.kind === 'remove') await slots.removeTrials(character, action.trials, clip.name)
    else await slots.addTrial(character, full)
  }

  async function play (): Promise<void> { try { if (compatible) await animator.playLibrary(await resolve(clip)) } catch { /* resolve reports the error */ } }
</script>

<div use:contextMenu={() => [{ label: 'Preview', disabled: !compatible, run: () => { void play() } }, { label: action?.kind === 'remove' ? 'Remove trials' : action?.kind === 'fill' ? 'Fill slot' : 'Add as a trial', disabled: !compatible || action === null, run: () => { void press() } }]} data-testid="lib-clip" data-id={clip.id} data-loop={clip.loop} class="card" class:playing bind:this={node} role="button" tabindex="0" aria-label="Preview {clip.name}"
  onclick={play} onpointerenter={play} onkeydown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) play() }}>
  <div class="preview" style={sheet ? `--sheet: url(${sheet}); --frames: ${SPRITE_FRAMES}` : ''} class:ready={sheet !== null}>
    {#if sheet === null && !failed}<div class="shimmer"></div>{/if}
    <span class="time mono">{duration}s</span>
    {#if clip.loop}<span class="loop" use:tooltip={'Loops seamlessly'}><Repeat size={11} /></span>{/if}
    {#if clip.source === 'custom'}<span class="custom" use:tooltip={'Made here (the animation editor, or a script)'}>custom</span>{/if}
    {#if warning}<span class="warn" use:tooltip={warning} aria-label={warning}><TriangleAlert size={12} /></span>{/if}
    {#if button !== null && action !== null}
      <button class="add" class:on={action.kind === 'remove'} class:slot={action.kind === 'fill'} disabled={!compatible} title={!compatible ? `Requires ${clip.rig} rig` : undefined} onclick={press} aria-label={button.label} use:tooltip={button.hint}>
        {#if action.kind === 'fill'}<span class="slotname">{action.target.name}</span>{:else if action.kind === 'remove'}<Check size={14} strokeWidth={3} />{:else}<Plus size={15} />{/if}
      </button>
    {/if}
  </div>
  <div class="label" use:tooltip={hint}>
    <span class="name" class:provisional={!named}>{clip.name}{#if uncertain}<span class="unsure" aria-label="Uncertain name"><CircleQuestionMark size={11} /></span>{/if}</span>
    {#if detail}<span class="detail">{detail}</span>{/if}
    {#if slotNames.length > 0}<span class="uses">Plays {slotNames.join(', ')}</span>{/if}
  </div>
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    border-radius: var(--r-2);
    background: var(--bg-2);
    border: 1px solid var(--line);
    overflow: hidden;
    cursor: pointer;
    transition: border-color var(--fast), transform var(--fast), box-shadow var(--fast);
    outline: none;
  }
  .card:hover { border-color: var(--line-strong); transform: translateY(-1px); box-shadow: 0 8px 22px -12px rgb(0 0 0 / 70%); }
  .card:focus-visible { border-color: var(--accent); }
  .card.playing { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .preview {
    position: relative;
    aspect-ratio: 1;
    background:
      var(--sheet, none) 33.3% 0 / calc(var(--frames, 1) * 100%) 100% no-repeat,
      radial-gradient(circle at 50% 35%, #232a3b, #14171e 75%);
  }
  .preview.ready { background-position: 33.3% 0, 0 0; }
  .card:hover .preview.ready { animation: play 1.4s steps(var(--frames)) infinite; }
  @keyframes play { from { background-position: 0 0, 0 0; } to { background-position: calc(var(--frames) * 100% / (var(--frames) - 1)) 0, 0 0; } }
  .shimmer { position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, rgb(255 255 255 / 4%) 50%, transparent 70%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }
  .time { position: absolute; left: 6px; bottom: 6px; font-size: 10.5px; padding: 1px 5px; border-radius: 4px; background: rgb(10 11 14 / 70%); color: var(--text-2); }
  .loop { position: absolute; left: 6px; top: 6px; color: var(--text-3); display: grid; }
  .warn { position: absolute; right: 6px; bottom: 6px; padding: 3px; border-radius: 4px; display: grid; background: var(--warn-soft); color: var(--warn); }
  .add {
    position: absolute;
    right: 6px;
    top: 6px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 0;
    display: grid;
    place-items: center;
    background: rgb(10 11 14 / 70%);
    color: var(--text-1);
    opacity: 0;
    transition: opacity var(--fast), background var(--fast), transform var(--fast);
  }
  .card:hover .add, .add.on, .card:focus-within .add, .add:focus-visible { opacity: 1; }
  .add:hover { transform: scale(1.08); background: var(--accent); color: var(--accent-ink); }
  .add.on { background: var(--ok); color: #06140d; }
  .add.on:hover { background: var(--danger); color: #1b0d0d; }
  .add.slot { opacity: 1; width: auto; max-width: calc(100% - 12px); padding: 0 9px; border-radius: 13px; background: var(--accent); color: var(--accent-ink); }
  .custom { position: absolute; left: 50%; transform: translateX(-50%); top: 6px; padding: 1px 6px; border-radius: 4px; background: rgb(255 122 184 / 85%); color: #1b0d14; font-size: 10px; font-weight: 700; letter-spacing: 0.02em; }
  .slotname { font-size: 11px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .label { padding: 7px 8px 8px; min-height: 40px; display: flex; flex-direction: column; gap: 2px; }
  .name { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; font-weight: 550; line-height: 1.3; }
  .name.provisional { color: var(--text-2); font-weight: 450; }
  .unsure { display: inline-grid; margin-left: 4px; vertical-align: -1px; color: var(--text-3); }
  .detail, .uses { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; line-height: 1.3; color: var(--text-3); }
  .uses { color: var(--ok); }
</style>
