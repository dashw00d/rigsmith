// Import: the inspect job (blender/jobs/inspect.py) that cleans and measures an upload, classifies it and finds its
// joints, and what it found written into the character (server/importing.ts applyInspect, DESIGN.md §2.2). Blender
// writes into a folder of its own; the new model.glb is moved into place under the files lock, with the document, so
// a failed or cancelled import changes nothing.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { applyInspect, hasOwnRig, type InspectResult } from './importing.ts'
import { enqueue, type Job, runBlender, type Update } from './jobs.ts'
import { type Character, characterDir, failCharacter, getCharacter, paths, updateCharacter, withFiles } from './store.ts'

// (Blender's own folder inside the character's, so the model moves into place with a rename; and a resize's temp
// files, server/routes/import.ts)
const SCRATCH = /^inspect-[0-9a-f]+$|\.glb\.fit-[0-9a-f]+\.tmp$/

/** Import (or `again`, re-import) a character's upload: inspect.py at its finger level and size, then the result. */
export async function runInspect (id: string, update: Update, signal: AbortSignal, o: { again: boolean, by: string }): Promise<void> {
  const c = await getCharacter(id)
  if (c === null) throw new Error(`No character ${id}`)
  if (o.again && c.skin.locked && !hasOwnRig(c) && c.files.rigged !== undefined) {
    throw new Error('Its weights are locked (Skin) and its rig is the imported file itself, which importing again would write over')
  }
  const dir = characterDir(id)
  const scratch = path.join(dir, `inspect-${randomBytes(4).toString('hex')}`)
  await mkdir(scratch)
  try {
    const { result } = await runBlender('jobs/inspect.py', [
      '--input', path.join(dir, c.source.file), '--out', scratch, '--overrides', paths(id).textures, '--ground',
      '--fingers', c.skeleton.fingerLevel, '--scale', String(c.source.scale),
    ], (progress, message) => { update({ progress: progress * 0.95, message }) }, { signal })
    const r = result as unknown as InspectResult
    signal.throwIfAborted()
    update({ progress: 0.97, message: 'Saving' })
    const changes: string[] = []
    await withFiles(id, async () => {
      if (r.model !== null) await rename(path.join(scratch, r.model), path.join(dir, r.model))
      await updateCharacter(id, x => { changes.push(...applyInspect(x, r, { again: o.again })) },
        { by: o.by, what: o.again ? 'reimport' : 'import', changes })
    })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Queue the import of a character's upload. A first import that fails leaves the character failed (status error); a
 * re-import that fails leaves it as it was, the reason in its error and journal. */
export function inspect (character: Character, o: { by?: string, again?: boolean } = {}): Job {
  const again = o.again === true
  const by = o.by ?? 'server'
  const id = character.id
  return enqueue(again ? 'reimport' : 'inspect', `${again ? 'Re-import' : 'Import'} ${character.name}`, id, async (job, update, signal) => {
    try {
      await runInspect(id, update, signal, { again, by })
    } catch (error) {
      const now = await getCharacter(id).catch(() => null)
      if (now === null) throw error
      if (now.status === 'importing' || now.status === 'error') await failCharacter(id, signal.aborted ? new Error('The import was cancelled') : error)
      const why = signal.aborted ? 'cancelled' : `failed: ${error instanceof Error ? error.message : String(error)}`
      await updateCharacter(id, x => { x.error = `Re-import ${why}` }, { by, what: 'reimport', changes: [`re-import ${why}`] }).catch(() => {})
      throw error
    }
  }, { lock: 'files' })
}

/** Restart recovery: characters left mid-import are imported again, and what an import or a resize was writing when
 * the server stopped is removed. */
export function resumeImports (characters: Character[]): void {
  void (async () => {
    // (tidied first: an import started now has a folder of its own there)
    for (const c of characters) {
      try {
        const dir = characterDir(c.id)
        if (!existsSync(dir)) continue
        for (const f of await readdir(dir)) if (SCRATCH.test(f)) await rm(path.join(dir, f), { recursive: true, force: true })
      } catch (error) {
        console.error(`rigsmith: could not tidy ${c.id}'s import folders:`, error)
      }
    }
    for (const c of characters) if (c.status === 'importing') inspect(c)
  })()
}
