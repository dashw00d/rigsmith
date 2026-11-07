import type { LibraryIndexRow } from '../../../server/library.ts'
import type { LibraryClip } from '../../state/api.ts'
import { animator } from '../../state/animator.svelte.ts'

let token = 0
export function cancelLibraryPreview (): void { token++ }
/** Resolve a compact row only while it remains the most recent preview request. */
export async function playLibraryPreview (clip: LibraryIndexRow, resolve: (row: LibraryIndexRow) => Promise<LibraryClip>, compatible: boolean): Promise<void> {
  const requested = ++token
  if (!compatible) return
  try {
    const full = await resolve(clip)
    if (requested === token) await animator.playLibrary(full)
  } catch { /* resolve reports the error */ }
}
