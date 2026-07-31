import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Replaced by the wasender session status endpoint. WasenderApi has no
 * Meta-style phone/WABA registration — the equivalent "is my WhatsApp
 * live?" check is the session status (see /api/wasender/sessions and
 * the `session.status` webhook). This route returns a structured
 * diagnostic the UI can badge on.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({
      live: false,
      message: 'Your profile is not linked to an account.',
    })
  }

  // Any connected wasender session ⇒ the account is live.
  const { data: sessions } = await supabase
    .from('wasender_sessions')
    .select('id')
    .eq('account_id', accountId)
    .eq('status', 'connected')
    .limit(1)

  const connected = !!sessions && sessions.length > 0
  return NextResponse.json({
    live: connected,
    checks: {
      session_connected: connected,
    },
    message: connected
      ? 'A WasenderApi session is connected.'
      : 'No connected WasenderApi session. Add one in Settings → WhatsApp.',
  })
}
