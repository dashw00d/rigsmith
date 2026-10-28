// For tools that write the workspace directly (tools/migrate.ts, tools/apply.ts): they may only while no Rigsmith
// server runs. A server keeps each character's lock and journal numbering in memory, so a second writer beside it
// could interleave writes or number two journal entries the same.

/** Where a Rigsmith server listens on this machine: dev (vite.config.ts), preview, and the rebuild sandbox's dev. */
const PORTS = [5180, 5181, 5190]

/** The address of a Rigsmith server that answers (its job list), or null when none does. */
export async function runningServer (): Promise<string | null> {
  const found = await Promise.all(PORTS.map(async port => {
    const url = `http://127.0.0.1:${port}`
    try {
      const res = await fetch(`${url}/api/jobs`, { signal: AbortSignal.timeout(800) })
      return res.ok && Array.isArray(await res.json()) ? url : null
    } catch {
      return null
    }
  }))
  return found.find(url => url !== null) ?? null
}

/** The flag that goes on anyway: for a server that serves another workspace (the owner's own tool on 5180 while
 * working in a copy of it). */
export const IGNORE_SERVER = '--ignore-server'
