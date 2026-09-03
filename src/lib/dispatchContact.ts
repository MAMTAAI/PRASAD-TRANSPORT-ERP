// The dispatch desk's mobile — the one number the driver app dials (owner,
// 2026-09-03: "+919864001130 … tapping the button opens the phone's dialer
// with this number pre-filled"). Baked in as the default so the production
// build carries it; VITE_DISPATCH_MOBILE at build time overrides it for a
// staging or on-prem build.
const raw = String(import.meta.env?.VITE_DISPATCH_MOBILE || '9864001130').replace(/\D/g, '');
export const DISPATCH_MOBILE = raw.replace(/^91(?=\d{10}$)/, '');
export const DISPATCH_TEL = `tel:+91${DISPATCH_MOBILE}`;
export const DISPATCH_DISPLAY = `+91 ${DISPATCH_MOBILE.slice(0, 5)} ${DISPATCH_MOBILE.slice(5)}`;
