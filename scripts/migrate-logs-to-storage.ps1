# ============================================================================
#  migrate-logs-to-storage.ps1  -  sweep <repo>\logs onto the data drive
#
#  Usage:
#      powershell -ExecutionPolicy Bypass -File scripts/migrate-logs-to-storage.ps1
#      powershell -ExecutionPolicy Bypass -File scripts/migrate-logs-to-storage.ps1 -WhatIf
#
#  WHY THIS EXISTS
#  Everything moved to F:\Prasad_Transport_Data on 15-08-2026, but three writers
#  hardcoded <repo>\logs and stayed on E:. Those writers now read LOG_DIR
#  (start-ai-stack.ps1, erp_auto_healer.cjs, ioclSyncRunner.js), so NEW logs go
#  to the right place from the next restart onward. This moves the history that
#  was left behind.
#
#  RUN IT TWICE. A log file with a live writer is held open, and moving it out
#  from under that writer either fails or silently detaches the redirect - the
#  process keeps logging into a handle pointing at nothing. Locked files are
#  therefore SKIPPED, not forced. Run this once now, and once more after the
#  next logon when the stack has restarted onto F: and released them.
#
#  Idempotent: nothing to move is a success, not an error.
#  ASCII ONLY - non-ASCII breaks the scheduled tasks (see CLAUDE.md).
# ============================================================================

param(
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Source   = Join-Path $RepoRoot 'logs'

# ---- resolve LOG_DIR exactly as start-ai-stack.ps1 does --------------------
$LogDir = $null
$EnvFile = Join-Path $RepoRoot '.env'
if (Test-Path $EnvFile) {
    $m = Select-String -Path $EnvFile -Pattern '^\s*LOG_DIR\s*=\s*(.+?)\s*$'
    if ($m) {
        # A backslash is not an escape character in a .NET replacement string,
        # so this must be a single one.
        $LogDir = $m.Matches[0].Groups[1].Value.Trim() -replace '/', '\'
        # 'F:Prasad_...' with no separator is drive-RELATIVE and resolves
        # against that drive's current directory rather than its root.
        $LogDir = $LogDir -replace '^([A-Za-z]:)(?![\\])', '$1\'
    }
}

if (-not $LogDir) {
    Write-Host 'LOG_DIR is not set in .env - the repo IS the log directory here. Nothing to migrate.' -ForegroundColor Yellow
    exit 0
}
if ((Resolve-Path -LiteralPath $Source -ErrorAction SilentlyContinue).Path -eq
    (Resolve-Path -LiteralPath $LogDir -ErrorAction SilentlyContinue).Path) {
    Write-Host 'LOG_DIR already points at the repo logs directory. Nothing to migrate.' -ForegroundColor Yellow
    exit 0
}

$Volume = [System.IO.Path]::GetPathRoot($LogDir)
if (-not (Test-Path $Volume)) {
    Write-Host "LOG_DIR points at $LogDir but the volume $Volume is not mounted." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $Source)) {
    Write-Host "No $Source to migrate - already clean." -ForegroundColor Green
    exit 0
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host ''
Write-Host "  from : $Source"
Write-Host "  to   : $LogDir"
Write-Host ''

$moved = 0; $skipped = 0; $renamed = 0

foreach ($f in (Get-ChildItem -Path $Source -File)) {
    # Is anything holding it open? Opening for ReadWrite with no sharing is the
    # only reliable test on Windows; there is no "is locked" property.
    $locked = $false
    try { $h = [System.IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None'); $h.Close() }
    catch { $locked = $true }

    if ($locked) {
        Write-Host ("  SKIP  {0,-30} live writer holds it - rerun after the next logon" -f $f.Name) -ForegroundColor Yellow
        $skipped++
        continue
    }

    $target = Join-Path $LogDir $f.Name
    if (Test-Path $target) {
        # Never overwrite: the file already on the data drive is the one the
        # migrated services have been writing, and it is not the same history.
        $stamp = $f.LastWriteTime.ToString('yyyyMMdd-HHmmss')
        $target = Join-Path $LogDir ("{0}.from-repo-{1}{2}" -f $f.BaseName, $stamp, $f.Extension)
        $renamed++
    }

    if ($WhatIf) {
        Write-Host ("  WOULD {0,-30} -> {1}" -f $f.Name, (Split-Path $target -Leaf))
    } else {
        Move-Item -LiteralPath $f.FullName -Destination $target
        Write-Host ("  MOVE  {0,-30} -> {1}" -f $f.Name, (Split-Path $target -Leaf)) -ForegroundColor Green
    }
    $moved++
}

Write-Host ''
Write-Host ("  {0} moved, {1} skipped (locked), {2} renamed to avoid a collision" -f $moved, $skipped, $renamed)
if ($skipped -gt 0) {
    Write-Host ''
    Write-Host '  Those files still have a process writing into them. After the next' -ForegroundColor Yellow
    Write-Host '  logon the stack restarts onto the data drive and lets them go -' -ForegroundColor Yellow
    Write-Host '  run this script once more then and it will finish the sweep.' -ForegroundColor Yellow
}
Write-Host ''
