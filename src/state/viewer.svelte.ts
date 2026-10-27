// Bridges app state and the 3D engine: which character is shown, display mode, joint editing.
import { api, type Character, fileUrl } from './api.ts'
import { animator } from './animator.svelte.ts'
import { app, type Step } from './app.svelte.ts'
import { outfit } from './outfit.svelte.ts'
import { CharacterView, type DisplayMode } from '../engine/CharacterView.ts'
import { humanSpec, JointEditor, templateSpec, type Joints, type SkeletonSpec } from '../engine/JointEditor.ts'
import { loadTemplate } from '../engine/templates.ts'
import type { FingerLevel } from '../engine/mixamo.ts'
import { Stage } from '../engine/Stage.ts'
import * as THREE from 'three'
import { restFrame } from '../engine/garments.ts'
import { riderScale, seatMatrix } from '../engine/mount.ts'

class Viewer {
  stage: Stage | null = null
  character = $state.raw<CharacterView | null>(null)
  editor = $state.raw<JointEditor | null>(null)
  mode = $state<DisplayMode>('shaded')
  skeleton = $state(false)
  loading = $state(false)
  loadError = $state<string | null>(null)
  hoveredJoint = $state<string | null>(null)
  selectedJoint = $state<string | null>(null)
  mirror = $state(true)
  /** Back at the joints of a rigged character (markers, the 3D editor) to re-rig it: it stays rigged till then. */
  adjusting = $state(false)
  /** Bumped on every frame so overlay labels can follow joints. */
  frame = $state(0)

  private loadedKey = ''
  private loadToken = 0
  /** The horse the character on stage rides (its CharacterView), and the seat holding his rig on its back:
   * horse bone -> its rest frame undone -> the seat (his placement, at his size) -> his root. */
  horse = $state.raw<CharacterView | null>(null)
  private horseKey = ''
  private horseToken = 0
  private seat: THREE.Group | null = null
  private seatBone = ''
  /** The game's heights for a rider and his horse (the spec), per character. */
  private heights = new Map<string, Promise<{ rider: number | null, horse: number | null }>>()

  attach (container: HTMLElement): () => void {
    this.stage = new Stage(container)
    const off = this.stage.onFrame(() => { if (this.hoveredJoint !== null || this.selectedJoint !== null) this.frame++ })
    return () => {
      off()
      this.clear()
      this.stage?.dispose()
      this.stage = null
      this.loadedKey = ''
    }
  }

  /** Which file a step shows: the rigged result once it exists, otherwise the imported model. */
  private fileFor (c: Character): string | undefined {
    return c.files.rigged ?? c.files.model
  }

  async sync (character: Character | null, step: Step): Promise<void> {
    if (this.stage === null) return
    const file = character === null ? undefined : this.fileFor(character)
    const url = character === null ? null : fileUrl(character, file)
    const key = url ?? ''
    if (key !== this.loadedKey) {
      this.loadedKey = key
      const token = ++this.loadToken
      this.clear()
      if (url === null || character === null) return
      this.loading = true
      this.loadError = null
      try {
        const view = await CharacterView.load(url)
        if (token !== this.loadToken) { view.dispose(this.stage); return }
        view.addTo(this.stage)
        this.character = view
        this.stage.frame(view.box, true)
        view.setMode(this.mode)
        view.showSkeleton(this.stage, this.skeleton)
        animator.attach(view, this.stage)
        outfit.bind(view, this.stage)
      } catch (error) {
        this.loadError = (error as Error).message
      } finally {
        if (token === this.loadToken) this.loading = false
      }
    }
    this.syncEditor(character, step)
    await this.syncMount(character)
    void outfit.sync(step === 'outfit')
    // (the rig test plays on in the Rig step, till the joints are back up to change)
    if (step !== 'animate' && step !== 'export' && step !== 'outfit' && animator.current !== null && !(step === 'rig' && animator.current.test === true && !this.adjusting)) animator.stop()
  }

  private editorToken = 0

  private syncEditor (character: Character | null, step: Step): void {
    const wants = step === 'rig' && character !== null && character.kind === 'mesh' && character.joints !== undefined && this.character !== null && (character.status !== 'rigged' || this.adjusting)
    if (!wants) {
      this.editorToken++
      if (this.editor !== null) { this.editor.dispose(); this.editor = null }
      return
    }
    if (this.editor !== null) return
    const token = ++this.editorToken
    const id = character.id
    const template = character.template ?? 'human'
    const spec: Promise<SkeletonSpec> = template === 'human'
      ? Promise.resolve(humanSpec((character.fingers ?? 'full') as FingerLevel))
      : loadTemplate(template).then(templateSpec)
    void spec.then(spec => {
      if (token !== this.editorToken || this.editor !== null || this.stage === null || this.character === null) return
      this.editor = new JointEditor(this.stage, character.joints as Joints, spec, this.character.height, {
        hover: name => { this.hoveredJoint = name },
        select: name => { this.selectedJoint = name },
        commit: joints => { void app.update(id, { joints, jointsEdited: true }) },
      })
      this.editor.setMirror(this.mirror)
      if (this.mode === 'shaded') this.setMode('xray')
    })
  }

  /** The character's joints changed (the marker board, the CLI, a reset): the 3D editor takes them up, so it never
   * shows (or saves back) the joints from before. */
  followJoints (joints: Joints | undefined): void {
    if (this.editor === null || joints === undefined) return
    const now = this.editor.value
    const same = Object.keys(joints).length === Object.keys(now).length && Object.entries(joints).every(([k, p]) => now[k] !== undefined && p.every((x, i) => Math.abs(x - now[k][i]) < 1e-9))
    if (!same) this.editor.setJoints(joints)
  }

  /** Rebuild the joint editor (finger level changed, joints reset). */
  resetEditor (): void {
    this.editor?.dispose()
    this.editor = null
    void this.sync(app.selected, app.step)
  }

  setMode (mode: DisplayMode): void {
    this.mode = mode
    this.character?.setMode(mode)
  }

  setSkeleton (visible: boolean): void {
    this.skeleton = visible
    if (this.stage !== null) this.character?.showSkeleton(this.stage, visible)
  }

  setMirror (mirror: boolean): void {
    this.mirror = mirror
    this.editor?.setMirror(mirror)
  }

  focus (): void {
    if (this.character !== null) this.stage?.frame(this.character.box)
  }

  /** Put the character on its horse (or take it off): load the horse beside it, seat its rig on the horse's bone at its
   * placement and size, hand the horse to the animator. */
  private async syncMount (character: Character | null): Promise<void> {
    const stage = this.stage
    const rider = this.character
    if (stage === null) return
    const m = character?.mount
    const horseChar = m === undefined ? undefined : app.characters.find(c => c.id === m.character)
    const url = horseChar === undefined ? null : fileUrl(horseChar, horseChar.files.rigged)
    const key = url === null || rider === null ? '' : `${rider.root.uuid}|${url}`
    if (key !== this.horseKey) {
      this.horseKey = key
      const token = ++this.horseToken
      this.dropHorse()
      if (url === null || rider === null) return
      try {
        const horse = await CharacterView.load(url)
        if (token !== this.horseToken || this.character !== rider) { horse.dispose(stage); return }
        stage.content.add(horse.root)
        horse.setMode(this.mode)
        this.horse = horse
        animator.attachMount(horse)
      } catch (error) {
        this.loadError = `The horse didn't load: ${(error as Error).message}`
        return
      }
    }
    const horse = this.horse
    if (horse === null || rider === null || m === undefined || horseChar === undefined) return
    const bone = horse.bones.get(m.bone)
    if (bone === undefined) return
    if (this.seat === null || this.seatBone !== m.bone) {
      this.seat?.parent?.removeFromParent()
      const group = new THREE.Group()
      group.name = 'mount_seat_frame'
      group.applyMatrix4((restFrame(horse, m.bone) ?? bone.matrixWorld.clone()).invert())
      this.seat = new THREE.Group()
      this.seat.name = 'mount_seat'
      group.add(this.seat)
      bone.add(group)
      this.seat.add(rider.root)
      this.seatBone = m.bone
    }
    const h = await this.gameHeights(character!.id)
    const k = riderScale(m, { game: h.rider, own: rider.height }, { game: h.horse, own: horse.height })
    this.seat.matrix.identity()
    seatMatrix(m, k).decompose(this.seat.position, this.seat.quaternion, this.seat.scale)
  }

  /** The seat holding the rider (for the outfit's gizmo), when he rides. */
  get seatNode (): THREE.Group | null { return this.seat }

  private async gameHeights (id: string): Promise<{ rider: number | null, horse: number | null }> {
    // (keyed by the game's beat too: saving a unit's dimensions gives the new heights)
    const key = `${id}@${app.gameBeat}`
    let pending = this.heights.get(key)
    if (pending === undefined) {
      pending = fetch(`/api/characters/${id}/game`).then(async r => (r.ok ? await r.json() : null) as { height: number | null, companion?: { height: number | null } } | null)
        .then(g => ({ rider: g?.height ?? null, horse: g?.companion?.height ?? null }), () => ({ rider: null, horse: null }))
      this.heights.set(key, pending)
    }
    return await pending
  }

  /** The horse off stage; the rider back on the ground. */
  private dropHorse (): void {
    const stage = this.stage
    if (this.character !== null && stage !== null && this.character.root.parent !== stage.content) {
      stage.content.add(this.character.root)
      this.character.root.position.set(0, 0, 0)
      this.character.root.quaternion.identity()
      this.character.root.scale.set(1, 1, 1)
    }
    this.seat = null
    this.seatBone = ''
    if (this.horse !== null && stage !== null) this.horse.dispose(stage)
    this.horse = null
    animator.attachMount(null)
  }

  private clear (): void {
    if (this.stage === null) return
    this.dropHorse()
    this.horseKey = ''
    this.editor?.dispose()
    this.editor = null
    animator.detach()
    outfit.bind(null, this.stage)
    this.character?.dispose(this.stage)
    this.character = null
    this.hoveredJoint = null
    this.selectedJoint = null
  }
}

export const viewer = new Viewer()
