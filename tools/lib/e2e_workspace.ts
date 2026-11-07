// A scenario workspace: character files are copies, the selected read-mostly library files are hard links. Source
// library mtimes are checked before cleanup. No symlinks or external game path are allowed into the sandbox.
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface E2EWorkspace { dir: string, characters: string[], verify: () => void, cleanup: () => void }
interface Snapshot { file: string, mtime: bigint, size: bigint, inode: bigint }

function copyTree (from: string, to: string, hardlink: boolean, guard: Snapshot[]): void {
  const entry = lstatSync(from)
  if (entry.isSymbolicLink()) throw new Error(`E2E workspace refuses symlink: ${from}`)
  if (entry.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const child of readdirSync(from)) copyTree(path.join(from, child), path.join(to, child), hardlink, guard)
  } else if (entry.isFile()) {
    mkdirSync(path.dirname(to), { recursive: true })
    if (hardlink) {
      linkSync(from, to)
      const stat = statSync(from, { bigint: true })
      guard.push({ file: from, mtime: stat.mtimeNs, size: stat.size, inode: stat.ino })
    } else copyFileSync(from, to)
  } else throw new Error(`E2E workspace refuses special file: ${from}`)
}

/** Make the workspace; caller must verify and cleanup even after failure. IDs are comma-separated or an array. */
export function makeWorkspace (source: string, requested?: string | string[]): E2EWorkspace {
  const root = path.resolve(source)
  if (lstatSync(root).isSymbolicLink()) throw new Error(`E2E workspace refuses symlink: ${root}`)
  const dir = mkdtempSync(path.join(statSync(os.tmpdir()).dev === statSync(root).dev ? os.tmpdir() : path.dirname(root), 'rigsmith-e2e-'))
  const guard: Snapshot[] = []
  try {
    const charRoot = path.join(root, 'characters')
    const candidates = readdirSync(charRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
    const ids = requested === undefined ? [] : (Array.isArray(requested) ? requested : requested.split(',')).map(s => s.trim()).filter(Boolean)
    let selected: string[]
    if (ids.length > 0) selected = [...new Set(ids)]
    else {
      const described = candidates.map(id => {
        const c = JSON.parse(readFileSync(path.join(charRoot, id, 'character.json'), 'utf8')) as { folk?: unknown, gear?: Array<{ outfit?: string }> }
        return { id, folk: c.folk !== undefined || (c.gear ?? []).some(g => g.outfit !== undefined) }
      })
      selected = [described.find(c => c.folk)?.id, described.find(c => !c.folk)?.id].filter((id): id is string => id !== undefined)
    }
    if (selected.length === 0) throw new Error('E2E workspace has no selected characters')
    for (const id of selected) {
      if (!/^[a-z0-9-]+$/.test(id) || !candidates.includes(id)) throw new Error(`Unknown E2E character: ${id}`)
      copyTree(path.join(charRoot, id), path.join(dir, 'characters', id), false, guard)
    }
    for (const name of ['settings.json', 'game']) {
      const file = path.join(root, name)
      if (existsSync(file)) copyTree(file, path.join(dir, name), false, guard)
    }
    for (const name of ['clips', 'creatures', 'manifest.json', 'meta']) {
      const file = path.join(root, 'library', name)
      if (existsSync(file)) copyTree(file, path.join(dir, 'library', name), true, guard)
    }
    mkdirSync(path.join(dir, 'library'), { recursive: true })
    // A copied settings.json must not let Ship, Forge, or audio commands write to the real game checkout.
    const settingsFile = path.join(dir, 'settings.json')
    const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown> : {}
    const fakeGame = path.join(dir, 'game-repo')
    settings.gameRepo = fakeGame
    mkdirSync(path.join(fakeGame, 'tools', 'rigsmith'), { recursive: true })
    const units = path.join(dir, 'game', 'units.json')
    if (existsSync(units)) copyFileSync(units, path.join(fakeGame, 'tools', 'rigsmith', 'units.json'))
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
    return {
      dir, characters: selected,
      verify: () => {
        const changed = guard.filter(item => {
          try { const now = statSync(item.file, { bigint: true }); return now.mtimeNs !== item.mtime || now.size !== item.size || now.ino !== item.inode } catch { return true }
        })
        if (changed.length > 0) throw new Error(`Source library changed in place (${changed.length}): ${changed.slice(0, 5).map(x => x.file).join(', ')}`)
      },
      cleanup: () => { rmSync(dir, { recursive: true, force: true }) },
    }
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
}
