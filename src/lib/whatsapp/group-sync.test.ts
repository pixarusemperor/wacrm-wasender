import { describe, it, expect, vi, afterEach } from 'vitest'
import { encrypt } from './encryption'
import { syncGroupsForSession } from './group-sync'

function enc(s: string): string {
  return encrypt(s)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('syncGroupsForSession', () => {
  function mockAdmin(overrides: { groupRow?: boolean } = {}) {
    const upsertGroup = vi.fn().mockResolvedValue({
      data: { id: 'group-1' },
      error: null,
    })
    const selectMembers = vi.fn().mockResolvedValue({ data: [], error: null })
    const insertMember = vi.fn().mockResolvedValue({ error: null })
    const insertActivity = vi.fn().mockResolvedValue({ error: null })

    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'wasender_sessions') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'sess-1', wats_api_key: enc('sess-key-1') },
                    error: null,
                  }),
                })),
              })),
            })),
          }
        }
        if (table === 'wasender_groups') {
          return {
            upsert: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'group-1' },
                  error: null,
                }),
              })),
            })),
          }
        }
        if (table === 'wasender_group_members') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                is: vi.fn().mockResolvedValue({ data: [], error: null }),
              })),
            })),
            insert: insertMember,
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({ error: null }),
              })),
            })),
          }
        }
        if (table === 'wasender_group_activity') {
          return { insert: insertActivity }
        }
        return {}
      }),
    } as unknown as Parameters<typeof syncGroupsForSession>[0]

    return { admin, upsertGroup, selectMembers, insertMember, insertActivity }
  }

  it('syncs groups and joins new members', async () => {
    const { admin, insertMember, insertActivity } = mockAdmin()

    // Provider responses: groups list then participants per group.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          success: true,
          data: [{ jid: '123456789-987654321@g.us', name: 'Team', imgUrl: null }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          success: true,
          data: [{ id: '111@s.whatsapp.net', admin: 'superadmin' }],
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncGroupsForSession(admin, 'acct-1', 'sess-1')

    expect(result.success).toBe(true)
    expect(result.groupsSynced).toBe(1)
    expect(result.membersSynced).toBe(1)
    // The provider call used the DECRYPTED session key.
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sess-key-1'
    )
    expect(insertMember).toHaveBeenCalled()
    expect(insertActivity).toHaveBeenCalled()
  })

  it('returns an error when the session is missing', async () => {
    const admin = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: { message: 'x' } }),
            })),
          })),
        })),
      })),
    } as unknown as Parameters<typeof syncGroupsForSession>[0]

    const result = await syncGroupsForSession(admin, 'acct-1', 'sess-1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Session not found')
  })

  it('saves the group even when participant sync fails', async () => {
    const { admin } = mockAdmin()

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          success: true,
          data: [{ jid: '123@g.us', name: 'G', imgUrl: null }],
        }),
      })
      .mockRejectedValueOnce(new Error('participants api down'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncGroupsForSession(admin, 'acct-1', 'sess-1')
    expect(result.success).toBe(true)
    expect(result.groupsSynced).toBe(1)
  })
})
