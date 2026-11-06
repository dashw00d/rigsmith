// Workspace files by what they hold: a file's URL carries its content hash (/files/...?h=<hash>, server/files.ts), so
// a cache keyed by the URL can never hold old bytes and the browser keeps the file for good. The app's manifests
// (src/state/assets.svelte.ts) give the hashes and set the resolver; without one (the tools, the tests) a URL stays as
// it is. Identity URLs (a clip ref's '/files/library/clips/<id>.glb') stay plain everywhere they are compared or
// stored: only loaders call versioned().

/** A character's file's URL inside its folder, with its hash when known. */
export function characterFileUrl (id: string, file: string, hash?: string | null): string {
  const base = `/files/characters/${encodeURIComponent(id)}/${file.split('/').map(encodeURIComponent).join('/')}`
  return hash === undefined || hash === null ? base : `${base}?h=${hash}`
}

/** Where a '/files/...' URL points: a character's file (its id, its path inside the folder) or the library's (path
 * inside library/). Null for anything else (a bundled /animations/ file, an object URL). */
export function parseFilesUrl (url: string): { character: string | null, file: string } | null {
  const bare = url.split(/[?#]/)[0]
  let m = /^\/files\/characters\/([^/]+)\/(.+)$/.exec(bare)
  if (m !== null) {
    try { return { character: decodeURIComponent(m[1]), file: m[2].split('/').map(decodeURIComponent).join('/') } } catch { return null }
  }
  m = /^\/files\/library\/(.+)$/.exec(bare)
  if (m !== null) {
    try { return { character: null, file: m[1].split('/').map(decodeURIComponent).join('/') } } catch { return null }
  }
  return null
}

type Resolver = (url: string) => string
let resolver: Resolver | null = null

/** The app's hashes (src/state/assets.svelte.ts); null: URLs as they are. */
export function setAssetResolver (fn: Resolver | null): void { resolver = fn }

/** A '/files/...' URL with its content hash (kept as it is when it has one, its hash isn't known, or it is no workspace
 * file); a '#Name' fragment (a clip in a file of several) stays at the end. */
export function versioned (url: string): string {
  if (resolver === null || !url.startsWith('/files/') || /[?&]h=/.test(url)) return url
  return resolver(url)
}

/** A versioned URL put back together: `url`'s path, then ?h=, then its fragment. */
export function withHash (url: string, hash: string | undefined): string {
  if (hash === undefined) return url
  const [rest, fragment] = url.split('#', 2)
  return `${rest}${rest.includes('?') ? '&' : '?'}h=${hash}${fragment === undefined ? '' : `#${fragment}`}`
}
