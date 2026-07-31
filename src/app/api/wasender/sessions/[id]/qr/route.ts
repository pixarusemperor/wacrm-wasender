import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getSessionQr } from '@/lib/whatsapp/wasender-sessions'

type Params = Promise<{ id: string }>

/**
 * GET /api/wasender/sessions/[id]/qr
 * Fetch a fresh QR string for a session in NEED_SCAN.
 */
export async function GET(_request: Request, { params }: { params: Params }) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await params
    const result = await getSessionQr(supabaseAdmin(), accountId, id)
    return NextResponse.json({ data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[wasender/sessions/qr]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
