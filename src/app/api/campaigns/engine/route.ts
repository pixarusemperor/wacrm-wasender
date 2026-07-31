import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { engineTick, queueTick } from '@/lib/campaigns/campaign-engine'

/**
 * POST /api/campaigns/engine
 * Drive the campaign engine: enqueue due events, then process the
 * queue (session-serialized, anti-ban). Called by the external
 * scheduler (Coolify cron / campaign-worker) at a fixed interval.
 */
export async function POST(request: Request) {
  const engineSecret = process.env.ENGINE_SECRET
  if (engineSecret) {
    const header =
      request.headers.get('x-engine-secret') ||
      request.headers.get('Authorization')?.replace('Bearer ', '')
    if (header !== engineSecret) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  try {
    const db = supabaseAdmin()
    const engineResult = await engineTick(db)
    const queueResult = await queueTick(db)

    return NextResponse.json({
      processed: engineResult.processed + queueResult.processed,
      engine: engineResult,
      queue: queueResult,
    })
  } catch (err) {
    console.error('[campaigns/engine] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Engine tick failed' },
      { status: 500 }
    )
  }
}
