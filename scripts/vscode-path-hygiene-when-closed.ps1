# =============================================================================
# Run vscode-path-hygiene.cjs --apply the moment VS Code is properly closed.
# (ASCII only - project rule)
#
# The cleanup cannot run under a live editor: VS Code rewrites storage.json from
# memory on exit and holds state.vscdb open in WAL mode. But the person asking
# for the cleanup is usually working inside VS Code at the time, so "close it and
# run this" is a request they cannot act on immediately. This waits instead.
#
#   powershell -ExecutionPolicy Bypass -File scripts\vscode-path-hygiene-when-closed.ps1
#
# Bounded on purpose: it gives up after -MaxHours (default 12) rather than
# lingering on the machine forever, and it exits after ONE successful run.
# =============================================================================
param(
  [int]$MaxHours = 12,
  [int]$SettleSeconds = 20,
  [string]$LogFile
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $LogFile) { $LogFile = Join-Path $PSScriptRoot 'vscode-path-hygiene.log' }

function Log($m) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  $line | Out-File -FilePath $LogFile -Append -Encoding ascii
}

Log "=== watcher start (MaxHours=$MaxHours, settle=${SettleSeconds}s) ==="

$deadline = (Get-Date).AddHours($MaxHours)
$clearFor = 0

while ((Get-Date) -lt $deadline) {
  $running = @(Get-Process -Name Code -ErrorAction SilentlyContinue).Count -gt 0

  if ($running) {
    if ($clearFor -gt 0) { Log "VS Code reappeared - settle timer reset" }
    $clearFor = 0
    Start-Sleep -Seconds 10
    continue
  }

  # Not running. Require it to STAY closed: a close-then-reopen would otherwise
  # land the write in the middle of the editor rebuilding its state.
  $clearFor += 10
  if ($clearFor -lt $SettleSeconds) { Start-Sleep -Seconds 10; continue }

  Log "VS Code closed for ${clearFor}s - applying hygiene"
  Push-Location $root
  try {
    $out = & node (Join-Path $PSScriptRoot 'vscode-path-hygiene.cjs') --apply 2>&1
    $code = $LASTEXITCODE
  } finally { Pop-Location }

  foreach ($l in $out) { Log "  $l" }

  if ($code -eq 0) {
    Log "=== done (exit 0) - watcher exiting ==="
    exit 0
  }
  # exit 2 means Code.exe came back between the check and the run; keep waiting.
  Log "hygiene returned $code - will retry"
  $clearFor = 0
  Start-Sleep -Seconds 10
}

Log "=== gave up after $MaxHours h without a clean VS Code shutdown ==="
exit 1
