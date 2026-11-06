// A dynamic character: one rigged body every unit of a kind shares, dressed per unit. Its parts (types.ts):
//   skins    look.skins: faces and skin tones on the body's own UVs, each with a hair colour and tags
//   outfits  gear with `outfit`: a unit kind wears one outfit, its pieces together (boots, bracers, a helmet...)
//   hair     gear with role 'hair' (swap set 'hair'), one per unit, tinted to its skin's hair colour
//   beards   gear with role 'beard' (swap set 'beard'), one or none per unit, the same tint
//   clothes  look.clothes: RGBA layers over the skin's shirt and trouser areas (tagged 'long-sleeves': the forearms
//            too, the body's long_sleeve shape on), one per unit
// The rules of a unit's pick live here once: Rigsmith's Randomize and the game export's manifest read them, and the
// game follows the manifest (it never guesses what fits).
//   - a piece tagged 'fem' only goes on a skin tagged 'female', one tagged 'masc' only on a skin that isn't;
//   - a skin tagged 'beardless' takes no beard;
//   - an outfit with a piece tagged 'covers-hair' (a helmet, a hood, a hat over the crown) takes no hair: hair under
//     it would poke through; its beard still shows, unless a piece is tagged 'covers-face' (a great helm);
//   - an outfit with a forearm piece (bracers) takes no long-sleeved clothes: the sleeve's cuff would show through.
import type { Gear, Skin } from '../model/types.ts'

export const HAIR_SET = 'hair'
export const BEARD_SET = 'beard'
/** Hair and beard textures are grey with about this mean (tools/folk/import: the colour taken out), so a tint of a
 * skin's hair colour divided by it brings the piece back to that colour on average. */
export const HAIR_GREY_MEAN = 0.62

/** The character's outfits, sorted. */
export function outfitsOf (gear: readonly Gear[]): string[] {
  return [...new Set(gear.flatMap(g => (g.outfit !== undefined ? [g.outfit] : [])))].sort()
}

/** The outfit shown in Rigsmith: the one with a piece shown (null: none). */
export function shownOutfit (gear: readonly Gear[]): string | null {
  return gear.find(g => g.outfit !== undefined && g.hidden !== true)?.outfit ?? null
}

export const isFolk = (c: { gear: readonly Gear[], look: { skins?: readonly Skin[] } }): boolean =>
  c.gear.some(g => g.outfit !== undefined || g.role !== undefined)

/** Whether a hair or beard piece goes on a skin. */
export function fits (piece: Pick<Gear, 'role' | 'tags'>, skin: Pick<Skin, 'tags'> | undefined): boolean {
  const skinTags = skin?.tags ?? []
  const tags = piece.tags ?? []
  const female = skinTags.includes('female')
  if (tags.includes('fem') && !female) return false
  if (tags.includes('masc') && female) return false
  if (piece.role === 'beard' && skinTags.includes('beardless')) return false
  return true
}

/** Whether an outfit leaves no room for hair (a piece of it tagged 'covers-hair'). */
export function coversHair (gear: readonly Gear[], outfit: string | null): boolean {
  return outfit !== null && gear.some(g => g.outfit === outfit && (g.tags ?? []).includes('covers-hair'))
}

export interface FolkPick { skin: string | null, hair: string | null, beard: string | null, clothing: string | null }

/** Whether an outfit hides the face (no beard under it). */
export function coversFace (gear: readonly Gear[], outfit: string | null): boolean {
  return outfit !== null && gear.some(g => g.outfit === outfit && (g.tags ?? []).includes('covers-face'))
}

/** Whether an outfit has a forearm piece (bracers: no long sleeves under them), by the game's piece names. */
export function hasBracers (gear: readonly Gear[], outfit: string | null): boolean {
  return outfit !== null && gear.some(g => g.outfit === outfit && /forearm/i.test(g.name))
}

/** The clothes an outfit can wear. */
export function clothesFor (gear: readonly Gear[], outfit: string | null, clothes: readonly Skin[]): Skin[] {
  return hasBracers(gear, outfit) ? clothes.filter(k => !longSleeves(k)) : [...clothes]
}

/** A unit's look: a skin, then hair and a beard that fit it (gear ids; null: none), under the outfit it wears, and its
 * clothes. A beard is worn about half the time when one fits. `rand` returns [0, 1). */
export function pickFolk (gear: readonly Gear[], skins: readonly Skin[], outfit: string | null, rand: () => number, clothes: readonly Skin[] = []): FolkPick {
  const pickOf = <T>(xs: readonly T[]): T | null => (xs.length === 0 ? null : xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))])
  const skin = pickOf(skins)
  const ready = gear.filter(g => g.status === 'ready')
  const hairs = coversHair(gear, outfit) ? [] : ready.filter(g => g.role === 'hair' && fits(g, skin ?? undefined))
  const beards = coversFace(gear, outfit) ? [] : ready.filter(g => g.role === 'beard' && fits(g, skin ?? undefined))
  const hair = pickOf(hairs)
  const beard = beards.length > 0 && rand() < 0.5 ? pickOf(beards) : null
  const clothing = pickOf(clothesFor(gear, outfit, clothes))
  return { skin: skin?.name ?? null, hair: hair?.id ?? null, beard: beard?.id ?? null, clothing: clothing?.name ?? null }
}

/** A small seeded generator (mulberry32): the same seed, the same picks. */
export function seeded (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A #rrggbb colour as 0-1 sRGB components. */
export function rgbOf (hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** The multiplier a grey hair texture (HAIR_GREY_MEAN) is drawn with to come out as `hex` (sRGB, may pass 1). */
export function hairTint (hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex)
  return [r / HAIR_GREY_MEAN, g / HAIR_GREY_MEAN, b / HAIR_GREY_MEAN]
}

/** Whether clothes need the body's long sleeves (the long_sleeve shape on, the forearms cloth). */
export const longSleeves = (clothes: Pick<Skin, 'tags'> | undefined): boolean => (clothes?.tags ?? []).includes('long-sleeves')

/** The body's shape key for long sleeves (v6). */
export const LONG_SLEEVE = 'long_sleeve'

// ---- the female shape ----------------------------------------------------------------------------------------------

/** The body's morph target for a female skin (a skin tagged 'female' plays it at 1). */
export const FEMALE = 'female'

const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const gauss = (d: number, s: number): number => Math.exp(-(d * d) / (2 * s * s))

/** The female shape's offset at a rest-space point of a body of height 1 (soles at 0, facing +z): a bust, a narrower
 * waist, wider hips and seat, narrower shoulders with the arms moved in whole, a slimmer neck and jaw. The same field
 * as Emberhold's tools/rigsmith/folk_female.py, which puts it on the body: gear takes it where it sits, so it follows. */
export function femaleOffset (x: number, y: number, z: number): [number, number, number] {
  const ax = Math.abs(x); const sx = Math.sign(x)
  let dx = 0; let dy = 0; let dz = 0
  let w = gauss(Math.hypot(ax - 0.055, y - 0.655), 0.03) * smooth(0, 0.05, z)
  dz += 0.032 * w; dy -= 0.006 * w
  w = gauss(y - 0.565, 0.025) * (1 - smooth(0.12, 0.16, ax))
  dx -= x * 0.12 * w; dz -= z * 0.07 * w
  w = gauss(y - 0.48, 0.035) * (1 - smooth(0.13, 0.18, ax))
  dx += x * 0.13 * w; if (z < 0) dz += z * 0.12 * w
  const s = Math.max(smooth(0.6, 0.68, y) * smooth(0.09, 0.15, ax), smooth(0.17, 0.21, ax))
  dx -= sx * 0.018 * s
  w = gauss(y - 0.8, 0.02) * (1 - smooth(0.06, 0.09, ax))
  dx -= x * 0.14 * w; dz -= z * 0.08 * w
  w = gauss(y - 0.845, 0.025) * (1 - smooth(0.07, 0.1, ax))
  dx -= x * 0.16 * w
  return [dx, dy, dz]
}

/** The female shape's offsets for positions (xyz triples) in a rest space of height `height`. */
export function femaleOffsets (positions: ArrayLike<number>, height: number): Float32Array {
  const out = new Float32Array(positions.length)
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const [dx, dy, dz] = femaleOffset(positions[i] / height, positions[i + 1] / height, positions[i + 2] / height)
    out[i] = dx * height; out[i + 1] = dy * height; out[i + 2] = dz * height
  }
  return out
}
