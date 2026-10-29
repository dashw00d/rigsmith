// The bake's build (docs/motion-plan.md §2.6): a slot's `ik` made part of the one bake, so the viewer, the timeline and
// the game export all play it alike. In place of the keys on bones (src/engine/keys.ts applyBoneKeys) the clip is
// built as the clip editor built it (src/engine/clipedit.ts buildEdit): its bone keys, then per frame each hand put on
// the handle it holds by IK (over its windows: on or off frame by frame), a leading piece on its path with the hands
// on it following, and a foot the build sank lifted back to the floor. The body is never solved here ("Solve body"
// keys what it moves, and those are ordinary keys), so the build is deterministic and needs no pose model: it runs in
// node as in the browser. What it needs of the character (handles' places, the fists the hands close to on them, the
// pieces' shafts and the hands' grips, where Gear places each piece) is read off the character and ctx.posable, the
// same way wherever it runs (ikRig: the posing state asks it too, for its live IK while a joint is dragged).
import * as THREE from 'three'
import type { Character, ClipKey, Gear, Quat, Side, Slot, Window } from '../model/types.ts'
import { carryHandle, gearById, handSide, heightOf } from '../model/select.ts'
import { boneRest, type BakeContext } from './bake.ts'
import { buildEdit, carrierGrip, fistGrip, handGrip, type Attachment, type GearPath, type GearRig, type Grip, type PlacedHandle } from './clipedit.ts'
import { gearNode, principalAxis } from './geom.ts'
import { handleRef, poseOfRef } from './hands.ts'
import { propKeysOf } from './keys.ts'
import { JointLimits } from './limits.ts'
import { garmentMatrix } from './placement.ts'
import { HORSE_RIG, HUMAN_RIG, type PoseRig } from './PoseEditor.ts'
import { retargetOffsets } from './retarget.ts'

/** A shaft's radius, as a share of the body's height (the editor's, when a piece's own isn't measured). */
export const SHAFT_RADIUS = 0.011
/** A fist's width, and the gap left between two hands on one shaft beyond their widths (shares of the height). */
const FIST = 0.05
const HAND_GAP = 0.005
/** The most a hand slides on a shaft either way (a share of the height: posespace.ts SLIDE.most). */
const SLIDE_MOST = 0.05

/** The rig a skeleton template is posed by. */
export const poseRigOf = (template: string): PoseRig => (template === 'horse' ? HORSE_RIG : HUMAN_RIG)

/** A bone-attached piece the build can hold (ready, shown, placed) and its node on the posable copy. */
interface Piece { id: string, gear: Gear, bone: string, node: THREE.Object3D }

const onBone = (g: Gear): boolean => g.status === 'ready' && g.hidden !== true && g.attach.kind === 'bone' && g.attach.legacyFrame === undefined

function piecesOf (c: Character, posable: THREE.Object3D): Piece[] {
  return c.gear.flatMap(g => {
    if (!onBone(g) || g.attach.kind !== 'bone') return []
    const node = posable.getObjectByName(gearNode(g))
    return node === undefined ? [] : [{ id: g.id, gear: g, bone: g.attach.bone, node }]
  })
}

/**
 * `fn` run with a node for every bone piece on the copy: the viewer's copy has the gear on it, the export's body hasn't
 * (it bakes before it hangs the gear): an empty node is hung for a piece the copy lacks, framed as the viewer frames a
 * worn piece (garments.ts boneFrame: the bone, its rest frame undone, then the place node with Gear's placement, which
 * is in the character's rest space), so its world is the viewer's (all the build reads of a node is where it is); taken
 * off after. `rest`: the skeleton at rest the frame is undone by (unset: the copy's bones as they stand, at rest).
 */
export async function withGearNodes<T> (c: Character, posable: THREE.Object3D, fn: () => Promise<T> | T, rest?: BakeContext['rest']): Promise<T> {
  const hung: THREE.Object3D[] = []
  posable.updateMatrixWorld(true)
  for (const g of c.gear) {
    if (!onBone(g) || g.attach.kind !== 'bone' || posable.getObjectByName(gearNode(g)) !== undefined) continue
    const bone = posable.getObjectByName(g.attach.bone)
    if (bone === undefined) continue
    const r = rest?.bones.get(g.attach.bone)
    const frame = r !== undefined
      ? new THREE.Matrix4().compose(r.worldPosition, r.worldQuaternion, new THREE.Vector3(1, 1, 1))
      : (() => { const p = new THREE.Vector3(); const q = new THREE.Quaternion(); posable.matrixWorld.clone().invert().multiply(bone.matrixWorld).decompose(p, q, new THREE.Vector3()); return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)) })()
    const group = new THREE.Object3D()
    group.applyMatrix4(frame.invert())
    const node = new THREE.Object3D()
    node.name = gearNode(g)
    garmentMatrix(g.attach.place).decompose(node.position, node.quaternion, node.scale)
    group.add(node)
    bone.add(group)
    hung.push(group)
  }
  if (hung.length > 0) posable.updateMatrixWorld(true)
  try {
    return await fn()
  } finally {
    for (const n of hung) n.removeFromParent()
    if (hung.length > 0) posable.updateMatrixWorld(true)
  }
}

/** A piece's long axis in its own node's frame (the end by the bone carrying it first) and its radius: the main
 * direction of its mesh's vertices, end to end along it, through their middle (as the editor measures it). */
function shaftOf (p: Piece, posable: THREE.Object3D, height: number): { from: THREE.Vector3, to: THREE.Vector3, radius: number } | null {
  posable.updateMatrixWorld(true)
  const node = p.node
  const inv = node.matrixWorld.clone().invert()
  const pts: THREE.Vector3[] = []
  node.traverse(o => {
    const m = o as THREE.Mesh
    if (m.isMesh !== true) return
    const pos = m.geometry.attributes.position as THREE.BufferAttribute
    const to = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)
    const step = Math.max(1, Math.floor(pos.count / 3000))
    for (let i = 0; i < pos.count; i += step) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(to))
  })
  if (pts.length < 2) return null
  const { center, axis, lo, hi } = principalAxis(pts)
  const a = center.clone().addScaledVector(axis, lo); const b = center.clone().addScaledVector(axis, hi)
  const bone = posable.getObjectByName(p.bone)
  const at = bone === undefined ? center : bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv)
  const [from, to] = a.distanceTo(at) < b.distanceTo(at) ? [a, b] : [b, a]
  return { from, to, radius: SHAFT_RADIUS * height }
}

/**
 * The gear a slot's build holds, as the editor assembled it (src/state/clipedit.svelte.ts gearRig): the hands on
 * handles (`slot.ik.hands`, windows as given: phases of the clip played), the leading pieces' paths (their keys,
 * `slot.gear[id].keys` as played, world moves from where each rode) and the hand carrying each held by its carry
 * handle, the other pieces' keys as moves in the hand; the handles' places (a carry handle not placed: where the piece's
 * placement puts the hand), each held hand's fist (the one hand resolver's pose for its handle, hands.ts handleRef), the
 * and where Gear places each piece. No root holds (a live drag's softening: a drag commits keys). `measure`: also the
 * leading pieces' shafts (their meshes, on the copy) and the hands' grips on them (their fists against the skin): only
 * the body solver reads those (a "Solve body" on a frame); the build's IK doesn't, so the bake leaves them out and the
 * export, whose body has no gear meshes yet, builds the same. `gearKeys`: the slot's gear keys as played. Null when
 * the slot holds nothing. Run inside withGearNodes when the copy may lack a piece's node.
 * `limits`: the rig's joint ranges mapped onto the character through the retarget's turns (null without ctx.rom).
 */
export async function ikRig (c: Character, slot: Slot, ctx: BakeContext, gearKeys: Record<string, ClipKey[]> = {}, o: { measure?: boolean } = {}): Promise<{ rig: GearRig, limits: JointLimits | null, poseRig: PoseRig, height: number } | null> {
  const ik = slot.ik
  if (ik === undefined) return null
  const posable = ctx.posable
  const height = heightOf(c)
  const pieces = piecesOf(c, posable)
  const pieceOf = (id: string): Piece | undefined => pieces.find(p => p.id === id)
  const handRest = (side: Side): THREE.Matrix4 | null => {
    const r = ctx.rest.bones.get(`${side}Hand`)
    return r === undefined ? null : new THREE.Matrix4().compose(r.worldPosition, r.worldQuaternion, new THREE.Vector3(1, 1, 1))
  }
  // (a carry handle not placed: where the piece's placement puts the hand carrying it)
  const placed = (p: Piece, id: string): PlacedHandle | null => {
    const h = p.gear.handles.find(x => x.id === id)
    if (h === undefined || h.kind === 'pull') return null
    if (h.place !== undefined) return { id: h.id, name: h.name, exact: h.exact, place: h.place }
    const side = handSide(p.bone); const rest = side === null ? null : handRest(side)
    return h.kind === 'carry' && rest !== null ? { id: h.id, name: h.name, place: carrierGrip(garmentMatrix(p.gear.attach.place), rest) } : null
  }
  const handles: Record<string, PlacedHandle[]> = {}
  const addHandle = (gid: string, h: PlacedHandle): void => { if (!(handles[gid] ?? []).some(x => x.id === h.id)) handles[gid] = [...(handles[gid] ?? []), h] }
  for (const p of pieces) for (const h of p.gear.handles) { const x = h.kind === 'pull' || h.place === undefined ? null : placed(p, h.id); if (x !== null) addHandle(p.id, x) }

  const attachments: Attachment[] = []
  for (const a of ik.hands) {
    const p = pieceOf(a.gear); const h = p === undefined ? null : placed(p, a.handle)
    if (p === undefined || h === null) continue
    addHandle(p.id, h)
    attachments.push({ hand: a.hand, gear: a.gear, handle: a.handle, ...(a.windows !== undefined ? { windows: a.windows } : {}) })
  }
  // (each hand's fingers closed on what it holds, as the one hand resolver says)
  const fingers: Partial<Record<Side, Record<string, Quat>>> = {}
  for (const a of attachments) {
    const turns = await poseOfRef(posable, a.hand, handleRef(c, slot, a.hand, a.gear, a.handle), c, ctx.clips, ctx.sharedPoses)
    fingers[a.hand] = turns === 'clip' ? {} : Object.fromEntries([...turns].map(([n, q]) => [n, q.toArray() as Quat]))
  }
  // (a piece that leads: the hand carrying it holds it by its carry handle, unless that hand is on another handle)
  const lead = new Set((ik.lead ?? []).filter(id => pieceOf(id) !== undefined))
  for (const id of lead) {
    const p = pieceOf(id)!
    const side = handSide(p.bone); const carry = carryHandle(p.gear)
    const h = carry === undefined ? null : placed(p, carry.id)
    if (side === null || h === null || attachments.some(a => a.hand === side)) continue
    addHandle(id, h)
    attachments.push({ hand: side, gear: id, handle: h.id })
  }
  const paths: Record<string, GearPath> = {}
  for (const id of lead) paths[id] = { locked: true, keys: gearKeys[id] ?? [] }
  for (const [id, keys] of Object.entries(gearKeys)) if (!lead.has(id) && keys.length > 0 && pieceOf(id) !== undefined) paths[id] = { locked: false, keys }

  const shafts: NonNullable<GearRig['shafts']> = {}
  const measured = new Map<string, ReturnType<typeof shaftOf>>()
  const shaft = (id: string): ReturnType<typeof shaftOf> => {
    if (!measured.has(id)) { const p = pieceOf(id); measured.set(id, p === undefined ? null : shaftOf(p, posable, height)) }
    return measured.get(id)!
  }
  for (const id of o.measure === true ? lead : []) {
    const s = shaft(id)
    if (s !== null) shafts[id] = { from: s.from.toArray(), to: s.to.toArray(), radius: s.radius, gap: (FIST + HAND_GAP) * height, most: SLIDE_MOST * height }
  }
  // (where each hand on a handle holds the shaft: the carrying hand held by its placement has none, its turn is exact)
  const grips: Partial<Record<Side, Grip>> = {}
  for (const a of o.measure === true ? attachments : []) {
    const h = pieceOf(a.gear)?.gear.handles.find(x => x.id === a.handle)
    if (h?.kind === 'carry' && h.place === undefined) continue
    const f = fingers[a.hand]
    const g = f !== undefined && Object.keys(f).length > 0 ? fistGrip(posable, a.hand, f, shaft(a.gear)?.radius ?? SHAFT_RADIUS * height) : null
    const grip = g ?? handGrip(ctx.rest, a.hand)
    if (grip !== null) grips[a.hand] = grip
  }
  const rest: NonNullable<GearRig['rest']> = Object.fromEntries(pieces.map(p => {
    const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
    garmentMatrix(p.gear.attach.place).decompose(position, quaternion, new THREE.Vector3())
    return [p.id, { position: position.toArray(), quaternion: quaternion.toArray() as Quat }]
  }))
  const rig: GearRig = {
    node: id => { const g = gearById(c, id); return g === undefined ? `${id}_place` : gearNode(g) },
    paths, attachments, handles, carriers: Object.fromEntries(pieces.map(p => [p.id, p.bone])), fingers, shafts, grips, rest,
  }
  return { rig, limits: await limitsOf(c, slot, ctx), poseRig: poseRigOf(c.skeleton.template), height }
}

/** The rig's joint ranges mapped onto the character through the slot's clip's retarget (as the editor maps them):
 * null without ctx.rom, the rig's ranges, or the clip's skeleton. */
async function limitsOf (c: Character, slot: Slot, ctx: BakeContext): Promise<JointLimits | null> {
  const template = c.skeleton.template
  const rig = template === 'human' ? 'human' : template
  const rom = ctx.rom === undefined ? null : await ctx.rom(rig).catch(() => null)
  const source = rom === null || ctx.clips.sourceRest === undefined ? null : await ctx.clips.sourceRest(slot.clip).catch(() => null)
  if (rom === null || source === null) return null
  const rest = ctx.rest
  const offsets = retargetOffsets(source, rest).offsets
  return new JointLimits(rom, offsets, name => rest.bones.get(name)?.parent ?? null, rig === 'human' ? 1 : 3, rig === 'human' ? 5 : 15)
}

/**
 * The bake's build stage: `unkeyed` (the clip as it plays, before keys) with the slot's bone keys (as played), the hands
 * kept on their handles by IK, leading gear on its path and the floor kept (slot.ik.floor false: a foot the build sank
 * stays). `slot`: as played (its ik windows phases of this clip); `gearKeys`: its gear keys as played. Returns the clip
 * and the gear keys to play with it: a leading piece's path, frame by frame, as keys from where Gear places it (so the
 * gear tracks and the export's Prop_ bones play it as built), the others' as given.
 */
export async function ikBuild (c: Character, slot: Slot, unkeyed: THREE.AnimationClip, boneKeys: Record<string, ClipKey[]>, gearKeys: Record<string, ClipKey[]>,
  ctx: BakeContext): Promise<{ clip: THREE.AnimationClip, gearKeys: Record<string, ClipKey[]> }> {
  return await withGearNodes(c, ctx.posable, async () => await build(c, slot, unkeyed, boneKeys, gearKeys, ctx), ctx.rest)
}

async function build (c: Character, slot: Slot, unkeyed: THREE.AnimationClip, boneKeys: Record<string, ClipKey[]>, gearKeys: Record<string, ClipKey[]>,
  ctx: BakeContext): Promise<{ clip: THREE.AnimationClip, gearKeys: Record<string, ClipKey[]> }> {
  const made = await ikRig(c, slot, ctx, gearKeys)
  if (made === null) return { clip: unkeyed, gearKeys }
  const { rig, limits, poseRig, height } = made
  // (the build poses the copy's gear nodes and leaves its bones as they were: its gear nodes are put back too, as the
  // export writes the copy it measures on)
  const nodes = piecesOf(c, ctx.posable).map(p => [p.node, p.node.position.clone(), p.node.quaternion.clone(), p.node.scale.clone()] as const)
  let clip: THREE.AnimationClip
  try {
    clip = buildEdit(unkeyed, boneKeys, slot.loop, boneRest(ctx.rest), ctx.posable, poseRig, 0, limits, rig, height, null, { floor: slot.ik?.floor !== false })
  } finally {
    for (const [n, p, q, sc] of nodes) { n.position.copy(p); n.quaternion.copy(q); n.scale.copy(sc) }
    ctx.posable.updateMatrixWorld(true)
  }
  const out: Record<string, ClipKey[]> = { ...gearKeys }
  for (const [id, path] of Object.entries(rig.paths)) {
    if (!path.locked) continue
    const g = gearById(c, id)
    if (g === undefined) continue
    const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
    garmentMatrix(g.attach.place).decompose(position, quaternion, new THREE.Vector3())
    const keys = propKeysOf(clip, gearNode(g), { position, quaternion }, g.attach.place.scale)
    if (keys !== null) out[id] = keys
    else delete out[id]
  }
  return { clip, gearKeys: out }
}

/** A slot's ik hands with their windows as played (`toPlayed`: the time map's); a window the clip doesn't play is left
 * out, and a hand with none left is never on. */
export function playedIk (slot: Slot, toPlayed: (w: Window[]) => Window[]): Slot {
  if (slot.ik === undefined) return slot
  return { ...slot, ik: { ...slot.ik, hands: slot.ik.hands.map(h => (h.windows === undefined ? h : { ...h, windows: toPlayed(h.windows) })) } }
}
