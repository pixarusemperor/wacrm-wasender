import { NextResponse, after } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { createSessionResolver } from '@/lib/whatsapp/wasender-webhook-auth'
import {
  parseWasenderWebhook,
  type WasenderWebhookPayload,
} from '@/lib/whatsapp/wasender-types'
import {
  webhookToNormalizedMessages,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/wasender-normalize'
import { decryptAndStoreMedia } from '@/lib/whatsapp/wasender-media'
import { WasenderClient } from '@/lib/whatsapp/wasender-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'

export const maxDuration = 60

// Lazy service-role client (webhook has no user session).
let _adminClient: SupabaseClient | null = null
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// ---------------------------------------------------------------------
// POST — WasenderApi webhook entry
//
// Verification: X-Webhook-Signature (plain token, per-session
// webhook_secret) compared constant-time. WasenderApi requires a fast
// 200 OK; heavy work runs in `after()`.
// ---------------------------------------------------------------------
export async function POST(request: Request) {
  const signature = request.headers.get('x-webhook-signature')
  if (!signature) {
    // WasenderApi sends no signature when the session has no secret
    // configured. We reject loudly (401) like WaCRM's Meta webhook —
    // a missing secret on a public URL means anyone could spoof events.
    return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
  }

  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const payload = parseWasenderWebhook(body)
  if (!payload) {
    // Unknown/irrelevant event — ack immediately, never retried.
    return NextResponse.json({ status: 'received' }, { status: 200 })
  }

  after(async () => {
    try {
      await processWebhook(payload, signature)
    } catch (error) {
      console.error('[webhook] error processing wasender event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

// ---------------------------------------------------------------------
// Processing — resolve session, dispatch messages through the pipeline
// ---------------------------------------------------------------------
async function processWebhook(payload: WasenderWebhookPayload, signature: string) {
  const admin = supabaseAdmin()

  // 1. Resolve the owning session/account by webhook_secret.
  const resolver = createSessionResolver(admin)
  const session = await resolver(signature)
  if (!session) {
    console.warn('[webhook] no session matched the signature; dropping event')
    return
  }

  // 2. Handle non-message events.
  switch (payload.event) {
    case 'session.status':
      await admin
        .from('wasender_sessions')
        .update({ status: payload.data.status, updated_at: new Date().toISOString() })
        .eq('id', session.sessionId)
      return
    case 'qrcode.updated':
      // Session status flows to `need_scan`; the UI polls the QR endpoint.
      await admin
        .from('wasender_sessions')
        .update({ status: 'need_scan', updated_at: new Date().toISOString() })
        .eq('id', session.sessionId)
      return
    case 'groups.upsert':
      await upsertGroupsFromWebhook(admin, session.accountId, session.sessionId, payload.data)
      return
    case 'group-participants.update':
      await logGroupActivity(admin, session.accountId, payload.data)
      return
    case 'messages.update':
      await handleMessageStatusUpdate(admin, payload.data)
      return
    case 'message.sent':
      // Outbound ack — nothing to do (we persist our own outbound rows).
      return
    case 'messages.reaction':
      await handleReactionEvent(admin, payload.data)
      return
    default:
      break
  }

  // 3. Normalize inbound customer messages.
  const messages = webhookToNormalizedMessages(payload)
  for (const msg of messages) {
    await processMessage(admin, session, msg)
  }
}

// ---------------------------------------------------------------------
// Single inbound message → WaCRM pipeline
// ---------------------------------------------------------------------
async function processMessage(
  admin: SupabaseClient,
  session: { accountId: string; userId: string; sessionId: string; sessionApiKey: string },
  msg: NormalizedInboundMessage
) {
  // Outbound echoes (fromMe) are filtered by webhookToNormalizedMessages.
  const senderPhone = msg.senderPhone
  if (!senderPhone && !msg.isGroup) {
    console.warn('[webhook] message with no resolvable sender phone; dropping', msg.messageId)
    return
  }

  // Find or create the contact by E.164 (cleaned fields — never the LID).
  const contact = await findOrCreateContact(
    admin,
    session.accountId,
    session.userId,
    senderPhone,
    msg.isGroup ? msg.remoteJid : senderPhone
  )
  if (!contact) return

  // Find or create the conversation.
  const conversation = await findOrCreateConversation(
    admin,
    session.accountId,
    session.userId,
    contact.id,
    session.sessionId,
    msg.isGroup
  )
  if (!conversation) return

  // Media: decrypt + store permanently.
  let mediaUrl: string | null = null
  if (msg.media) {
    const client = new WasenderClient({ sessionApiKey: session.sessionApiKey })
    const mediaResult = await decryptAndStoreMedia(
      { client, supabase: admin },
      msg,
      session.accountId
    )
    mediaUrl = mediaResult.publicUrl ?? mediaResult.tempUrl ?? null
  }

  // Persist the message (content_type matches WaCRM's CHECK constraint).
  const contentType = msg.contentType === 'sticker' ? 'image' : msg.contentType
  const { data: msgRow, error: msgError } = await admin
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: msg.text || (msg.contentType === 'location' ? '[Location]' : null),
      media_url: mediaUrl,
      message_id: msg.messageId,
      status: 'delivered',
      reply_to_message_id: null,
      interactive_reply_id: msg.interactiveReplyId ?? null,
      source_provider: 'wasender',
      wats_msg_id: msg.messageId,
      sender_jid: msg.remoteJid,
    })
    .select('id')
    .single()
  if (msgError) {
    console.error('[webhook] message insert failed:', msgError)
    return
  }
  void msgRow

  // Conversation preview + unread.
  await admin
    .from('conversations')
    .update({
      last_message_text: msg.text || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // Broadcast reply tracking (recipient → replied).
  await flagBroadcastReplyIfAny(admin, session.accountId, contact.id)

  // First-inbound detection (before dispatch, for triggers).
  const { count } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (count ?? 0) === 0

  // ---- Pipeline: Flows → Automations → AI (WaCRM machinery) ----
  const flowMessage = msg.interactiveReplyId
    ? {
        kind: 'interactive_reply' as const,
        reply_id: msg.interactiveReplyId,
        reply_title: msg.text ?? '',
        meta_message_id: msg.messageId,
      }
    : {
        kind: 'text' as const,
        text: msg.text ?? '',
        meta_message_id: msg.messageId,
      }

  const flowResult = await dispatchInboundToFlows({
    accountId: session.accountId,
    userId: session.userId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: flowMessage,
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (msg.interactiveReplyId) automationTriggers.push('interactive_reply')
  }
  if (contact.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId: session.accountId,
      triggerType,
      contactId: contact.id,
      context: {
        message_text: msg.text ?? '',
        conversation_id: conversation.id,
        interactive_reply_id: msg.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && !msg.interactiveReplyId && (msg.text ?? '').trim()) {
    await dispatchInboundToAiReply({
      accountId: session.accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId: session.userId,
    })
  }

  await dispatchWebhookEvent(admin, session.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: msg.messageId,
    content_type: contentType,
    text: msg.text,
  })
}

// ---------------------------------------------------------------------
// Supporting handlers
// ---------------------------------------------------------------------

async function findOrCreateContact(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
  phone: string,
  name: string
): Promise<{ id: string; wasCreated: boolean } | null> {
  const existing = await findExistingContact(admin, accountId, phone)
  if (existing) {
    if (name && name !== existing.name) {
      await admin
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { id: existing.id, wasCreated: false }
  }

  const { data: created, error } = await admin
    .from('contacts')
    .insert({ account_id: accountId, user_id: userId, phone, name: name || phone })
    .select('id')
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(admin, accountId, phone)
      if (raced) return { id: raced.id, wasCreated: false }
    }
    console.error('[webhook] contact create failed:', error)
    return null
  }
  return { id: created.id, wasCreated: true }
}

async function findOrCreateConversation(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
  sessionId: string,
  isGroup: boolean
): Promise<{ id: string; unread_count: number } | null> {
  const { data: existing } = await admin
    .from('conversations')
    .select('id, unread_count')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)
  if (existing && existing.length > 0) return existing[0]

  const { data: created, error } = await admin
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      session_id: sessionId,
      is_group: isGroup,
      source_provider: 'wasender',
    })
    .select('id, unread_count')
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await admin
        .from('conversations')
        .select('id, unread_count')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) return raced[0]
    }
    console.error('[webhook] conversation create failed:', error)
    return null
  }
  return created
}

async function handleMessageStatusUpdate(
  admin: SupabaseClient,
  data: { update: { status: number }; key: { id: string } }
) {
  const statusMap: Record<number, string> = {
    0: 'failed',
    2: 'sent',
    3: 'delivered',
    4: 'read',
    5: 'read',
  }
  const next = statusMap[data.update.status] ?? 'sent'

  // Mirror onto messages (matches WaCRM's message_id column — our
  // inbound rows store the WasenderApi key.id there).
  await admin
    .from('messages')
    .update({ status: next })
    .eq('message_id', data.key.id)
}

async function flagBroadcastReplyIfAny(
  admin: SupabaseClient,
  accountId: string,
  contactId: string
) {
  try {
    const { data: recs } = await admin
      .from('broadcast_recipients')
      .select('id')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (recs && recs.length > 0) {
      await admin
        .from('broadcast_recipients')
        .update({ status: 'replied', replied_at: new Date().toISOString() })
        .eq('id', recs[0].id)
    }
  } catch (err) {
    console.error('[webhook] flagBroadcastReplyIfAny failed:', err)
  }
}

async function upsertGroupsFromWebhook(
  admin: SupabaseClient,
  accountId: string,
  sessionId: string,
  data: Array<{
    jid: string
    subject: string
    creation: number
    owner: string
    desc: string
    participants: Array<{ jid: string; isAdmin: boolean; isSuperAdmin: boolean }>
  }>
) {
  for (const g of data) {
    await admin
      .from('wasender_groups')
      .upsert(
        {
          account_id: accountId,
          session_id: sessionId,
          group_jid: g.jid,
          name: g.subject,
          is_active: true,
          synced_at: new Date().toISOString(),
        },
        { onConflict: 'session_id,group_jid' }
      )
  }
}

async function logGroupActivity(
  admin: SupabaseClient,
  accountId: string,
  data: { jid: string; participants: string[]; action: string }
) {
  const { data: group } = await admin
    .from('wasender_groups')
    .select('id')
    .eq('group_jid', data.jid)
    .eq('account_id', accountId)
    .limit(1)
  if (!group || group.length === 0) return
  for (const p of data.participants) {
    await admin.from('wasender_group_activity').insert({
      account_id: accountId,
      group_id: group[0].id,
      event_type: `member_${data.action}`,
      member_jid: p,
    })
  }
}

async function handleReactionEvent(
  admin: SupabaseClient,
  data: Array<{ key: { id: string }; reaction: { text: string } }>
) {
  for (const r of data) {
    const { data: msg } = await admin
      .from('messages')
      .select('id, conversation_id')
      .eq('message_id', r.key.id)
      .limit(1)
    if (!msg || msg.length === 0) continue

    // Resolve the conversation's contact — actor_id must reference the
    // reacting CUSTOMER (contact), not the message id.
    const { data: conv } = await admin
      .from('conversations')
      .select('contact_id')
      .eq('id', msg[0].conversation_id)
      .limit(1)
      .maybeSingle()
    if (!conv?.contact_id) continue

    // Upsert into WaCRM's message_reactions table (best-effort).
    try {
      await admin
        .from('message_reactions')
        .upsert(
          {
            message_id: msg[0].id,
            conversation_id: msg[0].conversation_id,
            actor_type: 'customer',
            actor_id: conv.contact_id,
            emoji: r.reaction.text,
          },
          { onConflict: 'message_id,actor_type,actor_id' }
        )
    } catch (err) {
      console.warn('[webhook] reaction upsert failed:', err)
    }
  }
}
