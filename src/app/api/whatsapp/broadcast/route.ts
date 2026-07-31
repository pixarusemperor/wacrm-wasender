import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * POST /api/whatsapp/broadcast
 *
 * DISABLED — WasenderApi has no Meta-approved message templates, so
 * template broadcasts are unsupported. Bulk sends now go through the
 * campaign engine (`/api/campaigns`) with raw text/media messages and
 * the anti-ban dispatch loop.
 */
export async function POST() {
  try {
    await requireRole('agent')
    return NextResponse.json(
      {
        error:
          'Template broadcasts are not supported by WasenderApi. Create a campaign (/api/campaigns) to send raw messages instead.',
      },
      { status: 501 }
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
