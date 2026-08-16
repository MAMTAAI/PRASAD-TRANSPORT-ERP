// server/modules/drilldown.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// "Click any number, see the rows that make it up" -- and a way to PROVE the
// rows really do make it up.
//
//   GET /api/v1/dashboard/drilldown                 list the metrics
//   GET /api/v1/dashboard/drilldown/_selfcheck      registry vs the live cards
//   GET /api/v1/dashboard/drilldown/:metric         the rows  (?format=csv)
//
// The interesting one is _selfcheck. The dashboard cards run their own SQL in
// dashboard.routes.js; the registry runs its own. Both are hand-written, so
// both can drift -- and a drill-down that quietly disagrees with its headline
// is the exact bug this feature is supposed to kill, not introduce. _selfcheck
// fetches the real /dashboard/v5 payload through app.inject(), compares every
// metric that declares a `headline` path, and reports mismatches. It is a test
// that runs against live data, on demand, in production.
import { query, isDegraded } from '../db/pool.js';
import { METRICS, getMetric, metricKeys, totalsSql, pagedSql, rowSql } from '../lib/drilldownRegistry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same parse as the dashboard: an unrecognised value becomes NULL rather than a
// 400, so a stale bookmark shows unfiltered data instead of an error.
function filtersOf(q) {
  const id = (v) => (UUID_RE.test(String(v ?? '')) ? String(v) : null);
  const fleet = String(q?.fleet ?? '').toUpperCase();
  return [
    id(q?.company_id),
    id(q?.branch_id),
    String(q?.owner ?? '').trim() || null,
    fleet === 'OWNED' || fleet === 'ATTACHED' ? fleet : null,
  ];
}

/** RFC4180-ish. Excel opens this; a comma in a consignee name does not break it. */
function toCsv(columns, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(cell).join(',');
  const body = rows.map((r) => columns.map((c) => cell(r[c])).join(',')).join('\r\n');
  // BOM so Excel reads UTF-8 rather than mangling a Devanagari consignee name.
  return `﻿${head}\r\n${body}\r\n`;
}

const at = (obj, path) =>
  String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function registerDrilldownRoutes(app) {
  // ── the catalogue ─────────────────────────────────────────────────────────
  app.get('/dashboard/drilldown', async () => ({
    ok: true,
    count: metricKeys().length,
    metrics: metricKeys().map((k) => ({
      key: k, hub: METRICS[k].hub, label: METRICS[k].label,
      unit: METRICS[k].unit, has_money: !!METRICS[k].measure,
      checkable: !!METRICS[k].headline,
    })),
  }));

  // ── the proof ─────────────────────────────────────────────────────────────
  // Only metrics with a `headline` can be checked; the rest have no single card
  // to compare against and are reported as such rather than silently passed.
  app.get('/dashboard/drilldown/_selfcheck', async (req, reply) => {
    if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });

    const qs = new URLSearchParams();
    for (const k of ['company_id', 'branch_id', 'owner', 'fleet']) {
      if (req.query?.[k]) qs.set(k, String(req.query[k]));
    }
    // One path to the dashboard's own numbers. Re-implementing them here to
    // compare against would compare my copy with my copy.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/dashboard/v5${qs.toString() ? `?${qs}` : ''}`,
      headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
    });
    let payload = null;
    try { payload = res.json(); } catch { /* handled below */ }
    if (!payload?.ok) {
      return reply.code(502).send({ ok: false, error: 'DASHBOARD_UNAVAILABLE', status: res.statusCode });
    }

    const P = filtersOf(req.query);
    const checks = [];
    for (const key of metricKeys()) {
      const m = METRICS[key];
      try {
        // EXECUTE EVERY METRIC, even one with no card to compare against.
        // Skipping them meant a metric with a broken query sat at "no headline"
        // and looked benign -- two of them referenced a ledger_entries.voucher_no
        // that does not exist, and neither showed up here until somebody clicked
        // the card. A drill-down that 500s is a defect whether or not there is a
        // number to check it against, so the query runs regardless and only the
        // COMPARISON is conditional.
        const { rows } = await query(totalsSql(m), P);
        if (!m.headline) {
          checks.push({ key, status: 'RUNS_OK', rows: Number(rows[0].n), note: 'query runs; no single card to compare against' });
          continue;
        }
        const drill = m.measure ? Number(rows[0].total) : Number(rows[0].n);
        const card = Number(at(payload, m.headline));
        // Money is compared to the paisa, counts exactly. A tolerance here would
        // be a way of not noticing.
        const agree = Number.isFinite(card) && Math.abs(drill - card) < 0.005;
        checks.push({
          key, headline: m.headline, card, drilldown: drill,
          rows: Number(rows[0].n),
          status: agree ? 'MATCH' : 'MISMATCH',
        });
      } catch (e) {
        checks.push({ key, status: 'ERROR', error: String(e.message).slice(0, 200) });
      }
    }
    const bad = checks.filter((c) => c.status === 'MISMATCH' || c.status === 'ERROR');
    return {
      ok: bad.length === 0,
      executed: checks.length,
      compared: checks.filter((c) => c.status === 'MATCH' || c.status === 'MISMATCH').length,
      mismatches: bad.length,
      checks,
    };
  });

  // ── the rows ──────────────────────────────────────────────────────────────
  app.get('/dashboard/drilldown/:metric', async (req, reply) => {
    if (isDegraded()) return reply.code(503).send({ error: 'DB_UNAVAILABLE' });

    const key = String(req.params.metric);
    const m = getMetric(key);
    if (!m) {
      return reply.code(404).send({ error: 'UNKNOWN_METRIC', metric: key, known: metricKeys() });
    }

    const csv = String(req.query?.format ?? '').toLowerCase() === 'csv';
    const P = filtersOf(req.query);

    // CSV is the WHOLE set, deliberately. Exporting only the page on screen is
    // how someone reconciles 25 rows against a total of 52 and concludes the
    // books are wrong.
    const limit = csv ? 100000 : Math.min(Math.max(Number(req.query?.limit) || 100, 1), 1000);
    const offset = csv ? 0 : Math.max(Number(req.query?.offset) || 0, 0);

    const [{ rows: tot }, { rows }] = await Promise.all([
      query(totalsSql(m), P),
      query(pagedSql(m), [...P, limit, offset]),
    ]);

    const columns = rows.length
      ? Object.keys(rows[0]).filter((c) => c !== '_measure')
      : [];

    if (csv) {
      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${key.replace(/\W+/g, '_')}_${stamp}.csv"`)
        .send(toCsv(columns, rows));
    }

    return {
      ok: true,
      metric: key,
      label: m.label,
      hub: m.hub,
      unit: m.unit,
      // total is the count of rows this query returns; money_total sums the
      // measure over ALL of them, not over the page.
      total: Number(tot[0].n),
      money_total: tot[0].total === null ? null : tot[0].total,
      returned: rows.length,
      limit,
      offset,
      columns,
      rows,
      link: m.link ?? null,
      // Handed to the UI so a reviewer can see the predicate that produced the
      // rows without opening the source.
      sql: String(req.query?.explain) === '1' ? rowSql(m) : undefined,
    };
  });
}

export default registerDrilldownRoutes;
