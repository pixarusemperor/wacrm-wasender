import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { WasenderClient } from '@/lib/whatsapp/wasender-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { GroupJid } from '@/lib/whatsapp/wasender-types'

type Params = Promise<{ id: string }>

/**
 * POST /api/wasender/groups/[id]/refresh-participants
 * Re-pull participants for one group from WasenderApi.
 */
export async function POST(_request: Request, { params }: { params: Params }) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await params

    const { data: group, error: groupErr } = await supabaseAdmin()
      .from('wasender_groups')
      .select('id, session_id, group_jid, wasender_sessions(wats_api_key)')
      .eq('id', id)
      .eq('account_id', accountId)
      .single()
    if (groupErr || !group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    const session = group.wasender_sessions as unknown as { wats_api_key: string }
    if (!session?.wats_api_key) {
      return NextResponse.json({ error: 'Session key missing' }, { status: 400 })
    }
    const client = new WasenderClient({ sessionApiKey: decrypt(session.wats_api_key) })
    const participants = await client.getGroupParticipants(group.group_jid as GroupJid)

    const { data: dbMembers } = await supabaseAdmin()
      .from('wasender_group_members')
      .select('member_jid')
      .eq('group_id', group.id)
      .is('left_at', null)
    const currentJids = new Set(participants.map((p) => p.id))
    const dbActive = new Set((dbMembers ?? []).map((m) => m.member_jid))

    for (const p of participants) {
      if (!dbActive.has(p.id)) {
        await supabaseAdmin().from('wasender_group_members').insert({
          account_id: accountId,
          group_id: group.id,
          member_jid: p.id,
          phone_number: p.id.split('@')[0] || null,
          role: p.admin || 'member',
        })
        await supabaseAdmin().from('wasender_group_activity').insert({
          account_id: accountId,
          group_id: group.id,
          event_type: 'member_joined',
          member_jid: p.id,
        })
      }
    }
    for (const jid of dbActive) {
      if (!currentJids.has(jid)) {
        await supabaseAdmin()
          .from('wasender_group_members')
          .update({ left_at: new Date().toISOString() })
          .eq('group_id', group.id)
          .eq('member_jid', jid)
        await supabaseAdmin().from('wasender_group_activity').insert({
          account_id: accountId,
          group_id: group.id,
          event_type: 'member_left',
          member_jid: jid,
        })
      }
    }

    return NextResponse.json({ success: true, participants: participants.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[wasender/groups/refresh]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
