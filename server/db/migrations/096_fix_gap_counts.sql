-- ═══════════════════════════════════════════════════════════════════════════
-- 096_fix_gap_counts.sql — the per-vehicle counts were fleet-wide totals
--
-- In 095 the expired/expiring subqueries read
--     SELECT count(*) FROM held h WHERE h.next_due_date < CURRENT_DATE
-- with no `AND h.vehicle_id = v.id`. The correlation was missing, so every row
-- got the whole fleet's total: all 49 lorries reported 6 expired and 3
-- expiring, including the 13 that hold no documents at all.
--
-- Caught because those numbers were identical on every row, and because a lorry
-- with docs_held = 0 cannot have six expired documents. An uncorrelated
-- subquery does not error — it just quietly answers a different question.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW v_vehicle_gaps AS
WITH required(doc_type, label) AS (VALUES
  ('insurance',       'Insurance'),
  ('fitness',         'Fitness'),
  ('national_permit', 'National Permit'),
  ('home_permit',     'Home Permit'),
  ('pollution',       'PUC'),
  ('mv_tax',          'MV Tax')
)
SELECT v.id AS vehicle_id, v.vehicle_no, v.branch, v.owner_name,
       v.ownership::text AS ownership, v.status,
       (SELECT count(*)::int FROM vehicle_documents h WHERE h.vehicle_id = v.id) AS docs_held,
       ARRAY(SELECT r.label FROM required r
              WHERE NOT EXISTS (SELECT 1 FROM vehicle_documents h
                                 WHERE h.vehicle_id = v.id AND h.doc_type = r.doc_type)
              ORDER BY r.label) AS missing_docs,
       -- Held but undated: the paper exists, the expiry does not, so nothing
       -- will ever alert on it. Quietly the worst of the three states.
       ARRAY(SELECT COALESCE(d.doc_name, d.doc_type) FROM vehicle_documents d
              WHERE d.vehicle_id = v.id AND d.next_due_date IS NULL
              ORDER BY 1) AS undated_docs,
       (SELECT count(*)::int FROM vehicle_documents h
         WHERE h.vehicle_id = v.id
           AND h.next_due_date IS NOT NULL
           AND h.next_due_date < CURRENT_DATE) AS expired_count,
       (SELECT count(*)::int FROM vehicle_documents h
         WHERE h.vehicle_id = v.id
           AND h.next_due_date IS NOT NULL
           AND h.next_due_date >= CURRENT_DATE
           AND h.next_due_date <= CURRENT_DATE + compliance_alert_days()) AS expiring_count
  FROM vehicles v;

COMMIT;
