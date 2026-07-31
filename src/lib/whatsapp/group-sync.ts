/**
 * Group sync — ported from WassFlow's group-sync.ts, adapted to
 * WaCRM's multi-tenant schema (wasender_groups / wasender_group_members
 * / wasender_group_activity), account-scoped, RLS-guarded.
 *
 * Fetches the account's groups + members from WasenderApi and upserts
 * them, tracking joins/leaves/role changes in the activity log.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { WasenderClient } from '@/lib/whatsapp/wasender-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { GroupJid } from '@/lib/whatsapp/wasender-types'

export interface SyncResult {
  success: boolean
  groupsSynced: number
  membersSynced: number
  error?: string
}

/**
 * Sync groups + members for one of an account's sessions.
 * `sessionRowId` is the wasender_sessions.id; the API key is decrypted
 * server-side from the row.
 */
export async function syncGroupsForSession(
  db: SupabaseClient,
  accountId: string,
  sessionRowId: string
): Promise<SyncResult> {
  const result: SyncResult = { success: false, groupsSynced: 0, membersSynced: 0 }

  try {
    const { data: session, error: sessionErr } = await db
      .from('wasender_sessions')
      .select('id, wats_api_key')
      .eq('id', sessionRowId)
      .eq('account_id', accountId)
      .single()
    if (sessionErr || !session?.wats_api_key) {
      result.error = 'Session not found or missing API key'
      return result
    }

    const sessionKey = decrypt(session.wats_api_key)
    const client = new WasenderClient({ sessionApiKey: sessionKey })

    const groups = await client.getGroups()
    result.groupsSynced = groups.length

    for (const group of groups) {
      const groupJid = group.jid as GroupJid

      // Upsert the group.
      const { data: dbGroup, error: groupErr } = await db
        .from('wasender_groups')
        .upsert(
          {
            account_id: accountId,
            session_id: sessionRowId,
            group_jid: groupJid,
            name: group.name,
            img_url: group.imgUrl,
            is_active: true,
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'session_id,group_jid' }
        )
        .select('id')
        .single()
      if (groupErr || !dbGroup) {
        console.error(`[group-sync] upsert failed for ${groupJid}:`, groupErr)
        continue
      }

      // Fetch participants.
      let participants: Array<{ id: string; admin?: 'admin' | 'superadmin' | null }> = []
      try {
        participants = await client.getGroupParticipants(groupJid)
      } catch (err) {
        console.warn(`[group-sync] participants failed for ${groupJid}:`, err)
        continue // save the group even if participants fail
      }

      // Existing active members.
      const { data: dbMembers } = await db
        .from('wasender_group_members')
        .select('member_jid, role')
        .eq('group_id', dbGroup.id)
        .is('left_at', null)

      const dbActive = new Map((dbMembers ?? []).map((m) => [m.member_jid, m]))
      const currentJids = new Set(participants.map((p) => p.id))

      // Joins + role changes.
      for (const p of participants) {
        const existing = dbActive.get(p.id)
        const role = p.admin || 'member'
        if (!existing) {
          await db.from('wasender_group_members').insert({
            account_id: accountId,
            group_id: dbGroup.id,
            member_jid: p.id,
            phone_number: p.id.split('@')[0] || null,
            role,
          })
          await db.from('wasender_group_activity').insert({
            account_id: accountId,
            group_id: dbGroup.id,
            event_type: 'member_joined',
            member_jid: p.id,
          })
          result.membersSynced++
        } else if (existing.role !== role) {
          await db
            .from('wasender_group_members')
            .update({ role })
            .eq('group_id', dbGroup.id)
            .eq('member_jid', p.id)
          await db.from('wasender_group_activity').insert({
            account_id: accountId,
            group_id: dbGroup.id,
            event_type: 'role_changed',
            member_jid: p.id,
          })
        }
      }

      // Leaves.
      for (const [jid] of dbActive) {
        if (!currentJids.has(jid)) {
          await db
            .from('wasender_group_members')
            .update({ left_at: new Date().toISOString() })
            .eq('group_id', dbGroup.id)
            .eq('member_jid', jid)
          await db.from('wasender_group_activity').insert({
            account_id: accountId,
            group_id: dbGroup.id,
            event_type: 'member_left',
            member_jid: jid,
          })
        }
      }
    }

    result.success = true
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error('[group-sync] failed:', result.error)
    return result
  }
}
