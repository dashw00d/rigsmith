<script lang="ts">
  // The inspector of what the timeline or the viewport has selected, for the clip playing (docs/motion-plan.md §9 B):
  // keys (where they are, typed to a frame, how each span eases; duplicate, copy, paste, delete), a joint (key it here,
  // its keys), a piece of the clip (the Clip strip's: its range, blend, remove), a piece of gear (GearBox, and the gear
  // area's inspector), events (the events area's), a hand bar or the
  // Time track's items (their settings opened in the stack below). Then the posing tools that act on the clip (Solve
  // body, Naturalize, joint limits) and "Save as <clip>" (slot.copy: it replaces what that clip played).
  import { ClipboardPaste, Copy, CopyPlus, PersonStanding, Save, Trash2, WandSparkles, X } from '@lucide/svelte'
  import type { Character, Ease } from '../../model/types.ts'
  import { adjust } from '../../state/adjust.svelte.ts'
  import { pose } from '../../state/pose.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { timeline } from '../../state/timeline.svelte.ts'
  import { keysOf, spanOf } from '../../model/keyedit.ts'
  import { slotByName } from '../../model/select.ts'
  import { FIT } from './rules.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import NumberField from '../../ui/NumberField.svelte'
  import Select from '../../ui/Select.svelte'
  import TextField from '../../ui/TextField.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import EventsInspector from './events/EventsInspector.svelte'
  import GearInspector from './gear/GearInspector.svelte'
  import GearBox from './GearBox.svelte'
  import PieceInspector from './pieces/PieceInspector.svelte'
  import { boneLabel } from './tracks.ts'

  let { character }: { character: Character } = $props()

  const NEW = '\u0000new'
  const p = $derived(timeline.playing?.character.id === character.id ? timeline.playing : null)
  const slot = $derived(p?.slot ?? null)
  const f = $derived(timeline.frame(p))
  const view = $derived(timeline.view(v => v * timeline.width, x => x / Math.max(1, timeline.width)))
  const busy = $derived(pose.busy !== null)
  const keys = $derived(timeline.keys)
  const span = $derived(slot === null ? null : spanOf(slot, keys, f))
  const tracks = $derived([...new Set(keys.map(k => k.track))])
  const eases = $derived(slot === null ? [] : [...new Set(keys.map(k => keysOf(slot, k.track).find(x => x.u === k.u)?.ease ?? 'smooth'))])
  const events = $derived(timeline.selection.some(s => s.track === 'events'))
  const gearSel = $derived.by(() => {
    if (pose.gear !== null) return pose.gear
    const s = timeline.selection.find(x => /^(gear|held|shown):/.test(x.track))
    if (s !== undefined) return s.track.slice(s.track.indexOf(':') + 1)
    const ik = timeline.selection.find(x => x.track.startsWith('hands:ik:'))
    return ik === undefined ? null : slot?.ik?.hands.find(h => h.hand === ik.track.slice(9))?.gear ?? null
  })
  const bar = $derived(timeline.selection.find(s => s.track.startsWith('hands:') && !s.track.startsWith('hands:ik:')))
  const time = $derived(timeline.selection.find(s => s.track === 'time'))
  const piece = $derived(timeline.selection.find(s => s.track === 'pieces'))
  // (a bar or a Time track item selected: its setting opened in the stack below)
  $effect(() => { if (bar !== undefined) adjust.open = bar.track.slice(6) })
  $effect(() => { if (time !== undefined && slot?.time?.fit !== undefined) adjust.open = FIT })

  const EASE: Record<Ease, string> = { smooth: 'Smooth', linear: 'Linear', ease: 'Ease in and out', step: 'Stepped', hold: 'Held' }
  const frameOfV = (v: number): number => Math.round(v * (p?.frames ?? 30))

  // ---- save as ----
  const gameNames = $derived(slots.names)
  const saveOptions = $derived([
    ...gameNames.map(n => ({ value: n, label: slotByName(character, n) === undefined ? `${n} (empty)` : n, group: 'The game plays' })),
    ...character.clips.filter(s => !gameNames.includes(s.name)).map(s => ({ value: s.name, label: s.name, group: 'Trials and variants' })),
    { value: NEW, label: 'A new clip…' },
  ].filter(o => o.value !== slot?.name))
  let saveTo = $state('')
  let newName = $state('')
  const saveName = $derived(saveTo === NEW ? newName.trim() : saveTo)
  $effect(() => { if (saveTo !== '' && saveTo !== NEW && !saveOptions.some(o => o.value === saveTo)) saveTo = '' })
</script>

{#if p === null || slot === null}
  <p class="faint small">Play one of the clips (above) to pose and key it here: it shows in the timeline under the viewport.</p>
{:else}
  <div class="inspector">
    {#if keys.length > 0 && span !== null}
      <div class="box">
        <div class="row">
          <strong class="small">{keys.length} {keys.length === 1 ? 'key' : 'keys'}</strong>
          <span class="faint small">{tracks.length === 1 ? (tracks[0].startsWith('body:') ? boneLabel(tracks[0].slice(5)) : character.gear.find(g => g.id === tracks[0].slice(5))?.name ?? 'gear') : `on ${tracks.length} tracks`}
            · {span[0] === span[1] ? `frame ${frameOfV(span[0])}` : `frames ${frameOfV(span[0])}–${frameOfV(span[1])}`}</span>
          <span class="spacer"></span>
          <button class="x" aria-label="Deselect the keys" use:tooltip={'Deselect (Esc)'} onclick={() => timeline.clear()}><X size={13} /></button>
        </div>
        <div class="row">
          <Field label="At frame" hint="Moves the selection so its first key is on this frame">
            <NumberField size="sm" label="Move the keys to frame" value={frameOfV(span[0])} min={0} max={p.frames} step={1} onchange={(v) => timeline.toFrame(v)} />
          </Field>
          <span class="faint small" use:tooltip={'How each selected key eases into the next: drawn in its row as a solid, dashed, stepped or thick line'}>{eases.map(e => EASE[e]).join(', ')}</span>
        </div>
        <div class="row tools">
          <Button size="sm" variant="ghost" onclick={() => timeline.duplicate()} title="Duplicate just after them (Ctrl+D)"><CopyPlus size={13} /> Duplicate</Button>
          <Button size="sm" variant="ghost" onclick={() => timeline.copy()} title="Copy (Ctrl+C), then paste at the playhead (Ctrl+V)"><Copy size={13} /> Copy</Button>
          <Button size="sm" variant="ghost" disabled={!timeline.canPaste} onclick={() => timeline.paste()} title="Paste at the playhead (Ctrl+V)"><ClipboardPaste size={13} /> Paste</Button>
          <Button size="sm" variant="ghost" onclick={() => timeline.remove()} title="Delete (Delete)"><Trash2 size={13} /> Delete</Button>
        </div>
        {#if keys.length > 1}
          <Toggle label="Stretching retimes the clip" hint="Dragging the selection's edges on the ruler retimes the clip under the keys (retime markers) instead of moving the keys"
            checked={timeline.retimeClip} onchange={(on) => { timeline.retimeClip = on }} />
        {/if}
      </div>
    {:else if pose.selected !== null}
      {@const b = pose.selected}
      {@const n = slot.bones?.[b]?.length ?? 0}
      <div class="box">
        <div class="row">
          <strong class="small">{boneLabel(b)}</strong>
          <span class="faint small">{n === 0 ? 'no keys' : `${n} ${n === 1 ? 'key' : 'keys'}`}</span>
          <span class="spacer"></span>
          <button class="x" aria-label="Deselect the joint" use:tooltip={'Deselect (Esc)'} onclick={() => pose.select(null)}><X size={13} /></button>
        </div>
        <div class="row tools">
          <Button size="sm" disabled={busy} onclick={() => { void pose.keyHere([b]) }} title="Key it as it stands on this frame (K)">Key here</Button>
          <Button size="sm" variant="ghost" disabled={n === 0} onclick={() => timeline.select((slot.bones?.[b] ?? []).map(k => ({ track: `body:${b}`, id: String(k.u), u: k.u })))} title="Select its keys in the timeline">Select its keys</Button>
        </div>
        <p class="faint small">Drag the joint (or its gizmo) and let go to key it on this frame.</p>
      </div>
    {/if}

    {#if piece !== undefined}<PieceInspector {p} id={piece.id} />{/if}
    {#if events && view !== null}<EventsInspector {view} />{/if}

    {#if gearSel !== null}
      <GearBox {character} {slot} gear={gearSel} />
      {#if view !== null}<GearInspector {view} gear={gearSel} />{/if}
    {/if}

    {#if bar !== undefined}<p class="faint small">Its setting is open below; drag the bar or its ends in the timeline to change when.</p>{/if}

    <div class="row tools">
      <span use:tooltip={pose.natural ? 'On the frame shown: any arm inside the body is pushed out of it, then the body fitted to the hands on gear. What it moves is keyed here (B). Dragging never solves the body.' : 'Needs a person (the pose model)'}>
        <Button size="sm" disabled={busy || !pose.natural} onclick={() => { void pose.solveBody() }}><PersonStanding size={13} /> Solve body</Button>
      </span>
      {#if pose.naturalizing}
        <Button size="sm" variant="ghost" onclick={() => pose.cancelNaturalize()}>Cancel</Button>
      {:else}
        <span use:tooltip={'Every frame edged toward how people move and smoothed, the hands kept on gear and your keys near where you put them; then keyed on every frame it moved (one undo). Press again to go further.'}>
          <Button size="sm" disabled={busy || !pose.natural} onclick={() => { void pose.naturalize() }}><WandSparkles size={13} /> Naturalize</Button>
        </span>
      {/if}
    </div>
    {#if pose.busy !== null}<p class="status small" role="status"><span class="spinner"></span>{pose.busy}…</p>{/if}
    <Toggle label="Joint limits" hint="Posing keeps the joints within the rig's range of motion" checked={pose.limitsOn} onchange={(on) => pose.setLimits(on)} />

    <div class="save">
      <Field label="Save as" hint="Copies {slot.name} as it plays here over that clip (what it had goes; Ctrl+Z brings it back)">
        <Select size="sm" label="Save {slot.name} as" value={saveTo} placeholder="Choose a clip…" options={saveOptions} onchange={(v) => { saveTo = v }} />
      </Field>
      {#if saveTo === NEW}
        <TextField size="sm" label="New clip name" placeholder="Attack 2, Block…" bind:value={newName} maxlength={80} />
      {/if}
      <Button size="sm" variant="primary" disabled={saveName === '' || busy}
        onclick={() => { void pose.saveAs(character, slot.id, { slotId: slotByName(character, saveName)?.id ?? null, name: saveName }).then(ok => { if (ok) { saveTo = ''; newName = '' } }) }}>
        <Save size={13} /> Save as {saveName === '' ? '…' : saveName}
      </Button>
    </div>

    <details class="tips">
      <summary>Tips and shortcuts</summary>
      <p>Pause on a frame, drag a joint and let go: it is keyed there. Hands and feet reach, other joints turn their bones; the hips go up and down (Shift: any way). Click a joint for its gizmo. Let a free hand go on a piece's shaft to hold it there.</p>
      <p><kbd>Space</kbd> play · <kbd>,</kbd> <kbd>.</kbd> or <kbd>←</kbd> <kbd>→</kbd> a frame (<kbd>Shift</kbd> 10) · <kbd>↑</kbd> <kbd>↓</kbd> previous / next key · <kbd>Home</kbd> <kbd>End</kbd></p>
      <p>Keys: click, <kbd>Shift</kbd>/<kbd>Ctrl</kbd>+click or drag a box · drag to move (<kbd>Alt</kbd> free of frames) · drag the pink ends on the ruler to stretch · <kbd>Ctrl+D</kbd> duplicate · <kbd>Ctrl+C</kbd> <kbd>Ctrl+V</kbd> copy, paste at the playhead · <kbd>Delete</kbd> · <kbd>Ctrl+A</kbd> all · <kbd>Esc</kbd> deselect</p>
      <p><kbd>K</kbd> key the joint here · <kbd>G</kbd> move · <kbd>R</kbd> rotate · <kbd>B</kbd> solve body · <kbd>Ctrl+Z</kbd> undo · <kbd>Ctrl+Shift+Z</kbd> redo · <kbd>F</kbd> fit (<kbd>Shift+F</kbd> the selection) · <kbd>Ctrl</kbd>+wheel zoom · <kbd>[</kbd> <kbd>]</kbd> loop region · <kbd>\</kbd> clear it</p>
    </details>
  </div>
{/if}

<style>
  .inspector { display: flex; flex-direction: column; gap: 9px; }
  .box { display: flex; flex-direction: column; gap: 7px; padding: 9px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--bg-2); }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .tools { gap: 4px; }
  .spacer { flex: 1; }
  .small { font-size: 12px; margin: 0; }
  .x { border: 0; background: transparent; color: var(--text-3); display: grid; place-items: center; padding: 2px; border-radius: 4px; }
  .x:hover { color: var(--text-1); background: var(--bg-3); }
  .save { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--line); }
  .status { display: flex; align-items: center; gap: 7px; color: var(--accent-strong); }
  .spinner { width: 11px; height: 11px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tips { color: var(--text-3); font-size: 12px; }
  summary { cursor: pointer; color: var(--text-2); }
  .tips p { margin: 7px 0 0; line-height: 1.55; }
  kbd { font: inherit; font-size: 11px; color: var(--text-1); padding: 0 3px; border: 1px solid var(--line-strong); border-radius: 3px; }
</style>
