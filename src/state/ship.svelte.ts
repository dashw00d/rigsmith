// Ship: the game units (Rigsmith's list, server/game.ts), the export into the game and each unit's last build. Read by
// the Ship step and by the seat (src/state/mount.svelte.ts: the game heights a rider is seated by).
import { untrack } from 'svelte'
import { slotByName } from '../model/select.ts'
import { api, type Character, type GameStatus, type Job, type UnitBuildView, type UnitSpec } from './api.ts'
import { app } from './app.svelte.ts'
import { DEFAULT_LODS } from '../engine/contract.ts'
import { unitChecks, type Check } from '../engine/checks.ts'
import { unitNameOf } from '../app/ship/text.ts'

/** A unit a character is, or is the companion of. */
export interface UnitRow { name: string, ours: UnitSpec, game: UnitSpec | null, differs: boolean, role: 'unit' | 'companion' }

/** The clip names a new unit starts with (those its character has a slot for). */
const GAME_CLIPS = ['Idle', 'Walk', 'Run', 'Attack', 'Die']

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const active = (j: Job): boolean => j.status === 'queued' || j.status === 'running'

/** The units an export job is for (it says so in its result from the start). */
export function jobUnits (job: Job): string[] {
  const units = job.result?.units
  return Array.isArray(units) ? units.filter((u): u is string => typeof u === 'string') : []
}

class Ship {
  status = $state.raw<GameStatus | null>(null)
  /** Why the units couldn't be read, if they couldn't. */
  error = $state<string | null>(null)
  /** Each unit's last build, as last read (null: none yet). */
  builds = $state.raw<Record<string, UnitBuildView | null>>({})
  private loadedBeat = -1
  private loading: Promise<void> | null = null
  private buildBeat = new Map<string, number>()
  private writes: Promise<unknown> = Promise.resolve()

  /** Read the units (again when they changed: app.gameBeat is read here, so a calling effect runs again on it). */
  async load (): Promise<void> {
    const beat = app.gameBeat
    if (beat === this.loadedBeat && untrack(() => this.status) !== null) return
    if (this.loading !== null && beat === this.loadedBeat) return await this.loading
    this.loadedBeat = beat
    this.loading = (async () => {
      try {
        this.status = await api.game()
        this.error = null
      } catch (error) {
        this.error = reason(error)
      } finally {
        this.loading = null
      }
    })()
    await this.loading
  }

  /** The units a character is (first) or is the companion of. */
  unitsOf (id: string): UnitRow[] {
    const out: UnitRow[] = []
    for (const [name, u] of Object.entries(this.status?.units ?? {})) {
      if (u.ours === null) continue
      if (u.ours.character === id) out.push({ name, ours: u.ours, game: u.game, differs: u.differs, role: 'unit' })
      else if (u.ours.companion?.character === id) out.push({ name, ours: u.ours, game: u.game, differs: u.differs, role: 'companion' })
    }
    return out.sort((a, b) => (a.role === b.role ? 0 : a.role === 'unit' ? -1 : 1))
  }

  /** Rigsmith's entry for a unit. */
  spec (name: string): UnitSpec | null {
    return this.status?.units[name]?.ours ?? null
  }

  /** A unit's entry with the defaults under it: what its export builds from. */
  effective (name: string): UnitSpec | null {
    const ours = this.spec(name)
    return ours === null ? null : { ...this.status?.defaults, ...ours } as UnitSpec
  }

  /** Its levels: its own, else the defaults'. */
  lods (name: string): number[] {
    return [...(this.effective(name)?.lods ?? DEFAULT_LODS)]
  }

  /** Rigsmith's units by name (src/engine/mount.ts mountHeights reads a rider's and his horse's heights from them). */
  units (): Record<string, UnitSpec> {
    const out: Record<string, UnitSpec> = {}
    for (const [name, u] of Object.entries(this.status?.units ?? {})) if (u.ours !== null) out[name] = u.ours
    return out
  }

  /** Save a unit's entry (null takes it off Rigsmith's list). False when the server refused (toasted). */
  async save (name: string, entry: UnitSpec | null): Promise<boolean> {
    return await this.serial(async () => await this.put(name, entry))
  }

  /** Change some of a unit's keys; an undefined value takes the key out. Made on the entry as the last save left it,
   * so two quick edits don't undo each other. */
  async patch (name: string, change: Partial<UnitSpec>): Promise<boolean> {
    return await this.serial(async () => {
      const was = this.spec(name)
      if (was === null) return false
      const next: UnitSpec = { ...was, ...change }
      for (const [k, v] of Object.entries(change)) if (v === undefined) delete (next as Record<string, unknown>)[k]
      return await this.put(name, next)
    })
  }

  private async put (name: string, entry: UnitSpec | null): Promise<boolean> {
    try {
      this.status = await api.putUnit(name, entry)
      return true
    } catch (error) {
      app.toast('error', `${name}: ${reason(error)}`)
      return false
    }
  }

  /** One unit write at a time, in the order asked. */
  private async serial<T> (fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn)
    this.writes = run.catch(() => undefined)
    return await run
  }

  /** Make the character a unit: a draft (the game's build skips it till it is exported), playing the usual clip names it
   * has slots for. */
  async create (c: Character, name: string): Promise<boolean> {
    const unit = unitNameOf(name)
    if (unit === '') { app.toast('error', 'Name the unit'); return false }
    if (this.status?.units[unit] !== undefined) { app.toast('error', `There is a unit ${unit} already`); return false }
    const clips = GAME_CLIPS.filter(n => slotByName(c, n) !== undefined)
    return await this.save(unit, { character: c.id, height: 2, budget: 8000, tex: 1024, draft: true, clips })
  }

  async remove (name: string): Promise<void> {
    const ok = await app.confirm({
      title: `Remove the unit ${name}?`,
      body: "It comes off Rigsmith's list only: the game keeps its own entry and model until they are changed there.",
      confirm: 'Remove', danger: true,
    })
    if (ok) await this.save(name, null)
  }

  /** The export of this unit that is queued or running, if any. */
  jobOf (name: string): Job | null {
    return app.jobs.find(j => j.kind === 'export' && active(j) && jobUnits(j).includes(name)) ?? null
  }

  /** Is any export queued or running (one runs at a time)? */
  get exporting (): Job | null {
    return app.jobs.find(j => j.kind === 'export' && active(j)) ?? null
  }

  /** Export a unit into the game (the server's job: its entry, then the game's build). Asks first when checks fail. */
  async export (name: string, checks: Check[]): Promise<Job | null> {
    const fails = checks.filter(x => x.status === 'fail')
    if (fails.length > 0) {
      const ok = await app.confirm({
        title: `Export ${name} anyway?`,
        body: `${fails.length === 1 ? 'A check fails' : `${fails.length} checks fail`}: ${fails.map(x => x.text).join('; ')}. The export will likely stop on ${fails.length === 1 ? 'it' : 'them'}.`,
        confirm: 'Export', danger: true,
      })
      if (!ok) return null
    }
    try {
      return await api.exportUnits([name])
    } catch (error) {
      app.toast('error', reason(error))
      return null
    }
  }

  /** Stop this unit's export (queued: it never starts; running: the build is killed and the game's units.json put
   * back). */
  async cancel (name: string): Promise<void> {
    const job = this.jobOf(name)
    if (job !== null) await app.cancelJob(job.id)
  }

  /** Read a unit's last build (again after the units or an export changed). */
  async build (name: string): Promise<void> {
    const beat = app.gameBeat
    if (this.buildBeat.get(name) === beat) return
    this.buildBeat.set(name, beat)
    try {
      const view = await api.unitBuild(name)
      this.builds = { ...untrack(() => this.builds), [name]: view }
    } catch {
      this.builds = { ...untrack(() => this.builds), [name]: null }
    }
  }

  /** The Ship checks of a unit, its characters as this page has them. */
  checks (name: string): Check[] {
    const spec = this.effective(name)
    if (spec === null) return []
    return unitChecks({
      unit: name, spec, character: app.byId(spec.character),
      companion: spec.companion === undefined ? undefined : app.byId(spec.companion.character),
    })
  }
}

export const ship = new Ship()
