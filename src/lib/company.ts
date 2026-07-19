// 🏢 COMPANY NAME NORMALIZER — cross-module matching ka single source of truth.
// DB me wahi company 5 roop me likhi hai: 'M/S PRASAD TRANSPORT' (trips),
// 'PRASAD TRANSPORT' (bank txns), 'Prasad Transport Pvt Ltd', 'JAISWAL
// ENTERPRISE ' (trailing space), 'M/S JAISWAL ENTERPRISE  '. Exact-match
// filters in par cross-module data chupchaap gira dete the. Ye normalizer
// M/S, PVT LTD jaise legal tokens aur punctuation/extra-spaces hata kar
// compare karta hai. Pure function — Node me unit-testable.

export const normCompany = (v: any): string =>
  String(v || '')
    .toUpperCase()
    .replace(/[.,()]/g, ' ')
    .replace(/\bM\s*\/\s*S\b/g, ' ')          // M/S, M / S prefix
    .replace(/\bPVT\.?\s*LTD\.?\b/g, ' ')
    .replace(/\bPRIVATE\s+LIMITED\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** True when both names refer to the same company (normalized compare). */
export const sameCompany = (a: any, b: any): boolean => normCompany(a) === normCompany(b);

/** Filter-style match: selector 'ALL'/empty => sab; record blank/'ALL' =>
 *  har company me dikhna chahiye (missing-field row kabhi hide nahi hoti). */
export const companyMatches = (recordVal: any, filterVal: any): boolean => {
  const f = normCompany(filterVal);
  if (!f || f === 'ALL') return true;
  const r = normCompany(recordVal);
  if (!r || r === 'ALL') return true; // old/blank records: never silently dropped
  return r === f;
};
