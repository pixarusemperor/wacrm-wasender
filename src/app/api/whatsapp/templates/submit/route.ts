import { requireRole } from '@/lib/auth/account'
import { wasenderUnsupported } from '@/lib/whatsapp/wasender-capabilities'

/**
 * POST /api/whatsapp/templates/submit
 * DISABLED — WasenderApi has no Meta message templates. Reusable
 * campaign messages live in the campaign product picker instead.
 */
export async function POST() {
  await requireRole('admin')
  return wasenderUnsupported(
    'Message templates',
    'Create reusable messages as campaign products instead.'
  )
}
