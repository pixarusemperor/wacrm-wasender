import { WasenderUnsupportedError } from '@/lib/whatsapp/wasender-send'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE header. WasenderApi has
 * no message templates, so this helper is only reachable through the
 * disabled template routes — it throws a typed unsupported error.
 */

export async function ensureImageHeaderHandle(
  _payload: TemplatePayload,
  _accessToken: string,
): Promise<void> {
  throw new WasenderUnsupportedError('Template image headers')
}

