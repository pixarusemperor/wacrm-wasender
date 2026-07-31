/**
 * Multi-tenant WasenderApi session management.
 *
 * The PAT (Personal Access Token) is the SAAS OWNER's token — it is
 * never a user's credential. It lives in env (`WATSSENDER_MASTER_PAT`,
 * optionally overridden by an encrypted `owner_config` row) and is used
 * server-side to create/connect/disconnect sessions on behalf of any
 * account. Each created session returns a per-session API key +
 * webhook secret, which we store AES-256-GCM encrypted on
 * `wasender_sessions`, scoped to the owning account (RLS).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { WasenderClient } from './wasender-client'
import { encrypt, decrypt } from './encryption'
import type { WasenderSession, WasenderSessionCreateParams } from './wasender-types'

/**
 * Resolve the owner PAT: env var first, then an encrypted owner_config
 * row (so a self-hosted operator can rotate it without redeploying).
 */
export async function getOwnerPat(admin: SupabaseClient): Promise<string> {
  const fromEnv = process.env.WATSSENDER_MASTER_PAT
  if (fromEnv) return fromEnv

  const { data, error } = await admin
    .from('owner_config')
    .select('wasender_pat')
    .eq('id', 1)
    .maybeSingle()
  if (error || !data?.wasender_pat) {
    throw new Error(
      'WATSSENDER_MASTER_PAT is not configured. The SaaS owner must set the WasenderApi PAT.'
    )
  }
  return decrypt(data.wasender_pat as string)
}

/** Client bound to the owner PAT (account-level ops only). */
export function ownerClient(pat: string): WasenderClient {
  return new WasenderClient({ pat })
}

/**
 * List all WasenderApi sessions visible to the owner PAT.
 * Raw provider view — used by the dashboard's instance picker.
 */
export async function listOwnerSessions(pat: string): Promise<WasenderSession[]> {
  return ownerClient(pat).getSessions()
}

export interface CreateSessionForAccountInput {
  accountId: string
  userId: string
  name: string
  phoneNumber: string
  webhookUrl: string
  accountProtection?: boolean
  logMessages?: boolean
  alwaysOnline?: boolean
  proxyUrl?: string
}

/**
 * Create a WasenderApi session on behalf of an account:
 *   1. Call the provider with the OWNER PAT.
 *   2. Encrypt + store the per-session api_key + webhook_secret,
 *      scoped to the account.
 *   3. Return the stored row (secrets already encrypted).
 */
export async function createSessionForAccount(
  admin: SupabaseClient,
  input: CreateSessionForAccountInput
): Promise<{ id: string; wats_session_id: number | null; status: string }> {
  const pat = await getOwnerPat(admin)
  const client = ownerClient(pat)

  const params: WasenderSessionCreateParams = {
    name: input.name,
    phone_number: input.phoneNumber,
    account_protection: input.accountProtection ?? true,
    log_messages: input.logMessages ?? true,
    webhook_url: input.webhookUrl,
    webhook_enabled: true,
    webhook_events: [
      'messages.received',
      'messages-group.received',
      'messages-personal.received',
      'messages.upsert',
      'messages.update',
      'message.sent',
      'session.status',
      'qrcode.updated',
      'groups.upsert',
      'group-participants.update',
      'contacts.upsert',
      'messages.reaction',
      'call',
    ],
    read_incoming_messages: false,
    always_online: input.alwaysOnline ?? false,
    proxy_url: input.proxyUrl,
  }

  const created = await client.createSession(params)

  const { data, error } = await admin
    .from('wasender_sessions')
    .insert({
      account_id: input.accountId,
      user_id: input.userId,
      wats_session_id: created.id,
      wats_api_key: created.api_key ? encrypt(created.api_key) : null,
      wats_webhook_secret: created.webhook_secret ? encrypt(created.webhook_secret) : null,
      name: created.name || input.name,
      phone_number: created.phone_number || input.phoneNumber,
      status: created.status || 'need_scan',
      proxy_url: input.proxyUrl || null,
      always_online: input.alwaysOnline ?? false,
    })
    .select('id, wats_session_id, status')
    .single()

  if (error || !data) {
    // Roll back the provider session so we don't leak orphan numbers.
    await client.deleteSession(created.id).catch(() => undefined)
    throw new Error(`Failed to store wasender session: ${error?.message ?? 'unknown'}`)
  }

  return data
}

/**
 * Connect a stored session (owner PAT) and return the QR/passkey
 * payload for the linking UI.
 */
export async function connectStoredSession(
  admin: SupabaseClient,
  accountId: string,
  sessionRowId: string,
  linkMethod: 'qr' | 'passkey' = 'qr'
): Promise<
  | { status: 'NEED_SCAN'; qrCode: string }
  | { status: 'NEED_PASSKEY'; passkey: { token: string; expires_at: string } }
  | { status: 'CONNECTED'; message: string }
> {
  const { data: row, error } = await admin
    .from('wasender_sessions')
    .select('wats_session_id')
    .eq('id', sessionRowId)
    .eq('account_id', accountId)
    .single()
  if (error || !row?.wats_session_id) {
    throw new Error('Session not found for this account')
  }

  const pat = await getOwnerPat(admin)
  return ownerClient(pat).connectSession(row.wats_session_id, linkMethod)
}

/** Fetch a fresh QR string (must call connect first). */
export async function getSessionQr(
  admin: SupabaseClient,
  accountId: string,
  sessionRowId: string
): Promise<{ qrCode: string }> {
  const { data: row, error } = await admin
    .from('wasender_sessions')
    .select('wats_session_id')
    .eq('id', sessionRowId)
    .eq('account_id', accountId)
    .single()
  if (error || !row?.wats_session_id) {
    throw new Error('Session not found for this account')
  }
  const pat = await getOwnerPat(admin)
  return ownerClient(pat).getQrCode(row.wats_session_id)
}

export async function disconnectStoredSession(
  admin: SupabaseClient,
  accountId: string,
  sessionRowId: string
): Promise<void> {
  const { data: row, error } = await admin
    .from('wasender_sessions')
    .select('wats_session_id')
    .eq('id', sessionRowId)
    .eq('account_id', accountId)
    .single()
  if (error || !row?.wats_session_id) return
  const pat = await getOwnerPat(admin)
  await ownerClient(pat).disconnectSession(row.wats_session_id)
  await admin
    .from('wasender_sessions')
    .update({ status: 'disconnected', updated_at: new Date().toISOString() })
    .eq('id', sessionRowId)
}

export async function restartStoredSession(
  admin: SupabaseClient,
  accountId: string,
  sessionRowId: string
): Promise<void> {
  const { data: row, error } = await admin
    .from('wasender_sessions')
    .select('wats_session_id')
    .eq('id', sessionRowId)
    .eq('account_id', accountId)
    .single()
  if (error || !row?.wats_session_id) return
  const pat = await getOwnerPat(admin)
  await ownerClient(pat).restartSession(row.wats_session_id)
}

/** Delete the provider session (owner PAT) then the local row. */
export async function deleteStoredSession(
  admin: SupabaseClient,
  accountId: string,
  sessionRowId: string
): Promise<void> {
  const { data: row, error } = await admin
    .from('wasender_sessions')
    .select('wats_session_id')
    .eq('id', sessionRowId)
    .eq('account_id', accountId)
    .single()
  if (error || !row) {
    throw new Error('Session not found for this account')
  }
  if (row.wats_session_id) {
    const pat = await getOwnerPat(admin)
    await ownerClient(pat).deleteSession(row.wats_session_id).catch(() => undefined)
  }
  await admin.from('wasender_sessions').delete().eq('id', sessionRowId)
}

/** Sync statuses of an account's sessions from the provider. */
export async function syncSessionStatuses(
  admin: SupabaseClient,
  accountId: string
): Promise<void> {
  const { data: rows } = await admin
    .from('wasender_sessions')
    .select('id, wats_session_id, wats_api_key')
    .eq('account_id', accountId)
  if (!rows || rows.length === 0) return

  const pat = await getOwnerPat(admin).catch(() => '')
  for (const row of rows) {
    try {
      // Prefer the session key status endpoint; fall back to provider list.
      let status: string | null = null
      if (row.wats_api_key) {
        try {
          const sessionKey = decrypt(row.wats_api_key as string)
          const res = await new WasenderClient({ sessionApiKey: sessionKey }).getSessionStatus()
          status = res.status
        } catch {
          status = null
        }
      }
      if (!status && pat && row.wats_session_id) {
        const sessions = await ownerClient(pat).getSessions()
        const match = sessions.find((s) => s.id === row.wats_session_id)
        status = match?.status ?? null
      }
      if (status) {
        await admin
          .from('wasender_sessions')
          .update({ status, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', row.id)
      }
    } catch (err) {
      console.warn('[wasender-sessions] status sync failed for', row.id, err)
    }
  }
}
