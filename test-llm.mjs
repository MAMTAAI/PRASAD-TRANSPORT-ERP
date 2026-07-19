// Step 5 — offline streaming smoke test for the local Gemma 4 engine.
// Exercises the same /api/chat NDJSON streaming contract as src/lib/llm/providers/ollama.ts
const BASE = 'http://127.0.0.1:11434';
const MODEL = process.argv[2] || 'gemma4:12b';

const health = await fetch(`${BASE}/api/tags`).then(r => r.json());
console.log('Installed models:', health.models.map(m => m.name).join(', '));

const t0 = Date.now();
const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    stream: true,
    options: { temperature: 0.3 },
    messages: [
      { role: 'system', content: 'You are MAMTA AI, the assistant for PRASAD Transport ERP. Reply briefly in simple Hindi.' },
      { role: 'user', content: 'Ek line mein batao: tum kaun ho aur kya kar sakti ho?' },
    ],
  }),
});

if (!res.ok) { console.error('HTTP', res.status, await res.text()); process.exit(1); }

process.stdout.write(`\n[${MODEL}] streaming: `);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '', full = '', firstTokenMs = 0, tokens = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const j = JSON.parse(line);
    const d = j.message?.content || '';
    if (d) { if (!firstTokenMs) firstTokenMs = Date.now() - t0; tokens++; full += d; process.stdout.write(d); }
  }
}
const total = Date.now() - t0;
console.log(`\n\n✅ DONE  | first token: ${firstTokenMs}ms | chunks: ${tokens} | total: ${total}ms | ${(tokens / (total / 1000)).toFixed(1)} chunks/s`);
