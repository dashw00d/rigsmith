<script lang="ts">
  // The animation editor's panel (src/state/clipedit.svelte.ts): start editing the clip playing, then pose and key it in
  // the viewport; delete keys, hold joints in their ranges, save as a new library clip.
  import { onDestroy } from 'svelte'
  import { PencilRuler, Save, ShieldCheck, Sparkles, Trash2, X } from '@lucide/svelte'
  import { animator } from '../../state/animator.svelte.ts'
  import { clipEdit } from '../../state/clipedit.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let name = $state('')
  let seconds = $state(1)
  const keyHere = $derived.by(() => {
    void animator.time
    const u = clipEdit.phase()
    return Object.entries(clipEdit.keys).filter(([b, ks]) => (clipEdit.selected === null || clipEdit.selected === b) && ks.some(k => Math.abs(k.u - u) < 1e-4)).length
  })
  const keyedBones = $derived(Object.keys(clipEdit.keys).length)
  // (a clip that left the stage ends the editing: another one was played)
  $effect(() => {
    const c = animator.current
    if (clipEdit.active && (c === null || c.clipId !== clipEdit.base?.clipId)) clipEdit.stop()
  })
  $effect(() => { if (clipEdit.active && name === '') name = clipEdit.held ? 'New clip' : `${clipEdit.base?.name ?? 'Clip'} edit` })
  onDestroy(() => { clipEdit.stop() })

  function onKey (e: KeyboardEvent): void {
    if (!clipEdit.active || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clipEdit.deleteHere() }
    if (e.key === 'Escape') clipEdit.select(null)
  }
</script>

<svelte:window onkeydown={onKey} />

<Section title="Edit animation">
  {#if !clipEdit.active}
    <p class="faint small">Pose the clip playing and key it: scrub the timeline, drag a joint (a hand or a foot reaches, any other joint swings its bone; the diamond at the hips crouches and jumps, Shift moves it anyhow), or click one and turn it. Every joint keeps to its human range; no foot goes under the floor. Save makes a new library clip.</p>
    <Button block disabled={animator.current === null || animator.current.url === '' || clipEdit.busy !== null} onclick={() => clipEdit.start()}>
      <PencilRuler size={14} /> {animator.current === null ? 'Play a clip to edit it' : `Edit ${animator.current.name}`}
    </Button>
    <div class="row">
      <Button size="sm" variant="ghost" disabled={animator.current === null || animator.current.url === '' || clipEdit.busy !== null} onclick={() => clipEdit.startFromPose(seconds)}><Sparkles size={13} /> New clip from this frame</Button>
      <label class="field" use:tooltip={'Its length (seconds): you can change it while you work'}><input class="num" type="number" min="0.2" max="20" step="0.1" bind:value={seconds} /> s</label>
    </div>
  {:else}
    <div class="row">
      <span class="muted small">{clipEdit.selected ?? 'No joint selected'}</span>
      <span class="faint small">{keyedBones} bone{keyedBones === 1 ? '' : 's'} keyed · {clipEdit.phases.length} frame{clipEdit.phases.length === 1 ? '' : 's'}</span>
    </div>
    <p class="faint small">Letting go of a joint keys it at this frame{clipEdit.held ? '' : " (a bone's first key also pins it at the clip's ends: the change eases in and out)"}. Delete takes this frame's keys off{clipEdit.selected !== null ? ` ${clipEdit.selected}` : ' every bone'}; Esc lets go of the joint.</p>
    <div class="row">
      <Button size="sm" variant="ghost" disabled={keyHere === 0} onclick={() => clipEdit.deleteHere()}><Trash2 size={13} /> Delete key{keyHere > 1 ? 's' : ''} here</Button>
      <Button size="sm" variant="ghost" disabled={keyedBones === 0} onclick={() => clipEdit.clear()}>Clear all</Button>
    </div>
    <span use:tooltip={'Hold every joint inside the range it reached across the library’s motion captures (a horse: its template’s clips)'}><Toggle label="Human joint ranges" checked={clipEdit.limitsOn} onchange={(on: boolean) => clipEdit.setLimits(on)} /></span>
    <Toggle label="Loops" checked={clipEdit.base?.loop ?? false} onchange={(on: boolean) => clipEdit.setLoop(on)} />
    {#if clipEdit.held}
      <label class="field">Length <input class="num" type="number" min="0.2" max="20" step="0.1" value={clipEdit.length} onchange={(e) => clipEdit.setLength(Number((e.target as HTMLInputElement).value))} /> s</label>
    {/if}
    <label class="field">Name <input bind:value={name} /></label>
    <div class="row">
      <Button size="sm" variant="primary" disabled={keyedBones === 0 || name.trim() === '' || clipEdit.busy !== null} onclick={() => clipEdit.save(name.trim())}><Save size={13} /> Save as a new clip</Button>
      <Button size="sm" variant="ghost" onclick={() => clipEdit.stop()}><X size={13} /> Done</Button>
    </div>
    <p class="faint small"><ShieldCheck size={11} /> Saved clips go in the library tagged custom, in the category of {clipEdit.base?.name}; the clip it came from stays as it was.</p>
  {/if}
</Section>

<style>
  .small { font-size: 12px; margin: 0; }
  .row { display: flex; gap: 6px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .field { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
  .field input.num { flex: none; width: 64px; }
  .field input { flex: 1; height: 26px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 6px; }
</style>
