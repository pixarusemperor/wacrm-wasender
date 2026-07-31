import { NextResponse } from 'next/server'
import { getCurrentAccount } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

type Params = Promise<{ id: string }>

/**
 * GET /api/wasender/groups/[id]/members
 * List a group's members (active by default, ?include_left=true for all).
 */
export async function GET(request: Request, { params }: { params: Params }) {
  try {
    const { accountId } = await getCurrentAccount()
    const { id } = await params
    const url = new URL(request.url)
    const includeLeft = url.searchParams.get('include_left') === 'true'

    let query = supabaseAdmin()
      .from('wasender_group_members')
      .select('*')
      .eq('group_id', id)
      .eq('account_id', accountId)
    if (!includeLeft) query = query.is('left_at', null)
    const { data, error } = await query.order('joined_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data: data ?? [] })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[wasender/groups/members]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
