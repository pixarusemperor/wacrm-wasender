/**
 * WasenderApi domain types — Matt Pocock style.
 *
 * The types are the living documentation of the WasenderApi integration
 * decisions. Branded `Jid` makes it impossible to pass a phone number
 * where a JID is required (and vice versa) without an explicit converter.
 * The `WasenderMessagePayload` discriminated union encodes every message
 * shape the API accepts at `/api/send-message` — adding a new message
 * kind forces the send path to handle it (exhaustive switch).
 *
 * Source: https://wasenderapi.com/llms.txt (fetched 2026-07-31).
 */

// ---------------------------------------------------------------------
// JID handling — WasenderApi uses WhatsApp JIDs everywhere.
//   Individual: "5511999999999@s.whatsapp.net"
//   Group:      "123456789-987654321@g.us"
//   Channel:    "123456789@newsletter"
//   LID:        "123456789@lid" (never store; resolve to a phone first)
// WaCRM stores E.164 phones on `contacts`; convert at the boundary.
// ---------------------------------------------------------------------

export type Jid = string & { readonly __brand: 'Jid' };

// Specific JID flavors use a SEPARATE brand property so they can
// intersect with the parent Jid brand without collapsing to never
// (two different literal `__brand` values would conflict).
export type IndividualJid = string & { readonly __brand: 'Jid' } & {
  readonly __jidKind: 'individual';
};
export type GroupJid = string & { readonly __brand: 'Jid' } & {
  readonly __jidKind: 'group';
};
export type ChannelJid = string & { readonly __brand: 'Jid' } & {
  readonly __jidKind: 'channel';
};

/** Convert an E.164 phone (e.g. "+15550199") to an individual JID. */
export function phoneToJid(phone: string): IndividualJid {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net` as IndividualJid;
}

/** Extract the E.164 digits from an individual JID. */
export function jidToPhone(jid: IndividualJid): string {
  return `+${jid.replace(/@s\.whatsapp\.net$/, '')}`;
}

export function isGroupJid(jid: string): jid is GroupJid {
  return jid.endsWith('@g.us');
}

export function isChannelJid(jid: string): jid is ChannelJid {
  return jid.endsWith('@newsletter');
}

// ---------------------------------------------------------------------
// Session statuses (GET /api/status + session.status webhook)
// ---------------------------------------------------------------------

export type WasenderSessionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'need_scan'
  | 'need_passkey'
  | 'logged_out'
  | 'expired';

export type WasenderLinkMethod = 'qr' | 'passkey';

export interface WasenderSessionCreateParams {
  name: string;
  phone_number: string;
  account_protection?: boolean;
  log_messages?: boolean;
  webhook_url?: string;
  webhook_enabled?: boolean;
  webhook_events?: string[];
  read_incoming_messages?: boolean;
  auto_reject_calls?: boolean;
  ignore_groups?: boolean;
  ignore_channels?: boolean;
  ignore_broadcasts?: boolean;
  proxy_url?: string;
  always_online?: boolean;
}

/** The session row as returned by the WasenderApi (PAT endpoints). */
export interface WasenderSession {
  id: number;
  name: string;
  phone_number: string;
  status: string;
  account_protection: boolean;
  log_messages: boolean;
  webhook_url: string | null;
  webhook_enabled: boolean;
  webhook_events: string[] | null;
  api_key?: string;
  webhook_secret?: string;
  proxy_url?: string | null;
  always_online?: boolean;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------
// Message sending — POST /api/send-message
// One endpoint, discriminated payload. `to` accepts E.164, group JID,
// or channel JID per the docs.
// ---------------------------------------------------------------------

export interface SendTextBody {
  kind: 'text';
  text: string;
  replyTo?: number;
}

export interface SendImageBody {
  kind: 'image';
  imageUrl: string;
  text?: string;
  replyTo?: number;
  viewOnce?: boolean;
}

export interface SendVideoBody {
  kind: 'video';
  videoUrl: string;
  text?: string;
  replyTo?: number;
  viewOnce?: boolean;
}

export interface SendAudioBody {
  kind: 'audio';
  audioUrl: string;
  text?: string;
  replyTo?: number;
  viewOnce?: boolean;
}

export interface SendDocumentBody {
  kind: 'document';
  documentUrl: string;
  fileName?: string;
  text?: string;
  replyTo?: number;
}

export interface SendStickerBody {
  kind: 'sticker';
  stickerUrl: string;
  replyTo?: number;
}

export interface SendContactBody {
  kind: 'contact';
  contact: { name: string; phone: string };
  replyTo?: number;
}

export interface SendLocationBody {
  kind: 'location';
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  replyTo?: number;
}

export interface SendPollBody {
  kind: 'poll';
  poll: {
    question: string;
    options: string[]; // min 2, max 12
    multiSelect?: boolean;
  };
  replyTo?: number;
}

export interface SendMentionsBody {
  kind: 'mentions';
  text: string;
  mentions: IndividualJid[];
  replyTo?: number;
}

/**
 * Discriminated union of everything WasenderApi accepts at
 * `/api/send-message`. The `kind` discriminator drives the payload
 * builder's exhaustive switch — a new kind fails compilation until
 * the builder handles it.
 */
export type WasenderMessageBody =
  | SendTextBody
  | SendImageBody
  | SendVideoBody
  | SendAudioBody
  | SendDocumentBody
  | SendStickerBody
  | SendContactBody
  | SendLocationBody
  | SendPollBody
  | SendMentionsBody;

export interface WasenderSendResult {
  msgId: number;
  jid: string;
  status: 'in_progress';
}

/** Media kinds WasenderApi accepts as URL params on /api/send-message. */
export type WasenderMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/**
 * Media kinds the WaCRM message orchestrator supports for outbound
 * sends (the flow send_media node and composer). Sticker is excluded
 * here because the composer has no sticker picker — keep the narrower
 * type so the flow validator stays honest.
 */
export type MediaKind = 'image' | 'video' | 'document' | 'audio';


// ---------------------------------------------------------------------
// Presence (POST /api/send-presence-update)
// Rule from the docs: composing/recording → recipient's JID;
// available/unavailable → YOUR OWN number as the JID.
// ---------------------------------------------------------------------

export type WasenderPresenceType =
  | 'composing'
  | 'recording'
  | 'available'
  | 'unavailable';

export interface WasenderPresenceParams {
  jid: Jid;
  type: WasenderPresenceType;
  delayMs?: number;
}

// ---------------------------------------------------------------------
// Message status codes (GET /api/messages/{msgId}/info + messages.update)
// ---------------------------------------------------------------------

export type WasenderMessageStatus =
  | 0 // ERROR
  | 1 // PENDING
  | 2 // SENT
  | 3 // DELIVERED
  | 4 // READ
  | 5; // PLAYED

/** Map a WasenderApi numeric status to a WaCRM message status string. */
export function wasenderStatusToWacrm(status: WasenderMessageStatus): string {
  switch (status) {
    case 0:
      return 'failed';
    case 1:
      return 'sent'; // pending → we treat as sent (best effort)
    case 2:
      return 'sent';
    case 3:
      return 'delivered';
    case 4:
      return 'read';
    case 5:
      return 'read'; // played ≈ read for media
    default: {
      const _exhaustive: never = status;
      return 'sent';
    }
  }
}

// ---------------------------------------------------------------------
// Webhook payloads (flattened, from wasenderapi.com/llms.txt)
// ---------------------------------------------------------------------

/** The message key — remoteJid can be a LID; always prefer the cleaned fields. */
export interface WasenderMessageKey {
  id: string;
  fromMe: boolean;
  remoteJid: string;
  addressingMode?: string;
  senderPn?: string;
  cleanedSenderPn?: string;
  senderLid?: string;
  participant?: string;
  participantPn?: string;
  cleanedParticipantPn?: string;
  participantLid?: string;
}

export interface WasenderInboundMessage {
  key: WasenderMessageKey;
  /** Unified text — always present for text, media captions, replies. */
  messageBody: string;
  /** Raw message content: {conversation} or {imageMessage: {...}} etc. */
  message: Record<string, unknown>;
}

/** messages.received / messages-group.received / -personal / -newsletter. */
export interface WasenderMessageReceivedWebhook {
  event:
    | 'messages.received'
    | 'messages-group.received'
    | 'messages-personal.received'
    | 'messages-newsletter.received';
  timestamp: number;
  data: {
    /** Object — NOT an array — for the *.received events. */
    messages: WasenderInboundMessage;
  };
}

/** messages.upsert — data.messages is an ARRAY (both directions). */
export interface WasenderMessageUpsertWebhook {
  event: 'messages.upsert';
  timestamp: number;
  data: {
    messages: WasenderInboundMessage[];
  };
}

/** messages.update — status 0-5. */
export interface WasenderMessageUpdateWebhook {
  event: 'messages.update';
  sessionId?: string;
  timestamp: number;
  data: {
    update: { status: WasenderMessageStatus };
    key: WasenderMessageKey;
  };
}

/** message.sent — our own outbound ack. */
export interface WasenderMessageSentWebhook {
  event: 'message.sent';
  timestamp: number;
  data: {
    key: WasenderMessageKey;
    message?: Record<string, unknown>;
    success: boolean;
    error?: string;
  };
}

/** session.status — connection state changed. */
export interface WasenderSessionStatusWebhook {
  event: 'session.status';
  sessionId: string;
  timestamp: number;
  data: { status: WasenderSessionStatus };
}

/** qrcode.updated — a fresh QR string for the linking UI. */
export interface WasenderQrCodeWebhook {
  event: 'qrcode.updated';
  sessionId: string;
  timestamp: number;
  data: { qr: string };
}

/** groups.upsert — joined a group or metadata changed. */
export interface WasenderGroupUpsertWebhook {
  event: 'groups.upsert';
  timestamp: number;
  data: Array<{
    jid: GroupJid;
    subject: string;
    creation: number;
    owner: string;
    desc: string;
    participants: Array<{ jid: string; isAdmin: boolean; isSuperAdmin: boolean }>;
  }>;
}

/** group-participants.update — add/remove/promote/demote. */
export interface WasenderGroupParticipantsWebhook {
  event: 'group-participants.update';
  timestamp: number;
  data: {
    jid: GroupJid;
    participants: string[];
    action: 'add' | 'remove' | 'promote' | 'demote';
  };
}

/** contacts.upsert — contact list changed. */
export interface WasenderContactUpsertWebhook {
  event: 'contacts.upsert';
  timestamp: number;
  data: Array<{
    jid: string;
    name?: string;
    notify?: string;
    verifiedName?: string;
    status?: string;
  }>;
}

/** messages.reaction — someone reacted to a message. */
export interface WasenderReactionWebhook {
  event: 'messages.reaction';
  timestamp: number;
  data: Array<{
    key: WasenderMessageKey;
    reaction: { text: string; key: WasenderMessageKey };
  }>;
}

/** call — incoming voice/video call. */
export interface WasenderCallWebhook {
  event: 'call';
  timestamp: number;
  data: {
    call: {
      id: string;
      from: string;
      date: string;
      isGroup: boolean;
      isVideo: boolean;
      status: string;
    };
  };
}

/** Every webhook the app understands, discriminated by `event`. */
export type WasenderWebhookPayload =
  | WasenderMessageReceivedWebhook
  | WasenderMessageUpsertWebhook
  | WasenderMessageUpdateWebhook
  | WasenderMessageSentWebhook
  | WasenderSessionStatusWebhook
  | WasenderQrCodeWebhook
  | WasenderGroupUpsertWebhook
  | WasenderGroupParticipantsWebhook
  | WasenderContactUpsertWebhook
  | WasenderReactionWebhook
  | WasenderCallWebhook;

/**
 * Discriminate a raw webhook body by its `event` field.
 * Returns null for unknown/unhandled events (we ack 200 and skip).
 */
export function parseWasenderWebhook(
  raw: Record<string, unknown>
): WasenderWebhookPayload | null {
  const event = typeof raw.event === 'string' ? raw.event : '';
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();
  const data = raw.data as Record<string, unknown>;

  switch (event) {
    case 'messages.received':
    case 'messages-group.received':
    case 'messages-personal.received':
    case 'messages-newsletter.received':
      return { event, timestamp, data: { messages: data.messages as WasenderInboundMessage } };
    case 'messages.upsert':
      return { event, timestamp, data: { messages: data.messages as WasenderInboundMessage[] } };
    case 'messages.update':
      return { event, timestamp, data: data as WasenderMessageUpdateWebhook['data'] };
    case 'message.sent':
      return { event, timestamp, data: data as WasenderMessageSentWebhook['data'] };
    case 'session.status':
      return {
        event,
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
        timestamp,
        data: data as WasenderSessionStatusWebhook['data'],
      };
    case 'qrcode.updated':
      return {
        event,
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
        timestamp,
        data: data as WasenderQrCodeWebhook['data'],
      };
    case 'groups.upsert':
      return { event, timestamp, data: (data as unknown as WasenderGroupUpsertWebhook['data']) };
    case 'group-participants.update':
      return { event, timestamp, data: data as WasenderGroupParticipantsWebhook['data'] };
    case 'contacts.upsert':
      return { event, timestamp, data: (data as unknown as WasenderContactUpsertWebhook['data']) };
    case 'messages.reaction':
      return { event, timestamp, data: (data as unknown as WasenderReactionWebhook['data']) };
    case 'call':
      return { event, timestamp, data: data as WasenderCallWebhook['data'] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------
// Group types (GET /api/groups, /metadata, /participants)
// ---------------------------------------------------------------------

export interface WasenderGroup {
  jid: GroupJid;
  name: string;
  imgUrl: string | null;
}

export interface WasenderGroupMetadata {
  jid: GroupJid;
  subject: string;
  creation: number;
  owner: string;
  desc?: string;
  participants: Array<{
    jid: string;
    isAdmin: boolean;
    isSuperAdmin: boolean;
  }>;
}

export interface WasenderGroupParticipant {
  id: string;
  admin?: 'admin' | 'superadmin' | null;
}

// ---------------------------------------------------------------------
// Rate limits — from wasenderapi.com/api-docs/rate-limits
// ---------------------------------------------------------------------

export interface WasenderRateLimitInfo {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  dailyReset: number | null;
}

/** Extract rate-limit headers from a fetch Response. */
export function parseRateLimitHeaders(headers: Headers): WasenderRateLimitInfo {
  const num = (v: string | null): number | null => {
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: num(headers.get('x-ratelimit-limit')),
    remaining: num(headers.get('x-ratelimit-remaining')),
    reset: num(headers.get('x-ratelimit-reset')),
    dailyLimit: num(headers.get('x-ratelimit-daily-limit')),
    dailyRemaining: num(headers.get('x-ratelimit-daily-remaining')),
    dailyReset: num(headers.get('x-ratelimit-daily-reset')),
  };
}
