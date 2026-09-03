/** @type {import('tailwindcss').Config} */
// Local Tailwind build (replaces cdn.tailwindcss.com). Utilities + Preflight
// behave the same as the Play-CDN output, so existing className-based styling
// renders identically but works offline.
//
// ---------------------------------------------------------------------------
// 2026 "INDIGO DECK" THEME (owner-approved 3-Sep-2026, docs/mockups/
// theme-2026-indigo-deck.html)
//
// The whole app was sitting on slate-950 = #020617 — near-black, so panels,
// hairlines and numbers all read as one flat sheet and the owner's verdict was
// "only black". `slate` is the app's single most-used colour family (1,819
// class references), so re-pointing that ONE ramp to a deep-navy ramp retints
// every Tailwind-styled screen at once: Master Control v5.0, the Super-App
// portals, the approval drawers, every dark panel.
//
// Rules the ramp keeps, so nothing regresses:
//   · It stays monotonic 50 → 950, so every existing light/dark pairing holds.
//   · slate-500 is 447/455 uses a TEXT colour and appears on white portal
//     surfaces too, so it is held at 4.9:1 on white (the stock slate was 4.8).
//   · The 500-level accent fills (bg-emerald-500 with white text, and friends)
//     are left alone — brightening a solid fill would break its white label.
//     Only the 400-level shades, which are text/dot colours on dark ground,
//     are pushed toward neon.
// ---------------------------------------------------------------------------
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ---- the ground the whole ERP stands on ----
        // Deep navy, not black. Every step carries blue, so a border reads as
        // a border and a card reads as a card before you look for its edge.
        slate: {
          50:  '#f6f8fd',
          100: '#eef3fa',
          200: '#dde5f4',
          300: '#c4d1ea',
          400: '#9aadd4',   // muted text on dark panels — brighter + bluer
          500: '#5d7196',   // secondary text, holds AA on white portals
          600: '#3d548a',   // hairline on hover
          700: '#27395f',   // hairline
          800: '#18244a',   // raised surface / inset
          900: '#121c38',   // panel
          950: '#0a1024',   // app ground (was #020617)
        },

        // ---- smart status accents ----
        // Named by what they MEAN, so a new screen picks the right one without
        // remembering which hue the ERP uses for "waiting on a person".
        live:    { DEFAULT: '#22d3ee', soft: 'rgba(34,211,238,0.13)',  dim: '#0e7490' }, // GPS / tracking / anything moving now
        active:  { DEFAULT: '#2fe39b', soft: 'rgba(47,227,155,0.13)',  dim: '#047857' }, // running, settled, verified
        pending: { DEFAULT: '#ffb224', soft: 'rgba(255,178,36,0.13)',  dim: '#b45309' }, // a queue with work in it
        blocked: { DEFAULT: '#ff6b81', soft: 'rgba(255,107,129,0.13)', dim: '#be123c' }, // stopped, expired, no firm named
        mamta:   { DEFAULT: '#a78bfa', soft: 'rgba(167,139,250,0.14)', dim: '#6d28d9' }, // MAMTA AI surfaces

        // 400-level pushes: these are text and dot colours on dark ground, so
        // brightening them is free. The 500s (solid fills) stay put.
        emerald: { 400: '#2fe39b' },
        amber:   { 400: '#ffc03d' },
        red:     { 400: '#ff8b9c' },
      },

      backgroundImage: {
        // The app ground. Navy base with a cyan wash top-right and a violet
        // wash bottom-left — the thing that stops a full-screen deck reading
        // as an off monitor.
        'deck-ground':
          'radial-gradient(1200px 680px at 88% -8%, rgba(34,211,238,0.10) 0%, transparent 60%),' +
          'radial-gradient(900px 620px at 2% 104%, rgba(167,139,250,0.09) 0%, transparent 58%),' +
          'linear-gradient(180deg, #0b1228 0%, #0a1024 100%)',
        // Card lighting: a top-left tint that fades out, so a panel has a lit
        // edge instead of a flat fill.
        'deck-card': 'linear-gradient(168deg, rgba(46,66,118,0.42) 0%, rgba(18,28,56,0) 58%)',
        'deck-tile': 'linear-gradient(160deg, rgba(46,66,118,0.50) 0%, rgba(18,28,56,0) 62%)',
      },

      boxShadow: {
        // Glow rings, one per status. Used on rails, active nav rows and any
        // chip that should announce itself across the room.
        'glow-live':    '0 0 24px rgba(34,211,238,0.30)',
        'glow-active':  '0 0 24px rgba(47,227,155,0.28)',
        'glow-pending': '0 0 24px rgba(255,178,36,0.28)',
        'glow-blocked': '0 0 24px rgba(255,107,129,0.26)',
        'glow-mamta':   '0 0 24px rgba(167,139,250,0.28)',
        // Elevation on navy needs a bluer, deeper shadow than black-on-black
        // did, plus a hairline of light on the top edge.
        'deck':    '0 2px 10px rgba(4,9,26,0.45), inset 0 1px 0 rgba(255,255,255,0.045)',
        'deck-hi': '0 16px 38px rgba(4,9,26,0.60), inset 0 1px 0 rgba(255,255,255,0.070)',
      },
    },
  },
  plugins: [],
};
