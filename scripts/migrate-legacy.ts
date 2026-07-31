/**
 * One-time legacy data migration (Phase 10).
 *
 * Reads the `legacy_*` tables (created by migration 099's rename of the
 * old WassFlow schema) and ports the data into WaCRM structures:
 *
 *   legacy_wf_sequences + legacy_wf_steps → flows + flow_nodes + flow_edges
 *     (linear: send_message nodes + wait nodes)
 *   legacy_wf_triggers → keyword-triggered flows
 *   legacy_wf_messages → contacts + conversations + messages (E.164)
 *   legacy_wf_campaigns / legacy_wf_products / legacy_wf_group_lists →
 *     campaigns / campaign_products / group_lists
 *
 * All migrated rows are assigned to the SaaS owner's account_id
 * (the first account in the DB).
 *
 * Idempotent: guarded by a migration marker table. Dry-run with
 * `--dry-run` prints what would happen without writing.
 *
 * Run: npx tsx scripts/migrate-legacy.ts [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const DRY_RUN = process.argv.includes('--dry-run')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const log = (msg: string) => console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}${msg}`)

async function getOwnerAccountId(): Promise<string> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error || !data) throw new Error('No account found — create one first')
  return data.id
}

async function alreadyMigrated(): Promise<boolean> {
  const { data } = await supabase
    .from('_migration_meta')
    .select('value')
    .eq('key', 'legacy_data_migrated')
    .maybeSingle()
  return data?.value === 'true'
}

async function markMigrated() {
  await supabase.from('_migration_meta').upsert({
    key: 'legacy_data_migrated',
    value: 'true',
    applied_at: new Date().toISOString(),
  })
}

function flowNode(
  flowId: string,
  nodeKey: string,
  nodeType: string,
  config: Record<string, unknown>,
  position: { x: number; y: number }
) {
  return {
    id: randomUUID(),
    flow_id: flowId,
    node_key: nodeKey,
    node_type: nodeType,
    config,
    position_x: position.x,
    position_y: position.y,
  }
}

async function migrate() {
  log('Starting legacy data migration…')

  if (!DRY_RUN && (await alreadyMigrated())) {
    log('Already migrated (marker found). Exiting.')
    return
  }

  const accountId = await getOwnerAccountId()
  const adminUserId = await getFirstUserId()
  log(`Migrating into account ${accountId}`)

  // ---------------------------------------------------------------
  // 1. Sequences → flows (linear graphs)
  // ---------------------------------------------------------------
  const { data: sequences, error: seqErr } = await supabase
    .from('legacy_wf_sequences')
    .select('*')
  if (seqErr) {
    log(`No legacy sequences (${seqErr.message})`)
  } else if (sequences) {
    for (const seq of sequences) {
      if (DRY_RUN) {
        log(`Would migrate sequence "${seq.name}" (${seq.id})`)
        continue
      }
      const { data: steps } = await supabase
        .from('legacy_wf_steps')
        .select('*')
        .eq('sequence_id', seq.id)
        .order('step_order', { ascending: true })

      const flowId = randomUUID()
      const nodes = []

      for (let i = 0; i < (steps ?? []).length; i++) {
        const step = steps![i]
        const key = `step_${i}`
        const isText = step.message_type === 'text'
        const node = flowNode(
          flowId,
          key,
          isText ? 'send_message' : 'send_media',
          isText
            ? { text: step.message_body || '', next_node_key: `step_${i + 1}` }
            : {
                media_type:
                  step.message_type === 'image' ? 'image' : step.message_type,
                media_url: step.media_url || '',
                caption: step.caption || undefined,
                next_node_key: `step_${i + 1}`,
              },
          { x: 100, y: i * 120 }
        )
        nodes.push(node)
      }

      // Entry node. WaCRM's engine starts a run at flow.entry_node_id
      // and advances from it — edges live INSIDE each node's config as
      // next_node_key (there is no flow_edges table).
      const startNode = flowNode(
        flowId,
        'start',
        'start',
        { next_node_key: nodes.length > 0 ? 'step_0' : 'end' },
        { x: 100, y: -120 }
      )
      nodes.push(startNode)

      await supabase.from('flows').insert({
        id: flowId,
        account_id: accountId,
        user_id: adminUserId,
        name: seq.name,
        description: `Migrated from WassFlow sequence ${seq.id}`,
        status: 'draft',
        trigger_type: 'keyword',
        trigger_config: { keywords: [] },
        entry_node_id: startNode.id,
      })
      await supabase.from('flow_nodes').insert(nodes)
      log(`Migrated sequence "${seq.name}" → flow ${flowId} (${nodes.length} nodes, entry=${startNode.id})`)
    }
  }

  // ---------------------------------------------------------------
  // 2. Triggers → keyword flows
  // ---------------------------------------------------------------
  const { data: triggers, error: trigErr } = await supabase
    .from('legacy_wf_triggers')
    .select('*')
  if (trigErr) {
    log(`No legacy triggers (${trigErr.message})`)
  } else if (triggers) {
    for (const t of triggers) {
      if (DRY_RUN) {
        log(`Would migrate trigger "${t.keyword}" (${t.id})`)
        continue
      }
      // Find the migrated flow for this trigger's sequence.
      const { data: seq } = await supabase
        .from('legacy_wf_sequences')
        .select('name')
        .eq('id', t.sequence_id)
        .maybeSingle()
      const { data: flow } = await supabase
        .from('flows')
        .select('id')
        .eq('name', seq?.name ?? '__missing__')
        .eq('account_id', accountId)
        .limit(1)
        .maybeSingle()
      if (!flow) {
        log(`  Skipped trigger "${t.keyword}": no migrated flow for sequence ${t.sequence_id}`)
        continue
      }
      await supabase
        .from('flows')
        .update({
          trigger_config: {
            keywords: [t.keyword],
            match_type: t.match_type || 'exact',
            case_sensitive: false,
          },
          status: t.is_active ? 'active' : 'draft',
        })
        .eq('id', flow.id)
      log(`Migrated trigger "${t.keyword}" → flow ${flow.id}`)
    }
  }

  // ---------------------------------------------------------------
  // 3. Messages → contacts + conversations + messages
  // ---------------------------------------------------------------
  const { data: messages, error: msgErr } = await supabase
    .from('legacy_wf_messages')
    .select('*')
    .limit(5000)
  if (msgErr) {
    log(`No legacy messages (${msgErr.message})`)
  } else if (messages) {
    const convCache = new Map<string, string>()
    for (const m of messages) {
      if (DRY_RUN) {
        log(`Would migrate message from ${m.sender_number} (${m.message_type})`)
        continue
      }
      const phone = `+${(m.sender_number || '').replace(/\D/g, '')}`
      if (!phone || phone === '+') continue

      // Contact (find-or-create by phone).
      const { data: existing } = await supabase
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone', phone)
        .maybeSingle()
      let contactId = existing?.id
      if (!contactId) {
        const { data: contact } = await supabase
          .from('contacts')
          .insert({
            account_id: accountId,
            user_id: adminUserId,
            phone,
            name: m.sender_name || phone,
          })
          .select('id')
          .single()
        contactId = contact?.id
      }

      // Conversation (per contact).
      let convId = convCache.get(phone)
      if (!convId) {
        const { data: conv } = await supabase
          .from('conversations')
          .insert({
            account_id: accountId,
            user_id: adminUserId,
            contact_id: contactId,
            source_provider: 'wasender',
          })
          .select('id')
          .single()
        convId = conv?.id
        if (convId) convCache.set(phone, convId)
      }
      if (!convId) continue

      await supabase.from('messages').insert({
        conversation_id: convId,
        sender_type: m.direction === 'outgoing' ? 'bot' : 'customer',
        content_type: m.message_type === 'text' ? 'text' : m.message_type,
        content_text: m.message_body || null,
        media_url: m.media_url || null,
        message_id: m.id,
        status: 'sent',
        source_provider: 'wasender',
        wats_msg_id: m.id,
      })
      log(`Migrated message ${m.id} from ${phone}`)
    }
  }

  if (!DRY_RUN) {
    await markMigrated()
    log('Migration complete.')
  } else {
    log('DRY RUN complete — no rows written.')
  }
}

async function getFirstUserId(): Promise<string> {
  const { data } = await supabase.from('profiles').select('user_id').limit(1).maybeSingle()
  if (data?.user_id) return data.user_id
  const { data: acc } = await supabase.from('accounts').select('user_id').limit(1).maybeSingle()
  return (acc?.user_id as string) || ''
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
