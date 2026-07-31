import { NextResponse } from 'next/server'
import { getCurrentAccount } from '@/lib/auth/account'

/**
 * GET /api/wasender/groups
 * List the account's synced groups with member counts.
 * ?session_id= filters to one session.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('session_id')

    let query = supabase
      .from('wasender_groups')
      .select('id, session_id, group_jid, name, img_url, is_active, synced_at, updated_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
    if (sessionId) query = query.eq('session_id', sessionId)

    const { data: groups, error } = await query
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Member counts per group.
    const memberships: Record<string, number> = {}
    if (groups && groups.length > 0) {
      const { data: counts } = await supabase
        .from('wasender_group_members')
        .select('group_id, id')
        .eq('account_id', accountId)
        .is('left_at', null)
      for (const m of counts ?? []) {
        memberships[m.group_id] = (memberships[m.group_id] ?? 0) + 1
      }
    }

    const mapped = (groups ?? []).map((g) => ({
      ...g,
      jid: g.group_jid,
      participantCount: memberships[g.id] ?? 0,
    }))

    return NextResponse.json({ data: mapped })
  } catch (err) {
    return handleErr(err)
  }
}

function handleErr(err: unknown) {
  const message = err instanceof Error ? err.message : 'Internal server error'
  console.error('[wasender/groups]', message)
  return NextResponse.json({ error: message }, { status: 400 })
}
