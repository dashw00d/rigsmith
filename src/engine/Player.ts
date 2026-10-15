// Plays baked clips on a character in the stage.
import * as THREE from 'three'

export class Player {
  readonly mixer: THREE.AnimationMixer
  private action: THREE.AnimationAction | null = null
  playing = true
  speed = 1
  loop = true
  private readonly rest = new Map<THREE.Object3D, { p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3 }>()

  constructor (readonly root: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(root)
    root.traverse(o => { if ((o as THREE.Bone).isBone) this.rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }) })
  }

  get clip (): THREE.AnimationClip | null { return this.action?.getClip() ?? null }
  get time (): number { return this.action?.time ?? 0 }
  get duration (): number { return this.action?.getClip().duration ?? 0 }

  play (clip: THREE.AnimationClip, keepTime = false): void {
    const previous = this.action
    const t = keepTime && previous !== null ? previous.time / Math.max(previous.getClip().duration, 1e-6) : 0
    const next = this.mixer.clipAction(clip)
    next.reset()
    next.setLoop(this.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    next.clampWhenFinished = true
    next.timeScale = this.speed
    next.time = t * clip.duration
    next.play()
    if (previous !== null && previous !== next) {
      previous.stop()
      this.mixer.uncacheAction(previous.getClip())
    }
    this.action = next
    this.action.paused = !this.playing
  }

  stop (): void {
    if (this.action !== null) {
      this.action.stop()
      this.mixer.uncacheAction(this.action.getClip())
      this.action = null
    }
    for (const [o, r] of this.rest) { o.position.copy(r.p); o.quaternion.copy(r.q); o.scale.copy(r.s) }
  }

  setPlaying (playing: boolean): void {
    this.playing = playing
    if (this.action !== null) {
      if (playing && !this.action.isRunning() && this.action.time >= this.duration - 1e-3) this.action.time = 0
      this.action.paused = !playing
      if (playing) this.action.play()
    }
  }

  setSpeed (speed: number): void {
    this.speed = speed
    if (this.action !== null) this.action.timeScale = speed
  }

  setLoop (loop: boolean): void {
    this.loop = loop
    this.action?.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
  }

  seek (time: number): void {
    if (this.action === null) return
    this.action.time = Math.max(0, Math.min(time, this.duration))
    this.mixer.update(0)
  }

  update (dt: number): void {
    this.mixer.update(dt)
  }

  dispose (): void {
    this.stop()
    this.mixer.uncacheRoot(this.root)
  }
}
