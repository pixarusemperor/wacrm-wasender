import { NextResponse } from 'next/server'
import { getCurrentAccount } from '@/lib/auth/account'

type Params = Promise<{ id: string }>

/**
 * GET /api/campaigns/[id]/events — list a campaign's send events.
 * ?status=, ?page=, ?limit= filters.
 */
export async function GET(req: Request, { params }: { params: Params }) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    const { searchParams } = new URL(req.url)

    const status = searchParams.get('status')
    const page = parseInt(searchParams.get('page') || '1', 10)
    const limit = parseInt(searchParams.get('limit') || '50', 10)
    const offset = (page - 1) * limit

    let query = supabase
      .from('campaign_events')
      .select('*, campaign_products(name)', { count: 'exact' })
      .eq('campaign_id', id)
      .eq('account_id', accountId)
    if (status && status.toLowerCase() !== 'all') {
      query = query.eq('status', status.toLowerCase())
    }
    query = query.order('scheduled_at', { ascending: true }).range(offset, offset + limit - 1)

    const { data: events, count, error } = await query
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const formatted = (events ?? []).map((e) => ({
      ...e,
      product_name: (e.campaign_products as { name?: string } | null)?.name ?? 'Unknown Product',
    }))

    return NextResponse.json({
      events: formatted,
      total: count || 0,
      page,
      limit,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[campaigns/events]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
