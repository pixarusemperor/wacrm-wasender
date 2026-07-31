import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/whatsapp/media/[mediaId]
 *
 * WasenderApi has no Meta-style media IDs — inbound media is decrypted
 * and stored to Supabase Storage by the webhook (see wasender-media.ts),
 * and `messages.media_url` holds the permanent public URL directly.
 *
 * This route is kept for URL compatibility: it looks up the message by
 * its `message_id` (WasenderApi key.id) and redirects to the stored
 * media URL. The inbox renders `media_url` directly, so this is a
 * fallback for legacy clients that still call `/api/whatsapp/media/{id}`.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params
    if (!mediaId) {
      return NextResponse.json({ error: 'Media ID is required' }, { status: 400 })
    }

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
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      )
    }

    // Find the message by its provider message_id, scoped to the account.
    const { data: msg } = await supabase
      .from('messages')
      .select('media_url, conversations!inner(account_id)')
      .eq('message_id', mediaId)
      .eq('conversations.account_id', accountId)
      .limit(1)
      .maybeSingle()

    if (!msg?.media_url) {
      return NextResponse.json({ error: 'Media not found' }, { status: 404 })
    }

    // The stored media_url is a permanent Supabase Storage URL — redirect
    // so the inbox can render it directly.
    return NextResponse.redirect(msg.media_url, 302)
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500 })
  }
}
