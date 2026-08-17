# iPhone — install Prasad Transport ERP

There is no App Store build and none is planned. On iPhone and iPad the ERP is
installed straight from the web, as a Progressive Web App. It gets its own home
screen icon, opens full-screen with no browser bars, and is the same
application the Android app runs — same login, same data, same screens.

**No Mac, no Xcode, no Apple Developer Program (₹8,900/year), no review queue.**
A change pushed to production reaches every iPhone on the next launch.

---

## Send this to staff

> **Prasad Transport ERP — iPhone par install karne ke liye:**
>
> 1. **Safari** kholein (Chrome nahi) aur **https://prasadtransport.com** par jaayein
> 2. Neeche **Share** button dabayein — 􀈂 (upar arrow wala box)
> 3. Scroll karke **"Add to Home Screen"** chunein
> 4. **Add** dabayein
>
> App ab home screen par aa gayi. Usi email/password se login karein jo office
> ne diya hai.

The Safari requirement is real: on iOS only Safari can create a home-screen app
that opens without browser chrome. From Chrome or any other browser the same
page works, but it stays inside a browser tab.

---

## What you get, and what you do not

| | iPhone (PWA) | Android (Play Store app) |
|---|---|---|
| Own home screen icon | yes | yes |
| Full screen, no browser bars | yes | yes |
| All ERP screens and data | yes | yes |
| Live GPS while on duty | yes, with permission | yes, with permission |
| Photograph a bill | yes, via the camera picker | yes, via the camera picker |
| Works with a weak signal | shell loads from cache, data still needs the network | same |
| Push notifications | not implemented for either platform | not implemented |
| Found by searching an app store | no — install by link | yes |

The two platforms run the same JavaScript bundle, so a screen that works on one
works on the other. The difference is only how it gets onto the phone.

### One thing to warn drivers about

iOS clears a web app's stored data after roughly **seven days without opening
it**. The saved session goes with it, so someone who does not use the app for a
week will be asked to log in again. Nothing is lost — the data lives on the
server — but it looks like being logged out for no reason, and a driver who
does not know that will call the office about it.

Opening the app even briefly resets the clock.

---

## Requirements

- iOS 16.4 or newer is recommended. Older versions install and run, but the
  service worker that caches the shell is less reliable before 16.4.
- The phone needs a network connection to load data. Only the app shell is
  cached.

---

## For whoever maintains this

The PWA is configured in two places and nowhere else:

- **`vite.config.ts`** — the `VitePWA({ manifest: {...} })` block is the single
  source of truth for the web manifest. The plugin writes
  `dist/manifest.webmanifest` and injects the `<link rel="manifest">` itself, so
  a hand-written manifest in `public/` gets silently overwritten and a
  hand-written `<link>` ships twice.
- **`index.html`** — the `apple-*` meta tags. Safari ignores the web manifest
  for home-screen installs, so those tags are what actually make the app open
  chrome-less, set its name, and paint under the notch.

Icons come from `scripts/gen-pwa-icons.cjs`, which rasterises
`android/.../ic_launcher_foreground.webp` — the same brand mark the Android
launcher icon composites — so both platforms show the identical icon:

```bash
node scripts/gen-pwa-icons.cjs public/icons
```

Until 17-08-2026 those icons were a 🚛 emoji on a blue gradient, left over from
before the logo was in the repo. Android was unaffected (its launcher icon
comes from `res/mipmap`), so the placeholder was only ever visible on an
iPhone home screen — which is now the whole iOS story.
