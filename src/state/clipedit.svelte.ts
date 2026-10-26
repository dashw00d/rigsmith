// The animation editor (Animate step): a clip edited on the character as it plays. Start on any clip playing (a library
// clip plays as it is: the timeline starts empty); scrub, drag or turn a joint (src/engine/PoseEditor.ts): letting go
// keys every bone the drag moved, at that frame, as a turn from where the clip had it (src/engine/clipedit.ts). On a clip
// with motion of its own a bone's first key also pins it at the clip's ends, so a change eases in and back out. Keys
// tween smoothly; every joint stays in its range (src/engine/limits.ts); no foot goes under the floor. Delete takes the
// keys at the frame off (the selected bone's, or all). Save writes a new library clip (tagged custom, in the category
// of the clip it came from). A prop (a rigid garment: a spear) is clicked to select it: moving or turning it keys its
// path, and locks it (it leads: the hands on it follow it, the body follows the hands); its sockets (grips, kept on
// the garment) take a hand each, and an attached hand turned or moved changes its socket.
import * as THREE from 'three'
import type { ClipKey } from './api.ts'
import { app } from './app.svelte.ts'
import { animator, GRIP_CLIP, restOf, type NowPlaying } from './animator.svelte.ts'
import { loadSource } from '../engine/clips.ts'
import { armOf, buildEdit, fistGrip, frameTimes, GRIP_CLEAR, handGrip, handOn, holdAt, keyFor, nodePath, onPath, propObstacles, ROOT_HOLD, rootPath, unretarget, type Attachment, type Grip, type PropPath, type PropRig, type RootHold, type Socket } from '../engine/clipedit.ts'
import { propNode } from './tune.svelte.ts'
import { clipGlb, framesClip } from '../engine/clipexport.ts'
import { library } from './library.svelte.ts'
import { applyBoneKeys, KEY_FPS } from '../engine/keys.ts'
import { JointLimits, type Rom } from '../engine/limits.ts'
import { HORSE_RIG, HUMAN_RIG, PoseEditor, type PoseRig } from '../engine/PoseEditor.ts'
import { retargetOffsets, type RestSkeleton } from '../engine/retarget.ts'
import { reach, setWorldQuaternion } from '../engine/ik.ts'
import { bodyBones, solveBody } from '../engine/bodysolve.ts'
import { bodyColliderFor, solidsOf } from '../engine/bodycollide.ts'
import { bodyBonesNatural, createBodySolver, loadPoseModel, naturalizeClip, NaturalRig, poseTargets, type NaturalGoal, type PoseModel, type PoseModelData } from '../engine/posespace.ts'
import { FIT, fitProp, type FitResult } from '../engine/propfit.ts'

const IDENTITY: ClipKey['q'] = [0, 0, 0, 1]
/** Naturalize: how hard a keyed bone is pulled to the edit at its key, and over how many frames that fades out. */
const PULL_WEIGHT = 4
const PULL_FRAMES = 3
/** Naturalize, each press: the pull toward the library's poses (per whitened unit squared: the whole, and the part of a
 * pose outside what people do together), and the pull of each pose to the middle of its neighbours' (per radian squared). */
const NATURALIZE = { pull: 0.05, outside: 0.5, motion: 15 }
/** How near (a share of the body's height) a free hand's fist must be let go to a prop's shaft to snap onto it. */
const SNAP_REACH = 0.1
/** The gap left between two hands on one shaft, beyond their widths (a share of the body's height). */
const HAND_GAP = 0.005
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4
const isAnchor = (k: ClipKey): boolean => k.p === undefined && Math.abs(k.q[3]) > 1 - 1e-9

class ClipEdit {
  active = $state(false)
  /** The clip being edited, as it was started on. */
  base = $state<NowPlaying & { loop: boolean, inPlace: boolean } | null>(null)
  keys = $state.raw<Record<string, ClipKey[]>>({})
  /** The props on stage (rigid garments, shown): their names, the bones they ride, their sockets. */
  props = $derived((app.selected?.garments ?? []).filter(g => g.mode === 'rigid' && g.hidden !== true).map(g => ({ name: g.name, bone: g.bone, sockets: ((g.sockets ?? []) as Socket[]).filter(x => !x.name.endsWith('(carries it)')) })))
  /** The prop selected (clicked), or none. */
  prop = $state<string | null>(null)
  /** What the gizmo on a prop moves: this frame only (a key on its path) or every frame (the whole path, by the move). */
  propMoves = $state<'frame' | 'every'>('frame')
  /** Each prop's path: locked (it leads), and its keys. */
  paths = $state.raw<Record<string, PropPath>>({})
  /** The hands on sockets. */
  attachments = $state.raw<Attachment[]>([])
  /** The prop drags let go: the body's root held near where it was seen on the frames each moved the prop (RootHold). */
  private holds: RootHold[] = []
  /** The bones each drag keyed together, at its frame: Delete with one of them selected takes the others' keys there too. */
  private groups: Array<{ u: number, bones: string[] }> = []
  /** Each hand's fingers closed round a shaft (as its Hold fist does). */
  private fists: Partial<Record<'Left' | 'Right', Record<string, [number, number, number, number]>>> = {}
  selected = $state<string | null>(null)
  hovered = $state<string | null>(null)
  limitsOn = $state(true)
  /** What the gizmo on the joint selected does: moves it (the limb follows) or turns its bone. */
  gizmo = $state<'move' | 'rotate'>('move')
  /** A turn about the bone's own axes or the world's. */
  space = $state<'local' | 'world'>('local')
  busy = $state<string | null>(null)
  /** The frames keyed (phases), for the timeline. */
  phases = $derived([...new Set([...Object.values(this.keys), ...Object.values(this.paths).map(p => p.keys)].flat().filter(k => this.held || !isAnchor(k) || (k.u > 0 && k.u < 1)).map(k => Math.round(k.u * 1e4) / 1e4))].sort((a, b) => a - b))
  /** The selected bone's (or prop's) keyed frames. */
  selectedPhases = $derived(this.prop !== null ? (this.paths[this.prop]?.keys ?? []).map(k => k.u) : this.selected === null ? [] : (this.keys[this.selected] ?? []).map(k => k.u))

  private baseClip: THREE.AnimationClip | null = null
  private edited: THREE.AnimationClip | null = null
  private editor: PoseEditor | null = null
  private limits: JointLimits | null = null
  private rig: PoseRig = HUMAN_RIG
  private source: { rest: RestSkeleton, clip: THREE.AnimationClip } | null = null
  private lift = 0
  /** How the body follows the hands: the library's natural-pose solver (src/engine/posespace.ts) for a person, else the
   * rule search (src/engine/bodysolve.ts). */
  private solver: { solve: typeof solveBody, bones: typeof bodyBones } = { solve: solveBody, bones: bodyBones }
  /** Which one it is, for the panel. */
  natural = $state(false)
  /** The library's pose model, and the retarget's turns (for Naturalize). */
  private model: PoseModel | null = null
  private offsets: Map<string, THREE.Quaternion> | null = null
  /** The edit as it was last naturalized (shown and saved until the next change). */
  naturalized = $state(false)

  /** A new clip made from a held pose (no motion of its own: keys hold until the next, no pins at the ends). */
  held = $state(false)
  /** A held clip's length (seconds). */
  length = $state(1)

  /** A clip of `seconds` holding the pose `clip` has at `t` (every track's value there, at both ends). */
  private holdOf (clip: THREE.AnimationClip, t: number, seconds: number): THREE.AnimationClip {
    const tracks = clip.tracks.map(track => {
      const i = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
      const v = Array.from(i.evaluate(Math.min(t, clip.duration)) as ArrayLike<number>)
      const Track = track.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack
      return new Track(track.name, [0, seconds], [...v, ...v])
    })
    return new THREE.AnimationClip(`${clip.name} pose`, seconds, tracks)
  }

  /** Make a new clip from the frame playing now: that pose held for `seconds`. */
  async startFromPose (seconds: number): Promise<void> {
    const clip = animator.clip
    if (clip === null) { app.toast('error', 'Play a clip first: its frame is where the new one starts'); return }
    await this.start(this.holdOf(clip, animator.time, seconds))
    this.length = seconds
  }

  /** A held clip's length changed: its keys keep their place in it. */
  setLength (seconds: number): void {
    if (!this.held || this.baseClip === null || !(seconds > 0.05)) return
    const u = animator.time / Math.max(this.baseClip.duration, 1e-6)
    this.baseClip = this.holdOf(this.baseClip, 0, seconds)
    this.length = seconds
    this.show(u * seconds)
  }

  /** Loops or plays once (its keys tween round from the last to the first when it loops). */
  setLoop (loop: boolean): void {
    if (this.base === null) return
    this.base = { ...this.base, loop }
    animator.setLoop(loop)
    this.show(animator.time)
  }

  /** Edit the clip playing now (or `held`: a held pose to make a new clip from). */
  async start (held?: THREE.AnimationClip): Promise<void> {
    const now = animator.current; const clip = held ?? animator.clip; const view = animator.character; const stage = animator.stage
    if (now === null || clip === null || view === null || stage === null || view.rest === null || now.url === '') { app.toast('error', 'Play a clip first, then edit it'); return }
    this.busy = 'Opening the clip'
    try {
      this.stop()
      const template = app.selected?.template
      const rigName = template === undefined || template === 'human' ? 'human' : template
      this.rig = rigName === 'horse' ? HORSE_RIG : HUMAN_RIG
      const source = await loadSource(now.url)
      this.source = { rest: source.rest, clip: source.clip }
      // (the joints' ranges, mapped onto this character through the retarget's turns)
      const rom = await fetch(`/templates/rom/${rigName}.json`).then(async r => r.ok ? await r.json() as Rom : null).catch(() => null)
      const rest = view.rest
      const offsets = retargetOffsets(source.rest, rest).offsets
      this.limits = rom === null ? null : new JointLimits(rom, offsets, name => rest.bones.get(name)?.parent ?? null, rigName === 'human' ? 1 : 3, rigName === 'human' ? 5 : 15)
      const poses = rigName === 'human' ? await fetch('/templates/rom/human-pose.json').then(async r => r.ok ? await r.json() as PoseModelData : null).catch(() => null) : null
      this.model = poses === null ? null : loadPoseModel(poses)
      this.offsets = offsets
      // (the body as solids, fitted to this character's mesh: no part of it ends up inside another; none when the mesh can't be fitted)
      const collide = this.model === null ? undefined : solidsOf(view)
      this.solver = this.model === null ? { solve: solveBody, bones: bodyBones } : { solve: createBodySolver(this.model, offsets, { hipsMove: true, collide }), bones: bodyBonesNatural }
      this.natural = this.model !== null
      this.held = held !== undefined
      this.base = { ...now, entry: null, loop: this.held ? false : animator.loop, inPlace: animator.inPlace }
      this.baseClip = clip
      this.edited = clip
      // (a library clip plays stood on the floor: its hips raised by this; a saved clip is the source's height again)
      this.lift = now.entry === null ? animator.lift : (app.selected?.animations[now.entry]?.lift ?? 0)
      this.keys = {}
      this.paths = {}
      this.holds = []
      this.groups = []
      this.attachments = []
      this.selected = null
      this.prop = null
      animator.setPlaying(false)
      this.makeEditor(this.limitsOn)
      this.active = true
      // (a refresh while editing builds the edit again: its props re-attached, say)
      animator.editing = () => { this.show(animator.time) }
      this.show(animator.time)
    } finally {
      this.busy = null
    }
  }

  /** Leave the editor (the clip edited plays on until another is played). */
  stop (): void {
    this.editor?.dispose()
    this.editor = null
    this.active = false
    animator.holding = false
    animator.editing = null
  }

  setLimits (on: boolean): void {
    this.limitsOn = on
    if (!this.active) return
    // (the editor is made again with or without them)
    const stage = animator.stage; const view = animator.character
    if (stage === null || view === null) return
    const selected = this.selected; const prop = this.prop
    this.makeEditor(on)
    if (prop !== null) this.editor?.selectProp(prop); else this.editor?.select(selected)
  }

  /** The pose editor on stage (with the limits or without). */
  private makeEditor (limits: boolean): void {
    const stage = animator.stage; const view = animator.character
    if (stage === null || view === null) return
    this.editor?.dispose()
    this.editor = new PoseEditor(stage, view, this.rig, limits ? this.limits : null, {
      select: b => { this.selected = b },
      hover: b => { this.hovered = b },
      selectProp: p => { this.prop = p },
      begin: () => { animator.setPlaying(false); animator.holding = true },
      commit: bones => { void this.commit(bones) },
      constrain: moving => { this.handsLive(moving) },
      moveProp: (p, place, done) => { if (done) this.commitProp(p, place); else this.propLive(p, place) },
    }, 0, () => this.propNodes())
    this.editor.setMode(this.gizmo)
    this.editor.setSpace(this.space)
    this.editor.setGripLock(b => this.gripHold(b))
  }

  /** A hand on a socket (not the hand the prop rides): where its fist holds the prop and the prop's long axis there
   * (world): its gizmo slides it along the prop and rolls it round it, and letting go moves its socket (every frame). */
  private gripHold (bone: string): { at: THREE.Vector3, axis: THREE.Vector3 } | null {
    const hand = /^(Left|Right)Hand$/.exec(bone)?.[1] as 'Left' | 'Right' | undefined
    const a = hand === undefined ? undefined : this.attachments.find(x => x.hand === hand)
    const p = a === undefined ? undefined : this.props.find(x => x.name === a.prop)
    const view = animator.character; const b = view?.bones.get(bone)
    if (hand === undefined || a === undefined || p === undefined || p.bone === bone || b === undefined) return null
    const node = view?.root.getObjectByName(propNode(a.prop))
    const local = this.axisCache.get(a.prop) ?? this.shaftLocal(a.prop)
    const grip = this.gripOf(hand, a.prop)
    if (node === undefined || local === null || grip === null) return null
    this.axisCache.set(a.prop, local)
    node.updateMatrixWorld(true)
    const axis = local.to.clone().applyMatrix4(node.matrixWorld).sub(local.from.clone().applyMatrix4(node.matrixWorld)).normalize()
    const at = grip.fist.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion())).add(b.getWorldPosition(new THREE.Vector3()))
    return { at, axis }
  }
  /** Each prop's long axis in its own node's frame (measured once: its mesh doesn't change while editing). */
  private axisCache = new Map<string, { from: THREE.Vector3, to: THREE.Vector3, radius: number }>()

  /** The props on stage: by name, their placed nodes. */
  private propNodes (): Map<string, THREE.Object3D> {
    const view = animator.character
    const out = new Map<string, THREE.Object3D>()
    if (view === null) return out
    for (const p of this.props) { const n = view.root.getObjectByName(propNode(p.name)); if (n !== undefined) out.set(p.name, n) }
    return out
  }

  selectProp (name: string | null): void { this.editor?.selectProp(name) }

  select (bone: string | null): void { this.editor?.select(bone) }

  setGizmo (mode: 'move' | 'rotate'): void { this.gizmo = mode; this.editor?.setMode(mode) }
  setSpace (space: 'local' | 'world'): void { this.space = space; this.editor?.setSpace(space) }

  private get loop (): boolean { return this.base?.loop ?? true }

  /** The playhead as a phase of the clip, snapped to a frame (a loop's last frame is its first: a key there is the first's). */
  phase (): number {
    const d = this.baseClip?.duration ?? 0
    if (d <= 0) return 0
    const frames = Math.max(1, Math.round(d * KEY_FPS))
    const u = Math.round(Math.min(1, Math.max(0, animator.time / d)) * frames) / frames
    return this.loop && near(u, 1) ? 0 : u
  }

  /** A time snapped to the nearest frame of the clip edited (the playhead, while editing: a key is made on a frame, of
   * the pose seen there). */
  snapTime (time: number): number {
    const d = this.baseClip?.duration ?? 0
    if (!this.active || d <= 0) return time
    const frames = Math.max(1, Math.round(d * KEY_FPS))
    return Math.round(Math.min(1, Math.max(0, time / d)) * frames) / frames * d
  }

  /** Key the bones a drag moved, at the playhead (only those: the solve does the rest). */
  private async commit (moved: string[]): Promise<void> {
    const view = animator.character; const base = this.baseClip
    if (view === null || base === null || moved.length === 0) { animator.holding = false; return }
    const u = this.phase()
    const t = u * base.duration
    // (an attached arm is its socket's, not keyed)
    const carriers = Object.entries(this.paths).filter(([, x]) => x.locked).map(([p]) => this.carrierSocket(p)?.hand).filter((h): h is 'Left' | 'Right' => h !== undefined)
    const attached = new Set([...this.attachments.flatMap(a => [...Object.values(armOf(a.hand)), ...Object.keys(this.fists[a.hand] ?? {})]), ...carriers.flatMap(h => Object.values(armOf(h)))])
    // (a free hand let go near a prop's shaft snaps onto it there: its arm is the socket's then, not keyed)
    const snap = this.snapTarget(moved)
    if (snap !== null) for (const b of [...Object.values(armOf(snap.hand)), ...Object.keys(this.fists[snap.hand] ?? {})]) attached.add(b)
    // (keyed now, as seen, before anything else can move a bone)
    const next = { ...this.keys }
    const bones = moved.filter(b => !attached.has(b))
    this.keyBones(next, bones, u)
    if (bones.length > 0) this.groups = [...this.groups.filter(g => !(near(g.u, u) && g.bones.some(b => bones.includes(b)))), { u, bones }]
    // (a hand on a socket moved or turned: its socket goes where it is now)
    for (const a of this.attachments) {
      if (!moved.includes(armOf(a.hand).end)) continue
      const carries = this.props.find(p => p.name === a.prop)?.bone === `${a.hand}Hand`
      const sock = this.socketAt(a.hand, a.prop, false, carries)
      if (sock !== null) await this.saveSocket(a.prop, { ...sock, id: a.socket, name: this.props.find(p => p.name === a.prop)?.sockets.find(x => x.id === a.socket)?.name ?? sock.name })
    }
    if (snap !== null) {
      this.fists[snap.hand] ??= await animator.fistOf(snap.hand, GRIP_CLIP).catch(() => ({}))
      const sock = this.socketAt(snap.hand, snap.prop, true)
      if (sock !== null) {
        await this.saveSocket(snap.prop, this.clearOfOthers(snap.hand, snap.prop, sock))
        this.attachments = [...this.attachments.filter(a => a.hand !== snap.hand), { hand: snap.hand, prop: snap.prop, socket: sock.id }]
      }
    }
    this.keys = next
    this.show(t)
  }

  /** A hand on no socket, let go (in `moved`) with its fist near a prop's shaft (not the prop it carries): that hand and
   * prop, the nearest; else null. */
  private snapTarget (moved: string[]): { hand: 'Left' | 'Right', prop: string } | null {
    const view = animator.character
    if (view === null) return null
    let best: { hand: 'Left' | 'Right', prop: string, d: number } | null = null
    for (const hand of ['Left', 'Right'] as const) {
      const bone = view.bones.get(`${hand}Hand`)
      if (!moved.includes(`${hand}Hand`) || bone === undefined || this.attachments.some(a => a.hand === hand)) continue
      for (const p of this.props) {
        if (p.bone === `${hand}Hand`) continue
        const shaft = this.shaftOf(p.name); const grip = this.gripOf(hand, p.name)
        if (shaft === null || grip === null) continue
        const fist = grip.fist.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())).add(bone.getWorldPosition(new THREE.Vector3()))
        const length = shaft.from.distanceTo(shaft.to)
        const k = Math.max(0, Math.min(length, fist.clone().sub(shaft.from).dot(shaft.dir)))
        const d = shaft.from.clone().addScaledVector(shaft.dir, k).distanceTo(fist)
        if (d < SNAP_REACH * view.height && (best === null || d < best.d)) best = { hand, prop: p.name, d }
      }
    }
    return best === null ? null : { hand: best.hand, prop: best.prop }
  }

  /** Key `names` into `next` as they stand on the character, at `u`: the turn from where the clip has them at the time
   * shown (the playhead's, so no motion between it and the frame is baked in); a bone's first key on a clip with motion
   * of its own also pins it at the clip's ends, so the change eases in and back out. */
  private keyBones (next: Record<string, ClipKey[]>, names: Iterable<string>, u: number): void {
    const view = animator.character; const base = this.baseClip
    if (view === null || base === null) return
    const rest = restOf(view)
    const shown = Math.min(Math.max(animator.time, 0), base.duration)
    for (const name of names) {
      const bone = view.bones.get(name); const r = rest(name)
      if (bone === undefined || r === null) continue
      const key = keyFor(base, bone, u, shown, r, name === this.rig.hips)
      const ks = (next[name] ?? []).filter(k => !near(k.u, u))
      if (ks.length === 0 && !this.held) {
        if (!near(u, 0)) ks.push({ u: 0, q: [...IDENTITY] as ClipKey['q'] })
        if (!this.loop && !near(u, 1)) ks.push({ u: 1, q: [...IDENTITY] as ClipKey['q'] })
      }
      next[name] = [...ks, key].sort((a, b) => a.u - b.u)
    }
  }

  /** Take the keys at the playhead off: the selected bone's (and the bones keyed with it by the same drag), the selected
   * prop's, or every one's. */
  deleteHere (): void {
    const u = this.phase()
    const all = this.selected === null && this.prop === null
    const sel = this.selected
    const with_ = new Set(sel === null ? [] : [sel, ...this.groups.filter(g => near(g.u, u) && g.bones.includes(sel)).flatMap(g => g.bones)])
    this.groups = this.groups.filter(g => !(near(g.u, u) && (all || g.bones.some(b => with_.has(b)))))
    const next: Record<string, ClipKey[]> = {}
    for (const [bone, ks] of Object.entries(this.keys)) {
      const keep = all || with_.has(bone) ? ks.filter(k => !near(k.u, u)) : ks
      // (only its pins left: nothing changed on this bone)
      if (keep.length > 0 && (this.held || !keep.every(isAnchor))) next[bone] = keep
    }
    this.keys = next
    const paths: Record<string, PropPath> = {}
    for (const [p, path] of Object.entries(this.paths)) {
      const keep = all || this.prop === p ? path.keys.filter(k => !near(k.u, u)) : path.keys
      paths[p] = { ...path, keys: keep.length > 0 && (this.held || !keep.every(isAnchor)) ? keep : [] }
    }
    this.paths = paths
    // (a prop drag's key gone: its hold too)
    this.holds = this.holds.filter(h => paths[h.prop]?.keys.some(k => near(k.u, h.u)) === true)
    this.show(u * (this.baseClip?.duration ?? 0))
  }

  /** A prop's length (its longest side through its middle) as it stands: from the end nearer the hand carrying it to
   * the far end (a spear's head), in the world. */
  private shaftOf (prop: string): { from: THREE.Vector3, to: THREE.Vector3, dir: THREE.Vector3 } | null {
    const view = animator.character
    const node = view?.root.getObjectByName(propNode(prop))
    const p = this.props.find(x => x.name === prop)
    if (view === null || node === undefined || p === undefined) return null
    node.updateMatrixWorld(true)
    const inv = node.matrixWorld.clone().invert()
    const box = new THREE.Box3()
    node.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true) return
      const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld))
      g.computeBoundingBox(); box.union(g.boundingBox!)
    })
    if (box.isEmpty()) return null
    const size = box.getSize(new THREE.Vector3()); const mid = box.getCenter(new THREE.Vector3())
    const local = size.x >= size.y && size.x >= size.z ? new THREE.Vector3(1, 0, 0) : size.y >= size.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const half = Math.max(size.x, size.y, size.z) / 2
    const a = mid.clone().addScaledVector(local, -half).applyMatrix4(node.matrixWorld)
    const b = mid.clone().addScaledVector(local, half).applyMatrix4(node.matrixWorld)
    const c = view.bones.get(p.bone)?.getWorldPosition(new THREE.Vector3()) ?? mid.clone().applyMatrix4(node.matrixWorld)
    const [from, to] = a.distanceTo(c) < b.distanceTo(c) ? [a, b] : [b, a]
    return { from, to, dir: to.clone().sub(from).normalize() }
  }

  /** A socket for `hand` on `prop` where the hand is now (in the prop's frame). `snap`: its fist put on the prop's length,
   * the hand turned so the shaft runs through the fist (across the palm, thumb towards the far end), its roll kept. */
  private socketAt (hand: 'Left' | 'Right', prop: string, snap: boolean, exact = false): Socket | null {
    const view = animator.character
    const end = view?.bones.get(armOf(hand).end)
    const node = view?.root.getObjectByName(propNode(prop))
    if (view === null || view.rest === null || end === undefined || node === undefined) return null
    let turn = end.getWorldQuaternion(new THREE.Quaternion())
    let wrist = end.getWorldPosition(new THREE.Vector3())
    const shaft = this.shaftOf(prop)
    const grip = this.gripOf(hand, prop)
    // (exact: where the hand is, as it is: the hand carrying the prop holds it there by its placement)
    if (shaft !== null && grip !== null && !exact) {
      // (always on the shaft: a snap turns the hand onto it; a move keeps the turn and slides the fist along it)
      if (snap) turn = new THREE.Quaternion().setFromUnitVectors(grip.axis.clone().applyQuaternion(turn).normalize(), shaft.dir).multiply(turn)
      const fistNow = grip.fist.clone().applyQuaternion(turn).add(wrist)
      const s = Math.max(0, Math.min(shaft.from.distanceTo(shaft.to), fistNow.clone().sub(shaft.from).dot(shaft.dir)))
      const onShaft = shaft.from.clone().addScaledVector(shaft.dir, s)
      if (snap || onShaft.distanceTo(fistNow) < 0.15 * view.height) wrist = onShaft.sub(grip.fist.clone().applyQuaternion(turn))
    }
    node.updateMatrixWorld(true)
    const inv = node.matrixWorld.clone().invert()
    const nq = new THREE.Quaternion(); node.matrixWorld.decompose(new THREE.Vector3(), nq, new THREE.Vector3())
    const r5 = (v: number[]): number[] => v.map(x => Math.round(x * 1e5) / 1e5)
    const count = (this.props.find(p => p.name === prop)?.sockets.length ?? 0) + 1
    return {
      id: Math.random().toString(36).slice(2, 10), name: `${hand} grip ${count}`,
      position: r5(wrist.applyMatrix4(inv).toArray()) as Socket['position'],
      rotation: r5(nq.invert().multiply(turn).toArray()) as Socket['rotation'],
    }
  }

  /** A hand's grip (the line a shaft runs along and the point it holds it at, in the hand's own frame): from its fist
   * closed round a shaft of `prop`'s radius when it has one (fistGrip: the shaft across the middle of the palm), else the
   * rest hand's estimate (handGrip). Kept until the character's fist or the radius changes. */
  private gripOf (hand: 'Left' | 'Right', prop?: string): Grip | null {
    const fingers = this.fists[hand]; const root = this.posable()
    const view = animator.character
    const radius = (prop === undefined ? undefined : this.shaftLocal(prop)?.radius) ?? 0.011 * (view?.height ?? 1)
    if (fingers !== undefined && Object.keys(fingers).length > 0 && root !== null) {
      const held = this.gripCache[hand]
      if (held !== undefined && held.fingers === fingers && held.radius === radius && held.root === root) return held.grip
      const g = fistGrip(root, hand, fingers, radius)
      if (g !== null) { this.gripCache[hand] = { fingers, radius, root, grip: g }; return g }
    }
    const rest = animator.character?.rest
    return rest === null || rest === undefined ? null : handGrip(rest, hand)
  }
  /** A socket put on the shaft for `hand`'s grip: its spot along the shaft and its roll round it kept, its hold point
   * moved onto the shaft's line and its grip line turned along it (the shortest way, so a grip held thumb toward the butt
   * stays so). Null when it is on it already (or the prop has no shaft, the hand no grip). */
  private alignSocket (hand: 'Left' | 'Right', prop: string, sock: Socket): Socket | null {
    const node = animator.character?.root.getObjectByName(propNode(prop))
    const shaft = this.shaftLocal(prop); const grip = this.gripOf(hand, prop)
    if (node === undefined || shaft === null || grip === null) return null
    node.updateMatrixWorld(true)
    // (the socket is in the prop's node frame, its scale included; the grip in world units, in the hand's turn)
    const scale = node.matrixWorld.getMaxScaleOnAxis() || 1
    const q = new THREE.Quaternion(...sock.rotation); const p = new THREE.Vector3(...sock.position)
    const dir = shaft.to.clone().sub(shaft.from).normalize()
    const axis = grip.axis.clone().applyQuaternion(q).normalize()
    const q2 = new THREE.Quaternion().setFromUnitVectors(axis, axis.dot(dir) >= 0 ? dir : dir.clone().negate()).multiply(q).normalize()
    const hold = p.clone().add(grip.fist.clone().applyQuaternion(q).divideScalar(scale))
    const onLine = shaft.from.clone().addScaledVector(dir, hold.clone().sub(shaft.from).dot(dir))
    const p2 = onLine.sub(grip.fist.clone().applyQuaternion(q2).divideScalar(scale))
    if (p2.distanceTo(p) * scale < 0.001 && q2.angleTo(q) < THREE.MathUtils.degToRad(0.5)) return null
    const r5 = (v: number[]): number[] => v.map(x => Math.round(x * 1e5) / 1e5)
    return { ...sock, position: r5(p2.toArray()) as Socket['position'], rotation: r5(q2.toArray()) as Socket['rotation'] }
  }

  private gripCache: Partial<Record<'Left' | 'Right', { fingers: Record<string, [number, number, number, number]>, radius: number, root: THREE.Object3D, grip: Grip }>> = {}

  /** The hand put on the prop where it is: its fist squarely round the shaft (the shaft through the closed fingers, square
   * to the palm) at the spot on the shaft nearest it, turned the least way onto it, and slid along just clear of any other
   * hand on the prop; saved as the hand's socket on the prop (the one it has, or a new one) and the hand put on it; then
   * the prop fitted again if it leads. */
  async grip (hand: 'Left' | 'Right', prop: string): Promise<void> {
    if (this.busy !== null) return
    this.fists[hand] ??= await animator.fistOf(hand, GRIP_CLIP).catch(() => ({}))
    const snapped = this.socketAt(hand, prop, true)
    if (snapped === null) { app.toast('error', `No ${hand.toLowerCase()} hand, or the prop isn't on stage`); return }
    const had = this.attachments.find(a => a.hand === hand && a.prop === prop)?.socket
    const name = (had === undefined ? undefined : this.props.find(x => x.name === prop)?.sockets.find(x => x.id === had)?.name) ?? snapped.name
    const id = had ?? snapped.id
    await this.saveSocket(prop, this.clearOfOthers(hand, prop, { ...snapped, id, name }))
    this.attachments = [...this.attachments.filter(a => a.hand !== hand), { hand, prop, socket: id }]
    if (this.paths[prop]?.locked === true && this.natural) await this.fitPath(prop); else this.show(animator.time)
  }

  /** `sock` (for `hand` on `prop`) slid along the shaft, its turn kept, until its fist is a fist's width at least from every
   * other hand's on the prop (the one carrying it, any on a socket): to whichever side is nearer and still on the shaft. */
  private clearOfOthers (hand: 'Left' | 'Right', prop: string, sock: Socket): Socket {
    const view = animator.character; const node = view?.root.getObjectByName(propNode(prop))
    const shaft = this.shaftLocal(prop); const grip = this.gripOf(hand, prop)
    if (view === null || view.rest === null || node === undefined || shaft === null || grip === null) return sock
    node.updateMatrixWorld(true)
    // (in the prop's node frame, its scale included; a grip's fist is in world units, in the hand's turn)
    const scale = node.matrixWorld.getMaxScaleOnAxis() || 1
    const dir = shaft.to.clone().sub(shaft.from); const length = dir.length(); dir.normalize()
    const along = (x: Socket, g: { fist: THREE.Vector3 }): number => new THREE.Vector3(...x.position).add(g.fist.clone().applyQuaternion(new THREE.Quaternion(...x.rotation)).divideScalar(scale)).sub(shaft.from).dot(dir)
    const p = this.props.find(x => x.name === prop)
    const rest = view.rest
    const others: number[] = []
    const carrier = this.carrierSocket(prop)
    if (carrier !== null && carrier.hand !== hand) others.push(along(carrier.socket, this.gripOf(carrier.hand, prop) ?? handGrip(rest, carrier.hand) ?? { fist: new THREE.Vector3() }))
    for (const a of this.attachments) {
      if (a.prop !== prop || a.hand === hand || a.socket === carrier?.socket.id) continue
      const o = p?.sockets.find(x => x.id === a.socket)
      if (o !== undefined) others.push(along(o, this.gripOf(a.hand, prop) ?? handGrip(rest, a.hand) ?? { fist: new THREE.Vector3() }))
    }
    // (how far apart two fists must be along the shaft: half of each hand's width (its solid's, fitted to the mesh), and a little)
    const widthOf = (h: 'Left' | 'Right'): number => {
      const seg = solidsOf(view)?.shape.segments.find(x => x.name === `${h}Hand`)
      return seg === undefined ? FIT.fist * view.height : 2 * Math.max(seg.r1, seg.r2)
    }
    const others0 = [...(carrier !== null && carrier.hand !== hand ? [carrier.hand] : []), ...this.attachments.filter(a => a.prop === prop && a.hand !== hand && a.socket !== carrier?.socket.id).map(a => a.hand)]
    const fist = (Math.max(...others0.map(h => (widthOf(hand) + widthOf(h)) / 2), FIT.fist * view.height) + HAND_GAP * view.height) / scale
    const was = along(sock, grip)
    let at = was
    for (let round = 0; round < 3; round++) {
      for (const o of others) {
        if (Math.abs(at - o) >= fist) continue
        const before = o - fist; const after = o + fist
        at = (Math.abs(at - before) <= Math.abs(at - after) && before >= 0) || after > length ? before : after
      }
    }
    if (Math.abs(at - was) < 1e-6) return sock
    const r5 = (v: number[]): number[] => v.map(x => Math.round(x * 1e5) / 1e5)
    return { ...sock, position: r5(new THREE.Vector3(...sock.position).addScaledVector(dir, at - was).toArray()) as Socket['position'] }
  }

  /** Save a socket on its prop's garment (added, or the same id replaced). */
  private async saveSocket (prop: string, socket: Socket): Promise<void> {
    const c = app.selected
    if (c === null) return
    const garments = (c.garments ?? []).map(g => g.name !== prop ? g : { ...g, sockets: [...(g.sockets ?? []).filter(x => x.id !== socket.id), socket] })
    await app.update(c.id, { garments })
  }

  /** A new socket on the prop selected for `hand`, where the hand is now (its fist snapped on the shaft), the hand put on it. */
  async addSocket (hand: 'Left' | 'Right'): Promise<void> {
    const prop = this.prop
    if (prop === null) return
    // (its fist first: the socket is made with the shaft through the closed fingers)
    this.fists[hand] ??= await animator.fistOf(hand, GRIP_CLIP).catch(() => ({}))
    const sock = this.socketAt(hand, prop, true)
    if (sock === null) { app.toast('error', `No ${hand.toLowerCase()} hand, or the prop isn't on stage`); return }
    await this.saveSocket(prop, sock)
    await this.attach(hand, prop, sock.id)
  }

  async removeSocket (prop: string, id: string): Promise<void> {
    const c = app.selected
    if (c === null) return
    this.attachments = this.attachments.filter(a => !(a.prop === prop && a.socket === id))
    await app.update(c.id, { garments: (c.garments ?? []).map(g => g.name !== prop ? g : { ...g, sockets: (g.sockets ?? []).filter(x => x.id !== id) }) })
    this.show(animator.time)
  }

  /** Put `hand` on a socket (its fingers closed round the prop); one socket a hand. The socket is put on the shaft for the
   * hand's grip (its spot and roll kept) and slid just clear of any other hand on the prop; then, if the prop leads, the
   * prop is fitted again (fitPath). `place: false` puts the hand on the socket as it is. */
  async attach (hand: 'Left' | 'Right', prop: string, socket: string, opts: { place?: boolean } = {}): Promise<void> {
    this.fists[hand] ??= await animator.fistOf(hand, GRIP_CLIP).catch(() => ({}))
    // (a socket made for another grip (an older one: the shaft at the front of the knuckles) put back on the shaft for this one, its spot and roll kept)
    const p = this.props.find(x => x.name === prop); const sock = p?.sockets.find(x => x.id === socket)
    this.attachments = [...this.attachments.filter(a => a.hand !== hand), { hand, prop, socket }]
    if (opts.place !== false && sock !== undefined && p?.bone !== `${hand}Hand`) {
      const onShaft = this.alignSocket(hand, prop, sock) ?? sock
      const clear = this.clearOfOthers(hand, prop, onShaft)
      if (clear !== sock) await this.saveSocket(prop, clear)
    }
    if (this.paths[prop]?.locked === true && this.natural) { await this.fitPath(prop); return }
    this.show(animator.time)
  }

  detach (hand: 'Left' | 'Right'): void {
    this.attachments = this.attachments.filter(a => a.hand !== hand)
    this.show(animator.time)
  }

  /** Lock a prop (it leads: the hands on it follow its path, the body the hands), or let it ride its hand again. Locking
   * puts the hand carrying it on a socket where it holds it now, if it has none. Switched on, the prop is fitted to the body
   * once over the whole clip (fitPath: it moves, as little as it needs, to where the body holds it with room to spare). */
  async setLocked (prop: string, on: boolean): Promise<void> {
    if (this.props.find(x => x.name === prop) === undefined) return
    this.paths = { ...this.paths, [prop]: { locked: on, keys: this.paths[prop]?.keys ?? [] } }
    if (on && this.natural) { await this.fitPath(prop); return }
    this.show(animator.time)
  }

  /** The prop's long axis in its own node's frame (its ends: the one by the carrying hand first), and its radius. */
  private shaftLocal (prop: string): { from: THREE.Vector3, to: THREE.Vector3, radius: number } | null {
    const view = animator.character
    const node = view?.root.getObjectByName(propNode(prop))
    const shaft = this.shaftOf(prop)
    if (view === null || node === undefined || shaft === null) return null
    const inv = node.matrixWorld.clone().invert()
    return { from: shaft.from.clone().applyMatrix4(inv), to: shaft.to.clone().applyMatrix4(inv), radius: 0.011 * view.height }
  }

  /** What the fit and the grip placement read: the edit as it stands with `prop` leading (its carrier on a socket). */
  private fitInput (prop: string): Parameters<typeof fitProp>[0] | null {
    const view = animator.character; const base = this.baseClip; const root = this.posable()
    if (view === null || base === null || root === null || this.base === null || !this.natural) return null
    const bones = new Map<string, THREE.Bone>()
    root.traverse(o => { if ((o as THREE.Bone).isBone === true) bones.set(o.name, o as THREE.Bone) })
    let collider
    try { collider = bodyColliderFor(root, bones) } catch { collider = null }
    return {
      base, keys: this.keys, loop: this.loop, rest: restOf(view), posable: root, rig: this.rig, limits: this.limitsOn ? this.limits : null,
      props: this.propRig({ ...this.paths, [prop]: { locked: true, keys: this.paths[prop]?.keys ?? [] } }), prop, height: view.height, solver: this.solver,
      collider, shaft: this.shaftLocal(prop),
    }
  }

  /** The range limiter: one pass over the whole clip that moves the prop (a smooth offset on its path, as little as it needs,
   * its motion kept) to where every hand on it holds it within the joints' ranges, naturally, with the body clear of itself
   * and the prop, and room to spare in the arms: the spear held farther out, say. Writes the prop's path keys (locked: the
   * user can edit them after, a drag let go is the authority). */
  async fitPath (prop: string): Promise<FitResult | null> {
    if (this.props.find(x => x.name === prop) === undefined) return null
    this.paths = { ...this.paths, [prop]: { locked: true, keys: this.paths[prop]?.keys ?? [] } }
    this.busy = 'Fitting the prop to the body'
    await new Promise(r => setTimeout(r, 30))
    let result: FitResult | null = null
    try {
      const input = this.fitInput(prop)
      if (input !== null) {
        result = await fitProp(input, label => { this.busy = label })
        this.paths = { ...this.paths, [prop]: { locked: true, keys: result.keys } }
      }
    } catch (error) {
      app.toast('error', `The prop fit failed: ${(error as Error).message}`)
    } finally {
      this.busy = null
    }
    this.show(animator.time)
    if (result !== null) app.toast('ok', `Fitted ${prop}: moved up to ${(result.maxMove * 100).toFixed(1)} cm on ${result.moved} frames, ${result.keys.length} keys, ${(result.ms / 1000).toFixed(1)} s`)
    return result
  }

  /** The hand carrying a prop: where it holds it, in the prop's frame (from how the prop is placed on it: the Outfit
   * step's placement, so never stale), as a socket. */
  private carrierSocket (prop: string): { hand: 'Left' | 'Right', socket: Socket } | null {
    const view = animator.character
    const p = this.props.find(x => x.name === prop)
    const side = p === undefined ? undefined : /^(Left|Right)Hand$/.exec(p.bone)?.[1] as 'Left' | 'Right' | undefined
    const hand = side === undefined ? undefined : view?.bones.get(`${side}Hand`)
    const node = view?.root.getObjectByName(propNode(prop))
    if (side === undefined || hand === undefined || node === undefined) return null
    node.updateMatrixWorld(true)
    const m = node.matrixWorld.clone().invert().multiply(hand.matrixWorld)
    const at = new THREE.Vector3(); const q = new THREE.Quaternion(); m.decompose(at, q, new THREE.Vector3())
    return { hand: side, socket: { id: `carrier:${prop}`, name: `${side} hand (carries it)`, position: at.toArray() as Socket['position'], rotation: q.toArray() as Socket['rotation'] } }
  }

  /** Where `prop` rode at time `t` in the clip as it was (before the edit). */
  private rodeAt (prop: string, t: number): THREE.Matrix4 | null {
    const root = this.posable(); const base = this.baseClip
    if (root === null || base === null) return null
    const node = root.getObjectByName(propNode(prop))
    if (node === undefined) return null
    const mixer = new THREE.AnimationMixer(root)
    const action = mixer.clipAction(base)
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true
    action.play()
    mixer.setTime(Math.min(t, base.duration))
    root.updateMatrixWorld(true)
    const m = node.matrixWorld.clone()
    mixer.stopAllAction(); mixer.uncacheRoot(root)
    return m
  }

  /** A prop moved or turned by the gizmo, let go at `place` (world): a key on its path at the playhead (and it leads). */
  private commitProp (prop: string, place: THREE.Matrix4): void {
    if (this.propMoves === 'every') { this.offsetProp(prop, place); return }
    const base = this.baseClip
    if (base === null) return
    const u = this.phase(); const t = u * base.duration
    const was = this.rodeAt(prop, t)
    if (was === null) return
    const a = new THREE.Vector3(); const qa = new THREE.Quaternion(); const b = new THREE.Vector3(); const qb = new THREE.Quaternion(); const sc = new THREE.Vector3()
    was.decompose(a, qa, sc); place.decompose(b, qb, sc)
    const key: ClipKey = { u, q: qb.multiply(qa.invert()).normalize().toArray().map(v => Math.round(v * 1e6) / 1e6) as ClipKey['q'], p: b.sub(a).toArray().map(v => Math.round(v * 1e5) / 1e5) as ClipKey['p'] }
    let ks = (this.paths[prop]?.keys ?? []).filter(k => !near(k.u, u))
    if (ks.length === 0 && !this.held) {
      if (!near(u, 0)) ks.push({ u: 0, q: [...IDENTITY] as ClipKey['q'], p: [0, 0, 0] })
      if (!this.loop && !near(u, 1)) ks.push({ u: 1, q: [...IDENTITY] as ClipKey['q'], p: [0, 0, 0] })
    }
    ks = [...ks, key].sort((x, y) => x.u - y.u)
    const before = this.paths[prop]
    const after: PropPath = { locked: true, keys: ks }
    // (the body's root held where it was seen, on the frames the drag moved the prop: moving it away doesn't bring the body in)
    this.holdRoot(prop, u, before, after)
    // (moving a prop makes it lead)
    this.paths = { ...this.paths, [prop]: after }
    this.show(t)
  }

  /** A prop moved or turned by its gizmo with "every frame" on, let go at `place`: its whole path moved and turned by
   * that, on every frame (about the prop's own place there), and it leads. */
  private offsetProp (prop: string, place: THREE.Matrix4): void {
    const base = this.baseClip
    if (base === null) return
    const u = this.phase(); const t = u * base.duration
    const was = this.rodeAt(prop, t)
    if (was === null) return
    const path = this.paths[prop] ?? { locked: true, keys: [] }
    const now = onPath(was, path, u, this.loop)
    const a = new THREE.Vector3(); const qa = new THREE.Quaternion(); const b = new THREE.Vector3(); const qb = new THREE.Quaternion(); const sc = new THREE.Vector3()
    now.decompose(a, qa, sc); place.decompose(b, qb, sc)
    const dp = b.sub(a); const dq = qb.multiply(qa.invert()).normalize()
    // (no path yet: one key, which a path holds on every frame)
    const ks: ClipKey[] = path.keys.length > 0 ? path.keys : [{ u: 0, q: [...IDENTITY] as ClipKey['q'], p: [0, 0, 0] }]
    const moved = ks.map(k => ({
      ...k,
      q: dq.clone().multiply(new THREE.Quaternion(...k.q)).normalize().toArray().map(v => Math.round(v * 1e6) / 1e6) as ClipKey['q'],
      p: new THREE.Vector3(...(k.p ?? [0, 0, 0])).add(dp).toArray().map(v => Math.round(v * 1e5) / 1e5) as ClipKey['p'],
    }))
    this.paths = { ...this.paths, [prop]: { locked: true, keys: moved } }
    this.show(t)
  }

  /** A prop drag let go at `u` (its path `before` and `after`): on each frame the drag moved the prop, how much of it the
   * frame carries, and the solve's correction to the body's root there as it was (before the drag) — the build holds the
   * root to it softly (src/engine/clipedit.ts RootHold). A second drag of the same key keeps the first's correction. */
  private holdRoot (prop: string, u: number, before: PropPath | undefined, after: PropPath): void {
    const view = animator.character; const base = this.baseClip; const root = this.posable(); const edited = this.edited
    const shaft = this.shaftLocal(prop)
    if (view === null || base === null || root === null || edited === null || shaft === null) return
    const rode = nodePath(base, root, propNode(prop))
    const times = frameTimes(base.duration)
    if (rode.length !== times.length) return
    const ends = [shaft.from, shaft.to]
    const moveAt = (i: number): number => {
      const ui = base.duration > 0 ? times[i] / base.duration : 0
      const a = onPath(rode[i], before ?? { locked: true, keys: [] }, ui, this.loop); const b = onPath(rode[i], after, ui, this.loop)
      return Math.max(...ends.map(e => e.clone().applyMatrix4(a).distanceTo(e.clone().applyMatrix4(b))))
    }
    const at = Math.round(u * (times.length - 1))
    const full = moveAt(at)
    if (!(full > 1e-3)) return
    const had = this.holds.find(h => h.prop === prop && near(h.u, u))
    const keyed = rootPath(applyBoneKeys(base, this.keys, this.loop, restOf(view)), root, this.rig.hips)
    const solved = rootPath(edited, root, this.rig.hips)
    const frames: RootHold['frames'] = {}
    for (let i = 0; i < times.length; i++) {
      const w = Math.min(1, moveAt(i) / full)
      const was = had?.frames[i]
      if (was !== undefined) { frames[i] = { ...was, w: Math.max(was.w, w) }; continue }
      if (w < 0.05 || keyed[i] === undefined || solved[i] === undefined) continue
      const r5 = (v: number[]): number[] => v.map(x => Math.round(x * 1e6) / 1e6)
      frames[i] = {
        w: Math.round(w * 1000) / 1000,
        hips: r5(solved[i].hips.clone().sub(keyed[i].hips).toArray()) as [number, number, number],
        chest: r5(solved[i].chest.clone().multiply(keyed[i].chest.clone().invert()).normalize().toArray()) as [number, number, number, number],
      }
    }
    this.holds = [...this.holds.filter(h => h !== had), { prop, u, frames }]
  }

  /** While a prop is dragged: the hands on it follow it (the hand carrying it first, so the prop goes where it's dragged). */
  private propLive (prop: string, place: THREE.Matrix4): void {
    const view = animator.character
    if (view === null) return
    const nameOf = (b: THREE.Bone): string => b.name
    const limits = this.limitsOn ? this.limits ?? undefined : undefined
    const p = this.props.find(x => x.name === prop)
    const side = p === undefined ? undefined : /^(Left|Right)Hand$/.exec(p.bone)?.[1] as 'Left' | 'Right' | undefined
    const node = view.root.getObjectByName(propNode(prop))
    if (node === undefined) return
    // the carrying hand moved so that the prop lands on `place` (it rides the hand rigidly)
    if (side !== undefined) {
      const hand = view.bones.get(`${side}Hand`); const upper = view.bones.get(`${side}Arm`); const lower = view.bones.get(`${side}ForeArm`)
      if (hand !== undefined && upper !== undefined && lower !== undefined) {
        node.updateMatrixWorld(true)
        const rel = hand.matrixWorld.clone().invert().multiply(node.matrixWorld)
        const want = place.clone().multiply(rel.invert())
        const at = new THREE.Vector3(); const q = new THREE.Quaternion(); want.decompose(at, q, new THREE.Vector3())
        reach({ upper, lower, end: hand }, at, { limits, nameOf, keepEnd: false })
        setWorldQuaternion(hand, q)
      }
    }
    this.handsLive(side === undefined ? null : `${side}Hand`)
  }

  /** The hands on sockets put back on their props, as the body stands (while a joint or a prop is dragged): but the one
   * being moved. */
  private handsLive (moving: string | null): void {
    const view = animator.character
    if (view === null) return
    const nameOf = (b: THREE.Bone): string => b.name
    const limits = this.limitsOn ? this.limits ?? undefined : undefined
    for (const a of this.attachments) {
      if (armOf(a.hand).end === moving) continue
      const node = view.root.getObjectByName(propNode(a.prop))
      const sock = this.props.find(p => p.name === a.prop)?.sockets.find(x => x.id === a.socket)
      const upper = view.bones.get(`${a.hand}Arm`); const lower = view.bones.get(`${a.hand}ForeArm`); const end = view.bones.get(`${a.hand}Hand`)
      if (node === undefined || sock === undefined || upper === undefined || lower === undefined || end === undefined) continue
      node.updateMatrixWorld(true)
      const goal = handOn(node.matrixWorld, sock)
      reach({ upper, lower, end }, goal.at, { limits, nameOf, keepEnd: false })
      setWorldQuaternion(end, goal.turn)
      for (const [n, q] of Object.entries(this.fists[a.hand] ?? {})) { const b = view.bones.get(n); if (b !== undefined) { b.quaternion.set(...q); b.updateMatrixWorld(true) } }
    }
  }

  /** What the props do in the edit (for the clip's build). */
  private propRig (paths: Record<string, PropPath> = this.paths): PropRig {
    const sockets: Record<string, Socket[]> = Object.fromEntries(this.props.map(p => [p.name, [...p.sockets]]))
    const attachments = [...this.attachments]
    // (a prop that leads: the hand carrying it holds it where its placement has it, unless that hand is on a socket)
    for (const [prop, path] of Object.entries(paths)) {
      if (!path.locked) continue
      const c = this.carrierSocket(prop)
      if (c === null || attachments.some(a => a.hand === c.hand)) continue
      sockets[prop] = [...(sockets[prop] ?? []), c.socket]
      attachments.push({ hand: c.hand, prop, socket: c.socket.id })
    }
    // (each leading prop's shaft: the body is kept clear of it, but where the hands hold it)
    const shafts: NonNullable<PropRig['shafts']> = {}
    for (const [prop, path] of Object.entries(paths)) {
      const shaft = path.locked ? this.shaftLocal(prop) : null
      if (shaft !== null) shafts[prop] = { from: shaft.from.toArray() as [number, number, number], to: shaft.to.toArray() as [number, number, number], radius: shaft.radius }
    }
    // (where each hand on a socket holds the shaft: the carrying hand has none, its turn is held exactly)
    const grips: NonNullable<PropRig['grips']> = {}
    for (const a of attachments) {
      if (a.socket.startsWith('carrier:')) continue
      const grip = this.gripOf(a.hand, a.prop)
      if (grip !== null) grips[a.hand] = grip
    }
    return { node: propNode, paths, attachments, sockets, carriers: Object.fromEntries(this.props.map(p => [p.name, p.bone])), fingers: this.fists, shafts, grips, holds: this.holds }
  }

  /** Clear every key. */
  clear (): void { this.keys = {}; this.show(animator.time) }

  /** Naturalize the edit: every frame moved toward the most natural pose the library knows (src/engine/posespace.ts),
   * smooth through time, the feet free to pivot or slide (never under the floor), the hands kept on their sockets and
   * every keyed bone pulled to where the edit has it. Shown and saved until the next change. */
  /** Naturalize the edit: every frame edged toward how people's bodies move (the part of each pose people don't make
   * pulled out, the whole a little toward the library's poses) and the motion smoothed (jerks pulled to the middle of
   * their neighbours), the hands kept on their props, keyed bones held near their keys. Each press goes a little further. */
  async naturalize (amount: { pull: number, outside: number, motion: number } = NATURALIZE): Promise<void> {
    const view = animator.character; const root = this.posable()
    if (view === null || view.rest === null || root === null || this.model === null || this.edited === null) { app.toast('error', 'Naturalize works on a person (the library\'s pose model)'); return }
    this.busy = 'Naturalizing every frame'
    await new Promise(r => setTimeout(r, 30))
    try {
      const bones = new Map<string, THREE.Bone>()
      root.traverse(o => { if ((o as THREE.Bone).isBone === true) bones.set(o.name, o as THREE.Bone) })
      const rig = new NaturalRig(this.model, bones, { offsets: this.offsets, limits: this.limitsOn ? this.limits : null, nameOf: b => b.name })
      // (the hands on props: on a socket, or carrying a prop that leads; the prop rides the hand carrying it, so it is held too)
      const rigP = this.propRig()
      const holds = rigP.attachments
      const attachedHands = [...new Set(holds.map(a => `${a.hand}Hand`))]
      const held = new Set(holds.flatMap(a => Object.values(armOf(a.hand))))
      const keyed = Object.keys(this.keys).filter(b => !held.has(b) && bones.has(b))
      // (a keyed bone is pulled to where the edit has it at its keys, fading out over PULL_FRAMES frames: between keys the pass is free)
      const duration = this.edited.duration
      const pullAt = (t: number): Map<number, string[]> => {
        const byWeight = new Map<number, string[]>()
        for (const b of keyed) {
          // (the pins at the clip's ends are not edits: only what the user moved is pulled)
          const ks = this.keys[b].filter(k => !isAnchor(k))
          if (ks.length === 0) continue
          const d = Math.min(...ks.map(k => Math.abs(t - k.u * duration) * KEY_FPS))
          const w = Math.round(PULL_WEIGHT * Math.max(0, 1 - d / PULL_FRAMES) * 100) / 100
          if (w > 0) byWeight.set(w, [...(byWeight.get(w) ?? []), b])
        }
        return byWeight
      }
      // (the body's root where the edit has it (held there by the build) on the frames a prop drag moved the prop, as much)
      const rootHeld = (i: number): NaturalGoal[] => {
        const h = holdAt(rigP.holds, rigP.paths, i)
        if (h === null) return []
        const weight = ROOT_HOLD.weight * Math.min(1, h.w)
        return [...poseTargets(rig, [this.rig.hips], { weight, turn: false }), ...poseTargets(rig, [ROOT_HOLD.chest], { weight, position: false })]
      }
      const rest = view.rest
      const soles: Record<string, number> = {}
      for (const side of ['Left', 'Right']) for (const n of ['Foot', 'ToeBase', 'Toe_End']) { const b = rest.bones.get(`${side}${n}`); if (b !== undefined) soles[`${side}${n}`] = b.worldPosition.y }
      const t0 = performance.now()
      const out = naturalizeClip(rig, this.edited, {
        root, fps: KEY_FPS,
        goals: (i, t) => [
          // the body's root held where it was seen when a prop was let go, on the frames the drag moved it
          ...rootHeld(i),
          // the hands where the edit put them (on their sockets): met exactly
          ...attachedHands.map(n => { const b = bones.get(n)!; return { bone: n, position: b.getWorldPosition(new THREE.Vector3()), turn: b.getWorldQuaternion(new THREE.Quaternion()), exact: true } as NaturalGoal }),
          // the keyed bones near their keys pulled to where the edit has them
          ...[...pullAt(t)].flatMap(([w, names]) => poseTargets(rig, names, { weight: w })),
        ],
        feet: ['LeftFoot', 'RightFoot'].filter(n => bones.has(n)),
        floor: { y: 0, soles },
        hipsMove: true,
        collide: solidsOf(view),
        pull: amount.pull, pullOutside: amount.outside, smoothMotion: amount.motion, sweeps: 3,
        // (the leading props' shafts where the edit has them on each frame: the body kept clear of them but where the hands hold them)
        obstacles: () => propObstacles(rigP, prop => root.getObjectByName(propNode(prop))?.matrixWorld.clone() ?? null, GRIP_CLEAR * view.height),
      })
      this.edited = out.clip
      this.naturalized = true
      const worst = Math.max(0, ...out.misses)
      animator.showClip(this.edited, { ...this.base!, name: `${this.base!.name} (naturalized)` }, animator.time)
      app.toast('ok', `Naturalized ${out.times.length} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s${attachedHands.length > 0 ? `; hands off their sockets by ${(worst * 100).toFixed(1)} cm at worst` : ''}`)
    } catch (error) {
      app.toast('error', `Naturalize failed: ${(error as Error).message}`)
    } finally {
      this.busy = null
    }
  }

  /** The copy of the character the clip is built on, with every prop on stage (copied again when one is missing: a
   * prop loaded after it was made). */
  private posable (): THREE.Object3D | null {
    let root = animator.posableCopy()
    if (root !== null && this.props.some(p => root!.getObjectByName(propNode(p.name)) === undefined && animator.character?.root.getObjectByName(propNode(p.name)) !== undefined)) root = animator.posableCopy(true)
    return root
  }

  /** The edited clip, built again and shown at `time`. */
  private show (time: number): void {
    this.naturalized = false
    const view = animator.character; const base = this.baseClip; const root = this.posable()
    if (view === null || base === null || root === null || this.base === null) return
    this.edited = buildEdit(base, this.keys, this.loop, restOf(view), root, this.rig, 0, this.limitsOn ? this.limits : null, this.propRig(), view.height, this.solver)
    animator.showClip(this.edited, { ...this.base, name: this.held ? 'New clip (editing)' : `${this.base.name} (editing)` }, time)
    // (a hand just put on a prop, or let go of one: its gizmo locks to the prop, or is free again)
    this.editor?.setGripLock(b => this.gripHold(b))
  }

  /** Save the edited clip into the library as a new one: a person's (a library clip) through the library's build, a
   * creature's (its template's skeleton) as a clip file beside its bundled ones. */
  async save (name: string): Promise<void> {
    const view = animator.character; const root = this.posable(); const base = this.base; const source = this.source
    if (view === null || view.rest === null || root === null || base === null || source === null || this.edited === null) return
    this.busy = 'Saving the clip into the library'
    try {
      const frames = unretarget(this.edited, root, view.rest, source.rest, source.clip, this.lift)
      if (base.url.startsWith('/files/library/clips/')) {
        const r = await fetch('/api/library/edits', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, base: base.clipId, loop: base.loop, keys: this.keys, props: { paths: this.paths, attachments: this.attachments }, frames, characterId: app.selected?.id }),
        })
        const body = await r.json() as { id?: string, error?: string, job?: string }
        if (!r.ok || body.id === undefined) throw new Error(body.error ?? `HTTP ${r.status}`)
        this.busy = `Writing ${name} into the library`
        const done = await waitForJob(body.job ?? '')
        if (done !== null) throw new Error(done)
        app.toast('ok', `${name} is in the library (${body.id}): under Custom`)
      } else {
        const src = await loadSource(base.url)
        const glb = await clipGlb(src.root, source.rest, framesClip(frames, source.rest, name))
        const rig = app.selected?.template ?? 'human'
        const q = new URLSearchParams({ rig, name, base: base.clipId, loop: base.loop ? '1' : '0', inPlace: base.inPlace ? '1' : '0', duration: String(this.edited.duration) })
        const r = await fetch(`/api/library/creature-clips?${q.toString()}`, { method: 'POST', body: glb })
        const body = await r.json() as { id?: string, error?: string }
        if (!r.ok || body.id === undefined) throw new Error(body.error ?? `HTTP ${r.status}`)
        app.toast('ok', `${name} is in the ${rig}'s library (${body.id}): under Custom`)
      }
      library.reload()
    } catch (error) {
      app.toast('error', `The clip didn't save: ${(error as Error).message}`)
    } finally {
      this.busy = null
    }
  }
}

/** Wait for a job to finish: null when it did, else why it failed. */
async function waitForJob (id: string): Promise<string | null> {
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const jobs = await fetch('/api/jobs').then(async r => await r.json() as Array<{ id: string, status: string, message?: string, error?: string }>).catch(() => [])
    const job = jobs.find(j => j.id === id)
    if (job === undefined) continue
    if (job.status === 'done') return null
    if (job.status === 'failed' || job.status === 'error') return job.error ?? job.message ?? 'failed'
  }
  return 'it took too long (still running?)'
}

export const clipEdit = new ClipEdit()
