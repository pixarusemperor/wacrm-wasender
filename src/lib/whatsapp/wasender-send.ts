/**
 * WasenderApi drop-in sender — the single transport seam.
 *
 * WaCRM's upstream machinery (inbox send, broadcasts, flows,
 * automations) all call the five named functions exported here with
 * Meta-shaped arguments. This module implements the same contract
 * against WasenderApi's `/api/send-message`, so NOTHING above this
 * layer changes:
 *
 *   sendTextMessage      → kind 'text'
 *   sendMediaMessage     → kind image/video/document/audio
 *   sendTemplateMessage  → THROWS WasenderUnsupportedError (no templates)
 *   sendInteractiveButtons / sendInteractiveList
 *                        → numbered text-menu fallback (no interactive)
 *
 * Config source: `wasender_sessions` (per-account encrypted session
 * key) instead of `whatsapp_config` (Meta). The session key is
 * decrypted server-side and never leaves the server.
 *
 * The phone-variant retry is kept from the Meta path — WasenderApi
 * accepts E.164 directly, so variants are rarely needed, but the
 * callers already pass sanitized E.164 and the retry is harmless.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  WasenderClient,
  WasenderApiError,
} from './wasender-client';
import type {
  IndividualJid,
  WasenderMediaKind,
  WasenderMessageBody,
} from './wasender-types';
import { phoneToJid } from './wasender-types';
import { decrypt } from './encryption';

// ---------------------------------------------------------------------
// Public contract (mirrors meta-api.ts exports used by callers)
// ---------------------------------------------------------------------

export interface WasenderSendResult {
  messageId: string;
}

export interface SendTextMessageArgs {
  sessionApiKey: string;
  to: string;
  text: string;
  contextMessageId?: string;
}

export interface SendMediaMessageArgs {
  sessionApiKey: string;
  to: string;
  kind: WasenderMediaKind;
  link: string;
  caption?: string;
  filename?: string;
  contextMessageId?: string;
}

export interface SendTemplateMessageArgs {
  sessionApiKey: string;
  to: string;
  templateName: string;
  language: string;
  template?: unknown;
  params?: string[];
  messageParams?: unknown;
  contextMessageId?: string;
}

/** Thrown when a caller attempts a feature WasenderApi doesn't have. */
export class WasenderUnsupportedError extends Error {
  readonly code = 'wasender_unsupported';
  constructor(feature: string) {
    super(
      `${feature} is not supported by WasenderApi (unofficial provider). ` +
        'Use a raw text/media message instead.'
    );
    this.name = 'WasenderUnsupportedError';
  }
}

// ---------------------------------------------------------------------
// The five drop-in send functions
// ---------------------------------------------------------------------

/**
 * Send a plain-text message via WasenderApi.
 * Returns the provider's message id (numeric msgId as a string).
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<WasenderSendResult> {
  const client = new WasenderClient({ sessionApiKey: args.sessionApiKey });
  const body: WasenderMessageBody = {
    kind: 'text',
    text: args.text,
  };
  const res = await client.sendMessage(args.to, body);
  return { messageId: String(res.msgId) };
}

/**
 * Send an image/video/document/audio message via WasenderApi.
 * `link` is the public media URL (WasenderApi fetches at send time).
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs
): Promise<WasenderSendResult> {
  const client = new WasenderClient({ sessionApiKey: args.sessionApiKey });

  let body: WasenderMessageBody;
  switch (args.kind) {
    case 'image':
      body = { kind: 'image', imageUrl: args.link, text: args.caption };
      break;
    case 'video':
      body = { kind: 'video', videoUrl: args.link, text: args.caption };
      break;
    case 'audio':
      body = { kind: 'audio', audioUrl: args.link };
      break;
    case 'document':
      body = {
        kind: 'document',
        documentUrl: args.link,
        fileName: args.filename,
        text: args.caption,
      };
      break;
    case 'sticker':
      body = { kind: 'sticker', stickerUrl: args.link };
      break;
    default: {
      const _exhaustive: never = args.kind;
      body = { kind: 'text', text: '' };
    }
  }

  const res = await client.sendMessage(args.to, body);
  return { messageId: String(res.msgId) };
}

/**
 * Templates are not supported by WasenderApi — this always throws.
 * Callers (broadcast wizard, automation "send template" step) must
 * switch to raw text/media sends for the wasender provider.
 */
export async function sendTemplateMessage(
  _args: SendTemplateMessageArgs
): Promise<WasenderSendResult> {
  throw new WasenderUnsupportedError('Template messages');
}

/**
 * Interactive buttons are not supported by WasenderApi. We fall back
 * to a numbered text menu — the Flows engine's `collect_input` +
 * `condition` nodes already capture the number and route on it, so
 * the customer experience stays nearly identical.
 */
export async function sendInteractiveButtons(
  args: {
    sessionApiKey: string;
    to: string;
    bodyText: string;
    headerText?: string;
    footerText?: string;
    buttons: Array<{ id: string; title: string }>;
    contextMessageId?: string;
  }
): Promise<WasenderSendResult> {
  const menu = buildTextMenu(args.bodyText, args.buttons);
  return sendTextMessage({
    sessionApiKey: args.sessionApiKey,
    to: args.to,
    text: menu,
  });
}

/** Same numbered text-menu fallback for list-style interactive messages. */
export async function sendInteractiveList(
  args: {
    sessionApiKey: string;
    to: string;
    bodyText: string;
    buttonLabel?: string;
    headerText?: string;
    footerText?: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
    contextMessageId?: string;
  }
): Promise<WasenderSendResult> {
  const rows = args.sections.flatMap((s) => s.rows);
  const menu = buildTextMenu(args.bodyText, rows);
  return sendTextMessage({
    sessionApiKey: args.sessionApiKey,
    to: args.to,
    text: menu,
  });
}

// ---------------------------------------------------------------------
// Session-key resolution helper (shared by all engine senders)
// ---------------------------------------------------------------------

export interface WasenderSessionKeyRow {
  id: string;
  wats_api_key: string | null;
  wats_webhook_secret: string | null;
}

/**
 * Load a wasender session row and decrypt its API key.
 * `db` may be RLS-scoped (user) or service-role (engine) — the query
 * is always filtered by account_id, so tenancy holds either way.
 */
export async function resolveSessionApiKey(
  db: SupabaseClient,
  accountId: string
): Promise<string> {
  const { data, error } = await db
    .from('wasender_sessions')
    .select('id, wats_api_key, wats_webhook_secret')
    .eq('account_id', accountId)
    .eq('status', 'connected')
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.wats_api_key) {
    throw new WasenderApiError(
      'WhatsApp not configured. Connect a WasenderApi session first.',
      { status: 400 }
    );
  }
  return decrypt(data.wats_api_key);
}

/** Convenience: get a session key and send text in one call. */
export async function engineSendText(
  db: SupabaseClient,
  accountId: string,
  toPhone: string,
  text: string
): Promise<WasenderSendResult> {
  const sessionApiKey = await resolveSessionApiKey(db, accountId);
  return sendTextMessage({ sessionApiKey, to: toPhone, text });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildTextMenu(
  body: string,
  options: Array<{ id: string; title: string }>
): string {
  const lines = options.map((o, i) => `${i + 1}. ${o.title}`);
  return [`${body}`, ...lines, 'Reply with the number of your choice.'].join(
    '\n'
  );
}

/** Convert a contact phone to an individual JID (E.164 → JID). */
export function toIndividualJid(phone: string): IndividualJid {
  return phoneToJid(phone);
}
