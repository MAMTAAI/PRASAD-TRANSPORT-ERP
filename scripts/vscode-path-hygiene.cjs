#!/usr/bin/env node
// =============================================================================
// VS CODE PATH HYGIENE  (ASCII only - project rule)
//
// Clears dead and foreign-drive entries out of VS Code's own state so that
// File > Open Recent, the window restore list and the per-workspace caches stop
// offering paths that moved. After the 2026-08-18 consolidation the editor still
// listed nine E: folders and a deleted F:\prasad-erp.
//
// Drive rule (God rule 2026-08-15): C: is OS + Ollama only, F: is Prasad,
// H: is Jaiswal. So an entry is removed when EITHER
//   a) its target no longer exists on disk, or
//   b) it sits on C: or E:.
// VS Code's own state under AppData\...\Code\ is exempt from (b): the editor
// keeps untitled workspaces and agent-session files there by design, and they
// are tool state, not project data.
//
// WHY IT REFUSES TO RUN WHILE CODE IS OPEN
// VS Code holds state.vscdb open in WAL mode and rewrites storage.json from
// memory when it exits. Editing either one under a live editor is at best
// undone on close and at worst a corrupted database. The guard is the feature.
//
//   node scripts/vscode-path-hygiene.cjs --dry-run    # report only (default)
//   node scripts/vscode-path-hygiene.cjs --apply      # make the changes
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const CODE_USER = path.join(process.env.APPDATA || '', 'Code', 'User');
const GLOBAL_STORAGE = path.join(CODE_USER, 'globalStorage');
const STORAGE_JSON = path.join(GLOBAL_STORAGE, 'storage.json');
const STATE_DB = path.join(GLOBAL_STORAGE, 'state.vscdb');
const WORKSPACE_STORAGE = path.join(CODE_USER, 'workspaceStorage');

// VS Code keeps legitimate internal state under its own user-data dir.
const CODE_OWN_DIR = path.join(process.env.APPDATA || '', 'Code').toLowerCase();

function codeIsRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Code.exe" /NH', { encoding: 'utf8' });
    return /Code\.exe/i.test(out);
  } catch { return false; }
}

// file:///e%3A/foo/bar -> E:\foo\bar   (returns null for non-file URIs)
function uriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:///')) return null;
  let p = decodeURIComponent(uri.slice('file:///'.length));
  p = p.replace(/\//g, path.sep);
  return /^[A-Za-z]:/.test(p) ? p : null;
}

// A verdict of null means "keep".
function verdict(uri) {
  const p = uriToPath(uri);
  if (!p) return null;
  const lower = p.toLowerCase();
  if (lower.startsWith(CODE_OWN_DIR)) {
    // VS Code's own state: only drop it if the file is genuinely gone.
    return fs.existsSync(p) ? null : 'missing';
  }
  const drive = p[0].toUpperCase();
  if (drive === 'C' || drive === 'E') return 'foreign-drive';
  if (!fs.existsSync(p)) return 'missing';
  return null;
}

function entryUri(e) {
  if (!e || typeof e !== 'object') return null;
  return e.folderUri || e.fileUri ||
         (e.workspace && e.workspace.configPath) ||
         e.configURIPath || e.folder || null;
}

const removed = { workspaceStorage: [], storageJson: [], terminalDirs: [] };

// ---- 1. workspaceStorage/<hash>/ -------------------------------------------
function sweepWorkspaceStorage() {
  if (!fs.existsSync(WORKSPACE_STORAGE)) return;
  for (const dir of fs.readdirSync(WORKSPACE_STORAGE)) {
    const full = path.join(WORKSPACE_STORAGE, dir);
    const meta = path.join(full, 'workspace.json');
    if (!fs.existsSync(meta)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { continue; }
    const uri = j.folder || j.workspace || j.configuration;
    const v = verdict(uri);
    if (!v) continue;
    removed.workspaceStorage.push({ dir, uri, why: v });
    if (APPLY) fs.rmSync(full, { recursive: true, force: true });
  }
}

// ---- 2. storage.json: backupWorkspaces + windowsState ----------------------
function sweepStorageJson() {
  if (!fs.existsSync(STORAGE_JSON)) return;
  const raw = fs.readFileSync(STORAGE_JSON, 'utf8');
  const j = JSON.parse(raw);

  const filterList = (list, label) => {
    if (!Array.isArray(list)) return list;
    return list.filter(e => {
      const v = verdict(entryUri(e));
      if (v) removed.storageJson.push({ label, uri: entryUri(e), why: v });
      return !v;
    });
  };

  if (j.backupWorkspaces) {
    for (const k of ['folders', 'workspaces', 'emptyWindows']) {
      j.backupWorkspaces[k] = filterList(j.backupWorkspaces[k], 'backupWorkspaces.' + k);
    }
  }
  if (j.windowsState && Array.isArray(j.windowsState.openedWindows)) {
    j.windowsState.openedWindows = filterList(j.windowsState.openedWindows, 'windowsState.openedWindows');
  }
  if (Array.isArray(j.profileAssociations && j.profileAssociations.workspaces)) {
    j.profileAssociations.workspaces = filterList(j.profileAssociations.workspaces, 'profileAssociations');
  } else if (j.profileAssociations && j.profileAssociations.workspaces) {
    // object keyed by URI
    for (const key of Object.keys(j.profileAssociations.workspaces)) {
      const v = verdict(key);
      if (v) {
        removed.storageJson.push({ label: 'profileAssociations', uri: key, why: v });
        if (APPLY) delete j.profileAssociations.workspaces[key];
      }
    }
  }

  if (APPLY) {
    fs.writeFileSync(STORAGE_JSON + '.bak', raw);
    fs.writeFileSync(STORAGE_JSON, JSON.stringify(j, null, '\t'));
  }
}

// ---- 3. state.vscdb: terminal cwd history ---------------------------------
function sweepStateDb() {
  let Database;
  try {
    Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  } catch { return { skipped: 'better-sqlite3 not installed' }; }
  if (!fs.existsSync(STATE_DB)) return { skipped: 'state.vscdb not found' };

  const db = new Database(STATE_DB, { readonly: !APPLY, fileMustExist: true });
  const KEY = 'terminal.history.entries.dirs';
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(KEY);
  if (!row) { db.close(); return { skipped: KEY + ' absent' }; }

  let parsed;
  try { parsed = JSON.parse(row.value); } catch { db.close(); return { skipped: 'unparseable' }; }
  const list = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(list)) { db.close(); return { skipped: 'unexpected shape' }; }

  // Shape is { entries: [ { key: "E:\\path", value: {} }, ... ] } - the path
  // lives on .key, not .value. Reading .value silently matches nothing.
  const kept = list.filter(item => {
    const p = typeof item === 'string' ? item : (item && (item.key || item.value));
    if (typeof p !== 'string' || !/^[A-Za-z]:/.test(p)) return true;
    const drive = p[0].toUpperCase();
    const bad = drive === 'C' || drive === 'E' ? 'foreign-drive'
              : !fs.existsSync(p) ? 'missing' : null;
    if (bad && !p.toLowerCase().startsWith(CODE_OWN_DIR)) {
      removed.terminalDirs.push({ path: p, why: bad });
      return false;
    }
    return true;
  });

  if (APPLY && removed.terminalDirs.length) {
    const out = Array.isArray(parsed) ? kept : Object.assign({}, parsed, { entries: kept });
    db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(JSON.stringify(out), KEY);
  }
  db.close();
  return { before: list.length, after: kept.length };
}

// ---- run -------------------------------------------------------------------
if (APPLY && codeIsRunning()) {
  console.error('REFUSING: Code.exe is running.');
  console.error('VS Code rewrites storage.json from memory on exit and holds state.vscdb');
  console.error('open in WAL mode, so changes made now are undone at best. Close VS Code');
  console.error('completely, then run this again with --apply.');
  process.exit(2);
}

sweepWorkspaceStorage();
sweepStorageJson();
const dbResult = sweepStateDb();

const mode = APPLY ? 'APPLIED' : 'DRY RUN - nothing changed';
console.log('=== VS CODE PATH HYGIENE (' + mode + ') ===\n');

const section = (title, rows, fmt) => {
  console.log(title + ': ' + rows.length);
  for (const r of rows) console.log('   ' + fmt(r));
  if (rows.length) console.log('');
};
section('workspaceStorage dirs', removed.workspaceStorage,
        r => '[' + r.why + '] ' + (uriToPath(r.uri) || r.uri) + '   (' + r.dir + ')');
section('storage.json entries', removed.storageJson,
        r => '[' + r.why + '] ' + r.label + ' -> ' + (uriToPath(r.uri) || r.uri));
section('terminal cwd history', removed.terminalDirs,
        r => '[' + r.why + '] ' + r.path);

if (dbResult && dbResult.skipped) console.log('state.vscdb: skipped (' + dbResult.skipped + ')');
else if (dbResult) console.log('state.vscdb terminal dirs: ' + dbResult.before + ' -> ' + dbResult.after);

const total = removed.workspaceStorage.length + removed.storageJson.length + removed.terminalDirs.length;
console.log('\nTOTAL: ' + total + ' stale entries' + (APPLY ? ' removed.' : ' would be removed.'));
if (!APPLY && total) console.log('Close VS Code, then: node scripts/vscode-path-hygiene.cjs --apply');
