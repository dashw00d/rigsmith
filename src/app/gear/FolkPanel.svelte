<script lang="ts">
  // A dynamic character (engine/folk.ts): one body every unit of a kind shares, dressed per unit. Pick the outfit to
  // see and fit (its pieces shown together, the others hidden), and a skin, hair and beard to look at it with; the
  // game picks those per unit by the same rules (Randomize shows one such pick). Every change is a command.
  import { Dices } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { BEARD_SET, clothesFor, coversFace, coversHair, fits, HAIR_SET, outfitsOf, pickFolk, seeded, shownOutfit } from '../../engine/folk.ts'
  import type { Command } from '../../model/command-types.ts'
  import Button from '../../ui/Button.svelte'
  import Field from '../../ui/Field.svelte'
  import Select from '../../ui/Select.svelte'

  let { character }: { character: Character } = $props()

  const outfits = $derived(outfitsOf(character.gear))
  const outfit = $derived(shownOutfit(character.gear))
  const skins = $derived(character.look.skins ?? [])
  const skin = $derived(skins.find(s => s.name === character.look.skin))
  const clothes = $derived(character.look.clothes ?? [])
  const hairs = $derived(character.gear.filter(g => g.role === 'hair'))
  const beards = $derived(character.gear.filter(g => g.role === 'beard'))
  const hair = $derived(hairs.find(g => g.hidden !== true) ?? null)
  const beard = $derived(beards.find(g => g.hidden !== true) ?? null)
  const covered = $derived(coversHair(character.gear, outfit))
  const faceCovered = $derived(coversFace(character.gear, outfit))
  const wearable = $derived(new Set(clothesFor(character.gear, outfit, clothes).map(k => k.name)))

  const NONE = '-'
  const label = (s: string): string => s.replace(/_/g, ' ')

  /** The pieces of a role shown: `id` only (null: none of them). */
  function showOne (role: 'hair' | 'beard', id: string | null): Command[] {
    return character.gear.filter(g => g.role === role).flatMap(g => {
      const hidden = g.id !== id
      return hidden === (g.hidden === true) ? [] : [{ type: 'gear.update', id: g.id, patch: { hidden } } satisfies Command]
    })
  }

  async function run (commands: Command[]): Promise<void> {
    if (commands.length > 0) await app.do(character.id, commands)
  }

  /** An outfit shown, and what it leaves no room for taken off as the game does (hair under headwear, a beard under a
   * great helm; long sleeves under bracers). */
  async function wearOutfit (next: string | null): Promise<void> {
    const shownClothes = clothes.find(k => k.name === character.look.clothing)
    await run([
      { type: 'gear.outfit.show', outfit: next },
      ...(coversHair(character.gear, next) ? showOne('hair', null) : []),
      ...(coversFace(character.gear, next) ? showOne('beard', null) : []),
      ...(shownClothes !== undefined && !clothesFor(character.gear, next, clothes).includes(shownClothes)
        ? [{ type: 'look.clothing.show', name: clothesFor(character.gear, next, clothes)[0]?.name ?? null } satisfies Command] : []),
    ])
  }

  let rolls = 0
  async function randomize (): Promise<void> {
    const pick = pickFolk(character.gear, skins, outfit, seeded(Date.now() + ++rolls), clothes)
    await run([
      ...(pick.skin !== (character.look.skin ?? null) ? [{ type: 'look.skin.show', name: pick.skin } satisfies Command] : []),
      ...(pick.clothing !== (character.look.clothing ?? null) ? [{ type: 'look.clothing.show', name: pick.clothing } satisfies Command] : []),
      ...showOne('hair', pick.hair), ...showOne('beard', pick.beard),
    ])
  }
</script>

<div class="folk">
  {#if outfits.length > 0}
    <Field label="Outfit" hint="Its pieces show together; fit them here. A unit kind wears one outfit">
      <Select size="sm" label="Outfit" value={outfit ?? NONE}
        options={[{ value: NONE, label: 'None' }, ...outfits.map(o => ({ value: o, label: label(o) }))]}
        onchange={(v) => wearOutfit(v === NONE ? null : v)} />
    </Field>
  {/if}
  {#if skins.length > 0}
    <Field label="Skin" hint="The face and skin on the body's own UVs; the game picks one per unit">
      <Select size="sm" label="Skin" value={character.look.skin ?? NONE}
        options={[{ value: NONE, label: 'Its own texture' }, ...skins.map(s => ({ value: s.name, label: label(s.name) }))]}
        onchange={(v) => run([{ type: 'look.skin.show', name: v === NONE ? null : v }])} />
    </Field>
  {/if}
  {#if clothes.length > 0}
    <Field label="Clothes" hint="Laid over the skin's shirt and trousers; long sleeves turn the body's long_sleeve shape on">
      <Select size="sm" label="Clothes" value={character.look.clothing ?? NONE}
        options={[{ value: NONE, label: "The skin's own" }, ...clothes.map(s => ({ value: s.name, label: label(s.name), disabled: !wearable.has(s.name) }))]}
        onchange={(v) => run([{ type: 'look.clothing.show', name: v === NONE ? null : v }])} />
    </Field>
  {/if}
  {#if hairs.length > 0}
    <Field label="Hair" hint={covered ? `Under ${label(outfit ?? '')}'s headwear the game shows no hair` : `Swap set ${HAIR_SET}: tinted to the skin's hair colour`}>
      <Select size="sm" label="Hair" value={hair?.id ?? NONE}
        options={[{ value: NONE, label: 'None' }, ...hairs.map(g => ({ value: g.id, label: label(g.name), disabled: !fits(g, skin) }))]}
        onchange={(v) => run(showOne('hair', v === NONE ? null : v))} />
    </Field>
  {/if}
  {#if beards.length > 0}
    <Field label="Beard" hint={faceCovered ? `Under ${label(outfit ?? '')}'s helm the game shows no beard` : `Swap set ${BEARD_SET}: none on a skin tagged beardless`}>
      <Select size="sm" label="Beard" value={beard?.id ?? NONE}
        options={[{ value: NONE, label: 'None' }, ...beards.map(g => ({ value: g.id, label: label(g.name), disabled: !fits(g, skin) }))]}
        onchange={(v) => run(showOne('beard', v === NONE ? null : v))} />
    </Field>
  {/if}
  {#if skins.length > 0 || hairs.length > 0}
    <Button size="sm" variant="ghost" onclick={randomize} title="A skin, hair and beard as the game would pick them for a unit">
      <Dices size={13} /> Randomize</Button>
  {/if}
</div>

<style>
  .folk { display: flex; flex-direction: column; gap: 6px; }
</style>
