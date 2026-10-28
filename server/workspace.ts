// Was the store; now server/store.ts. Kept so modules not yet ported still resolve: the store's functions, and the type
// names they imported (schema 2's where it has that name, else the v1 shape from src/model/v1.ts). New code imports
// server/store.ts and src/model/types.ts.
export * from './store.ts'
export type { ClipKey, HandPose, Mount, TextureImage } from '../src/model/types.ts'
export type {
  V1AnimationEntry as AnimationEntry, V1ClipKeys as ClipKeys, V1Garment as Garment, V1GarmentSocket as GarmentSocket,
  V1PropAttachment as PropAttachment, V1PullSocket as PullSocket,
} from '../src/model/v1.ts'
