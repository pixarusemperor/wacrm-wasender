import { NextResponse } from 'next/server'
import { toErrorResponse } from '@/lib/auth/account'

/**
 * Capability gate for Meta-only endpoints that WasenderApi replaces.
 *
 * These routes (template management, Meta registration/verification,
 * template broadcasts) exist in the WaCRM upstream but have no
 * WasenderApi equivalent. Rather than delete them (which would break
 * upstream mergeability), they return 501 with a pointer to the
 * replacement so any caller gets a clear, actionable error.
 */
export async function wasenderUnsupported(feature: string, replacement: string) {
  try {
    return NextResponse.json(
      {
        error: `${feature} is not supported by WasenderApi. ${replacement}`,
      },
      { status: 501 }
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
