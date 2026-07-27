# 🛡️ Phase-1 Active Defense — deployment runbook (both infrastructures)

Built **shadow-armed by default**. Nothing blocks or halts until you explicitly
arm it. Read this before flipping anything on.

## What shipped (Prasad Transport — this repo, tested)

- **Strike counter + auto IP-ban** in `security.cjs`. Every threat event with an
  IP feeds a rolling-window counter (`SOC_STRIKE_THRESHOLD`, default 5, over
  `SOC_STRIKE_WINDOW_MIN`, default 10). At/over threshold it records a ban row.
- **Two modes, one env flag:**
  - `SOC_ARM` unset / `0` → **SHADOW**: records `status='shadow'` "would-ban"
    rows and a red `ip-would-ban` radar event. **Blocks nothing.**
  - `SOC_ARM=1` → **ARMED**: records `status='enforced'`; the bridge middleware
    drops the IP with **403 at the app edge** before any handler runs.
- **Allowlist** (`SOC_IP_ALLOWLIST`, CSV) + always loopback. Put Cloudflare
  egress IPs, the office IP, and the sibling infra's IP here BEFORE arming.
- **Manual kill-switch** — `POST /security/killswitch` (token + `confirm:"HALT"`).
  Engaging returns 503 on AI/upload/KG/speak routes; the radar stays reachable so
  you can release. **Never fires automatically.** UI button lives in the radar
  widget (God/admin only, double-confirm).

### Arming Prasad (do this only after a clean shadow session)
1. Watch the radar through a full session. Confirm the "IPs WOULD-BAN" tile only
   ever names real attackers — never your own traffic, CF, or the mobile app.
2. Add trusted IPs to `SOC_IP_ALLOWLIST` in `.env`.
3. Set `SOC_ARM=1`, restart the bridge (`pm2 restart prasad-ai-bridge`).
4. The 403 drop is at the **app layer** (safe, instantly reversible: unset
   `SOC_ARM`, restart). It does NOT touch iptables, so a bad rule can never lock
   you out of the box. If you later want kernel-level drops, layer **fail2ban**
   on top of the `ip-banned` log lines rather than shelling iptables from Node.

## Jaiswal Capital (separate AWS box — NOT deployed from here)

I could not and did not deploy to the live trading box. Port the same pattern
onto its FastAPI backend (`api.py` / `routes_trading.py` / `config.py`):

- Reuse the existing `_real_ip()` (`config.py:226`) and the `security_events`
  Mongo collection + `_sec_capture()` from Phase-0.
- Add a `strike_count(ip, window)` query over `security_events`, an `ip_bans`
  collection, and a request middleware that 403s enforced bans — gated behind an
  `SOC_ARM` env var exactly as above. **Ban at the app layer first**; only add
  the iptables `INPUT ... -j DROP` rule once the app-layer bans have run clean
  for days, and keep SSH(22)/HTTP(80)/HTTPS(443) + loopback ACCEPT rules ahead
  of any DROP (same discipline as the P0 §18b lockdown).

### ⚠️ Fleet-Kill / trading kill-switch — the hard warning
The **auto** kill-switch (square-off on detected anomaly) is deliberately **not
built as automatic**. What ships is a **manual** God-triggered halt. Reasons:

- An auto square-off that false-positives during market hours liquidates real
  positions — direct, irreversible financial loss.
- It must be **backtested against historical anomaly data** and dry-run through
  several live sessions in shadow (log "WOULD SQUARE OFF X") before it is ever
  allowed to fire on its own.

**Recommended path:** wire the manual HALT button to the trading engine's
existing `/api/trades/square-off-all` (Node) as a God action first. Only after a
shadow validation period should an automatic trigger be considered, and even
then behind its own `SQUAREOFF_AUTO_ARM` flag distinct from `SOC_ARM`.

## Rollback (either infra)
- Bans: unset `SOC_ARM`, restart → instantly back to shadow (observe-only).
- Kill-switch: `POST /security/killswitch {"active":false}` or the RELEASE button.
- Nothing here writes iptables, so there is no firewall state to unwind.
