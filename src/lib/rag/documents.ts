// 📄 Turn ERP Firestore records into concise text chunks for retrieval.
// Read-only: we never write back. Field access is defensive (messy schemas).

export interface RagDoc {
  id: string;          // `${collection}:${docId}`
  collection: string;
  text: string;        // what gets embedded + shown to the model
  meta: Record<string, any>;
}

const g = (o: any, keys: string[]): string => {
  for (const k of keys) {
    const hit = Object.keys(o || {}).find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (hit && o[hit] != null && String(o[hit]).trim() !== '') return String(o[hit]);
  }
  return '';
};

function tripText(d: any): string {
  const id = g(d, ['trip_id', 'Trip_ID']);
  const veh = g(d, ['vehicle_no', 'Vehical_No', 'vehical_no']);
  const drv = g(d, ['driver_name', 'Driver_Name']);
  const from = g(d, ['loading_point', 'Loading_Point']);
  const to = g(d, ['consignee_name', 'Consignee_Name']);
  const cust = g(d, ['customer_name', 'Customer', 'Registered_Assessee']);
  const status = g(d, ['trip_status', 'Trip_Status']) || 'UNKNOWN';
  const date = g(d, ['start_date', 'Loading_Date', 'loading_date']);
  const rtkm = g(d, ['rtkm', 'RTKM']);
  const product = g(d, ['product_type', 'Product_Type']);
  const qty = g(d, ['loaded_qty', 'Loaded_Qty']);
  const op = g(d, ['operating_company', 'Operating_Company']);
  return `TRIP ${id}: vehicle ${veh}, driver ${drv}, route ${from} to ${to}, customer ${cust}, product ${product} qty ${qty}, status ${status}, RTKM ${rtkm}, date ${date}, company ${op}`.replace(/\s+/g, ' ').trim();
}

function vehicleText(d: any): string {
  const no = g(d, ['Vehicle_No', 'vehicle_no', 'vehical_no']);
  const owner = g(d, ['owner_name']);
  const company = g(d, ['company_name']);
  const drv = g(d, ['driver_name']);
  const status = g(d, ['status']);
  const fuel = g(d, ['fuel']);
  const ins = g(d, ['insurance_validity']);
  const tax = g(d, ['tax_validity']);
  const permit = g(d, ['national_permit_validity']);
  const poll = g(d, ['pollution_validity']);
  const fit = g(d, ['fitness_validity', 'explosive_validity']);
  return `VEHICLE ${no}: owner ${owner}, company ${company}, driver ${drv}, status ${status}, fuel ${fuel}. Document validity — insurance ${ins}, tax ${tax}, national permit ${permit}, pollution ${poll}, fitness/explosive ${fit}`.replace(/\s+/g, ' ').trim();
}

function driverText(d: any): string {
  const name = g(d, ['name', 'driver_name']);
  const mob = g(d, ['mobile', 'mobile_no', 'phone']);
  const dl = g(d, ['license_no', 'dl_no']);
  const dlExp = g(d, ['license_expiry', 'dl_expiry_date', 'dl_validity']);
  const status = g(d, ['status', 'approval_status']);
  return `DRIVER ${name}: mobile ${mob}, licence ${dl} expiry ${dlExp}, status ${status}`.replace(/\s+/g, ' ').trim();
}

function ledgerText(d: any): string {
  const name = g(d, ['party_name', 'name', 'ledger_name', 'Party']);
  const type = g(d, ['type', 'group', 'ledger_type']);
  const bal = g(d, ['current_balance', 'balance', 'closing_balance']);
  return `LEDGER ${name}: type ${type}, balance ${bal}`.replace(/\s+/g, ' ').trim();
}

function genericText(coll: string, d: any): string {
  const parts = Object.entries(d)
    .filter(([k, v]) => k !== 'id' && v != null && typeof v !== 'object' && String(v).trim() !== '')
    .slice(0, 12)
    .map(([k, v]) => `${k}: ${v}`);
  return `${coll} — ${parts.join(', ')}`.slice(0, 600);
}

const BUILDERS: Record<string, (d: any) => string> = {
  TRIPS: tripText,
  VEHICLES: vehicleText,
  DRIVERS: driverText,
  LEDGERS: ledgerText,
};

export function buildDoc(collection: string, docId: string, data: any): RagDoc {
  const builder = BUILDERS[collection];
  const text = builder ? builder(data) : genericText(collection, data);
  return { id: `${collection}:${docId}`, collection, text, meta: { docId } };
}
