# Google Play Console — Prasad Transport ERP

Everything needed to get `com.prasadtransport.erp` from this repo onto Play,
and to ship every update after that.

**App:** Prasad Transport ERP · `com.prasadtransport.erp`
**Current build:** versionName `1.0.1`, versionCode `3`
**Bundle:** `android/app/build/outputs/bundle/release/app-release.aab` (4.7 MB)

> versionCode 1 and 2 are both spent — Play refuses a code it has seen before,
> even for a release that was never rolled out. 3 is the first unused one.

---

## ⛔ Three things that must be true before you submit

These are not polish. Each one, left undone, either breaks the app on every
phone or gets the submission rejected.

### 1. `https://localhost` must be in `ALLOWED_ORIGINS` on the AWS box

The Android app is a Capacitor shell: its web view serves the bundle from the
origin `https://localhost`, and every API call is therefore cross-origin. The
API's CORS allowlist had `capacitor://localhost` (iOS) and `http://localhost`,
but not the `https://` form Android actually uses — so the API would refuse
every request from the app while the browser kept working perfectly.

Fixed in this repo's `.env` and `.env.example`. **The production `.env` on the
AWS box is not in git, so it is still wrong.** On the box:

```bash
sudo -u www-data grep ALLOWED_ORIGINS /var/www/prasad-erp/.env
# add https://localhost to the list, then
pm2 restart prasad-api
```

Verify from anywhere:

```bash
curl -si -X OPTIONS https://prasadtransport.com/api/v1/masters/vehicles \
  -H 'Origin: https://localhost' \
  -H 'Access-Control-Request-Method: GET' | grep -i access-control-allow-origin
# must echo: access-control-allow-origin: https://localhost
```

If that header is missing, the app installs, launches, and fails every screen.

### 2. The privacy policy has to be live before you paste its URL

`public/privacy.html` is written and committed, but Play's reviewer fetches the
URL anonymously and a 404 fails the review. It goes live when the commit
reaches `main` — the box rebuilds `dist/` on deploy, which copies `public/`
into it.

```
https://prasadtransport.com/privacy.html
```

**Checking for HTTP 200 is not enough.** That URL already answers 200 today:
the SPA fallback serves `index.html` for any unknown path, so an unwritten
policy page looks perfectly healthy to a status-code check and shows the
reviewer a login screen. Open it in a private window and confirm you can read
the words "Privacy Policy" on it.

Remember that pushing `main` **is** the production release (see CLAUDE.md).

### 3. The reviewer's account currently sees an empty app

`play.review@prasadtransport.com` exists and has a password set, but its
`permissions` is `{"grants": []}` — zero modules. A reviewer signing in with it
lands on an app with nothing in it, and "we could not access the app's
functionality" is one of the most common rejection reasons there is.

Give it read access to a few real modules (Master Control → User Approvals /
Staff Profiles & Powers), then **sign in with those exact credentials yourself
on a real phone** before submitting. Whatever you see is what the reviewer sees.

Also confirm the account exists in the **production** database, not just the
local one — the app talks to `prasadtransport.com`, so that is the database
that matters.

---

## What is in this folder

| file | Play Console slot |
|---|---|
| `icon-512.png` | App icon (512×512, 32-bit) |
| `feature-graphic.png` | Feature graphic (1024×500) |
| `screenshots/01-command-center.png` | Phone screenshot |
| `screenshots/02-fleet-kpis.png` | Phone screenshot |
| `screenshots/03-accounts.png` | Phone screenshot — **see the note below** |
| `screenshots/04-crm.png` | Phone screenshot |
| `screenshots/05-staff-access.png` | Phone screenshot |

All five screenshots are 1080×1920, captured from the real app against the real
database by `node -r dotenv/config scripts/play-screenshots.mjs`. They are real
captures on purpose: Play treats a mocked-up "hero" image in a phone slot as
deceptive.

> **`03-accounts.png` shows the firm's actual figures** — freight income,
> receivables, trip expenses. A Play listing is public to anyone on the
> internet. If you would not put those numbers on a billboard, drop that one
> and upload the other four; Play needs a minimum of two.

The icon is already set on the Play listing and matches the launcher icon, so
`icon-512.png` is only needed if you want to replace it. It is upscaled from
the 192px launcher raster, which is the largest copy of the logo in this repo —
if the original artwork exists at a higher resolution, that is the better file.

---

## Store listing copy

**App name** (30 max)

```
Prasad Transport ERP
```

**Short description** (80 max — currently 78)

```
Fleet, trips, fuel, billing and live tracking for the Prasad Transport office.
```

**Full description** (4000 max)

```
Prasad Transport ERP is the internal operations system of Prasad Transport,
Bongaigaon, Assam. It is issued to our own staff, drivers and business
partners. Accounts are created by the office — there is no public sign-up.

WHAT IT DOES

Fleet and trips
Vehicles, drivers, owners and branches in one master. Open a trip, record
loading and unloading, and settle it — with the freight, advances, expenses and
driver khata all attached to the same trip.

Live tracking
A driver on duty puts the truck on the dispatch board. The customer sees the
progress of their own consignment, and nobody else's.

Fuel and running costs
Fuel entries, tolls and FASTag, tyres, batteries and maintenance, each posted
against the vehicle it belongs to.

Billing and the books
Customer bills, monthly billing runs, TDS and GST, ledgers, cash and bank book,
profit and loss and the balance sheet. Every figure opens the rows behind it,
and vouchers are posted through a single accounting path so the books stay
balanced.

Documents
Photograph a bill or a permit and file it against the trip, vehicle or invoice
it belongs to.

Roles
Office staff, drivers, customers and transport partners each sign in to their
own view. What a person can open is set by the office, per module.

ABOUT ACCESS

This is a private business application, not a consumer product. It needs an
account issued by Prasad Transport and an internet connection. Location is
requested only for a driver on duty, only while the app is on screen, and can
be refused without stopping the rest of the app from working.

Prasad Transport, Bongaigaon, Assam, India
prasadtransport699@gmail.com
```

**Category:** Business
**Tags:** Business, Productivity
**Contact email:** `prasadtransport699@gmail.com`
**Website:** `https://prasadtransport.com`
**Privacy policy:** `https://prasadtransport.com/privacy.html`

---

## The form answers

Play asks the same questions in several places. These are the answers that
match what this app actually does — each one is checkable against the code.

### App access
The app is **entirely behind a login**, so this section is mandatory and is the
one most likely to sink the review.

- Choose **"All or some functionality is restricted"**
- Add an instruction set:
  - Name: `Staff login`
  - Username: `play.review@prasadtransport.com`
  - Password: *(the password set for that account)*
  - Instructions:
    ```
    Open the app and sign in with the email and password above on the login
    screen. No OTP is required for this account. After signing in the app opens
    on the operations dashboard; the tabs at the bottom of the screen switch
    between Operations, Accounts and CRM.
    ```

### Ads
**No**, this app contains no ads. (Verified: no ad SDK in `package.json`.)

### Content rating questionnaire
- Category: **Utility, Productivity, Communication or Other**
- Violence, sexuality, language, controlled substances, gambling: **No** to all
- User-generated content shared with other users: **No** — uploads are business
  documents visible only to authorised staff, not a social feed
- Does the app share the user's location with other users: **Yes** — a driver's
  position is visible to the office and to the customer of that consignment
- Expected result: **Rated for 3+ / Everyone**

### Target audience and content
- Target age group: **18 and over** only
- Is the app designed for children: **No**
- Do not opt into the Designed for Families programme

### Data safety
Answer **Yes, this app collects/shares user data**, then:

| Data type | Collected | Shared | Required | Purpose |
|---|---|---|---|---|
| Name | Yes | No | Yes | App functionality, Account management |
| Email address | Yes | No | Yes | App functionality, Account management |
| Phone number | Yes | No | Yes | App functionality, Account management |
| Precise location | Yes | **Yes** | No (optional) | App functionality |
| Photos | Yes | No | No | App functionality |
| App activity / other actions | Yes | No | Yes | App functionality, Analytics *(own operational logs only)* |
| Crash logs / diagnostics | No | No | — | — |

Then:

- **Is all data encrypted in transit?** Yes (HTTPS only; the manifest sets
  `usesCleartextTraffic="false"`)
- **Can users request data deletion?** Yes — by email, stated in the policy
- **Precise location is "shared"** because a customer sees the driver's position
  on their own consignment. That is a different party, so Play counts it as
  sharing even though it never leaves the business relationship. Do not answer
  "No" here.
- Nothing is collected for advertising or marketing, and no data is sold.

### Government apps
**No** — this is a private company's internal system.

### Financial features
**No** — the app keeps the company's own books. It does not provide banking,
lending, payments or investment services to its users.

### Health / COVID / news / other declarations
**No** to all.

---

## Publishing route

Play now requires a **closed test before production** for new apps. If the
developer account is a personal (individual) account, that closed test must run
with **at least 12 testers who stay opted in for 14 continuous days** before the
"Apply for production access" button appears. An organisation account does not
carry the 12/14 requirement. Plan the calendar around this — it is the longest
pole, not the build.

**1. Internal testing** — instant, up to 100 testers, no wait
Test and release → Testing → Internal testing → Create new release
→ upload `app-release.aab` → add testers by email → share the opt-in link.
Use this to confirm on a real phone that login works and screens load data.
This is where a CORS or API-base mistake shows up.

**2. Closed testing** — the gate to production
Same flow, Closed testing track. Recruit the 12 testers here if the account is
personal. The clock starts when the release goes live to them.

**3. Production**
Once closed testing has satisfied the requirement, apply for production access
and promote the release.

At each step Play will not let you submit until Store listing, App access,
Ads, Content rating, Target audience, Data safety and the privacy policy URL
are all filled in — the section list in the left rail shows what is still open.

---

## Building a new version

One command does the whole chain and refuses to hand you a broken bundle:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1 -Bump patch
```

It bumps the version, builds the web bundle **with the production API origin
baked in**, syncs Capacitor, assembles a signed release AAB, and then verifies
three things before declaring success:

1. `https://prasadtransport.com` actually appears in the shipped JavaScript
2. the API-base resolver made it into the bundle
3. the bundle carries a signature block

Options: `-ApiUrl https://staging.example.com` to point a build elsewhere,
`-Bump none|patch|minor|major`, `-SkipWebBuild` to reuse `dist/`.

**Every upload needs a higher `versionCode`.** It lives in
`android/version.properties`; `-Bump` moves it, or
`node scripts/bump-android-version.cjs patch` on its own. A reused code is
rejected permanently, even if the release that used it was discarded.

### Why the script exists

The bundle built by hand on 15-08-2026 shipped `http://127.0.0.1:3300` as its
API base — every phone was told to call itself. Capacitor serves the app from
`https://localhost`, and the resolver in `src/lib/apiBase.ts` read that
hostname as "this is local development". The app installed, launched, painted
its shell and failed every request, and nothing in the build complained.

Two things fixed it: the resolver now detects a native shell explicitly, and
the environment variable is read through the statically-analysable spelling
`import.meta.env.VITE_AGENT_API_URL` — the optional-chained form Vite cannot
substitute compiled down to a read from an empty object, so the variable was
being set and ignored.

---

## The upload key

```
F:\Prasad_Transport_Data\keystore\prasad-upload.jks     (NOT in git)
alias   prasad-upload
subject CN=Prasad Transport, OU=ERP, O=Prasad Transport, L=Bongaigaon, ST=Assam, C=IN
valid   15-08-2026 → 31-12-2053
SHA-256 4D:70:DE:96:BA:21:C6:4E:89:C5:6F:5C:11:FB:3C:7C:FB:44:FC:F1:58:7B:A3:97:32:17:B1:CB:CB:EB:1A:08
SHA-1   BC:5F:21:8A:A6:F5:3E:25:63:A7:C7:0D:CD:93:48:D7:50:C5:83:35
```

This key is the only thing that lets you publish an update to this listing.
Back up the `.jks` file and `KEYSTORE-CREDENTIALS.txt` somewhere that is not
this machine. Losing it means asking Play support to reset the upload key.

---

## iPhone

There is no iOS build and none is planned. iPhone users install the web app
instead — see `docs/IPHONE-PWA.md`.
