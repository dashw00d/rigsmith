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
  /** Bumped on every frame so overlay labels can follow joints. */
  frame = $state(0)

  private loadedKey = ''
  private loadToken = 0

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
    void outfit.sync(step === 'outfit')
    if (step !== 'animate' && step !== 'export' && step !== 'outfit' && animator.current !== null) animator.stop()
  }

  private editorToken = 0

  private syncEditor (character: Character | null, step: Step): void {
    const wants = step === 'rig' && character !== null && character.kind === 'mesh' && character.joints !== undefined && this.character !== null && character.status !== 'rigged'
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

  private clear (): void {
    if (this.stage === null) return
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
