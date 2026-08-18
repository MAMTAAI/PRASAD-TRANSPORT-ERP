import pg from 'pg'; import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
const c = new pg.Client({ host: process.env.PGHOST, port: +(process.env.PGPORT||5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
await c.connect();
const q = async (l, s) => { try { const r = await c.query(s); console.log('\n--- '+l); console.table(r.rows.slice(0,12)); } catch(e){ console.log('\n--- '+l+'  ERR: '+e.message); } };
await q('server settings', `SELECT name, setting FROM pg_settings WHERE name IN
  ('max_connections','shared_buffers','work_mem','effective_cache_size','random_page_cost','max_worker_processes','autovacuum')`);
await q('connections by state', `SELECT state, count(*)::int n, max(now()-state_change)::text longest
  FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1 ORDER BY 2 DESC`);
await q('current waits / long runners', `SELECT pid, state, wait_event_type, wait_event,
  round(extract(epoch from now()-query_start))::int secs, left(regexp_replace(query,'\s+',' ','g'),90) q
  FROM pg_stat_activity WHERE datname=current_database() AND state<>'idle' AND pid<>pg_backend_pid()
  ORDER BY query_start LIMIT 10`);
await q('agent_halts: size + indexes', `SELECT (SELECT count(*)::int FROM agent_halts) rows,
  pg_size_pretty(pg_total_relation_size('agent_halts')) total,
  (SELECT count(*)::int FROM pg_indexes WHERE tablename='agent_halts') idx`);
await q('agent_events: size + dead tuples', `SELECT n_live_tup live, n_dead_tup dead,
  last_autovacuum, last_autoanalyze FROM pg_stat_user_tables WHERE relname='agent_events'`);
await q('biggest tables', `SELECT relname, n_live_tup live, n_dead_tup dead,
  pg_size_pretty(pg_total_relation_size(relid)) size FROM pg_stat_user_tables
  ORDER BY pg_total_relation_size(relid) DESC LIMIT 10`);
await q('tables with the worst dead-tuple ratio', `SELECT relname, n_live_tup live, n_dead_tup dead,
  CASE WHEN n_live_tup>0 THEN round(100.0*n_dead_tup/n_live_tup) ELSE NULL END pct_dead
  FROM pg_stat_user_tables WHERE n_dead_tup > 1000 ORDER BY n_dead_tup DESC LIMIT 10`);
await c.end();
