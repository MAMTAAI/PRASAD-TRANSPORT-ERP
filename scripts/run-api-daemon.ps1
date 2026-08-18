# =============================================================================
# PRASAD ERP API SUPERVISOR - keeps server\index.js alive for good.
#
# Started by the PrasadERP-API scheduled task at logon. Not meant to be run by
# hand, though it is safe to: if the API is already listening it says so and
# exits rather than fighting for the port.
#
# WHY A SUPERVISOR AND NOT JUST "start node".
#
# The 15-minute Gmail loading sync (server\lib\ioclSyncCron.js) lives INSIDE
# this process. When the API is down the cron is down with it, and nobody is
# told - the loading register simply stops filling. On 17-08-2026 that cost a
# whole day: the API happened to be started at 19:24, the cron ticked once at
# 19:30, and the other roughly forty ticks of the 09:00-21:59 window never
# happened. Three Prasad invoices landed; anything that arrived earlier waited.
#
# A scheduled task's own RestartCount stops after a handful of tries, which is
# the wrong shape for something that must simply never stop. So this loops:
# start node, wait for it to exit, pause, start it again, forever.
#
# PAUSE IT WITHOUT UNINSTALLING: create an empty file named ERP_API.KILL in the
# repo root. The loop notices within the retry interval and exits cleanly.
# Delete the file and the task starts it again at next logon (or start the task
# by hand). Same convention as ERP_HEALER.KILL.
#
# ASCII ONLY. Non-ASCII in these files breaks the scheduled tasks.
# =============================================================================
param(
  [int]$Port = 3300,
  [int]$RetrySeconds = 15
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$KillFile = Join-Path $Root 'ERP_API.KILL'

# Honour LOG_DIR the way every other writer must (see CLAUDE.md): app data
# lives on F:, not in the repo. Falls back to <repo>\logs when unset, which is
# the AWS layout.
$LogDir = $null
$EnvFile = Join-Path $Root '.env'
if (Test-Path $EnvFile) {
  $line = Select-String -Path $EnvFile -Pattern '^\s*LOG_DIR\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { $LogDir = ($line.Line -split '=', 2)[1].Trim().Trim('"').Trim("'") }
}
if (-not $LogDir) { $LogDir = Join-Path $Root 'logs' }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

$OutLog = Join-Path $LogDir 'api.daemon.log'

function Write-Log([string]$msg) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Add-Content -Path $OutLog -Value "[$stamp] $msg" -Encoding utf8
}

function Test-ApiUp {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

Write-Log "supervisor starting (port $Port, retry ${RetrySeconds}s)"

if (Test-ApiUp) {
  Write-Log "API already listening on $Port - another instance owns it, exiting"
  Write-Host "API is already running on port $Port. Nothing to do."
  return
}

while ($true) {
  if (Test-Path $KillFile) {
    Write-Log "ERP_API.KILL present - supervisor stopping"
    break
  }

  # Another process may have taken the port between loops (a manual start, or a
  # previous child that has not released it yet). Wait rather than crash-loop
  # on EADDRINUSE, which is what fills a log with nothing useful.
  if (Test-ApiUp) {
    Start-Sleep -Seconds $RetrySeconds
    continue
  }

  Write-Log "starting node server/index.js"
  # -NoNewWindow keeps it a child of this supervisor, so -Wait actually waits
  # and the task stays in the Running state while the API is up.
  $proc = Start-Process -FilePath 'node' `
    -ArgumentList '--expose-gc', 'server/index.js' `
    -WorkingDirectory $Root -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir 'api.out.log') `
    -RedirectStandardError  (Join-Path $LogDir 'api.err.log')

  if (-not $proc) {
    Write-Log "could not start node - retrying in ${RetrySeconds}s"
    Start-Sleep -Seconds $RetrySeconds
    continue
  }

  Write-Log "node started, pid $($proc.Id)"
  Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue
  Write-Log "node pid $($proc.Id) exited (code $($proc.ExitCode)) - restarting in ${RetrySeconds}s"
  Start-Sleep -Seconds $RetrySeconds
}

Write-Log "supervisor exited"
