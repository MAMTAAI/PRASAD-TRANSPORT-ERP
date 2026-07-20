# =============================================================================
# INSTALL WHATSAPP ENGINE AUTO-START - registers a Windows Scheduled Task that
# runs the PRASAD PRO WhatsApp engine (whatsapp-server/server.js) at every
# logon, so the 24/7 session survives reboots.
#
#   .\scripts\install-whatsapp-task.ps1              # install
#   .\scripts\install-whatsapp-task.ps1 -Uninstall   # remove
#
# No admin rights needed - runs as the current user at logon.
# =============================================================================
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'PrasadPRO-WhatsApp'
$ServerDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'whatsapp-server'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "No task named '$TaskName' found." -ForegroundColor Yellow
  }
  return
}

if (-not (Test-Path (Join-Path $ServerDir 'server.js'))) { throw "server.js not found in $ServerDir" }

$node = (Get-Command node).Source
$action    = New-ScheduledTaskAction -Execute $node -Argument 'server.js' -WorkingDirectory $ServerDir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
             -RestartInterval (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Installed '$TaskName' - WhatsApp engine will auto-start at logon (auto-restarts on crash)." -ForegroundColor Green
Write-Host "Start it now with: Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Cyan
