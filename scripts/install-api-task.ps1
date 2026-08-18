# =============================================================================
# INSTALL PRASAD ERP API - registers a Windows Scheduled Task that keeps the
# Fastify API (server\index.js) running from logon onwards.
#
#   .\scripts\install-api-task.ps1              # install
#   .\scripts\install-api-task.ps1 -Uninstall   # remove the task
#
# WHY THIS TASK HAS TO EXIST.
#
# The 15-minute Gmail loading sync is a node-cron INSIDE the API process
# (server\lib\ioclSyncCron.js, "*/15 9-21 * * *"). Nothing on this machine was
# starting the API: PrasadAI-Stack runs start-ai-stack.ps1, which does not touch
# it, and PrasadERP-AutoHealer runs the healer, which does not either. So the
# cron only ran while somebody happened to have the API up.
#
# On 17-08-2026 that meant ONE tick instead of roughly fifty-two. The API came
# up at 19:24, ticked at 19:30, pulled three Prasad Transport invoices, and the
# rest of the day's window never happened. cron_sync.log shows thirty
# "cron_started" lines across the log - thirty restarts, each ticking only for
# as long as someone left it running.
#
# With this task the API starts at logon and a supervisor restarts it if it
# ever exits, so both mailboxes - prasadtransport699@gmail.com and
# jaiswalenterprise2016@gmail.com - are swept every fifteen minutes without
# anyone remembering to do anything.
#
# PAUSE WITHOUT UNINSTALLING: create an empty file named ERP_API.KILL in the
# repo root. Delete it to resume. Same convention as ERP_HEALER.KILL.
#
# No admin rights needed - runs as the current user at logon.
# ASCII ONLY. Non-ASCII in these files breaks the scheduled tasks.
# =============================================================================
param(
  [switch]$Uninstall,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$TaskName = 'PrasadERP-API'
$Root     = Split-Path -Parent $PSScriptRoot
$Daemon   = Join-Path $PSScriptRoot 'run-api-daemon.ps1'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "No task named '$TaskName' found." -ForegroundColor Yellow
  }
  return
}

if (-not (Test-Path $Daemon)) { throw "Supervisor not found: $Daemon" }

$psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Daemon`""

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# ExecutionTimeLimit Zero: this is a daemon, it is supposed to run for weeks.
# MultipleInstances IgnoreNew: a second copy would only lose a race for port
# 3300 and fill the log with EADDRINUSE.
# RestartCount is belt to the supervisor's braces - the loop inside the script
# is what actually makes it never stop.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 `
            -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
             -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description 'PRASAD ERP API (Fastify, port 3300). Hosts the 15-minute IOCL AC5 Gmail loading sync for Prasad Transport and Jaiswal Enterprise.' -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' (starts at your next logon)." -ForegroundColor Green
Write-Host "   Start it now:               Start-ScheduledTask -TaskName $TaskName"
Write-Host "   Pause without uninstalling: New-Item $Root\ERP_API.KILL"
Write-Host "   Remove it later:            .\scripts\install-api-task.ps1 -Uninstall"

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started '$TaskName' now." -ForegroundColor Green
}
