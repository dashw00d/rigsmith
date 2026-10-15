// Props and accessories pinned to bones (weapons in hands, shields on forearms, gear on the back…).
// Attached props are children of their bone, so they follow animations and export as bone children
// (Godot turns those into BoneAttachment3D nodes).
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { CharacterView } from './CharacterView.ts'

export type Socket = 'RightHand' | 'LeftHand' | 'LeftForeArm' | 'RightForeArm' | 'Spine2' | 'Hips' | 'Head' | 'LeftUpLeg' | 'RightUpLeg'

export const SOCKETS: Array<{ id: Socket, label: string }> = [
  { id: 'RightHand', label: 'Right hand' },
  { id: 'LeftHand', label: 'Left hand' },
  { id: 'LeftForeArm', label: 'Left forearm' },
  { id: 'RightForeArm', label: 'Right forearm' },
  { id: 'Spine2', label: 'Back' },
  { id: 'Hips', label: 'Hips' },
  { id: 'LeftUpLeg', label: 'Left thigh' },
  { id: 'RightUpLeg', label: 'Right thigh' },
  { id: 'Head', label: 'Head' },
]

export interface PropAttachment {
  id: string
  /** 'catalog:<file>' for bundled props, 'custom:<id>' for imported ones. */
  ref: string
  name: string
  socket: Socket
  /** Offset in the socket's grip frame: meters (in character scale), degrees, uniform scale. */
  position: [number, number, number]
  rotation: [number, number, number]
  scale: number
}

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

export function catalogPreview (file: string): string {
  return `./props/preview/${file.replace(/\.glb$/, '.png')}`
}

export function propUrl (ref: string): string {
  const [kind, value] = ref.split(':')
  return kind === 'catalog' ? `./props/${value}` : `/files/props/${value}/model.glb`
}

/** Bundled props are modeled for a ~1.75 m human; this keeps them proportional on any character. */
export function defaultScale (characterHeight: number): number {
  return Math.round((characterHeight / 1.6) * 100) / 100
}

/** Starting offsets per socket and category (mount frame: +Y forward, +Z up, +X right). */
export function defaultPlacement (socket: Socket, category: string): Pick<PropAttachment, 'position' | 'rotation'> {
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

const loader = new GLTFLoader()
const models = new Map<string, Promise<THREE.Group>>()

async function loadModel (url: string): Promise<THREE.Group> {
  let pending = models.get(url)
  if (pending === undefined) {
    pending = loader.loadAsync(url).then(g => g.scene)
    models.set(url, pending)
    pending.catch(() => models.delete(url))
  }
  return await pending
}

const ANCHOR: Partial<Record<Socket, number>> = { RightHand: 0.75, LeftHand: 0.75, LeftForeArm: 0.5, RightForeArm: 0.5, Spine2: 0.4, LeftUpLeg: 0.15, RightUpLeg: 0.15, Head: 0.35 }

/**
 * Mount frame of a socket in its rest pose, in the bone's local space. Axes: +Y points forward (where
 * the character faces), +Z up, +X to the character's right. The origin sits on the bone (e.g. the
 * palm for hands). Offsets are in multiples of `unit` (the bone's length) so the same numbers fit
 * any character size.
 */
export function gripFrame (view: CharacterView, socket: Socket): { quaternion: THREE.Quaternion, anchor: THREE.Vector3, unit: number } | null {
  const rest = view.rest?.bones.get(socket)
  if (rest === undefined) return null
  const toLocal = rest.worldQuaternion.clone().invert()
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(toLocal)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(toLocal)
  const side = new THREE.Vector3().crossVectors(forward, up).normalize()
  up.crossVectors(side, forward).normalize()
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, forward, up))
  const children = [...(view.rest?.bones.values() ?? [])].filter(b => b.parent === socket)
  const tip = children.reduce<THREE.Vector3 | null>((best, c) => best === null || c.worldPosition.distanceTo(rest.worldPosition) > best.distanceTo(rest.worldPosition) ? c.worldPosition : best, null)
  const length = tip === null ? view.height * 0.06 : Math.max(tip.distanceTo(rest.worldPosition), view.height * 0.03)
  // Anchor along the bone (toward its farthest child), expressed in the bone's local space.
  const anchorWorld = tip === null ? rest.worldPosition.clone() : rest.worldPosition.clone().lerp(tip, ANCHOR[socket] ?? 0)
  const anchor = anchorWorld.sub(rest.worldPosition).applyQuaternion(toLocal)
  const boneScale = rest.node.getWorldScale(new THREE.Vector3()).x || 1
  anchor.divideScalar(boneScale)
  return { quaternion, anchor, unit: length }
}

export const PROP_FLAG = 'rigsmithProp'

/** Attach (or re-attach) every prop of a character to its loaded view. Returns the created objects. */
export async function attachProps (view: CharacterView, props: PropAttachment[]): Promise<Map<string, THREE.Object3D>> {
  detachProps(view)
  const out = new Map<string, THREE.Object3D>()
  for (const prop of props) {
    const object = await createProp(view, prop)
    if (object !== null) out.set(prop.id, object)
  }
  return out
}

export async function createProp (view: CharacterView, prop: PropAttachment): Promise<THREE.Object3D | null> {
  const bone = view.bones.get(prop.socket)
  const frame = gripFrame(view, prop.socket)
  if (bone === undefined || frame === null) return null
  const model = (await loadModel(propUrl(prop.ref))).clone(true)
  model.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false } })
  // mount (grip frame) -> holder (user offset) -> model
  const mount = new THREE.Group()
  mount.name = `${prop.name.replace(/[^\w]+/g, '_')}_mount`
  mount.userData[PROP_FLAG] = prop.id
  mount.quaternion.copy(frame.quaternion)
  mount.position.copy(frame.anchor)
  const boneScale = bone.getWorldScale(new THREE.Vector3()).x || 1
  mount.scale.setScalar(1 / boneScale)
  const holder = new THREE.Group()
  holder.name = prop.name.replace(/[^\w]+/g, '_')
  holder.userData.unit = frame.unit
  applyOffset(holder, prop)
  holder.add(model)
  mount.add(holder)
  bone.add(mount)
  return holder
}

export function applyOffset (holder: THREE.Object3D, prop: PropAttachment): void {
  const unit = holder.userData.unit as number
  holder.position.set(prop.position[0] * unit, prop.position[1] * unit, prop.position[2] * unit)
  holder.rotation.set(...prop.rotation.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number])
  holder.scale.setScalar(prop.scale)
}

export function readOffset (holder: THREE.Object3D): Pick<PropAttachment, 'position' | 'rotation' | 'scale'> {
  const unit = holder.userData.unit as number
  const r = (v: number): number => Math.round(v * 1000) / 1000
  return {
    position: [r(holder.position.x / unit), r(holder.position.y / unit), r(holder.position.z / unit)],
    rotation: [holder.rotation.x, holder.rotation.y, holder.rotation.z].map(v => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10) as [number, number, number],
    scale: r(holder.scale.x),
  }
}

export function detachProps (view: CharacterView): void {
  const mounts: THREE.Object3D[] = []
  view.root.traverse(o => { if (o.userData[PROP_FLAG] !== undefined) mounts.push(o) })
  for (const m of mounts) m.removeFromParent()
}
