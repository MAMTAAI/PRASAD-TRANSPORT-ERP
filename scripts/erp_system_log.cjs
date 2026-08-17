// scripts/erp_system_log.cjs
// Shared JSONL lifecycle logger for the PRASAD ERP self-healing layer.
// Row schema mirrors tools/mamta-bridge/boot_book.py `_row` exactly, so the
// same drill-down tooling (and the MAMTA /boot_book endpoint filters) work on
// both books. Two sinks:
//   - logs/erp_system.log            (local ERP book — always written)
//   - MAMTA boot_book.log            (unified book — best-effort, cross-repo;
//                                     a missing jaiswal-terminal checkout must
//                                     never crash the ERP daemons)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Honour LOG_DIR like every other writer here. This one was missed in the
// first pass -- the healer's STATE and its tail sources were repointed at the
// data drive while its lifecycle book kept appending to <repo>/logs, so a
// verified-clean migration still had a live writer on the code drive. Only
// checking what was actually being written afterwards caught it.
const ERP_LOG = path.join(
  process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(ROOT, 'logs'),
  'erp_system.log');
// Defaulted to E:\jaiswal-terminal\Algo-Engine\boot_book.log -- Prasad daemons
// writing their operational log into the trading company's repo. A unified book
// across both businesses is a fine idea, but it cannot be the DEFAULT across a
// company boundary. Unset now means local book only.
const BOOT_BOOK = process.env.MAMTA_BOOT_BOOK || null;

// IST timestamp, ISO-8601 with milliseconds and +05:30 offset (boot_book.py parity).
function istTs() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().replace('Z', '+05:30');
}

function row(agent, event, { cycle = 'erp', leg = null, fail_codes = null,
                             rule_refs = null, extra = null } = {}) {
  return {
    ts: istTs(),
    agent,
    cycle,
    leg,
    event,
    fail_codes: fail_codes || [],
    data_injected: null,
    rule_refs: rule_refs || [],
    approval: null,
    extra: extra || {},
  };
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + '\n', 'utf8');
}

// Local ERP book. Never throws — a logging failure must not kill a daemon.
function slog(agent, event, opts) {
  const line = JSON.stringify(row(agent, event, opts));
  try { appendLine(ERP_LOG, line); } catch { /* disk problem — nothing sane to do */ }
  return line;
}

// Unified book (summary rows only — start/proposed/applied/discarded/rollback).
function bootBook(agent, event, opts) {
  const line = JSON.stringify(row(agent, event, opts));
  if (!BOOT_BOOK) return false;   // no cross-company sink configured
  try { appendLine(BOOT_BOOK, line); return true; } catch { return false; }
}

// Both books in one call, for HITL-relevant milestones.
function slogBoth(agent, event, opts) {
  slog(agent, event, opts);
  bootBook(agent, event, opts);
}

module.exports = { slog, bootBook, slogBoth, istTs, ERP_LOG, BOOT_BOOK, ROOT };
