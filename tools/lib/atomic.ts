// Writing a build's files so a reader never sees half of one and an unchanged file is left alone: the bytes are
// compared with what is there first (the same: nothing written, its mtime kept, so Godot doesn't import it again),
// else written to a temp file beside it and renamed over it (a reader sees the old file or the new one, whole).
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const sameBytes = (file: string, bytes: Uint8Array): boolean => {
  let size: number
  try { size = statSync(file).size } catch { return false }
  if (size !== bytes.byteLength) return false
  return Buffer.compare(readFileSync(file), bytes) === 0
}

/** `data` written to `file` whole (temp + rename), unless the file holds those bytes already. True when written. */
export function writeIfChanged (file: string, data: string | Uint8Array): boolean {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  if (sameBytes(file, bytes)) return false
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`)
  try {
    writeFileSync(temp, bytes)
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return true
}

/** `from` copied to `to` the same way (left alone when `to` holds its bytes already). True when written. */
export function copyIfChanged (from: string, to: string): boolean {
  return writeIfChanged(to, readFileSync(from))
}
