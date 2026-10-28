<script lang="ts">
  // One game unit as Rigsmith keeps it (workspace/game/units.json): its height (set by eye in the scale room too), its
  // triangle budget and levels, the clip names the game plays (each one of the character's slots), draft, and the
  // companion it leads or rides. Every edit is saved at once, checked by the server and journaled on the characters it
  // names; the game gets it on Export. On a companion's page: the unit it goes with and its own height.
  import { ArrowRight, Gamepad2, Plus, Ruler, Trash2, X } from '@lucide/svelte'
  import { companionFor } from '../../engine/mount.ts'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { scaleRoom } from '../../state/scaleroom.svelte.ts'
  import { ship, type UnitRow } from '../../state/ship.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Badge from '../../ui/Badge.svelte'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import NumberField from '../../ui/NumberField.svelte'
  import Select from '../../ui/Select.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { addableClips, clipChips, lodPercents, nextLod, unitState } from './text.ts'

  let { character, row }: { character: Character, row: UnitRow } = $props()

  const name = $derived(row.name)
  const spec = $derived(row.ours)
  const standing = $derived(unitState(row))
  // (its slots: the unit's own character, also when this page is its companion's)
  const owner = $derived(row.role === 'unit' ? character : app.byId(spec.character))
  const slots = $derived(owner?.clips.map(s => s.name) ?? [])
  const chips = $derived(clipChips(spec.clips, slots))
  const addable = $derived(addableClips(spec.clips, slots))
  const lods = $derived(ship.lods(name))
  const ownLods = $derived(Array.isArray(spec.lods))
  const comp = $derived(spec.companion)
  const compName = $derived(comp === undefined ? '' : app.byId(comp.character)?.name ?? comp.character)
  // (what a unit can lead: the creatures, not itself)
  const companions = $derived(app.characters.filter(x => x.id !== spec.character && x.skeleton.template !== 'human'))
  const leadOptions = $derived([
    ...companions.map(c => ({ value: c.id, label: c.name })),
    ...(comp !== undefined && !companions.some(c => c.id === comp.character) ? [{ value: comp.character, label: compName }] : []),
  ])
  const onStage = $derived(viewer.character !== null && viewer.shownId === character.id)
  // (the game's own keys, kept as they are: its texture size, parts, thrown weapons, models_dir...)
  const KNOWN = new Set(['character', 'height', 'budget', 'clips', 'lods', 'draft', 'companion'])
  const otherKeys = $derived(Object.keys(spec).filter(k => !KNOWN.has(k) && !k.startsWith('_')))

  const patch = (change: Parameters<typeof ship.patch>[1]): void => { void ship.patch(name, change) }
  // (the pickers that act and go back to their placeholder: drawn anew after each pick)
  let picks = $state(0)

  function room (companion: boolean): void {
    if (!scaleRoom.show(name, companion)) app.toast('error', `${character.name} isn't loaded yet`)
  }

  function lead (id: string): void {
    const c = app.byId(id)
    if (c === null) return
    patch({ companion: companionFor(c, false, comp?.ridden === true ? undefined : comp) })
  }
</script>

<div class="card">
  <div class="head">
    <Gamepad2 size={14} />
    <strong class="mono">{name}</strong>
    <Badge tone={standing.tone}>{standing.label}</Badge>
    {#if row.role === 'unit'}
      <span class="end"><IconButton label="Remove the unit" hint="Take it off Rigsmith's list (asks first)" size="sm" variant="danger" onclick={() => ship.remove(name)}><Trash2 size={13} /></IconButton></span>
    {/if}
  </div>

  {#if row.role === 'companion' && comp !== undefined}
    <p class="faint small">
      {comp.ridden === true ? 'The horse' : 'The companion'} of
      <button class="link" onclick={() => app.select(spec.character)}>{owner?.name ?? spec.character} <ArrowRight size={11} /></button>
      in the game{comp.ridden === true ? ': he rides it' : ': it walks beside him'}. Its bones are prefixed {comp.prefix}.
    </p>
    <Field label="Height" hint="Its height in the game (game units)" group>
      <div class="with">
        <NumberField value={comp.height} onchange={(v) => patch({ companion: { ...comp, height: v } })} min={0.1} max={20} step={0.05} digits={2} label="Companion height" />
        <IconButton label="Scale room" hint="Set its height by eye beside the game's units" disabled={!onStage} onclick={() => room(true)}><Ruler size={14} /></IconButton>
      </div>
    </Field>
    <Field label="Budget" hint="Its triangles at the nearest level">
      <NumberField value={comp.budget} onchange={(v) => patch({ companion: { ...comp, budget: Math.round(v) } })} min={1} step={100} digits={0} label="Companion budget" />
    </Field>
  {:else}
    <Field label="Height" hint="In the game, soles to the top of the head (game units)" group>
      <div class="with">
        <NumberField value={spec.height} onchange={(v) => patch({ height: v })} min={0.1} max={20} step={0.05} digits={2} label="Height" />
        <IconButton label="Scale room" hint="Set the height by eye beside the game's units" disabled={!onStage} onclick={() => room(false)}><Ruler size={14} /></IconButton>
      </div>
    </Field>
    <Field label="Budget" hint="Triangles at the nearest level (its gear counts too; swapped parts don't)">
      <NumberField value={spec.budget} onchange={(v) => patch({ budget: Math.round(v) })} min={1} step={100} digits={0} label="Budget" />
    </Field>
    <Field label="Levels" hint={ownLods ? 'Each a share of the nearest level, smaller than the one before' : "The game's defaults"} group>
      <div class="lods">
        {#each lodPercents(lods) as pct, i (i)}
          <span class="lod">
            <NumberField value={pct} onchange={(v) => patch({ lods: lods.with(i, v / 100) })} min={1} max={99} step={5} digits={1} unit="%" size="sm" width="64px" label="{name}_LOD{i + 1}" />
            <button class="x" onclick={() => patch({ lods: lods.filter((_, k) => k !== i) })} aria-label="Drop {name}_LOD{i + 1}" use:tooltip={`Drop ${name}_LOD${i + 1}`}><X size={11} /></button>
          </span>
        {/each}
        {#if lods.length < 4}
          <IconButton label="Add a level" size="sm" onclick={() => patch({ lods: nextLod(lods) })}><Plus size={13} /></IconButton>
        {/if}
        {#if ownLods}
          <button class="link" onclick={() => patch({ lods: undefined })}>Defaults</button>
        {/if}
      </div>
    </Field>

    <div class="clips" role="group" aria-label="The clips the game plays">
      <span class="faint small">Plays</span>
      {#each chips as chip (chip.name)}
        <span class="chip" class:missing={!chip.ok} use:tooltip={chip.ok ? `${owner?.name ?? 'Its character'}'s slot ${chip.name}` : `No slot named ${chip.name}: fill it in Motion (the export stops on it)`}>
          {chip.name}
          <button class="x" onclick={() => patch({ clips: spec.clips.filter(c => c !== chip.name) })} aria-label="Drop {chip.name}"><X size={10} /></button>
        </span>
      {/each}
      {#if addable.length > 0}
        {#key picks}
          <Select options={addable.map(s => ({ value: s, label: s }))} value={null} placeholder="+ a slot" size="sm" label="Add a clip the game plays"
            onchange={(v) => { picks++; patch({ clips: [...spec.clips, v] }) }} />
        {/key}
      {:else if slots.length === 0}
        <span class="faint small">{owner?.name ?? 'Its character'} has no slots yet (Motion)</span>
      {/if}
    </div>

    <Toggle label="Draft" hint="The game's build skips it unless it is named; exporting it ends the draft" checked={spec.draft === true} onchange={(v) => patch({ draft: v ? true : undefined })} />
    {#if otherKeys.length > 0}
      <p class="faint small">Also in its entry, kept as they are: <span class="mono">{otherKeys.join(', ')}</span></p>
    {/if}

    <div class="companion">
      {#if comp === undefined}
        <Field label="Companion" hint="A creature that walks beside it (riding one is picked under Mount)">
          {#key picks}
            <Select options={leadOptions} value={null} placeholder="None" size="sm" label="Companion" onchange={(v) => { picks++; lead(v) }} />
          {/key}
        </Field>
      {:else if comp.ridden === true}
        <Field label="Rides" hint="Its horse in the game: the one picked under Mount" group>
          <span class="name">{compName}</span>
        </Field>
      {:else}
        <Field label="Leads" hint="A creature that walks beside it" group>
          <div class="with">
            {#key `${picks}:${comp.character}`}
              <Select options={leadOptions} value={comp.character} size="sm" label="Companion" onchange={(v) => { picks++; lead(v) }} />
            {/key}
            <IconButton label="No companion" size="sm" onclick={() => patch({ companion: undefined })}><X size={13} /></IconButton>
          </div>
        </Field>
      {/if}
      {#if comp !== undefined}
        <Field label="Its height" hint="The companion's height in the game (set it by eye on its own page)">
          <NumberField value={comp.height} onchange={(v) => patch({ companion: { ...comp, height: v } })} min={0.1} max={20} step={0.05} digits={2} label="Companion height" />
        </Field>
      {/if}
    </div>
  {/if}
</div>

{#if row.role === 'unit' && comp !== undefined && app.byId(comp.character) !== null}
  <Button size="sm" variant="ghost" onclick={() => app.select(comp.character)}>Open {compName} <ArrowRight size={12} /></Button>
{/if}

<style>
  .card { display: flex; flex-direction: column; gap: 8px; }
  .head { display: flex; align-items: center; gap: 6px; }
  .end { margin-left: auto; }
  .small { font-size: 12px; margin: 0; }
  .with { display: flex; align-items: center; gap: 4px; }
  .lods { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .lod { display: inline-flex; align-items: center; gap: 1px; }
  .clips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 4px 0 8px; border-radius: 11px; border: 1px solid var(--line-strong); font-size: 11.5px; color: var(--text-2); }
  .chip.missing { border-color: var(--danger); color: var(--danger); }
  .x { border: 0; background: transparent; color: var(--text-4); display: grid; place-items: center; padding: 0; width: 14px; height: 14px; cursor: pointer; }
  .x:hover { color: var(--danger); }
  .companion { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid var(--line); }
  .name { font-size: 12px; color: var(--text-1); }
  .link { border: 0; background: transparent; padding: 0; color: var(--accent-strong); font-size: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 2px; }
  .link:hover { text-decoration: underline; }
</style>
