-- ═══════════════════════════════════════════════════════════════════════════
-- 051_audit_actor_no_fk.sql — an append-only table cannot have ON DELETE SET NULL
--
-- 048 gave audit_logs two foreign keys to the actor (users, drivers) declared
-- ON DELETE SET NULL, and in the same file made the table append-only with a
-- trigger that refuses UPDATE. Those two decisions cannot both hold: SET NULL
-- *is* an UPDATE, so Postgres runs it, the trigger refuses it, and the whole
-- delete aborts with "audit_logs is append-only: UPDATE refused."
--
-- The effect was that ANY user who had ever performed a write could no longer
-- be deleted — DELETE /auth/users/:id would fail for exactly the accounts that
-- had been used, and succeed only for ones that never did anything. Found by
-- deleting a temporary account created to verify the approvals API.
--
-- The fix is to drop the foreign keys, not to weaken the immutability. The
-- trail was already built to survive the actor disappearing: actor_name and
-- actor_role are copied into every row precisely so it still reads correctly
-- after a user is renamed or removed. The FK added referential integrity that
-- the design does not depend on, at the cost of the guarantee that does matter.
--
-- The columns stay (plain uuid) — they are still the right join key while the
-- user exists, and a dangling id in a historical record is the honest
-- representation of "this person is gone".
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_user_id_fkey;
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_driver_id_fkey;

COMMENT ON COLUMN audit_logs.actor_user_id IS
  'users.id at the time of the action. Deliberately NOT a foreign key: the table is append-only, so ON DELETE SET NULL could never fire and blocked user deletion outright. actor_name/actor_role carry the readable record.';

COMMIT;
