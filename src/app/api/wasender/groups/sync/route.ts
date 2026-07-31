import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { syncGroupsForSession } from '@/lib/whatsapp/group-sync'

/**
 * POST /api/wasender/groups/sync
 * Body: { session_id }
 * Pull the session's groups + members from WasenderApi.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const body = await request.json()
    const { session_id } = body
    if (!session_id) {
      return NextResponse.json({ error: 'session_id is required' }, { status: 400 })
    }
    const result = await syncGroupsForSession(supabaseAdmin(), accountId, session_id)
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[wasender/groups/sync]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
