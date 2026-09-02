// scripts/check-undefined-refs.mjs
// ─────────────────────────────────────────────────────────────────────────────
// THE CHECK THAT WOULD HAVE CAUGHT THE BLANK DASHBOARD.
//
// On 2026-09-02 the whole Operations tab went white with
// `ReferenceError: ShieldAlert is not defined`. A dead mock table still named
// three lucide icons at module level after they were dropped from the import.
// Nothing in this repo saw it:
//
//   · the file carries `// @ts-nocheck`, so tsc looked away — and 40+ files
//     in src/ carry it, which is the real size of the blind spot;
//   · esbuild does not resolve free identifiers, so `npm run build` passed;
//   · eslint's no-undef is off for TypeScript (typescript-eslint disables it,
//     correctly, because tsc normally does that job — except where nocheck).
//
// So a free identifier could reach production in any @ts-nocheck file and the
// only test that would fail was opening the page.
//
// This is that test, made cheap: parse every source file, resolve every
// identifier against its scopes, and fail on anything that is neither declared,
// imported, nor a known global. Run by `npm run check:refs`.
// ─────────────────────────────────────────────────────────────────────────────
import { Linter } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROOTS = ['src', 'server', 'whatsapp-server'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'android', 'ios']);
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

const linter = new Linter({ configType: 'flat' });
// AN ARRAY WITH AN EXPLICIT `files` GLOB, AND THAT IS NOT A DETAIL. Passing a
// bare config object to a flat-config Linter makes verify() answer
// "No matching configuration found for <file>" for every path — one message
// that is not a no-undef, so a filter looking for no-undef finds nothing and
// the check reports a clean sweep having checked nothing at all. Caught by
// running it against a file with two known undefined identifiers in it.
const config = [{
  files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: {
      ...globals.browser, ...globals.node, ...globals.es2021,
      // Ambient TypeScript names the parser reports as identifiers.
      React: 'readonly', JSX: 'readonly', NodeJS: 'readonly',
      RequestInit: 'readonly', RequestInfo: 'readonly', HeadersInit: 'readonly',
      BodyInit: 'readonly', ResponseInit: 'readonly', BufferEncoding: 'readonly',
    },
  },
  rules: { 'no-undef': 'error' },
}];

let failed = 0;
let scanned = 0;
const findings = [];

for (const root of ROOTS) {
  const dir = path.join(ROOT, root);
  try { statSync(dir); } catch { continue; }
  for (const file of walk(dir)) {
    scanned++;
    let code;
    try { code = readFileSync(file, 'utf8'); } catch { continue; }
    let messages;
    try { messages = linter.verify(code, config, file); }
    catch { continue; }            // a parse failure is tsc's business, not ours
    for (const m of messages) {
      // A config that matches nothing is the failure mode this whole script
      // nearly shipped with. Never skip it quietly.
      if (m.ruleId === null && /No matching configuration/i.test(m.message)) {
        failed++;
        findings.push(`${path.relative(ROOT, file)}  CHECK DID NOT RUN — ${m.message}`);
        continue;
      }
      if (m.ruleId !== 'no-undef') continue;
      failed++;
      findings.push(`${path.relative(ROOT, file)}:${m.line}:${m.column}  ${m.message}`);
    }
  }
}

// ── BASELINE ────────────────────────────────────────────────────────────────
// This check was written the day a free identifier blanked the dashboard, and
// it immediately found 31 more that predate it — Firestore calls left behind by
// the Postgres migration (writeBatch, doc, db, increment, updateDoc, deleteDoc)
// plus a handful of genuine scope bugs. None of them are today's work and each
// needs a decision about what the code should do now, so they are RECORDED
// rather than fixed inside a deploy about something else.
//
// The check therefore fails on anything NEW. That is the whole value: it would
// have caught ShieldAlert. Fix a baselined one and the script says so and asks
// you to shrink the list — a baseline that only ever grows is a suppression
// file, which is the opposite of this.
const BASELINE_FILE = path.join(import.meta.dirname, 'undefined-refs.baseline.json');
const norm = (f) => f.replace(/\\\\/g, '/');
let baseline = [];
try { baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).known ?? []; } catch { /* first run */ }

const current = findings.map(norm);

if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE_FILE, JSON.stringify({
    note: 'Pre-existing undefined identifiers. Shrink this list; never grow it.',
    known: current.slice().sort(),
  }, null, 2) + '\n');
  console.log(`check:refs — baseline rewritten with ${current.length} known finding(s)`);
  process.exit(0);
}

const known = new Set(baseline);
const fresh = current.filter((f) => !known.has(f));
const fixed = baseline.filter((f) => !current.includes(f));

console.log(`check:refs — ${scanned} files parsed, ${current.length} undefined identifier(s), ${baseline.length} known`);

if (fixed.length) {
  console.log(`\n${fixed.length} baselined finding(s) are gone — run with --update-baseline to shrink the list:`);
  for (const f of fixed) console.log('  · ' + f);
}

if (!fresh.length) {
  console.log('\n✅ no NEW undefined identifiers\n');
  process.exit(0);
}

console.log(`\n❌ ${fresh.length} NEW undefined identifier(s):\n`);
for (const f of fresh) console.log('  ' + f);
console.log('\nEach throws a ReferenceError the moment that code runs. At MODULE level it\n'
  + 'takes the whole screen down — that is how the Operations tab went blank on\n'
  + '2026-09-02. Inside a function it breaks that feature when somebody uses it.\n');
process.exit(1);
