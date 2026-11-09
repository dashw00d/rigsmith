// The pose tools' own state (src/app/motion/pose/PoseToolbar.svelte): the copied pose (kept across slots and
// characters: it pastes by bone name), the onion skins' settings (remembered on this machine), the range set for range
// edit and its falloff, the tween slider's mode, and how many frames a seam blend runs over. Nothing here is saved
// with a character: every edit the tools make is a slot.keys.set in its journal.
import type { Falloff } from '../../../model/posetools.ts'
import type { Clipboard, RangeEdit, TweenMode } from './tools.ts'

export interface OnionSettings {
  on: boolean
  before: number
  after: number
  /** Frames between ghosts. */
  step: number
  /** Ghosts at the keys round the playhead instead of every `step` frames. */
  atKeys: boolean
  /** 'time': earlier warm, later cool. 'speed': each joint by how fast it moves (src/engine/onion.ts speedColor). */
  color: 'time' | 'speed'
}

const KEY = 'rigsmith.onion'
const DEFAULT_ONION: OnionSettings = { on: false, before: 2, after: 2, step: 2, atKeys: false, color: 'time' }

function remembered (): OnionSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<OnionSettings> | null
    return { ...DEFAULT_ONION, ...(v ?? {}) }
  } catch { return { ...DEFAULT_ONION } }
}

class PoseTools {
  clipboard = $state.raw<Clipboard | null>(null)
  onion = $state<OnionSettings>(remembered())
  range = $state.raw<RangeEdit | null>(null)
  falloff = $state<Falloff>('smooth')
  tweenMode = $state<TweenMode>('tween')
  blendFrames = $state(4)

  /** The onion settings changed: remembered. */
  setOnion (patch: Partial<OnionSettings>): void {
    this.onion = { ...this.onion, ...patch }
    try { localStorage.setItem(KEY, JSON.stringify(this.onion)) } catch { /* storage unavailable */ }
  }
}

export const poseTools = new PoseTools()
