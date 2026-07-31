/**
 * Normalize WasenderApi webhook payloads into WaCRM's message shape.
 *
 * Pure functions — no DB, no fetch — so the webhook route stays thin
 * and every transformation is unit-testable (TDD).
 *
 * Key WasenderApi facts encoded here (from wasenderapi.com/llms.txt):
 *   - `data.messages` is an OBJECT for messages.received / -group.received
 *     / -personal.received / -newsletter.received; an ARRAY for
 *     messages.upsert.
 *   - `key.remoteJid` may be a LID (`@lid`) — never use it as a phone.
 *     Use `key.cleanedSenderPn` (private) / `key.cleanedParticipantPn`
 *     (group) for the sender's real E.164 number.
 *   - `messageBody` is the unified text (text, captions, replies).
 *   - Media lives in `message.<kind>Message` with `url` + `mediaKey`
 *     and is decrypted via POST /api/decrypt-media.
 */

import type { WasenderWebhookPayload, WasenderInboundMessage } from './wasender-types';

// ---------------------------------------------------------------------
// Normalized outbound shape (what the webhook route persists)
// ---------------------------------------------------------------------

export type NormalizedContentType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'location'
  | 'sticker'
  | 'interactive'
  | 'template'
  | 'reaction';

export interface NormalizedInboundMessage {
  /** WaCRM messages.message_id (the WasenderApi key.id). */
  messageId: string;
  /** The sender's real E.164 phone (cleanedSenderPn / cleanedParticipantPn). */
  senderPhone: string;
  /** The chat's JID (remoteJid) — may be a group JID. */
  remoteJid: string;
  isGroup: boolean;
  fromMe: boolean;
  /** Unified text — captions and button replies included. */
  text: string;
  contentType: NormalizedContentType;
  /** Present when the message carries media. Pass this object to
   *  /api/decrypt-media to get a temporary public URL. */
  media?: {
    kind: Exclude<NormalizedContentType, 'text' | 'location' | 'reaction' | 'interactive' | 'template'>;
    url: string;
    mediaKey: string;
    mimetype?: string;
    fileName?: string;
  };
  /** For button/list replies: the option id (drives flow routing). */
  interactiveReplyId?: string;
  /** Unix seconds timestamp. */
  timestamp: number;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Extract the sender's E.164 phone from a message key. */
export function senderPhoneFromKey(key: WasenderInboundMessage['key']): string {
  // Group messages carry the participant's number; private chats the sender's.
  const pn = key.cleanedParticipantPn ?? key.cleanedSenderPn;
  if (pn) return `+${pn.replace(/\D/g, '')}`;
  // Fallback: strip the JID suffix (only safe for @s.whatsapp.net).
  const jid = key.remoteJid ?? '';
  if (jid.endsWith('@s.whatsapp.net')) {
    return `+${jid.replace(/@s\.whatsapp\.net$/, '')}`;
  }
  return '';
}

/** True when a remoteJid is a group JID. */
export function isGroupRemoteJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

const MEDIA_KIND_MAP: Record<string, Exclude<NormalizedContentType, 'text' | 'location' | 'reaction' | 'interactive' | 'template'>> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

const ALLOWED_CONTENT_TYPES: NormalizedContentType[] = [
  'text', 'image', 'document', 'audio', 'video',
  'location', 'template', 'interactive', 'sticker',
];

/** Extract media info from the raw message object, if any. */
function extractMedia(message: Record<string, unknown>): NormalizedInboundMessage['media'] {
  for (const [key, value] of Object.entries(message)) {
    const kind = MEDIA_KIND_MAP[key];
    if (!kind) continue;
    const media = (value ?? {}) as Record<string, unknown>;
    const url = typeof media.url === 'string' ? media.url : '';
    const mediaKey = typeof media.mediaKey === 'string' ? media.mediaKey : '';
    if (url && mediaKey) {
      return {
        kind,
        url,
        mediaKey,
        mimetype: typeof media.mimetype === 'string' ? media.mimetype : undefined,
        fileName: typeof media.fileName === 'string' ? media.fileName : undefined,
      };
    }
  }
  return undefined;
}

/** Detect an interactive (button/list) reply in the raw message. */
function extractInteractiveReply(message: Record<string, unknown>): string | undefined {
  const interactive = message.interactiveMessage as
    | { buttonReplyMessage?: { id?: string }; listReplyMessage?: { id?: string } }
    | undefined;
  const id = interactive?.buttonReplyMessage?.id ?? interactive?.listReplyMessage?.id;
  return id || undefined;
}

// ---------------------------------------------------------------------
// The normalizer
// ---------------------------------------------------------------------

/**
 * Normalize one inbound message object into WaCRM's shape.
 * Pure — no DB, no API calls.
 */
export function normalizeInboundMessage(
  msg: WasenderInboundMessage
): NormalizedInboundMessage {
  const key = msg.key;
  const rawMessage = msg.message ?? {};

  // Media detection: the raw object may carry conversation (text) or a
  // media sub-object.
  const media = extractMedia(rawMessage);
  const interactiveReplyId = extractInteractiveReply(rawMessage);

  // Determine content type:
  //   - explicit interactive reply → 'interactive'
  //   - media present → the media kind
  //   - otherwise 'text' (messageBody covers text + captions)
  let contentType: NormalizedContentType = 'text';
  if (interactiveReplyId) {
    contentType = 'interactive';
  } else if (media) {
    contentType = media.kind;
  } else if (rawMessage.locationMessage) {
    contentType = 'location';
  } else if (rawMessage.conversation === undefined && rawMessage.extendedTextMessage === undefined) {
    contentType = 'text';
  }

  return {
    messageId: key.id,
    senderPhone: senderPhoneFromKey(key),
    remoteJid: key.remoteJid,
    isGroup: isGroupRemoteJid(key.remoteJid),
    fromMe: key.fromMe,
    text: msg.messageBody ?? '',
    contentType,
    media,
    interactiveReplyId,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/**
 * Extract the message list from a parsed webhook, handling both the
 * object (`.received` events) and array (`messages.upsert`) shapes.
 * Pure — returns an empty array for events without messages.
 */
export function extractInboundMessages(
  payload: WasenderWebhookPayload
): WasenderInboundMessage[] {
  switch (payload.event) {
    case 'messages.received':
    case 'messages-group.received':
    case 'messages-personal.received':
    case 'messages-newsletter.received':
      return [payload.data.messages];
    case 'messages.upsert':
      return payload.data.messages;
    default:
      return [];
  }
}

/**
 * Map a WasenderApi webhook to a normalized message batch.
 * Returns [] for events that carry no inbound customer message
 * (status updates, session status, etc.).
 */
export function webhookToNormalizedMessages(
  payload: WasenderWebhookPayload
): NormalizedInboundMessage[] {
  return extractInboundMessages(payload)
    .filter((m) => !m.key.fromMe) // inbound only
    .map(normalizeInboundMessage)
    .filter((m) => m.senderPhone !== '' || m.isGroup);
}
