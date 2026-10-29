// The HTTP API: every route module, registered on the shared router (server/http.ts), and restart recovery. Each area
// owns its route module (docs/rebuild/DESIGN.md §3).
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import './routes/characters.ts'
import './commands.ts'
import './compat.ts'
import './routes/import.ts'
import './routes/skeleton.ts'
import './routes/skin.ts'
import './routes/gear.ts'
import './routes/look.ts'
import './routes/library.ts'
import './routes/edits.ts'
import './routes/ship.ts'
import './routes/restore.ts'
import './routes/sounds.ts'
import { resumeImports } from './inspect.ts'
import { importGarment } from './routes/gear.ts'
import { compose, composeStale, sweepFills } from './routes/look.ts'
import { characterDir, listCharacters, paths, updateCharacter } from './store.ts'

export { handle } from './http.ts'

// (a rig job's candidates, a finger fit's input, and a half-written rigged.glb or model.glb: saved painting, a resize
// and a texture swap write a temp file beside the file, then rename it over it; not rigging-*.glb.previous.glb, which
// a failed publish keeps on purpose as the recovery copy of the previous rig)
export const STRAY = /^(rigging-[0-9a-f]+(-heat|-before-optimize)?\.glb(\.paint\.json)?|finger-joints-[0-9a-f]+\.json|(rigged|model)\.glb\.[\w.-]+\.tmp)$/

/** After a restart: imports left half done are inspected again; a rig left running is called off (the character keeps
 * its last rig if it has one) and journaled; gear left importing is imported again from its upload; a texture whose
 * compose the restart may have cut off is composed again; files and folders a killed job left behind are deleted. */
export async function resumeInterrupted (): Promise<void> {
  const characters = await listCharacters()
  for (const c of characters) {
    try {
      const dir = characterDir(c.id)
      for (const f of await readdir(dir)) if (STRAY.test(f)) await rm(path.join(dir, f), { force: true })
      if (c.status === 'rigging') {
        const rigged = c.files.rigged !== undefined && existsSync(path.join(dir, c.files.rigged))
        await updateCharacter(c.id, x => {
          x.status = rigged ? 'rigged' : 'ready'
          x.error = 'the rig was interrupted'
        }, { by: 'server', what: 'rig', changes: [`the rig was interrupted by a restart${rigged ? '; the previous rig is kept' : ''}`] })
      }
      for (const g of c.gear) {
        if (g.status !== 'importing') continue
        const folder = paths(c.id).garment(g.id)
        const source = existsSync(folder) ? (await readdir(folder)).find(f => /^source\.[a-z0-9]+$/i.test(f)) : undefined
        if (source !== undefined) importGarment(c.id, g.id, g.name, path.join(folder, source))
        else await updateCharacter(c.id, x => {
          const gear = x.gear.find(y => y.id === g.id)
          if (gear !== undefined) { gear.status = 'error'; gear.error = 'its upload is gone (import it again)' }
        })
      }
      // (a fill's working folder; then the layers laid over the texture again when the texture files don't hold what
      // the layers say: the compose that would have caught up went with the server)
      await sweepFills(c.id)
      if (await composeStale(c)) {
        console.log(`rigsmith: composing ${c.id}'s texture again: its files don't hold its layers`)
        compose(c.id, c.name)
      }
    } catch (error) {
      console.error(`rigsmith: could not resume ${c.id}:`, error)
    }
  }
  resumeImports(characters)
}
