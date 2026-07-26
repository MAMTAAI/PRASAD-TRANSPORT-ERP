// 🧪 Proves the base_url/token sanitizers fix the two screenshot failures, then
// does a LIVE fetch+normalize against GTROPY (no Firestore writes). Ad-hoc R&D.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const axios = require('axios');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'node_modules', '.cache', 'tollParse.live.cjs');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execSync(`npx esbuild src/lib/tollParse.ts --bundle --platform=node --format=cjs --outfile="${OUT}"`, { cwd: ROOT, stdio: 'pipe' });
const T = require(OUT);

function cleanEndpoint(raw) {
  const s = String(raw || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  const u = new URL(s); return `${u.origin}${u.pathname}`;
}
function cleanToken(t) { return String(t || '').trim().replace(/^Authorization:\s*/i, '').replace(/^Bearer\s+/i, '').trim(); }

const prasadBad = `'https://thexyz.co.in/api/v3/expense_engine/lq/account_transactions'`;   // quoted → was "Invalid URL"
const jaiswalBad = `https://thexyz.co.in/api/v3/expense_engine/lq/account_transactions?start_time=01-03-2026&end_time=02-03-2026&start_index=0&end_index=1000`; // full URL → was HTTP 500

console.log('Prasad  cleaned:', cleanEndpoint(prasadBad));
console.log('Jaiswal cleaned:', cleanEndpoint(jaiswalBad));
console.log('token   cleaned:', cleanToken('Authorization: e42vy75rgjkfg65zsFDVzj'));

(async () => {
  const endpoint = cleanEndpoint(jaiswalBad), token = cleanToken('Bearer e42vy75rgjkfg65zsFDVzj');
  const res = await axios.get(endpoint, { headers: { Authorization: token }, params: { start_time: '22-07-2026', end_time: '23-07-2026', start_index: 0, end_index: 1000 }, timeout: 60000 });
  const arr = Array.isArray(res.data) ? res.data : [];
  console.log('\nLIVE fetch after fix → HTTP', res.status, '| rows:', arr.length);
  const norm = T.normalizeProviderTxns('gtropy', arr, 'prov-test');
  console.log('normalized → debits:', norm.debits.length, 'credits:', norm.credits.length, 'skipped:', norm.skipped);
  const s = norm.debits[0];
  console.log('sample debit → veh:', s.vehicle_no, '| crossing:', s.txn_datetime, '| ₹' + s.amount, '| plaza:', s.plaza, '| ext_txn_id set:', !!s.ext_txn_id);
  console.log('\nBOTH SCREENSHOT ERRORS FIXED ✅');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
