# PRASAD ERP — Unified Self-Healing Engine & API Shield

Level-5 safe self-healing for the ERP, wired into the MAMTA AI PRO Central
Orchestrator Bridge (`http://127.0.0.1:8765`). **Law: the AI proposes, God
(Subhash Sir) disposes.** Nothing overwrites live ERP code and nothing restarts
a service until a proposal is explicitly approved in the MAMTA God Approval UI.

## Components

| File | Role |
|---|---|
| `scripts/erp_api_shield.cjs` | Backoff + rate-limit + circuit-breaker decorator for external transport APIs (Vahan, Sarathi, E-Way Bill, GST, GTROPY). |
| `scripts/erp_auto_healer.cjs` | Log-tailing heal daemon: DETECT → GUARD → DRAFT (local LLM) → PROPOSE (HITL) → EXECUTE (only after GOD_APPROVE). |
| `scripts/erp_system_log.cjs` | Shared JSONL logger — `logs/erp_system.log` + summary mirror into MAMTA `boot_book.log` (same row schema as `boot_book.py`). |
| `scripts/install-healer-task.ps1` | Scheduled-task installer for the healer daemon (at-logon, current user). |

Bridge-side (repo `E:\jaiswal-terminal`, needs the bridge restarted to take
effect — already done 2026-08-01): `/propose` now accepts `kind=js`, and
`god_mode.risk_lint` gained a fail-closed JS branch (`eval`/`new Function`/
destructive-shell/download-and-exec ⇒ hard fail; `child_process` ⇒ lint note
for the reviewer + God). The deterministic JS **syntax** authority is
`node --check`, run ERP-side both before proposing and again before any apply.

## Heal pipeline (mirror of `tools/mamta-bridge/auto_healer.py`)

1. **DETECT** — tails `logs/*.err.log` (+ `whatsapp-server/logs/*.err.log`) for
   `SyntaxError` / `TypeError` / `ReferenceError` / `RangeError` stacks and
   UnhandledPromiseRejection tags. First stack frame inside an allowed ERP root
   wins. Offsets seed to end-of-file on first run — old log noise is history.
2. **GUARD** — allowed targets: root `*.cjs` (bridge.cjs, toll-sync.cjs, …),
   `scripts/`, `whatsapp-server/`. Never `node_modules`, never the healer or
   its logger (circular-repair ban). Max 3 proposals per module per hour, 24 h
   same-signature cooldown, ≤ 20 kB file cap (full-file LLM rewrite is unsafe
   beyond that — `HEAL_SKIP_TOOLARGE`, human review needed).
3. **DRAFT** — `deepseek-coder` via bridge `/ask` returns the complete
   corrected file. Validation before anything reaches God: `node --check`
   passes, size band 0.5–1.7×, fix ≠ original, top-level function names
   preserved. One guided retry, then `HEAL_DRAFT_FAIL`.
4. **PROPOSE** — `POST /propose` `{kind:'js', purpose:'[PRASAD_ERP] AUTO-HEAL …',
   leg:'heal|<file>', source_agent:'prasad-erp-healer'}` → Agentic Debate
   (JS lint + risk-guard reviewer + RLGF repeat-block) → `PENDING_APPROVAL` in
   `god_approvals.json` → God Approval UI. Ledger:
   `logs/erp_heal_proposals.json` (`{project:'PRASAD_ERP', id, module, line_no,
   traceback, original_sha, original_snippet, proposed_fix, status}`).
5. **EXECUTE** — polls `god_approvals.json` read-only (the HTTP list truncates
   code at 3000 chars; the file is the truth).
   - `GOD_APPROVED` / `GOD_APPROVED_OVERRIDE` → sha-unchanged check →
     re-validate (incl. `node --check`) → timestamped backup in `backups/heal/`
     → atomic overwrite → post-apply `node --check` (fail ⇒ instant rollback,
     `HEAL_ROLLBACK`) → restart mapped service (`bridge.cjs` → stop :3000 +
     idempotent `start-ai-stack.ps1`; one-shot scripts need no restart).
   - `REJECTED_BY_GOD` → discarded (`HEAL_DISCARDED`); RLGF has already
     vectorized the rejection reason so the mistake is never re-proposed.

## Run it

```powershell
node scripts\erp_auto_healer.cjs --self-test   # offline parser/guard tests
node scripts\erp_auto_healer.cjs --once        # single cycle
node scripts\erp_auto_healer.cjs               # daemon (15 s poll)
.\scripts\install-healer-task.ps1              # auto-start at logon
```

**Kill switch:** create `ERP_HEALER.KILL` in the repo root — the daemon pauses
(detect/propose/apply all stop, logged `HEALER_PAUSED`). Delete to resume.

Env overrides: `MAMTA_BRIDGE_URL`, `MAMTA_BRIDGE_TOKEN(_FILE)`,
`MAMTA_APPROVALS_PATH`, `MAMTA_BOOT_BOOK`, `ERP_HEAL_POLL_S`,
`ERP_HEAL_RATE_MAX`, `ERP_HEAL_MAX_FILE_BYTES`, `ERP_HEAL_MODEL`.

## API Shield usage

```js
const { createShield } = require('./scripts/erp_api_shield.cjs');
const vahan = createShield('VAHAN');            // presets: VAHAN SARATHI EWAYBILL GST GTROPY
const fetchRC = vahan.wrap((regNo) => axios.get(vahanUrl(regNo)));
await fetchRC('MH12AB1234');
```

Per call: token-bucket rate limit (waits its turn, `RateLimitError` if the
queue is hopeless) → circuit breaker (opens after 5 consecutive failures,
fail-fast `CircuitOpenError`, half-open trial after cooldown — no hammering a
downed government portal) → retries with exponential backoff + jitter on
network errors / HTTP 408/425/429/5xx (`Retry-After` honored). App-level 4xx
errors are **not** retried — fail loud. Breaker transitions and retry
exhaustion land in `logs/erp_system.log`. Self-test:
`node scripts\erp_api_shield.cjs --self-test`.

Suggested adoption (not yet wired — each is a live-code change for review):
`toll-sync.cjs` GTROPY calls, `email-parser.cjs` IMAP fetch, future
Vahan/E-Way integrations.

## Observability

- `logs/erp_system.log` — every lifecycle event (JSONL, boot_book schema).
- MAMTA `boot_book.log` — HEALER_START / HEAL_PROPOSED / HEAL_APPLIED /
  HEAL_DISCARDED / HEAL_ROLLBACK summaries (agent `prasad-erp-healer`), so the
  MAMTA UI `/boot_book` drill-down shows ERP heals next to trading-side heals.
- `logs/erp_heal_proposals.json` — per-proposal ledger (last 500).
- `logs/.erp_healer_state.json` — offsets, rate windows, signature cooldowns,
  tracked pending proposals.
