import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  createSessionForAccount,
  deleteStoredSession,
} from '@/lib/whatsapp/wasender-sessions'

/**
 * /api/whatsapp/config — replaced by the WasenderApi session flow.
 *
 * The old endpoint connected a Meta WABA (phone_number_id + access
 * token). WasenderApi uses per-account sessions created via the OWNER
 * PAT. This route keeps the same URL so the Settings UI works, but:
 *   GET    → reports the account's connected sessions
 *   POST   → creates a WasenderApi session (owner PAT) for the account
 *   DELETE → deletes all of the account's sessions
 */

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data: sessions, error } = await supabase
      .from('wasender_sessions')
      .select(
        'id, name, phone_number, status, always_online, proxy_url, created_at'
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: error.message },
        { status: 200 }
      )
    }

    const connected = (sessions ?? []).some((s) => s.status === 'connected')
    return NextResponse.json({
      connected,
      reason: connected ? 'connected' : 'no_config',
      sessions: sessions ?? [],
      message: connected
        ? 'A WasenderApi session is connected.'
        : 'No connected WasenderApi session. Create one below.',
    })
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, userId, accountId } = await requireRole('agent')
    const body = await request.json()
    const { name, phone_number, always_online } = body

    if (!name || !phone_number) {
      return NextResponse.json(
        { error: 'name and phone_number are required' },
        { status: 400 }
      )
    }

    const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
    const webhookUrl = `${origin.replace(/\/$/, '')}/api/whatsapp/webhook`

    const created = await createSessionForAccount(supabaseAdmin(), {
      accountId,
      userId,
      name,
      phoneNumber: phone_number,
      webhookUrl,
      alwaysOnline: always_online ?? false,
    })

    // Re-read through RLS so the UI gets the masked row.
    const { data: row } = await supabase
      .from('wasender_sessions')
      .select('id, name, phone_number, status, wats_session_id')
      .eq('id', created.id)
      .single()

    return NextResponse.json({ success: true, session: row ?? created })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE() {
  try {
    const { accountId } = await getCurrentAccount()

    const { data: sessions } = await supabaseAdmin()
      .from('wasender_sessions')
      .select('id')
      .eq('account_id', accountId)

    for (const s of sessions ?? []) {
      await deleteStoredSession(supabaseAdmin(), accountId, s.id).catch(() =>
        undefined
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
