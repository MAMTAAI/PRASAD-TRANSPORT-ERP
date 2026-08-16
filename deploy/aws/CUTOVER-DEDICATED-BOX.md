# Cutover — Prasad Transport onto its own box

Written 2026-08-16. Source box `13.127.25.123` (shared with Jaiswal Capital),
target: a dedicated Ubuntu 24.04 instance in ap-south-1, account 7341-4385-0337.

The order below is the whole point. Restore before you stop anything; verify
before you move DNS; stop the old writer before anyone can reach the new one.

---

## 0. Baseline — what the new box must reproduce exactly

Taken from the source at 12:52 on 2026-08-16, dump
`/home/ubuntu/prasad_erp-20260816-125221.dump` (6.5 MB, 98 tables, 1016 objects):

| table | rows |
|---|---|
| trips | 874 |
| ledger_entries | 5,595 |
| vehicles | 49 |
| drivers | 54 |
| loan_master | 29 |
| users | 9 |
| fuel_entries | 1,042 |

**Σ Dr = Σ Cr = 133,862,674.30.** This is the check that matters. A restore that
gets the row counts right and this wrong has silently lost or duplicated a leg,
and the books no longer balance.

---

## 1. Launch (you)

Ubuntu 24.04, t3.medium or larger, ap-south-1, 30 GB gp3. Security group: 22
from your IP, 80 and 443 from anywhere. Add the existing
`jaiswal_claude_ed25519` public key to `authorized_keys` so the deploy can
connect without a new secret changing hands.

## 2. Provision (me, one command)

```bash
scp deploy/aws/provision-prasad-box.sh ubuntu@<NEW_IP>:~
ssh ubuntu@<NEW_IP> 'bash provision-prasad-box.sh'
```

Installs node 20, pm2, postgres, nginx, the eight Chrome leaf libraries the
WhatsApp engine needs, clones the repo, builds, migrates, starts pm2 with
systemd persistence, sets ufw and the 3-minute deploy cron. Idempotent.

## 3. Secrets (me, never through the transcript)

`.env` gets `VITE_GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_SERVER_KEY`; `.env.api`
gets the PG credentials. Piped over SSH stdin, never echoed. The browser key is
referrer-restricted and already verified working for `www.prasadtransport.com`.

## 4. Data

```bash
# old box -> new box, direct
scp ubuntu@13.127.25.123:/home/ubuntu/prasad_erp-20260816-125221.dump /tmp/
scp /tmp/prasad_erp-*.dump ubuntu@<NEW_IP>:/tmp/
ssh ubuntu@<NEW_IP> 'sudo -u postgres pg_restore -d prasad_erp --clean --if-exists /tmp/prasad_erp-*.dump'
```

Then re-run the section 0 counts **and the Dr/Cr equality** on the new box. Do
not continue until they match. If the dump is older than the last live write,
take a fresh one — the numbers above are only valid for that dump file.

## 5. Verify before DNS

```bash
curl -s localhost:3200 >/dev/null && echo 'SPA ok'
curl -s localhost:3300/api/v1/auth/health
```

Reach the new box directly by IP through Cloudflare-bypass (`curl --resolve`)
and click through Master Control, the Finance Hub and a trip. Maps must draw —
that proves the referrer key survived the move.

## 6. DNS (you)

Cloudflare → prasadtransport.com → DNS → the `www` A record (and apex) →
change the origin from `13.127.25.123` to `<NEW_IP>`. Proxy status stays on.
Propagation is seconds because Cloudflare fronts it.

## 7. Stop the old writer — do not skip

```bash
ssh ubuntu@13.127.25.123 'pm2 stop prasad-erp-api prasad-erp-web prasad-ai-bridge prasad-wa-engine && pm2 save'
```

`ledger_entries` is append-only and corrections are reversing entries. Two
reachable writable copies means the same voucher lands under two different
UUIDs, and the divergence cannot be resolved by resync — only by reversing
entries through TARA. This project has had that split-brain once already. One
writer, always.

Leave the old box's `prasad_erp` database in place, stopped, for a week as a
rollback. Drop it only once the new box has taken a full backup cycle.

## 8. Afterwards

- **The WhatsApp engine is not on the box, and that is by design.** On the old
  box `WA_ENGINE_URL=http://127.0.0.1:5601`, and 5601 there is held by `sshd`:
  it is a reverse SSH tunnel to the engine running on the office PC, which is
  where the linked WhatsApp session lives. The AWS API reaches the PC's engine
  through it. Verified by comparing `/api/status` on both ends — byte-identical
  QR.

  So the new box needs the same tunnel re-established, not a new engine. If you
  do want the engine on the box instead, `prasad-wa-engine` (port 5002) exists
  in the ecosystem file for that — but only ONE engine may ever be linked to
  the number. Two linked engines both auto-reply, and drivers get every message
  twice.

  (An earlier revision of this document claimed 5601 was 5001 and collided with
  the Jaiswal trading API. That was wrong: it came from reading the code's
  fallback default `|| 'http://127.0.0.1:5001'` instead of the deployed
  `.env.api` value. Nothing was ever misrouted to the trading engine.)
- S3 for mobile uploads still needs an IAM user or instance role; nothing in
  this repo can create one without AWS credentials.
