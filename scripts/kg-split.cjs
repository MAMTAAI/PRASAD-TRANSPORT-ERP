#!/usr/bin/env node
/**
 * kg-split.cjs -- split the shared knowledge graph into one file per tenant.
 *
 *   node scripts/kg-split.cjs                 # dry run, prints the plan
 *   node scripts/kg-split.cjs --write         # actually write the two files
 *
 * WHY
 *
 * data/mamta-kg.db carries a `domain` column and holds both tenants. The
 * partition is enforced at the bridge -- a transport token cannot read trading
 * facts -- but it is one file, in the Prasad repo, and today every row in it is
 * `trading`. Moving that repo to F:\ would put Jaiswal Capital's knowledge on
 * the Prasad drive.
 *
 * After this split the `domain` column is redundant, which is the point:
 * isolation that lives in the filesystem cannot be undone by a config mistake.
 *
 * `shared` rows are copied into BOTH outputs, because that is what shared
 * means. If any exist, they are reported -- a genuinely shared fact is a
 * decision to make, not a default to inherit.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const WRITE = process.argv.includes('--write');
const SRC = process.env.KG_SRC || path.join(__dirname, '..', 'data', 'mamta-kg.db');

const TARGETS = [
  { domain: 'transport', out: process.env.KG_OUT_TRANSPORT || path.join(__dirname, '..', 'data', 'mamta-kg-transport.db'), owner: 'Prasad Transport' },
  { domain: 'trading',   out: process.env.KG_OUT_TRADING   || path.join(__dirname, '..', 'data', 'mamta-kg-trading.db'),   owner: 'Jaiswal Capital' },
];

if (!fs.existsSync(SRC)) { console.error(`source not found: ${SRC}`); process.exit(1); }

const src = new Database(SRC, { readonly: true });
const schema = src.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all().map(r => r.sql);

const count = (d) => ({
  nodes: src.prepare('SELECT count(*) n FROM nodes WHERE domain = ?').get(d).n,
  edges: src.prepare('SELECT count(*) n FROM edges WHERE domain = ?').get(d).n,
});

console.log(`source: ${SRC}`);
console.log(`mode  : ${WRITE ? 'WRITE' : 'DRY RUN -- nothing will be written'}\n`);

const shared = count('shared');
if (shared.nodes || shared.edges) {
  console.log(`NOTE: ${shared.nodes} nodes / ${shared.edges} edges are domain='shared'.`);
  console.log('      These will be copied into BOTH files. Review whether they should be.\n');
}

const domains = src.prepare('SELECT domain, count(*) n FROM nodes GROUP BY domain').all();
console.log('domains present in source:', JSON.stringify(domains));

let failed = false;

for (const t of TARGETS) {
  const c = count(t.domain);
  console.log(`\n--- ${t.owner}  (domain='${t.domain}')`);
  console.log(`    ${c.nodes} nodes, ${c.edges} edges  ->  ${t.out}`);

  if (!WRITE) continue;

  if (fs.existsSync(t.out)) {
    console.log(`    REFUSED: ${t.out} already exists. Move it aside first.`);
    failed = true;
    continue;
  }
  fs.mkdirSync(path.dirname(t.out), { recursive: true });

  const db = new Database(t.out);
  db.pragma('journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = OFF');
  for (const sql of schema) db.exec(sql);

  // Attach the source and copy in one transaction, so a failure leaves no
  // half-written tenant file behind.
  db.exec(`ATTACH DATABASE '${SRC.replace(/'/g, "''")}' AS s`);
  const copy = db.transaction(() => {
    db.exec(`INSERT INTO nodes   SELECT * FROM s.nodes   WHERE domain IN ('${t.domain}','shared')`);
    db.exec(`INSERT INTO edges   SELECT * FROM s.edges   WHERE domain IN ('${t.domain}','shared')`);
    // aliases carry no domain -- they follow their node.
    db.exec(`INSERT INTO aliases SELECT a.* FROM s.aliases a JOIN nodes n ON n.id = a.node_id`);
  });
  copy();
  db.exec('DETACH DATABASE s');

  const got = {
    nodes: db.prepare('SELECT count(*) n FROM nodes').get().n,
    edges: db.prepare('SELECT count(*) n FROM edges').get().n,
    aliases: db.prepare('SELECT count(*) n FROM aliases').get().n,
  };
  const want = { nodes: c.nodes + shared.nodes, edges: c.edges + shared.edges };

  // An orphan alias would mean a node failed to copy.
  const orphans = db.prepare('SELECT count(*) n FROM aliases a LEFT JOIN nodes n ON n.id = a.node_id WHERE n.id IS NULL').get().n;
  db.close();

  const ok = got.nodes === want.nodes && got.edges === want.edges && orphans === 0;
  console.log(`    written: ${got.nodes} nodes, ${got.edges} edges, ${got.aliases} aliases, ${orphans} orphan aliases`);
  console.log(`    verify : ${ok ? 'OK' : 'MISMATCH -- expected ' + JSON.stringify(want)}`);
  if (!ok) failed = true;
}

console.log('');
if (!WRITE) {
  console.log('DRY RUN -- re-run with --write to produce the two files.');
} else if (failed) {
  console.log('FINISHED WITH ERRORS -- the source is untouched. Fix the above before switching any bridge over.');
  process.exit(1);
} else {
  console.log('Both tenant graphs written and verified. The source is untouched.');
  console.log('Point each bridge at its own file with KG_DB_PATH, then archive the shared source.');
}
