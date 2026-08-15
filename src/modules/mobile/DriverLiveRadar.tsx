// @ts-nocheck
// ============================================================================
// <DriverLiveRadar /> — the driver's duty screen (DRIVER environment).
// Online/Offline toggle arms the 5-second geolocation heartbeat; every fix is
// pushed onto the live-tracking bus (WebSocket when configured, mock today).
// ============================================================================
import React, { useState } from 'react';
import {
  Power, Navigation2, MapPin, Gauge, Crosshair, Route as RouteIcon,
  PackageCheck, PhoneCall, AlertTriangle, LogOut,
} from 'lucide-react';
import { GlassPanel, StatusPill, Dot } from '../../mastercontrol/shared';
import useGeoPolling from './hooks/useGeoPolling';
import useLiveTracking from './hooks/useLiveTracking';
import { emitGpsFix } from '../../lib/gpsEmitter';
import { useAuth } from './auth/AuthProvider';

const ASSIGNED_TRIP = {
  id: 'PT-2661', vehicle: 'AS 25C 9908', product: 'HSD 12 KL',
  from: 'Bongaigaon Refinery', to: 'IOCL Depot, Guwahati',
  route: [
    { lat: 26.4831, lng: 90.5533 }, { lat: 26.4402, lng: 90.9871 },
    { lat: 26.3915, lng: 91.2510 }, { lat: 26.1844, lng: 91.7458 },
  ],
};

export default function DriverLiveRadar() {
  const { user, logout } = useAuth();
  const tracking = useLiveTracking({ tripId: ASSIGNED_TRIP.id, route: ASSIGNED_TRIP.route });
  // Every fix goes two places now: the in-memory bus that drives this screen,
  // and trip_gps_pings via POST /tracking/ping so the dispatch board can see
  // the truck at all. Only genuine device fixes are persisted — emitGpsFix
  // drops the simulated fallback rather than writing invented coordinates into
  // the table dispatch trusts.
  const [lastPing, setLastPing] = useState(null);
  const geo = useGeoPolling({
    onFix: (fix) => {
      tracking.sendPosition(fix);
      emitGpsFix(ASSIGNED_TRIP.id, fix).then(setLastPing);
    },
  });
  const [online, setOnline] = useState(false);

  const toggle = () => {
    if (online) { geo.stop(); tracking.disconnect(); setOnline(false); }
    else { geo.start(); tracking.connect(); setOnline(true); }
  };

  return (
    <div className="max-w-md mx-auto flex flex-col gap-4 p-1">
      {/* header */}
      <div className="flex items-center justify-between px-1">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-violet-400">Driver Command</p>
          <h2 className="text-lg font-black text-white">{user?.full_name || user?.name || 'Driver'}</h2>
        </div>
        <button onClick={logout} className="grid place-items-center w-9 h-9 rounded-xl bg-white/5 border border-slate-700/50 text-slate-400 hover:text-red-400 transition-colors"><LogOut size={15} /></button>
      </div>

      {/* radar + duty toggle */}
      <GlassPanel className={`p-6 text-center transition-all ${online ? 'border-emerald-500/50 shadow-[0_0_40px_rgba(52,211,153,0.15)]' : 'border-slate-700/50'}`}>
        <div className="relative mx-auto w-40 h-40 grid place-items-center">
          {online && (
            <>
              <span className="absolute inset-0 rounded-full border-2 border-emerald-500/40 animate-ping" />
              <span className="absolute inset-4 rounded-full border border-emerald-500/30 animate-ping" style={{ animationDelay: '0.4s' }} />
            </>
          )}
          <button
            onClick={toggle}
            className={`relative grid place-items-center w-28 h-28 rounded-full border-4 transition-all duration-300 active:scale-95
              ${online
                ? 'bg-gradient-to-br from-emerald-500 to-teal-700 border-emerald-300/60 shadow-[0_0_35px_rgba(52,211,153,0.5)]'
                : 'bg-slate-800/80 border-slate-600/60'}`}
          >
            <Power size={34} className={online ? 'text-white' : 'text-slate-500'} />
          </button>
        </div>
        <p className={`mt-3 text-sm font-black tracking-wider ${online ? 'text-emerald-300' : 'text-slate-500'}`}>
          {online ? 'ON DUTY — LIVE' : 'OFFLINE'}
        </p>
        <p className="text-[10px] text-slate-500">
          {online ? `Broadcasting location every ${geo.pollMs / 1000}s · bus: ${tracking.status}` : 'Go online to receive dispatches'}
        </p>
        {/* Whether the fix actually reached trip_gps_pings. The distinction
            matters to the driver: a device that refuses location still animates
            this screen off the simulator, and without this line "ON DUTY —
            LIVE" would look identical whether or not dispatch can see them. */}
        {online && lastPing && (
          <p className={`mt-1 text-[10px] font-bold ${lastPing.posted ? 'text-emerald-400' : 'text-amber-400/90'}`}>
            {lastPing.posted
              ? '● GPS recorded — dispatch can see this truck'
              : lastPing.reason === 'simulated'
                ? '● Device location off — position NOT sent to dispatch'
                : lastPing.reason === 'throttled'
                  ? '● GPS recorded — dispatch can see this truck'
                  : `● Not recorded (${lastPing.reason}${lastPing.detail ? `: ${lastPing.detail}` : ''})`}
          </p>
        )}
      </GlassPanel>

      {/* live telemetry */}
      <div className="grid grid-cols-3 gap-2">
        <GlassPanel className="p-3 text-center">
          <Gauge size={15} className="mx-auto text-cyan-400" />
          <p className="mt-1 text-lg font-black text-white">{geo.fix?.speedKmh ?? '—'}</p>
          <p className="text-[8px] uppercase text-slate-500">km/h</p>
        </GlassPanel>
        <GlassPanel className="p-3 text-center">
          <Crosshair size={15} className="mx-auto text-emerald-400" />
          <p className="mt-1 text-lg font-black text-white">{geo.fix ? `±${geo.fix.accuracy}m` : '—'}</p>
          <p className="text-[8px] uppercase text-slate-500">GPS accuracy</p>
        </GlassPanel>
        <GlassPanel className="p-3 text-center">
          <MapPin size={15} className="mx-auto text-violet-400" />
          <p className="mt-1 text-[11px] font-black text-white leading-tight">
            {geo.fix ? `${geo.fix.lat.toFixed(4)}, ${geo.fix.lng.toFixed(4)}` : '—'}
          </p>
          <p className="text-[8px] uppercase text-slate-500">{geo.fix?.simulated ? 'simulated' : 'position'}</p>
        </GlassPanel>
      </div>

      {/* assigned trip */}
      <GlassPanel className="p-4 border-violet-500/30">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[11px] font-black text-violet-300 uppercase tracking-wider"><RouteIcon size={13} /> Assigned Trip</span>
          <StatusPill tone={online ? 'green' : 'slate'} pulse={online}>{online ? tracking.tripState : 'STANDBY'}</StatusPill>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div className="flex flex-col items-center">
            <Dot color="bg-emerald-400" size="w-2.5 h-2.5" />
            <span className="w-px h-8 bg-gradient-to-b from-emerald-400/60 to-cyan-400/60" />
            <Dot color="bg-cyan-400" size="w-2.5 h-2.5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-bold text-slate-100 truncate">{ASSIGNED_TRIP.from}</p>
            <p className="mt-4 text-[12px] font-bold text-slate-100 truncate">{ASSIGNED_TRIP.to}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[11px] font-black text-white">{ASSIGNED_TRIP.id}</p>
            <p className="text-[9px] text-slate-500">{ASSIGNED_TRIP.vehicle}</p>
            <p className="text-[9px] text-amber-400 font-bold">{ASSIGNED_TRIP.product}</p>
          </div>
        </div>
      </GlassPanel>

      {/* quick actions */}
      <div className="grid grid-cols-3 gap-2">
        <button className="flex flex-col items-center gap-1 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-2 py-3 text-emerald-300 hover:bg-emerald-500/20 transition-colors">
          <PackageCheck size={17} /><span className="text-[9px] font-black">MARK UNLOADED</span>
        </button>
        <button className="flex flex-col items-center gap-1 rounded-2xl border border-cyan-500/40 bg-cyan-500/10 px-2 py-3 text-cyan-300 hover:bg-cyan-500/20 transition-colors">
          <PhoneCall size={17} /><span className="text-[9px] font-black">CALL DISPATCH</span>
        </button>
        <button className="flex flex-col items-center gap-1 rounded-2xl border border-red-500/40 bg-red-500/10 px-2 py-3 text-red-300 hover:bg-red-500/20 transition-colors">
          <AlertTriangle size={17} /><span className="text-[9px] font-black">SOS / BREAKDOWN</span>
        </button>
      </div>

      {geo.error && online && (
        <p className="text-center text-[9px] text-amber-500/80">GPS: {geo.error} — simulator engaged so dispatch still sees you.</p>
      )}
    </div>
  );
}
