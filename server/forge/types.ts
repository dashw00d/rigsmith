// The Forge's shapes (docs/dressing-plan.md Phase 4): a game's forge.json (pipelines of stages, each a command), the
// store on disk (sets of items, each stage's attempts, the attempt picked), the queue's jobs and what the board reads.
// The client imports these as types only.

/** Where a stage's input comes from: the picked attempt of an earlier stage (its outputs linked into work/ at their
 * own paths), or a file of the game's repo (linked into work/ as `as`, default its name). */
export type StageInput = { stage: string } | { file: string, as?: string }

/** A gate: what a person does before the stages after it can run. pick: choose one of the attempts (N sheets);
 * approve: say the one there is good (pieces over the body); align: done in the Gear step; mask: painted there. */
export type Gate = 'pick' | 'approve' | 'align' | 'mask'

export interface ForgeStage {
  id: string
  label: string
  /** The command, run in the game's repo. Placeholders: {work} {out} {spec} {seed} {item} {set} {attempt} {repo}
   * {in.X} (input X's path in work/: a file input's link, a stage input's first output). */
  cmd: string[]
  /** Bumped when the stage's meaning changes: every attempt made before is stale. */
  version?: number | string
  /** Declared: it waits its turn on the GPU lane for this VRAM (MiB); family 'comfy' for ComfyUI's models. */
  gpu?: { vram: number, family: string }
  /** Attempts one run makes (each its own seed), default 1. */
  variants?: number
  gate?: Gate
  inputs?: Record<string, StageInput>
  /** What it must write, relative to work/ (or out/): {item} replaced; a trailing '/' is a folder; '*' in the last
   * part a pattern (one match at least); a leading '?' optional. Moved into out/ when it is done. */
  outputs: string[]
  /** Game-repo files whose contents go into the attempt's key: a change to one makes its attempts stale. */
  code?: string[]
  /** work/ is deleted after a run that succeeded (what it kept is in out/). */
  scratch?: boolean
  /** It changes its inputs in place: they are copied into work/, not linked. */
  mutates?: boolean
  /** A run a restart cut off is run again in its own work/ (the command skips what it already did). */
  resumable?: boolean
  /** Seconds before it is stopped; default 1 hour. */
  timeout?: number
  /** Its result differs run to run (a generation): never reused. Default: true when it uses the GPU. */
  generative?: boolean
  /** A deterministic stage reuses an attempt of the same key instead of running again. */
  cache?: boolean
  env?: Record<string, string>
  /** The item becomes pieces here: its @@RESULT names them ({"pieces": [...]}). */
  splits?: boolean
}

/** How a pipeline's finished items go into the game and the character. */
export interface PublishSpec {
  /** The item's folder in the game's repo ({item}); each published stage's outputs under `from` are copied in. */
  into: string
  /** The part of each attempt's out/ that is copied ({item}; default '{item}'). */
  from?: string
  /** The stages copied, in order (later ones win a path both wrote); default every stage with outputs. */
  stages?: string[]
  /** The game's list of items: the item's spec put in it under its id. */
  roster?: { file: string, list: string, key: string }
  /** Into the Rigsmith character: each piece file (a pattern in the published folder) uploaded as gear. */
  character?: PublishCharacter
}

export interface PublishCharacter {
  /** Pieces, a pattern in the published folder ('fit/*.glb'); a piece is named by its file's stem. */
  pieces: string
  /** The gear's name ({item}, {piece}) and where it came from ({name}). */
  name: string
  from: string
  /** How each piece is worn on the skin, by the start of its name before '_' (head, torso, leg...). */
  policy: Record<string, string>
  hideBody?: boolean
  /** A piece left out when the item's spec has one of these pieces (an outfit's head when it is hair). */
  skip?: Record<string, string[]>
  /** Tags a piece gets when the item's spec has one of these pieces (headwear covers the hair). */
  tags?: Array<{ piece: string, anyOf: string[], tags: string[] }>
  /** The item's field set on each piece ('outfit': the item's id). */
  field?: string
}

export interface ForgePipeline {
  id: string
  label: string
  /** What one item is called ('outfit'). */
  item: string
  stages: ForgeStage[]
  publish?: PublishSpec
}

export interface ForgeConfig {
  schema: 1
  /** The game's repo (absolute) and the forge.json read. */
  repo: string
  file: string
  /** The store, absolute. */
  store: string
  /** ComfyUI's address, when the settings and $COMFY_URL don't say. */
  comfy?: string
  /** The body the pieces are made for, in the repo. */
  body?: string
  /** The Rigsmith character published pieces go into. */
  character?: string
  /** Re-takes the game's asset hashes after a publish (run once a batch, in the repo). */
  hashes?: string[]
  pipelines: Record<string, ForgePipeline>
}

// ---- the store ------------------------------------------------------------------------------------------------------

export interface ForgeSet { id: string, name: string, pipeline: string, createdAt: number, note?: string }
export interface ForgeItem { id: string, name: string, createdAt: number, spec: Record<string, unknown>, pieces?: string[] }

export type AttemptStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

/** An attempt's record (manifest.json): everything its key was made of, and what it wrote. */
export interface Manifest {
  schema: 1
  set: string
  item: string
  stage: string
  attempt: string
  key: string
  status: AttemptStatus
  version: string
  cmd: string[]
  params: Record<string, unknown>
  seed: number
  variant: number
  /** Each input: a stage's picked attempt then (and its outputs' hash), or a repo file's hash. */
  inputs: Record<string, { stage: string, attempt: string, hash: string } | { file: string, hash: string }>
  /** The item's spec's hash, and each listed code file's. */
  spec: string
  code: Record<string, string>
  /** Each file in out/ by its path there, and its sha256. */
  outputs: Record<string, string>
  result?: Record<string, unknown>
  error?: string
  startedAt: number
  finishedAt?: number
  /** Reused from another attempt of the same key (a deterministic stage). */
  reused?: string
  /** The partial attempt it carried on from. */
  resumed?: string
}

export interface Selection { attempt: string, at: number, by: string, approved?: boolean }

/** An attempt as the board shows it. */
export interface AttemptView {
  id: string
  status: AttemptStatus
  startedAt: number
  finishedAt?: number
  seed?: number
  error?: string
  outputs: string[]
  /** Why it no longer follows from what is picked upstream and the code (empty: current). */
  stale: string[]
  result?: Record<string, unknown>
}

export interface StageView {
  id: string
  attempts: AttemptView[]
  selected: Selection | null
  /** The stages after it may run: something is picked (and approved where the gate asks). */
  ready: boolean
  /** Why it can't run yet (an input not ready), else null. */
  blocked: string | null
}

export interface ItemView extends ForgeItem { stages: StageView[] }
export interface SetView extends ForgeSet { items: ItemView[] }

// ---- the queue --------------------------------------------------------------------------------------------------

export type QueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface QueueJob {
  id: string
  set: string
  item: string
  stage: string
  label: string
  lane: 'gpu' | 'cpu'
  params: Record<string, unknown>
  variant: number
  status: QueueStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  progress: number
  message: string
  error?: string
  attempt?: string
  /** A partial attempt to carry on from (after a restart). */
  resume?: string
  /** Run the stages after this one too, up to the first gate ('gate') or up to that stage. */
  through?: string
}

/** The SSE `forge` event: a job's state, its ETA (seconds, null unknown) and its log's last lines. */
export interface ForgeEvent { job: QueueJob, progress: number, eta: number | null, logTail: string[] }

export interface ForgeView {
  config: { repo: string, store: string, character?: string, pipelines: Record<string, ForgePipeline> } | null
  error?: string
  sets: SetView[]
  queue: QueueJob[]
}
