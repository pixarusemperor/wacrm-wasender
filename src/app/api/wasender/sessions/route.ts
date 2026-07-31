import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { createSessionForAccount } from '@/lib/whatsapp/wasender-sessions'

/**
 * GET /api/wasender/sessions
 * List the caller's account sessions (RLS-scoped, secrets masked).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data: sessions, error } = await supabase
      .from('wasender_sessions')
      .select(
        'id, wats_session_id, name, phone_number, status, proxy_url, always_online, last_seen_at, created_at, updated_at'
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data: sessions ?? [] })
  } catch (err) {
    return handleErr(err)
  }
}

/**
 * POST /api/wasender/sessions
 * Create a new instance on behalf of the account (owner PAT flow).
 * Body: { name, phone_number, always_online?, proxy_url? }
 */
export async function POST(request: Request) {
  try {
    const { userId, accountId } = await requireRole('agent')

    const body = await request.json()
    const { name, phone_number, always_online, proxy_url } = body

    if (!name || !phone_number) {
      return NextResponse.json(
        { error: 'name and phone_number are required' },
        { status: 400 }
      )
    }

    const origin =
      process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
    const webhookUrl = `${origin.replace(/\/$/, '')}/api/whatsapp/webhook`

    const created = await createSessionForAccount(supabaseAdmin(), {
      accountId,
      userId,
      name,
      phoneNumber: phone_number,
      webhookUrl,
      alwaysOnline: always_online ?? false,
      proxyUrl: proxy_url ?? undefined,
    })

    return NextResponse.json({ data: created }, { status: 201 })
  } catch (err) {
    return handleErr(err)
  }
}

function handleErr(err: unknown) {
  const message = err instanceof Error ? err.message : 'Internal server error'
  console.error('[wasender/sessions]', message)
  return NextResponse.json({ error: message }, { status: 400 })
}
