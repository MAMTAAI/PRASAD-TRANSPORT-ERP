# =============================================================================
# INSTALL AUTO-START - registers a Windows Scheduled Task that runs
# start-ai-stack.ps1 every time you log in, so Ollama + bridge are always up.
#
#   .\scripts\install-startup-task.ps1                    # install (Ollama + bridge)
#   .\scripts\install-startup-task.ps1 -WithCloudflared   # also launch cloudflared
#   .\scripts\install-startup-task.ps1 -Uninstall         # remove the task
#
# No admin rights needed - it runs as the current user at logon.
# =============================================================================
param(
  [switch]$WithCloudflared,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'PrasadAI-Stack'
$Launcher = Join-Path $PSScriptRoot 'start-ai-stack.ps1'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "No task named '$TaskName' found." -ForegroundColor Yellow
  }
  return
}

if (-not (Test-Path $Launcher)) { throw "Launcher not found: $Launcher" }

# Build the arguments for powershell.exe that the task will run.
$psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
if ($WithCloudflared) { $psArgs += ' -WithCloudflared' }

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description 'Starts Ollama + PRASAD ERP bridge (and optionally cloudflared) at logon.' -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' (runs at your next logon)." -ForegroundColor Green
Write-Host "   Run it now without logging out:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "   Remove it later:                 .\scripts\install-startup-task.ps1 -Uninstall"
