// server/ai_engine/journal.js
// ─────────────────────────────────────────────────────────────────────────────
// Graph execution journal — one JSON line per invoke.
//
// Writes under LOG_DIR (set by server/config/init_drives.js — the F: volume
// on the office PC, repo-local logs/ on AWS), never the OS drive. Journaling
// must never take down event processing: every failure here is swallowed
// after one console warning.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let dir = null;
let warned = false;

function journalDir() {
  if (dir) return dir;
  const base = process.env.LOG_DIR?.trim() || join(process.cwd(), 'logs');
  dir = join(base, 'ai_engine');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append one graph run to today's journal file. */
export function journal(entry) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(journalDir(), `graph-${day}.jsonl`), JSON.stringify(entry) + '\n');
  } catch (err) {
    if (!warned) { warned = true; console.warn(`[ai_engine] journal disabled: ${err.message}`); }
  }
}
