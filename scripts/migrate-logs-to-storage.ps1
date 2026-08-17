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

# NOT LOGS - LIVE PROCESS STATE. These are owned and rewritten by a running
# process (the healer updates its offsets on every tick), so they are not
# history to preserve and sweeping them is actively wrong: the owner recreates
# the file on E: within seconds, each copy differs from the last, and every run
# of this script leaves another .from-repo- snapshot behind. Once the owner
# restarts it writes to LOG_DIR directly and the file appears there by itself.
$ExcludeNames = @('.erp_healer_state.json', 'erp_heal_proposals.json')

$moved = 0; $skipped = 0; $renamed = 0; $duplicate = 0; $held = 0

# RECURSE. Logs are not all flat: server/ai_engine writes a dated JSONL under
# logs/ai_engine/, and a top-level-only sweep silently left that subtree on the
# code drive while reporting success.
foreach ($f in (Get-ChildItem -Path $Source -File -Recurse)) {
    $rel = $f.FullName.Substring($Source.Length).TrimStart('\')
    if ($ExcludeNames -contains $f.Name) {
        Write-Host ("  STATE {0,-30} live process state, not history - its owner relocates it on restart" -f $f.Name) -ForegroundColor DarkGray
        $held++
        continue
    }

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

    $target = Join-Path $LogDir $rel
    $parent = Split-Path $target -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if (Test-Path $target) {
        # IDENTICAL CONTENT IS NOT A SECOND HISTORY. A process still running the
        # pre-fix code recreates its file on E: within seconds of the sweep --
        # the healer rewrites .erp_healer_state.json on every tick -- so running
        # this before the restart used to litter the data drive with byte-for-
        # byte duplicates. Compare first: same bytes means drop the copy.
        $srcHash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
        $dstHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        if ($srcHash -eq $dstHash) {
            if ($WhatIf) {
                Write-Host ("  WOULD {0,-30} discard (identical copy already on the data drive)" -f $f.Name) -ForegroundColor DarkGray
            } else {
                Remove-Item -LiteralPath $f.FullName -Force
                Write-Host ("  SAME  {0,-30} identical copy already there - source discarded" -f $f.Name) -ForegroundColor DarkGray
            }
            $duplicate++
            continue
        }
        # Different bytes IS a different history - keep both, never overwrite.
        $stamp = $f.LastWriteTime.ToString('yyyyMMdd-HHmmss')
        $target = Join-Path $parent ("{0}.from-repo-{1}{2}" -f $f.BaseName, $stamp, $f.Extension)
        $renamed++
    }

    if ($WhatIf) {
        Write-Host ("  WOULD {0,-30} -> {1}" -f $rel, (Split-Path $target -Leaf))
    } else {
        Move-Item -LiteralPath $f.FullName -Destination $target
        Write-Host ("  MOVE  {0,-30} -> {1}" -f $rel, (Split-Path $target -Leaf)) -ForegroundColor Green
    }
    $moved++
}

# Prune what the sweep emptied, deepest first. A directory that still holds
# something (an excluded state file, a locked log) is left exactly as it is.
foreach ($d in (Get-ChildItem -Path $Source -Directory -Recurse | Sort-Object { $_.FullName.Length } -Descending)) {
    if (-not (Get-ChildItem -LiteralPath $d.FullName -Force)) { Remove-Item -LiteralPath $d.FullName -Force }
}

Write-Host ''
Write-Host ("  {0} moved, {1} skipped (locked), {2} left as live state, {3} identical discarded, {4} renamed" -f $moved, $skipped, $held, $duplicate, $renamed)
if ($skipped -gt 0) {
    Write-Host ''
    Write-Host '  Those files still have a process writing into them. After the next' -ForegroundColor Yellow
    Write-Host '  logon the stack restarts onto the data drive and lets them go -' -ForegroundColor Yellow
    Write-Host '  run this script once more then and it will finish the sweep.' -ForegroundColor Yellow
}
Write-Host ''
