# =============================================================================
# PRASAD AI STACK LAUNCHER - starts Ollama + bridge.cjs (and optionally
# cloudflared) so the live sites can reach the local AI engine.
#
# IDEMPOTENT: if a piece is already running (port in use) it is skipped, so this
# is safe to run at every logon or by hand any number of times.
#
#   .\scripts\start-ai-stack.ps1                 # Ollama + bridge
#   .\scripts\start-ai-stack.ps1 -WithCloudflared -TunnelName prasad-ollama
#
# cloudflared is usually installed as its OWN Windows service (see
# CLOUDFLARE-TUNNEL-SETUP.md Part 3) - only pass -WithCloudflared if you did NOT
# install it as a service and want this script to launch it too.
# =============================================================================
param(
  [switch]$WithCloudflared,
  [string]$TunnelName = 'prasad-ollama'
)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot   # repo root (scripts\ is one level down)
$LogDir  = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-PortUp([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Wait-PortUp([int]$Port, [int]$TimeoutSec = 20) {
  for ($i = 0; $i -lt $TimeoutSec; $i++) {
    if (Test-PortUp $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

Write-Host "=== PRASAD AI stack launcher ===" -ForegroundColor Cyan
Write-Host "Repo: $Root"

# -- 1. OLLAMA (:11434) -------------------------------------------------------
if (Test-PortUp 11434) {
  Write-Host "[skip] Ollama already listening on 11434." -ForegroundColor DarkGray
} else {
  Write-Host "[start] Ollama serve ..." -ForegroundColor Green
  # CORS wildcard so localhost/native callers work; the tunnel path is gated by
  # the bridge token regardless.
  $env:OLLAMA_ORIGINS = '*'
  Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'ollama.out.log') `
    -RedirectStandardError  (Join-Path $LogDir 'ollama.err.log') | Out-Null
  if (Wait-PortUp 11434 30) { Write-Host "        Ollama is up." -ForegroundColor Green }
  else { Write-Warning "Ollama did not open 11434 within 30s - check logs\ollama.err.log" }
}

# -- 2. BRIDGE (:3000) --------------------------------------------------------
if (Test-PortUp 3000) {
  Write-Host "[skip] Bridge already listening on 3000." -ForegroundColor DarkGray
} else {
  Write-Host "[start] node bridge.cjs ..." -ForegroundColor Green
  # WorkingDirectory = repo root so dotenv finds .env and google-key.json.
  Start-Process -FilePath 'node' -ArgumentList 'bridge.cjs' -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'bridge.out.log') `
    -RedirectStandardError  (Join-Path $LogDir 'bridge.err.log') | Out-Null
  if (Wait-PortUp 3000 20) { Write-Host "        Bridge is up on 3000." -ForegroundColor Green }
  else { Write-Warning "Bridge did not open 3000 within 20s - check logs\bridge.err.log" }
}

# -- 3. CLOUDFLARED named tunnel (optional) -----------------------------------
# Runs the locally-configured named tunnel via config.yml (tunnel id + creds),
# so it needs NO cert.pem. Idempotent: skips if cloudflared is already running.
if ($WithCloudflared) {
  $cfExe = Join-Path $env:LOCALAPPDATA 'Programs\cloudflared\cloudflared.exe'
  $cfCfg = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
  if (Get-Process cloudflared -ErrorAction SilentlyContinue) {
    Write-Host "[skip] cloudflared already running." -ForegroundColor DarkGray
  } elseif ((Test-Path $cfExe) -and (Test-Path $cfCfg)) {
    Write-Host "[start] cloudflared named tunnel -> ollama.prasadtransport.com ..." -ForegroundColor Green
    Start-Process -FilePath $cfExe -ArgumentList 'tunnel','--config',"`"$cfCfg`"",'run' -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $LogDir 'cloudflared.out.log') `
      -RedirectStandardError  (Join-Path $LogDir 'cloudflared.err.log') | Out-Null
    Write-Host "        cloudflared launched." -ForegroundColor Green
  } else {
    Write-Warning "cloudflared exe or ~/.cloudflared/config.yml missing - re-run the tunnel setup."
  }
} else {
  Write-Host "[info] cloudflared not managed here (pass -WithCloudflared to auto-run the named tunnel)." -ForegroundColor DarkGray
}

Write-Host "=== done ===" -ForegroundColor Cyan
