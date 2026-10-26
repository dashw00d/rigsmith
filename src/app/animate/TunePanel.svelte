<script lang="ts">
  // Tune the clip playing: its ground (lift), and keys on its bones and props (src/state/tune.svelte.ts). What plays here
  // is what the game gets (the export applies the same keys: src/engine/keys.ts).
  import { onDestroy } from 'svelte'
  import { Anchor, ArrowDownToLine, Crosshair, KeyRound, Move3d, Rotate3d, Trash2, X } from '@lucide/svelte'
  import type { Character, ClipKey } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { propNode, tune } from '../../state/tune.svelte.ts'
  import { KEY_FPS } from '../../engine/keys.ts'
  import Section from '../../ui/Section.svelte'
  import { tooltip } from '../../ui/tooltip.ts'

  let { character }: { character: Character } = $props()

  const current = $derived(tune.entry)
  const entry = $derived(current?.entry ?? null)
  const frames = $derived(entry !== null && animator.duration > 0 ? Math.max(1, Math.round(animator.duration / entry.speed * KEY_FPS)) : 1)
  const view = $derived(animator.character)
  const bones = $derived(view?.rest?.order.filter(b => view.bones.has(b)) ?? [])
  const propNames = $derived((character.garments ?? []).filter(g => g.mode === 'rigid' && view?.root.getObjectByName(propNode(g.name)) !== undefined).map(g => g.name))
  const targetKeys = $derived.by((): ClipKey[] => {
    const t = tune.target
    if (entry === null || t === null) return []
    return (t.startsWith('bone:') ? entry.keys?.bones?.[t.slice(5)] : entry.keys?.props?.[t.slice(5)]) ?? []
  })
  const keyed = $derived([
    ...Object.entries(entry?.keys?.bones ?? {}).map(([n, k]) => ({ target: `bone:${n}`, name: n, count: k.length })),
    ...Object.entries(entry?.keys?.props ?? {}).map(([n, k]) => ({ target: `prop:${n}`, name: n, count: k.length })),
  ])
  const moves = $derived(tune.target !== null && (tune.target.startsWith('prop:') || tune.target === 'bone:Hips'))
  // the lift shown in centimetres in the game (the unit's game height over this character's height), else % of height
  const perCm = $derived(slots.game?.height != null && view !== null ? slots.game.height / view.height * 100 : null)
  const liftShown = $derived(entry === null ? 0 : perCm !== null ? Math.round((entry.lift ?? 0) * perCm * 10) / 10 : Math.round((entry.lift ?? 0) / (view?.height ?? 1) * 1000) / 10)

  $effect(() => {
    void tune.target; void tune.mode; void animator.current; void entry
    tune.show(app.step === 'animate' && entry !== null && tune.target !== null)
  })
  onDestroy(() => { tune.show(false) })

  function setLift (shown: number): void {
    if (current === null) return
    const lift = perCm !== null ? shown / perCm : shown / 100 * (view?.height ?? 1)
    void tune.patchEntry(current.index, { lift: Math.round(lift * 1e4) / 1e4 })
  }
  function go (k: ClipKey): void {
    animator.setPlaying(false)
    animator.seek(k.u * animator.duration)
  }
  async function zeroKey (): Promise<void> {
    if (tune.target === null) return
    const u = tune.phase()
    await tune.setKeys(tune.target, keys => [...keys.filter(k => Math.abs(k.u - u) > 1e-4), { u, q: [0, 0, 0, 1] as ClipKey['q'] }].sort((a, b) => a.u - b.u))
  }
</script>

{#if entry !== null && current !== null}
  <Section title="Tune {entry.name}">
    <div class="field">
      <span use:tooltip={'Raise or lower the whole body through this clip, so its feet meet the ground (the game gets the same)'}><ArrowDownToLine size={12} /> Ground</span>
      <span class="row">
        <input class="mono" type="number" step="0.5" value={liftShown} onchange={(e) => setLift(Number((e.target as HTMLInputElement).value) || 0)} aria-label="Lift" />
        <span class="faint">{perCm !== null ? 'cm' : '%'}</span>
        <button class="small-btn" disabled={tune.busy} onclick={() => tune.autoGround()} use:tooltip={'Lift it until the lowest point of the clip touches the ground'}>Auto</button>
        {#if (entry.lift ?? 0) !== 0}<button class="icon" onclick={() => tune.patchEntry(current.index, { lift: 0 })} aria-label="No lift"><X size={12} /></button>{/if}
      </span>
    </div>

    <div class="field">
      <span><Crosshair size={12} /> Tweak</span>
      <select value={tune.target ?? ''} onchange={(e) => { tune.target = (e.target as HTMLSelectElement).value || null }} aria-label="Bone or prop to tweak">
        <option value="">Nothing</option>
        {#if propNames.length > 0}<optgroup label="Props">{#each propNames as p}<option value="prop:{p}">{p}</option>{/each}</optgroup>{/if}
        <optgroup label="Bones">{#each bones as b}<option value="bone:{b}">{b}</option>{/each}</optgroup>
      </select>
    </div>

    {#if tune.target !== null}
      <div class="row modes">
        <button class:on={tune.mode === 'rotate'} onclick={() => { tune.mode = 'rotate' }}><Rotate3d size={13} /> Turn</button>
        <button class:on={tune.mode === 'translate'} disabled={!moves} onclick={() => { tune.mode = 'translate' }}><Move3d size={13} /> Move</button>
        <span class="faint mono frame">frame {Math.round(tune.phase() * frames)} / {frames}</span>
      </div>
      <p class="faint small">Pause on a frame (Space; , and . step) and drag the gizmo: letting go keys it there. Between keys it
        blends; {entry.loop ? 'round the loop' : 'before the first and after the last it holds'}.</p>
      <div class="row">
        <button class="small-btn" onclick={() => tune.commit()} use:tooltip={'Key it as it stands at this frame'}><KeyRound size={12} /> Key here</button>
        <button class="small-btn" onclick={zeroKey} use:tooltip={'A key with no change: the clip as it is at this frame (keeps a tweak from spreading past it)'}><Anchor size={12} /> No change here</button>
      </div>
      {#if targetKeys.length > 0}
        <ul class="keys">
          {#each targetKeys as k (k.u)}
            <li>
              <button class="go mono" onclick={() => go(k)}>frame {Math.round(k.u * frames)}</button>
              <span class="faint small">{k.q[3] > 0.99999 && k.p === undefined ? 'no change' : `${Math.round(2 * Math.acos(Math.min(1, Math.abs(k.q[3]))) * 180 / Math.PI)}°${k.p !== undefined ? ' + move' : ''}`}</span>
              <button class="icon" onclick={() => tune.setKeys(tune.target!, ks => ks.filter(x => x !== k))} aria-label="Delete key"><Trash2 size={12} /></button>
            </li>
          {/each}
        </ul>
        <button class="small-btn" onclick={() => tune.setKeys(tune.target!, () => [])}>Clear {tune.target.slice(5)}</button>
      {/if}
    {/if}

    {#if keyed.length > 0}
      <p class="faint small">Keyed: {#each keyed as k, i}<button class="link" onclick={() => { tune.target = k.target }}>{k.name} ({k.count})</button>{i < keyed.length - 1 ? ', ' : ''}{/each}</p>
    {/if}
  </Section>
{/if}

<style>
  .field { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
  .field > span:first-child { color: var(--text-2); display: flex; align-items: center; gap: 4px; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  select, input { height: 26px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 12px; padding: 0 4px; }
  select { max-width: 190px; }
  input { width: 64px; }
  .modes button, .small-btn { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .modes button.on { border-color: var(--accent); color: var(--accent-strong); }
  .modes button:disabled, .small-btn:disabled { opacity: 0.4; }
  .frame { margin-left: auto; font-size: 11px; }
  .icon { width: 22px; height: 22px; border: 0; border-radius: 5px; background: transparent; color: var(--text-3); display: grid; place-items: center; }
  .icon:hover { color: var(--danger); background: var(--danger-soft); }
  .keys { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .keys li { display: flex; align-items: center; gap: 8px; }
  .go { border: 0; background: transparent; color: var(--accent-strong); font-size: 12px; padding: 0; }
  .link { border: 0; background: transparent; color: var(--accent-strong); padding: 0; font-size: 12px; }
  .small { font-size: 12px; margin: 0 0 6px; }
</style>
