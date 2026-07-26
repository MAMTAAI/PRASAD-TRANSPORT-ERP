#!/usr/bin/env node
/**
 * 🕸️ KG SYNC — TRANSPORT DOMAIN (read-only on Firestore)
 * Reads VEHICLES / DRIVERS / CUSTOMERS / TRIPS and pushes nodes+edges to the
 * MAMTA KG on the AWS bridge (/api/kg/upsert). Re-runnable any time — upserts
 * are idempotent; trip counts become edge weights.
 *
 * Schema produced:
 *   truck —driven_by→ driver          (from TRIPS, weight = trip count)
 *   driver —delivers_to→ client       (from TRIPS)
 *   truck —hauls_for→ client          (from TRIPS)
 *   truck —loads_at→ location         (from TRIPS.Loading_Point)
 *
 * Usage:  node scripts/kg-sync-transport.cjs
 * Env:    KG_BRIDGE_URL (default https://prasadtransport.com/ai)
 */
require('dotenv').config();
const path = require('path');
const axios = require('axios');

const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));
const serviceAccount = require(path.join(__dirname, '..', 'whatsapp-server', 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const BRIDGE = (process.env.KG_BRIDGE_URL || 'https://prasadtransport.com/ai').replace(/\/+$/, '');
const TOKEN = process.env.VITE_LLM_AUTH_TOKEN || '';
const DOMAIN = 'transport';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

(async () => {
  const [vehicles, drivers, customers, trips] = await Promise.all(
    ['VEHICLES', 'DRIVERS', 'CUSTOMERS', 'TRIPS'].map((c) => db.collection(c).get()),
  );
  console.log(`Firestore: ${vehicles.size} vehicles, ${drivers.size} drivers, ${customers.size} customers, ${trips.size} trips`);

  const nodes = [];
  for (const d of vehicles.docs) {
    const v = d.data();
    const no = clean(v.Vehicle_No || v.vehicle_no || d.id);
    if (no) nodes.push({ type: 'truck', name: no.toUpperCase(), domain: DOMAIN });
  }

  // First-name aliases only when unique among drivers (avoid wrong matches)
  const firstCount = {};
  for (const d of drivers.docs) {
    const first = clean(d.data().name).split(' ')[0].toLowerCase();
    if (first.length >= 4) firstCount[first] = (firstCount[first] || 0) + 1;
  }
  for (const d of drivers.docs) {
    const v = d.data();
    const name = clean(v.name);
    if (!name) continue;
    const first = name.split(' ')[0].toLowerCase();
    nodes.push({
      type: 'driver', name: name.toUpperCase(), domain: DOMAIN,
      props: { mobile: v.mobile || '', license_no: v.license_no || '', license_expiry: v.license_expiry || '' },
      aliases: first.length >= 4 && firstCount[first] === 1 ? [first] : [],
    });
  }
  for (const d of customers.docs) {
    const v = d.data();
    const name = clean(v.customer_name);
    if (name) nodes.push({ type: 'client', name: name.toUpperCase(), domain: DOMAIN, props: { state: v.state || '', gst_no: v.gst_no || '' } });
  }

  // Aggregate trips into weighted edges
  const w = new Map(); // key -> {src,rel,dst,count}
  const bump = (st, sn, rel, dt, dn) => {
    sn = clean(sn).toUpperCase(); dn = clean(dn).toUpperCase();
    if (!sn || !dn) return;
    const k = `${st}|${sn}|${rel}|${dt}|${dn}`;
    const e = w.get(k) || { src: { type: st, name: sn }, rel, dst: { type: dt, name: dn }, domain: DOMAIN, weight: 0 };
    e.weight++; w.set(k, e);
  };
  for (const d of trips.docs) {
    const t = d.data();
    const truck = t.Vehical_No || t.vehicle_no;
    const driver = t.Driver_Name || t.driver_name;
    const client = t.Customer || t.customer_name;
    const point = t.Loading_Point || t.loading_point;
    if (truck && driver) bump('truck', truck, 'driven_by', 'driver', driver);
    if (driver && client) bump('driver', driver, 'delivers_to', 'client', client);
    if (truck && client) bump('truck', truck, 'hauls_for', 'client', client);
    if (truck && point) bump('truck', truck, 'loads_at', 'location', point);
  }
  const edges = [...w.values()];
  console.log(`Prepared ${nodes.length} nodes, ${edges.length} weighted edges. Pushing to ${BRIDGE} ...`);

  const post = (payload) => axios.post(`${BRIDGE}/api/kg/upsert`, payload, {
    headers: { 'X-PT-Token': TOKEN, 'Content-Type': 'application/json' }, timeout: 60000,
  });
  for (let i = 0; i < nodes.length; i += 500) await post({ nodes: nodes.slice(i, i + 500) });
  for (let i = 0; i < edges.length; i += 500) await post({ edges: edges.slice(i, i + 500) });

  const stats = await axios.get(`${BRIDGE}/api/kg/stats`, { headers: { 'X-PT-Token': TOKEN }, timeout: 30000 });
  console.log('✅ Sync done. KG stats:', JSON.stringify(stats.data));
  process.exit(0);
})().catch((e) => { console.error('❌ Sync failed:', e.response?.data || e.message); process.exit(1); });
