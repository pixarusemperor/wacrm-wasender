import { NextResponse } from 'next/server'
import { getCurrentAccount } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

type Params = Promise<{ id: string }>

/**
 * GET /api/campaigns/[id]
 * DELETE /api/campaigns/[id]
 */
export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select('*, group_lists(name)')
      .eq('id', id)
      .eq('account_id', accountId)
      .single()

    if (error || !campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    return NextResponse.json({
      ...campaign,
      group_list_name: (campaign.group_lists as { name?: string } | null)?.name ?? 'Unknown List',
    })
  } catch (err) {
    return handleErr(err)
  }
}

export async function DELETE(_req: Request, { params }: { params: Params }) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data: campaign, error: fetchError } = await supabase
      .from('campaigns')
      .select('status')
      .eq('id', id)
      .eq('account_id', accountId)
      .single()
    if (fetchError || !campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const allowedDeletes = ['draft', 'completed', 'cancelled']
    if (!allowedDeletes.includes(campaign.status)) {
      return NextResponse.json(
        { error: `Cannot delete campaign in '${campaign.status}' status` },
        { status: 400 }
      )
    }

    const { error: deleteError } = await supabase.from('campaigns').delete().eq('id', id)
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return handleErr(err)
  }
}

function handleErr(err: unknown) {
  const message = err instanceof Error ? err.message : 'Internal server error'
  console.error('[campaigns/[id]]', message)
  return NextResponse.json({ error: message }, { status: 400 })
}
