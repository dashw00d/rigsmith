<script lang="ts">
  // A dynamic character (engine/folk.ts): one body every unit of a kind shares, dressed per unit. Pick the outfit to
  // see and fit (its pieces shown together, the others hidden), and a skin, clothes, hair and beard to look at it with;
  // the game picks those per unit by the same rules (Randomize shows one such pick, keeping what is locked). Browsing
  // is the stage's own (state/dress.svelte.ts): nothing is saved, journaled or undone until "Make default" makes the
  // look on stage the character's own (its thumbnail, and what the game shows a unit with no pick of its own).
  import { Dices, Lock, LockOpen, RotateCcw } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { dress } from '../../state/dress.svelte.ts'
  import type { DressField } from '../../state/dressing.ts'
  import { setsOf } from '../../state/dressing.ts'
  import { BEARD_SET, clothesFor, coversFace, coversHair, fits, HAIR_SET } from '../../engine/folk.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import Select from '../../ui/Select.svelte'

  let { character }: { character: Character } = $props()

  const outfits = $derived(setsOf(character).map(s => s.name))
  const worn = $derived(dress.worn(character))
  const outfit = $derived(worn.outfit)
  const skins = $derived(character.look.skins ?? [])
  const skin = $derived(skins.find(s => s.name === worn.skin))
  const clothes = $derived(character.look.clothes ?? [])
  const hairs = $derived(character.gear.filter(g => g.role === 'hair'))
  const beards = $derived(character.gear.filter(g => g.role === 'beard'))
  const covered = $derived(coversHair(character.gear, outfit))
  const faceCovered = $derived(coversFace(character.gear, outfit))
  const wearable = $derived(new Set(clothesFor(character.gear, outfit, clothes).map(k => k.name)))
  const changed = $derived(dress.differs(character))

  let saving = $state(false)

  const NONE = '-'
  const label = (s: string): string => s.replace(/_/g, ' ')
  const value = (v: string): string | null => (v === NONE ? null : v)

  async function makeDefault (): Promise<void> {
    saving = true
    try { await dress.makeDefault(character) } finally { saving = false }
  }
</script>

{#snippet lock(field: DressField)}
  {@const on = dress.locked(character.id, field)}
  <IconButton size="sm" active={on} label={on ? 'Kept by Randomize' : 'Randomize picks it'}
    onclick={() => { dress.toggleLock(character, field) }}>
    {#if on}<Lock size={12} />{:else}<LockOpen size={12} />{/if}
  </IconButton>
{/snippet}

<div class="folk">
  {#if outfits.length > 0}
    <Field label="Outfit" hint="Its pieces show together; fit them here. A unit kind wears one outfit">
      <Select size="sm" label="Outfit" value={outfit ?? NONE}
        options={[{ value: NONE, label: 'None' }, ...outfits.map(o => ({ value: o, label: label(o) }))]}
        onchange={(v) => { dress.wearOutfit(character, value(v)) }} />
    </Field>
  {/if}
  {#if skins.length > 0}
    <Field label="Skin" hint="The face and skin on the body's own UVs; the game picks one per unit">
      <div class="row">
        <Select size="sm" label="Skin" value={worn.skin ?? NONE}
          options={[{ value: NONE, label: 'Its own texture' }, ...skins.map(s => ({ value: s.name, label: label(s.name) }))]}
          onchange={(v) => { dress.setSkin(character, value(v)) }} />
        {@render lock('skin')}
      </div>
    </Field>
  {/if}
  {#if clothes.length > 0}
    <Field label="Clothes" hint="Laid over the skin's shirt and trousers; long sleeves turn the body's long_sleeve shape on">
      <div class="row">
        <Select size="sm" label="Clothes" value={worn.clothing ?? NONE}
          options={[{ value: NONE, label: "The skin's own" }, ...clothes.map(s => ({ value: s.name, label: label(s.name), disabled: !wearable.has(s.name) }))]}
          onchange={(v) => { dress.setClothing(character, value(v)) }} />
        {@render lock('clothing')}
      </div>
    </Field>
  {/if}
  {#if hairs.length > 0}
    <Field label="Hair" hint={covered ? `Under ${label(outfit ?? '')}'s headwear the game shows no hair` : `Swap set ${HAIR_SET}: tinted to the skin's hair colour`}>
      <div class="row">
        <Select size="sm" label="Hair" value={worn.hair ?? NONE}
          options={[{ value: NONE, label: 'None' }, ...hairs.map(g => ({ value: g.id, label: label(g.name), disabled: !fits(g, skin) }))]}
          onchange={(v) => { dress.setHair(character, value(v)) }} />
        {@render lock('hair')}
      </div>
    </Field>
  {/if}
  {#if beards.length > 0}
    <Field label="Beard" hint={faceCovered ? `Under ${label(outfit ?? '')}'s helm the game shows no beard` : `Swap set ${BEARD_SET}: none on a skin tagged beardless`}>
      <div class="row">
        <Select size="sm" label="Beard" value={worn.beard ?? NONE}
          options={[{ value: NONE, label: 'None' }, ...beards.map(g => ({ value: g.id, label: label(g.name), disabled: !fits(g, skin) }))]}
          onchange={(v) => { dress.setBeard(character, value(v)) }} />
        {@render lock('beard')}
      </div>
    </Field>
  {/if}
  <div class="actions">
    {#if skins.length > 0 || hairs.length > 0}
      <Button size="sm" variant="ghost" onclick={() => { dress.randomize(character) }} title="A skin, clothes, hair and beard as the game would pick them for a unit (the locked ones kept)">
        <Dices size={13} /> Randomize</Button>
    {/if}
    {#if changed}
      <Button size="sm" variant="ghost" onclick={() => { dress.reset(character) }} title="Back to the character's own look">
        <RotateCcw size={13} /> Its own</Button>
      <Button size="sm" variant="secondary" disabled={saving} onclick={makeDefault}
        title="Make this look the character's own: its thumbnail, and what the game shows a unit with no pick of its own (one undo)">
        Make default</Button>
    {/if}
  </div>
</div>

<style>
  .folk { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 4px; }
  .row > :global(:first-child) { flex: 1; min-width: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 4px; }
</style>
