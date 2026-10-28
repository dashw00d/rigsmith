// The Skeleton step's state: the marker board (open or not, the body or a hand, the marker picked), the 3D joints
// drawn over the model (src/engine/JointEditor.ts, attached through the viewer while the Skeleton step shows), the
// joint name that follows the pointer, and the one Mirror toggle both go by. The board and the 3D joints are two
// cameras on the same thing: what either places goes in as the user's placements (skeleton.place: only joints that
// differ from the detected ones become overrides), and both show select.jointsOf, whoever changed it (the other one,
// an undo, a finger trace, another page).
import { untrack } from 'svelte'
import type { CharacterView } from '../engine/CharacterView.ts'
import { JointEditor } from '../engine/JointEditor.ts'
import { markerSet, type MarkerSet } from '../engine/markers.ts'
import { fitTemplate, loadTemplate, skeletonSpec, templateName, type JointSide, type SkeletonSpec } from '../engine/templates.ts'
import { jointsOf, phaseOf } from '../model/select.ts'
import { hierarchyOf } from '../model/skeletons.ts'
import type { Character, FingerLevel, Job, Joints, MarkerBoardState } from '../model/types.ts'
import { convertJoints } from '../app/skeleton/joints.ts'
import JointLabel from '../app/skeleton/JointLabel.svelte'
import MarkerOverlay from '../app/skeleton/MarkerOverlay.svelte'
import { animator } from './animator.svelte.ts'
import { api } from './api.ts'
import { app, type Step } from './app.svelte.ts'
import { viewer } from './viewer.svelte.ts'

/** The jobs that write the skeleton's detected joints (server/routes/skeleton.ts). */
export const GENERATORS: readonly string[] = ['fingers', 'template', 'convert']

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export type BoardView = 'body' | 'right' | 'left'

/** A character's marker board: its body's set (by template) and the skeleton the solver bends. */
export interface Board { name: string, set: MarkerSet, parents: Record<string, string | null> }

/** Joints placed on the 3D model can be dragged: not an animation, not a rigged import before conversion, not while
 * it is being imported. */
export function placeable (c: Character): boolean {
  if (c.source.kind === 'animation' || c.status === 'importing') return false
  return phaseOf(c).phase !== 'needs-conversion'
}

class SkeletonState {
  /** One Mirror toggle for both: a front-view board's pairs and the 3D joints (the partner follows mirrored). */
  mirror = $state(true)
  /** The marker board is open (it covers the viewport). */
  board = $state(false)
  boardView = $state<BoardView>('body')
  /** The marker picked on the board (its id, a pair's both sides). */
  marker = $state<string | null>(null)
  /** The 3D joint picked (chips and the viewport), and the one under the pointer. */
  joint = $state<string | null>(null)
  hovered = $state<string | null>(null)
  /** The joint name shown beside the joint under the pointer (else the picked one), where it is on screen. */
  label = $state.raw<{ name: string, x: number, y: number, side: JointSide } | null>(null)
  /** The model the joints are placed on (the viewer's), while the Skeleton step shows. */
  view = $state.raw<CharacterView | null>(null)
  /** Whether the 3D joints are up (the Skeleton step, a placeable character with joints). */
  editing = $state(false)

  private editor: JointEditor | null = null
  private spec: SkeletonSpec | null = null
  private editorKey = ''
  private offFrame: (() => void) | null = null

  constructor () {
    viewer.onLoad((view) => {
      this.view = view
      return () => {
        this.closeBoard()
        this.dropEditor()
        this.view = null
      }
    }, 30)
    viewer.onSync((view, c, step) => { this.sync(view, c, step) })
    // (a clip playing moves the body away from its rest: the joints hide till it stops)
    $effect.root(() => {
      $effect(() => {
        const still = animator.playing === null
        untrack(() => { this.editor?.setEnabled(still) })
      })
    })
  }

  /** A character's marker board, or null when its body has no marker set (its joints are dragged in 3D). */
  boardFor (c: Character): Board | null {
    const set = markerSet(c.skeleton.template)
    if (set === null) return null
    return { name: c.skeleton.template, set, parents: Object.fromEntries(hierarchyOf(c)) }
  }

  setMirror (on: boolean): void {
    this.mirror = on
    this.editor?.setMirror(on)
  }

  /** Pick a joint (a chip): it grows in the viewport and its name shows. */
  pick (name: string | null): void {
    if (this.editor !== null) this.editor.select(name)
    else this.joint = name
  }

  /** Open the board on the body or a hand's view. The body goes back to rest: a clip playing stops. */
  openBoard (view: BoardView = 'body', marker?: string): void {
    const c = app.selected
    if (c === null || this.boardFor(c) === null || !placeable(c)) return
    if (animator.playing !== null) animator.stop()
    this.boardView = view
    if (marker !== undefined) this.marker = marker
    if (!this.board) {
      this.board = true
      viewer.setOverlay('markers', { component: MarkerOverlay, props: {}, covers: true, blocksInput: true })
    }
  }

  closeBoard (): void {
    if (!this.board) return
    this.board = false
    viewer.setOverlay('markers', null)
    app.setBusy('markers', null)
  }

  /** The user's placements: joints put where they were placed (the reducer keeps only those that differ from the
   * detected ones), with the board's state when it placed them. Joints the skeleton doesn't have are left out. */
  async place (c: Character, joints: Joints, markers?: MarkerBoardState | null): Promise<boolean> {
    const known = new Set(hierarchyOf(c).map(([j]) => j))
    const given = Object.fromEntries(Object.entries(joints).filter(([j]) => known.has(j)))
    if (Object.keys(given).length === 0 && markers === undefined) return true
    const entry = await app.do(c.id, { type: 'skeleton.place', joints: given, ...(markers !== undefined ? { markers } : {}) })
    return entry !== null
  }

  /** Joints back where they were detected (the picked one, and with mirroring its partner). */
  async unplace (c: Character, joints: string[]): Promise<void> {
    const placed = joints.filter(j => c.skeleton.overrides[j] !== undefined)
    if (placed.length > 0) await app.do(c.id, { type: 'skeleton.unplace', joints: placed })
  }

  /** Every joint back where it was detected: the placements, the markers and the set-aside placements cleared (asked
   * first; undoable). */
  async reset (c: Character): Promise<void> {
    const s = c.skeleton
    const placed = Object.keys(s.overrides).length
    const aside = s.stale?.length ?? 0
    const what = [
      ...(placed > 0 ? [plural(placed, 'placed joint')] : []),
      ...(s.markers !== undefined ? ['the markers'] : []),
      ...(aside > 0 ? [plural(aside, 'set-aside placement')] : []),
    ]
    if (what.length === 0) return
    const ok = await app.confirm({
      title: 'Back to the detected joints?',
      body: `This clears ${what.join(', ').replace(/, ([^,]*)$/, ' and $1')}. You can undo it.`,
      confirm: 'Reset',
      danger: true,
    })
    if (!ok) return
    const open = this.board
    this.closeBoard()
    await app.do(c.id, { type: 'skeleton.reset' })
    if (open) this.openBoard()
  }

  /** The markers seeded afresh from the joints as they are (the joints stay). */
  async restartMarkers (c: Character): Promise<void> {
    const open = this.board
    this.closeBoard()
    await app.do(c.id, { type: 'skeleton.markers', markers: null })
    if (open) this.openBoard()
  }

  // ---- the generators (server jobs) --------------------------------------------------------------------------------

  /** A generator's job started, then awaited: true when it finished. A refusal is toasted here, a failure by the app
   * when the job ends. */
  private async generate (start: () => Promise<Job>): Promise<boolean> {
    let job: Job
    try {
      job = await start()
    } catch (error) {
      app.toast('error', message(error))
      return false
    }
    return (await app.jobDone(job.id)).status === 'done'
  }

  /** Another finger level (every finger traced from the mesh again), or the fingers detected again. */
  async setFingers (c: Character, level: FingerLevel, redetect = false): Promise<boolean> {
    return await this.generate(async () => await api.fitFingers(c.id, level, redetect))
  }

  /** Another skeleton family, asked first (it clears what was made for this one). A creature's template is fitted
   * along the mesh by the server, or to the model's bounds (computed here) when the mesh doesn't read as that body. A
   * rigged import going to a person takes its own skeleton's joints. */
  async setTemplate (c: Character, template: string): Promise<boolean> {
    if (template === c.skeleton.template) return false
    const s = c.skeleton
    const lose = [
      ...(c.clips.length > 0 ? [plural(c.clips.length, 'clip')] : []),
      ...(s.markers !== undefined ? ['the markers'] : []),
      ...(Object.keys(s.overrides).length > 0 ? [plural(Object.keys(s.overrides).length, 'placed joint')] : []),
      ...((s.stale?.length ?? 0) > 0 ? [plural(s.stale!.length, 'set-aside placement')] : []),
    ]
    const rigged = phaseOf(c).phase === 'rigged'
    const ok = await app.confirm({
      title: `Put ${c.name} on the ${templateName(template)} skeleton?`,
      body: [
        lose.length > 0 ? `This clears ${lose.join(', ').replace(/, ([^,]*)$/, ' and $1')}: they were made for the ${templateName(s.template)} skeleton.` : '',
        rigged ? 'It needs rigging again afterwards.' : '',
        'You can undo it.',
      ].filter(t => t !== '').join(' '),
      confirm: 'Switch',
      danger: lose.length > 0,
    })
    if (!ok) return false
    let joints: Joints | undefined
    let fingers: FingerLevel | undefined
    try {
      if (template !== 'human') joints = await this.boundsFit(template)
      // (its own skeleton when the loaded model still has it; else the server detects the joints on the mesh)
      else if (c.source.kind === 'rigged' && viewer.character?.rest != null) ({ joints, fingers } = this.ownJoints())
    } catch (error) {
      app.toast('error', message(error))
      return false
    }
    this.closeBoard()
    return await this.generate(async () => await api.setTemplate(c.id, template, { joints, fingers }))
  }

  /** The creature template fitted to the mesh again; the placements stay on top. */
  async refit (c: Character): Promise<boolean> {
    let joints: Joints
    try {
      joints = await this.boundsFit(c.skeleton.template)
    } catch (error) {
      app.toast('error', message(error))
      return false
    }
    return await this.generate(async () => await api.fitTemplate(c.id, c.skeleton.template, { joints }))
  }

  /** A rigged import put on the Rigsmith rig: its joints read off its own skeleton (by Mixamo name, through its bone
   * map), at the finger level its hands have. */
  async convert (c: Character): Promise<boolean> {
    let own: { joints: Joints, fingers: FingerLevel }
    try {
      own = this.ownJoints()
    } catch (error) {
      app.toast('error', message(error))
      return false
    }
    const done = await this.generate(async () => await api.convert(c.id, own))
    if (done) app.toast('ok', `${c.name}: ${Object.keys(own.joints).length} joints from its own skeleton. Place the markers if they need it, then rig it.`)
    return done
  }

  /** The loaded rigged import's joints, or why they can't be read. */
  private ownJoints (): { joints: Joints, fingers: FingerLevel } {
    const rest = viewer.character?.rest
    if (rest === null || rest === undefined) throw new Error('The model is still loading')
    const { joints, fingers, missing } = convertJoints(bone => rest.bones.get(bone)?.worldPosition.toArray() ?? null)
    if (missing.length > 0) throw new Error(`Its skeleton doesn't name ${missing.join(', ')}: map them first`)
    return { joints, fingers }
  }

  /** A creature template laid into the loaded model's bounds (the server's fallback when the mesh doesn't read as
   * that body). */
  private async boundsFit (template: string): Promise<Joints> {
    const box = viewer.character?.box
    if (box === undefined) throw new Error('The model is still loading')
    return fitTemplate(await loadTemplate(template), box)
  }

  // ---- the 3D joints -----------------------------------------------------------------------------------------------

  private sync (view: CharacterView, c: Character, step: Step): void {
    this.view = view
    if (step !== 'skeleton') {
      this.closeBoard()
      this.dropEditor()
      return
    }
    const joints = placeable(c) ? jointsOf(c) : {}
    if (Object.keys(joints).length === 0) {
      this.closeBoard()
      this.dropEditor()
      return
    }
    const key = `${c.id}|${view.root.uuid}|${Object.keys(joints).join(',')}`
    if (this.editor === null || key !== this.editorKey) this.build(view, c, joints, key)
    else if (!this.editor.busy && !this.editor.shows(joints)) this.editor.setJoints(joints)
  }

  private build (view: CharacterView, c: Character, joints: Joints, key: string): void {
    this.dropEditor()
    const stage = viewer.stage
    if (stage === null) return
    const id = c.id
    this.spec = skeletonSpec(c)
    this.editor = new JointEditor(stage, joints, this.spec, view.height, {
      hover: name => { this.hovered = name },
      select: name => { this.joint = name },
      commit: moved => {
        const now = app.byId(id)
        if (now !== null) void this.place(now, moved)
      },
    })
    this.editorKey = key
    this.editor.setMirror(this.mirror)
    this.editor.setEnabled(untrack(() => animator.playing === null))
    // (the joints inside the body show through it)
    if (untrack(() => viewer.mode) === 'shaded') viewer.setMode('xray')
    if (this.joint !== null && this.spec.bones.some(([b]) => b === this.joint)) this.editor.select(this.joint)
    else this.joint = null
    this.offFrame = stage.onFrame(() => { this.follow() })
    viewer.setOverlay('joint-label', { component: JointLabel, props: {} })
    this.editing = true
  }

  private dropEditor (): void {
    if (this.editor === null) return
    this.offFrame?.()
    this.offFrame = null
    this.editor.dispose()
    this.editor = null
    this.spec = null
    this.editorKey = ''
    this.hovered = null
    this.label = null
    this.editing = false
    viewer.setOverlay('joint-label', null)
  }

  /** Each frame: the label beside its joint (moved only when it moved: the camera turns under it). */
  private follow (): void {
    const name = this.hovered ?? this.joint
    const at = name === null || this.editor === null || animator.playing !== null ? null : this.editor.screenOf(name)
    if (name === null || at === null || this.spec === null) {
      if (this.label !== null) this.label = null
      return
    }
    const was = this.label
    if (was !== null && was.name === name && Math.abs(was.x - at.x) < 0.5 && Math.abs(was.y - at.y) < 0.5) return
    this.label = { name, x: at.x, y: at.y, side: this.spec.side(name) }
  }
}

export const skeleton = new SkeletonState()
