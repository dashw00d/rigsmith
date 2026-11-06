// Schema 4's character (src/model/types.ts before schema 5), as old files hold it: schema 5's without the folk section
// and the cloth layers (a dynamic character's outfits were Gear.outfit, its hair and beards Gear.role, its clothes
// look.clothes; src/model/folk.ts folkFromLegacy reads them). The migration (src/model/migrate.ts toV5) reads it.
import type { Character, LookSection } from './types.ts'

export type V4Character = Omit<Character, 'schema' | 'folk' | 'look'> & { schema: 4, look: Omit<LookSection, 'cloth'> }
