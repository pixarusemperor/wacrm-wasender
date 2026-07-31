import { NextResponse } from 'next/server'
import { getCurrentAccount } from '@/lib/auth/account'

/**
 * Media library — upload/list files in the account's Supabase Storage
 * folder. Ported from WassFlow's /api/media, account-scoped so each
 * tenant only sees their own media.
 *
 * GET  /api/wasender/media?folder=<name>
 * POST /api/wasender/media  (multipart form: file + folder)
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const folder = (formData.get('folder') as string | null) || 'general'

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const path = `${accountId}/${folder}/${file.name}`

    const { error } = await supabase.storage.from('media').upload(path, buffer, {
      contentType: file.type,
      upsert: true,
    })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const { data: publicUrlData } = supabase.storage.from('media').getPublicUrl(path)
    return NextResponse.json({
      success: true,
      url: publicUrlData.publicUrl,
      fileName: file.name,
      fileType: file.type,
      sizeBytes: file.size,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[wasender/media]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { searchParams } = new URL(request.url)
    const folder = searchParams.get('folder') || 'general'

    const prefix = `${accountId}/${folder}`
    const { data, error } = await supabase.storage.from('media').list(prefix, {
      sortBy: { column: 'created_at', order: 'desc' },
    })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const files = (data ?? [])
      .filter((f) => f.name !== '.emptyFolderPlaceholder')
      .map((f) => {
        const { data: publicUrlData } = supabase.storage
          .from('media')
          .getPublicUrl(`${prefix}/${f.name}`)
        return {
          name: f.name,
          id: f.id,
          createdAt: f.created_at,
          sizeBytes: f.metadata?.size || 0,
          url: publicUrlData.publicUrl,
        }
      })

    return NextResponse.json({ success: true, files })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[wasender/media]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
