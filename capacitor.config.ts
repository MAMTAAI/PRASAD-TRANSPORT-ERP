import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.prasadtransport.erp',
  appName: 'Prasad Transport',
  webDir: 'dist',

  // ── LIVE ASSETS, NOT A FROZEN BUNDLE (2026-08-31 mandate) ─────────────────
  // Without `server.url` a Capacitor app serves whatever dist/ was on the
  // build machine the day the APK was compiled — and never anything newer.
  // The handsets in the field were running a UI weeks behind the web because
  // nobody rebuilds an APK per deploy. Pointing the WebView at production
  // turns both native shells into thin frames over the SAME hashed, service-
  // worker-updated bundle every browser gets: a deploy reaches the phones on
  // the next launch (or within the SW's two-minute check while open).
  //
  // The trade, stated plainly: first launch needs the network. This ERP is
  // useless offline anyway — every screen reads the server on mount — and the
  // service worker still caches the shell for flaky-signal moments.
  //
  // One LAST APK rebuild/redistribution is needed to carry this config to the
  // installed base; after that, never again for a UI change.
  server: {
    url: 'https://www.prasadtransport.com',
    androidScheme: 'https',
  },
};

export default config;
