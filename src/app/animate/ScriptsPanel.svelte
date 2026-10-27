<script lang="ts">
  // The character's clip scripts (src/engine/scripts.ts): switch each on or off, set it, add or remove one. The viewer
  // plays entries with them, and the game export applies the same ones.
  import { Plus, Swords, Timer, Trash2 } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { animator, GRIP_CLIP } from '../../state/animator.svelte.ts'
  import { describe, type ClipScript } from '../../engine/scripts.ts'
  import Section from '../../ui/Section.svelte'
  import Toggle from '../../ui/Toggle.svelte'

  let { character }: { character: Character } = $props()

  const scripts = $derived(character.scripts ?? [])
  // (a hand's fist is set where the hands on a prop are: the animation editor's prop panel)
  const shown = $derived(scripts.filter(s => s.kind !== 'grip'))
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
      ? { id, kind, enabled: true, side: 'Right', clip: GRIP_CLIP }
      : kind === 'blow'
        ? { id, kind, enabled: true, clip: pick('Attack'), at: 0.45, hand: 'RightHand' }
        : { id, kind, enabled: true, clip: pick('Carry'), like: pick('Walk') }
    void save([...scripts, script])
  }

  const hint = (s: ClipScript): string => s.kind === 'grip'
    ? `as in ${s.clip.replace(/^mixamo-/, '').replace(/_/g, ' ')}, where its fingers close most`
    : s.kind === 'blow'
      ? `The game lands each hit at ${Math.round(s.at * 100)}% of the ${s.clip}: the clip is cut so its blow falls there. The blow: ${s.blowU !== undefined ? 'the frame you set' : `found, the ${(s.hand ?? 'RightHand').replace('Hand', '').toLowerCase()} hand's fastest moment`}`
      : 'its planted foot as fast as that clip\'s'

  // The blow at the frame playing: where it is in the clip before its cut (the cut's start plus the time played, at
  // the clip's speed), as a phase of that clip.
  const playing = (clip: string): boolean => animator.current?.name === clip && animator.current.entry !== null
  function blowHere (id: string, clip: string): void {
    const entry = character.animations.find(a => a.name === clip)
    if (entry === undefined || !playing(clip)) return
    const cut = animator.cut?.name === clip ? animator.cut : null
    const uncut = cut?.uncut ?? animator.duration / entry.speed
    const t = (cut?.start ?? 0) + animator.time / entry.speed
    change(id, { blowU: Math.round(Math.min(1, Math.max(0, t / uncut)) * 1e4) / 1e4, enabled: true })
  }
  // A blow later in the clip than where it must land: say what that costs (its start cut, or its end held).
  const lateness = (s: ClipScript & { kind: 'blow' }): string | null => {
    if (s.window !== undefined) return null
    const cut = animator.cut?.name === s.clip ? animator.cut : null
    const u = s.blowU ?? (cut !== null ? cut.blow / cut.uncut : null)
    if (u === null || u <= s.at || cut === null) return null
    return s.late === 'hold'
      ? `blow at ${Math.round(u * 100)}%: held ${(cut.end - cut.uncut).toFixed(2)} s after the clip's end`
      : `blow at ${Math.round(u * 100)}%: the first ${cut.start.toFixed(2)} s are cut`
  }
  const blowFrame = (s: ClipScript & { kind: 'blow' }): string => {
    if (s.blowU === undefined) return ''
    const entry = character.animations.find(a => a.name === s.clip)
    const uncut = animator.cut?.name === s.clip ? animator.cut.uncut : null
    return uncut !== null && entry !== undefined ? `frame ${Math.round(s.blowU * uncut * 30)} of ${Math.round(uncut * 30)}` : `${Math.round(s.blowU * 100)}% into the clip`
  }
</script>

<Section title="Scripts">
  {#if shown.length === 0}
    <p class="faint small">Changes on top of the clips (an attack's blow timed, a walk paced; a hand's fist is set on its prop, in the animation editor). They play here
      as the game gets them.</p>
  {:else}
    <ul>
      {#each shown as s (s.id)}
        <li class:off={!s.enabled}>
          <div class="head">
            <Toggle label={describe(s)} hint={s.note ?? hint(s)} checked={s.enabled} onchange={(v) => change(s.id, { enabled: v })} />
            <button class="del" onclick={() => save(scripts.filter(x => x.id !== s.id))} aria-label="Remove script"><Trash2 size={13} /></button>
          </div>
          <div class="params">
            {#if s.kind === 'blow'}
              <select value={s.clip} onchange={(e) => change(s.id, { clip: (e.target as HTMLSelectElement).value })} aria-label="Clip">
                {#each names as n}<option value={n}>{n}</option>{/each}
              </select>
              <span class="faint">blow</span>
              {#if s.blowU !== undefined}
                <span class="mono">{blowFrame(s)}</span>
                <button class="mini" onclick={() => change(s.id, { blowU: undefined })} title="Find it instead: the hand's fastest moment">Auto</button>
              {:else}
                <select value={s.hand ?? 'RightHand'} onchange={(e) => change(s.id, { hand: (e.target as HTMLSelectElement).value })} aria-label="Hand" title="Found: this hand's fastest moment">
                  <option value="RightHand">right hand's fastest</option><option value="LeftHand">left hand's fastest</option>
                </select>
              {/if}
              <button class="mini" disabled={!playing(s.clip)} onclick={() => blowHere(s.id, s.clip)}
                title={playing(s.clip) ? 'The blow is the frame playing now (pause on it first)' : `Play ${s.clip} and pause on its blow first`}>Set to this frame</button>
              {#if lateness(s) !== null}
                <span class="faint late">{lateness(s)}</span>
                <select value={s.late ?? 'cut'} onchange={(e) => change(s.id, { late: (e.target as HTMLSelectElement).value === 'hold' ? 'hold' : undefined })} aria-label="A late blow">
                  <option value="cut">cut the start</option><option value="hold">hold the end</option>
                </select>
              {/if}
              <label>lands at <input class="mono" type="number" min="5" max="95" step="5" value={Math.round(s.at * 100)}
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
  label { display: flex; align-items: center; gap: 4px; color: var(--text-2); }
  .late { font-size: 11px; }
  .mini { height: 22px; padding: 0 7px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 11px; }
  .mini:hover:not(:disabled) { color: var(--text-1); background: var(--bg-3); }
  .mini:disabled { opacity: 0.4; }
  .del { width: 24px; height: 24px; border-radius: 5px; border: 0; background: transparent; color: var(--text-3); display: grid; place-items: center; flex: none; }
  .del:hover { color: var(--danger); background: var(--danger-soft); }
  .add { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
  .add span { display: flex; align-items: center; gap: 3px; }
  .add button { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .add button:hover { background: var(--bg-3); color: var(--text-1); }
  .small { font-size: 12px; margin: 0; }
</style>
