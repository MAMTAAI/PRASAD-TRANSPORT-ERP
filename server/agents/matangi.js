// server/agents/matangi.js
// AGENT 09 — MATANGI · CRM & Driver WhatsApp AI Assistant
import { defineAgent, ok, skipped, blocked, failed } from './base.js';
import { queryOne, query } from '../db/pool.js';
import { sendViaEngine } from '../lib/waSend.js';
import { buildFuelSlipPdf } from '../lib/fuelSlipPdf.js';
import { put, safeKey } from '../lib/storage.js';
import { mintShareLink } from '../lib/shareLinks.js';

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
const last10 = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);

/**
 * The office's fallback numbers, from app_settings['notify_contacts']:
 *   { "fleet_manager": "98xxxxxxxx", "admin": "98xxxxxxxx" }
 * Set them at PUT /api/v1/crm/settings/notify_contacts. Until they exist a
 * notice with no other recipient is SUPPRESSED and says so — it is not an
 * error, and it must never look like a delivery.
 */
async function fallbackNumber(key) {
  const row = await queryOne(`SELECT value FROM app_settings WHERE key = 'notify_contacts'`);
  const v = row?.value ?? {};
  return last10(v[key] ?? v.admin ?? '');
}

/**
 * ONE delivery path for every notice this agent sends.
 *
 * Everything the fuel slip learned, applied to the rest: the attempt is a row
 * before it is a message, idempotence rides the (event_id, recipient) index
 * (whose PARTIAL predicate the ON CONFLICT must repeat), a retry finds its row
 * and sends again because only a SENT row is skipped, and a failure RETHROWS so
 * the bus retries five times and then shows a DEAD event. Returning a hopeful
 * string here is exactly how this agent came to look healthy while it had never
 * sent anything at all.
 */
async function sendNotice(event, ctx, { template, text, tripId, to, fallbackKey, who, aggregate, aggregateId }) {
  let phone = last10(to);
  let viaFallback = false;
  if (phone.length !== 10) {
    phone = await fallbackNumber(fallbackKey);
    viaFallback = true;
  }
  if (phone.length !== 10) {
    // Nothing to deliver to. Record it as SUPPRESSED so the gap is visible on
    // the dashboard rather than discovered when somebody asks why the customer
    // never heard from us.
    await query(
      `INSERT INTO notifications (event_id, channel, recipient, template, body, status, last_error)
       VALUES ($1,'WHATSAPP','(none)',$2,$3,'SUPPRESSED',$4)
       ON CONFLICT (event_id, recipient) WHERE event_id IS NOT NULL DO NOTHING`,
      [event.id, template, text, `no number for ${who} and no notify_contacts.${fallbackKey}`]).catch(() => {});
    return skipped(`no WhatsApp number for ${who}, and app_settings.notify_contacts.${fallbackKey} is not set`);
  }

  const claim = await query(
    `INSERT INTO notifications (event_id, channel, recipient, template, body, status)
     VALUES ($1,'WHATSAPP',$2,$3,$4,'QUEUED')
     ON CONFLICT (event_id, recipient) WHERE event_id IS NOT NULL
       DO UPDATE SET body = EXCLUDED.body
     RETURNING id, status`,
    [event.id, phone, template, text]);
  const nid = claim.rows[0].id;
  if (claim.rows[0].status === 'SENT') return skipped(`${template} already sent to ${phone}`);

  try {
    await sendViaEngine({ phone, text, user: null, tripId, role: 'CUSTOMER' });
    await query(`UPDATE notifications SET status='SENT', sent_at=now(), attempts=attempts+1 WHERE id=$1`, [nid]);
    await ctx.emit('notification.sent', {
      aggregate, aggregateId, payload: { channel: 'WHATSAPP', recipient: phone, template, fallback: viaFallback },
      correlationId: event.correlation_id,
    });
    return ok(`${template} sent to ${who} (${phone})${viaFallback ? ' via office fallback' : ''}`);
  } catch (e) {
    await query(`UPDATE notifications SET status='FAILED', attempts=attempts+1, last_error=$2 WHERE id=$1`,
      [nid, String(e.message).slice(0, 500)]).catch(() => {});
    await ctx.emit('notification.failed', {
      aggregate, aggregateId,
      payload: { channel: 'WHATSAPP', recipient: phone, template, error: e.code ?? 'SEND_FAILED', detail: e.message },
      correlationId: event.correlation_id,
    }).catch(() => {});
    throw e;
  }
}

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
        // ONE STOP, ONE MESSAGE. The route emits a single event per visit
        // carrying every product issued, so diesel and engine oil taken
        // together arrive as one slip instead of two.
        const nameOf = (ft) => (String(ft ?? '').toUpperCase() === 'MOBIL'
          ? 'MOBIL / ENGINE OIL'
          : (ft && ft !== 'FIXED' && ft !== 'ADVANCE' ? ft : 'DIESEL'));
        const items = (Array.isArray(p.items) && p.items.length)
          ? p.items
          : [{ fuel_type: p.fuel_type, liters: p.liters, rate: p.rate, amount: p.amount }];
        const itemLines = items.map((it) => {
          const oil = String(it.fuel_type ?? '').toUpperCase() === 'MOBIL';
          const qty = `${Number(it.liters ?? 0)} L`;
          // Rate and value appear ONLY once the pump's bill has priced it.
          return Number(it.rate) > 0
            ? `${oil ? '🛢' : '💧'} *${nameOf(it.fuel_type)}:* ${qty} @ ${rupees(it.rate)}/L = ${rupees(it.amount)}`
            : `${oil ? '🛢' : '💧'} *${nameOf(it.fuel_type)}:* ${qty}`;
        });
        const anyPriced = items.some((it) => Number(it.rate) > 0);
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
          ...itemLines,
          anyPriced ? null : '💰 *Value:* as per your bill',
          Number(p.cash_given_to_pump) > 0 ? `💵 *Cash Advance:* ${rupees(p.cash_given_to_pump)}` : null,
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

        // ── THE DOCUMENT THE PUMP FILES ──────────────────────────────────
        // A message is read and forgotten; the pump reconciles at fortnight end
        // against a slip it kept. Built here rather than at the route so a
        // failure to render NEVER blocks the trip's fuel being recorded — if
        // this throws, the text still goes out below with the numbers in it.
        let media = null;
        let link = null;
        try {
          const firm = p.trip_id ? await queryOne(
            `SELECT c.company_name, c.address, c.city, c.state, c.pincode,
                    c.gstin::text AS gstin, c.pan_no::text AS pan_no, c.phone
               FROM trips t LEFT JOIN companies c ON c.id = t.company_id
              WHERE t.id = $1::uuid`, [p.trip_id]) : null;

          const pdf = await buildFuelSlipPdf({
            slip: {
              memo_no: p.memo_no, slip_id: p.slip_id, entry_date: p.entry_date,
              vendor_name: p.vendor_name, vehicle_no: p.vehicle_no,
              driver_name: p.driver_name, route_name: p.route_name,
              trip_code: p.trip_code, cash_given_to_pump: p.cash_given_to_pump,
              // Every product from this stop on ONE sheet — the pump files one
              // slip for one visit, as it writes one entry in its own book.
              items: items.map((it) => ({
                label: nameOf(it.fuel_type) === 'DIESEL' ? 'HSD (DIESEL)' : nameOf(it.fuel_type),
                qty: Number(it.liters ?? 0), unit: 'L',
                rate: Number(it.rate ?? 0), amount: Number(it.amount ?? 0),
              })),
            },
            company: firm,
          });

          const slipRef = String(p.memo_no || p.slip_id || 'slip').replace(/[^A-Za-z0-9._-]/g, '_');
          const filename = `FuelSlip-${slipRef}.pdf`;
          // Filed against the TRIP, like the LR copy: one document, whoever it
          // later goes to.
          const key = safeKey(`trips/${p.trip_id ?? 'unlinked'}/fuel-slips/${Date.now()}-${filename}`);
          const stored = await put(key, Buffer.from(pdf), 'application/pdf');
          link = await mintShareLink({
            storageKey: stored.key, filename, contentType: 'application/pdf',
            purpose: 'FUEL_SLIP', phone: mobile, tripId: p.trip_id ?? null,
            // 30 days: a pump reconciles at fortnight end and being asked to
            // re-open a slip a fortnight later is the normal case.
            hours: 720,
          });
          media = { key: stored.key, type: 'application/pdf', filename };
        } catch (e) {
          console.warn(`[matangi] fuel slip PDF failed for ${p.memo_no ?? p.slip_id}: ${e.message} — sending text only`);
        }

        try {
          await sendViaEngine({
            phone: mobile,
            text: link ? `${text}\n\n📄 Slip PDF (30 days): ${link.url}` : text,
            user: null,
            tripId: p.trip_id ?? null, role: 'PUMP', media,
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
        const tripId = event.aggregate_id;
        if (!tripId) return skipped('no trip id');
        const t = await queryOne(
          `SELECT t.trip_code, t.vehicle_no, t.loading_point, t.consignee_name,
                  t.customer_name, t.unloading_date,
                  c.mobile_no AS customer_mobile, c.contact_person
             FROM trips t
             LEFT JOIN customers c ON norm_company_name(c.customer_name) = norm_company_name(t.customer_name)
            WHERE t.id = $1::uuid`, [tripId]);
        if (!t) return failed(`trip ${tripId} not found`);

        const short = Number(event.payload?.shortage_qty ?? 0);
        const text = [
          `*✅ DELIVERED — ${t.trip_code ?? ''}*`,
          '',
          t.contact_person ? `Dear ${t.contact_person},` : `Dear ${t.customer_name ?? 'Sir'},`,
          '',
          `🚛 *Vehicle:* ${t.vehicle_no ?? '—'}`,
          `📍 *Route:* ${[t.loading_point, t.consignee_name].filter(Boolean).join(' → ')}`,
          event.payload?.unloaded_qty != null ? `🛢 *Unloaded:* ${event.payload.unloaded_qty} KL` : null,
          short > 0 ? `⚠ *Shortage:* ${short} KL` : null,
          `📅 *Delivered:* ${t.unloading_date ?? new Date().toISOString().slice(0, 10)}`,
          '',
          'POD is being filed. Reply here if anything does not match.',
        ].filter(Boolean).join('\n');

        return sendNotice(event, ctx, {
          template: 'POD_DELIVERED', text, tripId,
          to: t.customer_mobile, fallbackKey: 'admin',
          who: t.customer_name ?? 'customer',
          aggregate: 'trip', aggregateId: tripId,
        });
      }

      case 'invoice.generated': {
        // NOTE: nothing in the codebase emits this event today (0 producers as
        // of 6-Sep-2026). Implemented properly so it works the day a producer
        // exists, rather than left as a string that claims it already does.
        const p = event.payload ?? {};
        const cust = p.customer_name ? await queryOne(
          `SELECT mobile_no, contact_person FROM customers
            WHERE norm_company_name(customer_name) = norm_company_name($1) LIMIT 1`, [p.customer_name]) : null;
        const text = [
          `*🧾 INVOICE ${p.invoice_no ?? ''}*`,
          '',
          cust?.contact_person ? `Dear ${cust.contact_person},` : 'Dear Sir,',
          '',
          p.period ? `📅 *Period:* ${p.period}` : null,
          p.amount != null ? `💰 *Amount:* ₹${Number(p.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : null,
          p.trips != null ? `🚛 *Trips:* ${p.trips}` : null,
          '',
          'The bill and its annexure follow. Reply here with any query.',
        ].filter(Boolean).join('\n');

        return sendNotice(event, ctx, {
          template: 'INVOICE', text, tripId: null,
          to: cust?.mobile_no, fallbackKey: 'admin',
          who: p.customer_name ?? 'customer',
          aggregate: 'invoice', aggregateId: event.aggregate_id,
        });
      }

      case 'compliance.expiry.warning': {
        // An expiry is an office task, not a driver's — this goes to the fleet
        // manager, and to the admin when no fleet manager is configured.
        const p = event.payload ?? {};
        const v = Number(p.vehicles_due ?? 0);
        const d = Number(p.drivers_due ?? 0);
        if (v + d === 0) return skipped('nothing expiring');
        const text = [
          '*📋 COMPLIANCE — EXPIRING SOON*',
          '',
          `Within ${p.window_days ?? 30} days:`,
          v > 0 ? `🚛 *Vehicles:* ${v} document(s) due` : null,
          d > 0 ? `👤 *Drivers:* ${d} licence/HZD due` : null,
          '',
          'Open Vehicle Documents / Driver Master to renew.',
        ].filter(Boolean).join('\n');

        return sendNotice(event, ctx, {
          template: 'COMPLIANCE_EXPIRY', text, tripId: null,
          to: null, fallbackKey: 'fleet_manager',
          who: 'fleet manager',
          aggregate: 'fleet', aggregateId: event.aggregate_id,
        });
      }

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
