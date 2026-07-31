/**
 * Campaign dispatch engine — ported from WassFlow's campaign-engine.ts.
 *
 * Anti-ban design (WasenderApi rate limits, verified from docs):
 *   - Session-serialized: only ONE send per session at a time.
 *   - 5-second minimum gap between sends per session (account
 *     protection is 1 per 5s on paid plans).
 *   - Exponential backoff retry: 15s → 30s → 60s on 429/5xx.
 *   - Priority queue: campaigns are priority 1, trigger/autoresponse
 *     priority 10 (triggers preempt campaigns).
 *   - Presence simulation ('composing') before each message.
 *
 * engineTick() enqueues due campaign_events into send_queue.
 * queueTick()   processes due send_queue items, one per session.
 *
 * Both are idempotent + concurrency-safe via optimistic status locks.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WasenderClient,
  WasenderApiError,
} from '@/lib/whatsapp/wasender-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  phoneToJid,
  type Jid,
  type WasenderMessageBody,
} from '@/lib/whatsapp/wasender-types'

export interface EngineTickResult {
  processed: number
  eventId?: string
  status?: string
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

const MIN_INTER_SEND_GAP_MS = 5000

/**
 * Re-space a campaign's remaining pending events relative to now —
 * used when the campaign's scheduled times fell behind (server down,
 * paused, etc.) so it doesn't blast a backlog.
 */
async function reSpaceOverdueEvents(
  db: SupabaseClient,
  campaignId: string,
  delayMin: number,
  delayMax: number
) {
  const { data: events, error } = await db
    .from('campaign_events')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .order('batch_index', { ascending: true })
    .order('send_order', { ascending: true })
  if (error || !events || events.length === 0) return

  let currentScheduled = new Date()
  for (let i = 0; i < events.length; i++) {
    if (i > 0) {
      const delay = randomInt(delayMin, delayMax)
      currentScheduled = new Date(currentScheduled.getTime() + delay * 1000)
    }
    await db
      .from('campaign_events')
      .update({ scheduled_at: currentScheduled.toISOString() })
      .eq('id', events[i].id)
  }
}

/**
 * Tick 1: move the oldest due pending campaign event into the send
 * queue (optimistic lock on status='pending' → 'queued').
 */
export async function engineTick(db: SupabaseClient): Promise<EngineTickResult> {
  try {
    const now = new Date().toISOString()

    // 1. Re-space overdue events (scheduled > 30s ago).
    const overdueCutoff = new Date(Date.now() - 30000).toISOString()
    const { data: overdueEvents } = await db
      .from('campaign_events')
      .select('campaign_id')
      .eq('status', 'pending')
      .lte('scheduled_at', overdueCutoff)
    if (overdueEvents && overdueEvents.length > 0) {
      const ids = Array.from(new Set(overdueEvents.map((e) => e.campaign_id)))
      for (const campaignId of ids) {
        const { data: campaign } = await db
          .from('campaigns')
          .select('delay_min_seconds, delay_max_seconds')
          .eq('id', campaignId)
          .single()
        if (campaign) {
          await reSpaceOverdueEvents(
            db,
            campaignId,
            campaign.delay_min_seconds,
            campaign.delay_max_seconds
          )
        }
      }
    }

    // 2. Oldest due pending event.
    const { data: event, error: fetchError } = await db
      .from('campaign_events')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (fetchError || !event) return { processed: 0 }

    // 3. Optimistic lock pending → queued.
    const { data: locked, error: lockError } = await db
      .from('campaign_events')
      .update({ status: 'queued' })
      .eq('id', event.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle()
    if (lockError || !locked) return { processed: 0 }

    // 4. Campaign + product details.
    const { data: campaign, error: campError } = await db
      .from('campaigns')
      .select('*')
      .eq('id', event.campaign_id)
      .single()
    if (campError || !campaign) {
      await db
        .from('campaign_events')
        .update({ status: 'failed', error_message: 'Campaign not found' })
        .eq('id', event.id)
      return { processed: 1, eventId: event.id, status: 'failed' }
    }

    if (campaign.status !== 'running') {
      const reset = campaign.status === 'paused' ? 'pending' : 'cancelled'
      await db.from('campaign_events').update({ status: reset }).eq('id', event.id)
      return { processed: 0 }
    }

    const { data: product, error: prodError } = await db
      .from('campaign_products')
      .select('*')
      .eq('id', event.product_id)
      .single()
    if (prodError || !product) {
      await db
        .from('campaign_events')
        .update({ status: 'failed', error_message: 'Product not found' })
        .eq('id', event.id)
      await db
        .from('campaigns')
        .update({ failed_events: (campaign.failed_events || 0) + 1 })
        .eq('id', campaign.id)
      await checkCampaignCompletion(db, campaign.id)
      return { processed: 1, eventId: event.id, status: 'failed' }
    }

    // 5. Build the send payload.
    const payload: Record<string, unknown> = { to: event.group_jid }
    if (product.caption) payload.text = product.caption
    if (product.media_type === 'image' && product.media_url) {
      payload.imageUrl = product.media_url
    } else if (product.media_type === 'video' && product.media_url) {
      payload.videoUrl = product.media_url
    } else if (product.media_type === 'audio' && product.media_url) {
      payload.audioUrl = product.media_url
    } else if (product.media_type === 'document' && product.media_url) {
      payload.documentUrl = product.media_url
      payload.fileName = product.name || 'document'
    }

    // 6. Enqueue into send_queue (priority 1 = campaign). Resolve the
    //    session's encrypted API key for the snapshot column.
    const { data: sessionRow } = await db
      .from('wasender_sessions')
      .select('wats_api_key')
      .eq('id', campaign.session_id)
      .single()
    const sessionKeySnapshot = sessionRow?.wats_api_key ?? ''

    const { error: queueError } = await db.from('send_queue').insert({
      account_id: campaign.account_id,
      session_id: campaign.session_id,
      instance_api_key: sessionKeySnapshot,
      recipient: event.group_jid,
      payload,
      priority: 1,
      status: 'pending',
      scheduled_at: event.scheduled_at,
      campaign_event_id: event.id,
    })
    if (queueError) {
      await db
        .from('campaign_events')
        .update({
          status: 'pending',
          error_message: `Queue insert failed: ${queueError.message}`,
        })
        .eq('id', event.id)
      return { processed: 0 }
    }

    return { processed: 1, eventId: event.id, status: 'queued' }
  } catch (err) {
    console.error('[campaign-engine] engineTick error:', err)
    return { processed: 0 }
  }
}

/**
 * Tick 2: process due send_queue items until the 8s budget runs out.
 */
export async function queueTick(db: SupabaseClient): Promise<{ processed: number }> {
  let processedCount = 0
  const start = Date.now()
  const MAX_MS = 8000

  while (Date.now() - start < MAX_MS) {
    const result = await processNextQueueItem(db)
    if (result.processed === 0) break
    processedCount += result.processed
  }
  return { processed: processedCount }
}

/**
 * Select, lock, and dispatch ONE queue item — session-serialized.
 */
async function processNextQueueItem(
  db: SupabaseClient
): Promise<{ processed: number }> {
  try {
    const nowStr = new Date().toISOString()

    // 1. Exclude sessions currently processing (session serialization).
    const { data: processing } = await db
      .from('send_queue')
      .select('session_id')
      .eq('status', 'processing')
    const excluded = processing?.map((p) => p.session_id) || []

    // 2. Oldest due pending item, highest priority first.
    let query = db
      .from('send_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', nowStr)
    if (excluded.length > 0) {
      query = query.not(
        'session_id',
        'in',
        `(${excluded.map((id) => `"${id}"`).join(',')})`
      )
    }
    const { data: item, error: fetchError } = await query
      .order('priority', { ascending: false })
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (fetchError || !item) return { processed: 0 }

    // 3. Optimistic lock pending → processing.
    const { data: locked, error: lockError } = await db
      .from('send_queue')
      .update({ status: 'processing' })
      .eq('id', item.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle()
    if (lockError || !locked) return { processed: 0 }

    // 4. Enforce 5s minimum gap per session (anti-ban).
    const { data: lastSent } = await db
      .from('send_queue')
      .select('executed_at')
      .eq('session_id', locked.session_id)
      .eq('status', 'sent')
      .order('executed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastSent?.executed_at) {
      const elapsed = Date.now() - new Date(lastSent.executed_at).getTime()
      if (elapsed < MIN_INTER_SEND_GAP_MS) {
        await new Promise((r) => setTimeout(r, MIN_INTER_SEND_GAP_MS - elapsed))
      }
    }

    // 5. Presence simulation (typing indicator) before sending.
    let sessionKey = locked.instance_api_key
    try {
      sessionKey = decrypt(locked.instance_api_key)
    } catch {
      // Keep the raw value; the client will fail loudly if it's garbage.
    }

    if (locked.presence_type && locked.presence_duration_seconds > 0) {
      try {
        const client = new WasenderClient({ sessionApiKey: sessionKey })
        // Recipient may be a group JID (@g.us) or an E.164 phone — only
        // convert phones to individual JIDs; groups pass through as-is.
        const presenceJid = locked.recipient.endsWith('@g.us')
          ? (locked.recipient as Jid)
          : phoneToJid(locked.recipient)
        await client.sendPresence({
          jid: presenceJid,
          type: locked.presence_type === 'recording' ? 'recording' : 'composing',
        })
      } catch (err) {
        console.warn('[campaign-engine] presence failed:', err)
      }
      await new Promise((r) =>
        setTimeout(r, locked.presence_duration_seconds * 1000)
      )
    }

    // 6. Send via WasenderApi. The stored payload is the flat shape
    //    (to + media keys); rebuild it as a typed WasenderMessageBody.
    let success = false
    let errorMessage = ''
    let statusCode = 200
    let responseBody = ''
    try {
      const client = new WasenderClient({ sessionApiKey: sessionKey })
      const body = payloadToMessageBody(locked.payload)
      const res = await client.sendMessage(locked.recipient, body)
      success = true
      responseBody = JSON.stringify(res)
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
      statusCode =
        err instanceof WasenderApiError
          ? err.status
          : 500
      if (!statusCode) statusCode = 500
    }

    // 7. Handle success / failure.
    if (success) {
      await db
        .from('send_queue')
        .update({
          status: 'sent',
          executed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', locked.id)

      if (locked.campaign_event_id) {
        await db
          .from('campaign_events')
          .update({
            status: 'sent',
            actual_sent_at: new Date().toISOString(),
            api_status_code: statusCode,
            api_response: responseBody.substring(0, 2000),
          })
          .eq('id', locked.campaign_event_id)
        const { data: event } = await db
          .from('campaign_events')
          .select('campaign_id')
          .eq('id', locked.campaign_event_id)
          .single()
        if (event) {
          const { data: campaign } = await db
            .from('campaigns')
            .select('completed_events')
            .eq('id', event.campaign_id)
            .single()
          if (campaign) {
            await db
              .from('campaigns')
              .update({ completed_events: (campaign.completed_events || 0) + 1 })
              .eq('id', event.campaign_id)
            await checkCampaignCompletion(db, event.campaign_id)
          }
        }
      }
      console.log(`[campaign-engine] sent ${locked.id}`)
    } else {
      const retryCount = locked.attempts || 0
      const isRetryable =
        statusCode === 429 || (statusCode >= 500 && statusCode < 600)

      if (isRetryable && retryCount < locked.max_attempts) {
        const backoffMs = Math.pow(2, retryCount) * 15000 // 15s, 30s, 60s
        await db
          .from('send_queue')
          .update({
            status: 'pending',
            attempts: retryCount + 1,
            scheduled_at: new Date(Date.now() + backoffMs).toISOString(),
            error_message: errorMessage,
          })
          .eq('id', locked.id)
        console.log(
          `[campaign-engine] retry ${locked.id} in ${backoffMs / 1000}s (attempt ${retryCount + 1})`
        )
      } else {
        await db
          .from('send_queue')
          .update({
            status: 'failed',
            error_message: errorMessage,
            executed_at: new Date().toISOString(),
          })
          .eq('id', locked.id)
        if (locked.campaign_event_id) {
          await db
            .from('campaign_events')
            .update({ status: 'failed', error_message: errorMessage })
            .eq('id', locked.campaign_event_id)
          const { data: event } = await db
            .from('campaign_events')
            .select('campaign_id')
            .eq('id', locked.campaign_event_id)
            .single()
          if (event) {
            const { data: campaign } = await db
              .from('campaigns')
              .select('failed_events')
              .eq('id', event.campaign_id)
              .single()
            if (campaign) {
              await db
                .from('campaigns')
                .update({ failed_events: (campaign.failed_events || 0) + 1 })
                .eq('id', event.campaign_id)
              await checkCampaignCompletion(db, event.campaign_id)
            }
          }
        }
        console.error(`[campaign-engine] failed ${locked.id}: ${errorMessage}`)
      }
    }

    return { processed: 1 }
  } catch (err) {
    console.error('[campaign-engine] queue processing error:', err)
    return { processed: 0 }
  }
}

async function checkCampaignCompletion(
  db: SupabaseClient,
  campaignId: string
): Promise<void> {
  const { count, error } = await db
    .from('campaign_events')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'queued', 'sending'])
  if (!error && count === 0) {
    await db
      .from('campaigns')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', campaignId)
    console.log(`[campaign-engine] campaign ${campaignId} completed`)
  }
}

/** Decrypt the session API key stored on a campaign's session. */
export function decryptSessionKey(encrypted: string): string {
  return decrypt(encrypted)
}

/**
 * Convert the flat send-queue payload ({to, text, imageUrl, ...}) into
 * a typed WasenderMessageBody for the client. Exhaustive over the media
 * keys the engine stores.
 */
export function payloadToMessageBody(
  payload: Record<string, unknown>
): WasenderMessageBody {
  if (typeof payload.imageUrl === 'string') {
    return {
      kind: 'image',
      imageUrl: payload.imageUrl,
      text: typeof payload.text === 'string' ? payload.text : undefined,
    }
  }
  if (typeof payload.videoUrl === 'string') {
    return {
      kind: 'video',
      videoUrl: payload.videoUrl,
      text: typeof payload.text === 'string' ? payload.text : undefined,
    }
  }
  if (typeof payload.audioUrl === 'string') {
    return { kind: 'audio', audioUrl: payload.audioUrl }
  }
  if (typeof payload.documentUrl === 'string') {
    return {
      kind: 'document',
      documentUrl: payload.documentUrl,
      fileName: typeof payload.fileName === 'string' ? payload.fileName : undefined,
      text: typeof payload.text === 'string' ? payload.text : undefined,
    }
  }
  return {
    kind: 'text',
    text: typeof payload.text === 'string' ? payload.text : '',
  }
}
