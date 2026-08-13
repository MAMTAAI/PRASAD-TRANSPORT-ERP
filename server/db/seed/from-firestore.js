// server/db/seed/from-firestore.js
// ─────────────────────────────────────────────────────────────────────────────
// Firestore → PostgreSQL data loader.
//
//   node server/db/seed/from-firestore.js            load newest backup
//   node server/db/seed/from-firestore.js --dry-run  parse + report, write nothing
//   node server/db/seed/from-firestore.js --file backups/firestore-backup-X.json
//
// Properties that matter more than speed:
//   • IDEMPOTENT — every row keys on legacy_id with ON CONFLICT DO UPDATE, so
//     re-running against a fresher export refreshes rows instead of duplicating.
//   • LOSSLESS — the legacy data spells one fact three ways (Vehical_No /
//     Vehicle_No / vehicle_no); the mappers coalesce, and anything that had to
//     be repaired to satisfy a constraint is written to the migration report
//     AND stamped into the row's remarks. No silent fixes.
//   • TRANSACTIONAL — one transaction per collection; a mapper bug rolls back
//     that collection, not the half of it that got through.
//   • READ-ONLY at the source — this script never writes to Firestore.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { initDb, withTransaction, query, closePool } from '../pool.js';

const DRY = process.argv.includes('--dry-run');
const fileArg = process.argv.indexOf('--file');
const BACKUPS_DIR = join(process.cwd(), 'backups');

// ── migration report ────────────────────────────────────────────────────────
const report = { source: null, started_at: new Date().toISOString(), collections: {}, repairs: [], skipped: [] };
const repair = (coll, legacyId, what) => report.repairs.push({ coll, legacyId, what });
const skip = (coll, legacyId, why) => report.skipped.push({ coll, legacyId, why });

// ── source ──────────────────────────────────────────────────────────────────
function newestBackup() {
  const files = readdirSync(BACKUPS_DIR).filter((f) => /^firestore-backup-.*\.json$/.test(f)).sort();
  if (!files.length) throw new Error(`no firestore-backup-*.json in ${BACKUPS_DIR}`);
  return join(BACKUPS_DIR, files[files.length - 1]);
}

// ── field helpers ───────────────────────────────────────────────────────────
/** Coalesce across the legacy spelling variants; '' counts as absent. */
const g = (o, keys, dflt = null) => {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return dflt;
};
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const boolOrNull = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
/** Firestore date: 'YYYY-MM-DD' string, DD-MM-YYYY string, or {_seconds}. */
function isoDate(v) {
  if (!v) return null;
  if (typeof v === 'object' && v._seconds) return new Date(v._seconds * 1000).toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (dmy) {
    const yyyy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${yyyy}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const iso = new Date(t).toISOString().slice(0, 10);
  // Typo years in the source ('12025-12-01') must not become +012025-12-01.
  const year = Number(iso.slice(0, 4));
  return /^\d{4}-/.test(iso) && year >= 1990 && year <= 2100 ? iso : null;
}
function isoTs(v) {
  if (!v) return null;
  if (typeof v === 'object' && v._seconds) return new Date(v._seconds * 1000).toISOString();
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) return null;
  const iso = new Date(t).toISOString();
  const year = Number(iso.slice(0, 4));
  return year >= 1990 && year <= 2100 ? iso : null;
}
const cleanMobile = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
};
const normReg = (v) => String(v ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const drcr = (v) => (/dr/i.test(String(v)) ? 'DR' : /cr/i.test(String(v)) ? 'CR' : null);

// PBKDF2 in the exact format src/lib/passwords.ts verifies (100k, SHA-256).
function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(String(plain), salt, 100000, 32, 'sha256');
  return { saltHex: salt.toString('hex'), hashHex: hash.toString('hex') };
}

// Vehicle-specific upsert — natural key is the normalised registration.
async function upsertVehicle(tx, row) {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  const vals = cols.map((c) => row[c]);
  const ph = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.map((c) => `${c} = EXCLUDED.${c}`);
  const { rows } = await tx.query(
    `INSERT INTO vehicles (${cols.join(',')}) VALUES (${ph.join(',')})
     ON CONFLICT (vehicle_no_norm) DO UPDATE SET ${updates.join(',')}
     RETURNING id`,
    vals
  );
  return rows[0].id;
}

// Driver-specific upsert. Doc ids churn across exports like vehicles', but a
// driver has no single perfect natural key — so adoption order is: legacy_id,
// then ACTIVE mobile, then normalised licence. Whichever existing row matches
// first is updated in place and adopts the newest doc id.
async function upsertDriver(tx, row) {
  const existing = await tx.query(
    `SELECT id FROM drivers
      WHERE legacy_id = $1
         OR (status = 'ACTIVE' AND mobile = $2 AND $2 <> '0000000000')
         OR (status <> 'ARCHIVED' AND license_no_norm = norm_reg($3))
      ORDER BY (legacy_id = $1) DESC
      LIMIT 1`,
    [row.legacy_id, row.mobile, row.license_no]
  );
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  if (existing.rows.length) {
    const sets = cols.map((c, i) => `${c} = $${i + 2}`);
    await tx.query(
      `UPDATE drivers SET ${sets.join(',')} WHERE id = $1`,
      [existing.rows[0].id, ...cols.map((c) => row[c])]
    );
    return existing.rows[0].id;
  }
  const ph = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await tx.query(
    `INSERT INTO drivers (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING id`,
    cols.map((c) => row[c])
  );
  return rows[0].id;
}

async function insertOnly(tx, table, row) {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  const ph = cols.map((_, i) => `$${i + 1}`);
  await tx.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')})
     ON CONFLICT (legacy_id) DO NOTHING`,
    cols.map((c) => row[c])
  );
}

// ── generic upsert ──────────────────────────────────────────────────────────
async function upsert(tx, table, row) {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  const vals = cols.map((c) => row[c]);
  const ph = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter((c) => c !== 'legacy_id').map((c) => `${c} = EXCLUDED.${c}`);
  const { rows } = await tx.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')})
     ON CONFLICT (legacy_id) DO UPDATE SET ${updates.join(',')}
     RETURNING id`,
    vals
  );
  return rows[0].id;
}

// ── collection walkers ──────────────────────────────────────────────────────
const docsOf = (colls, name) =>
  Object.entries(colls[name] ?? {}).map(([id, d]) => ({ legacyId: id, ...(d.__data__ ?? d) }));

// Cross-collection id maps, built as we load.
const maps = {
  companies: new Map(), users: new Map(), vehicles: new Map(), vehiclesByNo: new Map(),
  drivers: new Map(), driversByName: new Map(), customers: new Map(), customersByName: new Map(),
  vendors: new Map(), trips: new Map(), ledgers: new Map(),
};

// ═════════════════════════════════════════════════════════════════════════
// Mappers — one per collection, in dependency order.
// ═════════════════════════════════════════════════════════════════════════

async function loadCompanies(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'COMPANIES')) {
    let gstin = String(g(d, ['gstin']) ?? '').toUpperCase() || null;
    if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}$/.test(gstin)) {
      repair('COMPANIES', d.legacyId, `malformed gstin '${gstin}' → NULL`);
      gstin = null;
    }
    const id = await upsert(tx, 'companies', {
      legacy_id: d.legacyId,
      company_name: g(d, ['company_name'], `Company ${d.legacyId}`),
      tagline: g(d, ['tagline']), gstin, pan_no: g(d, ['pan_no']),
      tds_tan: g(d, ['tds_tan']), email: g(d, ['email']), phone: g(d, ['phone']),
      address: g(d, ['address']), city: g(d, ['city']), state: g(d, ['state']),
      pincode: g(d, ['pincode']), bank_name: g(d, ['bank_name']),
      account_no: g(d, ['account_no']), ifsc_code: g(d, ['ifsc_code']),
      logo_url: g(d, ['logo_url']), gst_pdf_url: g(d, ['gst_pdf_url']), pan_pdf_url: g(d, ['pan_pdf_url']),
    });
    maps.companies.set(d.legacyId, id);
    n++;
  }
  return n;
}

const ROLE_MAP = { SUPER_ADMIN: 'SUPER_ADMIN', SUPERADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', ACCOUNTS: 'ACCOUNTS', DISPATCH: 'DISPATCH', DRIVER: 'DRIVER', CUSTOMER: 'CUSTOMER' };
async function loadUsers(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'USERS')) {
    const rawRole = String(g(d, ['role'], 'VIEWER')).toUpperCase().replace(/\s+/g, '_');
    const role = ROLE_MAP[rawRole] ?? 'VIEWER';
    if (!ROLE_MAP[rawRole]) repair('USERS', d.legacyId, `unknown role '${d.role}' → VIEWER`);

    // The legacy password field is PLAINTEXT (10–11 chars in the snapshot).
    // It is hashed here — PBKDF2-SHA256-100000, the app's existing format — and
    // the plaintext never reaches PostgreSQL.
    const plain = g(d, ['password']);
    let password_hash = 'MIGRATION-RESET-REQUIRED';
    if (plain && String(plain).length < 40) {
      const { saltHex, hashHex } = hashPassword(plain);
      password_hash = `PBKDF2-SHA256-100000$${saltHex}$${hashHex}`;
    } else if (plain) {
      password_hash = String(plain); // already a hash — carry as-is
    } else {
      repair('USERS', d.legacyId, 'no password on record → login requires reset');
    }

    let permissions = g(d, ['permissions'], {});
    // Legacy permissions are an ARRAY of grant objects; the schema requires an
    // object. Wrapped, not reshaped — the UI's reader is updated at repoint time.
    if (Array.isArray(permissions)) permissions = { grants: permissions };

    const id = await upsert(tx, 'users', {
      legacy_id: d.legacyId,
      full_name: g(d, ['full_name', 'name'], 'Unknown User'),
      email: g(d, ['email']),
      mobile: cleanMobile(g(d, ['mobile'])),
      password_hash, role,
      permissions: JSON.stringify(permissions),
      scope: g(d, ['scope']), branch: g(d, ['branch']), city: g(d, ['city']), state: g(d, ['state']),
      status: String(g(d, ['status'], 'ACTIVE')).toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    });
    maps.users.set(d.legacyId, id);
    n++;
  }
  return n;
}

async function loadCustomers(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'CUSTOMERS')) {
    const name = g(d, ['customer_name', 'name']);
    if (!name) { skip('CUSTOMERS', d.legacyId, 'no customer_name'); continue; }
    const id = await upsert(tx, 'customers', {
      legacy_id: d.legacyId,
      customer_code: g(d, ['customer_id']),
      customer_name: name,
      address: g(d, ['address']), state: g(d, ['state']), pincode: g(d, ['pincode']),
      gst_no: g(d, ['gst_no']), pan_no: g(d, ['pan_no']),
      contact_person: g(d, ['contact_person']), mobile_no: cleanMobile(g(d, ['mobile_no'])),
      email: g(d, ['email']), payment_terms: g(d, ['payment_terms']),
      opening_balance: num(g(d, ['opening_balance'])) ?? 0,
      current_outstanding: num(g(d, ['current_outstanding'])) ?? 0,
      total_freight: num(g(d, ['total_freight'])) ?? 0,
      total_received: num(g(d, ['total_received'])) ?? 0,
      total_shortage: num(g(d, ['total_shortage'])) ?? 0,
      total_tds: num(g(d, ['total_tds'])) ?? 0,
      consignees: JSON.stringify(g(d, ['consignees'], [])),
      locations: JSON.stringify(g(d, ['locations'], [])),
      portal_features: JSON.stringify(g(d, ['portal_features'], {})),
    });
    maps.customers.set(d.legacyId, id);
    maps.customersByName.set(name.trim().toUpperCase(), id);
    n++;
  }
  return n;
}

async function loadVendors(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'VENDORS')) {
    const id = await upsert(tx, 'vendors', {
      legacy_id: d.legacyId,
      vendor_name: g(d, ['vendor_name'], `Vendor ${d.legacyId}`),
      vendor_type: g(d, ['vendor_type']), contact_person: g(d, ['contact_person']),
      mobile_no: cleanMobile(g(d, ['mobile_no'])), address: g(d, ['address']),
      gst_no: g(d, ['gst_no']), bank_account: g(d, ['bank_account']), ifsc_code: g(d, ['ifsc_code']),
      opening_balance: num(g(d, ['opening_balance'])) ?? 0,
      current_balance: num(g(d, ['current_balance'])) ?? 0,
    });
    maps.vendors.set(d.legacyId, id);
    n++;
  }
  return n;
}

async function loadVehicles(tx, colls) {
  let n = 0;
  const seen = new Map(); // norm → legacyId, to catch duplicate registrations
  for (const d of docsOf(colls, 'VEHICLES')) {
    const vehicleNo = g(d, ['Vehicle_No', 'vehicle_no']);
    if (!vehicleNo) { skip('VEHICLES', d.legacyId, 'no Vehicle_No'); continue; }
    const norm = normReg(vehicleNo);
    if (seen.has(norm)) {
      skip('VEHICLES', d.legacyId, `duplicate of ${seen.get(norm)} ('${vehicleNo}')`);
      maps.vehicles.set(d.legacyId, maps.vehiclesByNo.get(norm)); // alias to the kept row
      continue;
    }
    seen.set(norm, d.legacyId);
    // Conflict on the REGISTRATION, not the doc id: Firestore doc ids churn
    // when a vehicle is deleted and re-created at source, but AS19C8666 is the
    // same physical truck forever. legacy_id follows the newest source doc.
    const id = await upsertVehicle(tx, {
      legacy_id: d.legacyId,
      vehicle_no: String(vehicleNo).trim(),
      vehicle_type: 'TANKER',           // fleet is petroleum tankers; refine per-vehicle later
      owner_name: g(d, ['owner_name']),
      make_model: g(d, ['make_model']), chassis_no: g(d, ['chassis_no', 'chassis']),
      engine_no: g(d, ['engine_no']),
      capacity_kl: num(g(d, ['capacity_kl', 'capacityKl'])),
      insurance_expiry: isoDate(g(d, ['insurance_expiry'])),
      fitness_expiry: isoDate(g(d, ['fitness_expiry'])),
      permit_expiry: isoDate(g(d, ['permit_expiry'])),
      puc_expiry: isoDate(g(d, ['puc_expiry'])),
      tax_expiry: isoDate(g(d, ['tax_expiry'])),
      rc_photo_url: g(d, ['rc_photo_url']),
    });
    maps.vehicles.set(d.legacyId, id);
    maps.vehiclesByNo.set(norm, id);
    n++;
  }
  return n;
}

async function loadDrivers(tx, colls) {
  let n = 0;
  const activeMobiles = new Map();
  const seenLicenses = new Map();
  for (const d of docsOf(colls, 'DRIVERS')) {
    const name = g(d, ['name'], `Driver ${d.legacyId}`);
    const remarksBits = [];

    let mobile = cleanMobile(g(d, ['mobile']));
    if (!mobile) {
      mobile = '0000000000';
      remarksBits.push('MIGRATION: mobile missing/invalid in source');
      repair('DRIVERS', d.legacyId, `invalid mobile '${d.mobile}' → placeholder + remark`);
    }

    let status = 'ACTIVE';
    if (activeMobiles.has(mobile) && mobile !== '0000000000') {
      status = 'INACTIVE';
      remarksBits.push(`MIGRATION: mobile duplicates driver ${activeMobiles.get(mobile)} — marked INACTIVE, review`);
      repair('DRIVERS', d.legacyId, `duplicate mobile ${mobile} → INACTIVE`);
    } else {
      activeMobiles.set(mobile, name);
    }
    // Placeholder mobiles collide on the partial-unique index; only one may stay ACTIVE.
    if (mobile === '0000000000' && activeMobiles.has(mobile)) status = 'INACTIVE';
    activeMobiles.set(mobile, name);

    let license = g(d, ['license_no']);
    if (!license) {
      license = `MIGRATION-UNKNOWN-${d.legacyId.slice(0, 8)}`;
      remarksBits.push('MIGRATION: licence number missing in source');
      repair('DRIVERS', d.legacyId, 'missing license_no → placeholder + remark');
    }
    const licNorm = normReg(license);
    if (seenLicenses.has(licNorm)) {
      status = 'INACTIVE';
      remarksBits.push(`MIGRATION: licence duplicates ${seenLicenses.get(licNorm)} — INACTIVE, review`);
      repair('DRIVERS', d.legacyId, `duplicate licence ${license} → INACTIVE`);
    } else if (status === 'ACTIVE') {
      seenLicenses.set(licNorm, name);
    }

    let hzdCert = g(d, ['hzd_cert_no']);
    const hzdExpiry = isoDate(g(d, ['hzd_expiry']));
    if (hzdCert && !hzdExpiry) {
      remarksBits.push(`MIGRATION: hazmat cert '${hzdCert}' had no expiry — cert cleared, review`);
      repair('DRIVERS', d.legacyId, 'hzd cert without expiry → cleared + remark');
      hzdCert = null;
    }

    let aadhar = String(g(d, ['aadhar_no']) ?? '').replace(/\D/g, '') || null;
    if (aadhar && aadhar.length !== 12) { repair('DRIVERS', d.legacyId, `aadhar '${aadhar}' not 12 digits → NULL`); aadhar = null; }
    let ifsc = String(g(d, ['ifsc_code']) ?? '').toUpperCase() || null;
    if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) { repair('DRIVERS', d.legacyId, `ifsc '${ifsc}' malformed → NULL`); ifsc = null; }

    const approval = String(g(d, ['approval_status'], 'PENDING')).toUpperCase();
    const id = await upsertDriver(tx, {
      legacy_id: d.legacyId,
      name, mobile, status,
      address: g(d, ['address']), profile_pic_url: g(d, ['profile_pic']),
      license_no: license, license_expiry: isoDate(g(d, ['license_expiry'])),
      dl_photo_url: g(d, ['dl_photo']),
      hzd_cert_no: hzdCert, hzd_expiry: hzdCert ? hzdExpiry : null, hzd_photo_url: g(d, ['hzd_photo']),
      aadhar_no: aadhar, aadhar_photo_url: g(d, ['aadhar_photo']),
      pan_no: g(d, ['pan_no']), pan_photo_url: g(d, ['pan_photo']),
      bank_name: g(d, ['bank_name']), account_no: g(d, ['account_no']), ifsc_code: ifsc,
      bank_photo_url: g(d, ['bank_photo']),
      guarantor_name: g(d, ['guarantor_name']), guarantor_mobile: cleanMobile(g(d, ['guarantor_mobile'])),
      join_date: isoDate(g(d, ['join_date'])),
      approval_status: ['PENDING', 'APPROVED', 'REJECTED'].includes(approval) ? approval : 'PENDING',
      remarks: remarksBits.length ? remarksBits.join(' | ') : null,
    });
    maps.drivers.set(d.legacyId, id);
    maps.driversByName.set(name.trim().toUpperCase(), id);
    n++;
  }
  return n;
}

async function loadAssignments(tx, colls) {
  // The export is a point-in-time snapshot of who-drives-what. Refresh
  // semantics: close every currently-ACTIVE link first (history is preserved
  // as ENDED rows), then the snapshot's own picks become the ACTIVE set. This
  // keeps re-loads deterministic even when doc ids churned at source.
  await tx.query(
    `UPDATE vehicle_assignments
        SET state = 'ENDED', released_at = GREATEST(assigned_at, now()),
            remarks = COALESCE(remarks, 'MIGRATION: closed by snapshot refresh')
      WHERE state = 'ACTIVE'`
  );
  // Newest assignment per vehicle AND per driver stays ACTIVE; earlier ones
  // are closed as ENDED history.
  const rows = docsOf(colls, 'Vehicle_Assignments')
    .map((d) => ({
      d,
      vehicleId: maps.vehicles.get(g(d, ['vehicleId'])),
      driverId: maps.drivers.get(g(d, ['driverId'])),
      at: isoTs(g(d, ['assignedAt', 'assignDate'])) ?? '1970-01-01T00:00:00Z',
    }))
    .filter((r) => {
      if (!r.vehicleId || !r.driverId) { skip('Vehicle_Assignments', r.d.legacyId, 'vehicle or driver unresolved'); return false; }
      return true;
    })
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  const activeVehicle = new Set();
  const activeDriver = new Set();
  let n = 0;
  for (const r of rows.reverse()) { // newest first claims ACTIVE
    const canBeActive = !activeVehicle.has(r.vehicleId) && !activeDriver.has(r.driverId);
    if (canBeActive) { activeVehicle.add(r.vehicleId); activeDriver.add(r.driverId); }
    else repair('Vehicle_Assignments', r.d.legacyId, 'older/conflicting link → ENDED');
    await upsert(tx, 'vehicle_assignments', {
      legacy_id: r.d.legacyId,
      vehicle_id: r.vehicleId, driver_id: r.driverId,
      assigned_at: r.at,
      state: canBeActive ? 'ACTIVE' : 'ENDED',
      released_at: canBeActive ? null : r.at,
      remarks: canBeActive ? null : 'MIGRATION: superseded by a newer assignment',
    });
    n++;
  }
  return n;
}

async function loadRtkm(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'RTKM_MASTER')) {
    await upsert(tx, 'rtkm_master', {
      legacy_id: d.legacyId,
      customer_name: g(d, ['Customer', 'customer_name'], 'UNKNOWN'),
      registered_assessee: g(d, ['Registered_Assessee']),
      depot_link: g(d, ['Depot_Link', 'depot_link']),
      consignee_id: g(d, ['Consignee_ID']),
      consignee_name: g(d, ['Consignee_Name', 'consignee_name'], 'UNKNOWN'),
      vehicle_capacity: g(d, ['Vehicle_Capacity', 'vehicle_capacity']),
      item_type: g(d, ['Item_Type', 'item_type']),
      rtkm_distance: num(g(d, ['RTKM_Distance', 'rtkm_distance'])),
      fixed_hsd_qty: num(g(d, ['Fixed_HSD_Qty', 'Fixed_HSD', 'fixed_hsd'])),
      fixed_cash_amt: num(g(d, ['Fixed_Cash_Amt', 'Fixed_Cash', 'fixed_cash'])),
      toll_amt: num(g(d, ['Toll_Amt', 'toll_amt'])),
      status: /inactive/i.test(String(g(d, ['Status', 'status'], 'Active'))) ? 'INACTIVE' : 'ACTIVE',
    });
    n++;
  }
  return n;
}

async function loadTrips(tx, colls) {
  let n = 0;
  const seenCodes = new Set();
  for (const d of docsOf(colls, 'TRIPS')) {
    const vehicleNo = g(d, ['vehicle_no', 'Vehicle_No', 'Vehical_No']);
    const customerName = g(d, ['customer_name', 'Customer']);
    const driverName = g(d, ['driver_name', 'Driver_Name']);
    const loaded = num(g(d, ['loaded_qty', 'Loaded_Qty']));
    const rate = num(g(d, ['Rate', 'rate']));
    const status = String(g(d, ['trip_status'], 'COMPLETED')).toUpperCase();

    // Real defect in the source: 'GP00026' is stamped on 10 different trips.
    // First doc keeps the code; duplicates carry it in remarks instead, so the
    // human reference survives without breaking code uniqueness.
    let tripCode = g(d, ['trip_id', 'Trip_ID']);
    let remarks = g(d, ['remarks']);
    if (tripCode && seenCodes.has(tripCode)) {
      repair('TRIPS', d.legacyId, `duplicate trip code '${tripCode}' → moved to remarks`);
      remarks = [`MIGRATION: source trip code '${tripCode}' duplicated another trip`, remarks].filter(Boolean).join(' | ');
      tripCode = null;
    } else if (tripCode) {
      seenCodes.add(tripCode);
    }

    await upsert(tx, 'trips', {
      legacy_id: d.legacyId,
      trip_code: tripCode,
      operating_company: g(d, ['operating_company', 'Operating_Company']),
      status: ['PENDING', 'LOADED', 'IN_TRANSIT', 'UNLOADING', 'COMPLETED', 'SETTLED', 'CANCELLED'].includes(status) ? status : 'COMPLETED',
      customer_id: customerName ? maps.customersByName.get(customerName.trim().toUpperCase()) ?? null : null,
      customer_name: customerName,
      registered_assessee: g(d, ['Registered_Assessee']),
      consignee_name: g(d, ['consignee_name', 'Consignee_Name']),
      vehicle_id: vehicleNo ? maps.vehiclesByNo.get(normReg(vehicleNo)) ?? null : null,
      vehicle_no: vehicleNo,
      driver_id: driverName ? maps.driversByName.get(driverName.trim().toUpperCase()) ?? null : null,
      driver_name: driverName,
      driver_mobile: cleanMobile(g(d, ['driver_mobil_no', 'Driver_Mobil_No'])),
      loading_date: isoDate(g(d, ['loading_date', 'Loading_Date'])),
      loading_point: g(d, ['loading_point', 'Loading_Point']),
      challan_no: g(d, ['challan_no', 'Challan_No']),
      product_type: g(d, ['Product_Type', 'product_type']),
      loaded_qty: loaded,
      rtkm: num(g(d, ['RTKM', 'rtkm'])),
      rate,
      // As-billed freight when present; loaded_qty × rate is the fallback the
      // settlement UI already uses. Recorded per-row which one applied.
      freight_amount: num(g(d, ['freight_amount'])) ?? (loaded !== null && rate !== null ? +(loaded * rate).toFixed(2) : null),
      unloading_date: isoDate(g(d, ['unloading_date', 'Unloading_Date'])),
      unloading_location: g(d, ['unloading_location']),
      unloaded_qty: num(g(d, ['unloaded_qty', 'Unloaded_Qty'])),
      shortage_qty: num(g(d, ['shortage_qty', 'Shortage_Qty'])),
      shortage_penalty: num(g(d, ['shortage_penalty'])),
      unloading_remarks: g(d, ['unloading_remarks']),
      fixed_cash: num(g(d, ['fixed_cash'])),
      fixed_hsd: num(g(d, ['fixed_hsd'])),
      hsd_issued: num(g(d, ['hsd_issued'])),
      pump_cash_advance: num(g(d, ['pump_cash_advance'])),
      office_cash_paid: num(g(d, ['office_cash_paid'])),
      bank_paid: num(g(d, ['bank_paid'])),
      total_expense: num(g(d, ['total_expense'])),
      final_balance: num(g(d, ['final_balance'])),
      office_approved_loading: boolOrNull(g(d, ['office_approved_loading'])),
      office_approved_unloading: boolOrNull(g(d, ['office_approved_unloading'])),
      invoice_url: g(d, ['invoice_url', 'Invoice_URL']),
      remarks,
      completed_at: isoTs(g(d, ['completed_at'])),
      created_at: isoTs(g(d, ['created_at', 'createdAt'])) ?? new Date().toISOString(),
    });
    maps.trips.set(d.legacyId, true);
    n++;
  }
  return n;
}

async function loadFuel(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'FUEL_ENTRIES')) {
    const vehicleNo = g(d, ['vehicle_no']);
    await upsert(tx, 'fuel_entries', {
      legacy_id: d.legacyId,
      entry_date: isoDate(g(d, ['date'])),
      vehicle_id: vehicleNo ? maps.vehiclesByNo.get(normReg(vehicleNo)) ?? null : null,
      vehicle_no: vehicleNo,
      trip_legacy_id: g(d, ['trip_id']),
      route_name: g(d, ['route_name']),
      driver_name: g(d, ['driver_name']),
      vendor_id: maps.vendors.get(g(d, ['vendor_id'])) ?? null,
      vendor_name: g(d, ['vendor_name']),
      memo_no: g(d, ['memo_no']),
      fuel_type: g(d, ['fuel_type']),
      liters: num(g(d, ['liters'])),
      rate: num(g(d, ['rate'])),
      amount: num(g(d, ['amount'])),
      cash_given_to_pump: num(g(d, ['cash_given_to_pump'])),
      pump_mobile: cleanMobile(g(d, ['pump_mobile'])),
      bill_status: g(d, ['bill_status']),
    });
    n++;
  }
  // Second pass: resolve trip FKs now that trips are loaded.
  await tx.query(`
    UPDATE fuel_entries f SET trip_id = t.id
      FROM trips t
     WHERE f.trip_id IS NULL AND f.trip_legacy_id IS NOT NULL
       AND (t.legacy_id = f.trip_legacy_id OR t.trip_code = f.trip_legacy_id)`);
  return n;
}

async function loadDriverTxns(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'DRIVER_TRANSACTIONS')) {
    const driverName = g(d, ['driver_name'], 'UNKNOWN');
    await upsert(tx, 'driver_transactions', {
      legacy_id: d.legacyId,
      driver_id: maps.driversByName.get(driverName.trim().toUpperCase()) ?? null,
      driver_name: driverName,
      txn_date: isoDate(g(d, ['date'])),
      txn_type: g(d, ['txn_type']),
      amount: num(g(d, ['amount'])),
      mode: g(d, ['mode']),
      remarks: g(d, ['remarks']),
    });
    n++;
  }
  return n;
}

async function loadLedgers(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'LEDGERS')) {
    const id = await upsert(tx, 'ledgers', {
      legacy_id: d.legacyId,
      ledger_name: g(d, ['ledger_name', 'name'], `Ledger ${d.legacyId}`),
      group_head: g(d, ['group_head', 'group']),
      dr_cr: drcr(g(d, ['dr_cr'])),
      opening_balance: num(g(d, ['opening_balance', 'op_balance'])) ?? 0,
      current_balance: num(g(d, ['current_balance'])) ?? 0,
      company: g(d, ['company']), branch: g(d, ['branch']),
      creation_type: g(d, ['creation_type']),
      linked_module: g(d, ['linked_module']), linked_id: g(d, ['linked_id']),
    });
    maps.ledgers.set(d.legacyId, id);
    n++;
  }
  return n;
}

async function loadLedgerEntries(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'LEDGER_ENTRIES')) {
    const side = drcr(g(d, ['dr_cr']));
    if (!side) { skip('LEDGER_ENTRIES', d.legacyId, `unparseable dr_cr '${d.dr_cr}'`); continue; }
    const amount = num(g(d, ['amount']));
    if (amount === null || amount < 0) { skip('LEDGER_ENTRIES', d.legacyId, `bad amount '${d.amount}'`); continue; }
    const ledgerId = maps.ledgers.get(g(d, ['ledgerId'])) ?? null;
    // Denormalised name comes from the resolved ledger; unresolved ones keep a
    // traceable placeholder rather than losing the row of history.
    let ledgerName = 'MIGRATION: unresolved ledger';
    if (ledgerId) {
      const { rows } = await tx.query('SELECT ledger_name FROM ledgers WHERE id = $1', [ledgerId]);
      ledgerName = rows[0]?.ledger_name ?? ledgerName;
    } else {
      repair('LEDGER_ENTRIES', d.legacyId, `ledgerId '${d.ledgerId}' unresolved → placeholder name`);
    }
    // INSERT-ONLY: the append-only trigger (correctly) refuses UPDATE, and a
    // historical ledger row that changed at source must never silently rewrite
    // our book — new rows land, existing rows are left exactly as first loaded.
    await insertOnly(tx, 'ledger_entries', {
      legacy_id: d.legacyId,
      ledger_id: ledgerId,
      ledger_name: ledgerName,
      voucher_id: null,                    // LEGACY era — exempt from balance rule by design
      entry_date: isoDate(g(d, ['date'])) ?? '1970-01-01',
      particulars: g(d, ['particulars']),
      dr_cr: side,
      amount,
      source_type: 'LEGACY_MIGRATION',
      source_ref: g(d, ['source']),
      company: g(d, ['company']), branch: g(d, ['branch']),
      created_at: isoTs(g(d, ['created_at'])) ?? new Date().toISOString(),
    });
    n++;
  }
  return n;
}

async function loadLoans(tx, colls) {
  let n = 0;
  for (const d of docsOf(colls, 'LOAN_MASTER')) {
    await upsert(tx, 'loan_master', {
      legacy_id: d.legacyId,
      loan_account_no: g(d, ['Loan_Account_No']),
      vehicle_no: g(d, ['Vehicle_No']),
      owner_name: g(d, ['Owner_Name']),
      company_name: g(d, ['Company_Name']),
      loan_type: g(d, ['Loan_Type']),
      bank_name: g(d, ['Bank_Name']),
      sanction_date: isoDate(g(d, ['Sanction_Date'])),
      rate_of_interest: num(g(d, ['Rate_Of_Interest'])),
      principal_amt: num(g(d, ['Principal_Amt'])),
      tenure_months: intOrNull(g(d, ['Tenure_Months'])),
      emi_amount: num(g(d, ['EMI_Amount'])),
      moratorium_months: intOrNull(g(d, ['Moratorium_Months'])),
      first_emi_date: isoDate(g(d, ['First_EMI_Date'])),
      as_on_date: isoDate(g(d, ['As_On_Date'])),
      emis_completed: intOrNull(g(d, ['EMIs_Completed', 'Old_EMIs_Paid'])),
      remaining_principal: num(g(d, ['Remaining_Principal'])),
      total_interest_paid: num(g(d, ['Total_Interest_Paid'])),
      payment_status: g(d, ['Payment_Status']),
      emi_slabs: JSON.stringify(g(d, ['emi_slabs'], [])),
      repayment_schedule: JSON.stringify(g(d, ['repayment_schedule'], [])),
    });
    n++;
  }
  return n;
}

// ═════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════
const STAGES = [
  ['COMPANIES', loadCompanies], ['USERS', loadUsers], ['CUSTOMERS', loadCustomers],
  ['VENDORS', loadVendors], ['VEHICLES', loadVehicles], ['DRIVERS', loadDrivers],
  ['Vehicle_Assignments', loadAssignments], ['RTKM_MASTER', loadRtkm],
  ['TRIPS', loadTrips], ['FUEL_ENTRIES', loadFuel], ['DRIVER_TRANSACTIONS', loadDriverTxns],
  ['LEDGERS', loadLedgers], ['LEDGER_ENTRIES', loadLedgerEntries], ['LOAN_MASTER', loadLoans],
];

async function main() {
  const file = fileArg > -1 ? process.argv[fileArg + 1] : newestBackup();
  report.source = file;
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  const colls = snapshot.collections ?? snapshot;
  console.log(`[loader] source: ${file}${DRY ? '  (DRY RUN — nothing will be written)' : ''}`);

  const conn = await initDb();
  if (conn.degraded) throw new Error('database unreachable — loader refuses to run');

  // DRY RUN: everything in ONE transaction, rolled back at the very end, so
  // cross-collection FK references resolve exactly as they will in the real
  // run. (Per-collection rollback would orphan the id maps between stages.)
  const runStages = async (tx) => {
    for (const [name, fn] of STAGES) {
      const t0 = Date.now();
      const n = await fn(tx, colls);
      report.collections[name] = { loaded: n, ms: Date.now() - t0 };
      console.log(`  ✔ ${name.padEnd(22)} ${String(n).padStart(4)} rows (${Date.now() - t0}ms)`);
    }
  };

  if (DRY) {
    await withTransaction(async (tx) => { await runStages(tx); throw { __dry: true }; })
      .catch((e) => { if (!e.__dry) throw e; });
    console.log('  (dry run — transaction rolled back, database untouched)');
  } else {
    for (const [name, fn] of STAGES) {
      const t0 = Date.now();
      try {
        const n = await withTransaction((tx) => fn(tx, colls));
        report.collections[name] = { loaded: n, ms: Date.now() - t0 };
        console.log(`  ✔ ${name.padEnd(22)} ${String(n).padStart(4)} rows (${Date.now() - t0}ms)`);
      } catch (err) {
        report.collections[name] = { error: err.message };
        console.error(`  ✖ ${name} FAILED (collection rolled back): ${err.message}`);
        throw err; // later stages depend on earlier maps — stop rather than half-load
      }
    }
  }

  report.finished_at = new Date().toISOString();
  const reportFile = join(BACKUPS_DIR, `migration-report-${report.started_at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n[loader] repairs: ${report.repairs.length} · skipped: ${report.skipped.length}`);
  console.log(`[loader] full report: ${reportFile}`);

  if (!DRY) {
    // Row-count reconciliation, straight from the database.
    const { rows } = await query(`
      SELECT 'vehicles' t, count(*) n FROM vehicles UNION ALL
      SELECT 'drivers', count(*) FROM drivers UNION ALL
      SELECT 'trips', count(*) FROM trips UNION ALL
      SELECT 'customers', count(*) FROM customers UNION ALL
      SELECT 'vendors', count(*) FROM vendors UNION ALL
      SELECT 'rtkm_master', count(*) FROM rtkm_master UNION ALL
      SELECT 'fuel_entries', count(*) FROM fuel_entries UNION ALL
      SELECT 'ledgers', count(*) FROM ledgers UNION ALL
      SELECT 'ledger_entries', count(*) FROM ledger_entries UNION ALL
      SELECT 'vehicle_assignments', count(*) FROM vehicle_assignments UNION ALL
      SELECT 'driver_transactions', count(*) FROM driver_transactions UNION ALL
      SELECT 'loan_master', count(*) FROM loan_master UNION ALL
      SELECT 'users', count(*) FROM users UNION ALL
      SELECT 'companies', count(*) FROM companies
      ORDER BY 1`);
    console.log('\n[loader] PostgreSQL row counts:');
    for (const r of rows) console.log(`   ${r.t.padEnd(22)} ${r.n}`);
  }
}

main()
  .then(() => console.log('[loader] done'))
  .catch((err) => { console.error('[loader] fatal:', err.message); process.exitCode = 1; })
  .finally(closePool);
