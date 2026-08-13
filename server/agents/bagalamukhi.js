// server/agents/bagalamukhi.js
// AGENT 08 — BAGALAMUKHI · Infra Hard-Halt & AWS Reverse Tunnel Security Guard
import { createRequire } from 'node:module';
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { query, queryOne, isDegraded, DB_TARGET } from '../db/pool.js';

// security.cjs is CommonJS and already owns the SOC event store, ban evaluation
// and kill switch (capture / radar / isBanned / killState / setKill / armed).
// Bagalamukhi WRAPS it — a second kill switch would be a second source of truth
// about whether the system is halted, which is the last thing a kill switch
// should have. Loaded lazily so the agent still declares cleanly if the SOC
// module is absent (e.g. a bare AWS deploy).
const require = createRequire(import.meta.url);
let soc = null;
try {
  soc = require('../../security.cjs');
} catch {
  console.warn('[AGENT_08] security.cjs not loadable — SOC integration inactive');
}

/**
 * Phase-1 active defence is SHADOW by default (see deploy/PHASE1-ACTIVE-DEFENSE.md):
 * SOC_ARM=1 is the only switch that lets a ban actually block traffic. That
 * design is respected here rather than bypassed — an agent that could silently
 * arm the shield would defeat the point of a deliberate arming step.
 */
export default defineAgent({
  id: 'AGENT_08',
  codename: 'BAGALAMUKHI',
  title: 'Infra Hard-Halt & AWS Reverse Tunnel Security Guard',
  domain: 'infrastructure',
  mandate:
    'Guards the boundary between the local PC and AWS: reverse-tunnel integrity, database ' +
    'connection isolation, and the hard-halt kill switch. Bagalamukhi is the only agent ' +
    'permitted to stop the swarm, and the halt it writes survives a process restart. It ' +
    'never touches business data of any kind.',

  subscribes: [
    'agent.halt.requested',
    'agent.resume.requested',
    'ledger.imbalance.detected',
    'infra.tunnel.check',
    'infra.db.failover.detected',
    'security.intrusion.suspected',
  ],
  emits: [
    'agent.halted',
    'agent.resumed',
    'infra.tunnel.down',
    'infra.tunnel.restored',
    'infra.db.isolated',
    'security.ban.recommended',
  ],

  owns: {
    tables: ['agent_halts', 'infra_health_checks'],
    modules: ['SecurityRadar.tsx', 'security.cjs', 'scripts/erp_api_shield.cjs'],
  },
  reads: ['agent_events', 'agent_runs'],

  mustNot: [
    'read or write ANY business table — vehicles, trips, ledgers, fuel, drivers are all out of scope',
    'arm the SOC shield by itself; SOC_ARM stays a deliberate human action',
    'clear a halt it did not raise without an explicit operator identity',
    'expose the database to a non-loopback bind, or widen a security group',
  ],

  guards: [
    { name: 'halt_survives_restart',
      description: 'A halt is a row in agent_halts, not a process flag; bouncing PM2 does not resume the swarm.' },
    { name: 'halt_requires_identity',
      description: 'Both halting and clearing record who did it — an anonymous halt is refused.' },
    { name: 'db_stays_loopback_or_vpc',
      description: 'Local PostgreSQL binds 127.0.0.1; RDS stays private with the EC2 SG as the only inbound rule.' },
    { name: 'imbalance_is_a_hard_halt',
      description: 'A ledger imbalance from TARA halts the whole swarm, not just the finance agent.' },
    { name: 'shadow_by_default',
      description: 'Bans are recommended, never auto-armed; SOC_ARM remains the human gate.' },
  ],

  requires: ['agent_halts'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'agent.halt.requested':
      case 'ledger.imbalance.detected': {
        const scope = event.payload?.scope ?? null;   // null = global halt
        const reason = event.payload?.reason ?? `raised by ${event.emitted_by ?? 'unknown'}`;
        const by = event.payload?.requested_by ?? event.emitted_by ?? null;

        if (!by) return failed('halt refused: no requesting identity recorded');

        // The partial unique indexes on agent_halts make a duplicate live halt
        // impossible, so ON CONFLICT DO NOTHING is the idempotent path — a
        // redelivered event must not stack halts.
        const { rows } = await query(
          `INSERT INTO agent_halts (agent_id, reason, halted_by)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [scope, reason, by]
        );

        if (!rows.length) return skipped(`halt already active for ${scope ?? 'GLOBAL'}`);

        // Mirror into the SOC kill switch so the HTTP layer refuses traffic too.
        // Without this the agents stop but the API keeps accepting writes.
        if (soc?.setKill && scope === null) {
          try { soc.setKill(true, `AGENT_08: ${reason}`); }
          catch (err) { console.error('[AGENT_08] SOC setKill failed:', err.message); }
        }

        await ctx.emit('agent.halted', {
          aggregate: 'swarm',
          payload: { scope, reason, halted_by: by },
          correlationId: event.correlation_id,
        });
        console.error(`[AGENT_08] HALT ${scope ?? 'GLOBAL'} — ${reason} (by ${by})`);
        return ok(`halted ${scope ?? 'GLOBAL'}: ${reason}`);
      }

      case 'agent.resume.requested': {
        const scope = event.payload?.scope ?? null;
        const by = event.payload?.cleared_by;
        if (!by) return failed('resume refused: no clearing identity recorded');

        const { rowCount } = await query(
          `UPDATE agent_halts SET cleared_at = now(), cleared_by = $2
            WHERE cleared_at IS NULL
              AND ((agent_id IS NULL AND $1::text IS NULL) OR agent_id = $1)`,
          [scope, by]
        );
        if (!rowCount) return skipped(`no active halt for ${scope ?? 'GLOBAL'}`);

        if (soc?.setKill && scope === null) {
          try { soc.setKill(false, `AGENT_08 resume by ${by}`); }
          catch (err) { console.error('[AGENT_08] SOC setKill clear failed:', err.message); }
        }

        await ctx.emit('agent.resumed', {
          aggregate: 'swarm',
          payload: { scope, cleared_by: by },
          correlationId: event.correlation_id,
        });
        return ok(`resumed ${scope ?? 'GLOBAL'} (by ${by})`);
      }

      case 'security.intrusion.suspected': {
        const ip = event.payload?.ip;
        if (!ip) return failed('intrusion report carried no ip');
        // Recommend, never auto-ban. SOC_ARM stays the human gate.
        if (soc?.capture) {
          try { soc.capture({ kind: 'AGENT_08_INTRUSION', ip, detail: event.payload?.detail ?? '' }); }
          catch { /* SOC store is best-effort */ }
        }
        await ctx.emit('security.ban.recommended', {
          aggregate: 'security',
          payload: { ip, armed: Boolean(soc?.armed), detail: event.payload?.detail ?? null },
          correlationId: event.correlation_id,
        });
        return ok(`ban recommended for ${ip} (SOC armed: ${Boolean(soc?.armed)})`);
      }

      case 'infra.db.failover.detected':
        // Fired when pool.js resolved a fallback target. Operationally loud,
        // because running on the fallback silently is how a split brain starts.
        return blocked(`database is on a FALLBACK target (DB_TARGET=${DB_TARGET}, degraded=${isDegraded()})`);

      default:
        return skipped(`no infra rule for ${event.event_type}`);
    }
  },
});

/** Is the swarm (or one agent) currently halted? Used by the registry gate. */
export async function activeHalt(agentId = null) {
  return queryOne(
    `SELECT agent_id, reason, halted_by, halted_at FROM agent_halts
      WHERE cleared_at IS NULL AND (agent_id IS NULL OR agent_id = $1)
      ORDER BY halted_at LIMIT 1`,
    [agentId]
  );
}
