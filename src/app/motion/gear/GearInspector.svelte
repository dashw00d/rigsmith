<script lang="ts">
  // The inspector for one gear piece in the timeline (src/app/motion/lanes.ts): who holds it over the clip and when it
  // shows. Each holder from its switch frame on (the first: its Gear bone, or what holds it from the start), where it
  // sits there: one of its handles, its Gear placement, or wherever it was at the switch ("No pop"; turned off, it
  // takes a handle on that hand, its placement on its own bone, or the place it had pinned); the hidden spans by
  // frame; whether the piece's track plays in this clip at all. Every change is one slot.gear.update (one undo).
  import { Pin, Plus, Trash2 } from '@lucide/svelte'
  import * as THREE from 'three'
  import { app } from '../../../state/app.svelte.ts'
  import { placementOf } from '../../../engine/placement.ts'
  import type { GearTrack, HeldBy, Placement } from '../../../model/types.ts'
  import IconButton from '../../../ui/IconButton.svelte'
  import NumberField from '../../../ui/NumberField.svelte'
  import Select from '../../../ui/Select.svelte'
  import Toggle from '../../../ui/Toggle.svelte'
  import type { TimelineView } from '../lanes.ts'
  import {
    boneName, hiddenOf, holderOptions, holderValue, moveBoundary, moveEdge, removeBoundary, segmentsOf, setHolder, splitAt, toggleFrom, unhide,
    type Held, type Holder, type Shown,
  } from './strips.ts'

  let { view, gear }: { view: TimelineView, gear: string } = $props()

  const piece = $derived(view.character.gear.find(g => g.id === gear))
  const track = $derived(view.slot.gear?.[gear])
  const held = $derived(track?.heldBy ?? [])
  const shown = $derived(track?.shown ?? [])
  const segments = $derived(piece === undefined ? [] : segmentsOf(piece, held, view.toPlayed))
  const spans = $derived(hiddenOf(shown))
  const options = $derived(piece === undefined ? [] : holderOptions(view.character, piece))
  const attach = $derived(piece?.attach.kind === 'bone' ? piece.attach.bone : null)
  const muted = $derived((view.slot.muted ?? []).includes(`gear:${gear}`))
  const busy = $derived(view.baked === null)
  const playheadU = $derived(view.toSource(view.playhead))
  const frameNow = $derived(Math.round(view.playhead * view.frames))
  // (the segment picked in the strip, else the one under the playhead)
  const picked = $derived.by((): number => {
    const sel = view.selection.find(s => s.track === `held:${gear}`)
    if (sel !== undefined) return Number(sel.id)
    return segments.findLast(s => s.from <= view.playhead + 1e-9)?.index ?? -1
  })

  const frameOf = (u: number): number => Math.round(Math.min(1, Math.max(0, view.toPlayed(u))) * view.frames)
  const sourceOfFrame = (f: number): number => view.toSource(Math.min(view.frames, Math.max(0, f)) / Math.max(1, view.frames))

  async function write (patch: { heldBy?: Held, shown?: Shown }): Promise<void> {
    const p: { heldBy?: GearTrack['heldBy'] | null, shown?: GearTrack['shown'] | null } = {}
    if (patch.heldBy !== undefined) p.heldBy = patch.heldBy.length === 0 ? null : patch.heldBy
    if (patch.shown !== undefined) p.shown = patch.shown.length === 0 ? null : patch.shown
    await app.do(view.character.id, { type: 'slot.gear.update', slot: view.slot.id, gear, patch: p })
  }

  const entryOf = (index: number): HeldBy | null => (index >= 0 ? held[index] : held[0] !== undefined && held[0].u <= 1e-3 ? held[0] : null)
  const isFree = (x: HeldBy | null): boolean => x !== null && x.place === undefined && x.handle === undefined && x.placed !== true

  /** The place the bake found for entry `index` (where it was at its switch), as a placement to pin. */
  function resolvedPlace (index: number): Placement | null {
    const x = held[index]
    const holds = view.baked?.gearHolds?.[gear]?.holds
    if (x === undefined || holds === undefined || piece?.attach.kind !== 'bone') return null
    const t = Math.max(0, view.toPlayed(x.u))
    const h = holds.find(y => y.bone === x.bone && Math.abs(y.t - t) < 1e-6)
    if (h === undefined) return null
    const s = piece.attach.place.scale
    return placementOf({ position: new THREE.Vector3(...h.place.position), quaternion: new THREE.Quaternion(...h.place.quaternion), scale: new THREE.Vector3(s, s, s) })
  }

  function pick (index: number, value: string): void {
    const o = options.find(x => x.value === value)
    if (o !== undefined) void write({ heldBy: setHolder(held, index, o.holder) })
  }

  /** No pop on: held where it is; off: on a handle of that hand, its Gear placement on its own bone, or pinned where
   * the bake found it. */
  function setNoPop (index: number, on: boolean): void {
    const x = entryOf(index)
    if (x === null) return
    let holder: Holder | null = null
    if (on) holder = { bone: x.bone }
    else {
      const handle = options.find(o => o.value.startsWith('handle:') && o.holder.bone === x.bone)
      if (handle !== undefined) holder = handle.holder
      else if (x.bone === attach) holder = { bone: x.bone, placed: true }
      else {
        const place = resolvedPlace(index)
        if (place !== null) holder = { bone: x.bone, place }
      }
    }
    if (holder !== null) void write({ heldBy: setHolder(held, index, holder) })
  }

  function pin (index: number): void {
    const x = held[index]; const place = resolvedPlace(index)
    if (x !== undefined && place !== null) void write({ heldBy: setHolder(held, index, { bone: x.bone, place }) })
  }

  function split (): void {
    if (piece === undefined) return
    const next = splitAt(piece, held, playheadU)
    if (next !== null) void write({ heldBy: next })
  }

  const label = (x: HeldBy | null, bone: string): string => (x?.place !== undefined ? `${boneName(bone)}, pinned` : boneName(bone))
</script>

{#if piece !== undefined}
  <div class="inspector">
    <header>
      <h4>{piece.name}</h4>
      <span class="faint small">{attach !== null ? `On ${boneName(attach)} in Gear` : 'Worn on the body: no one holds it'}</span>
    </header>
    <Toggle checked={!muted} label="Plays in this clip" hint="Its keys, holders and hidden spans (off: kept, not played)" disabled={busy}
      onchange={(on) => app.do(view.character.id, { type: 'slot.update', id: view.slot.id, patch: { muted: on ? (view.slot.muted ?? []).filter(m => m !== `gear:${gear}`) : [...(view.slot.muted ?? []), `gear:${gear}`] } })} />

    {#if attach !== null}
      <section>
        <div class="head">
          <h5>Held by</h5>
          <button class="add" disabled={busy || splitAt(piece, held, playheadU) === null || view.playhead <= 0 || view.playhead >= 1} onclick={split}><Plus size={12} /> Change hands at frame {frameNow}</button>
        </div>
        <ul>
          {#each segments as s (s.index)}
            {@const x = entryOf(s.index)}
            {@const value = s.index === -1 && x === null ? holderValue(null, piece) : holderValue(x, piece)}
            <li class:picked={picked === s.index}>
              <div class="row">
                {#if s.index >= 0}
                  <NumberField size="sm" width="58px" label="Frame it changes hands" value={frameOf(held[s.index].u)} min={0} max={view.frames} digits={0} disabled={busy}
                    onchange={(f) => write({ heldBy: moveBoundary(held, s.index, sourceOfFrame(f)) })} />
                {:else}
                  <span class="from faint">Start</span>
                {/if}
                <Select size="sm" width="100%" label="Who holds it" disabled={busy}
                  options={value === null ? [{ value: 'pinned', label: label(x, s.bone), group: 'Its places' }, ...options] : options}
                  value={value ?? 'pinned'} onchange={(v) => { if (v !== 'pinned') pick(s.index, v) }} />
                {#if s.index >= 0}
                  <IconButton size="sm" variant="danger" label="Hand back to the holder before" disabled={busy} onclick={() => write({ heldBy: removeBoundary(held, s.index) })}><Trash2 size={12} /></IconButton>
                {/if}
              </div>
              {#if x !== null}
                <div class="row sub">
                  <Toggle checked={isFree(x)} label="No pop" hint={isFree(x) ? 'Takes it where it is at the switch' : x.handle !== undefined ? 'Takes it by its handle' : x.placed ? 'Puts it where Gear places it' : 'Holds it at a pinned place'}
                    disabled={busy} onchange={(on) => setNoPop(s.index, on)} />
                  {#if isFree(x) && s.index >= 0}
                    <IconButton size="sm" label="Pin this place" hint="Keep it where it sits now, even if the timing changes" disabled={busy || resolvedPlace(s.index) === null} onclick={() => pin(s.index)}><Pin size={12} /></IconButton>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section>
      <div class="head">
        <h5>Hidden</h5>
        <button class="add" disabled={busy || view.playhead >= 1} onclick={() => write({ shown: toggleFrom(shown, playheadU) })}>
          <Plus size={12} /> {spans.some(s => playheadU >= s.from - 1e-9 && playheadU < s.to) ? 'Show' : 'Hide'} from frame {frameNow}
        </button>
      </div>
      {#if spans.length === 0}
        <p class="faint small">Shown all through.</p>
      {:else}
        <ul>
          {#each spans as s, i (s.start)}
            <li>
              <div class="row">
                <NumberField size="sm" width="58px" label="Hidden from frame" value={frameOf(s.from)} min={0} max={view.frames} digits={0} disabled={busy}
                  onchange={(f) => write({ shown: moveEdge(shown, i, 'from', sourceOfFrame(f)) })} />
                <span class="faint">to</span>
                {#if s.to === Infinity}
                  <span class="faint">the end</span>
                {:else}
                  <NumberField size="sm" width="58px" label="Shown again from frame" value={frameOf(s.to)} min={0} max={view.frames} digits={0} disabled={busy}
                    onchange={(f) => write({ shown: moveEdge(shown, i, 'to', sourceOfFrame(f)) })} />
                {/if}
                <span class="spacer"></span>
                <IconButton size="sm" variant="danger" label="Show it there again" disabled={busy} onclick={() => write({ shown: unhide(shown, i) })}><Trash2 size={12} /></IconButton>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="faint small">The game hears each change: hide, show, detach and attach events on the clip.</p>
    </section>
  </div>
{/if}

<style>
  .inspector { display: flex; flex-direction: column; gap: 8px; }
  header { display: flex; flex-direction: column; gap: 1px; }
  h4 { margin: 0; font-size: 12.5px; font-weight: 600; }
  h5 { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--text-2); }
  section { display: flex; flex-direction: column; gap: 4px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .add { display: flex; align-items: center; gap: 3px; padding: 2px 6px; border: 0; border-radius: var(--r-1); background: transparent; color: var(--text-2); font-size: 11px; }
  .add:hover:not(:disabled) { background: var(--bg-3); color: var(--text-1); }
  .add:disabled { opacity: 0.4; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  li { padding: 3px 5px; border-radius: var(--r-1); border: 1px solid transparent; }
  li.picked { background: var(--bg-2); border-color: var(--line-strong); }
  .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .row.sub { padding-left: 64px; font-size: 11.5px; }
  .row.sub :global(.toggle) { flex: 1; }
  .from { width: 58px; flex: none; font-size: 11px; }
  .spacer { flex: 1; }
  .small { font-size: 11px; margin: 0; }
</style>
