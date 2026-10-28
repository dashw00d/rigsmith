// The bundled catalog of weapons, shields and tools (static/props/*.glb): a source of gear. Adding one makes a piece
// of bone gear (src/state/gear.svelte.ts) placed by the same rest-space placement as any other; this file only lists
// them, gives their previews, and says where one starts on its bone.
//
// Catalog placements used to be kept in a per-bone "grip frame" (+Y forward, +Z up, +X right, offsets in units of the
// bone's length). gripToRest turns such a placement into rest space: catalog gear migrated with attach.legacyFrame
// 'grip' is converted the first time its character's rig is loaded, and a new catalog piece starts from its table
// placement converted the same way.
import * as THREE from 'three'
import type { Placement } from '../model/types.ts'
import { placementFromMatrix } from './placement.ts'
import { restWorldOf, type RestSkeleton } from './retarget.ts'

export type Socket = 'RightHand' | 'LeftHand' | 'LeftForeArm' | 'RightForeArm' | 'Spine2' | 'Hips' | 'Head' | 'LeftUpLeg' | 'RightUpLeg'

export interface CatalogProp { file: string, name: string, category: string, socket: Socket }

const C = (file: string, name: string, category: string, socket: Socket = 'RightHand'): CatalogProp => ({ file, name, category, socket })

export const CATALOG: CatalogProp[] = [
  C('sword_B.glb', 'Short sword', 'Swords'), C('sword_A.glb', 'Cartoon sword', 'Swords'), C('sword_C.glb', 'Katana', 'Swords'),
  C('sword_D.glb', 'Rapier', 'Swords'), C('sword_E.glb', 'Greatsword', 'Swords'),
  C('axe_A.glb', 'Battle axe', 'Axes'), C('axe_B.glb', 'Large battle axe', 'Axes'), C('axe_C.glb', 'Broad axe', 'Axes'),
  C('hammer_A.glb', 'Sledgehammer', 'Hammers'), C('hammer_B.glb', 'War hammer', 'Hammers'), C('hammer_C.glb', 'Spiked bat', 'Hammers'),
  C('spear_A.glb', 'Spear', 'Polearms'), C('halberd.glb', 'Halberd', 'Polearms'),
  C('staff_A.glb', 'Quarterstaff', 'Staves'), C('staff_B.glb', 'Crystal staff', 'Staves'), C('wand_A.glb', 'Crystal wand', 'Staves'),
  C('bow_A_withString.glb', 'Recurve bow', 'Ranged', 'LeftHand'), C('bow_B_withString.glb', 'Ornate bow', 'Ranged', 'LeftHand'),
  C('bow_A.glb', 'Recurve bow (no string)', 'Ranged', 'LeftHand'), C('bow_B.glb', 'Ornate bow (no string)', 'Ranged', 'LeftHand'),
  C('arrow_A.glb', 'Arrow', 'Ranged'), C('arrow_B.glb', 'Crude arrow', 'Ranged'),
  C('shield_A.glb', 'Round shield', 'Shields', 'LeftForeArm'), C('shield_B.glb', 'Heater shield', 'Shields', 'LeftForeArm'), C('shield_C.glb', 'Kite shield', 'Shields', 'LeftForeArm'),
  C('dagger_A.glb', 'Dagger', 'Daggers'), C('dagger_B.glb', 'Sai', 'Daggers'), C('Knife_1.glb', 'Combat knife', 'Daggers'), C('Knife_2.glb', 'Hunting knife', 'Daggers'),
  C('fistweapon_A.glb', 'Brass knuckles', 'Daggers'), C('fistweapon_B.glb', 'Hand claws', 'Daggers'),
  C('Shovel.glb', 'Shovel', 'Tools'), C('Sickle.glb', 'Sickle', 'Tools'),
  C('Pistol.glb', 'Pistol', 'Guns'), C('Revolver.glb', 'Revolver', 'Guns'), C('Revolver_Small.glb', 'Snub revolver', 'Guns'),
  C('SMG.glb', 'SMG', 'Guns'), C('AK.glb', 'Assault rifle', 'Guns'), C('Shotgun.glb', 'Shotgun', 'Guns'), C('Sniper.glb', 'Sniper rifle', 'Guns'),
  C('Sniper_2.glb', 'Heavy sniper', 'Guns'), C('GrenadeLauncher.glb', 'Grenade launcher', 'Guns'), C('RocketLauncher.glb', 'Rocket launcher', 'Guns'),
  C('ShortCannon.glb', 'Hand cannon', 'Guns'),
]

export const catalogItem = (file: string): CatalogProp | undefined => CATALOG.find(p => p.file === file)

export function catalogPreview (file: string): string {
  return `./props/preview/${file.replace(/\.glb$/, '.png')}`
}

/** Where a catalog model loads from (served from static/props). */
export function catalogUrl (file: string): string {
  return `./props/${file.split('/').map(encodeURIComponent).join('/')}`
}

/** Bundled props are modeled for a ~1.75 m human; this keeps them proportional on any character. */
export function defaultScale (characterHeight: number): number {
  return Math.round((characterHeight / 1.6) * 100) / 100
}

/** Starting offsets per bone and category, in the bone's grip frame (+Y forward, +Z up, +X right; bone lengths). */
export function defaultPlacement (socket: string, category: string): Pick<Placement, 'position' | 'rotation'> {
  const left = socket.startsWith('Left')
  if (socket.endsWith('ForeArm')) return { position: [left ? -0.25 : 0.25, 0, 0], rotation: [-90, 0, left ? -90 : 90] }
  if (socket === 'Spine2') return { position: [0, -0.9, 0], rotation: [-90, 40, 0] }
  if (socket.endsWith('UpLeg')) return { position: [left ? -0.3 : 0.3, 0, 0], rotation: [180, 0, 0] }
  if (socket === 'Hips') return { position: [0.6, 0, 0], rotation: [180, 0, 0] }
  if (socket === 'Head') return { position: [0, 0, 0.3], rotation: [-90, 0, 0] }
  if (category === 'Ranged') return { position: [0, 0, 0], rotation: [-90, 0, left ? 90 : -90] }
  if (category === 'Polearms' || category === 'Staves') return { position: [0, 0, 0], rotation: [-80, 0, 0] }
  return { position: [0, 0, 0], rotation: [-30, 0, 0] }
}

const ANCHOR: Record<string, number> = { RightHand: 0.75, LeftHand: 0.75, LeftForeArm: 0.5, RightForeArm: 0.5, Spine2: 0.4, LeftUpLeg: 0.15, RightUpLeg: 0.15, Head: 0.35 }

/** What a grip frame is measured on: a character's rest skeleton and its height. */
export interface RestBody { rest: RestSkeleton | null, height: number }

/**
 * A bone's grip frame at rest, in the bone's local space. Axes: +Y points forward (where the character faces), +Z up,
 * +X to the character's right. The origin sits on the bone, part way toward its farthest child (the palm for hands):
 * also where that bone holds a pull's point. Offsets in it are in multiples of `unit` (the bone's length) so the same
 * numbers fit any character size.
 */
export function gripFrame (body: RestBody, bone: string): { quaternion: THREE.Quaternion, anchor: THREE.Vector3, unit: number, boneScale: number } | null {
  const rest = body.rest?.bones.get(bone)
  if (rest === undefined) return null
  const toLocal = rest.worldQuaternion.clone().invert()
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(toLocal)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(toLocal)
  const side = new THREE.Vector3().crossVectors(forward, up).normalize()
  up.crossVectors(side, forward).normalize()
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, forward, up))
  const children = [...(body.rest?.bones.values() ?? [])].filter(b => b.parent === bone)
  const tip = children.reduce<THREE.Vector3 | null>((best, c) => best === null || c.worldPosition.distanceTo(rest.worldPosition) > best.distanceTo(rest.worldPosition) ? c.worldPosition : best, null)
  const unit = tip === null ? body.height * 0.06 : Math.max(tip.distanceTo(rest.worldPosition), body.height * 0.03)
  // Anchor along the bone (toward its farthest child), expressed in the bone's local space.
  const anchorWorld = tip === null ? rest.worldPosition.clone() : rest.worldPosition.clone().lerp(tip, ANCHOR[bone] ?? 0)
  const anchor = anchorWorld.sub(rest.worldPosition).applyQuaternion(toLocal)
  // (the bone's size as captured at rest, not as it stands now: a rider sits on his horse at the horse's scale)
  const boneScale = new THREE.Vector3().setFromMatrixScale(restWorldOf(body.rest!, bone)).x || 1
  anchor.divideScalar(boneScale)
  return { quaternion, anchor, unit, boneScale }
}

/** Where `bone` holds things (a hand: its palm), in its own frame, rounded: a new pull's grip. [0, 0, 0] when the bone
 * isn't there. */
export function gripPoint (body: RestBody, bone: string): [number, number, number] {
  const a = gripFrame(body, bone)?.anchor
  const r5 = (v: number): number => Math.round(v * 1e5) / 1e5
  return a === undefined ? [0, 0, 0] : [r5(a.x), r5(a.y), r5(a.z)]
}

/**
 * A placement kept in `bone`'s grip frame (the old catalog props': bone -> grip frame (its anchor, its turn, the bone's
 * scale undone) -> offset (position in bone lengths, XYZ degrees, scale) -> model) as a rest-space placement, which
 * puts the model exactly where it was: bone -> its rest frame undone -> placement -> model. Null when the bone isn't
 * in the skeleton.
 */
export function gripToRest (body: RestBody, bone: string, place: Placement): Placement | null {
  const rest = body.rest?.bones.get(bone)
  const frame = gripFrame(body, bone)
  if (rest === undefined || frame === null) return null
  const restFrame = new THREE.Matrix4().compose(rest.worldPosition, rest.worldQuaternion, new THREE.Vector3(1, 1, 1))
  const mount = new THREE.Matrix4().compose(frame.anchor, frame.quaternion, new THREE.Vector3(1, 1, 1).divideScalar(frame.boneScale))
  const offset = new THREE.Matrix4().compose(
    new THREE.Vector3(...place.position).multiplyScalar(frame.unit),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...place.rotation.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number])),
    new THREE.Vector3(place.scale, place.scale, place.scale))
  return placementFromMatrix(restFrame.multiply(mount).multiply(offset))
}

/** A new catalog piece's placement on `bone` (its table placement, sized to the character), in rest space. */
export function catalogPlacement (body: RestBody, item: Pick<CatalogProp, 'category'>, bone: string): Placement | null {
  return gripToRest(body, bone, { ...defaultPlacement(bone, item.category), scale: defaultScale(body.height) })
}
