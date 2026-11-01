// Distance-sampled brush input. Like three-mesh-bvh's sculpt example, spacing is a fraction of the brush diameter;
// residual distance is carried between pointer events so the result does not depend on the device's event rate.
export interface BrushSample { x: number, y: number }

export class BrushStroke {
  private cursor: BrushSample
  private last: BrushSample
  private residual = 0
  readonly spacing: number

  constructor (start: BrushSample, spacing: number) {
    this.cursor = { ...start }; this.last = { ...start }
    this.spacing = Math.max(1, Number.isFinite(spacing) ? spacing : 1)
  }

  move (to: BrushSample): BrushSample[] {
    if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return []
    const dx = to.x - this.cursor.x; const dy = to.y - this.cursor.y
    const distance = Math.hypot(dx, dy)
    const samples: BrushSample[] = []
    if (distance > 0) {
      let along = this.spacing - this.residual
      while (along <= distance + 1e-7) {
        const t = Math.min(1, along / distance)
        this.last = { x: this.cursor.x + dx * t, y: this.cursor.y + dy * t }
        samples.push(this.last)
        along += this.spacing
      }
      this.residual = (this.residual + distance) % this.spacing
      if (this.residual < 1e-7 || this.spacing - this.residual < 1e-7) this.residual = 0
    }
    this.cursor = { ...to }
    return samples
  }

  /** The endpoint gets one dab even when the last movement was shorter than the spacing. */
  end (): BrushSample[] {
    if (Math.hypot(this.cursor.x - this.last.x, this.cursor.y - this.last.y) < 1e-7) return []
    this.last = { ...this.cursor }; this.residual = 0
    return [this.last]
  }
}
