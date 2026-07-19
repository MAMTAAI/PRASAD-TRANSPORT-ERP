# Migrating prasadtransport.com to Cloudflare (safe runbook)

Goal: move DNS to Cloudflare so we can add a stable tunnel hostname
`ollama.prasadtransport.com`, **without breaking the live website or email.**

Do the phases in order. Phase 1-2 are non-destructive (nothing changes until you
flip nameservers in Phase 3). You can stop after any phase.

---

## Current DNS (captured before migration - the baseline to preserve)

| Record | Value | Purpose |
|---|---|---|
| `www` CNAME | `prasad-transport-grup.web.app` | Website (Firebase Hosting) |
| apex `@` | GoDaddy **domain forwarding** -> www (`3.33.130.190`) | Root redirect (GoDaddy-only feature) |
| MX | `smtp.secureserver.net` (0), `mailstore1.secureserver.net` (10) | Email (GoDaddy) for info@prasadtransport.com |
| TXT | SPF + verification records (check GoDaddy panel for exact values) | Email deliverability |

> Open your **GoDaddy DNS panel** (dcc.godaddy.com -> prasadtransport.com -> DNS)
> in another tab and keep it as the authoritative list to compare against.

---

## Phase 1 - Add the site to Cloudflare (NON-destructive)

1. https://dash.cloudflare.com -> **Add a site** -> `prasadtransport.com` -> **Free** plan.
2. Cloudflare scans GoDaddy and shows the records it imported. **Review carefully.**
3. Compare the imported list against your GoDaddy panel. Confirm ALL of these exist:
   - [ ] `www` CNAME -> `prasad-transport-grup.web.app`  -> set to **DNS only (grey cloud)**
   - [ ] MX -> `smtp.secureserver.net` (priority 0)
   - [ ] MX -> `mailstore1.secureserver.net` (priority 10)
   - [ ] every TXT from GoDaddy (SPF `v=spf1 ...secureserver.net...`, any `_domainkey`
         DKIM, `_dmarc` if present) - copy any that Cloudflare missed
   - [ ] any other records GoDaddy shows (e.g. `email`, `ftp`, autodiscover) - replicate
4. **Fix the apex** (the gotcha - forwarding won't import). Add ONE of:
   - **Simplest (replicate current behavior):** leave apex with a placeholder record
     (e.g. `A @ 192.0.2.1` **proxied/orange**) and create a **Redirect Rule**:
     *Rules -> Redirect Rules -> Create* -> if hostname = `prasadtransport.com`
     then 301 to `https://www.prasadtransport.com/$1`. This reproduces the GoDaddy
     forwarding exactly.
   - **OR point apex straight at Firebase:** add apex as a custom domain in the
     Firebase console first, then in Cloudflare set `@` CNAME -> `prasad-transport-grup.web.app`
     (Cloudflare flattens CNAME-at-apex), **DNS only**.
     Use this only if you want the root to serve the site directly.

**Do not continue until the imported records match GoDaddy + the apex is handled.**

---

## Phase 2 - Create the tunnel (still non-destructive)

`cloudflared` is already installed. Run these on this PC:

```powershell
cloudflared tunnel login            # browser opens -> pick prasadtransport.com
cloudflared tunnel create prasad-ollama
cloudflared tunnel route dns prasad-ollama ollama.prasadtransport.com
```

`route dns` adds a **proxied (orange-cloud)** CNAME `ollama` ->
`<tunnel-id>.cfargotunnel.com` in the Cloudflare zone. (It works only once the zone
is active - Phase 3 - but creating it now is fine.)

Create `C:\Users\JAISWAL CAPITAL\.cloudflared\config.yml`:

```yaml
tunnel: prasad-ollama
credentials-file: C:\Users\JAISWAL CAPITAL\.cloudflared\<TUNNEL_ID>.json
ingress:
  - hostname: ollama.prasadtransport.com
    service: http://localhost:3000     # the token-gated bridge
  - service: http_status:404
```

Install as an always-on service (replaces the temporary Quick Tunnel):

```powershell
cloudflared service install
```

---

## Phase 3 - Flip nameservers at GoDaddy (the switch)

1. Cloudflare (Phase 1) gave you **two nameservers**, e.g. `xxx.ns.cloudflare.com`.
2. GoDaddy -> prasadtransport.com -> **Nameservers** -> Change -> **Custom** ->
   replace `ns43/ns44.domaincontrol.com` with Cloudflare's two.
3. Propagation: usually 15 min - a few hours (up to 24h worst case).
4. Cloudflare emails you "prasadtransport.com is now active".

### Verify AFTER activation (do all three)
```powershell
nslookup -type=NS prasadtransport.com          # -> *.ns.cloudflare.com
nslookup www.prasadtransport.com               # -> still resolves (Firebase)
curl.exe -I https://www.prasadtransport.com    # -> site loads (200/301)
```
- [ ] Website loads (www **and** apex redirect)
- [ ] **Send + receive a test email** on info@prasadtransport.com (email is the
      highest-risk item - verify explicitly)
- [ ] `curl.exe -H "X-PT-Token: <PRASAD_TOKEN>" https://ollama.prasadtransport.com/api/tags`
      returns 200 (tunnel live on the permanent hostname)

### Rollback (if anything breaks)
At GoDaddy, set nameservers back to `ns43.domaincontrol.com` / `ns44.domaincontrol.com`.
DNS returns to the old state within the propagation window. No data is lost.

---

## Phase 4 - Point the ERP at the permanent hostname

In the production `.env` used for the live build:

```env
VITE_LLM_BASE_URL=https://ollama.prasadtransport.com
VITE_BRIDGE_URL=https://ollama.prasadtransport.com
VITE_LLM_AUTH_TOKEN=<PRASAD_TOKEN>
```

Then:

```powershell
npm run build
firebase deploy --only hosting
```

Jaiswal Capital (AWS) uses the same URL with its own token (Part 5 of
CLOUDFLARE-TUNNEL-SETUP.md). Add its domain to `ALLOWED_ORIGINS` if it calls from a
browser.

---

## When you're mid-migration, bring these back to me and I'll verify:
- The list of records Cloudflare says it imported (screenshot or paste), so I can
  diff it against the GoDaddy baseline **before** you flip nameservers.
- The Tunnel ID from `cloudflared tunnel create`, so I can write your exact config.yml.
