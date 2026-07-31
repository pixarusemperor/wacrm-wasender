import { describe, it, expect } from 'vitest'
import { expectTypeOf } from 'vitest'
import { selectVariantForContact, type ContactKey, type SplitVariant } from './split-test'

const variants: SplitVariant[] = [
  { targetNodeKey: 'node_a', name: 'Short', weight: 1 },
  { targetNodeKey: 'node_b', name: 'Detailed', weight: 1 },
]

function ck(s: string): ContactKey {
  return s as ContactKey
}

describe('selectVariantForContact', () => {
  it('is deterministic — same contact always gets the same variant', () => {
    const a1 = selectVariantForContact(variants, ck('contact-42'))
    const a2 = selectVariantForContact(variants, ck('contact-42'))
    expect(a1.targetNodeKey).toBe(a2.targetNodeKey)
  })

  it('returns a valid variant for any contact', () => {
    for (let i = 0; i < 50; i++) {
      const v = selectVariantForContact(variants, ck(`contact-${i}`))
      expect(['node_a', 'node_b']).toContain(v.targetNodeKey)
    }
  })

  it('distributes across variants (both appear in a modest sample)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      seen.add(selectVariantForContact(variants, ck(`c-${i}`)).targetNodeKey)
    }
    expect(seen.size).toBe(2)
  })

  it('throws when no variants are configured', () => {
    expect(() => selectVariantForContact([], ck('x'))).toThrow(
      'split_test requires at least one variant'
    )
  })

  it('respects weights (a 3:1 split skews toward the heavy variant)', () => {
    const weighted: SplitVariant[] = [
      { targetNodeKey: 'heavy', name: 'H', weight: 3 },
      { targetNodeKey: 'light', name: 'L', weight: 1 },
    ]
    let heavy = 0
    const total = 400
    for (let i = 0; i < total; i++) {
      if (selectVariantForContact(weighted, ck(`w-${i}`)).targetNodeKey === 'heavy') heavy++
    }
    // 3:1 → expect ~75%; allow generous slack for the deterministic hash.
    expect(heavy).toBeGreaterThan(total * 0.55)
    expect(heavy).toBeLessThan(total * 0.95)
  })

  it('type-level: ContactKey is branded (raw string not assignable)', () => {
    expectTypeOf<ContactKey>().not.toEqualTypeOf<string>()
  })
})
