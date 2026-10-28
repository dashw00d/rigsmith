// Typed client for the local server (server/api.ts).
import type { AnimationEntry, Character, ClipKey, ClipKeys, Garment, Mount, Settings, TextureImage, Vec3 } from '../../server/workspace.ts'
import type { Job } from '../../server/jobs.ts'
import type { JournalEntry } from '../../server/journal.ts'
import type { UnitSpec } from '../../server/game.ts'
import type { CatalogStatus, Clip } from '../../server/library.ts'

export type { AnimationEntry, Character, ClipKey, ClipKeys, Clip, Garment, Job, JournalEntry, Mount, Settings, TextureImage, UnitSpec, Vec3 }
export interface GameStatus { repo: string, units: Record<string, { ours: UnitSpec | null, game: UnitSpec | null, differs: boolean }> }

export interface LibraryClip extends Clip { url: string }
export interface LibraryPage {
  catalog: CatalogStatus | null
  total: number
  page: number
  pages: number
  pageSize: number
  categories: Array<{ id: string, label: string, count: number }>
  /** How many clips were made here (source custom). */
  custom: number
  clips: LibraryClip[]
}

async function call<T> (method: string, url: string, body?: BodyInit | object, headers: Record<string, string> = {}): Promise<T> {
  const isRaw = body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array
  const response = await fetch(url, {
    method,
    headers: body === undefined || isRaw ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : isRaw ? body as BodyInit : JSON.stringify(body),
  })
  const text = await response.text()
  const data = text === '' ? null : JSON.parse(text)
  if (!response.ok) throw new Error(data?.error ?? `${response.status} ${response.statusText}`)
  return data as T
}

export const api = {
  characters: async () => await call<Character[]>('GET', '/api/characters'),
  upload: async (file: File) => await call<Character>('POST', `/api/characters?name=${encodeURIComponent(file.name)}`, file),
  update: async (id: string, patch: Partial<Character>) => await call<Character>('PATCH', `/api/characters/${id}`, patch),
  saveWeights: async (id: string, edits: Array<{ mesh: number, vertex: number, weights: Array<[string, number]> }>) => await call<{ written: number, kept: number }>('PUT', `/api/characters/${id}/weights`, { edits }),
  forgetWeights: async (id: string) => await call<{ ok: boolean }>('DELETE', `/api/characters/${id}/weights`),
  gameModels: async () => await call<{ units: string[], buildings: string[], props: string[], visualScale: number }>('GET', '/api/game/models'),
  game: async () => await call<GameStatus>('GET', '/api/game'),
  putUnit: async (name: string, entry: UnitSpec | null) => await call<GameStatus>('PUT', `/api/game/units/${name}`, entry as unknown as object),
  exportUnits: async (units: string[]) => await call<Job>('POST', '/api/game/export', { units }),
  journal: async (id: string, last = 200) => await call<JournalEntry[]>('GET', `/api/characters/${id}/journal?last=${last}`),
  addNote: async (id: string, note: string) => await call<{ ok: boolean }>('POST', `/api/characters/${id}/journal`, { note }),
  remove: async (id: string) => await call<{ ok: boolean }>('DELETE', `/api/characters/${id}`),
  rig: async (id: string) => await call<Job>('POST', `/api/characters/${id}/rig`),
  fitFingers: async (id: string, fingers: Character['fingers'], redetect = false) => await call<Character>('POST', `/api/characters/${id}/fingers`, { fingers, redetect }),
  setTemplate: async (id: string, template: string, joints?: Record<string, Vec3>, fingers?: Character['fingers']) => await call<Character>('POST', `/api/characters/${id}/template`, { template, joints, fingers }),
  fit: async (id: string, height?: number) => await call<Character>('POST', `/api/characters/${id}/fit`, { height }),
  reimport: async (id: string) => await call<Job>('POST', `/api/characters/${id}/reimport`),
  fillTexture: async (id: string) => await call<Job>('POST', `/api/characters/${id}/texture/fill`),
  revertTexture: async (id: string) => await call<Job>('DELETE', `/api/characters/${id}/texture/fill`),
  uploadGarment: async (id: string, file: File, kind: 'prop' | 'clothing' | 'part' = 'clothing') => await call<Character>('POST', `/api/characters/${id}/garments?name=${encodeURIComponent(file.name)}&kind=${kind}`, file),
  saveGarmentWeights: async (id: string, gid: string, edits: Array<{ mesh: number, vertex: number, weights: Array<[string, number]> }>) => await call<{ written: number, kept: number }>('PUT', `/api/characters/${id}/garments/${gid}/weights`, { edits }),
  forgetGarmentWeights: async (id: string, gid: string) => await call<{ ok: boolean }>('DELETE', `/api/characters/${id}/garments/${gid}/weights`),
  putProjectionFile: async (id: string, pid: string, file: string, data: Blob) => await call<{ path: string }>('PUT', `/api/characters/${id}/projections/${pid}/${file}`, data),
  projections: async (id: string) => await call<Array<{ id: string, createdAt: number, hasResult: boolean, views: number }>>('GET', `/api/characters/${id}/projections`),
  projection: async (id: string, pid: string) => await call<{ path: string, files: string[], result: string | null, results: string[] | null, views: number, resultVersion: number | null }>('GET', `/api/characters/${id}/projections/${pid}`),
  codex: async (id: string, pid: string) => await call<Job>('POST', `/api/characters/${id}/projections/${pid}/codex`),
  saveTexture: async (id: string, name: string, data: Blob) => await call<Job>('PUT', `/api/characters/${id}/textures/${encodeURIComponent(name)}.png`, data),
  openFolder: async (folder: string) => await call<{ ok: boolean }>('POST', '/api/open', { path: folder }),
  skeletonPresets: async () => await call<Array<{ name: string, map: Record<string, string> }>>('GET', '/api/skeleton-presets'),
  saveSkeletonPreset: async (name: string, map: Record<string, string>) => await call<{ ok: boolean }>('POST', '/api/skeleton-presets', { name, map }),
  thumbnail: async (id: string, image: Blob) => await call<Character>('PUT', `/api/characters/${id}/thumbnail`, image),
  library: async (params: { category?: string, q?: string, page?: number, size?: number, rig?: string, source?: string }) => {
    const query = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') query.set(k, String(v))
    return await call<LibraryPage>('GET', `/api/library?${query.toString()}`)
  },
  settings: async () => await call<Settings>('GET', '/api/settings'),
  saveSettings: async (patch: Partial<Settings>) => await call<Settings>('PATCH', '/api/settings', patch),
  fitTemplate: async (id: string, template: string) => await call<{ joints: Record<string, [number, number, number]>, notes: string[] }>('POST', `/api/characters/${id}/fit-template`, { template }),
  saveExport: async (name: string, data: Blob) => await call<{ path: string }>('POST', `/api/exports?name=${encodeURIComponent(name)}`, data),
}

export function fileUrl (character: Character, file: string | undefined): string | null {
  if (file === undefined) return null
  const version = file.startsWith('thumbnail') ? character.thumbVersion : file.startsWith('textures/') ? character.texture?.at : character.revision
  return `/files/characters/${character.id}/${file}?v=${version ?? 0}`
}
