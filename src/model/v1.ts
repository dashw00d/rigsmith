// The character document before schema 2 (server/workspace.ts and src/engine/scripts.ts as they were), kept here so
// the model can read old files (src/model/migrate.ts) and answer the deprecated v1 API (src/model/legacy.ts) without
// importing server or engine code. Nothing new is written in this shape except by legacy.ts toV1.
import type { HandPose, Mount, Stats, Vec3 } from './types.ts'

export type V1HandPose = HandPose
export type V1Mount = Mount

export interface V1Character {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  source: { file: string, originalName: string, bytes: number }
  status: 'importing' | 'ready' | 'rigging' | 'rigged' | 'error'
  kind?: 'mesh' | 'rigged' | 'animation'
  rigPreset?: string
  stats?: Stats
  joints?: Record<string, Vec3>
  /** Joints as detected on import, for "reset" (on a conversion: the foreign skeleton's). */
  autoJoints?: Record<string, Vec3>
  jointsEdited?: boolean
  scale?: number
  markers?: { set: string, base: Record<string, Vec3>, positions: Record<string, Vec3> }
  fingers?: 'none' | 'one' | 'two' | 'three' | 'full'
  template?: string
  boneMap?: Record<string, string>
  files: { model?: string, rigged?: string, thumbnail?: string }
  revision?: number
  thumbVersion?: number
  rigReport?: { method: string, seconds: number, warnings: string[] }
  texture?: { filled: boolean, images: V1TextureImage[], at: number, painted?: boolean }
  animations: V1AnimationEntry[]
  scripts?: V1ClipScript[]
  handPoses?: V1HandPose[]
  props?: V1PropAttachment[]
  garments?: V1Garment[]
  mount?: V1Mount
  skins?: Array<{ name: string, file: string }>
  error?: string
}

export interface V1Garment {
  id: string
  name: string
  file?: string
  status: 'importing' | 'ready' | 'error'
  error?: string
  mode: 'clothing' | 'rigid' | 'part'
  policy: 'body' | 'cape' | 'skirt' | 'upper' | 'lower' | 'head'
  bone: string
  position: Vec3
  rotation: Vec3
  scale: number
  hideBody: boolean
  hidden?: boolean
  from?: string
  sockets?: V1GarmentSocket[]
  group?: string
  anchor?: Vec3
  painted?: number
  animation?: string
  pulls?: V1PullSocket[]
  /** 'pose:<id>', a fist clip id, unset (the default fist) or 'open' (the clip's own hand). */
  carryPose?: string
  /** Per entry name: where the carrying hand opens instead. */
  carryOpen?: Record<string, Array<[number, number]>>
}

export interface V1PullSocket {
  id: string
  name: string
  bone: string
  grip: Vec3
  rest: Vec3
  /** Per entry name: when it is held. */
  holds?: Record<string, Array<[number, number]>>
  /** 'pose:<id>' or a fist clip id; unset or 'open': the clip's own hand. */
  pose?: string
}

/** A grip on a rigid garment, in its placed frame (the editor's Socket added `placed`). */
export interface V1GarmentSocket {
  id: string
  name: string
  position: Vec3
  rotation: [number, number, number, number]
  placed?: boolean
}

/** A bundled catalog prop: `position` in its socket's grip frame (src/engine/props.ts gripFrame). */
export interface V1PropAttachment {
  id: string
  /** 'catalog:<file>' ('custom:<id>' was documented, never made). */
  ref: string
  name: string
  socket: string
  position: Vec3
  rotation: Vec3
  scale: number
}

export interface V1TextureImage {
  image: string
  coverage: number
  file: string | null
  mask?: string
}

export interface V1AnimationEntry {
  clipId: string
  url?: string
  name: string
  inPlace: boolean
  loop: boolean
  speed: number
  trim?: [number, number]
  note?: string
  keys?: V1ClipKeys
  lift?: number
}

/** Bones by name, props (rigid garments) by name. */
export interface V1ClipKeys {
  bones?: Record<string, V1ClipKey[]>
  props?: Record<string, V1ClipKey[]>
}
export interface V1ClipKey {
  u: number
  q: [number, number, number, number]
  p?: Vec3
}

export type V1ClipScript = V1GripScript | V1BlowScript | V1PaceScript
interface V1ScriptBase { id: string, enabled: boolean, note?: string }
export interface V1GripScript extends V1ScriptBase {
  kind: 'grip', side: 'Left' | 'Right', /** library clip id, or 'pose:<id>' */ clip: string
  /** Per entry name: where the hand opens instead. */
  open?: Record<string, Array<[number, number]>>
}
export interface V1BlowScript extends V1ScriptBase {
  kind: 'blow', /** entry name */ clip: string, at: number
  blowU?: number
  late?: 'cut' | 'hold'
  hand?: string, window?: number
}
export interface V1PaceScript extends V1ScriptBase { kind: 'pace', /** entry name */ clip: string, /** entry name */ like: string }

export interface V1Settings {
  exportDir?: string
  exportFormat?: 'glb' | 'fbx'
  boneNames?: 'mixamo' | 'mixamorig'
  gameRepo?: string
  handPoses?: V1HandPose[]
}
