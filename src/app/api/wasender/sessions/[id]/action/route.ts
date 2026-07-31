import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  disconnectStoredSession,
  restartStoredSession,
  deleteStoredSession,
} from '@/lib/whatsapp/wasender-sessions'

type Params = Promise<{ id: string }>

/**
 * POST /api/wasender/sessions/[id]/disconnect
 * POST /api/wasender/sessions/[id]/restart
 * POST /api/wasender/sessions/[id]/delete
 */
export async function POST(
  request: Request,
  { params }: { params: Params }
) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await params
    const path = new URL(request.url).pathname

    if (path.endsWith('/disconnect')) {
      await disconnectStoredSession(supabaseAdmin(), accountId, id)
    } else if (path.endsWith('/restart')) {
      await restartStoredSession(supabaseAdmin(), accountId, id)
    } else if (path.endsWith('/delete')) {
      await deleteStoredSession(supabaseAdmin(), accountId, id)
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[wasender/sessions/action]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
