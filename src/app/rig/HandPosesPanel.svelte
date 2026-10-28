<script lang="ts">
  // Rig → Hand poses: the character's named finger poses (src/state/handposes.svelte.ts). Sockets close their hands into
  // them; the Animate step sends a hand's pose from any frame of a clip here.
  import { Hand, Plus, Trash2, Users } from '@lucide/svelte'
  import { handPoses } from '../../state/handposes.svelte.ts'
  import { animator, FISTS } from '../../state/animator.svelte.ts'
  import { untrack } from 'svelte'
  import { FINGERS } from '../../engine/handposes.ts'
  import { HandDots } from '../../engine/handdots.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { app } from '../../state/app.svelte.ts'

  const poses = $derived(handPoses.poses)
  const open = $derived(poses.find(p => p.id === handPoses.editing) ?? null)
  // (shared poses this character hasn't got yet)
  const others = $derived(handPoses.shared.filter(p => !poses.some(x => x.id === p.id)))
  let side = $state(handPoses.side)
  // (the reference grip and the ranges, for the character on stage)
  $effect(() => { void app.selected?.id; void viewer.character; void handPoses.prepare() })
  // While a pose is open: a ring on the shown hand's finger joints; dragging one bends the finger by the joint behind it.
  const openId = $derived(open?.id ?? null)
  $effect(() => {
    const view = viewer.character; const stage = viewer.stage; const shown = handPoses.side
    if (openId === null || view === null || stage === null) return
    const dots = untrack(() => new HandDots(stage, view.root, shown, { turn: (bone, local) => { handPoses.turnJoint(bone, local) }, end: () => {} }))
    return () => { dots.dispose() }
  })
</script>

<Section title="Hand poses">
  <div class="new">
    <Button size="sm" onclick={() => handPoses.addFist(undefined, 'Grip')} title="The default fist: a hand closed round a shaft, as a Mixamo grip closes it"><Plus size={12} /> Grip</Button>
    <Button size="sm" variant="ghost" onclick={() => handPoses.addRest()} title="Fingers straight, as at rest"><Plus size={12} /> Blank</Button>
    <select value="" aria-label="New pose from a fist clip" onchange={(e) => { const v = (e.target as HTMLSelectElement).value; (e.target as HTMLSelectElement).value = ''; if (v !== '') void handPoses.addFist(v) }}>
      <option value="">From a fist…</option>
      {#each FISTS as [id, name] (id)}<option value={id}>{name}</option>{/each}
    </select>
  </div>
  <p class="faint small">Named finger poses for this character: a fist round a shaft, a bow grip, a drawstring pinch. Props'
    sockets close their hands into them (Outfit, or Animate → Edit). Make one from rest here, or send a hand from any frame
    of a clip (Animate: <em>Send hand pose</em>). Kept as each finger's bend, so a re-rig keeps them; either hand takes
    them, mirrored.</p>
  {#if poses.length === 0}
    <div class="empty"><Hand size={16} /><span class="faint small">No hand poses yet. Hands carrying a prop close into the default
      fist until you pick another; <strong>Grip</strong> adds it here to shape.</span></div>
  {:else}
    <ul>
      {#each poses as p (p.id)}
        <li class:selected={p.id === handPoses.editing}>
          <button class="row" onclick={() => handPoses.open(p.id === handPoses.editing ? null : p.id)}>
            <span class="name">{p.name}</span>
            <span class="faint small">{p.from !== undefined ? `from ${p.from.clip} at ${p.from.at.toFixed(2)} s` : 'made by hand'}</span>
          </button>
          <button class="icon share" class:on={handPoses.isShared(p.id)} onclick={() => handPoses.share(p.id, !handPoses.isShared(p.id))}
            aria-label="{handPoses.isShared(p.id) ? 'Stop sharing' : 'Share'} {p.name}" title={handPoses.isShared(p.id) ? 'Shared with every character (click to stop)' : 'Share with every character'}><Users size={13} /></button>
          <button class="icon" onclick={() => handPoses.remove(p.id)} aria-label="Delete {p.name}"><Trash2 size={13} /></button>
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
          <button class="icon share" onclick={() => handPoses.useShared(p.id)} aria-label="Add {p.name}" title="Add to this character"><Plus size={13} /></button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if open}
    <div class="editor">
      <input class="name-input" value={open.name} aria-label="Pose name"
        onchange={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v !== '') void handPoses.rename(open.id, v) }} />
      <div class="field">
        <span class="faint small">Shown on</span>
        <Segmented options={[{ value: 'Left', label: 'Left hand' }, { value: 'Right', label: 'Right hand' }]} bind:value={side} onchange={(s) => handPoses.setSide(s as 'Left' | 'Right')} />
      </div>
      <p class="faint small">Drag the rings on the {side.toLowerCase()} hand to bend its fingers: in, out, or spread a little. The sliders
        open or close a whole finger at once.</p>
      <Toggle label="Natural limits" hint="Every joint held within what a person's finger reaches (measured on the library's motion captures)" bind:checked={handPoses.natural} />
      <label class="slider big"><span>Whole hand</span>
        <span class="ends faint">open</span>
        <input type="range" min="0" max="1.3" step="0.01" value={handPoses.closed(open.id, 'all')} disabled={handPoses.ref === null}
          oninput={(e) => handPoses.setClosed(open.id, 'all', Number((e.target as HTMLInputElement).value))} />
        <span class="ends faint">fist</span></label>
      {#each FINGERS as f}
        <div class="finger">
          <label class="slider big"><span class="fname">{f}</span>
            <span class="ends faint">open</span>
            <input type="range" min="0" max="1.3" step="0.01" value={handPoses.closed(open.id, f)} disabled={handPoses.ref === null}
              oninput={(e) => handPoses.setClosed(open.id, f, Number((e.target as HTMLInputElement).value))} />
            <span class="ends faint">fist</span></label>
        </div>
      {/each}
      <p class="faint small">Shaped as made on the {open.side.toLowerCase()} hand; the other takes it mirrored.
        {#if animator.current?.clipId === 'handpose'}Showing it at rest.{/if}</p>
      <Button size="sm" variant="ghost" onclick={() => handPoses.open(null)}>Done</Button>
    </div>
  {/if}
</Section>

<style>
  .small { font-size: 12px; margin: 0; }
  .empty { display: flex; gap: 8px; align-items: flex-start; padding: 10px; border: 1px dashed var(--line-strong); border-radius: var(--r-2); }
  ul { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; border-radius: var(--r-1); border: 1px solid transparent; }
  li:hover { background: var(--bg-2); }
  li.selected { background: var(--accent-soft); border-color: rgb(142 162 255 / 30%); }
  .row { flex: 1; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px; border: 0; background: transparent; text-align: left; }
  .name { font-weight: 550; }
  .icon { width: 26px; height: 26px; margin-right: 4px; border: 0; border-radius: 5px; background: transparent; color: var(--text-3); display: grid; place-items: center; }
  .icon:hover { color: var(--danger); background: var(--danger-soft); }
  .icon.share { margin-right: 0; }
  .icon.share.on { color: var(--accent-strong); }
  .icon.share:hover { color: var(--text-1); background: var(--bg-3); }
  .new { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .new select { height: 28px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 6px; font-size: 12px; }
  .editor { display: flex; flex-direction: column; gap: 8px; padding-top: 6px; }
  .name-input { height: 28px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-1); padding: 0 8px; }
  .field { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .finger { display: flex; flex-direction: column; gap: 2px; padding-top: 4px; border-top: 1px solid var(--line); }
  .fname { font-size: 12px; font-weight: 600; }
  .slider { display: grid; grid-template-columns: 50px 1fr 36px; align-items: center; gap: 6px; font-size: 11.5px; }
  .slider.big { grid-template-columns: 70px 28px 1fr 22px; }
  .ends { font-size: 10.5px; }
  .slider input { width: 100%; accent-color: var(--accent); }
</style>
