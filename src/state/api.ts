// Typed client for the local server (server/routes/*, DESIGN.md §4.2). Every request from src/ that changes something
// goes through here. Each sends `x-rigsmith: 1` (the server refuses writes without it, so another web page can't make
// them) and `x-rigsmith-schema: 4` (the server answers the document, schema 4, not the v1 view old tools still read).
import type { Character, ClipKey, FingerLevel, Job, JournalEntry, Joints, Settings } from '../model/types.ts'
import type { Command } from '../model/command-types.ts'
import type { UnitSpec } from '../model/unit.ts'
import type { CatalogStatus, Clip } from '../../server/library.ts'
import type { SavedEdit } from '../../server/clipedits.ts'
import type { GameStatus, UnitBuildView } from '../../server/game.ts'
import type { ShapeEdit } from '../engine/weightpaint.ts'

export type * from '../model/types.ts'
export type * from '../model/unit.ts'
export type { Command, CommandType } from '../model/command-types.ts'
export type { CatalogStatus, Clip }

/** A refused or failed request: the HTTP status and the body the server sent with it (409s carry details: undo's
 * `conflicts`, delete's `riders`, `units`, `busy`). */
export class ApiError extends Error {
  status: number
  body: unknown
  constructor (status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** A write's result: the character as it now is and the journal entry it made (null when it made none). */
export interface Written { character: Character, entry: JournalEntry | null }

export type { GameStatus, UnitBuild, UnitBuildView } from '../../server/game.ts'
/** The game's side of a character: the unit it is (or is the companion of) and the clip names the game plays for it. */
export interface CharacterGame {
  unit: string
  role: 'unit' | 'companion'
  clips: string[]
  height: number | null
  spec: string
  companion?: { character: string, height: number | null, ridden: boolean }
}
export interface GameModels { units: string[], buildings: string[], props: string[], visualScale: number }

export interface LibraryClip extends Clip { url: string }
export interface LibraryPage {
  catalog: CatalogStatus | null
  /** Clips matching every filter. */
  total: number
  /** Clips for the rig, whatever the filters. */
  all: number
  page: number
  pages: number
  pageSize: number
  categories: Array<{ id: string, label: string, count: number }>
  /** How many clips were made here (source custom). */
  custom: number
  clips: LibraryClip[]
}
export interface LibraryQuery { category?: string, q?: string, page?: number, size?: number, rig?: string, source?: string }
/** The slots (of any character) that play a library clip. */
export interface ClipUsage { uses: Array<{ character: string, characterName: string, slot: string, slotName: string }> }

/** A projection capture in the list (newest first): how many of its views have a result newer than the last ask. */
export interface Projection { id: string, createdAt: number, views: number, notes: string, painted: number, ready: boolean }
/** A view's result: its file in the capture's folder, when it was written, and whether it is newer than the last ask
 * to Codex (older ones don't count). */
export interface ProjectionResult { file: string, at: number, fresh: boolean }
/** One capture (server/routes/look.ts): its folder, its views and each view's result (null: none yet). `ready` once
 * every view's is fresh; `resultVersion` then changes whenever one of them does. */
export interface ProjectionFiles {
  id: string, path: string, createdAt: number, views: number, names: string[], notes: string, requestedAt: number | null
  results: Array<ProjectionResult | null>, painted: number, ready: boolean, resultVersion: number | null
}

export interface SkeletonPreset { name: string, map: Record<string, string> }
/** A painted vertex: its skinned primitive (CharacterView.bodySkinned order, or the gear's), and its bone weights. */
export interface WeightEdit { mesh: number, vertex: number, weights: Array<[string, number]> }

/** How gear is worn: on a bone, on the skin, pinned to a spot. */
export type GearKind = 'bone' | 'skin' | 'spot'
// (the upload route's own names for them, which the game's scripts send too)
const GEAR_KIND: Record<GearKind, string> = { bone: 'prop', skin: 'clothing', spot: 'part' }

/** The model files the importers take. */
export const MODEL_FILE = /\.(fbx|glb|gltf|obj|dae|zip)$/i

type Raw = Blob | ArrayBuffer | Uint8Array

export async function call<T> (method: string, url: string, body?: Raw | object | null, headers: Record<string, string> = {}): Promise<T> {
  const raw = body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array
  const response = await fetch(url, {
    method,
    headers: {
      'x-rigsmith': '1',
      'x-rigsmith-schema': '4',
      ...(body === undefined || raw ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body as BodyInit : JSON.stringify(body),
  })
  const text = await response.text()
  let data: unknown
  try { data = text === '' ? null : JSON.parse(text) } catch { data = text }
  if (!response.ok) {
    const message = (data as { error?: unknown } | null)?.error
    throw new ApiError(response.status, typeof message === 'string' ? message : `${response.status} ${response.statusText}`, data)
  }
  return data as T
}

const of = (id: string): string => `/api/characters/${encodeURIComponent(id)}`
const query = (params: Record<string, string | number | boolean | undefined>): string => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v))
  return q.toString()
}

export const api = {
  // ---- characters, commands, journal (server-core) ----
  characters: async () => await call<Character[]>('GET', '/api/characters'),
  character: async (id: string) => await call<Character>('GET', of(id)),
  /** A new character from a model file; its import runs as a job. */
  upload: async (file: File) => await call<Character>('POST', `/api/characters?${query({ name: file.name })}`, file),
  /** One batch: all or nothing, one journal entry (and one undo). `cid` names it so the app can match the server's
   * copy to its own optimistic one. */
  command: async (id: string, commands: Command[], cid?: string, what?: string) =>
    await call<Written>('POST', `${of(id)}/commands`, { commands, cid, what }),
  /** Take back an entry (default: the newest undoable one); a redo names the undo's seq. 409 with `{ conflicts }` when
   * later writes changed what it would restore. */
  undo: async (id: string, seq?: number) => await call<Written>('POST', `${of(id)}/undo`, seq === undefined ? {} : { seq }),
  journal: async (id: string, last = 200) => await call<JournalEntry[]>('GET', `${of(id)}/journal?${query({ last })}`),
  addNote: async (id: string, note: string) => await call<{ ok: boolean }>('POST', `${of(id)}/journal`, { note }),
  /** 409 with `{ riders, units, busy }` while it is ridden, a unit or busy, unless forced (which also takes it off the
   * riders' mounts). */
  remove: async (id: string, force = false) => await call<{ ok: boolean }>('DELETE', `${of(id)}${force ? '?force=1' : ''}`),
  thumbnail: async (id: string, image: Blob) => await call<Character>('PUT', `${of(id)}/thumbnail`, image),

  jobs: async () => await call<Job[]>('GET', '/api/jobs'),
  cancelJob: async (id: string) => await call<Job>('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),

  settings: async () => await call<Settings>('GET', '/api/settings'),
  saveSettings: async (patch: Partial<Settings>) => await call<Settings>('PATCH', '/api/settings', patch),
  /** Open a workspace folder in the system's file manager. */
  openFolder: async (folder: string) => await call<{ ok: boolean }>('POST', '/api/open', { path: folder }),

  // ---- import (shell) ----
  /** Import the source again (keeps the overrides; 409 while busy). */
  reimport: async (id: string) => await call<Job>('POST', `${of(id)}/reimport`),
  /** Resize to `height` (else as it is) and stand it on the floor. */
  fit: async (id: string, height?: number) => await call<Job>('POST', `${of(id)}/fit`, { height }),

  // ---- skeleton ----
  /** A new finger level (the trace replaces the finger joints), or the fingers detected again. */
  fitFingers: async (id: string, fingers: FingerLevel, redetect = false) => await call<Job>('POST', `${of(id)}/fingers`, { fingers, redetect }),
  /** Switch the skeleton template (clears slots, markers and overrides; 409 while the skin is locked). */
  setTemplate: async (id: string, template: string, o: { joints?: Joints, fingers?: FingerLevel } = {}) =>
    await call<Job>('POST', `${of(id)}/template`, { template, ...o }),
  /** Fit the creature template along the mesh again (overrides kept); `joints`: the fit to the model's bounds, used
   * when the mesh doesn't read as that body. */
  fitTemplate: async (id: string, template: string, o: { joints?: Joints } = {}) => await call<Job>('POST', `${of(id)}/fit-template`, { template, ...o }),
  /** Put a rigged import onto the Rigsmith rig (its joints read from its own skeleton). */
  convert: async (id: string, o: { joints?: Joints, fingers?: FingerLevel } = {}) => await call<Job>('POST', `${of(id)}/convert`, o),
  skeletonPresets: async () => await call<SkeletonPreset[]>('GET', '/api/skeleton-presets'),
  saveSkeletonPreset: async (name: string, map: Record<string, string>) => await call<{ ok: boolean }>('POST', '/api/skeleton-presets', { name, map }),

  // ---- skin ----
  rig: async (id: string) => await call<Job>('POST', `${of(id)}/rig`),
  saveWeights: async (id: string, edits: WeightEdit[]) => await call<Job>('PUT', `${of(id)}/weights`, { edits }),
  savePainting: async (id: string, edits: WeightEdit[], lifts: ShapeEdit[], revision?: number) => await call<Job>('PUT', `${of(id)}/painting`, { edits, lifts, revision }),
  forgetWeights: async (id: string) => await call<Job>('DELETE', `${of(id)}/weights`),
  shapeEdits: async (id: string) => await call<ShapeEdit[]>('GET', `${of(id)}/shape`),
  saveShape: async (id: string, edits: ShapeEdit[]) => await call<Job>('PUT', `${of(id)}/shape`, { edits }),
  forgetShape: async (id: string) => await call<Job>('DELETE', `${of(id)}/shape`),

  // ---- gear ----
  /** New gear from a model file (its import runs as a job). */
  uploadGear: async (id: string, file: File, kind: GearKind = 'bone', o: { bone?: string } = {}) =>
    await call<Character>('POST', `${of(id)}/garments?${query({ name: file.name, kind: GEAR_KIND[kind], bone: o.bone })}`, file),
  saveGearWeights: async (id: string, gear: string, edits: WeightEdit[]) => await call<Job>('PUT', `${of(id)}/garments/${encodeURIComponent(gear)}/weights`, { edits }),
  forgetGearWeights: async (id: string, gear: string) => await call<Job>('DELETE', `${of(id)}/garments/${encodeURIComponent(gear)}/weights`),

  // ---- look ----
  /** Find the texture's holes and fill them (a fill layer, then the texture composed again). */
  fillTexture: async (id: string) => await call<Job>('POST', `${of(id)}/texture/fill`),
  /** A new repaint layer on top (an RGBA decal in `image`'s layout), then the texture composed again. */
  addLayer: async (id: string, image: string, png: Blob, o: { capture?: string, note?: string } = {}) =>
    await call<Written & { job: Job }>('POST', `${of(id)}/look/layers?${query({ image, ...o })}`, png),
  projections: async (id: string) => await call<Projection[]>('GET', `${of(id)}/projections`),
  projection: async (id: string, pid: string) => await call<ProjectionFiles>('GET', `${of(id)}/projections/${encodeURIComponent(pid)}`),
  putProjectionFile: async (id: string, pid: string, file: string, data: Blob) =>
    await call<{ path: string }>('PUT', `${of(id)}/projections/${encodeURIComponent(pid)}/${encodeURIComponent(file)}`, data),
  /** Ask Codex to paint a capture's views (uses the owner's Codex quota). */
  codex: async (id: string, pid: string) => await call<Job>('POST', `${of(id)}/projections/${encodeURIComponent(pid)}/codex`),
  qwen: async (id: string, pid: string) => await call<Job>('POST', `${of(id)}/projections/${encodeURIComponent(pid)}/qwen`),

  // ---- motion, editor ----
  library: async (params: LibraryQuery) => await call<LibraryPage>('GET', `/api/library?${query({ ...params })}`),
  /** Every slot that plays a library clip (the editor forks a shared custom clip rather than change it under them). */
  clipUsage: async (clipId: string) => await call<ClipUsage>('GET', `/api/library/usage/${encodeURIComponent(clipId)}`),
  /** An edited clip into the library (a job: the library's build makes it). */
  saveEdit: async (edit: SavedEdit) => await call<{ id: string, job: string }>('POST', '/api/library/edits', edit),
  /** What a clip made in the editor was made of (its base, keys and gear paths), to open that edit again (404: none). */
  editRecord: async (id: string) => await call<Pick<SavedEdit, 'name' | 'base' | 'loop' | 'making'> & { id: string }>('GET', `/api/library/edits/${encodeURIComponent(id)}`),
  /** A creature's edited clip (a .glb on its template's skeleton), with the gear paths it carries. */
  saveCreatureClip: async (p: { rig: string, name: string, base: string, category?: string, loop: boolean, inPlace: boolean, duration: number, characterId?: string, slot?: string, replace?: string },
    glb: Uint8Array | Blob, propPaths?: Record<string, ClipKey[]>) => {
    const q = { ...p, loop: p.loop ? '1' : '0', inPlace: p.inPlace ? '1' : '0' }
    if (propPaths === undefined || Object.keys(propPaths).length === 0) return await call<{ id: string, url: string }>('POST', `/api/library/creature-clips?${query(q)}`, glb)
    // (the prop paths go first: their JSON's length (4 bytes, little-endian), the JSON, then the .glb)
    const json = new TextEncoder().encode(JSON.stringify(propPaths))
    const head = new Uint8Array(4)
    new DataView(head.buffer).setUint32(0, json.length, true)
    return await call<{ id: string, url: string }>('POST', `/api/library/creature-clips?${query({ ...q, props: '1' })}`, new Blob([head, json, glb as BlobPart]))
  },

  // ---- ship ----
  game: async () => await call<GameStatus>('GET', '/api/game'),
  /** One unit's entry (null takes it off the game). */
  putUnit: async (name: string, entry: UnitSpec | null) => await call<GameStatus>('PUT', `/api/game/units/${encodeURIComponent(name)}`, entry),
  exportUnits: async (units: string[]) => await call<Job>('POST', '/api/game/export', { units }),
  /** A unit's last export, the build record the game has for it and when its model was written. */
  unitBuild: async (name: string) => await call<UnitBuildView>('GET', `/api/game/units/${encodeURIComponent(name)}/build`),
  gameModels: async () => await call<GameModels>('GET', '/api/game/models'),
  /** Null when no unit names it. */
  characterGame: async (id: string) => await call<CharacterGame | null>('GET', `${of(id)}/game`),
}

// (a character's file's URL is assets.svelte.ts asset(): by its content hash, not a document counter)
