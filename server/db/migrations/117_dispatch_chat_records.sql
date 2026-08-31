-- ═══════════════════════════════════════════════════════════════════════════
-- 117_dispatch_chat_records.sql — dispatch chat grows a record spine
--
-- The chat redesign mandate (2026-08-31). Three additions to wa_chats:
--
--   * media_key — the actual bytes. Until now the WhatsApp engine forwarded
--     only a LABEL ("📎 Document: bill.pdf") and threw the media away; the
--     engine now downloads inbound images/PDFs and stores them in the vault
--     (wa-media/<phone>/…), so staff preview them inline instead of asking
--     the driver to send it again "to the other number".
--
--   * vehicle_id / expense_id — structured record links, beside the existing
--     trip_id. A message ABOUT something should point AT that thing: a fuel
--     slip photo links to the expense it becomes, a breakdown message links
--     to the vehicle. Links are staff-set (PATCH /crm/chats/:id/link), never
--     guessed; the old inferred trip_id stays as a hint only.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE wa_chats
  ADD COLUMN IF NOT EXISTS media_key  text,
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id),
  ADD COLUMN IF NOT EXISTS expense_id uuid REFERENCES expense_approvals(id);

CREATE INDEX IF NOT EXISTS idx_wa_chats_vehicle
  ON wa_chats (vehicle_id, ts DESC) WHERE vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_chats_expense
  ON wa_chats (expense_id, ts DESC) WHERE expense_id IS NOT NULL;

COMMIT;
