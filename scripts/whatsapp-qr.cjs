#!/usr/bin/env node
/**
 * scripts/whatsapp-qr.cjs - live WhatsApp linking QR in this terminal.
 *
 * WHY THIS EXISTS. The engine's QR rotates every ~20s, so a QR pasted into a
 * chat or a screenshot is expired before it can be scanned. This polls the
 * local engine and RE-DRAWS the code whenever it changes, so whatever is on
 * screen is always the current one. It exits by itself the moment the phone
 * links.
 *
 * The QR is a login credential for the company WhatsApp - it is rendered
 * locally and never sent anywhere.
 *
 *   node scripts/whatsapp-qr.cjs
 */
const path = require('path');
const ENGINE = process.env.WA_ENGINE_URL || 'http://127.0.0.1:5001';

// qrcode-terminal lives in the engine's own node_modules, not the repo root.
let qrcode;
try {
  qrcode = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'qrcode-terminal'));
} catch {
  try { qrcode = require('qrcode-terminal'); }
  catch { console.error('qrcode-terminal not installed'); process.exit(1); }
}

let lastQr = null;
let tries = 0;

async function tick() {
  let s;
  try {
    const res = await fetch(`${ENGINE}/api/status`, { signal: AbortSignal.timeout(6000) });
    s = await res.json();
  } catch (e) {
    if (tries++ % 10 === 0) console.log(`\n  waiting for engine on ${ENGINE} ... (${e.message})`);
    return;
  }

  if (s.connected) {
    console.clear();
    console.log('\n\n   ================================================');
    console.log('     WHATSAPP LINKED SUCCESSFULLY');
    console.log('   ================================================');
    console.log(`\n     status : ${s.status}`);
    console.log('     OTP login is now live for drivers and portals.\n');
    process.exit(0);
  }

  if (s.qr && s.qr !== lastQr) {
    lastQr = s.qr;
    console.clear();
    console.log('\n   PRASAD TRANSPORT - LINK WHATSAPP');
    console.log('   ---------------------------------------------------');
    console.log('   Phone > WhatsApp > Settings > Linked Devices >');
    console.log('   "Link a device"  -- then scan the square below.\n');
    qrcode.generate(s.qr, { small: true });
    console.log(`   refreshed ${new Date().toLocaleTimeString()} - this code`);
    console.log('   redraws by itself; always scan the newest one.');
    console.log('   (Ctrl+C to close)\n');
  }
}

console.log('starting WhatsApp QR watcher...');
tick();
setInterval(tick, 3000);
