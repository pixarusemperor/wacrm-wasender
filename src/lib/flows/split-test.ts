/**
 * Split-test variant selection — ported from WassFlow's
 * `variant-selector.ts`, adapted to WaCRM's flow nodes.
 *
 * Decision encoded in the types: a split_test routes a contact to
 * ONE of N target nodes. Selection is deterministic per contact
 * (same contact → same variant across runs), which keeps A/B
 * attribution stable. `weight` allows future weighted rotation;
 * today the selector does a simple deterministic hash mod N.
 *
 * Pure — no DB, no network. Unit-testable.
 */

/** A stable contact identifier (any string is fine: UUID, phone, jid). */
export type ContactKey = string & { readonly __brand: 'ContactKey' };

export interface SplitVariant {
  /** The flow node_key this variant routes to. */
  targetNodeKey: string;
  /** Variant name, e.g. "Short", "Detailed", "With CTA". */
  name: string;
  /** Relative weight — equal weights → uniform distribution. */
  weight: number;
}

/**
 * Choose the variant a contact gets. Deterministic per contact:
 * the same contact key always maps to the same variant (stable
 * across runs, so response attribution is meaningful).
 */
export function selectVariantForContact(
  variants: readonly SplitVariant[],
  contactKey: ContactKey
): SplitVariant {
  if (variants.length === 0) {
    throw new Error('split_test requires at least one variant');
  }

  // Weighted index. For equal weights this degenerates to hash % N.
  const totalWeight = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  const normalized = totalWeight > 0 ? totalWeight : variants.length;

  const hash = simpleHash(contactKey);
  const raw = Math.abs(hash) % normalized;

  // Walk the weight bands.
  let acc = 0;
  for (const v of variants) {
    acc += Math.max(0, v.weight) || 1;
    if (raw < acc) return v;
  }
  return variants[variants.length - 1];
}

/**
 * Very small deterministic hash (FNV-1a variant). Not crypto — just
 * enough to spread contacts evenly.
 */
function simpleHash(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
