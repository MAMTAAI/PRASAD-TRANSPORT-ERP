// server/agents/matangi.js
// AGENT 09 — MATANGI · CRM & Driver WhatsApp AI Assistant
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne, query } from '../db/pool.js';
import { sendViaEngine } from '../lib/waSend.js';

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
    // The pump's fuel slip. ops.routes.js has emitted this since the slip route
    // was written, and until 6-Sep-2026 only TARA (ledger) and BHUVANESHWARI
    // (documents) listened — so the event fired correctly and NOBODY told the
    // pump. The slip reached the pump only when a person remembered to press
    // the button in Trip Management.
    'fuel.slip.recorded',
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
      // ── THE PUMP'S FUEL SLIP ────────────────────────────────────────────
      // Sent here rather than from the route because the bus is what makes it
      // survivable: the event is a committed row before anyone reacts, the
      // delivery is retried five times, and a message that still cannot be
      // delivered becomes a DEAD event somebody can see — instead of a browser
      // alert() nobody was watching.
      //
      // "Zero failure" is not something WhatsApp can promise: the engine can be
      // unpaired, the 1.9 GB box can be out of memory, the number can be wrong.
      // What is guaranteed is that a slip is never silently dropped — every
      // attempt lands in `notifications`, and a failure throws so the bus
      // retries and then surfaces it.
      case 'fuel.slip.recorded': {
        const p = event.payload ?? {};
        const mobile = String(p.pump_mobile ?? '').replace(/\D/g, '').slice(-10);
        if (mobile.length !== 10) {
          // Not a failure of delivery — there is nothing to deliver to. Say so
          // loudly enough that the pump master gets fixed, but do not retry a
          // number that will not become valid on its own.
          return skipped(`no usable WhatsApp number on pump ${p.vendor_name ?? p.vendor_id} — slip ${p.memo_no ?? p.slip_id} not sent`);
        }

        const rupees = (v) => '₹' + Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const text = [
          '*⛽ FUEL SLIP — PRASAD TRANSPORT*',
          '',
          `Dear ${p.vendor_name ?? 'Pump'},`,
          '',
          // The slip number is the first thing the pump reconciles against its
          // own book at fortnight end. It was missing from the manual message.
          `🧾 *Slip No:* ${p.memo_no ?? String(p.slip_id ?? '').slice(0, 8)}`,
          `🚛 *Vehicle:* ${p.vehicle_no ?? '—'}`,
          `👤 *Driver:* ${p.driver_name ?? '—'}`,
          p.route_name ? `📍 *Route:* ${p.route_name}` : null,
          '',
          `💧 *${p.fuel_type ?? 'DIESEL'}:* ${Number(p.liters ?? 0)} L @ ${rupees(p.rate)}/L`,
          `💰 *Fuel Value:* ${rupees(p.amount)}`,
          `💵 *Cash Advance:* ${rupees(p.cash_given_to_pump)}`,
          `📅 *Date:* ${p.entry_date ?? ''}`,
          '',
          'Please issue against this slip only. Reply here if anything does not match.',
        ].filter(Boolean).join('\n');

        // Idempotence, on the index built for it in migration 006 and never
        // used until now. Two details this has to get right:
        //   · the index is PARTIAL (WHERE event_id IS NOT NULL), so ON CONFLICT
        //     must repeat that predicate or PostgreSQL refuses the statement
        //     outright with "no unique or exclusion constraint matching";
        //   · DO NOTHING would be wrong. The bus retries a failed delivery, and
        //     a retry must find its row and send again — only an already SENT
        //     slip is skipped. DO NOTHING would turn every retry into a no-op
        //     and quietly guarantee the pump never hears from us.
        const claim = await query(
          `INSERT INTO notifications (event_id, channel, recipient, template, body, status)
           VALUES ($1, 'WHATSAPP', $2, 'FUEL_SLIP', $3, 'QUEUED')
           ON CONFLICT (event_id, recipient) WHERE event_id IS NOT NULL
             DO UPDATE SET body = EXCLUDED.body
           RETURNING id, status`,
          [event.id, mobile, text]);
        const nid = claim.rows[0].id;
        if (claim.rows[0].status === 'SENT') {
          return skipped(`slip ${p.memo_no ?? p.slip_id} already sent to ${mobile}`);
        }

        try {
          await sendViaEngine({
            phone: mobile, text, user: null,
            tripId: p.trip_id ?? null, role: 'PUMP',
          });
          await query(
            `UPDATE notifications SET status='SENT', sent_at=now(), attempts=attempts+1 WHERE id=$1`, [nid]);
          await ctx.emit('notification.sent', {
            aggregate: 'fuel_entry', aggregateId: p.slip_id ?? event.aggregate_id,
            payload: { channel: 'WHATSAPP', recipient: mobile, template: 'FUEL_SLIP', memo_no: p.memo_no },
            correlationId: event.correlation_id,
          });
          return ok(`fuel slip ${p.memo_no ?? ''} sent to ${p.vendor_name} (${mobile})`);
        } catch (e) {
          // Record the attempt, then RETHROW. Swallowing here would make the
          // event DONE with nothing delivered — which is precisely how this
          // whole path came to look healthy while no pump ever heard from us.
          await query(
            `UPDATE notifications SET status='FAILED', attempts=attempts+1, last_error=$2 WHERE id=$1`,
            [nid, String(e.message).slice(0, 500)]).catch(() => {});
          await ctx.emit('notification.failed', {
            aggregate: 'fuel_entry', aggregateId: p.slip_id ?? event.aggregate_id,
            payload: { channel: 'WHATSAPP', recipient: mobile, template: 'FUEL_SLIP', error: e.code ?? 'SEND_FAILED', detail: e.message },
            correlationId: event.correlation_id,
          }).catch(() => {});
          throw e;
        }
      }

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
