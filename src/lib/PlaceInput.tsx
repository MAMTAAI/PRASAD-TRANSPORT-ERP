// @ts-nocheck
// ============================================================================
// <PlaceInput /> — Places Autocomplete that degrades to a plain text box.
//
// THE DEGRADE MATTERS MORE THAN THE AUTOCOMPLETE. Half this ERP's lanes are
// depot names that Google has never heard of — "BONGAIGAON RC OFFICE (7R01)",
// "MOINARBAND DEPOT (7D18)". If the component demanded a Google-resolved place
// the operator could not type the thing they actually have. So the free text is
// always accepted, the suggestions are an accelerator, and picking one is
// optional.
//
// SESSION TOKENS ARE NOT DECORATION. Autocomplete is billed per KEYSTROKE
// unless the requests are grouped by a session token, which turns a whole
// lookup into one charge. A new token is minted per lookup and thrown away the
// moment a place is chosen — reusing it across lookups is the mistake that
// makes the grouping silently stop working.
//
// THE COMPANY'S OWN LANES COME FIRST (`local`, 4-Sep-2026). The trip form used
// a plain <datalist> of the 400-odd routes in the RTKM master, because picking
// one of those is what auto-fills the round-trip km, the fixed cash and the
// fixed diesel. Swapping that for Google outright would have made the form
// prettier and the numbers stop filling in. So both lists are shown in one
// dropdown, ours above Google's and marked as ours: a route the office already
// runs is chosen in one tap, and a place nobody has been to yet is still
// findable. Choosing a local entry NEVER touches a Google session token — it
// is not a Google lookup and must not be billed as the end of one.
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadGoogleMaps } from './maps';

export default function PlaceInput({
  value, onChange, placeholder = 'Type a place…', className = '', style,
  onResolved, disabled, id, autoFocus,
  local = [],          // [{ value, hint }] — this company's own routes/depots
  localLabel = 'Apni routes',
  onPickLocal,         // (value) => void — the auto-fill the datalist used to do
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const svcRef = useRef(null);
  const tokenRef = useRef(null);
  const boxRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    let dead = false;
    loadGoogleMaps()
      .then(() => {
        if (dead) return;
        const g = window.google;
        if (!g?.maps?.places?.AutocompleteService) return;   // Places library absent
        svcRef.current = new g.maps.places.AutocompleteService();
        tokenRef.current = new g.maps.places.AutocompleteSessionToken();
        setReady(true);
      })
      .catch(() => { /* no key, no network — the plain input still works */ });
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    const onDoc = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, []);

  const ask = useCallback((text) => {
    if (!svcRef.current || text.trim().length < 3) { setSuggestions([]); return; }
    svcRef.current.getPlacePredictions(
      {
        input: text,
        sessionToken: tokenRef.current,
        // India only. A lane from "Guwahati" should not offer Guwahati, Texas.
        componentRestrictions: { country: 'in' },
      },
      (res, status) => {
        const g = window.google;
        if (status !== g.maps.places.PlacesServiceStatus.OK || !res) { setSuggestions([]); return; }
        setSuggestions(res.slice(0, 5));
        setOpen(true);
        setHighlight(-1);
      },
    );
  }, []);

  // Ours, matched on the spot — no network, no billing, so it can fire on every
  // keystroke and from the first character rather than the third.
  const hits = React.useMemo(() => {
    const q = String(value ?? '').trim().toLowerCase();
    if (!q) return (local || []).slice(0, 6);
    return (local || [])
      .filter((o) => String(o.value ?? '').toLowerCase().includes(q))
      .slice(0, 6);
  }, [local, value]);

  const type = (e) => {
    const v = e.target.value;
    onChange(v);
    if (v.trim()) setOpen(true);
    // 250ms: fast enough to feel live, slow enough that "Bongaigaon" is one
    // lookup rather than ten. Every keystroke is a billed prediction request.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => ask(v), 250);
  };

  const pickLocal = (o) => {
    onChange(o.value);
    setOpen(false);
    setSuggestions([]);
    // The route master carries the money — rtkm, fixed cash, fixed diesel — and
    // this is the callback that fills them in. Without it the dropdown looks
    // identical and quietly stops doing the only thing it was there for.
    onPickLocal?.(o.value);
  };

  const choose = (s) => {
    onChange(s.description);
    setOpen(false);
    setSuggestions([]);
    onResolved?.({ description: s.description, place_id: s.place_id });
    // Token is spent. The next lookup starts a new billing session.
    const g = window.google;
    if (g?.maps?.places?.AutocompleteSessionToken) {
      tokenRef.current = new g.maps.places.AutocompleteSessionToken();
    }
  };

  const key = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && highlight >= 0) { e.preventDefault(); choose(suggestions[highlight]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        id={id}
        value={value ?? ''}
        onChange={type}
        onKeyDown={key}
        onFocus={() => (suggestions.length || hits.length) && setOpen(true)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        className={className}
        style={style}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && (suggestions.length > 0 || hits.length > 0) && (
        <ul className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-[320px] overflow-y-auto overflow-x-hidden rounded-xl
                       border border-white/10 bg-[#0b0f18]/95 shadow-[0_20px_50px_rgba(0,0,0,0.6)] backdrop-blur-xl">
          {hits.length > 0 && (
            <li className="border-b border-white/5 bg-cyan-500/[0.06] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-300/70">
              {localLabel}
            </li>
          )}
          {hits.map((o) => (
            <li key={`local:${o.value}`}>
              <button
                type="button"
                onClick={() => pickLocal(o)}
                className="block w-full px-3 py-2.5 text-left text-[12.5px] text-white/80 transition-colors hover:bg-cyan-500/15"
              >
                <span className="block font-semibold">{o.value}</span>
                {o.hint && <span className="block text-[11px] text-cyan-200/40">{o.hint}</span>}
              </button>
            </li>
          ))}
          {suggestions.length > 0 && hits.length > 0 && (
            <li className="border-y border-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white/25">
              Google Maps
            </li>
          )}
          {suggestions.map((s, i) => (
            <li key={s.place_id}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(s)}
                className={`block w-full px-3 py-2.5 text-left text-[12.5px] transition-colors
                            ${i === highlight ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/70 hover:bg-white/5'}`}
              >
                <span className="block font-semibold">
                  {s.structured_formatting?.main_text ?? s.description}
                </span>
                {s.structured_formatting?.secondary_text && (
                  <span className="block text-[11px] text-white/35">
                    {s.structured_formatting.secondary_text}
                  </span>
                )}
              </button>
            </li>
          ))}
          <li className="border-t border-white/5 px-3 py-1.5 text-[10px] text-white/25">
            Type karke apna naam bhi likh sakte hain — list se chunna zaroori nahi.
          </li>
        </ul>
      )}
      {!ready && value?.length > 2 && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-white/25">
          typing only
        </span>
      )}
    </div>
  );
}
