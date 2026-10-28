// What the Look step says: layer names, the hole scan, why painting can't start, how long ago a capture was, the file
// a view's result is saved as and the prompt Codex is given. Pure, so it is tested apart from the panel.
import type { Phase } from '../../model/select.ts'
import type { Character, TextureImage, TextureLayer } from '../../model/types.ts'

export const LAYER_KIND: Record<TextureLayer['kind'], string> = { fill: 'Hole fill', repaint: 'Repaint', snapshot: 'Earlier texture' }

export function percent (share: number): string {
  return `${(share * 100).toFixed(share > 0 && share < 0.01 ? 2 : 1)}%`
}

/** Under this share of magenta an image has no holes (anti-aliasing, not an unpainted area). */
export const NO_HOLES_BELOW = 0.0005

/** What a layer is, after its kind: its note, how much it filled, the image it paints when the model has several. */
export function layerDetail (l: TextureLayer, manyImages: boolean): string {
  const parts: string[] = []
  if (manyImages) parts.push(l.image)
  if (l.kind === 'fill' && l.coverage !== undefined) parts.push(`${percent(l.coverage)} was unpainted`)
  if (l.note !== undefined && l.note !== '') parts.push(l.note)
  return parts.join(' · ')
}

// (names cleaned before the rebuild made '-' _ too: the same image either way, as the server matches them)
const loose = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_')

/** Each image the last scan looked at: how much of it was unpainted and whether an enabled layer fills it (a fill, or
 * an earlier texture, which has the fill made before layers existed in it). */
export function scanLines (scan: { images: TextureImage[] } | undefined, layers: readonly TextureLayer[]): Array<{ image: string, text: string, tone: 'ok' | 'warn' | 'muted' }> {
  if (scan === undefined) return []
  return scan.images.map(i => {
    if (i.coverage < NO_HOLES_BELOW) return { image: i.image, text: 'no holes', tone: 'ok' as const }
    const on = layers.filter(l => loose(l.image) === loose(i.image))
    const text = `${percent(i.coverage)} unpainted`
    if (on.some(l => l.enabled && l.kind === 'fill')) return { image: i.image, text: `${text}, filled`, tone: 'ok' as const }
    if (on.some(l => l.enabled && l.kind === 'snapshot')) return { image: i.image, text: `${text}, filled in the earlier texture`, tone: 'ok' as const }
    if (on.some(l => l.kind === 'fill')) return { image: i.image, text: `${text}, its fill is off`, tone: 'warn' as const }
    return { image: i.image, text: `${text}, not filled`, tone: 'warn' as const }
  })
}

/** Why projection painting can't start on the character, or null when it can. `view`: whether its model is on stage
 * (and, once it is, whether that has a colour texture with texture coordinates). */
export function paintBlock (c: Pick<Character, 'source'>, phase: Phase, view: 'loading' | 'no-texture' | 'ok'): string | null {
  switch (phase) {
    case 'importing': return 'Wait for the import to finish.'
    case 'error': return 'The import failed: there is no model to paint on.'
    case 'animation-only': return 'An animation file has no texture to paint.'
    case 'needs-conversion': return 'Convert it onto the Rigsmith rig first (Skeleton step): a rigged import is painted once it is converted.'
    case 'rigging': if (c.source.kind !== 'mesh') return 'Wait for the rig to finish.'; break
    case 'needs-rig': if (c.source.kind !== 'mesh') return 'Rig it first (Skeleton step).'; break
    case 'rigged': break
  }
  if (view === 'loading') return 'The model is still loading.'
  if (view === 'no-texture') return 'This model has no colour texture with texture coordinates to paint on.'
  return null
}

export function ago (at: number, now = Date.now()): string {
  const m = Math.round((now - at) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/** The file view `n` (from 1)'s result is saved as, for an image of that type; null for a type the bake can't read. */
export function resultFile (n: number, file: { type: string, name: string }): string | null {
  const ext = EXTENSIONS[file.type] ?? (/\.(png|jpe?g|webp)$/i.exec(file.name)?.[1].toLowerCase().replace('jpeg', 'jpg') ?? null)
  return ext === null ? null : `result-${n}.${ext}`
}

/** The request Codex reads (prompt.md): what each view's files are and what to change. */
export function promptFor (views: ReadonlyArray<{ name: string }>, notes: string, name: string): string {
  const many = views.length > 1
  const list = views.map((v, i) => `- View ${i + 1} (${v.name}): view-${i + 1}-flat.png + view-${i + 1}-mask.png → result-${i + 1}.png`).join('\n')
  const what = notes.trim()
  // (short and to the point: one image edit a view, nothing else. Rigsmith bakes only the masked part of each result
  // back onto the texture, at whatever size it comes, so compositing, resizing or checking it is wasted time)
  return `# Repaint request: ${name}

For each view N, view-N-flat.png is the character's texture seen from that camera (unlit) and view-N-mask.png marks
in white the area to repaint.

${list}

${what !== '' ? `What to change: ${what}\n\n` : ''}Task: for each view, make ONE edit of view-N-flat.png with your built-in image generation tool: repaint only the white
area of the mask, in the same hand-painted, stylized game-texture style as the rest, with no new lighting or shadows.
Keep the framing: nothing moved, cropped or zoomed.${many ? ' The views show one object from different sides: paint it as one design, so details match where they overlap.' : ''}
Save it as result-N.png in this folder.

That is all. Do not composite, resize, crop or check the result, and don't open other files: Rigsmith keeps
everything outside the mask and handles the size itself. One generation per view; retry only if the tool fails.
`
}
