-- ═══════════════════════════════════════════════════════════════════════════
-- 065_compliance_alert_runs.sql — evidence that the expiry check actually ran
--
-- The dashboard reads v_compliance_alerts LIVE, so the red banner needs no
-- table behind it and none is created for it here. What a background job does
-- need is a record that it ran, because the failure mode of a silent daily
-- check is indistinguishable from a healthy one: an empty alert list means
-- "nothing expires soon" and also means "the job died three weeks ago".
--
-- `notifications` was the obvious candidate and is the wrong table — it is an
-- outbound message queue with a channel and a recipient, for things being SENT.
-- These are observations, not messages.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS compliance_alert_runs (
  id           bigserial PRIMARY KEY,
  ran_on       date NOT NULL DEFAULT CURRENT_DATE,
  threshold_days integer NOT NULL,
  checked      integer NOT NULL DEFAULT 0,
  expired      integer NOT NULL DEFAULT 0,
  expiring     integer NOT NULL DEFAULT 0,
  detail       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per day. The job is idempotent against this: a restart re-runs the
-- check and updates the day's row rather than appending a second one.
CREATE UNIQUE INDEX IF NOT EXISTS compliance_alert_runs_day ON compliance_alert_runs (ran_on);

COMMENT ON TABLE compliance_alert_runs IS
  'Daily proof the expiry sweep ran. An empty alert list is only good news if this table says today.';

COMMIT;
