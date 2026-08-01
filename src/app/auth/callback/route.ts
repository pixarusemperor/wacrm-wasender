import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { CookieOptions } from '@supabase/ssr'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  const response = NextResponse.redirect(`${origin}${next}`)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          const cookieHeader = request.headers.get('cookie')
          if (!cookieHeader) return []
          return cookieHeader
            .split('; ')
            .map((cookie) => {
              const [name, ...v] = cookie.split('=')
              return { name: name || '', value: v.join('=') || '' }
            })
            .filter((c) => c.name)
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
          headers: Record<string, string> | undefined,
        ) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
          if (headers) {
            Object.entries(headers).forEach(([key, value]) => {
              response.headers.set(key, value)
            })
          }
        },
      },
    },
  )

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      const errorResponse = NextResponse.redirect(
        `${origin}/login?error=${encodeURIComponent(error.message)}`,
      )
      response.cookies.getAll().forEach((cookie) => {
        errorResponse.cookies.set(cookie)
      })
      return errorResponse
    }
  } else {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('Authentication code not found. Please try again.')}`,
    )
  }

  return response
}

export const dynamic = 'force-dynamic'
