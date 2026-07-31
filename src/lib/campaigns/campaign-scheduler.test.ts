import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  shuffle,
  generateBroadcastSchedule,
  generateBulkSchedule,
  type CampaignEventInput,
} from './campaign-scheduler'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shuffle (Fisher-Yates)', () => {
  it('preserves all elements', () => {
    const input = [1, 2, 3, 4, 5]
    const out = shuffle(input)
    expect([...out].sort()).toEqual([...input].sort())
    // Original untouched.
    expect(input).toEqual([1, 2, 3, 4, 5])
  })
})

describe('generateBroadcastSchedule (Type 2)', () => {
  it('creates product × group events with increasing timestamps', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // deterministic shuffle+ints
    const events = generateBroadcastSchedule(
      ['p1', 'p2'],
      ['g1', 'g2'],
      new Date('2026-01-01T00:00:00Z'),
      10,
      20,
      0, // no start jitter
      30,
      40
    )

    expect(events).toHaveLength(4)
    // All events reference valid products.
    for (const e of events) {
      expect(['p1', 'p2']).toContain(e.product_id)
      expect(['g1', 'g2']).toContain(e.group_jid)
    }
    // Strictly increasing schedule.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].scheduled_at.getTime()).toBeGreaterThan(
        events[i - 1].scheduled_at.getTime()
      )
    }
    // Every group appears once per product wave (2 waves × 2 groups).
    const p1 = events.filter((e) => e.product_id === 'p1')
    expect(new Set(p1.map((e) => e.group_jid)).size).toBe(2)
  })

  it('returns [] when either list is empty', () => {
    expect(
      generateBroadcastSchedule([], ['g1'], new Date(), 1, 2)
    ).toEqual([])
    expect(
      generateBroadcastSchedule(['p1'], [], new Date(), 1, 2)
    ).toEqual([])
  })

  it('respects wave_start_times for manual waves', () => {
    const start = new Date('2026-01-01T00:00:00Z')
    const wave2 = new Date('2026-01-02T00:00:00Z')
    const events = generateBroadcastSchedule(
      ['p1', 'p2'],
      ['g1', 'g2'],
      start,
      10,
      20,
      0,
      60,
      120,
      [start, wave2]
    )
    // The p2 wave's first event lands exactly on wave2.
    const p2First = events.find(
      (e) => e.product_id === 'p2' && e.send_order === 0
    )!
    expect(p2First.scheduled_at.getTime()).toBe(wave2.getTime())
  })
})

describe('generateBulkSchedule (Type 1)', () => {
  it('creates product × group events with increasing timestamps', () => {
    // Real randomness so the consecutive-batch constraint check can
    // actually satisfy itself via reshuffle. Use 3+ groups so the
    // first-group constraint is reliably satisfiable (with 2 groups
    // the 50-attempt reshuffle can still exhaust).
    const events = generateBulkSchedule(
      ['p1', 'p2', 'p3'],
      ['g1', 'g2', 'g3'],
      new Date('2026-01-01T00:00:00Z'),
      10,
      20,
      0
    )

    expect(events).toHaveLength(9)
    for (let i = 1; i < events.length; i++) {
      expect(events[i].scheduled_at.getTime()).toBeGreaterThan(
        events[i - 1].scheduled_at.getTime()
      )
    }
    // Consecutive batches must not start with the same group.
    const batch0 = events.filter((e) => e.batch_index === 0)
    const batch1 = events.filter((e) => e.batch_index === 1)
    expect(batch0[0].group_jid).not.toBe(batch1[0].group_jid)
  })
})

describe('type-level: CampaignEventInput is the exact persisted shape', () => {
  it('carries product_id, group_jid, batch_index, send_order, scheduled_at', () => {
    const e: CampaignEventInput = {
      product_id: 'p',
      group_jid: 'g',
      batch_index: 0,
      send_order: 0,
      scheduled_at: new Date(),
    }
    expect(e.product_id).toBe('p')
  })
})
