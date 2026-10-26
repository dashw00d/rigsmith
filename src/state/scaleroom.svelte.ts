// The scale room (src/app/export/ScaleRoom.svelte): open or not, for which unit (or its mount).
import type { UnitSpec } from './api.ts'

class ScaleRoomState {
  open = $state(false)
  unit = $state<string | null>(null)
  entry = $state<UnitSpec | null>(null)
  companion = $state(false)

  show (unit: string, entry: UnitSpec, companion: boolean): void {
    this.unit = unit; this.entry = entry; this.companion = companion; this.open = true
  }
}

export const scaleRoom = new ScaleRoomState()
