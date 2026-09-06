// @ts-nocheck
// ============================================================================
// <GeoPicker /> — THE map control. One component for every party in the ERP,
// on the office PC and on a driver's phone.
//
// ── THE ONE IDEA THIS COMPONENT IS BUILT AROUND ────────────────────────────
//
// A Google Places result is the CENTROID of whatever Google thinks the place
// is. Search "Bongaigaon Refinery and Petro-chemic" and you get a point in the
// middle of a six-square-kilometre complex — verified 700 m from the gate a
// lorry actually queues at, which is a third of the default fence.
//
// So a search here is A CAMERA MOVE AND NOTHING ELSE. It flies you overhead at
// building zoom. What gets SAVED is wherever the pin ends up after a person has
// put it on the actual gate, and `geo_source` records which of the two it is so
// that afterwards nobody has to guess whether a coordinate was surveyed or
// assumed. Everything below serves that.
//
// ── PC AND PHONE GET DIFFERENT GESTURES, DELIBERATELY ──────────────────────
//
// PC: click to drop, then drag the pin. A mouse is precise and a drag is the
// obvious thing to try.
//
// PHONE: the map moves under a FIXED CENTRE CROSSHAIR and the pin is wherever
// the centre lands. Dragging a 30-px pin with a thumb is the most-missed target
// on a touch screen — the thumb covers the very thing being aimed at. Every
// mapping app people already use here (Ola, Uber, Swiggy) abandoned the drag
// for exactly this. `mode` picks between them and defaults to the pointer the
// device actually has, not to the window width: a touch laptop should get the
// touch gesture, and a phone held in landscape is still a phone.
//
// ── THINGS THAT LOOK LIKE DETAILS AND ARE NOT ──────────────────────────────
//
// · gestureHandling:'greedy' — one finger pans the MAP instead of scrolling the
//   form behind it. Without it a phone user cannot move the map at all inside a
//   scrolling page.
// · The camera NEVER moves during a drag. Recentring mid-gesture throws away
//   the gate the person had just found.
// · Satellite is one tap away. On a road map a refinery is a grey blob with no
//   gate drawn on it, so "pin the exact gate" is not a real instruction until
//   there is imagery under the pin.
// · ONE map instance, mutated. Maps JS is billed per map LOAD; remounting on
//   every prop change bills a fresh load each time the radius slider moves.
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { loadGoogleMaps } from '../maps';
import { sitePin, fenceStyle, observeAndRefit } from '../mapSymbols.mjs';
import PlaceInput from '../PlaceInput';
import { reverseGeocode, DEFAULT_RADIUS, hasPin, sourceLabel } from './geoApi';

// Same night styling the dispatch board uses. Roads and water only — POI pins
// and business labels compete with the one pin that matters here.
const DARK = [
  { elementType: 'geometry', stylers: [{ color: '#0a1024' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a1024' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5d7196' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#18244a' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#18244a' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#27395f' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#3d548a' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#050b16' }] },
];

// Lower NH-27, where this fleet runs. A picker that opens on the middle of the
// Indian Ocean makes every first pin a long scroll.
const HOME = { lat: 26.35, lng: 91.15 };

// Building zoom. At 13 you are looking at a town and cannot pick a shutter; at
// 18 the gate, the weighbridge and the parking bay are separate things.
const GATE_ZOOM = 18;

const RADIUS_CHIPS = [500, 1000, 2000, 5000, 10000];
const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);

/** Touch-first if the device's primary pointer is coarse. Not window width —
 *  a touch laptop deserves the touch gesture and a landscape phone is still a
 *  phone. */
const coarsePointer = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

export default function GeoPicker({
  value,                    // GeoValue — { lat, lng, geofence_radius, geo_source }
  onChange,                 // (GeoValue) => void, fired on every settled change
  height = 380,
  mode = 'auto',            // 'auto' | 'pin' | 'crosshair'
  light = false,            // portals and the driver app are light screens
  addressHint = '',         // the address already typed in the form, if any
  localRoutes = [],         // this company's own places, shown above Google's
  disabled = false,
}) {
  const box = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const circle = useRef(null);
  const refit = useRef(null);
  // The last point WE pushed to the map, so the value-sync effect below can
  // tell an external change from the echo of our own onChange.
  const own = useRef('');

  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');
  const [sat, setSat] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [addr, setAddr] = useState(value?.address || '');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');

  const touch = mode === 'crosshair' || (mode === 'auto' && coarsePointer());
  const radius = Number(value?.geofence_radius) || DEFAULT_RADIUS;
  const pinned = hasPin(value);
  const src = sourceLabel(value?.geo_source);

  // Content keys, not object identities. `value` is rebuilt by the parent on
  // every render, and keying effects on the object re-ran them constantly —
  // the same trap RouteMap documents, which on the driver app ended in
  // "Maximum update depth exceeded".
  const ptKey = pinned ? `${Number(value.lat).toFixed(7)},${Number(value.lng).toFixed(7)}` : '';

  /** Report a settled point upward. `address` is display-only and never saved —
   *  the coordinate is the truth and the address is a caption. */
  const emit = useCallback((lat, lng, source, nextRadius) => {
    own.current = lat == null ? '' : `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`;
    onChange?.({
      lat: lat == null ? null : Number(lat),
      lng: lng == null ? null : Number(lng),
      geofence_radius: Number(nextRadius ?? radius) || DEFAULT_RADIUS,
      geo_source: lat == null ? null : source,
    });
  }, [onChange, radius]);

  // ── the fence ─────────────────────────────────────────────────────────────
  const drawFence = useCallback((center, r) => {
    const g = window.google;
    if (!g || !map.current) return;
    const opts = { ...fenceStyle(), center, radius: Number(r) || DEFAULT_RADIUS };
    if (!circle.current) circle.current = new g.maps.Circle({ ...opts, map: map.current });
    else circle.current.setOptions(opts);
  }, []);

  /** Name the point. Fire-and-forget: a failed lookup leaves the pin standing
   *  and only empties the caption. */
  const nameIt = useCallback(async (lat, lng) => {
    setBusy(true);
    const r = await reverseGeocode(lat, lng);
    setBusy(false);
    setAddr(r?.formatted || '');
  }, []);

  // The map's listeners are registered ONCE at mount and close over whatever
  // existed then. These refs are how they read the CURRENT radius and drag
  // state without re-registering — and leaking — a listener on every render.
  const radiusRef = useRef(radius);
  radiusRef.current = radius;
  // Written DIRECTLY in the dragstart handler, never via setDragging + an
  // effect: `idle` can fire before React has flushed that state, and the
  // handler would then decline to commit the very drag that just happened.
  const dragRef = useRef(false);

  /** Place or move the marker. `lift` only changes the artwork. */
  const setPin = useCallback((lat, lng, lift) => {
    const g = window.google;
    if (!g || !map.current) return;
    // In crosshair mode the pin is a fixed overlay in the DOM, not a marker —
    // a marker under the crosshair would draw the same pin twice.
    if (touch) return;
    if (!marker.current) {
      marker.current = new g.maps.Marker({
        map: map.current, position: { lat, lng }, icon: sitePin(false),
        draggable: !disabled, cursor: 'grab', zIndex: 99,
      });
      marker.current.addListener('dragstart', () => {
        dragRef.current = true;
        setDragging(true);
        marker.current.setIcon(sitePin(true));
      });
      // The fence follows through the WHOLE gesture. You are placing a circle,
      // not a dot, and you have to see where it lands as you move.
      marker.current.addListener('drag', () => {
        const p = marker.current.getPosition();
        drawFence({ lat: p.lat(), lng: p.lng() }, radiusRef.current);
      });
      marker.current.addListener('dragend', () => {
        dragRef.current = false;
        setDragging(false);
        marker.current.setIcon(sitePin(false));
        const p = marker.current.getPosition();
        // A dragged pin is ALWAYS manual, whatever put it there first.
        emit(p.lat(), p.lng(), 'PIN');
        nameIt(p.lat(), p.lng());
        // Deliberately no panTo. Recentring under the thumb throws away the
        // gate that was just found.
      });
    } else {
      marker.current.setPosition({ lat, lng });
      marker.current.setIcon(sitePin(!!lift));
    }
  }, [touch, disabled, drawFence, emit, nameIt]);

  // ── mount the map exactly once ────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    loadGoogleMaps()
      .then((g) => {
        if (dead || !box.current) return;
        const start = pinned ? { lat: Number(value.lat), lng: Number(value.lng) } : HOME;
        map.current = new g.maps.Map(box.current, {
          center: start,
          zoom: pinned ? GATE_ZOOM : 8,
          styles: light ? [] : DARK,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'greedy',
          backgroundColor: light ? '#e8efe3' : '#0a1024',
          // POI pins are clickable by default and swallow the click that is
          // supposed to MOVE THE PIN. On a dense industrial area that makes
          // roughly half the map dead to the one gesture the screen is for.
          clickableIcons: false,
          tilt: 0,
        });

        // PC: click the map to drop the pin there.
        map.current.addListener('click', (e) => {
          if (disabled || touch) return;
          const lat = e.latLng.lat(); const lng = e.latLng.lng();
          setPin(lat, lng, false);
          emit(lat, lng, 'PIN');
          nameIt(lat, lng);
        });

        // PHONE: the centre IS the pin. The fence tracks the map continuously
        // so you can see where the circle lands while you are still moving,
        // and the coordinate is committed when the map settles.
        map.current.addListener('center_changed', () => {
          if (!touch || disabled) return;
          const c = map.current.getCenter();
          if (c) drawFence({ lat: c.lat(), lng: c.lng() }, radiusRef.current);
        });
        map.current.addListener('dragstart', () => {
          if (!touch) return;
          dragRef.current = true;
          setDragging(true);
        });
        map.current.addListener('idle', () => {
          if (!touch || disabled) return;
          const c = map.current.getCenter();
          if (!c) return;
          const lat = c.lat(); const lng = c.lng();
          const key = `${lat.toFixed(7)},${lng.toFixed(7)}`;
          // Only when the map actually moved. `idle` also fires on the initial
          // load and after a programmatic pan, and committing there would
          // relabel a SEARCH result as a hand-placed PIN without anyone
          // touching it.
          if (!dragRef.current) return;
          dragRef.current = false;
          setDragging(false);
          if (key === own.current) return;
          emit(lat, lng, 'PIN');
          nameIt(lat, lng);
        });

        if (pinned) {
          setPin(Number(value.lat), Number(value.lng), false);
          drawFence({ lat: Number(value.lat), lng: Number(value.lng) }, radius);
          if (!addr) nameIt(Number(value.lat), Number(value.lng));
        } else {
          drawFence(HOME, radius);
        }

        // Google keeps the zoom and loses the centre when the container
        // resizes — a modal opening, a bottom sheet expanding, a phone
        // rotating. Same fix every other map here uses.
        refit.current = observeAndRefit(box.current, () => {
          const c = map.current?.getCenter();
          if (c) map.current.setCenter(c);
        });
        setReady(true);
      })
      .catch((e) => setErr(e?.message || 'Map could not load'));
    return () => { dead = true; refit.current?.(); };
    // Mount once. Everything after this mutates the map in place, because Maps
    // JS is billed per map load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ── keep the map honest when the parent changes the value ────────────────
  useEffect(() => {
    if (!ready || !map.current) return;
    if (!ptKey) {
      marker.current?.setMap(null); marker.current = null;
      return;
    }
    if (ptKey === own.current) return;      // our own echo, nothing to do
    const [lat, lng] = ptKey.split(',').map(Number);
    setPin(lat, lng, false);
    drawFence({ lat, lng }, radius);
    map.current.panTo({ lat, lng });
  }, [ptKey, ready, radius, setPin, drawFence]);

  // The fence redraws when the radius changes, around whatever the pin is now.
  useEffect(() => {
    if (!ready) return;
    const c = touch ? map.current?.getCenter() : marker.current?.getPosition();
    if (c) drawFence({ lat: c.lat(), lng: c.lng() }, radius);
    else if (!pinned) drawFence(HOME, radius);
  }, [radius, ready, touch, pinned, drawFence]);

  // ── actions ───────────────────────────────────────────────────────────────

  /** A search result. Camera only — see the header. */
  const flyTo = useCallback((lat, lng, formatted) => {
    if (!map.current) return;
    map.current.panTo({ lat, lng });
    map.current.setZoom(GATE_ZOOM);
    if (!touch) setPin(lat, lng, false);
    drawFence({ lat, lng }, radius);
    setAddr(formatted || '');
    emit(lat, lng, 'SEARCH');
  }, [touch, setPin, drawFence, radius, emit]);

  const onResolved = useCallback((p) => {
    if (Number.isFinite(p?.lat) && Number.isFinite(p?.lng)) flyTo(p.lat, p.lng, p.formatted);
  }, [flyTo]);

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setBusy(false);
        const { latitude: lat, longitude: lng } = p.coords;
        map.current?.panTo({ lat, lng });
        map.current?.setZoom(GATE_ZOOM);
        if (!touch) setPin(lat, lng, false);
        drawFence({ lat, lng }, radius);
        // Standing at the gate is the most accurate capture there is.
        emit(lat, lng, 'GPS');
        nameIt(lat, lng);
      },
      () => { setBusy(false); setErr('Location permission not given'); },
      // GPS, not the tower estimate — the difference is 8 m against 800 m.
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }, [touch, setPin, drawFence, radius, emit, nameIt]);

  const toggleSat = useCallback(() => {
    const g = window.google;
    if (!g || !map.current) return;
    const next = !sat;
    setSat(next);
    map.current.setMapTypeId(next ? g.maps.MapTypeId.HYBRID : g.maps.MapTypeId.ROADMAP);
    // Custom styles apply only to the road map. Left on over imagery they tint
    // the satellite tiles navy and make them unreadable.
    map.current.setOptions({ styles: next || light ? [] : DARK });
  }, [sat, light]);

  const setRadius = (r) => emit(value?.lat ?? null, value?.lng ?? null, value?.geo_source ?? null, r);

  const clear = () => {
    marker.current?.setMap(null); marker.current = null;
    setAddr('');
    emit(null, null, null);
  };

  /** Typed coordinates beat a dragged pin when someone has surveyed numbers. */
  const typeCoord = (which, raw) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    const lat = which === 'lat' ? n : Number(value?.lat);
    const lng = which === 'lng' ? n : Number(value?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    if (!touch) setPin(lat, lng, false);
    map.current?.panTo({ lat, lng });
    map.current?.setZoom(GATE_ZOOM);
    drawFence({ lat, lng }, radius);
    emit(lat, lng, 'PIN');
    nameIt(lat, lng);
  };

  const ink = light
    ? { panel: '#ffffff', line: '#d8e0ee', text: '#0f172a', muted: '#5b6b88', chipOff: '#eef2f8' }
    : { panel: 'rgba(10,16,36,.55)', line: '#27395f', text: '#eef3ff', muted: '#9aadd4', chipOff: 'transparent' };

  const btn = {
    border: `1px solid ${ink.line}`, background: ink.chipOff, color: ink.text,
    borderRadius: 9, padding: '8px 13px', cursor: 'pointer', fontSize: 12.5,
    fontWeight: 600, minHeight: 38, whiteSpace: 'nowrap',
  };

  return (
    <div>
      {/* ── search ── */}
      <div style={{ marginBottom: 9 }}>
        <PlaceInput
          value={search}
          onChange={setSearch}
          onResolved={onResolved}
          withCoords
          local={localRoutes}
          placeholder="Search a place, address or landmark…"
          disabled={disabled}
          className="modern-input"
          style={{ width: '100%' }}
        />
      </div>

      {/* ── map ── */}
      <div style={{ position: 'relative', borderRadius: 13, overflow: 'hidden',
                    border: `1px solid ${ink.line}`, background: light ? '#e8efe3' : '#0a1024' }}>
        <div ref={box} style={{ width: '100%', height, touchAction: 'none' }} />

        {!ready && !err && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                        color: ink.muted, fontSize: 12.5 }}>Loading the map…</div>
        )}
        {err && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                        padding: 22, textAlign: 'center', color: ink.muted, fontSize: 12.5 }}>
            {err}
            {/* The coordinate boxes below still work, so a missing key is not a
                dead end — a surveyed number can be typed in. */}
          </div>
        )}

        {/* The fixed crosshair. Rendered in the DOM, not as a marker, so it
            cannot drift from the true centre of the viewport. */}
        {ready && touch && (
          <>
            <div style={{ position: 'absolute', left: '50%', top: '50%', zIndex: 5,
                          transform: `translate(-50%, ${dragging ? '-115%' : '-100%'})`,
                          transition: 'transform .12s ease-out', pointerEvents: 'none',
                          filter: 'drop-shadow(0 6px 10px rgba(0,0,0,.55))' }}>
              <img src={sitePin(dragging).url} alt="" width={34} height={50} />
            </div>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 10, zIndex: 6,
                          textAlign: 'center', pointerEvents: 'none' }}>
              <span style={{ background: 'rgba(10,16,36,.86)', border: `1px solid ${ink.line}`,
                             borderRadius: 99, padding: '5px 12px', fontSize: 11, color: '#c4d1ea' }}>
                Map ko khiska kar theek gate par pin rakhein
              </span>
            </div>
          </>
        )}

        {ready && (
          <div style={{ position: 'absolute', left: 10, top: 10, zIndex: 6, display: 'flex', gap: 6,
                        background: 'rgba(10,16,36,.82)', border: `1px solid ${ink.line}`,
                        borderRadius: 99, padding: 4 }}>
            {[['Map', false], ['Satellite', true]].map(([label, wantSat]) => (
              <button key={label} type="button" onClick={() => { if (sat !== wantSat) toggleSat(); }}
                style={{ ...btn, border: 0, minHeight: 30, padding: '5px 12px', borderRadius: 99,
                         background: sat === wantSat ? 'rgba(34,211,238,.18)' : 'transparent',
                         color: sat === wantSat ? '#22d3ee' : '#9aadd4' }}>{label}</button>
            ))}
          </div>
        )}

        {ready && !disabled && (
          <button type="button" onClick={useMyLocation} style={{ ...btn, position: 'absolute',
            right: 10, bottom: 10, zIndex: 6, background: 'rgba(10,16,36,.86)' }}>
            ◎ My location
          </button>
        )}
      </div>

      {/* ── radius ── */}
      <div style={{ marginTop: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
          <span style={{ flex: 1, fontSize: 11, color: ink.muted }}>
            Geofence — a lorry inside this circle counts as “arrived”
          </span>
          <span style={{ fontSize: 15, fontWeight: 800, color: '#22d3ee',
                         fontVariantNumeric: 'tabular-nums' }}>{fmtKm(radius)}</span>
        </div>
        <input type="range" min={200} max={10000} step={100} value={radius} disabled={disabled}
          onChange={(e) => setRadius(Number(e.target.value))}
          style={{ width: '100%', height: 34, accentColor: '#22d3ee' }} />
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {RADIUS_CHIPS.map((r) => (
            <button key={r} type="button" disabled={disabled} onClick={() => setRadius(r)}
              style={{ ...btn, borderRadius: 99, minHeight: 34, padding: '6px 13px',
                       background: radius === r ? 'rgba(34,211,238,.16)' : ink.chipOff,
                       borderColor: radius === r ? '#22d3ee' : ink.line,
                       color: radius === r ? '#22d3ee' : ink.muted }}>{fmtKm(r)}</button>
          ))}
        </div>
      </div>

      {/* ── coordinates + caption ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 13 }}>
        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: ink.muted, marginBottom: 4 }}>Latitude</label>
          <input className="modern-input" inputMode="decimal" disabled={disabled}
            defaultValue={pinned ? Number(value.lat).toFixed(7) : ''} key={`la:${ptKey}`}
            placeholder="26.5318800" onBlur={(e) => typeCoord('lat', e.target.value)} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: ink.muted, marginBottom: 4 }}>Longitude</label>
          <input className="modern-input" inputMode="decimal" disabled={disabled}
            defaultValue={pinned ? Number(value.lng).toFixed(7) : ''} key={`ln:${ptKey}`}
            placeholder="90.5204100" onBlur={(e) => typeCoord('lng', e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: 11, fontSize: 11.5, color: '#c4d1ea', background: ink.panel,
                    border: `1px solid ${ink.line}`, borderRadius: 9, padding: '9px 11px', minHeight: 38 }}>
        {!pinned && <span style={{ color: ink.muted }}>No pin yet — search above, or {touch ? 'move the map' : 'click the map'}.</span>}
        {pinned && (
          <>
            <b style={{ color: ink.text }}>{busy ? 'Resolving address…' : (addr || 'No street address at this point')}</b>
            <br />
            <span style={{ color: ink.muted }}>
              {Number(value.lat).toFixed(6)}, {Number(value.lng).toFixed(6)} · fence {fmtKm(radius)} ·{' '}
              <span style={{ color: src.exact ? '#2fe39b' : '#ffb224', fontWeight: 700 }}>{src.text}</span>
            </span>
            {!src.exact && (
              <div style={{ marginTop: 5, color: '#ffb224', fontSize: 11 }}>
                Yeh Google ka andaaz hai — {touch ? 'map khiska kar' : 'pin ko pakad kar'} theek gate par rakhein.
              </div>
            )}
          </>
        )}
      </div>

      {pinned && !disabled && (
        <button type="button" onClick={clear}
          style={{ ...btn, marginTop: 11, borderColor: 'rgba(255,107,129,.5)', color: '#ff6b81' }}>
          Clear pin
        </button>
      )}
    </div>
  );
}
