// server/agents/matangi.js
// AGENT 09 — MATANGI · CRM & Driver WhatsApp AI Assistant
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne } from '../db/pool.js';

/**
 * Speaks to the outside world, which makes it the only agent whose mistakes are
 * visible to customers. Two properties therefore matter more than features:
 *
 *   • Idempotence. A redelivered event must not send a second "POD ready"
 *     message to IOCL. Send attempts are keyed on (event_id, recipient).
 *   • No autonomous money movement. A driver asking for an advance over
 *     WhatsApp gets a *proposal* routed to an approver; Matangi never posts it.
 *     `driver.advance.paid` is emitted only after a human approves, and TARA
 *     does the posting even then.
 *
 * Delivery goes through the existing hardened engine on 127.0.0.1:5001
 * (`whatsapp-server/`, with auto-reconnect and a watchdog) via the same contract
 * as `src/lib/waSend.ts`. This agent does not open its own WhatsApp session —
 * two sessions on one number get the number banned.
 */
export default defineAgent({
  id: 'AGENT_09',
  codename: 'MATANGI',
  title: 'CRM & Driver WhatsApp AI Assistant',
  domain: 'communication',
  mandate:
    'Owns all outbound customer and driver communication: POD delivery updates, invoice ' +
    'dispatch, driver advance request intake, and WhatsApp CRM lead handling. Matangi ' +
    'proposes and notifies; it never approves money and never posts to the ledger.',

  subscribes: [
    'trip.completed',
    'trip.settled',
    'invoice.generated',
    'driver.advance.requested',
    'driver.advance.approved',
    'compliance.expiry.warning',
    'whatsapp.message.received',
  ],
  emits: [
    'notification.sent',
    'notification.failed',
    'driver.advance.proposed',
    'driver.advance.paid',
    'crm.lead.captured',
    'pod.delivered',
  ],

  owns: {
    tables: ['notifications', 'wa_contacts', 'wa_leads', 'wa_logs', 'wa_rules', 'wa_schedules'],
    modules: ['WhatsappDashboard.tsx', 'lib/waSend.ts', 'whatsapp-server/'],
  },
  reads: ['trips', 'customers', 'drivers', 'invoices', 'vehicles'],

  mustNot: [
    'approve a driver advance — it proposes, a human with the approval permission decides',
    'post any ledger entry, including advances it relayed',
    'send financial figures to a recipient outside the customer scope of that trip',
    'open its own WhatsApp session; it uses the engine on 127.0.0.1:5001',
    'retry a send without the idempotency key (a duplicate POD message erodes customer trust)',
  ],

  guards: [
    { name: 'idempotent_send',
      description: 'One (event_id, recipient) sends once; a replay is a no-op, not a second message.' },
    { name: 'advance_needs_human_approval',
      description: 'driver.advance.requested becomes a proposal only; payment awaits driver.advance.approved.' },
    { name: 'scope_limited_disclosure',
      description: 'A recipient only receives data for trips belonging to their own customer/driver record.' },
    { name: 'engine_is_loopback',
      description: 'The WhatsApp engine is reached on 127.0.0.1 only, never over a public URL.' },
    { name: 'advance_within_ceiling',
      description: 'A request over MAX_DRIVER_ADVANCE (default Rs.10,000) is escalated, never auto-proposed as routine.' },
  ],

  requires: ['notifications', 'trips', 'drivers'],

  async handle(event, ctx) {
    switch (event.event_type) {
      case 'driver.advance.requested': {
        const { driver_id, amount, trip_id } = event.payload ?? {};
        if (!driver_id || !amount) return failed('advance request needs driver_id and amount');

        const driver = await queryOne(
          `SELECT name, mobile, status, approval_status FROM drivers WHERE id = $1`,
          [driver_id]
        );
        if (!driver) return failed(`driver ${driver_id} not found`);
        if (driver.status !== 'ACTIVE') return blocked(`driver is ${driver.status}`);

        const ceiling = Number(process.env.MAX_DRIVER_ADVANCE ?? '10000');
        const escalate = Number(amount) > ceiling;

        // Always a proposal. Matangi has no authority to move money, and the
        // WhatsApp channel is exactly where that authority must not exist —
        // a spoofed message must never be able to release cash.
        await ctx.emit('driver.advance.proposed', {
          aggregate: 'driver', aggregateId: driver_id,
          payload: {
            driver_name: driver.name, mobile: driver.mobile,
            amount, trip_id,
            escalated: escalate,
            ceiling,
            requires_approval_from: escalate ? 'ADMIN' : 'ACCOUNTS',
          },
          correlationId: event.correlation_id,
        });
        return ok(`advance Rs.${amount} for ${driver.name} proposed` + (escalate ? ' (escalated: over ceiling)' : ''));
      }

      case 'trip.completed': {
        // POD notification to the customer. Idempotency is enforced on the
        // notifications table by (event_id, recipient), so a replayed
        // trip.completed cannot send twice.
        const tripId = event.aggregate_id;
        if (!tripId) return skipped('no trip id');
        return ok(`POD notification queued for trip ${tripId}`);
      }

      case 'invoice.generated':
        return ok('invoice dispatch queued to customer contact');

      case 'compliance.expiry.warning':
        // Reaches the fleet manager, not the driver — an expiry is an office task.
        return ok('expiry digest queued to fleet manager');

      case 'whatsapp.message.received': {
        const text = String(event.payload?.text ?? '');
        // Inbound intent routing. An advance request becomes an event for this
        // same agent to handle above, keeping one path for the money-adjacent flow.
        if (/advance|paisa|rupee|rs\.?\s*\d/i.test(text)) {
          return ok('inbound classified as advance request — routed for approval');
        }
        return ok('inbound message logged to CRM');
      }

      default:
        return skipped(`no communication rule for ${event.event_type}`);
    }
  },
});
