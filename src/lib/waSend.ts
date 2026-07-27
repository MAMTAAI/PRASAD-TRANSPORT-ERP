// @ts-nocheck
// 💬 UNIVERSAL DUAL-MODE WHATSAPP SENDER — one helper for every ERP module.
//
//  Mode 1 (primary): PRASAD PRO server auto-send — the central engine sends the
//    message itself with the logged-in user's footprint (sentByUserId/Name)
//    logged to Firestore WA_CHATS/WA_LOGS. Local engine first, cloud fallback.
//  Mode 2 (fallback / mobile): wa.me deep link — opens the device's native
//    WhatsApp (mobile app or WhatsApp Web on desktop) with number + message
//    pre-filled. Used automatically whenever no engine is ONLINE, so staff on
//    phones are never blocked.
//
//  const r = await sendWhatsApp({ phone, message, tripId });
//  r.via === 'server' → already delivered;  'deeplink' → phone WhatsApp opened.

const WA_LOCAL = 'http://localhost:5001';
const WA_CLOUD = 'https://prasad-api.onrender.com';

// 🔐 P0: optional shared secret for the hardened engine (WA_ENGINE_TOKEN on the
// server side). Empty = gate disabled on the engine too, header simply omitted.
const WA_TOKEN = ((import.meta as any).env?.VITE_WA_ENGINE_TOKEN as string) || '';
export const waHeaders = (): Record<string, string> =>
  WA_TOKEN ? { 'X-PT-Token': WA_TOKEN } : {};

const normPhone = (p: any) => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  return d;
};

const erpUser = () => {
  try {
    const u = JSON.parse(localStorage.getItem('prasad_user') || '{}');
    return { id: u.email || u.id || u.uid || 'unknown', name: u.full_name || u.name || 'Admin' };
  } catch { return { id: 'unknown', name: 'Admin' }; }
};

/** wa.me universal link for a number+message (empty number → share-only link). */
export const waDeepLink = (phone: any, message: string) => {
  const n = normPhone(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(message || '')}`;
};

/** Open the device's native WhatsApp (mobile app / WhatsApp Web) pre-filled.
 *  window.open can be popup-blocked once the click's transient activation
 *  expires (~5s) — fall back to same-tab navigation, which mobile browsers
 *  bounce straight into the WhatsApp app. */
export const openWaDeepLink = (phone: any, message: string) => {
  const url = waDeepLink(phone, message);
  const w = window.open(url, '_blank');
  if (!w) window.location.assign(url);
};

// ⚡ Engine health cache — the send decision must happen INSIDE the click's
// activation window, so we probe /api/status in the background (15s TTL)
// instead of burning seconds on doomed send attempts.
let engineCache: { at: number; base: string | null } = { at: 0, base: null };
const probeStatus = async (base: string, ms: number) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${base}/api/status`, { signal: ctl.signal, headers: waHeaders() });
    const j = await res.json();
    return j && j.connected === true;
  } catch { return false; }
  finally { clearTimeout(t); }
};
const getOnlineEngine = async (): Promise<string | null> => {
  if (Date.now() - engineCache.at < 15000) return engineCache.base;
  let base = null;
  if (await probeStatus(WA_LOCAL, 1200)) base = WA_LOCAL;
  else if (await probeStatus(WA_CLOUD, 3000)) base = WA_CLOUD;
  engineCache = { at: Date.now(), base };
  return base;
};

const post = async (base: string, payload: any, ms: number) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${base}/api/send-whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...waHeaders() },
      body: JSON.stringify(payload), signal: ctl.signal,
    });
    const out = await res.json().catch(() => ({}));
    return res.ok && out.success !== false;
  } catch { return false; }
  finally { clearTimeout(t); }
};

export interface WaResult { via: 'server' | 'deeplink'; }

/** Dual-mode send. Server auto-send (with audit footprint) when an engine is
 *  ONLINE; otherwise opens the wa.me deep link so the user sends from their
 *  own WhatsApp. Never throws — messaging must never block operations. */
export async function sendWhatsApp(
  { phone, message, tripId, role }: { phone: any; message: string; tripId?: string; role?: string }
): Promise<WaResult> {
  const n = normPhone(phone);
  if (!n || n.length < 11) { openWaDeepLink(phone, message); return { via: 'deeplink' }; }
  const u = erpUser();
  const payload = {
    userId: u.name, number: n, message,
    tripId: tripId || null, role: role || null,
    sentByUserId: u.id, sentByUserName: u.name, // 👣 audit footprint
  };
  const engine = await getOnlineEngine(); // instant when cache warm
  if (engine && await post(engine, payload, 10000)) return { via: 'server' };
  openWaDeepLink(n, message);
  return { via: 'deeplink' };
}

// Warm the engine cache at module load so the FIRST click also decides
// instantly (inside the popup-safe activation window).
getOnlineEngine().catch(() => {});

/** Standard feedback line for alerts/toasts after sendWhatsApp(). */
export const waResultText = (r: WaResult) =>
  r.via === 'server'
    ? '✅ WhatsApp PRASAD PRO se auto-send ho gaya (aapke naam ke saath logged).'
    : '📱 Aapka WhatsApp khul gaya — message ready hai, bas Send dabayein.';
