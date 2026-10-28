// What the character list and the Import step do to a character, written once: rename it, delete it (asking first,
// and again with the server's reasons when something depends on it), import files and show the first, rig a batch.
import { ApiError, MODEL_FILE, type Character, type Job } from '../state/api.ts'
import { app } from '../state/app.svelte.ts'
import { refusal, refusalText } from './activity.ts'

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A new name (blank or the same: nothing happens). The server's refusal is toasted. */
export async function renameCharacter (c: Character, name: string): Promise<void> {
  const next = name.trim()
  if (next === '' || next === c.name) return
  await app.do(c.id, { type: 'character.rename', name: next })
}

/** Delete a character once the user agrees: it goes to workspace/trash. When a rider, a game unit or a job depends
 * on it the server says so (409), and the user is asked again with what deleting anyway does. True when deleted. */
export async function removeCharacter (c: Character): Promise<boolean> {
  const sure = await app.confirm({
    title: `Delete ${c.name}?`,
    body: 'It goes to workspace/trash. To bring it back, move its folder back into workspace/characters.',
    confirm: 'Delete',
    danger: true,
  })
  if (!sure) return false
  try {
    await app.remove(c.id)
  } catch (error) {
    const why = error instanceof ApiError && error.status === 409 ? refusal(error.body) : null
    if (why === null) {
      app.toast('error', `${c.name} wasn't deleted: ${reason(error)}`)
      return false
    }
    const anyway = await app.confirm({
      title: `${c.name} is in use`,
      body: refusalText(why, id => app.byId(id)?.name ?? id),
      confirm: 'Delete anyway',
      danger: true,
    })
    if (!anyway) return false
    try {
      await app.remove(c.id, true)
    } catch (again) {
      app.toast('error', `${c.name} wasn't deleted: ${reason(again)}`)
      return false
    }
  }
  app.toast('ok', `${c.name} deleted (in workspace/trash)`)
  return true
}

/** Import model files (one after another) and show the first as soon as it is in. */
export async function importFiles (files: File[]): Promise<void> {
  const accepted = files.filter(f => MODEL_FILE.test(f.name))
  if (accepted.length < files.length) app.toast('error', 'Skipped files that are not FBX, GLB, OBJ, DAE or ZIP')
  const [first, ...rest] = accepted
  if (first === undefined) return
  const before = new Set(app.characters.map(c => c.id))
  await app.importFiles([first])
  const made = app.characters.find(c => !before.has(c.id))
  // (the same file again answers the character it made before)
  const again = made === undefined ? [...app.characters].reverse().find(c => c.source.originalName === first.name) : undefined
  if (again !== undefined) app.toast('info', `${first.name} was imported before: ${again.name}`)
  const shown = made ?? again
  if (shown !== undefined) await app.select(shown.id)
  if (rest.length > 0) await app.importFiles(rest)
}

/** Start rigging each; the ones the server refused (each toasted) by name, and the jobs started. */
export async function rigEach (list: readonly Character[]): Promise<{ jobs: Array<{ c: Character, job: Job }>, refused: string[] }> {
  const jobs: Array<{ c: Character, job: Job }> = []
  const refused: string[] = []
  for (const c of list) {
    const job = await app.rig(c.id)
    if (job === null) refused.push(c.name)
    else jobs.push({ c, job })
  }
  return { jobs, refused }
}
