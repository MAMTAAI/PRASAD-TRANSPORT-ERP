-- ═══════════════════════════════════════════════════════════════════════════
-- 074_loan_tiers_and_ledger.sql — step-up EMIs, the lender's own ledger, and a
-- statement that can be handed to an auditor.
--
-- ── WHY THE EXISTING SHAPE COULD NOT ANSWER THE QUESTION ────────────────────
-- loan_master already carried `emi_slabs` and `repayment_schedule` as jsonb, and
-- for what they were built to do — feed one screen a whole loan at once — that
-- was the right call (005 says so). What they cannot do is be QUERIED. There is
-- no way to ask "which instalments were overdue on 01-04-2026", "what did this
-- truck's finance cost last year", or "show every EMI between two dates across
-- the fleet" without pulling 29 documents into JavaScript and looping. A ledger
-- statement is exactly that question asked 58 times.
--
-- Worse, a jsonb array cannot be constrained. Nothing stopped a slab running
-- 001-006 while the next started at 008, and the two instalments in the gap
-- would simply never be billed — a schedule that is short by one EMI still adds
-- up to a plausible-looking number and fails silently for four years.
--
-- ── WHAT A TIER IS ─────────────────────────────────────────────────────────
-- TATA does not lend at a flat instalment. Contract 5004384745 reads:
--
--     001 to 001     30,301        the odd first month, lead period included
--     002 to 006     30,285        five low instalments while the truck earns
--     007 to 058    112,987        the contractual EMI for the rest of the term
--
-- Every one of the 27 contracts has three tiers. Code that assumed one flat EMI
-- was wrong about 58 months out of 58 on every loan — the six low months by
-- 82,702 each, and the other 52 by whatever the average concealed.
--
-- loan_emi_tiers holds that pattern as rows, and a constraint trigger enforces
-- what the jsonb could not: the tiers must start at instalment 1, must not
-- overlap, must leave no gap, and must end exactly on the contracted tenure.
--
-- ── WHY THE LENDER'S LEDGER, NOT A MODEL ───────────────────────────────────
-- A model says every instalment fell due on the 11th and was paid. These
-- accounts run at an average delay of 47 days and a peak of 214; four of them
-- carry repossession and valuation charges. loan_instalments and loan_receipts
-- hold what TATA's own statement records — what it raised, what it received,
-- when, and the late-payment interest each delay attracted. Rows sourced from
-- the statement are marked LENDER_STATEMENT and outrank anything modelled,
-- because on a disputed account the lender's book is the one that will be
-- produced.
--
-- ── ONE WRITER ─────────────────────────────────────────────────────────────
-- No agent owns these tables. `server/modules/loanImport.routes.js` is the sole
-- writer, the same as for loan_master and emi_payments, and TARA remains the
-- only path to ledger_entries — nothing here posts to the GL.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The moratorium the contract actually has ────────────────────────────
-- Disbursal and first instalment are NOT consecutive months. 5004384745 paid
-- out on 14-07-2022 and does not collect until 11-09-2022 — a 59-day lead
-- period that the lender prints and on which it charges interest. The old model
-- started the balance at the full principal on the first EMI date and never
-- accounted for that gap; the solved rate silently absorbed it, which is how a
-- printed 10.5301% came out as 10.8625%.
ALTER TABLE loan_master
  ADD COLUMN IF NOT EXISTS disbursal_date     date,
  ADD COLUMN IF NOT EXISTS lead_period_days   integer,
  ADD COLUMN IF NOT EXISTS moratorium_interest numeric(14,2),
  ADD COLUMN IF NOT EXISTS contract_value     numeric(14,2),
  ADD COLUMN IF NOT EXISTS interest_amt       numeric(14,2),
  ADD COLUMN IF NOT EXISTS printed_irr        numeric(8,4),
  ADD COLUMN IF NOT EXISTS instalment_count   integer,
  ADD COLUMN IF NOT EXISTS statement_as_of    date;

-- ── tenure_months MEANT TWO DIFFERENT THINGS ───────────────────────────────
-- Caught by the tier trigger below on its first run, which is the whole point
-- of having one. TATA prints "No.of Instls 058" and that went into
-- tenure_months; IndusInd's three loans are 60-MONTH TERMS containing a
-- two-month moratorium and 58 instalments, and 60 went into the same column.
-- So one column held instalments for 26 loans and months for 3, and any
-- arithmetic over the fleet was wrong on whichever set it did not mean.
--
-- instalment_count is now the number of instalments and nothing else — it is
-- what the tier pattern must cover. tenure_months keeps its literal meaning,
-- the length of the term, and v_loan_term_check reports where the two cannot
-- be reconciled through the moratorium instead of a constraint deciding which
-- lender's paperwork is wrong.
COMMENT ON COLUMN loan_master.instalment_count IS
  'Number of instalments the lender will collect. NOT the term: a 60-month '
  'IndusInd facility with a two-month moratorium collects 58.';
COMMENT ON COLUMN loan_master.tenure_months IS
  'Length of the term in months, moratorium included. Use instalment_count for '
  'anything that counts instalments.';

COMMENT ON COLUMN loan_master.lead_period_days IS
  'Days between disbursal and the first instalment. Interest accrues across it; '
  'a schedule that ignores it misprices every instalment that follows.';
COMMENT ON COLUMN loan_master.printed_irr IS
  'The rate the lender prints. Kept for reference only — it does not reproduce '
  'the contract''s own cash flows. loanAmortiser solves the rate from the '
  'instalments instead. See v_loan_rate_check.';

-- sanction_date was already carrying the disbursal date; name it honestly.
UPDATE loan_master SET disbursal_date = sanction_date
 WHERE disbursal_date IS NULL AND sanction_date IS NOT NULL;

UPDATE loan_master
   SET lead_period_days = (first_emi_date - disbursal_date)
 WHERE lead_period_days IS NULL
   AND first_emi_date IS NOT NULL AND disbursal_date IS NOT NULL;

-- moratorium_months was recorded on the three IndusInd loans and left null on
-- the TATA ones, though every TATA contract has one. Derive it from the dates
-- so the column means the same thing on all 29.
UPDATE loan_master
   SET moratorium_months = GREATEST(0,
         (date_part('year',  age(first_emi_date, disbursal_date)) * 12
        + date_part('month', age(first_emi_date, disbursal_date)))::int)
 WHERE moratorium_months IS NULL
   AND first_emi_date IS NOT NULL AND disbursal_date IS NOT NULL;

-- ── 2. Step-up / multi-tier instalments ────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_emi_tiers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES loan_master(id) ON DELETE CASCADE,
  from_instalment integer NOT NULL CHECK (from_instalment >= 1),
  to_instalment   integer NOT NULL,
  emi_amount      numeric(14,2) NOT NULL CHECK (emi_amount > 0),
  -- The lender's own IRR for this tier, as printed. Reference, not arithmetic.
  printed_irr     numeric(8,4),
  source          text NOT NULL DEFAULT 'LENDER_CONTRACT',
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tier_range_sane CHECK (to_instalment >= from_instalment)
);
CREATE UNIQUE INDEX IF NOT EXISTS loan_emi_tiers_start_uniq
  ON loan_emi_tiers (loan_id, from_instalment);
CREATE INDEX IF NOT EXISTS loan_emi_tiers_loan_idx
  ON loan_emi_tiers (loan_id, from_instalment);

-- A tier table that does not cover the term is the failure this replaces, and
-- it is invisible in the data — the rows all look reasonable on their own. So
-- the whole set is checked together, at COMMIT, whenever any of it moves.
CREATE OR REPLACE FUNCTION loan_tiers_must_cover_term() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_loan   uuid := COALESCE(NEW.loan_id, OLD.loan_id);
  v_count  integer;
  v_first  integer;
  v_last   integer;
  v_gap    integer;
BEGIN
  SELECT instalment_count INTO v_count FROM loan_master WHERE id = v_loan;
  SELECT min(from_instalment), max(to_instalment)
    INTO v_first, v_last FROM loan_emi_tiers WHERE loan_id = v_loan;

  IF v_first IS NULL THEN
    RETURN NULL;                                    -- every tier deleted; fine
  END IF;
  IF v_first <> 1 THEN
    RAISE EXCEPTION 'loan % : instalment tiers start at %, not 1', v_loan, v_first
      USING ERRCODE = 'check_violation';
  END IF;

  -- Overlap and gap are the same test: consecutive tiers must meet exactly.
  SELECT count(*) INTO v_gap FROM (
    SELECT to_instalment,
           lead(from_instalment) OVER (ORDER BY from_instalment) AS nxt
      FROM loan_emi_tiers WHERE loan_id = v_loan) t
   WHERE nxt IS NOT NULL AND nxt <> to_instalment + 1;
  IF v_gap > 0 THEN
    RAISE EXCEPTION 'loan % : instalment tiers overlap or leave a gap', v_loan
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_count IS NOT NULL AND v_last <> v_count THEN
    RAISE EXCEPTION 'loan % : tiers end at instalment % but the contract collects %',
      v_loan, v_last, v_count USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS loan_emi_tiers_cover ON loan_emi_tiers;
CREATE CONSTRAINT TRIGGER loan_emi_tiers_cover
  AFTER INSERT OR UPDATE OR DELETE ON loan_emi_tiers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION loan_tiers_must_cover_term();

COMMENT ON TABLE loan_emi_tiers IS
  'Step-up instalment pattern: instalments from_instalment..to_instalment cost '
  'emi_amount. Deferred trigger enforces start-at-1, no gap, no overlap, ends on '
  'the contracted tenure — the four ways a jsonb slab array failed silently.';

-- Carry the jsonb slabs across. They stay on loan_master as the raw reading of
-- the paper; these rows are what everything queries from here on.
INSERT INTO loan_emi_tiers (loan_id, from_instalment, to_instalment, emi_amount, source, note)
SELECT l.id,
       (s->>'from_month')::int, (s->>'to_month')::int, (s->>'amount')::numeric,
       'LENDER_CONTRACT', 'backfilled from loan_master.emi_slabs at migration 074'
  FROM loan_master l
  CROSS JOIN LATERAL jsonb_array_elements(l.emi_slabs) s
 WHERE jsonb_typeof(l.emi_slabs) = 'array'
   AND NOT EXISTS (SELECT 1 FROM loan_emi_tiers t WHERE t.loan_id = l.id)
ON CONFLICT (loan_id, from_instalment) DO NOTHING;

-- The instalment count comes FROM the tiers, because the tiers came from the
-- lender's own contract change history and that is the authoritative statement
-- of how many instalments it will collect. Deriving it the other way — from
-- tenure_months less a moratorium — is what produced the ambiguity above.
UPDATE loan_master l
   SET instalment_count = t.last_no
  FROM (SELECT loan_id, max(to_instalment) AS last_no
          FROM loan_emi_tiers GROUP BY loan_id) t
 WHERE t.loan_id = l.id AND l.instalment_count IS NULL;

UPDATE loan_master SET instalment_count = tenure_months
 WHERE instalment_count IS NULL AND tenure_months IS NOT NULL;

-- Where the term and the instalment count cannot be squared through the
-- moratorium, say so out loud rather than picking a winner.
CREATE OR REPLACE VIEW v_loan_term_check AS
SELECT id AS loan_id, loan_account_no, vehicle_no, bank_name AS financier,
       tenure_months, instalment_count, moratorium_months, lead_period_days,
       disbursal_date, first_emi_date,
       (tenure_months - instalment_count - COALESCE(moratorium_months, 0)) AS unexplained_months
  FROM loan_master
 WHERE tenure_months IS NOT NULL AND instalment_count IS NOT NULL
   AND tenure_months - instalment_count - COALESCE(moratorium_months, 0) <> 0;

COMMENT ON VIEW v_loan_term_check IS
  'Loans whose term, instalment count and moratorium do not add up. Empty is '
  'the expected state; a row means the paperwork was read wrong somewhere.';

-- ── 3. The instalments themselves ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_instalments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id           uuid NOT NULL REFERENCES loan_master(id) ON DELETE CASCADE,
  instalment_no     integer NOT NULL CHECK (instalment_no >= 1),
  due_date          date NOT NULL,
  due_amount        numeric(14,2) NOT NULL CHECK (due_amount > 0),
  -- Split, where a model can supply one. A statement-sourced instalment has no
  -- split — the lender does not publish it — and null says so rather than 0.00
  -- pretending the whole instalment was interest.
  principal_part    numeric(14,2),
  interest_part     numeric(14,2),
  closing_principal numeric(14,2),
  -- What the lender did, as opposed to what the contract said.
  raised_on         date,
  lender_running_dues numeric(14,2),
  delay_days        integer,
  overdue_interest  numeric(14,2) NOT NULL DEFAULT 0 CHECK (overdue_interest >= 0),
  document_no       text,
  source            text NOT NULL DEFAULT 'MODELLED'
                    CHECK (source IN ('MODELLED','LENDER_STATEMENT')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, instalment_no)
);
CREATE INDEX IF NOT EXISTS loan_instalments_due_idx ON loan_instalments (due_date);
CREATE INDEX IF NOT EXISTS loan_instalments_loan_idx ON loan_instalments (loan_id, instalment_no);

COMMENT ON COLUMN loan_instalments.overdue_interest IS
  'Late-payment interest (ODC/LPC) the lender charged against THIS instalment, '
  'from its own statement. Not a modelled penalty.';

-- ── 4. What actually cleared ───────────────────────────────────────────────
-- Distinct from emi_payments on purpose. emi_payments is OUR book — one row per
-- EMI we posted, carrying the voucher that moved the GL. loan_receipts is the
-- LENDER'S book — one row per instrument it banked, in its amounts and on its
-- dates. They will not agree row for row and are not meant to; the gap between
-- them is the reconciliation, and collapsing them into one table would destroy
-- the only evidence that a payment went missing.
CREATE TABLE IF NOT EXISTS loan_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id           uuid NOT NULL REFERENCES loan_master(id) ON DELETE CASCADE,
  value_date        date NOT NULL,
  cleared_date      date NOT NULL,
  amount            numeric(14,2) NOT NULL CHECK (amount > 0),
  document_no       text,
  lender_running_dues numeric(14,2),
  delay_days        integer,
  overdue_interest  numeric(14,2),
  -- Document order in the statement. Two receipts can share a date, and the
  -- lender's running balance only makes sense in the order it printed them.
  stmt_seq          integer,
  source            text NOT NULL DEFAULT 'LENDER_STATEMENT',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_receipts_loan_idx ON loan_receipts (loan_id, cleared_date, stmt_seq);
-- One instrument is banked once. Re-importing the same statement must converge.
CREATE UNIQUE INDEX IF NOT EXISTS loan_receipts_doc_uniq
  ON loan_receipts (loan_id, document_no, cleared_date, amount)
  WHERE document_no IS NOT NULL AND document_no <> '';

-- ── 5. LPC, bounce and the rest ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_charges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id       uuid NOT NULL REFERENCES loan_master(id) ON DELETE CASCADE,
  head          text NOT NULL,
  -- NULL where the lender states a balance without a date. That is a real gap
  -- in the paper and it is recorded as one: the opening balance reports undated
  -- charges on their own line instead of guessing which side of the cut-off
  -- they belong on.
  charge_date   date,
  charged       numeric(14,2) NOT NULL DEFAULT 0,
  recovered     numeric(14,2) NOT NULL DEFAULT 0,
  outstanding   numeric(14,2) NOT NULL DEFAULT 0,
  -- LPC and bounce are penal and belong in the arrears figure. Stamp duty and
  -- the processing fee were deducted at disbursal and are not arrears at all.
  is_penal      boolean NOT NULL DEFAULT false,
  source        text NOT NULL DEFAULT 'LENDER_STATEMENT',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, head, source)
);
CREATE INDEX IF NOT EXISTS loan_charges_loan_idx ON loan_charges (loan_id);

COMMENT ON COLUMN loan_charges.is_penal IS
  'LPC / bounce / repossession — charges caused by default, which belong in '
  'arrears. Stamp and processing fees are not: they were netted off at '
  'disbursal and were never owed.';

DROP TRIGGER IF EXISTS loan_instalments_touch ON loan_instalments;
CREATE TRIGGER loan_instalments_touch BEFORE UPDATE ON loan_instalments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 6. Backfill the instalments from what is already stored ────────────────
-- repayment_schedule is a modelled schedule and it stays marked MODELLED. The
-- statement import replaces these with LENDER_STATEMENT rows where it has them.
INSERT INTO loan_instalments (loan_id, instalment_no, due_date, due_amount,
                              principal_part, interest_part, closing_principal, source)
SELECT l.id,
       (r->>'month_no')::int,
       (r->>'date')::date,
       (r->>'emi')::numeric,
       NULLIF(r->>'principal','')::numeric,
       NULLIF(r->>'interest','')::numeric,
       NULLIF(r->>'balance','')::numeric,
       'MODELLED'
  FROM loan_master l
  CROSS JOIN LATERAL jsonb_array_elements(l.repayment_schedule) r
 WHERE jsonb_typeof(l.repayment_schedule) = 'array'
   AND (r->>'emi')::numeric > 0
ON CONFLICT (loan_id, instalment_no) DO NOTHING;

COMMIT;
