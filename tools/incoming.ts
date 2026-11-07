// Validate a gear-tool delivery before publishing it to Incoming.
import path from 'node:path'
import { readPackage } from '../server/incoming/read.ts'
const [, , command, dir] = process.argv
if (command !== 'validate' || !dir || process.argv.length !== 4) {
  console.error('Usage: node tools/incoming.ts validate DIR'); process.exitCode = 2
} else {
  try {
    const { manifest, errors } = await readPackage(path.resolve(dir), { staging: true })
    const failures = errors.flatMap((error, i) => error ? [`${manifest.parts[i]?.id ?? i}: ${error}`] : [])
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 } else console.log(`OK ${manifest.id}: ${manifest.parts.length} parts`)
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
