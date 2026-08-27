// scripts/ship.mjs
// ─────────────────────────────────────────────────────────────────────────────
// "Is production actually running what we wrote?" — and, deliberately, shipping.
//
//   node scripts/ship.mjs            what is on main, what is not, is the box current
//   node scripts/ship.mjs --release  fast-forward main to this branch and release
//
// WHY THIS EXISTS. The pre-push hook stops `main` being pushed by accident,
// because on 16-08-2026 six commits reached production during what everyone
// believed was ordinary committing. It works. But it only guards one direction,
// and on 27-08-2026 the opposite failure showed up: main had not moved since
// 24-08, six commits sat finished on upgrade-2026, and the report from the
// office was "we commit and the system never updates" — which is exactly what
// it looks like from the outside. Nothing was broken. Nothing had been released.
//
// A gate with no gauge is half a mechanism. This is the gauge.
//
// --release still writes PRASAD_DEPLOY_APPROVED=1 rather than hiding it: the
// variable's purpose is that releasing is a sentence somebody chose to write,
// and `node scripts/ship.mjs --release` is no more typeable by accident than
// the variable was. What it removes is the fiddly part people get wrong —
// remembering to fast-forward main first, and getting the env var syntax right
// on a shell that is cmd.exe half the time.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';

const WORK_BRANCH = 'upgrade-2026';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const releasing = process.argv.includes('--release');

// Always read the remote first. A stale origin/main is how you conclude the
// pipeline is broken when in fact you are the one who has not looked.
try { git('fetch', 'origin', '--quiet'); } catch { console.warn('⚠  could not reach origin — showing local knowledge only\n'); }

const here = git('rev-parse', '--abbrev-ref', 'HEAD');
const mainSha = git('rev-parse', '--short', 'origin/main');
const workSha = git('rev-parse', '--short', `origin/${WORK_BRANCH}`);
const pending = git('log', '--oneline', `origin/main..origin/${WORK_BRANCH}`);
const list = pending ? pending.split('\n') : [];

console.log(`branch          ${here}`);
console.log(`origin/main     ${mainSha}   ${git('log', '-1', '--format=%s', 'origin/main')}`);
console.log(`origin/${WORK_BRANCH} ${workSha}`);
console.log(`last released   ${git('log', '-1', '--format=%ad', '--date=format:%d %b %Y %H:%M', 'origin/main')}`);
console.log('');

if (!list.length) {
  console.log('✅ Nothing waiting — production is running everything on ' + WORK_BRANCH + '.');
} else {
  console.log(`⚠  ${list.length} commit(s) finished but NOT on production:\n`);
  for (const line of list) console.log('   ' + line);
  console.log('');
  if (!releasing) {
    console.log('Committing does not deploy. To release these:');
    console.log('   node scripts/ship.mjs --release');
  }
}

if (!releasing) process.exit(0);

if (!list.length) { console.log('\nNothing to release.'); process.exit(0); }

// Fast-forward only. The box runs `git merge --ff-only origin/main`, so a main
// that is not a straight continuation of the work branch would leave the deploy
// wedged with no way forward except a human on the machine.
console.log('\n→ fast-forwarding main to ' + WORK_BRANCH);
git('branch', '-f', 'main', `origin/${WORK_BRANCH}`);

console.log('→ releasing to production');
execFileSync('git', ['push', 'origin', 'main'], {
  stdio: 'inherit',
  env: { ...process.env, PRASAD_DEPLOY_APPROVED: '1' },
});

console.log('\n✅ Pushed. The AWS box pulls every 3 minutes, then migrates and restarts.');
console.log('   Watch it land:  node scripts/ship.mjs');
console.log('   prasad-wa-engine restarts too, but only when whatsapp-server/ changed.');
