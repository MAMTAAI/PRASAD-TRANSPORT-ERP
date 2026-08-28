/// <reference types="vite-plugin-pwa/client" />
// src/lib/pwaUpdate.ts
// ─────────────────────────────────────────────────────────────────────────────
// MAKING A DEPLOY ACTUALLY REACH THE SCREEN.
//
// The PWA was configured `registerType: 'autoUpdate'` and nothing imported the
// registration, so vite-plugin-pwa fell back to injecting a bare
// `navigator.serviceWorker.register('/sw.js')`. That installs a new worker and
// lets it claim the page — but the tab that is already open keeps running the
// JavaScript it loaded, so the new build appears only on the NEXT navigation.
//
// The result, measured on 28-08: the box was serving the new bundle, the live
// index.html pointed at it, and the browser still drew the old panel. One
// reload installed the worker and showed the old app; a second reload showed
// the new one. From the outside that is indistinguishable from "the deploy did
// not work", which is exactly how it was reported.
//
// `registerSW` from the virtual module is the piece that was missing: in
// autoUpdate mode it listens for the new worker taking control and reloads the
// page once, itself.
//
// AND IT CHECKS WHILE THE TAB STAYS OPEN. The dashboard is left running all
// day on the office machine, and deploys land several times a day. Without a
// periodic check, a tab opened at nine in the morning would go until somebody
// reloaded it — which, again, reads as the deploy having done nothing. Every
// two minutes is far below the three-minute deploy cron and costs one
// conditional GET of sw.js.
//
// Note this reloads the page. That is safe here and nowhere near as rude as it
// sounds: it happens only when the served build has actually changed, the app
// keeps its session in localStorage, and every screen reads its state from the
// server on mount. An unsent line in the dispatch composer is the one thing
// that would be lost, which is why the check is skipped while the tab is
// hidden — the reload then happens on the next visible tick, when nobody is
// mid-sentence.
// ─────────────────────────────────────────────────────────────────────────────
import { registerSW } from 'virtual:pwa-register';

const CHECK_EVERY_MS = 2 * 60 * 1000;

export function installPwaAutoUpdate() {
  // Nothing to register in dev, and no service worker on an insecure origin.
  if (!('serviceWorker' in navigator)) return;

  registerSW({
    // Register straight away rather than waiting for the load event: the sooner
    // the check runs, the smaller the window in which the office is looking at
    // a build we have already replaced.
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => {
        // A hidden tab that reloads is a tab that throws away whatever was
        // typed in it, unseen. The next tick catches it once it is looked at.
        if (document.visibilityState !== 'visible') return;
        // Fails while offline, which is not an error worth surfacing — the
        // point of the service worker is that the app still works.
        registration.update().catch(() => {});
      }, CHECK_EVERY_MS);
    },
  });
}
