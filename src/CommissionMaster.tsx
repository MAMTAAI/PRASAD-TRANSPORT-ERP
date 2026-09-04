// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// COMMISSION & RATE MASTER — its own screen in Accounts & Admin
//
// The rates already had a home inside Vehicle 15-Day Settlement, three tabs
// deep. That is the wrong place for a MASTER: a master is set up once, by
// somebody who is not settling a fortnight that morning, and it sits beside
// Rate Master because the two answer mirror questions — Rate Master is what we
// CHARGE the customer, this is what we KEEP out of an attached or market
// lorry's freight.
//
// It matters right now because 16 of 49 lorries are attached and none has a
// rate: 127 historical settlements across five months cannot be approved until
// somebody fills this in.
//
// The same component the settlement screen uses, so there is one editor and one
// set of rules — not two that drift.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect } from 'react';
import CommissionTerms from './settlement/CommissionTerms';
import UnmappedVehicles from './settlement/UnmappedVehicles';
import { API_BASE } from './lib/apiBase';

const API = `${API_BASE}/api/v1/vehicle-settlement`;

// Plain fetch: src/lib/authFetch.ts patches window.fetch with the bearer.
const apiJson = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.detail || j.error || `HTTP ${res.status}`), { code: j.error });
  return j;
};

export default function CommissionMaster() {
  const [tab, setTab] = useState('RATES');
  // The rate the desk almost always wants is "from the start of the data we
  // hold", because the 127 unpriced settlements run back to April. Defaulting
  // to today would price none of them and look broken.
  const [from, setFrom] = useState('2026-04-01');

  return (
    <div style={{ padding: '20px', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: 'clamp(21px, 4vw, 27px)', color: '#fff' }}>
          💼 Commission &amp; Rate Master
        </h2>
        <p style={{ color: '#9aadd4', fontSize: '12.5px', margin: '5px 0 0', maxWidth: '76ch',
                    lineHeight: 1.55 }}>
          Attached (family/partner) aur Market lorry ka freight <b style={{ color: '#eef3ff' }}>
          owner ka paisa</b> hai — usme se hamara <b style={{ color: '#2fe39b' }}>commission</b> hi
          hamari aamdani hai, aur usi par TDS kat-ta hai. Yahan rate darj kijiye;
          jab tak rate nahi, us lorry ka settlement approve nahi hoga.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
                    marginBottom: '16px' }}>
        <div style={{ display: 'flex', border: '1px solid #27395f', borderRadius: '9px',
                      overflow: 'hidden' }}>
          {[['RATES', '💹 Commission rates'], ['UNMAPPED', '🔍 Bina master ki lorry']].map((t) => (
            <button key={t[0]} onClick={() => setTab(t[0])}
              style={{ background: tab === t[0] ? 'rgba(34,211,238,0.14)' : 'transparent',
                       color: tab === t[0] ? '#22d3ee' : '#9aadd4', border: 'none',
                       padding: '9px 15px', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer' }}>
              {t[1]}
            </button>
          ))}
        </div>

        {tab === 'RATES' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto',
                          color: '#9aadd4', fontSize: '12px' }}>
            Naye rate kis tareekh se
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              style={{ background: '#0a1024', border: '1px solid #3d548a', borderRadius: '7px',
                       color: '#eef3ff', padding: '6px 9px', fontSize: '12.5px', colorScheme: 'dark' }} />
          </label>
        )}
      </div>

      {tab === 'RATES' && (
        <>
          {/* Said before they touch anything, because it is the one thing that
              silently does nothing: 1 Apr 2026 is where the trip data starts,
              so a rate dated today prices none of the 127 open settlements. */}
          <div style={{ border: '1px solid rgba(255,178,36,0.35)', background: 'rgba(255,178,36,0.06)',
                        borderRadius: '9px', padding: '11px 14px', marginBottom: '14px',
                        fontSize: '12px', color: '#c4d1ea', lineHeight: 1.6 }}>
            <b style={{ color: '#ffb224' }}>Tareekh ka dhyaan rakhiye:</b> rate <b>usi din se</b>
            {' '}lagta hai jo aap chunte hain. Humara trip data <b>1 April 2026</b> se hai, aur
            127 settlement us date se aage bina rate ke pade hain — isliye upar
            <b> 2026-04-01</b> pehle se bhara hai. Aaj ki tareekh rakhenge to purane
            fortnight par kuch nahi lagega.
          </div>
          <CommissionTerms api={API} apiJson={apiJson} defaultFrom={from} />
        </>
      )}

      {tab === 'UNMAPPED' && <UnmappedVehicles api={API} apiJson={apiJson} />}
    </div>
  );
}
