-- ============================================================
-- 100a_account_members_compat.sql
--
-- Migration 100_wasender_schema.sql was written against a
-- hypothetical `account_members` table, but the membership model
-- that migrations 001-036 actually created (017_account_sharing)
-- is: profiles.account_id + profiles.account_role, with the
-- is_account_member(account_id, min_role) helper.
--
-- This migration materialises the account_members shape as a VIEW
-- over the real membership data so 100's RLS policies (which read
-- `account_id IN (SELECT account_id FROM account_members WHERE
-- user_id = auth.uid())`) resolve correctly.
--
-- Idempotent.
-- ============================================================

CREATE OR REPLACE VIEW account_members AS
SELECT
  p.account_id,
  p.user_id,
  p.account_role::text AS role
FROM profiles p
WHERE p.account_id IS NOT NULL;

GRANT SELECT ON account_members TO authenticated, service_role;
