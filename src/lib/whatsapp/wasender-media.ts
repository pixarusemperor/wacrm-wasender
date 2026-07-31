/**
 * Inbound media handling for WasenderApi.
 *
 * WasenderApi delivers media as ENCRYPTED objects (`url` + `mediaKey`
 * inside `message.<kind>Message`). We:
 *   1. POST the message object to /api/decrypt-media → temporary
 *      public URL (valid 1 hour).
 *   2. Download the decrypted bytes.
 *   3. Upload them to Supabase Storage (`media` bucket) for permanent
 *      retention — upgrading WaCRM's on-demand Meta relay, which does
 *      not persist media.
 *
 * Pure-ish: `decryptAndStoreMedia` takes injected dependencies so it
 * can be unit-tested without real network calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WasenderClient } from './wasender-client';
import type { NormalizedInboundMessage } from './wasender-normalize';

export interface MediaStoreResult {
  stored: boolean;
  publicUrl?: string;
  tempUrl?: string;
  error?: string;
}

export interface DecryptStoreDeps {
  client: WasenderClient;
  supabase: SupabaseClient;
  bucket?: string;
}

/**
 * Decrypt inbound media via WasenderApi and persist it to Supabase
 * Storage. Falls back to the temporary URL when storage fails (the
 * temp URL is valid 1 hour — enough for the inbox to render it).
 */
export async function decryptAndStoreMedia(
  deps: DecryptStoreDeps,
  msg: NormalizedInboundMessage,
  accountId: string
): Promise<MediaStoreResult> {
  if (!msg.media) return { stored: false };

  try {
    // 1. Decrypt → temp public URL (1h).
    const { publicUrl } = await deps.client.decryptMedia({
      messages: {
        key: { id: msg.messageId },
        message: buildRawMessageObject(msg),
      },
    });

    // 2. Download decrypted bytes.
    const fileRes = await fetch(publicUrl);
    if (!fileRes.ok) {
      return { stored: false, tempUrl: publicUrl, error: `download failed: ${fileRes.status}` };
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const contentType =
      fileRes.headers.get('content-type') || msg.media.mimetype || 'application/octet-stream';

    // 3. Upload to Supabase Storage.
    const ext = extensionFor(msg.media.mimetype);
    const fileName = `${msg.messageId}.${ext}`;
    const path = `${accountId}/${fileName}`;

    const { error: uploadError } = await deps.supabase.storage
      .from(deps.bucket || 'media')
      .upload(path, buffer, { contentType, upsert: true });

    if (uploadError) {
      console.warn('[wasender-media] storage upload failed, using temp URL:', uploadError.message);
      return { stored: false, tempUrl: publicUrl, error: uploadError.message };
    }

    const { data: publicUrlData } = deps.supabase.storage
      .from(deps.bucket || 'media')
      .getPublicUrl(path);

    return { stored: true, publicUrl: publicUrlData.publicUrl, tempUrl: publicUrl };
  } catch (err) {
    console.error('[wasender-media] decrypt/store failed:', err);
    return {
      stored: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Rebuild the raw message object WasenderApi's /api/decrypt-media
 * expects (`data.messages.message.<kind>Message.{url,mediaKey}`).
 */
export function buildRawMessageObject(msg: NormalizedInboundMessage): Record<string, unknown> {
  if (!msg.media) return {};
  const kindKey = `${msg.media.kind}Message`;
  return {
    [kindKey]: {
      url: msg.media.url,
      mediaKey: msg.media.mediaKey,
      mimetype: msg.media.mimetype,
      fileName: msg.media.fileName,
    },
  };
}

function extensionFor(mimetype?: string): string {
  if (!mimetype) return 'bin';
  const ext = mimetype.split('/')[1]?.split(';')[0]?.trim();
  return ext && ext.length <= 8 ? ext : 'bin';
}
