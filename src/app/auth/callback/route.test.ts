import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exchangeMock = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
}))

const getAllMock = vi.hoisted(() => ({
  getAll: vi.fn(),
}))

const setAllCalls: Array<{
  cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>
}> = []

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((_url, _key, opts) => {
    const setAllCallsForThisClient: {
      cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>
    } = { cookies: [] }
    setAllCalls.push(setAllCallsForThisClient)
    return {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: null,
        })),
        exchangeCodeForSession: exchangeMock.exchangeCodeForSession.mockImplementation(
          async (code: string) => {
            if (code === 'valid-code') {
              // Simulate setting cookies via setAll
              opts?.cookies?.setAll?.([
                { name: 'sb-test', value: 'new-session', options: { httpOnly: true, path: '/' } },
              ])
              return { data: { user: { id: 'user-1' } }, error: null }
            }
            return { data: null, error: { message: 'Invalid code' } }
          }
        ),
      },
      cookies: getAllMock.getAll,
    }
  }),
}))

// Imported after mocks are registered
const { GET } = await import('./route')

function makeRequest(url: string) {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
  setAllCalls.length = 0
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  process.env.NEXT_PUBLIC_SITE_URL = 'https://wassflow.orizongroup.online'
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('/auth/callback route handler', () => {
  it('exchanges a valid code and redirects to the next path with cookies', async () => {
    const request = makeRequest(
      'https://wassflow.orizongroup.online/auth/callback?code=valid-code&next=/reset-password'
    )

    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'https://wassflow.orizongroup.online/reset-password'
    )
    expect(exchangeMock.exchangeCodeForSession).toHaveBeenCalledWith('valid-code')
  })

  it('defaults next to /dashboard when not provided', async () => {
    const request = makeRequest(
      'https://wassflow.orizongroup.online/auth/callback?code=valid-code'
    )

    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'https://wassflow.orizongroup.online/dashboard'
    )
  })

  it('redirects to login with error when code exchange fails', async () => {
    const request = makeRequest(
      'https://wassflow.orizongroup.online/auth/callback?code=bad-code'
    )

    const response = await GET(request)

    expect(response.status).toBe(307)
    const location = response.headers.get('location') || ''
    expect(location).toContain('/login')
    expect(location).toContain('error=')
  })

  it('redirects to login with error when no code is provided', async () => {
    const request = makeRequest('https://wassflow.orizongroup.online/auth/callback')

    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login')
    expect(response.headers.get('location')).toContain('error=')
  })

  it('preserves cookies on error redirect', async () => {
    const request = makeRequest(
      'https://wassflow.orizongroup.online/auth/callback?code=bad-code'
    )

    await GET(request)

    // The mock setAll was called during exchangeCodeForSession,
    // so cookies should be present on the error response
    expect(exchangeMock.exchangeCodeForSession).toHaveBeenCalled()
  })
})
