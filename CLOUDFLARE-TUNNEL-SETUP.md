# 🌐 Secure Tunnel: Live Websites → Your PC's Local Ollama

This connects your **live HTTPS sites** to the **Ollama engine on your PC** safely.

- **Prasad Transport ERP** — `https://www.prasadtransport.com` (Firebase)
- **Jaiswal Capital** — hosted on AWS

Both reach the *same* local Ollama through *one* Cloudflare Tunnel and the hardened
`bridge.cjs`, each with its **own secret token**.

---

## Why a tunnel is required (read this first)

A browser on `https://www.prasadtransport.com` **cannot** call `http://localhost:11434`:

1. **Mixed Content** — HTTPS pages may not call plain `http://localhost`.
2. **`localhost` is the *visitor's* device, not your PC.** It would only ever work on
   the one machine running Ollama, never on a phone or another PC.
3. A cloud proxy can't help either — a cloud server's `localhost` is *itself*, and your
   home PC's Ollama sits behind your router (NAT), unreachable from the internet.

The **only** way to reach a service on a home PC is an **outbound tunnel**: a small
program (`cloudflared`) on your PC dials *out* to Cloudflare and gives Ollama a real
HTTPS address. This kills Mixed Content (HTTPS→HTTPS) *and* makes it reachable anywhere.

```
 Browser (HTTPS site)                    Your PC (always-on)
 ┌──────────────────┐                    ┌───────────────────────────────────┐
 │ prasadtransport  │  HTTPS + token     │  cloudflared → bridge.cjs :3000 →  │
 │ jaiswalcapital   │ ─────────────────▶ │  Ollama :11434 (gemma4:12b)        │
 └──────────────────┘   Cloudflare edge  └───────────────────────────────────┘
```

> ⚠️ **Works only while your PC + Ollama + bridge + cloudflared are running.** If the
> PC sleeps, the AI goes offline and the apps fall back to the Claude Haiku cloud engine.

---

## Part 1 — Generate the two secret tokens

Run twice (once per app) and keep the outputs safe:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- Token **#1** → Prasad Transport
- Token **#2** → Jaiswal Capital

---

## Part 2 — Configure the bridge (`.env` on your PC)

Add to `E:\PRASAD-TRANSPORT-ERP\.env`:

```env
# Both apps' tokens, comma-separated (each independently revocable)
PT_BRIDGE_TOKEN=<TOKEN_1_PRASAD>,<TOKEN_2_JAISWAL>

# Browser origins allowed to call the bridge. Add Jaiswal Capital's real AWS
# domain here. (A server-to-server AWS backend needs NO entry — it has no Origin.)
ALLOWED_ORIGINS=https://www.prasadtransport.com,https://prasadtransport.com,https://<JAISWAL_CAPITAL_DOMAIN>,http://localhost:5173,http://localhost:4173,capacitor://localhost,http://localhost

OLLAMA_BASE_URL=http://localhost:11434
```

Restart the bridge — it should log `🔒 AI routes protected — 2 client token(s) accepted.`

```powershell
node bridge.cjs
```

---

## Part 3 — Install & create the Cloudflare Tunnel

**Prereq:** `prasadtransport.com` must use Cloudflare nameservers (add the domain at
dash.cloudflare.com → *Websites* → *Add site*, then update nameservers at your registrar).

```powershell
winget install --id Cloudflare.cloudflared    # or: choco install cloudflared
cloudflared tunnel login                        # opens browser → pick prasadtransport.com
cloudflared tunnel create prasad-ollama         # note the Tunnel ID / credentials path
cloudflared tunnel route dns prasad-ollama ollama.prasadtransport.com
```

Create `C:\Users\JAISWAL CAPITAL\.cloudflared\config.yml`:

```yaml
tunnel: prasad-ollama
credentials-file: C:\Users\JAISWAL CAPITAL\.cloudflared\<TUNNEL_ID>.json

ingress:
  # Point the tunnel at the BRIDGE (not raw Ollama) — the bridge enforces the
  # token and exposes only chat + model-list, never Ollama's admin API.
  - hostname: ollama.prasadtransport.com
    service: http://localhost:3000
  - service: http_status:404
```

Test, then install as an always-on Windows service:

```powershell
cloudflared tunnel run prasad-ollama            # test in foreground first
cloudflared service install                     # auto-start on boot
```

Verify from anywhere (should be `401` without the token, `200` with it):

```powershell
curl https://ollama.prasadtransport.com/api/tags
curl -H "X-PT-Token: <TOKEN_1_PRASAD>" https://ollama.prasadtransport.com/api/tags
```

---

## Part 4 — Point Prasad Transport at the tunnel

In the **production** `.env` used for the live build:

```env
VITE_LLM_BASE_URL=https://ollama.prasadtransport.com   # local engine over the tunnel
VITE_BRIDGE_URL=https://ollama.prasadtransport.com      # cloud (Claude) engine too
VITE_LLM_AUTH_TOKEN=<TOKEN_1_PRASAD>
```

Rebuild & deploy:

```powershell
npm run build
firebase deploy --only hosting
```

The AI Brain Control panel's endpoint will now read `ollama.prasadtransport.com` and go
green when your PC is up — from any device, no Mixed Content error.

---

## Part 5 — Connect Jaiswal Capital (AWS)

Same tunnel URL, **its own token (#2)**. Two cases:

**A) Jaiswal Capital has a browser front-end (SPA):**
- Add its domain to `ALLOWED_ORIGINS` (Part 2).
- In its build config set the equivalent of:
  `LLM_BASE_URL=https://ollama.prasadtransport.com`, `AUTH_TOKEN=<TOKEN_2_JAISWAL>`
  and send the header `X-PT-Token: <TOKEN_2_JAISWAL>` on every request.

**B) Jaiswal Capital calls from its AWS backend (server-to-server):**
- **No `ALLOWED_ORIGINS` entry needed** (no browser Origin). Just send the token:

```bash
curl -X POST https://ollama.prasadtransport.com/api/chat \
  -H "X-PT-Token: <TOKEN_2_JAISWAL>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4:12b","messages":[{"role":"user","content":"hello"}],"stream":false}'
```

Either way, if Token #2 is ever leaked you rotate **only** it (edit `PT_BRIDGE_TOKEN`,
restart bridge) — Prasad Transport keeps working on Token #1.

---

## Part 6 (optional, strongest) — Cloudflare Access

The in-app token blocks bots but ships inside the browser bundle, so it isn't a true
secret. For real identity-gating, put **Cloudflare Access** in front of the hostname:

- Cloudflare dash → *Zero Trust* → *Access* → *Applications* → add `ollama.prasadtransport.com`.
- Policy: allow only your Google emails (e.g. `mamta.ai@jaiswalcapital.com`).
- For the AWS server-to-server path, create an **Access Service Token** and send its
  `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers instead of a login.

Requests are then authenticated at Cloudflare's edge *before* they ever reach your PC.

---

## Daily startup order

1. `ollama serve` (with `OLLAMA_ORIGINS="*"`)
2. `node bridge.cjs`
3. `cloudflared` (already automatic if installed as a service)

### Auto-start (done for you)

Two helper scripts handle #1 and #2 automatically:

```powershell
.\scripts\start-ai-stack.ps1            # idempotent: starts Ollama + bridge (skips whatever's already up)
.\scripts\install-startup-task.ps1      # registers a logon Scheduled Task 'PrasadAI-Stack' to run it every login
```

- Run the stack now without logging out: `Start-ScheduledTask -TaskName PrasadAI-Stack`
- Also auto-launch cloudflared (only if you did NOT install it as a service):
  `.\scripts\install-startup-task.ps1 -WithCloudflared`
- Remove auto-start: `.\scripts\install-startup-task.ps1 -Uninstall`
- Logs: `logs\ollama.*.log`, `logs\bridge.*.log`, `logs\cloudflared.*.log`
