// Ids of things inside a character (gear, slots, adjustments, hand poses, layers). Reducers never make them: the
// caller does (newId) and puts them in the command, so the app's optimistic copy and the server's agree. A migration
// derives them from what it migrates (stableId), so every process migrating the same file gets the same ids.

/** 8 lowercase hex characters, random. */
export function newId (): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** FNV-1a, 32 bits, over the string's UTF-8 bytes. */
export function fnv1a (s: string): number {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193)
  return h >>> 0
}

export const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')

/** The same 8 hex characters for the same seed, everywhere. */
export function stableId (seed: string): string {
  return hex8(fnv1a(seed))
}
