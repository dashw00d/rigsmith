<script lang="ts">
  // The Gear step (DESIGN.md §5 #4): everything the character wears or carries. The list (the game's parts, catalog
  // pieces, uploads; grouped by swap set; shown or hidden), adding from the catalog or a model file, then the piece
  // open: its name, the bone it rides (or another way to wear it), where it sits (gizmo and numbers), where hands hold
  // it, its painted weights, and what each hand does and why. Every change is a command (src/state/gear.svelte.ts).
  import { untrack } from 'svelte'
  import { Library, LoaderCircle, Shirt, Sword, Upload } from '@lucide/svelte'
  import { gearById, phaseOf } from '../../model/select.ts'
  import { gearLeftOut, meshNameOf } from '../../engine/contract.ts'
  import { MODEL_FILE, type Character, type GearKind } from '../../state/api.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { app } from '../../state/app.svelte.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import { hands } from '../../state/hands.svelte.ts'
  import { paintableGear } from '../../state/paint.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import Field from '../../ui/Field.svelte'
  import Section from '../../ui/Section.svelte'
  import Select from '../../ui/Select.svelte'
  import TextField from '../../ui/TextField.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import FolkPanel from '../gear/FolkPanel.svelte'
  import { wardrobe } from '../gear/wardrobe.svelte.ts'
  import GearList from '../gear/GearList.svelte'
  import { isFolk } from '../../engine/folk.ts'
  import HandleList from '../gear/HandleList.svelte'
  import OriginFields from '../gear/OriginFields.svelte'
  import PlacementFields from '../gear/PlacementFields.svelte'
  import WearOptions from '../gear/WearOptions.svelte'
  import { boneChoices, boneLabel, fromGame, swapSets } from '../gear/text.ts'
  import HandsPanel from '../hands/HandsPanel.svelte'
  import WeightPaintPanel from '../skin/WeightPaintPanel.svelte'

  let { character }: { character: Character } = $props()

  const rigged = $derived(phaseOf(character).phase === 'rigged')
  const piece = $derived(gearState.selected === null ? undefined : gearById(character, gearState.selected))
  const game = $derived(piece !== undefined && fromGame(piece))
  const fitting = $derived(piece !== undefined && gearState.fitting === piece.id)
  const paintable = $derived(piece === undefined ? null : paintableGear(piece))
  const leftOut = $derived(piece === undefined ? null : gearLeftOut(piece))
  const sets = $derived(swapSets(character.gear))

  function cancelFitOnEscape (event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || !fitting) return
    event.preventDefault()
    void gearState.cancelFit()
  }

  // ---- adding ----
  let input = $state<HTMLInputElement>()
  let kind = $state<GearKind>('bone')
  let uploading = $state(false)
  function choose (k: GearKind): void {
    kind = k
    input?.click()
  }
  async function picked (): Promise<void> {
    const files = [...(input?.files ?? [])].filter(f => MODEL_FILE.test(f.name))
    if (input !== undefined) input.value = ''
    if (files.length === 0) return
    uploading = true
    try {
      await gearState.upload(character, files, kind)
    } finally {
      uploading = false
    }
  }

  // ---- the Hands panel's link to a handle ----
  let highlight = $state<string | null>(null)
  $effect(() => {
    const to = hands.focus
    if (to === null || to.step !== 'gear') return
    untrack(() => {
      hands.focus = null
      gearState.select(to.gear)
      highlight = to.handle ?? null
    })
  })
  $effect(() => {
    if (highlight === null) return
    const t = setTimeout(() => { highlight = null }, 2500)
    return () => { clearTimeout(t) }
  })

  // ---- the pose it is looked at in ----
  const pose = $derived(gearState.pose)
  const poses = $derived([
    { value: 'rest', label: 'Rest' },
    { value: 'fists', label: 'Rest, fists closed' },
    ...character.clips.map(s => ({ value: s.id, label: s.name, group: 'Clips' })),
    ...(pose === 'other' ? [{ value: 'other', label: animator.playing?.label ?? 'Playing', group: 'Playing' }] : []),
  ])
</script>

<svelte:window onkeydown={cancelFitOnEscape} />

<Section title="Gear">
  {#snippet action()}
    <div class="adds">
      {#if isFolk(character)}
        <Button size="sm" data-testid="wardrobe-button" keys="dress.wardrobe" variant={app.drawer === 'wardrobe' ? 'primary' : 'ghost'} onclick={() => app.toggleDrawer('wardrobe')}><Shirt size={13} /> Wardrobe</Button>
      {/if}
      <Button size="sm" variant={app.drawer === 'wardrobe' && wardrobe.tab(character.id) === 'props' ? 'primary' : 'ghost'} onclick={() => { wardrobe.setTab(character.id, 'props'); app.drawer = 'wardrobe' }}
        title="Weapons, shields and tools that come with Rigsmith"><Library size={13} /> Catalog</Button>
      <Button size="sm" variant="ghost" loading={uploading} onclick={() => choose('bone')} title="Your own model (FBX, GLB, OBJ, DAE or ZIP), on a bone">
        <Upload size={13} /> Upload</Button>
    </div>
  {/snippet}
  <input bind:this={input} type="file" accept=".fbx,.glb,.gltf,.obj,.dae,.zip" hidden multiple onchange={picked} />
  {#if !rigged}
    <p class="note">Gear shows on {character.name} once it is rigged (Skeleton step).</p>
  {/if}
  {#if character.gear.length === 0}
    <EmptyState icon={Sword} compact title="No gear yet" body="Add a weapon, shield or tool from the catalog, or upload your own model." />
  {:else}
    <GearList {character} />
  {/if}
  <details class="more">
    <summary>Other ways to wear it</summary>
    <div class="more-body">
      <Button size="sm" variant="ghost" onclick={() => choose('skin')} title="Each vertex moves like the skin under it (a coat, a cape)">
        <Upload size={13} /> Clothing, on the skin</Button>
      <Button size="sm" variant="ghost" onclick={() => choose('spot')} title="Pinned to one spot of the skin, moving without bending (a buckle, a pouch)">
        <Upload size={13} /> A part, pinned to a spot</Button>
    </div>
  </details>
</Section>

{#if isFolk(character) || (character.look.skins ?? []).length > 0 || (character.look.clothes ?? []).length > 0}
  <Section title="Dynamic character">
    <FolkPanel {character} />
  </Section>
{/if}

<Section title="Pose">
  <Select size="sm" options={poses} value={pose} label="Pose" onchange={(v) => { if (v !== 'other') void gearState.setPose(character, v) }} />
  <p class="note">Look at the gear in a clip as the game plays it. Pause on a frame (Space; , and . step) and drag the gizmo there.</p>
</Section>

{#if piece !== undefined}
  {@const a = piece.attach}
  <Section title={piece.name}>
    {#if piece.status === 'importing'}
      <p class="note"><LoaderCircle size={12} class="spin" /> Importing…</p>
    {:else if piece.status === 'error'}
      <p class="error">The import failed: {piece.error ?? 'no reason given'}. Upload the file again.</p>
    {/if}
    <Field label="Name" hint={game ? `The game names it (${meshNameOf(piece)})` : undefined}>
      <TextField size="sm" value={piece.name} disabled={game} label="Name" oncommit={(v) => gearState.rename(character, piece, v)} />
    </Field>
    <Field label="Swap set" hint="Of a set, one piece shows at a time">
      <input class="set" list="gear-swap-sets" placeholder="none" value={piece.swapSet ?? ''} aria-label="Swap set"
        onchange={(e) => gearState.setSwapSet(character, piece, (e.currentTarget as HTMLInputElement).value)} />
      <datalist id="gear-swap-sets">{#each sets as s (s)}<option value={s}></option>{/each}</datalist>
    </Field>
    <Toggle label="Shown" hint={piece.swapSet !== undefined ? `Showing it hides the rest of ${piece.swapSet}` : 'Hidden: kept, but not shown or exported'}
      checked={gearState.shownOnStage(character, piece)} onchange={(on) => gearState.setShown(character, piece, on)} />
    {#if a.kind === 'bone'}
      <Field label="Held by" hint="Moving it to the other hand carries it across, held the same way">
        <Select size="sm" options={boneChoices(character, a.bone).map(b => ({ value: b, label: boneLabel(b) }))} value={a.bone} label="Held by"
          onchange={(b) => gearState.setBone(character, piece, b)} />
      </Field>
    {/if}
    <WearOptions {character} gear={piece} />
    {#if piece.status === 'ready'}
      <div class="place">
        {#if a.kind === 'bone'}
          <PlacementFields {character} gear={piece} />
          {#if a.legacyFrame === undefined}<OriginFields {character} gear={piece} />{/if}
        {:else if fitting}
          <PlacementFields {character} gear={piece} />
          <OriginFields {character} gear={piece} />
          <p class="note">Shown unbound while you place it.</p>
          <div class="fit-actions">
            <Button variant="primary" data-testid="fit-bind" disabled={gearState.cancellingFit} onclick={() => gearState.fit(null)}>Bind to {character.name}</Button>
            <Button data-testid="fit-cancel" disabled={gearState.cancellingFit} onclick={() => { void gearState.cancelFit() }}>Cancel</Button>
          </div>
        {:else}
          <Button size="sm" onclick={() => gearState.fit(piece.id)}>Place it</Button>
        {/if}
      </div>
    {/if}
    {#if leftOut !== null && piece.status === 'ready'}
      <p class="note">The game export leaves it out: {leftOut}.</p>
    {/if}
  </Section>

  {#if a.kind === 'bone' && piece.status === 'ready'}
    <Section title="Handles">
      <HandleList {character} gear={piece} {highlight} />
    </Section>
  {/if}

  {#if paintable !== null && piece.status === 'ready'}
    {#if !gearState.shownOnStage(character, piece) || fitting}
      <Section title="Weights">
        <p class="note">{!gearState.shownOnStage(character, piece) ? 'Show it to paint its weights.' : 'Bind it (finish placing) to paint its weights.'}</p>
      </Section>
    {:else}
      <WeightPaintPanel {character} gear={piece} />
    {/if}
  {/if}
{/if}

<HandsPanel {character} />

<style>
  .adds { display: flex; gap: 2px; }
  .adds :global(button) { padding-inline: 5px; gap: 4px; }
  .note { margin: 0; font-size: 12px; color: var(--text-3); display: flex; align-items: center; gap: 4px; }
  .error { margin: 0; font-size: 12px; color: var(--danger); }
  .more summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
  .more summary:hover { color: var(--text-1); }
  .more-body { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .fit-actions { display: flex; gap: 6px; }
  .place { display: flex; flex-direction: column; gap: 8px; }
  .set { width: 150px; height: 28px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 8px; color: inherit; font: inherit; font-size: 12.5px; }
  .set:focus { outline: none; border-color: var(--accent); }
</style>
