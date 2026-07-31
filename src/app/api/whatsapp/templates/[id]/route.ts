import { requireRole } from '@/lib/auth/account'
import { wasenderUnsupported } from '@/lib/whatsapp/wasender-capabilities'

/**
 * PATCH/DELETE /api/whatsapp/templates/[id]
 * DISABLED — WasenderApi has no Meta message templates.
 */
export async function PATCH() {
  await requireRole('admin')
  return wasenderUnsupported(
    'Message templates',
    'Create reusable messages as campaign products instead.'
  )
}

export async function DELETE() {
  await requireRole('admin')
  return wasenderUnsupported(
    'Message templates',
    'Create reusable messages as campaign products instead.'
  )
}
