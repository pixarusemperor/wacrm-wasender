/**
 * WasenderApi HTTP client — the unofficial WhatsApp gateway.
 *
 * Base URL: https://wasenderapi.com
 * Auth: two tiers, both `Authorization: Bearer <token>`:
 *   - PAT (Personal Access Token): account-level ops (session CRUD,
 *     connect, QR, proxy/webhook config). SaaS-owner token, server-side.
 *   - Session API Key: per-connected-session ops (messaging, media,
 *     contacts, groups, presence). Stored encrypted per account.
 *
 * Every endpoint here was verified against https://wasenderapi.com/llms.txt
 * on 2026-07-31. Response shape is consistently
 *   { success: true, data: ... }  |  { success: false, message, errors? }
 * HTTP errors and `success: false` bodies both throw `WasenderApiError`.
 */

import {
  type ChannelJid,
  type GroupJid,
  type IndividualJid,
  type Jid,
  type WasenderGroup,
  type WasenderGroupMetadata,
  type WasenderGroupParticipant,
  type WasenderMessageBody,
  type WasenderMessageStatus,
  type WasenderPresenceParams,
  type WasenderPresenceType,
  type WasenderSendResult,
  type WasenderSession,
  type WasenderSessionCreateParams,
  type WasenderSessionStatus,
  type WasenderRateLimitInfo,
  parseRateLimitHeaders,
  phoneToJid,
} from './wasender-types';

export const WASENDER_BASE_URL =
  process.env.WASENDER_BASE_URL || 'https://wasenderapi.com';

export class WasenderApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly rateLimit?: WasenderRateLimitInfo;

  constructor(
    message: string,
    opts: {
      status: number;
      code?: string;
      retryAfterSeconds?: number;
      rateLimit?: WasenderRateLimitInfo;
    }
  ) {
    super(message);
    this.name = 'WasenderApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.rateLimit = opts.rateLimit;
  }
}

/** True when an error is worth retrying (429 or 5xx). */
export function isRetryableWasenderError(err: unknown): boolean {
  if (err instanceof WasenderApiError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  return false;
}

interface WasenderClientConfig {
  pat?: string;
  sessionApiKey?: string;
  baseUrl?: string;
}

/**
 * Low-level WasenderApi client.
 *
 * Construct with a PAT for account-level ops, a session API key for
 * messaging ops, or both (session management needs PAT; sending needs
 * the session key).
 */
export class WasenderClient {
  private readonly pat?: string;
  private readonly sessionApiKey?: string;
  private readonly baseUrl: string;

  constructor(config: WasenderClientConfig = {}) {
    this.pat = config.pat;
    this.sessionApiKey = config.sessionApiKey;
    this.baseUrl = (config.baseUrl || WASENDER_BASE_URL).replace(/\/$/, '');
  }

  // -------------------------------------------------------------------
  // Request plumbing
  // -------------------------------------------------------------------

  private headers(auth: 'pat' | 'session'): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const token = auth === 'pat' ? this.pat : this.sessionApiKey;
    if (!token) {
      throw new WasenderApiError(
        auth === 'pat'
          ? 'WasenderClient: PAT required for this operation'
          : 'WasenderClient: Session API key required for this operation',
        { status: 0 }
      );
    }
    headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { auth: 'pat' | 'session'; body?: unknown; rawBody?: BodyInit } = {
      auth: 'session',
    }
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.headers(opts.auth);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body:
          opts.rawBody !== undefined
            ? opts.rawBody
            : opts.body !== undefined
              ? JSON.stringify(opts.body)
              : undefined,
      });
    } catch (err) {
      throw new WasenderApiError(
        `WasenderApi network error: ${err instanceof Error ? err.message : String(err)}`,
        { status: 0 }
      );
    }

    const rateLimit = parseRateLimitHeaders(res.headers);

    // 204 No Content (session delete) — nothing to parse.
    if (res.status === 204) {
      return {} as T;
    }

    let body: Record<string, unknown> | unknown[] | null = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON body — preserve status text for debugging.
      const text = await res.text().catch(() => '');
      throw new WasenderApiError(
        `WasenderApi HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
        { status: res.status, rateLimit }
      );
    }

    const obj = (Array.isArray(body) ? body[0] : body) as
      | (Record<string, unknown> | null)
      | undefined;
    const success = obj ? (obj as Record<string, unknown>).success !== false : true;
    const message =
      obj && typeof (obj as Record<string, unknown>).message === 'string'
        ? ((obj as Record<string, unknown>).message as string)
        : obj && typeof (obj as Record<string, unknown>).error === 'string'
          ? ((obj as Record<string, unknown>).error as string)
          : null;
    const retryAfter =
      res.headers.get('retry-after') ?? (obj as Record<string, unknown>)?.retry_after;
    const retryAfterSeconds =
      retryAfter !== null && retryAfter !== undefined
        ? Number(retryAfter)
        : undefined;

    if (!res.ok || !success) {
      throw new WasenderApiError(
        message || `WasenderApi HTTP ${res.status}`,
        {
          status: res.status,
          code: (obj as Record<string, unknown>)?.error as string | undefined,
          retryAfterSeconds: Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds
            : undefined,
          rateLimit,
        }
      );
    }

    // Unwrap { data: ... } when present.
    if (obj && typeof obj === 'object' && 'data' in obj) {
      return (obj as Record<string, unknown>).data as T;
    }
    return (Array.isArray(body) ? body : body ?? {}) as T;
  }

  // -------------------------------------------------------------------
  // Sessions (PAT auth)
  // -------------------------------------------------------------------

  getSessions(): Promise<WasenderSession[]> {
    return this.request<WasenderSession[]>('GET', '/api/whatsapp-sessions', {
      auth: 'pat',
    });
  }

  getSession(id: number | string): Promise<WasenderSession> {
    return this.request<WasenderSession>(
      'GET',
      `/api/whatsapp-sessions/${id}`,
      { auth: 'pat' }
    );
  }

  createSession(
    params: WasenderSessionCreateParams
  ): Promise<WasenderSession> {
    return this.request<WasenderSession>('POST', '/api/whatsapp-sessions', {
      auth: 'pat',
      body: {
        account_protection: true,
        log_messages: true,
        ...params,
      },
    });
  }

  updateSession(
    id: number | string,
    params: Partial<WasenderSessionCreateParams>
  ): Promise<WasenderSession> {
    return this.request<WasenderSession>(
      'PUT',
      `/api/whatsapp-sessions/${id}`,
      { auth: 'pat', body: params }
    );
  }

  deleteSession(id: number | string): Promise<void> {
    return this.request<void>('DELETE', `/api/whatsapp-sessions/${id}`, {
      auth: 'pat',
    });
  }

  connectSession(
    id: number | string,
    linkMethod: 'qr' | 'passkey' = 'qr'
  ): Promise<
    | { status: 'NEED_SCAN'; qrCode: string }
    | { status: 'NEED_PASSKEY'; passkey: { token: string; expires_at: string } }
    | { status: 'CONNECTED'; message: string }
  > {
    return this.request('POST', `/api/whatsapp-sessions/${id}/connect`, {
      auth: 'pat',
      body: { linkMethod },
    });
  }

  getQrCode(id: number | string): Promise<{ qrCode: string }> {
    return this.request<{ qrCode: string }>(
      'GET',
      `/api/whatsapp-sessions/${id}/qrcode`,
      { auth: 'pat' }
    );
  }

  restartSession(id: number | string): Promise<{ message: string }> {
    return this.request('POST', `/api/whatsapp-sessions/${id}/restart`, {
      auth: 'pat',
    });
  }

  disconnectSession(id: number | string): Promise<{ status: string }> {
    return this.request('POST', `/api/whatsapp-sessions/${id}/disconnect`, {
      auth: 'pat',
    });
  }

  regenerateApiKey(id: number | string): Promise<{ api_key: string }> {
    return this.request('POST', `/api/whatsapp-sessions/${id}/regenerate-key`, {
      auth: 'pat',
    });
  }

  getSessionStatus(): Promise<{ status: WasenderSessionStatus }> {
    return this.request<{ status: WasenderSessionStatus }>('GET', '/api/status', {
      auth: 'session',
    });
  }

  // -------------------------------------------------------------------
  // Messaging (session key auth) — POST /api/send-message
  // -------------------------------------------------------------------

  /**
   * Send any supported message type. `to` accepts an E.164 phone, an
   * individual JID, a group JID, or a channel JID (the API is lenient;
   * our types keep the call sites honest).
   */
  async sendMessage(
    to: string | Jid,
    body: WasenderMessageBody
  ): Promise<WasenderSendResult> {
    const payload = buildSendPayload(to, body);
    return this.request<WasenderSendResult>('POST', '/api/send-message', {
      auth: 'session',
      body: payload,
    });
  }

  editMessage(
    msgId: number,
    text: string
  ): Promise<Record<string, unknown>> {
    return this.request('PUT', `/api/messages/${msgId}`, {
      auth: 'session',
      body: { text },
    });
  }

  deleteMessage(msgId: number): Promise<{ message: string }> {
    return this.request('DELETE', `/api/messages/${msgId}`, { auth: 'session' });
  }

  getMessageInfo(msgId: number): Promise<{
    remoteJid: string;
    id: string;
    msgId: number;
    status: WasenderMessageStatus;
  }> {
    return this.request('GET', `/api/messages/${msgId}/info`, {
      auth: 'session',
    });
  }

  markMessageAsRead(key: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
  }): Promise<{ status: string }> {
    return this.request<{ status: string }>('POST', '/api/messages/read', {
      auth: 'session',
      body: { key },
    });
  }

  resendMessage(msgId: number): Promise<{ message: string }> {
    return this.request('POST', `/api/messages/${msgId}/resend`, {
      auth: 'session',
    });
  }

  // -------------------------------------------------------------------
  // Media (session key auth)
  // -------------------------------------------------------------------

  /**
   * Decrypt inbound media. Send the FULL webhook message object
   * (as received in `messages.received`) — the API reads
   * `data.messages.message.<kind>Message.{url,mediaKey}`.
   * Returns a public URL valid for 1 hour.
   */
  decryptMedia(
    webhookData: { messages: { key: unknown; message: Record<string, unknown> } }
  ): Promise<{ publicUrl: string }> {
    return this.request<{ publicUrl: string }>('POST', '/api/decrypt-media', {
      auth: 'session',
      body: { data: webhookData },
    });
  }

  /**
   * Upload media (raw binary or base64 JSON). Returns a public URL
   * valid for 24 hours. Limits: docs 100MB, images 16MB, videos 50MB,
   * audio 16MB, stickers 5MB.
   */
  async uploadMedia(
    file: Uint8Array,
    mimeType: string
  ): Promise<{ publicUrl: string }> {
    const res = await fetch(`${this.baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.sessionApiKey}`,
        'Content-Type': mimeType,
      },
      body: file as BodyInit,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.success === false) {
      throw new WasenderApiError(
        (body.message as string) || `WasenderApi upload HTTP ${res.status}`,
        { status: res.status }
      );
    }
    return body as { publicUrl: string };
  }

  // -------------------------------------------------------------------
  // Presence (session key auth)
  // -------------------------------------------------------------------

  sendPresence(params: WasenderPresenceParams): Promise<unknown> {
    return this.request('POST', '/api/send-presence-update', {
      auth: 'session',
      body: params,
    });
  }

  /**
   * Typing indicator for the recipient (composing/recording must target
   * the recipient's JID per the docs).
   */
  sendTyping(jid: Jid, type: 'composing' | 'recording' = 'composing') {
    return this.sendPresence({ jid, type });
  }

  // -------------------------------------------------------------------
  // Contacts (session key auth)
  // -------------------------------------------------------------------

  getContacts(params?: {
    paginated?: boolean;
    page?: number;
    limit?: number;
  }): Promise<Array<{ jid: string; name?: string; notify?: string; imgUrl?: string }>> {
    const q = new URLSearchParams();
    if (params?.paginated) q.append('paginated', 'true');
    if (params?.page) q.append('page', String(params.page));
    if (params?.limit) q.append('limit', String(params.limit));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request('GET', `/api/contacts${qs}`, { auth: 'session' });
  }

  upsertContact(params: {
    jid: IndividualJid;
    fullName?: string;
    saveOnPrimaryAddressbook?: boolean;
  }): Promise<{ jid: string; fullName?: string }> {
    return this.request('PUT', '/api/contacts', {
      auth: 'session',
      body: params,
    });
  }

  blockContact(phone: string): Promise<{ message: string }> {
    return this.request('POST', `/api/contacts/${phone}/block`, {
      auth: 'session',
    });
  }

  unblockContact(phone: string): Promise<{ message: string }> {
    return this.request('POST', `/api/contacts/${phone}/unblock`, {
      auth: 'session',
    });
  }

  getLidFromPn(pnJid: IndividualJid): Promise<{ lid: string }> {
    return this.request('GET', `/api/lid-from-pn/${encodeURIComponent(pnJid)}`, {
      auth: 'session',
    });
  }

  getPnFromLid(lid: string): Promise<{ pn: IndividualJid }> {
    return this.request('GET', `/api/pn-from-lid/${encodeURIComponent(lid)}`, {
      auth: 'session',
    });
  }

  // -------------------------------------------------------------------
  // Groups (session key auth)
  // -------------------------------------------------------------------

  getGroups(params?: {
    paginated?: boolean;
    page?: number;
    limit?: number;
  }): Promise<WasenderGroup[]> {
    const q = new URLSearchParams();
    if (params?.paginated) q.append('paginated', 'true');
    if (params?.page) q.append('page', String(params.page));
    if (params?.limit) q.append('limit', String(params.limit));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<WasenderGroup[]>('GET', `/api/groups${qs}`, {
      auth: 'session',
    });
  }

  createGroup(
    name: string,
    participants: IndividualJid[]
  ): Promise<WasenderGroupMetadata> {
    return this.request<WasenderGroupMetadata>('POST', '/api/groups', {
      auth: 'session',
      body: { name, participants },
    });
  }

  getGroupMetadata(groupJid: GroupJid): Promise<WasenderGroupMetadata> {
    return this.request<WasenderGroupMetadata>(
      'GET',
      `/api/groups/${encodeURIComponent(groupJid)}/metadata`,
      { auth: 'session' }
    );
  }

  getGroupParticipants(
    groupJid: GroupJid
  ): Promise<WasenderGroupParticipant[]> {
    return this.request<WasenderGroupParticipant[]>(
      'GET',
      `/api/groups/${encodeURIComponent(groupJid)}/participants`,
      { auth: 'session' }
    );
  }

  addGroupParticipants(
    groupJid: GroupJid,
    participants: string[]
  ): Promise<Array<{ status: number; jid: string; message: string }>> {
    return this.request('POST', `/api/groups/${encodeURIComponent(groupJid)}/participants/add`, {
      auth: 'session',
      body: { participants },
    });
  }

  removeGroupParticipants(
    groupJid: GroupJid,
    participants: string[]
  ): Promise<Array<{ status: number; jid: string; message: string }>> {
    return this.request('POST', `/api/groups/${encodeURIComponent(groupJid)}/participants/remove`, {
      auth: 'session',
      body: { participants },
    });
  }

  updateGroupParticipants(
    groupJid: GroupJid,
    action: 'promote' | 'demote',
    participants: string[]
  ): Promise<{ participants: string[] }> {
    return this.request('PUT', `/api/groups/${encodeURIComponent(groupJid)}/participants/update`, {
      auth: 'session',
      body: { action, participants },
    });
  }

  updateGroupSettings(
    groupJid: GroupJid,
    settings: {
      subject?: string;
      description?: string;
      announce?: boolean;
      restrict?: boolean;
      joinApproval?: boolean;
      memberAdd?: boolean;
      profilePicUrl?: string;
    }
  ): Promise<Record<string, unknown>> {
    return this.request('PUT', `/api/groups/${encodeURIComponent(groupJid)}/settings`, {
      auth: 'session',
      body: settings,
    });
  }

  getGroupInviteLink(groupJid: GroupJid): Promise<{ inviteLink: string }> {
    return this.request('GET', `/api/groups/${encodeURIComponent(groupJid)}/invite-link`, {
      auth: 'session',
    });
  }

  acceptGroupInvite(code: string): Promise<{ id: GroupJid }> {
    return this.request('POST', '/api/groups/invite/accept', {
      auth: 'session',
      body: { code },
    });
  }

  leaveGroup(groupJid: GroupJid): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/groups/${encodeURIComponent(groupJid)}/leave`, {
      auth: 'session',
    });
  }
}

/**
 * Build the flat `/api/send-message` payload from the typed union.
 * Exhaustive over `kind` — a new message type fails compilation here
 * until a builder branch is added.
 */
export function buildSendPayload(
  to: string | Jid,
  body: WasenderMessageBody
): Record<string, unknown> {
  const base: Record<string, unknown> = { to };
  if (body.replyTo !== undefined) base.replyTo = body.replyTo;

  switch (body.kind) {
    case 'text':
      return { ...base, text: body.text };
    case 'image':
      return { ...base, imageUrl: body.imageUrl, text: body.text, viewOnce: body.viewOnce };
    case 'video':
      return { ...base, videoUrl: body.videoUrl, text: body.text, viewOnce: body.viewOnce };
    case 'audio':
      return { ...base, audioUrl: body.audioUrl, text: body.text, viewOnce: body.viewOnce };
    case 'document':
      return {
        ...base,
        documentUrl: body.documentUrl,
        fileName: body.fileName,
        text: body.text,
      };
    case 'sticker':
      return { ...base, stickerUrl: body.stickerUrl };
    case 'contact':
      return { ...base, contact: body.contact };
    case 'location':
      return { ...base, location: body.location };
    case 'poll':
      return { ...base, poll: body.poll };
    case 'mentions':
      return {
        ...base,
        text: body.text,
        mentions: body.mentions,
      };
    default: {
      const _exhaustive: never = body;
      return base;
    }
  }
}

/** Convenience: send a plain text message to an E.164 phone. */
export async function sendText(
  client: WasenderClient,
  phone: string,
  text: string
): Promise<WasenderSendResult> {
  return client.sendMessage(phoneToJid(phone), { kind: 'text', text });
}

export type { ChannelJid, GroupJid, IndividualJid, Jid, WasenderPresenceType };
