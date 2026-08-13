# =============================================================================
# INSTALL ERP AUTO-HEALER - registers a Windows Scheduled Task that runs
# scripts\erp_auto_healer.cjs at every logon (daemon mode, HITL-gated).
#
#   .\scripts\install-healer-task.ps1              # install
#   .\scripts\install-healer-task.ps1 -Uninstall   # remove the task
#
# Pause the healer any time WITHOUT uninstalling: create an empty file named
# ERP_HEALER.KILL in the repo root. Delete it to resume.
# No admin rights needed - runs as the current user at logon.
# =============================================================================
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'PrasadERP-AutoHealer'
$Root     = Split-Path -Parent $PSScriptRoot
$Healer   = Join-Path $PSScriptRoot 'erp_auto_healer.cjs'
$OutLog   = Join-Path $Root 'logs\erp_healer.daemon.log'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "No task named '$TaskName' found." -ForegroundColor Yellow
  }
  return
}

if (-not (Test-Path $Healer)) { throw "Healer not found: $Healer" }

# powershell wrapper so stdout/stderr land in one daemon log (*>> appends both).
$cmd    = "& node `"$Healer`" *>> `"$OutLog`""
$psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$cmd`""

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $Root
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 `
             -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description 'PRASAD ERP safe auto-healer daemon (HITL: AI proposes, God disposes).' -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' (runs at your next logon)." -ForegroundColor Green
Write-Host "   Run it now without logging out:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "   Pause without uninstalling:      New-Item $Root\ERP_HEALER.KILL"
Write-Host "   Remove it later:                 .\scripts\install-healer-task.ps1 -Uninstall"
