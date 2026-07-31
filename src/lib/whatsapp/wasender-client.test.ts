import { describe, it, expect, vi, afterEach } from 'vitest';
import { expectTypeOf } from 'vitest';
import {
  WasenderClient,
  buildSendPayload,
  sendText,
  isRetryableWasenderError,
  WasenderApiError,
} from '@/lib/whatsapp/wasender-client';
import {
  phoneToJid,
  jidToPhone,
  isGroupJid,
  parseWasenderWebhook,
  wasenderStatusToWacrm,
  type WasenderMessageBody,
  type Jid,
  type GroupJid,
} from '@/lib/whatsapp/wasender-types';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

function clientWith(pat?: string, key?: string) {
  return new WasenderClient({
    pat: pat || 'pat-test',
    sessionApiKey: key || 'key-test',
    baseUrl: 'https://wasenderapi.test',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WasenderClient — sessions (PAT auth)', () => {
  it('GET /api/whatsapp-sessions returns the session list from data', async () => {
    const fetchMock = mockFetch(200, {
      success: true,
      data: [
        {
          id: 1,
          name: 'Business WhatsApp',
          phone_number: '+1234567890',
          status: 'connected',
          api_key: 'sess-key',
          webhook_secret: 'wh-secret',
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = clientWith('pat-1');
    const sessions = await client.getSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(1);
    expect(sessions[0].api_key).toBe('sess-key');
    // PAT must be in the Authorization header
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer pat-1'
    );
  });

  it('createSession sends account_protection + log_messages defaults', async () => {
    const fetchMock = mockFetch(200, {
      success: true,
      data: { id: 9, name: 'New', api_key: 'k', webhook_secret: 's' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = clientWith('pat-1');
    await client.createSession({ name: 'New', phone_number: '+15550199' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.account_protection).toBe(true);
    expect(body.log_messages).toBe(true);
    expect(body.phone_number).toBe('+15550199');
  });

  it('throws WasenderApiError with retryAfterSeconds on rate limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '60' }),
      json: async () => ({
        message: 'You are on a free trial. You can only send 1 message every 1 minute.',
        retry_after: 60,
      }),
      text: async () => 'rate limited',
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = clientWith('pat-1');
    await expect(client.getSessions()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 60,
    });

    expect(isRetryableWasenderError(new WasenderApiError('x', { status: 429 }))).toBe(true);
    expect(isRetryableWasenderError(new WasenderApiError('x', { status: 400 }))).toBe(false);
  });

  it('connectSession returns the QR string for NEED_SCAN', async () => {
    const fetchMock = mockFetch(200, {
      success: true,
      data: { status: 'NEED_SCAN', qrCode: '2@DTMUHeYfa9/RMXr8A2IP3/...' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = clientWith('pat-1');
    const res = await client.connectSession(42);

    expect(res.status).toBe('NEED_SCAN');
    if (res.status === 'NEED_SCAN') {
      expect(res.qrCode.startsWith('2@')).toBe(true);
    }
  });
});

describe('WasenderClient — messaging (session key auth)', () => {
  it('sendMessage builds the correct payload per kind and unwraps data', async () => {
    const fetchMock = mockFetch(200, {
      success: true,
      data: { msgId: 100000, jid: '+123456789', status: 'in_progress' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = clientWith(undefined, 'sess-1');
    const res = await client.sendMessage(phoneToJid('+15550199'), {
      kind: 'text',
      text: 'Hello from WasenderApi!',
    });

    expect(res.msgId).toBe(100000);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sess-1'
    );
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ to: '15550199@s.whatsapp.net', text: 'Hello from WasenderApi!' });
  });

  it('image kind maps to imageUrl + text caption', () => {
    const payload = buildSendPayload('+15550199', {
      kind: 'image',
      imageUrl: 'https://example.com/pic.jpg',
      text: 'Look!',
    });
    expect(payload).toEqual({
      to: '+15550199',
      imageUrl: 'https://example.com/pic.jpg',
      text: 'Look!',
    });
  });

  it('document kind maps to documentUrl + fileName', () => {
    const payload = buildSendPayload('123456789-987654321@g.us', {
      kind: 'document',
      documentUrl: 'https://example.com/report.pdf',
      fileName: 'report.pdf',
    });
    expect(payload).toEqual({
      to: '123456789-987654321@g.us',
      documentUrl: 'https://example.com/report.pdf',
      fileName: 'report.pdf',
    });
  });

  it('poll kind keeps question/options/multiSelect', () => {
    const payload = buildSendPayload('+15550199', {
      kind: 'poll',
      poll: {
        question: 'What is your favorite color?',
        options: ['Blue', 'Green', 'Red', 'Yellow'],
        multiSelect: false,
      },
    });
    expect(payload.poll).toMatchObject({
      question: 'What is your favorite color?',
      options: ['Blue', 'Green', 'Red', 'Yellow'],
    });
  });

  it('type-level: buildSendPayload accepts every message kind (Pocock type test)', () => {
    // Compile-time documentation: the union is exhaustive over these kinds.
    const kinds: WasenderMessageBody['kind'][] = [
      'text', 'image', 'video', 'audio', 'document', 'sticker',
      'contact', 'location', 'poll', 'mentions',
    ];
    expect(kinds).toContain('text');
    expectTypeOf<WasenderMessageBody['kind']>().toEqualTypeOf<
      | 'text' | 'image' | 'video' | 'audio' | 'document'
      | 'sticker' | 'contact' | 'location' | 'poll' | 'mentions'
    >();
  });
});

describe('sendText convenience + JID helpers', () => {
  it('sendText converts phone → JID and sends', async () => {
    const fetchMock = mockFetch(200, {
      success: true,
      data: { msgId: 1, jid: '+15550199', status: 'in_progress' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = clientWith(undefined, 'sess-1');
    const res = await sendText(client, '+15550199', 'hi');

    expect(res.status).toBe('in_progress');
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string).to).toBe('15550199@s.whatsapp.net');
  });

  it('jidToPhone strips the JID suffix and re-adds +', () => {
    expect(jidToPhone(phoneToJid('+15550199'))).toBe('+15550199');
  });

  it('isGroupJid distinguishes group JIDs', () => {
    expect(isGroupJid('123456789-987654321@g.us')).toBe(true);
    expect(isGroupJid('15550199@s.whatsapp.net')).toBe(false);
  });

  it('type-level: Jid is branded (cannot assign a raw string)', () => {
    // A raw string is NOT assignable to Jid without the helper.
    expectTypeOf<Jid>().not.toEqualTypeOf<string>();
    expectTypeOf<GroupJid>().not.toEqualTypeOf<string>();
  });
});

describe('Webhook parsing (flattened payloads)', () => {
  it('parses messages.received with a single object message', () => {
    const w = parseWasenderWebhook({
      event: 'messages.received',
      timestamp: 1633456789,
      data: {
        messages: {
          key: {
            id: '3EB0X123456789',
            fromMe: false,
            remoteJid: '555555555@lid',
            cleanedSenderPn: '5551234567',
          },
          messageBody: 'Hello, I have a question',
          message: { conversation: 'Hello, I have a question' },
        },
      },
    });

    expect(w?.event).toBe('messages.received');
    if (w?.event === 'messages.received') {
      // The cleaned sender phone is the field we must use for contacts.
      expect(w.data.messages.key.cleanedSenderPn).toBe('5551234567');
      expect(w.data.messages.messageBody).toBe('Hello, I have a question');
    }
  });

  it('parses messages.upsert as an ARRAY of messages', () => {
    const w = parseWasenderWebhook({
      event: 'messages.upsert',
      timestamp: 1633456789,
      data: { messages: [{ key: { id: 'a' }, messageBody: 'x', message: {} }] },
    });

    expect(w?.event).toBe('messages.upsert');
    if (w?.event === 'messages.upsert') {
      expect(Array.isArray(w.data.messages)).toBe(true);
    }
  });

  it('parses session.status and qrcode.updated', () => {
    const s = parseWasenderWebhook({
      event: 'session.status',
      sessionId: 'key-1',
      timestamp: 1,
      data: { status: 'need_passkey' },
    });
    expect(s?.event).toBe('session.status');
    if (s?.event === 'session.status') {
      expect(s.data.status).toBe('need_passkey');
    }

    const q = parseWasenderWebhook({
      event: 'qrcode.updated',
      sessionId: 'key-1',
      timestamp: 1,
      data: { qr: '2@abc' },
    });
    expect(q?.event).toBe('qrcode.updated');
  });

  it('returns null for unknown events (acked and skipped)', () => {
    expect(parseWasenderWebhook({ event: 'messages.something-new' })).toBeNull();
  });
});

describe('Status mapping', () => {
  it('maps WasenderApi numeric status to WaCRM status strings', () => {
    expect(wasenderStatusToWacrm(0)).toBe('failed');
    expect(wasenderStatusToWacrm(2)).toBe('sent');
    expect(wasenderStatusToWacrm(3)).toBe('delivered');
    expect(wasenderStatusToWacrm(4)).toBe('read');
    expect(wasenderStatusToWacrm(5)).toBe('read');
  });
});
