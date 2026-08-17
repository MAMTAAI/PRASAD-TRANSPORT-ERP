#!/usr/bin/env node
/**
 * Bump android/version.properties.
 *
 *   node scripts/bump-android-version.cjs            # patch: 1.0.1 -> 1.0.2
 *   node scripts/bump-android-version.cjs minor      # 1.0.1 -> 1.1.0
 *   node scripts/bump-android-version.cjs major      # 1.0.1 -> 2.0.0
 *   node scripts/bump-android-version.cjs --code-only
 *
 * VERSION_CODE always goes up by one, whatever the name does, because Play
 * rejects a reused code permanently - even for a release that was discarded
 * before rollout. Editing this file by hand is how you get two builds claiming
 * the same code and only find out after the upload.
 *
 * Comments are preserved: the file is rewritten line by line, not re-serialised
 * from a parsed object.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'android', 'version.properties');

const args = process.argv.slice(2);
const codeOnly = args.includes('--code-only');
const part = args.find((a) => ['major', 'minor', 'patch'].includes(a)) || 'patch';

if (!fs.existsSync(FILE)) {
  console.error(`[bump] ${FILE} not found - it is tracked in git, restore it rather than recreating it.`);
  process.exit(1);
}

const lines = fs.readFileSync(FILE, 'latin1').split(/\r?\n/);

let oldCode = null;
let oldName = null;
for (const line of lines) {
  const m = /^\s*VERSION_CODE\s*=\s*(.+?)\s*$/.exec(line);
  if (m) oldCode = m[1];
  const n = /^\s*VERSION_NAME\s*=\s*(.+?)\s*$/.exec(line);
  if (n) oldName = n[1];
}

if (oldCode === null || oldName === null) {
  console.error('[bump] VERSION_CODE or VERSION_NAME missing from version.properties.');
  process.exit(1);
}

const codeNum = Number.parseInt(oldCode, 10);
if (!Number.isInteger(codeNum) || codeNum < 1) {
  console.error(`[bump] VERSION_CODE is not a positive integer: ${oldCode}`);
  process.exit(1);
}
const newCode = codeNum + 1;

let newName = oldName;
if (!codeOnly) {
  const seg = oldName.split('.').map((s) => Number.parseInt(s, 10));
  if (seg.length !== 3 || seg.some((s) => !Number.isInteger(s))) {
    console.error(`[bump] VERSION_NAME is not major.minor.patch: ${oldName}`);
    process.exit(1);
  }
  let [maj, min, pat] = seg;
  if (part === 'major') { maj += 1; min = 0; pat = 0; }
  else if (part === 'minor') { min += 1; pat = 0; }
  else { pat += 1; }
  newName = `${maj}.${min}.${pat}`;
}

const out = lines.map((line) => {
  if (/^\s*VERSION_CODE\s*=/.test(line)) return `VERSION_CODE=${newCode}`;
  if (/^\s*VERSION_NAME\s*=/.test(line)) return `VERSION_NAME=${newName}`;
  return line;
});

fs.writeFileSync(FILE, out.join('\n'), 'latin1');

console.log(`[bump] versionCode ${codeNum} -> ${newCode}`);
console.log(`[bump] versionName ${oldName} -> ${newName}${codeOnly ? ' (unchanged, --code-only)' : ''}`);
