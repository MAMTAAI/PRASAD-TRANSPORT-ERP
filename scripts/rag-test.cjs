// Proof: real ERP data → nomic embeddings → cosine retrieval → Gemma grounded answer.
const fs = require('fs');
const OLLAMA = 'http://localhost:11434';

const g = (o, keys) => {
  for (const k of keys) {
    const hit = Object.keys(o || {}).find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (hit && o[hit] != null && String(o[hit]).trim() !== '') return String(o[hit]);
  }
  return '';
};
const tripText = d => `TRIP ${g(d,['trip_id','Trip_ID'])}: vehicle ${g(d,['vehicle_no','Vehical_No'])}, driver ${g(d,['driver_name','Driver_Name'])}, route ${g(d,['loading_point','Loading_Point'])} to ${g(d,['consignee_name','Consignee_Name'])}, status ${g(d,['trip_status','Trip_Status'])||'UNKNOWN'}`.replace(/\s+/g,' ').trim();
const vehText = d => `VEHICLE ${g(d,['Vehicle_No','vehicle_no'])}: owner ${g(d,['owner_name'])}, company ${g(d,['company_name'])}. Validity insurance ${g(d,['insurance_validity'])}, tax ${g(d,['tax_validity'])}, permit ${g(d,['national_permit_validity'])}, pollution ${g(d,['pollution_validity'])}`.replace(/\s+/g,' ').trim();
const drvText = d => `DRIVER ${g(d,['name'])}: mobile ${g(d,['mobile','mobile_no'])}, licence ${g(d,['license_no'])} expiry ${g(d,['license_expiry','dl_expiry_date'])}, status ${g(d,['status','approval_status'])}`.replace(/\s+/g,' ').trim();

async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }) });
  return (await r.json()).embedding;
}
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; } return d / (Math.sqrt(na)*Math.sqrt(nb) || 1); };

(async () => {
  const b = require('../backups/' + fs.readdirSync('./backups').filter(f => f.endsWith('.json')).sort().pop());
  const docs = [];
  Object.values(b.collections.TRIPS).slice(0, 120).forEach(t => docs.push(tripText(t.__data__)));
  Object.values(b.collections.VEHICLES).forEach(v => docs.push(vehText(v.__data__)));
  Object.values(b.collections.DRIVERS).forEach(d => docs.push(drvText(d.__data__)));
  console.log(`Embedding ${docs.length} ERP chunks (120 trips + all vehicles + drivers)…`);

  const t0 = Date.now();
  const vecs = [];
  for (let i = 0; i < docs.length; i++) { vecs.push(await embed(docs[i])); if ((i+1) % 50 === 0) process.stdout.write(`  ${i+1}/${docs.length}\r`); }
  console.log(`\nEmbedded in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const query = process.argv[2] || 'Kaunse vehicles ke documents (insurance/permit) expire hone wale hain?';
  const qv = await embed(query);
  const hits = docs.map((text, i) => ({ text, score: cos(qv, vecs[i]) })).sort((a, b) => b.score - a.score).slice(0, 6);
  console.log(`\nQUERY: ${query}\nTOP RETRIEVED:`);
  hits.forEach((h, i) => console.log(`  [${i+1}] (${h.score.toFixed(3)}) ${h.text.slice(0, 110)}`));

  const context = hits.map((h, i) => `[${i+1}] ${h.text}`).join('\n');
  const sys = 'You are MAMTA AI for PRASAD Transport ERP. Answer ONLY from the ERP context. Be concise. Reply in Hinglish.';
  const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemma4:12b', stream: false, options: { temperature: 0.2 }, messages: [{ role: 'system', content: sys }, { role: 'user', content: `ERP CONTEXT:\n${context}\n\nQUESTION: ${query}` }] }) });
  console.log('\nGEMMA GROUNDED ANSWER:\n' + (await r.json()).message?.content);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
