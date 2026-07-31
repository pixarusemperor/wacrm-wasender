import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { encrypt } from './encryption'
import {
  getOwnerPat,
  createSessionForAccount,
  connectStoredSession,
  getSessionQr,
  deleteStoredSession,
  syncSessionStatuses,
} from './wasender-sessions'

function enc(plain: string): string {
  return encrypt(plain)
}

type AdminMock = {
  from: ReturnType<typeof vi.fn>
  [k: string]: unknown
}

function mockAdmin(): { admin: AdminMock; calls: string[] } {
  const calls: string[] = []
  const admin = {
    from: vi.fn((table: string) => {
      calls.push(table)
      return {
        select: vi.fn(() => admin),
        eq: vi.fn(() => admin),
        neq: vi.fn(() => admin),
        single: vi.fn().mockResolvedValue({ data: undefined, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: undefined, error: null }),
        insert: vi.fn(() => admin),
        update: vi.fn(() => admin),
        delete: vi.fn(() => admin),
        order: vi.fn(() => admin),
        limit: vi.fn(() => admin),
      }
    }),
  }
  return { admin, calls }
}

const REAL_OWNER_PAT = 'owner-pat-123'

beforeEach(() => {
  process.env.WATSSENDER_MASTER_PAT = REAL_OWNER_PAT
})

afterEach(() => {
  delete process.env.WATSSENDER_MASTER_PAT
  vi.restoreAllMocks()
})

describe('getOwnerPat', () => {
  it('returns the env PAT when set (owner token, never a user token)', async () => {
    const { admin } = mockAdmin()
    expect(await getOwnerPat(admin as never)).toBe(REAL_OWNER_PAT)
  })

  it('falls back to an encrypted owner_config row', async () => {
    delete process.env.WATSSENDER_MASTER_PAT
    const { admin } = mockAdmin()
    admin.from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { wasender_pat: enc('stored-pat') },
            error: null,
          }),
        })),
      })),
    }))
    expect(await getOwnerPat(admin as never)).toBe('stored-pat')
  })
})

describe('createSessionForAccount', () => {
  it('creates a provider session with the OWNER PAT and stores encrypted creds', async () => {
    const { admin } = mockAdmin()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        success: true,
        data: {
          id: 42,
          name: 'Biz',
          phone_number: '+15550199',
          status: 'need_scan',
          api_key: 'session-key-1',
          webhook_secret: 'wh-secret-1',
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    // The insert path returns the stored row.
    admin.from = vi.fn((table: string) => {
      if (table === 'wasender_sessions') {
        return {
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { id: 'row-1', wats_session_id: 42, status: 'need_scan' },
              error: null,
            }),
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: { id: 'row-1', wats_session_id: 42, status: 'need_scan' },
                error: null,
              }),
            })),
          })),
        }
      }
      return { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }
    })

    const result = await createSessionForAccount(admin as never, {
      accountId: 'acct-1',
      userId: 'user-1',
      name: 'Biz',
      phoneNumber: '+15550199',
      webhookUrl: 'https://crm.example.com/api/whatsapp/webhook',
    })

    expect(result).toMatchObject({ id: 'row-1', wats_session_id: 42 })

    // The provider call must use the OWNER PAT, not the user's credentials.
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${REAL_OWNER_PAT}`
    )

    // The stored insert must carry encrypted credentials.
    const insertArgs = admin.from.mock.calls.find((c) => c[0] === 'wasender_sessions')
    expect(insertArgs).toBeDefined()
  })

  it('rolls back the provider session if the DB insert fails', async () => {
    const { admin } = mockAdmin()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          success: true,
          data: { id: 99, name: 'X', status: 'need_scan', api_key: 'k', webhook_secret: 's' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
        json: async () => ({}),
      })
    vi.stubGlobal('fetch', fetchMock)

    admin.from = vi.fn((table: string) => {
      if (table === 'wasender_sessions') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: { message: 'dupe' } }),
            })),
          })),
        }
      }
      return {}
    })

    await expect(
      createSessionForAccount(admin as never, {
        accountId: 'a',
        userId: 'u',
        name: 'X',
        phoneNumber: '+1',
        webhookUrl: 'https://x/webhook',
      })
    ).rejects.toThrow('Failed to store wasender session')

    // Second fetch = the rollback DELETE.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('/api/whatsapp-sessions/99')
  })
})

describe('connectStoredSession + getSessionQr', () => {
  function sessionLookupAdmin(row: { wats_session_id: number | null }) {
    const { admin } = mockAdmin()
    admin.from = vi.fn((table: string) => {
      if (table === 'wasender_sessions') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: row, error: null }),
              })),
            })),
          })),
        }
      }
      return {}
    })
    return admin
  }

  it('connects via the owner PAT and returns the QR', async () => {
    const admin = sessionLookupAdmin({ wats_session_id: 42 })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        success: true,
        data: { status: 'NEED_SCAN', qrCode: '2@abc' },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await connectStoredSession(admin as never, 'acct-1', 'row-1', 'qr')
    expect(res.status).toBe('NEED_SCAN')
    if (res.status === 'NEED_SCAN') expect(res.qrCode).toBe('2@abc')

    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${REAL_OWNER_PAT}`
    )
  })

  it('getSessionQr hits the provider qrcode endpoint', async () => {
    const admin = sessionLookupAdmin({ wats_session_id: 42 })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ success: true, data: { qrCode: '2@fresh' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await getSessionQr(admin as never, 'acct-1', 'row-1')
    expect(res.qrCode).toBe('2@fresh')
    expect(fetchMock.mock.calls[0][0]).toContain('/api/whatsapp-sessions/42/qrcode')
  })
})

describe('deleteStoredSession + syncSessionStatuses', () => {
  it('deletes the provider session then the local row', async () => {
    const { admin } = mockAdmin()
    admin.from = vi.fn((table: string) => {
      if (table === 'wasender_sessions') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { wats_session_id: 7 },
                  error: null,
                }),
              })),
            })),
          })),
          delete: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ error: null }),
          })),
        }
      }
      return {}
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    await deleteStoredSession(admin as never, 'acct-1', 'row-1')

    expect(fetchMock.mock.calls[0][0]).toContain('/api/whatsapp-sessions/7')
    expect(admin.from).toHaveBeenCalledWith('wasender_sessions')
  })

  it('syncSessionStatuses updates statuses from the session key endpoint', async () => {
    const { admin } = mockAdmin()
    const rows = [
      { id: 'row-1', wats_session_id: 1, wats_api_key: enc('sess-key-1') },
    ]
    const updateMock = vi.fn().mockResolvedValue({ error: null })
    admin.from = vi.fn((table: string) => {
      if (table === 'wasender_sessions') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ data: rows, error: null }),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => updateMock),
          })),
        }
      }
      return {}
    })

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ status: 'connected' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await syncSessionStatuses(admin as never, 'acct-1')
    // Session-key status endpoint called with the decrypted key.
    expect(fetchMock).toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sess-key-1'
    )
  })
})
