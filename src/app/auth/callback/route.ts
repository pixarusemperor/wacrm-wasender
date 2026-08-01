import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { CookieOptions } from '@supabase/ssr'

function getOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim()
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
  if (forwardedHost && forwardedProto) {
    return `${forwardedProto}://${forwardedHost}`
  }

  return new URL(request.url).origin
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'
  const origin = getOrigin(request)

  const supabaseResponse = NextResponse.redirect(`${origin}${next}`)

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
            supabaseResponse.cookies.set(name, value, options)
          })
          if (headers) {
            Object.entries(headers).forEach(([key, value]) => {
              supabaseResponse.headers.set(key, value)
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
        `${origin}/login?error=${encodeURIComponent(error.message)}`
      )
      supabaseResponse.cookies.getAll().forEach((cookie) => {
        errorResponse.cookies.set(cookie)
      })
      return errorResponse
    }
  } else {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('Authentication code not found. Please try again.')}`
    )
  }

  return supabaseResponse
}

export const dynamic = 'force-dynamic'
