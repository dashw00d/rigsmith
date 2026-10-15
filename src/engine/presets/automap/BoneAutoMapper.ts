import { BoneCategoryMapper } from './BoneCategoryMapper'
import { CanonicalSlotMapper } from './CanonicalSlotMapper'

// re-exported so existing imports from './BoneAutoMapper' keep working
export { BoneCategory, BoneSide, BoneSlot, type BoneMetadata } from './BoneTypes'
import { type BoneMetadata } from './BoneTypes'

/**
 * BoneAutoMapper - Handles automatic bone mapping between source and target skeletons
 * Source = Mesh2Motion skeleton (draggable bones)
 * Target = Uploaded mesh skeleton (drop zones)
 *
 * Rigs that match a known template (Mixamo, Rigify) go through that template's
 * exact table. Everything else goes through canonical slot resolution, which
 * reduces both skeletons to (joint, side, position-in-chain) and matches on that -
 * see BoneSlotVocabulary and BoneChainResolver.
 */
export class BoneAutoMapper {
  /**
   * Map an arbitrarily named rig in three passes.
   *
   * Exact names go first: if two rigs literally agree on a bone name, nothing the
   * vocabulary infers should overrule that. Canonical slots handle the rest of the
   * humanoid skeleton, and a final loose-name pass picks up anything anatomical the
   * vocabulary has no word for - custom animal chains, accessory bones.
   *
   * Each pass carries the accumulated map forward, so a source bone claimed by one
   * pass can never be handed out again by a later one.
   *
   * Kept separate from auto_map_bones so it can be unit tested without a three.js scene.
   */
  public static map_by_canonical_slots (
    source_bones_meta: BoneMetadata[], target_bones_meta: BoneMetadata[]
  ): Map<string, string> {
    const exact_mappings = BoneCategoryMapper.match_exact_names(
      source_bones_meta, target_bones_meta, new Map()
    )

    const slot_mappings = CanonicalSlotMapper.map_bones(
      source_bones_meta, target_bones_meta, exact_mappings
    )

    const mappings = BoneCategoryMapper.match_loose_names(
      source_bones_meta, target_bones_meta, slot_mappings
    )

    return mappings
  }

}
