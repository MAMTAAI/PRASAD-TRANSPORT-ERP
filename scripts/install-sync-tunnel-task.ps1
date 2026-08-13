# scripts/install-sync-tunnel-task.ps1
# Registers the AWS sync tunnel (scripts/sync-tunnel.cjs) as a Scheduled Task
# so it starts at logon and survives reboots -- same pattern as the WhatsApp
# engine and healer tasks. Run from an ELEVATED PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts/install-sync-tunnel-task.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$name = 'PrasadERP-SyncTunnel'

$action  = New-ScheduledTaskAction -Execute $node -Argument 'scripts/sync-tunnel.cjs' -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch {}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "[$name] registered and started. Check: npm run sync:tunnel:status"
