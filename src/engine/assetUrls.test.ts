// Files by what they hold (src/engine/assetUrls.ts): a character's file's URL with its hash, '/files/...' URLs taken
// apart, and versioned() leaving alone what it should (no resolver, a hash already, not a workspace file) and keeping
// a clip's '#Name' at the end.
import { afterEach, describe, expect, it } from 'vitest'
import { characterFileUrl, parseFilesUrl, setAssetResolver, versioned, withHash } from './assetUrls.ts'

afterEach(() => { setAssetResolver(null) })

describe('asset URLs', () => {
  it('names a character\'s file, with its hash when known', () => {
    expect(characterFileUrl('folk-1', 'skins/a b.png')).toBe('/files/characters/folk-1/skins/a%20b.png')
    expect(characterFileUrl('folk-1', 'rigged.glb', 'abc')).toBe('/files/characters/folk-1/rigged.glb?h=abc')
  })

  it('takes /files URLs apart', () => {
    expect(parseFilesUrl('/files/characters/folk-1/skins/a%20b.png?h=1')).toEqual({ character: 'folk-1', file: 'skins/a b.png' })
    expect(parseFilesUrl('/files/library/clips/mixamo-Walk.glb#Walk')).toEqual({ character: null, file: 'clips/mixamo-Walk.glb' })
    expect(parseFilesUrl('/animations/human-basic.glb#Idle')).toBeNull()
  })

  it('puts the hash before a fragment', () => {
    expect(withHash('/files/library/x.glb#Run', 'h1')).toBe('/files/library/x.glb?h=h1#Run')
    expect(withHash('/files/library/x.glb', undefined)).toBe('/files/library/x.glb')
  })

  it('versions through the resolver, only workspace files without a hash', () => {
    expect(versioned('/files/library/clips/a.glb')).toBe('/files/library/clips/a.glb')
    setAssetResolver(url => withHash(url, 'zz'))
    expect(versioned('/files/library/clips/a.glb')).toBe('/files/library/clips/a.glb?h=zz')
    expect(versioned('/files/library/clips/a.glb?h=yy')).toBe('/files/library/clips/a.glb?h=yy')
    expect(versioned('/animations/a.glb')).toBe('/animations/a.glb')
  })
})
