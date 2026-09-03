// @ts-nocheck
// ============================================================================
// <CustomerLiveTracking /> — track your freight like an Uber cab.
// The map is a dark-grid placeholder container (drop-in slot for the real map
// layer later); the truck marker, route line, progress, live speed and ETA are
// all driven by the useLiveTracking bus and are fully live today (mock lane).
// ============================================================================
import React, { useEffect, useMemo } from 'react';
import {
  Truck, MapPin, Clock3, Gauge, PhoneCall, Share2, PackageOpen,
  CircleDot, LogOut, Satellite,
} from 'lucide-react';
import { GlassPanel, StatusPill, Dot, Avatar, ProgressBar } from '../../mastercontrol/shared';
import useLiveTracking from './hooks/useLiveTracking';
import { useAuth } from './auth/AuthProvider';

const SHIPMENT = {
  lr: 'LR-8842', trip: 'PT-2661', vehicle: 'AS 25C 9908',
  driver: 'Vijay Singh', driverMobile: 'PT00409',
  product: 'HSD 12 KL', from: 'Bongaigaon Refinery', to: 'IOCL Depot, Guwahati',
  route: [
    { lat: 26.4831, lng: 90.5533 }, { lat: 26.4402, lng: 90.9871 },
    { lat: 26.3915, lng: 91.2510 }, { lat: 26.1844, lng: 91.7458 },
  ],
};

// Project the polyline into the placeholder box (SVG viewBox 0-100).
function useProjected(route) {
  return useMemo(() => {
    const lats = route.map((p) => p.lat), lngs = route.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const px = (p) => ({
      x: 8 + ((p.lng - minLng) / (maxLng - minLng || 1)) * 84,
      y: 78 - ((p.lat - minLat) / (maxLat - minLat || 1)) * 56,
    });
    return { px, poly: route.map(px) };
  }, [route]);
}

export default function CustomerLiveTracking() {
  const { user, logout } = useAuth();
  const t = useLiveTracking({ tripId: SHIPMENT.trip, route: SHIPMENT.route });
  const { px, poly } = useProjected(SHIPMENT.route);

  useEffect(() => { t.connect(); return () => t.disconnect(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const marker = t.position ? px(t.position) : null;
  const eta = t.etaMin != null
    ? t.etaMin >= 60 ? `${Math.floor(t.etaMin / 60)}h ${t.etaMin % 60}m` : `${t.etaMin} min`
    : '—';

  return (
    <div className="max-w-md mx-auto flex flex-col gap-4 p-1">
      {/* header */}
      <div className="flex items-center justify-between px-1">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-emerald-400">Live Freight Tracking</p>
          <h2 className="text-lg font-black text-white">{SHIPMENT.lr} · {SHIPMENT.product}</h2>
        </div>
        <button onClick={logout} className="grid place-items-center w-9 h-9 rounded-xl bg-white/5 border border-slate-700/50 text-slate-400 hover:text-red-400 transition-colors"><LogOut size={15} /></button>
      </div>

      {/* map placeholder with live overlay */}
      <GlassPanel className="overflow-hidden border-emerald-500/30">
        <div className="relative h-72 bg-[radial-gradient(ellipse_at_center,rgba(8,22,36,1)_0%,rgba(4,8,16,1)_80%)]">
          {/* map grid ground — swap this layer for the real map tile container */}
          <div className="absolute inset-0 opacity-25" style={{
            backgroundImage: 'linear-gradient(rgba(34,211,238,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.15) 1px, transparent 1px)',
            backgroundSize: '26px 26px',
          }} />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
            <defs>
              <filter id="ctGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="1.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            {/* full route */}
            <polyline points={poly.map((p) => `${p.x},${p.y}`).join(' ')} fill="none"
              stroke="rgba(148,163,184,0.4)" strokeWidth="0.8" strokeDasharray="2 1.6" />
            {/* covered portion glows */}
            {marker && t.position?.progress != null && (
              <polyline
                points={[...poly.slice(0, Math.max(1, Math.ceil(t.position.progress * (poly.length - 1)) + 0)), marker].map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none" stroke="#2fe39b" strokeWidth="1.1" strokeLinecap="round" filter="url(#ctGlow)" />
            )}
            {/* endpoints */}
            <circle cx={poly[0].x} cy={poly[0].y} r="2" fill="#2fe39b" filter="url(#ctGlow)" />
            <circle cx={poly[poly.length - 1].x} cy={poly[poly.length - 1].y} r="2" fill="#22d3ee" filter="url(#ctGlow)" />
            {/* live truck marker */}
            {marker && (
              <g filter="url(#ctGlow)">
                <circle cx={marker.x} cy={marker.y} r="3.4" fill="rgba(47, 227, 155,0.25)">
                  <animate attributeName="r" values="3.4;5;3.4" dur="2s" repeatCount="indefinite" />
                </circle>
                <circle cx={marker.x} cy={marker.y} r="1.8" fill="#2fe39b" />
              </g>
            )}
          </svg>
          {/* HTML labels — never distorted by preserveAspectRatio=none */}
          <span className="absolute text-[9px] font-bold text-emerald-300" style={{ left: `${poly[0].x}%`, top: `calc(${poly[0].y}% + 8px)`, transform: 'translateX(-50%)' }}>{SHIPMENT.from}</span>
          <span className="absolute text-[9px] font-bold text-cyan-300" style={{ left: `${poly[poly.length - 1].x}%`, top: `calc(${poly[poly.length - 1].y}% + 8px)`, transform: 'translateX(-50%)' }}>{SHIPMENT.to}</span>
          {marker && (
            <span className="absolute -translate-x-1/2 -translate-y-[26px] flex items-center gap-1 rounded-full bg-slate-950/80 border border-emerald-500/50 px-2 py-0.5 text-[9px] font-black text-emerald-300 whitespace-nowrap"
              style={{ left: `${marker.x}%`, top: `${marker.y}%` }}>
              <Truck size={10} /> {SHIPMENT.vehicle}
            </span>
          )}
          <div className="absolute top-2.5 left-2.5"><StatusPill tone="green" pulse><Satellite size={9} /> {t.status === 'OPEN' ? 'LIVE · WS' : 'LIVE'}</StatusPill></div>
          <div className="absolute top-2.5 right-2.5"><StatusPill tone="cyan">{t.tripState}</StatusPill></div>
        </div>

        {/* trip progress */}
        <div className="px-4 py-3">
          <ProgressBar pct={(t.position?.progress ?? 0) * 100} gradient="from-emerald-500 to-cyan-400" />
          <div className="mt-1.5 flex justify-between text-[9px] font-bold text-slate-500">
            <span>{SHIPMENT.from}</span>
            <span className="text-emerald-400">{Math.round((t.position?.progress ?? 0) * 100)}%</span>
            <span>{SHIPMENT.to}</span>
          </div>
        </div>
      </GlassPanel>

      {/* live stats — the Uber strip */}
      <div className="grid grid-cols-3 gap-2">
        <GlassPanel className="p-3 text-center border-emerald-500/30">
          <Clock3 size={15} className="mx-auto text-emerald-400" />
          <p className="mt-1 text-lg font-black text-white">{eta}</p>
          <p className="text-[8px] uppercase text-slate-500">ETA</p>
        </GlassPanel>
        <GlassPanel className="p-3 text-center">
          <Gauge size={15} className="mx-auto text-cyan-400" />
          <p className="mt-1 text-lg font-black text-white">{t.position?.speedKmh ?? '—'}</p>
          <p className="text-[8px] uppercase text-slate-500">km/h live</p>
        </GlassPanel>
        <GlassPanel className="p-3 text-center">
          <MapPin size={15} className="mx-auto text-violet-400" />
          <p className="mt-1 text-lg font-black text-white">{t.remainingKm != null ? `${Math.round(t.remainingKm)}` : '—'}</p>
          <p className="text-[8px] uppercase text-slate-500">km to go</p>
        </GlassPanel>
      </div>

      {/* driver card */}
      <GlassPanel className="p-4">
        <div className="flex items-center gap-3">
          <Avatar name={SHIPMENT.driver} size="w-11 h-11" ring="ring-emerald-500/50" />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-black text-slate-100 flex items-center gap-1.5">{SHIPMENT.driver} <Dot color="bg-emerald-400" pulse size="w-1.5 h-1.5" /></p>
            <p className="text-[10px] text-slate-500">{SHIPMENT.vehicle} · {SHIPMENT.driverMobile}</p>
          </div>
          <button className="grid place-items-center w-10 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"><PhoneCall size={16} /></button>
          <button className="grid place-items-center w-10 h-10 rounded-xl bg-white/5 border border-slate-700/50 text-slate-300 hover:bg-white/10 transition-colors"><Share2 size={15} /></button>
        </div>
      </GlassPanel>

      {/* journey timeline */}
      <GlassPanel className="p-4">
        <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-3">Journey Timeline</p>
        {[
          { icon: PackageOpen, label: 'Loaded at Bongaigaon Refinery', time: '06:10', done: true },
          { icon: CircleDot, label: 'Crossed Bijni toll plaza', time: '07:35', done: true },
          { icon: Truck, label: `En route · NH-27 (${t.position?.speedKmh ?? '—'} km/h)`, time: 'now', done: false },
          { icon: MapPin, label: 'Arrival — IOCL Depot, Guwahati', time: `ETA ${eta}`, done: false },
        ].map((s, i) => (
          <div key={i} className="flex items-start gap-3 pb-3 last:pb-0">
            <span className={`grid place-items-center w-7 h-7 rounded-full border shrink-0 ${s.done ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-400' : i === 2 ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300 mc-glow-pulse' : 'bg-white/5 border-slate-700/50 text-slate-400'}`}>
              <s.icon size={13} />
            </span>
            <div className="flex-1 min-w-0">
              <p className={`text-[11px] font-bold ${s.done || i === 2 ? 'text-slate-200' : 'text-slate-500'}`}>{s.label}</p>
            </div>
            <span className="text-[9px] font-bold text-slate-400 shrink-0">{s.time}</span>
          </div>
        ))}
      </GlassPanel>

      <p className="text-center text-[9px] text-slate-300">Tracking {user?.full_name ? `for ${user.full_name}` : ''} · trip {SHIPMENT.trip}</p>
    </div>
  );
}
