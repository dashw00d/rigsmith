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
import { animator, restOf, type NowPlaying } from './animator.svelte.ts'
import { loadSource } from '../engine/clips.ts'
import { armOf, buildEdit, fistGrip, GRIP_CLEAR, handGrip, handOn, keyFor, legsOf, propObstacles, unretarget, type Attachment, type PropPath, type PropRig, type Socket } from '../engine/clipedit.ts'
import { propNode } from './tune.svelte.ts'
import { clipGlb, framesClip } from '../engine/clipexport.ts'
import { library } from './library.svelte.ts'
import { KEY_FPS } from '../engine/keys.ts'
import { JointLimits, type Rom } from '../engine/limits.ts'
import { HORSE_RIG, HUMAN_RIG, PoseEditor, type PoseRig } from '../engine/PoseEditor.ts'
import { retargetOffsets, type RestSkeleton } from '../engine/retarget.ts'
import { reach, setWorldQuaternion } from '../engine/ik.ts'
import { bodyBones, solveBody } from '../engine/bodysolve.ts'
import { bodyColliderFor, solidsOf } from '../engine/bodycollide.ts'
import { bodyBonesNatural, createBodySolver, loadPoseModel, naturalizeClip, NaturalRig, poseTargets, type NaturalGoal, type PoseModel, type PoseModelData } from '../engine/posespace.ts'
import { fitProp, placeGrip, type FitResult, type GripResult } from '../engine/propfit.ts'

const IDENTITY: ClipKey['q'] = [0, 0, 0, 1]
/** Naturalize: how hard a keyed bone is pulled to the edit at its key, and over how many frames that fades out. */
const PULL_WEIGHT = 4
const PULL_FRAMES = 3
/** Naturalize, each press: the pull toward the library's poses (per whitened unit squared: the whole, and the part of a
 * pose outside what people do together), and the pull of each pose to the middle of its neighbours' (per radian squared). */
const NATURALIZE = { pull: 0.05, outside: 0.5, motion: 15 }
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
  /** Each prop's path: locked (it leads), and its keys. */
  paths = $state.raw<Record<string, PropPath>>({})
  /** The hands on sockets. */
  attachments = $state.raw<Attachment[]>([])
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
  }

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

  /** The playhead as a phase of the clip, snapped to a frame. */
  phase (): number {
    const d = this.baseClip?.duration ?? 0
    if (d <= 0) return 0
    const frames = Math.max(1, Math.round(d * KEY_FPS))
    return Math.round(Math.min(1, Math.max(0, animator.time / d)) * frames) / frames
  }

  /** Key the bones a drag moved, at the playhead; while the body is solved round hands on props, every bone the solve
   * moves too, as it stands (what was seen when it was let go is the authority at this frame: the solve starts there). */
  private async commit (moved: string[]): Promise<void> {
    const view = animator.character; const base = this.baseClip
    if (view === null || base === null || moved.length === 0) { animator.holding = false; return }
    const u = this.phase()
    const t = u * base.duration
    // (an attached arm alone is its socket's, not keyed; with the body solved, it is keyed as seen with the rest)
    const carriers = Object.entries(this.paths).filter(([, x]) => x.locked).map(([p]) => this.carrierSocket(p)?.hand).filter((h): h is 'Left' | 'Right' => h !== undefined)
    const attached = new Set([...this.attachments.flatMap(a => [...Object.values(armOf(a.hand)), ...Object.keys(this.fists[a.hand] ?? {})]), ...carriers.flatMap(h => Object.values(armOf(h)))])
    // (keyed now, as seen, before anything else can move a bone)
    const next = { ...this.keys }
    this.keyBones(next, new Set([...moved.filter(b => !attached.has(b)), ...this.seenBones()]), u, t)
    // (a hand on a socket moved or turned: its socket goes where it is now)
    for (const a of this.attachments) {
      if (!moved.includes(armOf(a.hand).end)) continue
      const carries = this.props.find(p => p.name === a.prop)?.bone === `${a.hand}Hand`
      const sock = this.socketAt(a.hand, a.prop, false, carries)
      if (sock !== null) await this.saveSocket(a.prop, { ...sock, id: a.socket, name: this.props.find(p => p.name === a.prop)?.sockets.find(x => x.id === a.socket)?.name ?? sock.name })
    }
    this.keys = next
    this.show(t)
  }

  /** Key `names` into `next` as they stand on the character, at `u` (time `t`): a bone's first key on a clip with motion
   * of its own also pins it at the clip's ends, so the change eases in and back out. */
  private keyBones (next: Record<string, ClipKey[]>, names: Iterable<string>, u: number, t: number): void {
    const view = animator.character; const base = this.baseClip
    if (view === null || base === null) return
    const rest = restOf(view)
    for (const name of names) {
      const bone = view.bones.get(name); const r = rest(name)
      if (bone === undefined || r === null) continue
      const key = keyFor(base, bone, u, t, r, name === this.rig.hips)
      const ks = (next[name] ?? []).filter(k => !near(k.u, u))
      if (ks.length === 0 && !this.held) {
        if (!near(u, 0)) ks.push({ u: 0, q: [...IDENTITY] as ClipKey['q'] })
        if (!this.loop && !near(u, 1)) ks.push({ u: 1, q: [...IDENTITY] as ClipKey['q'] })
      }
      next[name] = [...ks, key].sort((a, b) => a.u - b.u)
    }
  }

  /** While the body is solved round hands on props (a hand on a socket, or carrying a prop that leads): every bone the
   * solve moves (the body, the legs, both arms; not the fingers, which the hold sets), else none. */
  private seenBones (): string[] {
    const view = animator.character
    if (view === null) return []
    const carriers = Object.entries(this.paths).filter(([, x]) => x.locked).map(([p]) => this.props.find(q => q.name === p)?.bone)
    const hands = (['Left', 'Right'] as const).filter(h => this.attachments.some(a => a.hand === h) || carriers.includes(`${h}Hand`))
    if (hands.length === 0) return []
    return [...new Set([...this.solver.bones(hands.map(hand => ({ hand })), legsOf(view.bones, this.rig)),
      ...['Left', 'Right'].flatMap(s => [`${s}Arm`, `${s}ForeArm`, `${s}Hand`]), this.rig.hips])].filter(n => view.bones.has(n))
  }

  /** Take the keys at the playhead off: the selected bone's, or every bone's. */
  deleteHere (): void {
    const u = this.phase()
    const all = this.selected === null && this.prop === null
    const next: Record<string, ClipKey[]> = {}
    for (const [bone, ks] of Object.entries(this.keys)) {
      const keep = all || this.selected === bone ? ks.filter(k => !near(k.u, u)) : ks
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
    const grip = this.gripOf(hand)
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

  /** A hand's grip (the line a shaft runs along through its fist, and the fist's middle, in the hand's own frame): from
   * its fist closed round a shaft when it has one (fistGrip), else the rest hand's estimate (handGrip). */
  private gripOf (hand: 'Left' | 'Right'): { axis: THREE.Vector3, fist: THREE.Vector3 } | null {
    const fingers = this.fists[hand]; const root = this.posable()
    if (fingers !== undefined && Object.keys(fingers).length > 0 && root !== null) {
      const g = fistGrip(root, hand, fingers)
      if (g !== null) return g
    }
    const rest = animator.character?.rest
    return rest === null || rest === undefined ? null : handGrip(rest, hand)
  }

  /** The hand put on the prop where it holds it best: its fist squarely round the shaft (the shaft through the closed
   * fingers, square to the palm, the thumb toward the far end), and, when another hand holds the prop too, slid along it
   * and rolled round it to where the whole clip is easiest; saved as the hand's socket on the prop (the one it has, or a
   * new one) and the hand put on it; then the prop fitted again if it leads. */
  async grip (hand: 'Left' | 'Right', prop: string): Promise<void> {
    if (this.busy !== null) return
    this.fists[hand] ??= await animator.fistOf(hand).catch(() => ({}))
    const sock = this.socketAt(hand, prop, true)
    if (sock === null) { app.toast('error', `No ${hand.toLowerCase()} hand, or the prop isn't on stage`); return }
    const had = this.attachments.find(a => a.hand === hand && a.prop === prop)?.socket
    const name = (had === undefined ? undefined : this.props.find(x => x.name === prop)?.sockets.find(x => x.id === had)?.name) ?? sock.name
    const id = had ?? sock.id
    await this.saveSocket(prop, { ...sock, id, name })
    this.attachments = [...this.attachments.filter(a => a.hand !== hand), { hand, prop, socket: id }]
    const placed = await this.autoGrip(hand, prop, id, { free: true })
    if (placed === null) { if (this.paths[prop]?.locked === true && this.natural) await this.fitPath(prop); else this.show(animator.time) }
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
    this.fists[hand] ??= await animator.fistOf(hand).catch(() => ({}))
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

  /** Put `hand` on a socket (its fingers closed round the prop); one socket a hand. When another hand holds the prop (the one
   * carrying it, or another on a socket) the grip's spot is chosen too, once, over the whole clip: along the shaft and round it
   * where the body has the most room (src/engine/propfit.ts placeGrip), saved as that socket; then, if the prop leads, it is
   * fitted again (fitPath). `place: false` puts the hand on the socket as it is. */
  async attach (hand: 'Left' | 'Right', prop: string, socket: string, opts: { place?: boolean } = {}): Promise<void> {
    this.fists[hand] ??= await animator.fistOf(hand).catch(() => ({}))
    this.attachments = [...this.attachments.filter(a => a.hand !== hand), { hand, prop, socket }]
    if (opts.place !== false && this.solver !== null && this.natural) {
      const placed = await this.autoGrip(hand, prop, socket)
      if (placed !== null) return
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

  /** The grip's spot for `hand`'s socket on `prop`, chosen over the whole clip when another hand holds the prop; saved as that
   * socket (same id), then the prop is fitted again if it leads. Null when no other hand holds it (nothing is changed). */
  private async autoGrip (hand: 'Left' | 'Right', prop: string, socket: string, opts: { free?: boolean } = {}): Promise<GripResult | null> {
    const view = animator.character
    const p = this.props.find(x => x.name === prop)
    const sock = p?.sockets.find(x => x.id === socket)
    if (view === null || view.rest === null || p === undefined || sock === undefined) return null
    const carrier = this.carrierSocket(prop)
    const others = [
      ...(carrier !== null && carrier.hand !== hand ? [{ hand: carrier.hand, socket: carrier.socket }] : []),
      ...this.attachments.filter(a => a.prop === prop && a.hand !== hand && a.socket !== carrier?.socket.id).map(a => ({ hand: a.hand, socket: p.sockets.find(x => x.id === a.socket) })).filter((o): o is { hand: 'Left' | 'Right', socket: Socket } => o.socket !== undefined),
    ]
    if (others.length === 0) return null
    this.busy = 'Placing the grip'
    await new Promise(r => setTimeout(r, 30))
    let placed: GripResult | null = null
    try {
      const input = this.fitInput(prop)
      const rest = view.rest
      if (input !== null) {
        placed = await placeGrip({ ...input, hand, socket, grip: this.gripOf(hand), others: others.map(o => ({ ...o, grip: this.gripOf(o.hand) ?? handGrip(rest, o.hand) })), free: opts.free }, label => { this.busy = label })
        if (placed !== null) await this.saveSocket(prop, { ...placed.socket, id: socket, name: sock.name })
      }
    } catch (error) {
      app.toast('error', `Placing the grip failed: ${(error as Error).message}`)
    } finally {
      this.busy = null
    }
    if (placed !== null) app.toast('ok', `${sock.name}: ${Math.round(placed.s * 100)}% along the shaft (was ${Math.round(placed.was.s * 100)}%), rolled ${placed.roll.toFixed(0)}°, ${(placed.ms / 1000).toFixed(1)} s`)
    if (this.paths[prop]?.locked === true) await this.fitPath(prop); else this.show(animator.time)
    return placed ?? null
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
    // (moving a prop makes it lead)
    this.paths = { ...this.paths, [prop]: { locked: true, keys: ks } }
    // (the body as it was seen when let go: the authority at this frame, keyed; the solve starts from it)
    const next = { ...this.keys }
    this.keyBones(next, this.seenBones(), u, t)
    this.keys = next
    this.show(t)
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
    return { node: propNode, paths, attachments, sockets, carriers: Object.fromEntries(this.props.map(p => [p.name, p.bone])), fingers: this.fists, shafts }
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
          const d = Math.min(...this.keys[b].map(k => Math.abs(t - k.u * duration) * KEY_FPS))
          const w = Math.round(PULL_WEIGHT * Math.max(0, 1 - d / PULL_FRAMES) * 100) / 100
          if (w > 0) byWeight.set(w, [...(byWeight.get(w) ?? []), b])
        }
        return byWeight
      }
      const rest = view.rest
      const soles: Record<string, number> = {}
      for (const side of ['Left', 'Right']) for (const n of ['Foot', 'ToeBase', 'Toe_End']) { const b = rest.bones.get(`${side}${n}`); if (b !== undefined) soles[`${side}${n}`] = b.worldPosition.y }
      const t0 = performance.now()
      const out = naturalizeClip(rig, this.edited, {
        root, fps: KEY_FPS,
        goals: (_i, t) => [
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
