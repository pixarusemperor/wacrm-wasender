-- ============================================================
-- 100_wasender_schema.sql
--
-- WasenderApi (unofficial WhatsApp provider) tables for the
-- multi-tenant SaaS. Every table is account-scoped with RLS,
-- mirroring WaCRM's conventions (idempotent, DROP POLICY IF EXISTS,
-- ENABLE ROW LEVEL SECURITY).
--
-- Auth model:
--   * WATSSENDER_MASTER_PAT (env) = SaaS owner PAT — never in DB,
--     never in the browser. Used server-side to create/connect
--     sessions on behalf of users.
--   * wasender_sessions.wats_api_key + wats_webhook_secret =
--     per-session credentials, AES-256-GCM encrypted (encryption.ts).
--     RLS ensures a session is visible only to its account.
--   * Webhooks arrive at one URL; the session is resolved by its
--     unique webhook_secret → account_id.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- WASENDER SESSIONS — one row per connected WhatsApp number
-- ============================================================
CREATE TABLE IF NOT EXISTS wasender_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- WasenderApi session id (integer) + the session-scoped credentials
  -- returned at creation time. Encrypted with AES-256-GCM.
  wats_session_id INTEGER,
  wats_api_key TEXT,
  wats_webhook_secret TEXT,
  name TEXT NOT NULL,
  phone_number TEXT,
  status TEXT NOT NULL DEFAULT 'need_scan', -- connecting|connected|disconnected|need_scan|need_passkey|logged_out|expired
  proxy_url TEXT,
  always_online BOOLEAN DEFAULT false,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(account_id, wats_session_id)
);

CREATE INDEX IF NOT EXISTS idx_wasender_sessions_account ON wasender_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_wasender_sessions_status ON wasender_sessions(status);

ALTER TABLE wasender_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own wasender sessions" ON wasender_sessions;
CREATE POLICY "Users can manage own wasender sessions" ON wasender_sessions
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- WASENDER GROUPS — synced WhatsApp groups (provider-side cache)
-- ============================================================
CREATE TABLE IF NOT EXISTS wasender_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES wasender_sessions(id) ON DELETE CASCADE,
  group_jid TEXT NOT NULL, -- e.g. '123456789-987654321@g.us'
  name TEXT NOT NULL,
  img_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(session_id, group_jid)
);

CREATE INDEX IF NOT EXISTS idx_wasender_groups_account ON wasender_groups(account_id);
CREATE INDEX IF NOT EXISTS idx_wasender_groups_session ON wasender_groups(session_id);

ALTER TABLE wasender_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own wasender groups" ON wasender_groups;
CREATE POLICY "Users can manage own wasender groups" ON wasender_groups
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- WASENDER GROUP MEMBERS — participants with roles
-- ============================================================
CREATE TABLE IF NOT EXISTS wasender_group_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES wasender_groups(id) ON DELETE CASCADE,
  member_jid TEXT NOT NULL, -- e.g. '123456789@s.whatsapp.net' or '@lid'
  phone_number TEXT,        -- cleaned E.164 when resolvable
  role TEXT NOT NULL DEFAULT 'member', -- member|admin|superadmin
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(group_id, member_jid)
);

CREATE INDEX IF NOT EXISTS idx_wasender_members_account ON wasender_group_members(account_id);
CREATE INDEX IF NOT EXISTS idx_wasender_members_group ON wasender_group_members(group_id);

ALTER TABLE wasender_group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own wasender group members" ON wasender_group_members;
CREATE POLICY "Users can manage own wasender group members" ON wasender_group_members
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- WASENDER GROUP ACTIVITY — join/leave/role-change audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS wasender_group_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES wasender_groups(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- member_joined|member_left|role_changed|group_updated
  member_jid TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wasender_activity_account ON wasender_group_activity(account_id);
CREATE INDEX IF NOT EXISTS idx_wasender_activity_group_date
  ON wasender_group_activity(group_id, created_at DESC);

ALTER TABLE wasender_group_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own wasender group activity" ON wasender_group_activity;
CREATE POLICY "Users can manage own wasender group activity" ON wasender_group_activity
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- GROUP LISTS — saved collections of group JIDs for targeting
-- ============================================================
CREATE TABLE IF NOT EXISTS group_lists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_lists_account ON group_lists(account_id);

ALTER TABLE group_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own group lists" ON group_lists;
CREATE POLICY "Users can manage own group lists" ON group_lists
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

CREATE TABLE IF NOT EXISTS group_list_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_list_id UUID NOT NULL REFERENCES group_lists(id) ON DELETE CASCADE,
  group_jid TEXT NOT NULL,
  group_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(group_list_id, group_jid)
);

CREATE INDEX IF NOT EXISTS idx_group_list_items_list ON group_list_items(group_list_id);

ALTER TABLE group_list_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own group list items" ON group_list_items;
CREATE POLICY "Users can manage own group list items" ON group_list_items
  FOR ALL USING (
    group_list_id IN (
      SELECT gl.id FROM group_lists gl
      JOIN account_members am ON am.account_id = gl.account_id
      WHERE am.user_id = auth.uid()
    )
  );

-- ============================================================
-- CAMPAIGN PRODUCTS — reusable raw messages (replaces templates)
-- ============================================================
CREATE TABLE IF NOT EXISTS campaign_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  caption TEXT,
  media_url TEXT,
  media_type TEXT NOT NULL DEFAULT 'text', -- text|image|video|audio|document
  source TEXT NOT NULL DEFAULT 'manual',   -- manual|csv_import|campaign_custom
  import_batch_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_products_account ON campaign_products(account_id);
CREATE INDEX IF NOT EXISTS idx_campaign_products_created ON campaign_products(created_at DESC);

ALTER TABLE campaign_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own campaign products" ON campaign_products;
CREATE POLICY "Users can manage own campaign products" ON campaign_products
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- CAMPAIGNS — scheduled bulk sends (WassFlow engine port)
-- campaign_type: 1 = bulk product distribution, 2 = broadcast
-- ============================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  campaign_type INTEGER NOT NULL DEFAULT 2,
  session_id UUID NOT NULL REFERENCES wasender_sessions(id) ON DELETE CASCADE,
  group_list_id UUID REFERENCES group_lists(id) ON DELETE SET NULL,
  product_ids UUID[] NOT NULL DEFAULT '{}',
  delay_min_seconds INTEGER NOT NULL DEFAULT 60,
  delay_max_seconds INTEGER NOT NULL DEFAULT 300,
  wave_delay_min_seconds INTEGER NOT NULL DEFAULT 60,
  wave_delay_max_seconds INTEGER NOT NULL DEFAULT 300,
  scheduling_mode TEXT NOT NULL DEFAULT 'automatic', -- automatic|manual
  wave_start_times TIMESTAMPTZ[],
  scheduled_start_at TIMESTAMPTZ,
  start_jitter_seconds INTEGER DEFAULT 120,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|scheduled|running|paused|completed|cancelled|failed
  total_events INTEGER NOT NULL DEFAULT 0,
  completed_events INTEGER NOT NULL DEFAULT 0,
  failed_events INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT chk_campaign_status CHECK (
    status IN ('draft','scheduled','running','paused','completed','cancelled','failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(account_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own campaigns" ON campaigns;
CREATE POLICY "Users can manage own campaigns" ON campaigns
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- CAMPAIGN EVENTS — per-recipient send jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS campaign_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES campaign_products(id),
  group_jid TEXT NOT NULL,
  group_name TEXT,
  batch_index INTEGER NOT NULL DEFAULT 0,
  send_order INTEGER NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|queued|sending|sent|failed|skipped|cancelled
  actual_sent_at TIMESTAMPTZ,
  api_status_code INTEGER,
  api_response TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT chk_event_status CHECK (
    status IN ('pending','queued','sending','sent','failed','skipped','cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_campaign_events_account ON campaign_events(account_id);
CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign_status
  ON campaign_events(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_events_pending
  ON campaign_events(status, scheduled_at) WHERE status = 'pending';

ALTER TABLE campaign_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own campaign events" ON campaign_events;
CREATE POLICY "Users can manage own campaign events" ON campaign_events
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- SEND QUEUE — serialized dispatch (anti-ban: 1-5 workers/session,
-- 5s min gap, exponential backoff)
-- ============================================================
CREATE TABLE IF NOT EXISTS send_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  instance_api_key TEXT NOT NULL, -- encrypted session key snapshot
  recipient TEXT NOT NULL,
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 1,     -- 1 = campaign, 10 = trigger/autoresponse
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|sent|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  presence_type TEXT,
  presence_duration_seconds INTEGER DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  error_message TEXT,
  campaign_event_id UUID REFERENCES campaign_events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT chk_queue_status CHECK (
    status IN ('pending','processing','sent','failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_send_queue_account ON send_queue(account_id);
CREATE INDEX IF NOT EXISTS idx_send_queue_pending_lookup
  ON send_queue(session_id, priority DESC, scheduled_at)
  WHERE status = 'pending';

ALTER TABLE send_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own send queue" ON send_queue;
CREATE POLICY "Users can manage own send queue" ON send_queue
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- FLOW SPLIT TESTS — A/B variant routing for flows
-- (WassFlow variant-selector + response-tracker port)
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_split_tests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID REFERENCES flows(id) ON DELETE CASCADE,
  trigger_id TEXT,              -- the node key of the split_test node
  name TEXT NOT NULL,
  weight INTEGER DEFAULT 1,
  target_node_key TEXT NOT NULL, -- which flow node this variant routes to
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flow_split_tests_account ON flow_split_tests(account_id);
CREATE INDEX IF NOT EXISTS idx_flow_split_tests_flow ON flow_split_tests(flow_id);

ALTER TABLE flow_split_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own flow split tests" ON flow_split_tests;
CREATE POLICY "Users can manage own flow split tests" ON flow_split_tests
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- Which variant was sent to which contact, and whether they responded.
CREATE TABLE IF NOT EXISTS flow_split_test_sends (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  flow_id UUID,
  split_test_id UUID REFERENCES flow_split_tests(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  responded BOOLEAN DEFAULT FALSE,
  responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_split_test_sends_contact
  ON flow_split_test_sends(contact_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_split_test_sends_variant
  ON flow_split_test_sends(split_test_id, sent_at);

ALTER TABLE flow_split_test_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own split test sends" ON flow_split_test_sends;
CREATE POLICY "Users can manage own split test sends" ON flow_split_test_sends
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM account_members WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- Extend WaCRM's messages + conversations for wasender identity
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS source_provider TEXT NOT NULL DEFAULT 'wasender',
  ADD COLUMN IF NOT EXISTS wats_msg_id TEXT,
  ADD COLUMN IF NOT EXISTS sender_jid TEXT;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS source_provider TEXT NOT NULL DEFAULT 'wasender',
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES wasender_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_messages_wats_msg_id ON messages(wats_msg_id);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);

-- ============================================================
-- updated_at trigger helper (matches WaCRM's convention)
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_wasender_sessions_updated_at ON wasender_sessions;
CREATE TRIGGER set_wasender_sessions_updated_at
  BEFORE UPDATE ON wasender_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_wasender_groups_updated_at ON wasender_groups;
CREATE TRIGGER set_wasender_groups_updated_at
  BEFORE UPDATE ON wasender_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_group_lists_updated_at ON group_lists;
CREATE TRIGGER set_group_lists_updated_at
  BEFORE UPDATE ON group_lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_campaigns_updated_at ON campaigns;
CREATE TRIGGER set_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
