// Pure-logic test of Mamta memory (embed + cosine recall + dedupe + scope).
// Uses real local Ollama embeddings; no Firestore, no IndexedDB (quota-safe).
const OLLAMA = 'http://localhost:11434';
async function embed(t) {
  const r = await fetch(`${OLLAMA}/api/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'nomic-embed-text', prompt: t }) });
  return (await r.json()).embedding;
}
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); };
const nrm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

(async () => {
  const mem = []; // {text, vector, scope}
  const DEDUPE = 0.92;
  async function remember(text, scope = 'all') {
    const v = await embed(text);
    let best = null;
    for (const m of mem) { const s = cos(v, m.vector); if (!best || s > best.s) best = { m, s }; }
    if (best && best.s >= DEDUPE) { best.m.text = text; best.m.vector = v; return 'updated'; }
    mem.push({ text, vector: v, scope }); return 'added';
  }
  async function recall(query, scopeVal = null, k = 3) {
    const qv = await embed(query);
    // scopeVal === null => admin / 'all' scope: sees everything (mirrors module: scope.type==='all').
    const vis = mem.filter(m => scopeVal === null || m.scope === 'all' || nrm(m.scope) === nrm(scopeVal));
    return vis.map(m => ({ ...m, score: cos(qv, m.vector) })).sort((a, b) => b.score - a.score).slice(0, k);
  }

  let pass = 0, fail = 0; const ok = (n, c) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? pass++ : fail++; };

  console.log('Writing memories…');
  await remember('Customer IOCL prefers deliveries before noon and pays within 15 days.');
  await remember('Vendor Singh Transport rate is 18000 for the Agartala route.', 'Singh Transport');
  await remember('Driver Ramesh Das is reliable and knows the Bongaigaon-Agartala route well.', 'Ramesh Das');
  const r1 = await remember('IOCL ko dopahar se pehle delivery chahiye, payment 15 din me.'); // paraphrase of #1
  console.log('  paraphrase result:', r1, '| total memories:', mem.length);

  // Recall relevance
  const rec = await recall('IOCL payment terms kya hain?');
  ok('Recall surfaces the IOCL fact first', /IOCL/i.test(rec[0]?.text));

  // RBAC scope: a generic query as a DIFFERENT vendor must NOT see Singh's rate
  const asOtherVendor = await recall('Agartala route rate kya hai?', 'Other Vendor');
  ok('Other vendor does NOT see Singh Transport scoped memory', !asOtherVendor.some(m => /Singh Transport/i.test(m.text)));
  // The right vendor DOES see it
  const asSingh = await recall('Agartala route rate kya hai?', 'Singh Transport');
  ok('Singh Transport DOES see their own memory', asSingh.some(m => /Singh Transport/i.test(m.text)));
  // Admin (all) sees everything
  const asAdmin = await recall('Agartala route rate kya hai?', null);
  ok('Admin (all scope) sees scoped memory too', asAdmin.some(m => /Singh Transport/i.test(m.text)));

  console.log(`\nparaphrase dedupe -> ${r1} (sim-based)`);
  console.log(`===== ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
