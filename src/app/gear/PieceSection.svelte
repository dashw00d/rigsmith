<script lang="ts">
  import { LoaderCircle } from '@lucide/svelte'
  import { gearById } from '../../model/select.ts'
  import { gearLeftOut, meshNameOf } from '../../engine/contract.ts'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { gear as gearState } from '../../state/gear.svelte.ts'
  import { paintableGear } from '../../state/paint.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import Section from '../../ui/Section.svelte'
  import Select from '../../ui/Select.svelte'
  import TextField from '../../ui/TextField.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { typing } from '../../ui/shortcuts.ts'
  import { wardrobe } from './wardrobe.svelte.ts'
  import HandleList from './HandleList.svelte'
  import BodyCoverage from './BodyCoverage.svelte'
  import OriginFields from './OriginFields.svelte'
  import PlacementFields from './PlacementFields.svelte'
  import WearOptions from './WearOptions.svelte'
  import { boneChoices, boneLabel, fromGame, swapSets } from './text.ts'
  import WeightPaintPanel from '../skin/WeightPaintPanel.svelte'
  let { character, highlight }: { character: Character, highlight: string | null } = $props()
  const piece = $derived(gearState.selected === null ? undefined : gearById(character, gearState.selected))
  const game = $derived(piece !== undefined && fromGame(piece))
  const fitting = $derived(piece !== undefined && gearState.fitting === piece.id)
  const paintable = $derived(piece === undefined ? null : paintableGear(piece))
  const leftOut = $derived(piece === undefined ? null : gearLeftOut(piece))
  const sets = $derived(swapSets(character.gear))
  function cancelFitOnEscape (event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || !fitting || gearState.placingOrigin !== null || gearState.picking !== null || typing(event.target) || app.drawer !== null || app.confirming !== null || wardrobe.keysOpen || document.querySelector('[aria-label="Close panel"]') !== null) return
    event.preventDefault()
    void gearState.cancelFit()
  }
</script>

<svelte:window onkeydown={cancelFitOnEscape} />

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
    {#if piece.attach.kind === 'skin'}<BodyCoverage {piece} />{/if}
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


<style>
  .note { margin: 0; font-size: 12px; color: var(--text-3); display: flex; align-items: center; gap: 4px; }
  .error { margin: 0; font-size: 12px; color: var(--danger); }
  .fit-actions { display: flex; gap: 6px; }
  .place { display: flex; flex-direction: column; gap: 8px; }
  .set { width: 150px; height: 28px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 8px; color: inherit; font: inherit; font-size: 12.5px; }
  .set:focus { outline: none; border-color: var(--accent); }
</style>
