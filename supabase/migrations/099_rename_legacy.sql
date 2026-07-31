-- ============================================================
-- 099_rename_legacy.sql
--
-- The previous single-user WassFlow app shares this Supabase
-- project (boecdbsvopfxjkiaxvzl). Its tables collide with WaCRM's
-- schema (notably `messages`). To host the new multi-tenant SaaS in
-- the SAME project, every existing WassFlow table is renamed to
-- `legacy_*`. Postgres automatically rewrites foreign keys, indexes,
-- triggers, and RLS policies to follow the renamed tables, so all
-- existing data is preserved intact for the one-time port (Phase 10).
--
-- The old app will no longer work after this runs (its queries
-- reference the old names). Run this BEFORE applying WaCRM's
-- migrations 001-036 and our 100+ wasender migrations.
--
-- Idempotent: guarded by existence checks.
-- ============================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Rename only if the target name doesn't already exist.
  FOR r IN
    SELECT oid::regclass::text AS old_name,
           ('legacy_' || oid::regclass::text) AS new_name
    FROM pg_class
    WHERE relkind = 'r'
      AND relnamespace = 'public'::regnamespace
      AND oid::regclass::text IN (
        'tenants',
        'whatsapp_sessions',
        'chats',
        'messages',
        'groups',
        'group_members',
        'group_activity_logs',
        'automation_workflows',
        'automation_actions',
        'scheduled_broadcasts',
        'trigger_variants',
        'automation_variant_sends',
        'wf_config',
        'wf_sequences',
        'wf_steps',
        'wf_triggers',
        'wf_messages',
        'wf_send_jobs',
        'wf_group_lists',
        'wf_group_list_items',
        'wf_products',
        'wf_campaigns',
        'wf_campaign_events',
        'wf_send_queue'
      )
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', r.old_name, r.new_name);
      RAISE NOTICE 'Renamed % to %', r.old_name, r.new_name;
    EXCEPTION
      WHEN duplicate_table THEN
        RAISE NOTICE 'Skipping % (target already exists)', r.old_name;
    END;
  END LOOP;
END $$;

-- Sanity marker: record the cutover so later migrations can detect
-- whether the rename ran.
CREATE TABLE IF NOT EXISTS _migration_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO _migration_meta (key, value)
VALUES ('legacy_rename_done', 'true')
ON CONFLICT (key) DO UPDATE SET value = 'true', applied_at = now();
