// =======================================================
// 🕸️ MAMTA KG — lightweight SQLite knowledge graph (GraphRAG core)
// for the shared AI bridge on the t3.large. NO graph-DB server:
// better-sqlite3 (WAL) + two tables + BFS = the whole engine.
// RAM cost ≈ the page cache of a few-MB file; safe next to the
// live trading engine.
//
// Domains keep the two businesses separate in one brain:
//   'transport' (Prasad ERP) | 'trading' (Jaiswal Capital) | 'shared'
// Every read filters to (requested domain + shared).
// =======================================================
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.KG_DB_PATH || path.join(__dirname, '..', 'data', 'mamta-kg.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  domain     TEXT NOT NULL DEFAULT 'shared',
  props      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, name)
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE TABLE IF NOT EXISTS aliases (
  alias   TEXT NOT NULL,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  UNIQUE(alias, node_id)
);
CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY,
  src        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rel        TEXT NOT NULL,
  dst        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  domain     TEXT NOT NULL DEFAULT 'shared',
  weight     REAL NOT NULL DEFAULT 1,
  props      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(src, rel, dst)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
`);

// ── normalization ──────────────────────────────────────
// Match key strips everything but [a-z0-9] so "PB 10-AB 1234",
// "pb10ab1234" and "PB10AB1234" all collide onto one key.
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ── writes ─────────────────────────────────────────────
const insNode = db.prepare(`
  INSERT INTO nodes (type, name, domain, props) VALUES (@type, @name, @domain, @props)
  ON CONFLICT(type, name) DO UPDATE SET
    domain = excluded.domain,
    props = json_patch(nodes.props, excluded.props),
    updated_at = datetime('now')
`);
const getNodeId = db.prepare(`SELECT id FROM nodes WHERE type = ? AND name = ?`);
const insAlias = db.prepare(`INSERT OR IGNORE INTO aliases (alias, node_id) VALUES (?, ?)`);
const insEdge = db.prepare(`
  INSERT INTO edges (src, rel, dst, domain, weight, props) VALUES (@src, @rel, @dst, @domain, @weight, @props)
  ON CONFLICT(src, rel, dst) DO UPDATE SET
    domain = excluded.domain,
    weight = excluded.weight,
    props = json_patch(edges.props, excluded.props),
    updated_at = datetime('now')
`);

let matcherDirty = true;

function upsertNode(n) {
  const name = cleanName(n.name);
  if (!n.type || !name) throw new Error('node needs type and name');
  insNode.run({ type: n.type, name, domain: n.domain || 'shared', props: JSON.stringify(n.props || {}) });
  const id = getNodeId.get(n.type, name).id;
  insAlias.run(normKey(name), id);
  for (const a of n.aliases || []) { const k = normKey(a); if (k.length >= 3) insAlias.run(k, id); }
  matcherDirty = true;
  return id;
}

function upsertEdge(e) {
  const src = typeof e.src === 'number' ? e.src : upsertNode({ domain: e.domain, ...e.src });
  const dst = typeof e.dst === 'number' ? e.dst : upsertNode({ domain: e.domain, ...e.dst });
  if (!e.rel) throw new Error('edge needs rel');
  insEdge.run({ src, rel: e.rel, dst, domain: e.domain || 'shared', weight: e.weight ?? 1, props: JSON.stringify(e.props || {}) });
  matcherDirty = true;
}

// One transaction for a whole sync batch — atomic and fast.
const batchUpsert = db.transaction(({ nodes = [], edges = [] }) => {
  for (const n of nodes) upsertNode(n);
  for (const e of edges) upsertEdge(e);
  return { nodes: nodes.length, edges: edges.length };
});

// ── entity matcher ─────────────────────────────────────
// In-memory index: normKey -> Set<nodeId>. Rebuilt lazily after any
// write. A few thousand entities ≈ well under 1 MB.
let matcher = [];
function rebuildMatcher() {
  const rows = db.prepare(`
    SELECT a.alias, a.node_id, n.domain FROM aliases a JOIN nodes n ON n.id = a.node_id
  `).all();
  const byAlias = new Map();
  for (const r of rows) {
    if (r.alias.length < 3) continue;
    if (!byAlias.has(r.alias)) byAlias.set(r.alias, []);
    byAlias.get(r.alias).push({ id: r.node_id, domain: r.domain });
  }
  // longest aliases first so "tata steel" wins over "tata"
  matcher = [...byAlias.entries()].sort((a, b) => b[0].length - a[0].length);
  matcherDirty = false;
}

function findEntities(text, domain, cap = 8) {
  if (matcherDirty) rebuildMatcher();
  const hay = normKey(text);
  if (!hay) return [];
  const found = new Set();
  for (const [alias, nodes] of matcher) {
    if (found.size >= cap) break;
    if (!hay.includes(alias)) continue;
    for (const n of nodes) {
      if (n.domain === 'shared' || n.domain === domain) found.add(n.id);
    }
  }
  return [...found].slice(0, cap);
}

// ── traversal ──────────────────────────────────────────
function subgraph(seedIds, { domain = 'shared', depth = 2, maxEdges = 40 } = {}) {
  const seen = new Set(seedIds);
  let frontier = [...seedIds];
  const edges = [];
  for (let hop = 0; hop < depth && frontier.length && edges.length < maxEdges; hop++) {
    const ph = frontier.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT e.src, e.rel, e.dst, e.weight,
             ns.type AS stype, ns.name AS sname, nd.type AS dtype, nd.name AS dname
      FROM edges e JOIN nodes ns ON ns.id = e.src JOIN nodes nd ON nd.id = e.dst
      WHERE (e.src IN (${ph}) OR e.dst IN (${ph}))
        AND (e.domain = 'shared' OR e.domain = ?)
      ORDER BY e.weight DESC LIMIT ?
    `).all(...frontier, ...frontier, domain, maxEdges - edges.length);
    const next = [];
    for (const r of rows) {
      if (edges.some(x => x.src === r.src && x.rel === r.rel && x.dst === r.dst)) continue;
      edges.push(r);
      for (const id of [r.src, r.dst]) if (!seen.has(id)) { seen.add(id); next.push(id); }
    }
    frontier = next;
  }
  return edges;
}

// ── context injection (the GraphRAG step) ──────────────
const propsOf = db.prepare(`SELECT type, name, props FROM nodes WHERE id = ?`);
function contextForMessage(text, { domain = 'shared', maxChars = Number(process.env.KG_MAX_CONTEXT || 1500) } = {}) {
  const seeds = findEntities(text, domain);
  if (!seeds.length) return null;
  const edges = subgraph(seeds, { domain });
  const lines = [];
  for (const id of seeds) {
    const n = propsOf.get(id);
    if (!n) continue;
    const p = Object.entries(JSON.parse(n.props || '{}'))
      .filter(([, v]) => v !== null && typeof v !== 'object' && String(v).length <= 40)
      .slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ');
    lines.push(`• ${n.type} ${n.name}${p ? ` (${p})` : ''}`);
  }
  for (const e of edges) {
    const w = e.weight > 1 ? ` [x${Math.round(e.weight)}]` : '';
    lines.push(`- ${e.stype} ${e.sname} —${e.rel}→ ${e.dtype} ${e.dname}${w}`);
  }
  if (!lines.length) return null;
  let out = 'KNOWLEDGE GRAPH — organization ke VERIFIED facts (inko priority do; jo fact yahan nahi hai use invent mat karo):\n';
  for (const l of lines) {
    if (out.length + l.length + 1 > maxChars) break;
    out += l + '\n';
  }
  return { context: out.trimEnd(), facts: Math.min(lines.length, out.split('\n').length - 1), entities: seeds.length };
}

// ── misc ───────────────────────────────────────────────
function stats() {
  const g = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    nodes: g(`SELECT COUNT(*) c FROM nodes`).c,
    edges: g(`SELECT COUNT(*) c FROM edges`).c,
    aliases: g(`SELECT COUNT(*) c FROM aliases`).c,
    by_domain: db.prepare(`SELECT domain, COUNT(*) c FROM nodes GROUP BY domain`).all(),
    db_path: DB_PATH,
  };
}

function queryEntity(name, { domain = 'shared', depth = 2 } = {}) {
  const ids = findEntities(name, domain, 3);
  if (!ids.length) return { entity: name, found: false, edges: [] };
  const edges = subgraph(ids, { domain, depth }).map(e => ({
    src: `${e.stype}:${e.sname}`, rel: e.rel, dst: `${e.dtype}:${e.dname}`, weight: e.weight,
  }));
  return { entity: name, found: true, edges };
}

// Seed a domain from a JSON file once (skips if that domain already has edges).
function ensureSeed(file, domain) {
  const has = db.prepare(`SELECT COUNT(*) c FROM edges WHERE domain = ?`).get(domain).c;
  if (has > 0 || !fs.existsSync(file)) return false;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  batchUpsert(data);
  console.log(`🕸️ KG: seeded ${domain} from ${path.basename(file)} (${data.nodes?.length || 0} nodes, ${data.edges?.length || 0} edges)`);
  return true;
}

module.exports = { upsertNode, upsertEdge, batchUpsert, findEntities, subgraph, contextForMessage, stats, queryEntity, ensureSeed };
