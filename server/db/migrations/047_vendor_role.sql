-- ═══════════════════════════════════════════════════════════════════════════
-- 047_vendor_role.sql — give VENDOR a place in the role enum
--
-- The 5-role super app routes on ADMIN / OFFICE_STAFF / DRIVER / CUSTOMER /
-- VENDOR, but `user_role` only ever had SUPER_ADMIN, ADMIN, ACCOUNTS, DISPATCH,
-- DRIVER, CUSTOMER, VIEWER. CUSTOMER could at least be spelled; VENDOR could
-- not be stored at all, so the vendor portal had no reachable account and sat
-- behind a role wall nobody could satisfy.
--
-- WHY THIS FILE IS ALONE AND HAS NO BEGIN/COMMIT.
-- Postgres refuses to USE a new enum value in the same transaction that adds
-- it. The runner executes each file as one statement batch and lets the file
-- own its transaction, so a bare file runs in autocommit: the value is
-- committed here and is usable by 048 in the next batch. Merging the two would
-- fail with "unsafe use of new value of enum type".
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'VENDOR';
