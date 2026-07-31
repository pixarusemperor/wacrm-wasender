import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { connectStoredSession } from '@/lib/whatsapp/wasender-sessions'

type Params = Promise<{ id: string }>

/**
 * POST /api/wasender/sessions/[id]/connect
 * Body: { link_method?: 'qr' | 'passkey' }
 * Returns { data: { status: 'NEED_SCAN', qrCode } | ... }
 */
export async function POST(request: Request, { params }: { params: Params }) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const linkMethod = body.link_method === 'passkey' ? 'passkey' : 'qr'

    const result = await connectStoredSession(supabaseAdmin(), accountId, id, linkMethod)
    return NextResponse.json({ data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[wasender/sessions/connect]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
