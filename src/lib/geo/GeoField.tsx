// @ts-nocheck
// ============================================================================
// <GeoField /> — the ONE row a master form adds to become pinnable.
//
// THIS IS THE ENTIRE INTEGRATION SURFACE. Twelve screens, twelve one-line
// diffs. No master screen imports Google Maps, mounts a map, or knows what a
// session token is — the alternative is a map embedded in a dozen forms, each
// drifting into its own idea of what a pin means.
//
// WHY A ROW AND A SHEET, NOT AN INLINE MAP. A 380-px map inside every party
// form pushes the fields people actually fill in every day below the fold, and
// bills a map load on every form open whether or not anyone was going to touch
// the location. The row costs nothing until it is tapped.
//
// THE ROW STATES ITS OWN TRUTHFULNESS. "Pinned" quietly means two different
// things — a coordinate somebody surveyed, and Google's guess at the middle of
// a town — and the difference is a third of the default fence. So an
// unconfirmed pin is badged amber ON THE FORM ROW, where it is seen without
// opening anything.
//
// BottomSheet is reused rather than reinvented: it is already a bottom sheet on
// a phone and a centred dialog on a desktop, which is exactly the split this
// control needs.
// ============================================================================
import React, { useState } from 'react';
import BottomSheet from '../../ui/BottomSheet';
import GeoPicker from './GeoPicker';
import { EMPTY_GEO, DEFAULT_RADIUS, hasPin, sourceLabel } from './geoApi';

const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);

export default function GeoField({
  value,                          // GeoValue | null
  onChange,                       // (GeoValue) => void
  label = 'Location on map & geofence',
  hint = 'Pin the gate, not the town — the fence is measured from this point.',
  title,                          // sheet heading, e.g. the party's name
  addressHint = '',               // the address already typed in the form
  localRoutes = [],
  light = false,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  // Edits are held here and committed on Save, so closing the sheet with the
  // scrim or the drag-down gesture does NOT silently move a party's gate.
  const [draft, setDraft] = useState(null);

  const g = value || EMPTY_GEO;
  const pinned = hasPin(g);
  const src = sourceLabel(g.geo_source);
  const radius = Number(g.geofence_radius) || DEFAULT_RADIUS;

  const start = () => { setDraft({ ...EMPTY_GEO, ...g }); setOpen(true); };
  const save = () => { onChange?.(draft); setOpen(false); };

  const chip = (text, tone) => (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 800, letterSpacing: '.06em',
      padding: '3px 8px', borderRadius: 99, whiteSpace: 'nowrap',
      background: tone === 'ok' ? 'rgba(47,227,155,.15)'
        : tone === 'warn' ? 'rgba(255,178,36,.15)' : 'rgba(154,173,212,.15)',
      color: tone === 'ok' ? '#2fe39b' : tone === 'warn' ? '#ffb224' : '#9aadd4',
    }}>{text}</span>
  );

  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: '#9aadd4', marginBottom: 5 }}>{label}</label>

      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', padding: '11px 12px', borderRadius: 11,
        border: pinned ? '1px solid rgba(47,227,155,.42)' : '1px dashed #3d548a',
        background: pinned ? 'rgba(47,227,155,.06)' : 'rgba(34,211,238,.045)',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 19, lineHeight: 1 }}>📍</span>

        <span style={{ flex: 1, minWidth: 170 }}>
          <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: '#eef3ff' }}>
            {pinned
              ? `${Number(g.lat).toFixed(5)}, ${Number(g.lng).toFixed(5)}  ·  ${fmtKm(radius)} fence`
              : 'Not pinned yet'}
          </span>
          <span style={{
            display: 'block', fontSize: 11, color: '#9aadd4',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {pinned ? (g.address || 'Open the map to check the exact spot') : hint}
          </span>
        </span>

        {/* An approximate pin says so here, so nobody has to open the map to
            find out that it was never moved off Google's guess. */}
        {pinned && chip(src.text.toUpperCase(), src.exact ? 'ok' : 'warn')}
        {!pinned && chip('UNPINNED', 'warn')}

        {!disabled && (
          <button type="button" onClick={start} style={{
            border: '1px solid #3d548a', background: 'rgba(39,57,95,.45)', color: '#eef3ff',
            borderRadius: 9, padding: '9px 14px', cursor: 'pointer', fontSize: 12.5,
            fontWeight: 600, minHeight: 40, whiteSpace: 'nowrap',
          }}>{pinned ? 'Edit' : 'Set on map'}</button>
        )}
      </div>

      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title={title ? `Set location — ${title}` : 'Set location'}
        maxWidth={760}
      >
        <GeoPicker
          value={draft || EMPTY_GEO}
          onChange={setDraft}
          addressHint={addressHint}
          localRoutes={localRoutes}
          light={light}
          height={360}
        />
        <div style={{ display: 'flex', gap: 9, marginTop: 15 }}>
          <button type="button" onClick={() => setOpen(false)} style={{
            flex: 1, border: '1px solid #27395f', background: 'transparent', color: '#c4d1ea',
            borderRadius: 9, padding: '11px 14px', cursor: 'pointer', fontSize: 13,
            fontWeight: 600, minHeight: 44,
          }}>Cancel</button>
          <button type="button" onClick={save} style={{
            flex: 1, border: 0, background: 'linear-gradient(135deg,#22d3ee,#4f7cf7)',
            color: '#04121e', borderRadius: 9, padding: '11px 14px', cursor: 'pointer',
            fontSize: 13, fontWeight: 800, minHeight: 44,
          }}>Save location</button>
        </div>
      </BottomSheet>
    </div>
  );
}
