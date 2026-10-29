<script lang="ts">
  // The hand pose open to shape: its name, the hand it is shown and shaped on, Natural limits, a slider for the whole
  // hand and one per finger (open to the default fist, and a little past), and rings on the shown hand's finger joints
  // in the viewport (dragging one turns the joint behind it). Shown on the character while open; each change is saved
  // a moment after, as a command.
  import { untrack } from 'svelte'
  import type { Character, HandPose, Side } from '../../state/api.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import { FINGERS, type Finger } from '../../engine/handposes.ts'
  import { HandDots } from '../../engine/handdots.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import TextField from '../../ui/TextField.svelte'
  import Toggle from '../../ui/Toggle.svelte'

  let { character, pose }: { character: Character, pose: HandPose } = $props()

  const sides: Array<{ value: Side, label: string }> = [{ value: 'Left', label: 'Left hand' }, { value: 'Right', label: 'Right hand' }]
  // (the clip editor's clip is on stage: the pose can be shaped by its sliders, not seen or dragged)
  const shared = $derived(hands.isShared(pose.id))

  // The reference grip and the natural ranges, for the rig on stage.
  $effect(() => { void hands.view; untrack(() => { void hands.prepare(character) }) })

  // Shown on the character as it is now: on opening, after each change, on the other hand.
  const shown = $derived(`${pose.id}|${pose.side}|${hands.side}|${JSON.stringify(pose.joints)}`)
  $effect(() => {
    void shown; void hands.view
    untrack(() => { hands.preview(character, hands.side, pose) })
  })
  // (closed: what is being shaped saved now, the character back as it was)
  $effect(() => () => { untrack(() => { hands.flush(); hands.preview(character, hands.side, null) }) })

  // Rings on the shown hand's finger joints while it is open; a drag let go saves at once.
  $effect(() => {
    const view = hands.view; const stage = viewer.stage; const side = hands.side
    if (view === null || stage === null) return
    const dots = untrack(() => new HandDots(stage, view.root, side, {
      turn: (bone, local) => { hands.turnJoint(character, bone, local) },
      end: () => { hands.flush() },
    }))
    return () => { dots.dispose() }
  })

  const value = (finger: Finger | 'all'): number => hands.closed(pose, finger)
  const set = (finger: Finger | 'all', e: Event): void => { hands.setClosed(character, pose.id, finger, Number((e.currentTarget as HTMLInputElement).value)) }
</script>

<div class="editor">
  <Field label="Name">
    <TextField size="sm" value={pose.name} label="Pose name" oncommit={(v) => hands.rename(character, pose.id, v)} />
  </Field>
  <Field label="Shown on" group>
    <Segmented size="sm" options={sides} value={hands.side} label="Shown on" onchange={(s) => { hands.setSide(s) }} />
  </Field>
  <Toggle label="Natural limits" hint="Each joint held within what a person's finger reaches (measured on the library's captures)" bind:checked={hands.natural} />

  <p class="faint small">Drag the rings on the {hands.side.toLowerCase()} hand to bend its fingers: in, out, or spread a little. A slider
    closes a whole finger at once.</p>

  <datalist id="hand-fist"><option value="1"></option></datalist>
  <label class="slider all">
    <span class="what">Whole hand</span>
    <span class="end faint">open</span>
    <input type="range" min="0" max="1.3" step="0.01" list="hand-fist" value={value('all')} disabled={hands.ref === null}
      oninput={(e) => set('all', e)} onchange={() => hands.flush()} />
    <span class="end faint">fist</span>
  </label>
  {#each FINGERS as f (f)}
    <label class="slider">
      <span class="what">{f}</span>
      <span class="end faint">open</span>
      <input type="range" min="0" max="1.3" step="0.01" list="hand-fist" value={value(f)} disabled={hands.ref === null}
        oninput={(e) => set(f, e)} onchange={() => hands.flush()} />
      <span class="end faint">fist</span>
    </label>
  {/each}
  {#if hands.ref === null && hands.view !== null}<p class="faint small">Measuring the default fist the sliders close toward…</p>{/if}
  {#if hands.view === null}<p class="faint small">The sliders need the rigged character on stage.</p>{/if}

  <p class="faint small">Made on the {pose.side.toLowerCase()} hand; the other takes it mirrored. The tick on each slider is the
    default fist; past it closes further.{#if shared} Shared: the shared copy changes with it (characters that took one keep
    theirs).{/if}</p>
  <div class="done"><Button size="sm" variant="ghost" onclick={() => hands.open(character, null)}>Done</Button></div>
</div>

<style>
  .editor { display: flex; flex-direction: column; gap: 8px; padding-top: 6px; border-top: 1px solid var(--line); }
  .small { font-size: 12px; margin: 0; }
  .slider { display: grid; grid-template-columns: 76px 30px 1fr 24px; align-items: center; gap: 6px; font-size: 12px; }
  .slider.all { padding-bottom: 4px; border-bottom: 1px solid var(--line); }
  .slider.all .what { font-weight: 600; }
  .what { color: var(--text-2); }
  .end { font-size: 10.5px; }
  .slider input { width: 100%; accent-color: var(--accent); }
  .done { display: flex; justify-content: flex-end; }
</style>
