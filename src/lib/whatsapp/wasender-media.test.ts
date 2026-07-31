import { describe, it, expect, vi } from 'vitest';
import { decryptAndStoreMedia, buildRawMessageObject } from './wasender-media';
import type { NormalizedInboundMessage } from './wasender-normalize';
import type { WasenderClient } from './wasender-client';

function mediaMessage(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    messageId: 'img-1',
    senderPhone: '+15550199',
    remoteJid: '15550199@s.whatsapp.net',
    isGroup: false,
    fromMe: false,
    text: 'caption',
    contentType: 'image',
    media: {
      kind: 'image',
      url: 'https://mmg.whatsapp.net/encrypted.jpg',
      mediaKey: 'base64-key',
      mimetype: 'image/jpeg',
    },
    timestamp: 1,
    ...overrides,
  };
}

function mockClient() {
  return {
    decryptMedia: vi.fn().mockResolvedValue({
      publicUrl: 'https://wasenderapi.test/decrypted-media/img-1',
    }),
  } as unknown as WasenderClient;
}

function mockSupabase() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const getPublicUrl = vi.fn().mockReturnValue({
    data: { publicUrl: 'https://supabase.test/media/acct-1/img-1.jpeg' },
  });
  return {
    storage: {
      from: vi.fn(() => ({ upload, getPublicUrl })),
    },
  } as unknown as Parameters<typeof decryptAndStoreMedia>[0]['supabase'];
}

describe('buildRawMessageObject', () => {
  it('rebuilds the object WasenderApi expects for /api/decrypt-media', () => {
    const raw = buildRawMessageObject(mediaMessage());
    expect(raw).toEqual({
      imageMessage: {
        url: 'https://mmg.whatsapp.net/encrypted.jpg',
        mediaKey: 'base64-key',
        mimetype: 'image/jpeg',
        fileName: undefined,
      },
    });
  });

  it('returns {} for messages without media', () => {
    expect(buildRawMessageObject(mediaMessage({ media: undefined }))).toEqual({});
  });
});

describe('decryptAndStoreMedia', () => {
  it('decrypts, downloads, uploads, and returns the permanent URL', async () => {
    const client = mockClient();
    const supabase = mockSupabase();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await decryptAndStoreMedia(
      { client, supabase },
      mediaMessage(),
      'acct-1'
    );

    expect(client.decryptMedia).toHaveBeenCalledWith({
      messages: { key: { id: 'img-1' }, message: expect.any(Object) },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://wasenderapi.test/decrypted-media/img-1'
    );
    expect(supabase.storage.from).toHaveBeenCalledWith('media');
    expect(result).toMatchObject({
      stored: true,
      publicUrl: 'https://supabase.test/media/acct-1/img-1.jpeg',
    });
  });

  it('falls back to the temp URL when storage upload fails', async () => {
    const client = mockClient();
    const supabase = {
      storage: {
        from: vi.fn(() => ({
          upload: vi.fn().mockResolvedValue({ error: { message: 'bucket full' } }),
          getPublicUrl: vi.fn(),
        })),
      },
    } as unknown as Parameters<typeof decryptAndStoreMedia>[0]['supabase'];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: new Headers(),
      })
    );

    const result = await decryptAndStoreMedia({ client, supabase }, mediaMessage(), 'acct-1');

    expect(result.stored).toBe(false);
    expect(result.tempUrl).toBe('https://wasenderapi.test/decrypted-media/img-1');
    expect(result.error).toContain('bucket full');
  });

  it('returns stored:false without touching the network for text messages', async () => {
    const client = mockClient();
    const supabase = mockSupabase();
    const result = await decryptAndStoreMedia(
      { client, supabase },
      mediaMessage({ media: undefined }),
      'acct-1'
    );
    expect(result).toEqual({ stored: false });
    expect(client.decryptMedia).not.toHaveBeenCalled();
  });
});
