import { describe, it, expect, vi } from 'vitest';
import { encrypt } from './encryption';
import {
  verifyWebhookSignature,
  createSessionResolver,
  WasenderWebhookError,
} from './wasender-webhook-auth';

// ENCRYPTION_KEY is set in vitest.config.ts env (32 zero bytes hex).
function enc(plain: string): string {
  return encrypt(plain);
}

describe('verifyWebhookSignature', () => {
  it('accepts an exact match', () => {
    expect(verifyWebhookSignature('my-secret', 'my-secret')).toBe(true);
  });

  it('rejects mismatches and null signatures', () => {
    expect(verifyWebhookSignature('wrong', 'my-secret')).toBe(false);
    expect(verifyWebhookSignature(null, 'my-secret')).toBe(false);
    expect(verifyWebhookSignature(undefined as unknown as string, 'my-secret')).toBe(false);
  });

  it('rejects length-mismatched inputs without throwing', () => {
    expect(verifyWebhookSignature('a', 'much-longer-secret')).toBe(false);
  });
});

describe('createSessionResolver', () => {
  const sessions = [
    {
      id: 'sess-1',
      account_id: 'acct-1',
      user_id: 'user-1',
      wats_api_key: enc('session-key-1'),
      wats_webhook_secret: enc('secret-1'),
    },
    {
      id: 'sess-2',
      account_id: 'acct-2',
      user_id: 'user-2',
      wats_api_key: enc('session-key-2'),
      wats_webhook_secret: enc('secret-2'),
    },
  ];

  it('resolves the owning session by webhook_secret and decrypts the key', async () => {
    const admin = {
      from: vi.fn(() => ({
        select: vi.fn().mockResolvedValue({ data: sessions, error: null }),
      })),
    } as unknown as Parameters<typeof createSessionResolver>[0];

    const resolver = createSessionResolver(admin);
    const resolved = await resolver('secret-2');

    expect(resolved).toMatchObject({
      sessionId: 'sess-2',
      accountId: 'acct-2',
      userId: 'user-2',
      sessionApiKey: 'session-key-2',
    });
  });

  it('returns null for an unknown signature (ack 200 + drop)', async () => {
    const admin = {
      from: vi.fn(() => ({
        select: vi.fn().mockResolvedValue({ data: sessions, error: null }),
      })),
    } as unknown as Parameters<typeof createSessionResolver>[0];

    const resolver = createSessionResolver(admin);
    expect(await resolver('nope')).toBeNull();
    expect(await resolver(null)).toBeNull();
  });

  it('throws WasenderWebhookError on a DB failure', async () => {
    const admin = {
      from: vi.fn(() => ({
        select: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
      })),
    } as unknown as Parameters<typeof createSessionResolver>[0];

    const resolver = createSessionResolver(admin);
    await expect(resolver('secret-1')).rejects.toBeInstanceOf(WasenderWebhookError);
  });
});
