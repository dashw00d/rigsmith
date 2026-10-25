<script lang="ts">
  // The character's clip scripts (src/engine/scripts.ts): switch each on or off, set it, add or remove one. The viewer
  // plays entries with them, and the game export applies the same ones.
  import { Hand, Plus, Swords, Timer, Trash2 } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { describe, type ClipScript } from '../../engine/scripts.ts'
  import Section from '../../ui/Section.svelte'
  import Toggle from '../../ui/Toggle.svelte'

  let { character }: { character: Character } = $props()

  const scripts = $derived(character.scripts ?? [])
  const names = $derived(character.animations.map(a => a.name))

  async function save (next: ClipScript[]): Promise<void> {
    await app.update(character.id, { scripts: next })
    void animator.refresh()
  }

  function change (id: string, patch: Partial<ClipScript>): void {
    void save(scripts.map(s => (s.id === id ? { ...s, ...patch } as ClipScript : s)))
  }

  function add (kind: ClipScript['kind']): void {
    const id = Math.random().toString(36).slice(2, 10)
    const pick = (want: string): string => names.includes(want) ? want : names[0] ?? want
    const script: ClipScript = kind === 'grip'
      ? { id, kind, enabled: true, side: 'Right', clip: 'mixamo-2hand_Idle' }
      : kind === 'blow'
        ? { id, kind, enabled: true, clip: pick('Attack'), at: 0.45, hand: 'RightHand' }
        : { id, kind, enabled: true, clip: pick('Carry'), like: pick('Walk') }
    void save([...scripts, script])
  }

  const hint = (s: ClipScript): string => s.kind === 'grip'
    ? `as in ${s.clip.replace(/^mixamo-/, '').replace(/_/g, ' ')}, where its fingers close most`
    : s.kind === 'blow'
      ? `the ${(s.hand ?? 'RightHand').replace('Hand', '').toLowerCase()} hand's fastest moment`
      : 'its planted foot as fast as that clip\'s'
</script>

<Section title="Scripts">
  {#if scripts.length === 0}
    <p class="faint small">Changes on top of the clips (a fist held closed, an attack's blow timed, a walk paced). They play here
      as the game gets them.</p>
  {:else}
    <ul>
      {#each scripts as s (s.id)}
        <li class:off={!s.enabled}>
          <div class="head">
            <Toggle label={describe(s)} hint={s.note ?? hint(s)} checked={s.enabled} onchange={(v) => change(s.id, { enabled: v })} />
            <button class="del" onclick={() => save(scripts.filter(x => x.id !== s.id))} aria-label="Remove script"><Trash2 size={13} /></button>
          </div>
          <div class="params">
            {#if s.kind === 'grip'}
              <select value={s.side} onchange={(e) => change(s.id, { side: (e.target as HTMLSelectElement).value as 'Left' | 'Right' })} aria-label="Hand">
                <option value="Right">Right hand</option><option value="Left">Left hand</option>
              </select>
              <input class="mono wide" value={s.clip} aria-label="Grip clip" title="Library clip id whose fist it keeps"
                onchange={(e) => change(s.id, { clip: (e.target as HTMLInputElement).value.trim() || s.clip })} />
            {:else if s.kind === 'blow'}
              <select value={s.clip} onchange={(e) => change(s.id, { clip: (e.target as HTMLSelectElement).value })} aria-label="Clip">
                {#each names as n}<option value={n}>{n}</option>{/each}
              </select>
              <select value={s.hand ?? 'RightHand'} onchange={(e) => change(s.id, { hand: (e.target as HTMLSelectElement).value })} aria-label="Hand">
                <option value="RightHand">Right</option><option value="LeftHand">Left</option>
              </select>
              <label>at <input class="mono" type="number" min="5" max="95" step="5" value={Math.round(s.at * 100)}
                onchange={(e) => change(s.id, { at: Math.min(0.95, Math.max(0.05, Number((e.target as HTMLInputElement).value) / 100)) })} />%</label>
              <label>window <input class="mono" type="number" min="0" step="0.1" value={s.window ?? ''} placeholder="whole"
                onchange={(e) => { const v = Number((e.target as HTMLInputElement).value); change(s.id, { window: v > 0 ? v : undefined }) }} />s</label>
            {:else}
              <select value={s.clip} onchange={(e) => change(s.id, { clip: (e.target as HTMLSelectElement).value })} aria-label="Clip">
                {#each names as n}<option value={n}>{n}</option>{/each}
              </select>
              <span class="faint">like</span>
              <select value={s.like} onchange={(e) => change(s.id, { like: (e.target as HTMLSelectElement).value })} aria-label="Paced like">
                {#each names as n}<option value={n}>{n}</option>{/each}
              </select>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="add">
    <span class="faint small"><Plus size={12} /> Add</span>
    <button onclick={() => add('grip')}><Hand size={13} /> Hold fist</button>
    <button onclick={() => add('blow')}><Swords size={13} /> Blow timing</button>
    <button onclick={() => add('pace')}><Timer size={13} /> Pace</button>
  </div>
</Section>

<style>
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li { padding: 4px 6px; border: 1px solid var(--line); border-radius: var(--r-1); }
  li.off { opacity: 0.6; }
  .head { display: flex; align-items: center; gap: 6px; }
  .head :global(.toggle) { flex: 1; }
  .params { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 2px 0 4px; font-size: 12px; }
  select, input { height: 24px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 12px; padding: 0 4px; }
  input { width: 52px; }
  input.wide { width: 170px; }
  label { display: flex; align-items: center; gap: 4px; color: var(--text-2); }
  .del { width: 24px; height: 24px; border-radius: 5px; border: 0; background: transparent; color: var(--text-3); display: grid; place-items: center; flex: none; }
  .del:hover { color: var(--danger); background: var(--danger-soft); }
  .add { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
  .add span { display: flex; align-items: center; gap: 3px; }
  .add button { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .add button:hover { background: var(--bg-3); color: var(--text-1); }
  .small { font-size: 12px; margin: 0; }
</style>
