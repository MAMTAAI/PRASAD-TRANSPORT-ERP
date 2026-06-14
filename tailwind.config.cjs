/** @type {import('tailwindcss').Config} */
// Local Tailwind build (replaces cdn.tailwindcss.com). Default v3 theme to
// match the Play-CDN output exactly — utilities + Preflight behave the same,
// so existing className-based styling renders identically but works offline.
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
