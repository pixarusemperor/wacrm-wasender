import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * GET /api/campaigns — list the account's campaigns with group list names.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('*, group_lists(name)')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const formatted = (campaigns ?? []).map((c) => ({
      ...c,
      group_list_name: (c.group_lists as { name?: string } | null)?.name ?? 'Unknown List',
    }))

    return NextResponse.json(formatted)
  } catch (err) {
    return handleErr(err)
  }
}

/**
 * POST /api/campaigns — create a campaign definition.
 *
 * Body: { name, campaign_type?, session_id, group_list_id?, product_ids?,
 *         custom_products?, delay_min_seconds?, delay_max_seconds?, ... }
 * Ported from WassFlow's campaign create route, account-scoped.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const db = supabaseAdmin()
    const body = await request.json()

    const {
      name,
      campaign_type,
      session_id,
      group_list_id,
      product_ids,
      custom_products,
      delay_min_seconds,
      delay_max_seconds,
      wave_delay_min_seconds,
      wave_delay_max_seconds,
      scheduling_mode,
      wave_start_times,
      scheduled_start_at,
      start_jitter_seconds,
    } = body

    if (!name) return NextResponse.json({ error: 'Campaign name is required' }, { status: 400 })
    if (!session_id) {
      return NextResponse.json({ error: 'WhatsApp session is required' }, { status: 400 })
    }
    if (delay_min_seconds !== undefined && delay_min_seconds < 5) {
      return NextResponse.json(
        { error: 'Minimum outbound delay must be at least 5 seconds' },
        { status: 400 }
      )
    }

    // Resolve custom products (inline message templates) into campaign_products.
    let resolvedProductIds = product_ids || []
    if (custom_products && Array.isArray(custom_products) && custom_products.length > 0) {
      const productsToInsert = custom_products.map(
        (p: { name?: string; caption?: string; media_url?: string; media_type?: string }) => ({
          account_id: accountId,
          user_id: userId,
          name: p.name || `Custom: ${name.substring(0, 30)}`,
          caption: p.caption || null,
          media_url: p.media_url || null,
          media_type: p.media_type || 'text',
          source: 'campaign_custom',
        })
      )
      const { data: inserted, error: insertProdError } = await db
        .from('campaign_products')
        .insert(productsToInsert)
        .select('id')
      if (insertProdError || !inserted) {
        return NextResponse.json(
          { error: `Failed to create custom products: ${insertProdError?.message}` },
          { status: 500 }
        )
      }
      resolvedProductIds = inserted.map((p) => p.id)
    }

    if (!resolvedProductIds || resolvedProductIds.length === 0) {
      return NextResponse.json({ error: 'At least one product is required' }, { status: 400 })
    }
    if (!group_list_id) {
      return NextResponse.json({ error: 'A target group list is required' }, { status: 400 })
    }

    const { data: campaign, error: campError } = await db
      .from('campaigns')
      .insert({
        account_id: accountId,
        user_id: userId,
        name,
        campaign_type: campaign_type || 2,
        session_id,
        group_list_id,
        product_ids: resolvedProductIds,
        delay_min_seconds: delay_min_seconds !== undefined ? delay_min_seconds : 60,
        delay_max_seconds: delay_max_seconds !== undefined ? delay_max_seconds : 300,
        wave_delay_min_seconds:
          wave_delay_min_seconds !== undefined ? wave_delay_min_seconds : 60,
        wave_delay_max_seconds:
          wave_delay_max_seconds !== undefined ? wave_delay_max_seconds : 300,
        scheduling_mode: scheduling_mode || 'automatic',
        wave_start_times: wave_start_times || null,
        scheduled_start_at: scheduled_start_at || null,
        start_jitter_seconds: start_jitter_seconds !== undefined ? start_jitter_seconds : 120,
        status: 'draft',
        total_events: 0,
      })
      .select()
      .single()

    if (campError || !campaign) {
      return NextResponse.json(
        { error: campError?.message || 'Failed to create campaign' },
        { status: 500 }
      )
    }

    return NextResponse.json(campaign, { status: 201 })
  } catch (err) {
    return handleErr(err)
  }
}

function handleErr(err: unknown) {
  const message = err instanceof Error ? err.message : 'Internal server error'
  console.error('[campaigns]', message)
  return NextResponse.json({ error: message }, { status: 400 })
}
