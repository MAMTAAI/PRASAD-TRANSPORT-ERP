# =============================================================================
# PRASAD TRANSPORT - LOCAL MASTER STARTUP  (ASCII only - project rule)
#
# Brings up the office PC as the AUTHORITATIVE ERP master:
#   1. PostgreSQL         local database (the master copy of the books)
#   2. Sync tunnel        outbound SSH to AWS  -> pushes changes to the cloud
#   3. ERP API            :3300, storage on F:, 10 agents + OCR
#
# Idempotent: anything already running is skipped. Safe to run any number of
# times, and safe to run at logon.
#
#   .\scripts\START-PRASAD-LOCAL.ps1
#   .\scripts\START-PRASAD-LOCAL.ps1 -Status      (check only, start nothing)
# =============================================================================
param([switch]$Status)

$ErrorActionPreference = 'Continue'
$Root   = Split-Path -Parent $PSScriptRoot

# RETIRED (owner decision 2026-08-24): production is the master. ERP_API.KILL
# marks this copy retired; server/index.js refuses to boot while it exists,
# so starting anything here would only print errors. Point people at the site.
if (Test-Path (Join-Path $Root 'ERP_API.KILL')) {
  Write-Host 'THIS COPY IS RETIRED - the ERP now runs at https://www.prasadtransport.com' -ForegroundColor Yellow
  Write-Host 'Owner decision 2026-08-24: production (AWS) is the one writer. Delete ERP_API.KILL only if that decision is reversed.' -ForegroundColor Yellow
  exit 1
}
$LogDir = 'F:\Prasad_Transport_Data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function PortUp([int]$p) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}
function WaitPort([int]$p, [int]$secs = 25) {
  for ($i = 0; $i -lt $secs; $i++) { if (PortUp $p) { return $true }; Start-Sleep -Seconds 1 }
  return $false
}

Write-Host "=== PRASAD LOCAL MASTER ===" -ForegroundColor Cyan

# -- 1. PostgreSQL ------------------------------------------------------------
$pg = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pg -and $pg.Status -ne 'Running') {
  if ($Status) { Write-Host "[down] PostgreSQL is stopped" -ForegroundColor Red }
  else { Write-Host "[start] PostgreSQL ..." -ForegroundColor Green; Start-Service $pg.Name; Start-Sleep -Seconds 5 }
} elseif ($pg) { Write-Host "[ok]   PostgreSQL running" -ForegroundColor DarkGray }
else { Write-Warning "PostgreSQL service not found - the books live here, this must run." }

# -- 2. Sync tunnel (local -> AWS) -------------------------------------------
# Outbound only: the PC dials AWS, so no static IP and no inbound firewall hole.
if (PortUp 15432) { Write-Host "[ok]   sync tunnel up (:15432)" -ForegroundColor DarkGray }
elseif ($Status)  { Write-Host "[down] sync tunnel NOT running - cloud will go stale" -ForegroundColor Yellow }
else {
  Write-Host "[start] sync tunnel ..." -ForegroundColor Green
  Start-Process -FilePath 'node' -ArgumentList 'scripts/sync-tunnel.cjs' -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'sync-tunnel.out.log') `
    -RedirectStandardError  (Join-Path $LogDir 'sync-tunnel.err.log') | Out-Null
  if (WaitPort 15432 25) { Write-Host "        tunnel up." -ForegroundColor Green }
  else { Write-Warning "tunnel did not open :15432 - check $LogDir\sync-tunnel.out.log (work continues offline)" }
}

# -- 3. ERP API (local master) ------------------------------------------------
if (PortUp 3300) { Write-Host "[ok]   ERP API up (:3300)" -ForegroundColor DarkGray }
elseif ($Status) { Write-Host "[down] ERP API NOT running" -ForegroundColor Red }
else {
  Write-Host "[start] ERP API ..." -ForegroundColor Green
  Start-Process -FilePath 'node' -ArgumentList '--expose-gc','server/index.js' -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'erp-api.out.log') `
    -RedirectStandardError  (Join-Path $LogDir 'erp-api.err.log') | Out-Null
  if (WaitPort 3300 40) { Write-Host "        API up." -ForegroundColor Green }
  else { Write-Warning "API did not open :3300 - check $LogDir\erp-api.err.log" }
}

# -- Health -------------------------------------------------------------------
Write-Host ""
Write-Host "--- HEALTH ---" -ForegroundColor Cyan
try {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3300/api/v1/auth/health' -TimeoutSec 15
  Write-Host ("  API      : ok={0}  jwt={1}" -f $h.ok, $h.jwt_secret)
  Write-Host ("  OTP      : {0} ({1})" -f $h.otp_channel.name, $(if ($h.otp_channel.ok) { 'linked' } else { $h.otp_channel.reason }))
} catch { Write-Host "  API      : NOT ANSWERING" -ForegroundColor Red }
Write-Host ("  Storage  : {0}" -f $(if (Test-Path 'F:\Prasad_Transport_Data\uploads') { 'F:\Prasad_Transport_Data OK' } else { 'F: MISSING - API will refuse to boot' }))
Write-Host ("  Cloud    : {0}" -f $(if (PortUp 15432) { 'tunnel up - AWS receiving updates' } else { 'OFFLINE - work continues, syncs when back' }))
Write-Host ""
Write-Host "Books stay correct even with no internet. The cloud catches up by itself." -ForegroundColor DarkGray
