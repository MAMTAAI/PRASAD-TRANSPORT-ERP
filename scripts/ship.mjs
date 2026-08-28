// scripts/ship.mjs
// ─────────────────────────────────────────────────────────────────────────────
// "Is production actually running what we wrote?" — and, deliberately, shipping.
//
//   node scripts/ship.mjs            what is on main, what is not, is the box current
//   node scripts/ship.mjs --watch    the same, live, refreshing until you stop it
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
// AND THE GAUGE USED TO STOP ONE HOP SHORT. Everything above is read from git:
// this checkout, origin/main, origin/upgrade-2026. All three can agree while the
// box serves something else entirely — which is not a hypothetical, it is what
// happened from 20-08 to 27-08, when a file mode made `git merge --ff-only` fail
// on the box every three minutes and every push still reported success. Git
// cannot see that. So the report now asks the machine itself what it is running,
// and the answer is the last line of the chain that starts in the editor:
//
//     VS Code (F:) → commit → origin/upgrade-2026 → [gate] → origin/main
//                                                          → cron → AWS box
//
// --release still writes PRASAD_DEPLOY_APPROVED=1 rather than hiding it: the
// variable's purpose is that releasing is a sentence somebody chose to write,
// and `node scripts/ship.mjs --release` is no more typeable by accident than
// the variable was. What it removes is the fiddly part people get wrong —
// remembering to fast-forward main first, and getting the env var syntax right
// on a shell that is cmd.exe half the time.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const WORK_BRANCH = 'upgrade-2026';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const releasing = process.argv.includes('--release');
const watching = process.argv.includes('--watch');
const WATCH_EVERY_MS = 30_000;

// ── THE BOX ──────────────────────────────────────────────────────────────────
// Read over SSH rather than through a new HTTP endpoint on purpose: the key is
// already on this PC and already the way in, so this adds no server surface, no
// second secret and nothing new to keep in sync. Overridable because the host
// moved once already (20-08) and every piece of config that hardcoded the old
// one failed silently when it did.
const BOX = process.env.PRASAD_BOX || 'ubuntu@65.0.27.161';
const KEY = process.env.PRASAD_SSH_KEY || path.join(os.homedir(), '.ssh', 'prasad-key.pem');
const APP_DIR = '/var/www/prasad-erp';

// One round trip, printed as key=value so a subject line containing anything at
// all cannot be mistaken for another field.
const REMOTE = [
  `cd ${APP_DIR} 2>/dev/null || exit 3`,
  // BOTH CUT TO SEVEN, AND THAT IS NOT COSMETIC. `git rev-parse --short` picks
  // its own length — it answered 8 here while the stamp file holds 7 — so
  // comparing them raw reports a half-finished deploy on a box that is
  // perfectly healthy. The gauge crying wolf is how gauges get ignored.
  'echo sha=$(cut -c1-7 .last-deployed-sha 2>/dev/null)',
  'echo head=$(git rev-parse HEAD 2>/dev/null | cut -c1-7)',
  'echo deploying=$(pgrep -af "[c]i-deploy" >/dev/null && echo yes || echo no)',
  'echo online=$(pm2 jlist 2>/dev/null | grep -o "\\"status\\":\\"online\\"" | wc -l)',
  'echo subject=$(git log -1 --format=%s 2>/dev/null)',
].join('; ');

/** Never throws. An unreachable box is a fact to report, not a crash — this is
 *  the tool you run BECAUSE something looks wrong. */
function readBox() {
  try {
    const out = execFileSync('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new',
      '-i', KEY, BOX, REMOTE,
    ], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const box = {};
    for (const line of out.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) box[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return box.sha || box.head ? box : { error: 'box answered but said nothing' };
  } catch (e) {
    const why = /ENOENT/.test(e.message) ? 'no ssh client on PATH'
      : e.signal === 'SIGTERM' ? 'timed out'
        : (e.stderr || e.message || '').toString().trim().split('\n')[0] || 'unreachable';
    return { error: why };
  }
}

function report() {
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

  // THE LAST HOP. Reported next to the git lines because the whole point is the
  // comparison: origin/main is what we asked for, this is what is answering.
  const box = readBox();
  if (box.error) {
    console.log(`AWS box         ⚠  ${box.error}`);
  } else {
    const behind = box.sha && box.sha !== mainSha;
    const mark = box.deploying === 'yes' ? '⏳' : behind ? '⚠ ' : '●';
    console.log(`AWS box         ${mark} ${box.sha || '?'}   ${box.subject || ''}`);
    const notes = [];
    // A deploy in flight explains a stale sha, so say so before it reads as a
    // fault. Three minutes is the cron interval, not a promise.
    if (box.deploying === 'yes') notes.push('deploy running now');
    else if (behind) notes.push(`behind origin/main — cron picks it up within 3 min`);
    if (box.head && box.sha && box.head !== box.sha) {
      // The stamp is written only by a deploy that finished. A checkout ahead of
      // its own stamp is a deploy that died in the middle, which retries — and
      // which you would otherwise read as "it landed".
      notes.push(`checkout at ${box.head} but last COMPLETED deploy is ${box.sha}`);
    }
    if (box.online && Number(box.online) < 4) notes.push(`only ${box.online}/4 pm2 apps online`);
    for (const n of notes) console.log(`                ${n}`);
  }
  console.log('');

  // COMMITTED HERE BUT NOT PUSHED ANYWHERE.
  //
  // The comparison above is remote-to-remote, so work that exists only in this
  // checkout is invisible to it — and it reported "nothing waiting" while two
  // finished commits sat on the local branch. That is the same blind spot this
  // tool was written to close, one step earlier in the chain: the gauge has to
  // cover the whole path from `git commit` to the box, not just the last leg.
  const unpushed = git('log', '--oneline', `origin/${WORK_BRANCH}..HEAD`);
  const unpushedList = unpushed ? unpushed.split('\n') : [];
  if (unpushedList.length) {
    console.log(`⚠  ${unpushedList.length} commit(s) not pushed anywhere yet:\n`);
    for (const line of unpushedList) console.log('   ' + line);
    console.log(`\n   git push origin ${here}\n`);
  }

  if (!list.length && !unpushedList.length) {
    console.log('✅ Nothing waiting — production is running everything on ' + WORK_BRANCH + '.');
  } else if (!list.length) {
    console.log('Nothing released is missing, but the commits above are only on this machine.');
  } else {
    console.log(`⚠  ${list.length} commit(s) finished but NOT on production:\n`);
    for (const line of list) console.log('   ' + line);
    console.log('');
    if (!releasing) {
      console.log('Committing does not deploy. To release these:');
      console.log('   node scripts/ship.mjs --release');
    }
  }
  return list;
}

// ── WATCH ────────────────────────────────────────────────────────────────────
// A terminal that answers "has it landed yet" without being asked. The old
// Terminal C ran this once at folderOpen and then sat there going stale for the
// rest of the day, which is worse than no gauge: it looked current.
if (watching) {
  const tick = () => {
    process.stdout.write('\x1B[2J\x1B[H');
    console.log(`PRASAD ERP — F: → git → AWS      (refreshes every ${WATCH_EVERY_MS / 1000}s, Ctrl+C to stop)`);
    console.log('─'.repeat(72));
    try { report(); } catch (e) { console.log('⚠  ' + (e.message || e)); }
    console.log('');
    console.log(`updated ${new Date().toLocaleTimeString()}`);
  };
  tick();
  setInterval(tick, WATCH_EVERY_MS);
} else {
  const list = report();

  if (releasing) {
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
    console.log('   Watch it land:  npm run ship:watch');
    console.log('   prasad-wa-engine restarts too, but only when whatsapp-server/ changed.');
  }
}
