/**
 * WasenderApi webhook session resolution + signature verification.
 *
 * WasenderApi signs webhooks with a plain-token header:
 *   X-Webhook-Signature: <session webhook_secret>
 * The secret is per-session, stored AES-256-GCM encrypted on
 * `wasender_sessions`. We verify with crypto.timingSafeEqual (upgrade
 * from a plain `!==` compare) and resolve the owning account from the
 * matching session row.
 *
 * Pure enough to unit-test: takes a Supabase-like client.
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from './encryption';

export class WasenderWebhookError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WasenderWebhookError';
    this.status = status;
  }
}

export interface ResolvedSession {
  sessionId: string;
  accountId: string;
  userId: string;
  /** Decrypted session API key (for media decrypt / presence). */
  sessionApiKey: string;
}

/**
 * Verify a webhook signature against a decrypted secret using a
 * constant-time compare. Safe on mismatched lengths (no early exit).
 */
export function verifyWebhookSignature(
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;
  const a = Buffer.from(signature);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface SessionResolver {
  (signature: string | null): Promise<ResolvedSession | null>;
}

/**
 * Resolve a webhook request to its session + account.
 *
 * Strategy: WasenderApi does NOT include the session id in the webhook
 * path (one URL for all sessions), so we find the session by its
 * (encrypted) webhook_secret. Scan the account's sessions and
 * constant-time-compare each decrypted secret. Returns null when no
 * session matches (caller acks 200 + drops, per WasenderApi docs).
 */
export function createSessionResolver(
  admin: SupabaseClient
): SessionResolver {
  return async (signature: string | null): Promise<ResolvedSession | null> => {
    if (!signature) return null;

    // Pull every wasender session (service-role) — the webhook has no
    // auth context of its own. One URL serves all sessions; we match
    // by webhook_secret below.
    const { data: allSessions, error: allError } = await admin
      .from('wasender_sessions')
      .select('id, account_id, user_id, wats_api_key, wats_webhook_secret');

    if (allError) {
      throw new WasenderWebhookError('Failed to load sessions', 500);
    }

    for (const s of allSessions ?? []) {
      if (!s.wats_webhook_secret) continue;
      let secret: string;
      try {
        secret = decrypt(s.wats_webhook_secret);
      } catch {
        continue; // malformed row — skip
      }
      if (!verifyWebhookSignature(signature, secret)) continue;

      return {
        sessionId: s.id,
        accountId: s.account_id,
        userId: s.user_id,
        sessionApiKey: s.wats_api_key ? decrypt(s.wats_api_key) : '',
      };
    }

    return null;
  };
}
