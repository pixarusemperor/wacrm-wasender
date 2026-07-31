import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  generateBroadcastSchedule,
  generateBulkSchedule,
} from '@/lib/campaigns/campaign-scheduler'

type Params = Promise<{ id: string }>

/**
 * POST /api/campaigns/[id]/control
 * Body: { action: 'start' | 'pause' | 'resume' | 'cancel' }
 *
 * 'start' generates the campaign's send events (product × target with
 * randomized delays) and flips status to running; the campaign engine
 * (/api/campaigns/engine) then dispatches them.
 */
export async function POST(req: Request, { params }: { params: Params }) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await params
    const { action } = await req.json()
    if (!action) {
      return NextResponse.json({ error: 'Action is required' }, { status: 400 })
    }

    const db = supabaseAdmin()

    const { data: campaign, error: fetchError } = await db
      .from('campaigns')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .single()
    if (fetchError || !campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const now = new Date().toISOString()
    let updateFields: Record<string, unknown> = {}

    if (action === 'start') {
      if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
        return NextResponse.json(
          { error: `Cannot start campaign in status '${campaign.status}'` },
          { status: 400 }
        )
      }

      // Resolve targets from the campaign's group list.
      const { data: listItems, error: itemsError } = await db
        .from('group_list_items')
        .select('group_jid, group_name')
        .eq('group_list_id', campaign.group_list_id)
      if (itemsError || !listItems || listItems.length === 0) {
        return NextResponse.json({ error: 'The campaign group list is empty' }, { status: 400 })
      }

      const startAt = new Date()
      const groupJids = listItems.map((item) => item.group_jid)
      const schedulerEvents =
        campaign.campaign_type === 2
          ? generateBroadcastSchedule(
              campaign.product_ids,
              groupJids,
              startAt,
              campaign.delay_min_seconds,
              campaign.delay_max_seconds,
              campaign.start_jitter_seconds || 120,
              campaign.wave_delay_min_seconds || 60,
              campaign.wave_delay_max_seconds || 300,
              campaign.wave_start_times
                ? campaign.wave_start_times.map((t: string) => new Date(t))
                : undefined
            )
          : generateBulkSchedule(
              campaign.product_ids,
              groupJids,
              startAt,
              campaign.delay_min_seconds,
              campaign.delay_max_seconds,
              campaign.start_jitter_seconds || 120
            )

      if (schedulerEvents.length === 0) {
        return NextResponse.json({ error: 'Failed to schedule campaign events' }, { status: 500 })
      }

      // Clear prior pending events, then insert the new schedule.
      await db.from('campaign_events').delete().eq('campaign_id', campaign.id).eq('status', 'pending')

      const jidToName = new Map(listItems.map((i) => [i.group_jid, i.group_name]))
      const eventsToInsert = schedulerEvents.map((e) => ({
        account_id: accountId,
        campaign_id: campaign.id,
        product_id: e.product_id,
        group_jid: e.group_jid,
        group_name: jidToName.get(e.group_jid) || null,
        batch_index: e.batch_index,
        send_order: e.send_order,
        scheduled_at: e.scheduled_at.toISOString(),
        status: 'pending',
      }))
      const { error: insertError } = await db.from('campaign_events').insert(eventsToInsert)
      if (insertError) {
        return NextResponse.json(
          { error: `Failed to create campaign events: ${insertError.message}` },
          { status: 500 }
        )
      }

      updateFields = {
        status: 'running',
        started_at: campaign.started_at || now,
        total_events: eventsToInsert.length,
        completed_events: 0,
        failed_events: 0,
        updated_at: now,
      }
    } else if (action === 'pause') {
      if (campaign.status !== 'running') {
        return NextResponse.json({ error: `Cannot pause in '${campaign.status}'` }, { status: 400 })
      }
      updateFields = { status: 'paused', updated_at: now }
    } else if (action === 'resume') {
      if (campaign.status !== 'paused') {
        return NextResponse.json({ error: `Cannot resume in '${campaign.status}'` }, { status: 400 })
      }
      updateFields = { status: 'running', updated_at: now }
    } else if (action === 'cancel') {
      if (['completed', 'cancelled'].includes(campaign.status)) {
        return NextResponse.json({ error: `Cannot cancel in '${campaign.status}'` }, { status: 400 })
      }
      updateFields = { status: 'cancelled', updated_at: now }
      await db.from('campaign_events').update({ status: 'cancelled' }).eq('campaign_id', id).eq('status', 'pending')
    } else {
      return NextResponse.json({ error: `Invalid action '${action}'` }, { status: 400 })
    }

    const { data: updated, error: updateError } = await db
      .from('campaigns')
      .update(updateFields)
      .eq('id', id)
      .select()
      .single()
    if (updateError || !updated) {
      return NextResponse.json({ error: 'Failed to update campaign' }, { status: 500 })
    }
    return NextResponse.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[campaigns/control]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
