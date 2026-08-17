# ============================================================================
#  consolidate-to-storage.ps1  -  move the repo's data directories onto the
#                                 data drive and leave a junction behind
#
#  Usage:
#      powershell -ExecutionPolicy Bypass -File scripts/consolidate-to-storage.ps1 -WhatIf
#      powershell -ExecutionPolicy Bypass -File scripts/consolidate-to-storage.ps1
#
#  WHY JUNCTIONS AND NOT CODE CHANGES
#  Something like fifteen places write into these directories - the healer's
#  rollback copies, the Firestore export, five IOCL recon scripts in Python, the
#  knowledge-graph SQLite files, the QA screenshot runners. Repointing every one
#  of them at a configured path is a large edit across two languages, and every
#  writer missed would silently recreate its directory on the code drive. That
#  is exactly how the 15-08-2026 move left two live log directories behind.
#
#  A junction moves the BYTES without moving the PATH: the repo path keeps
#  working for every writer, found or not, and the data lives on F:. This is
#  already the established pattern here - `uploads` has been a junction to
#  F:\Prasad_Transport_Data\uploads since the first migration.
#
#  logs\ is deliberately NOT in the table below. Its writers were fixed properly
#  to read LOG_DIR (they had to be: erp_auto_healer.cjs TAILS those files, so
#  the reader and the writers must agree on one path), and
#  scripts/migrate-logs-to-storage.ps1 sweeps the history.
#
#  SAFE TO RERUN. A directory that is already a junction is left alone.
#  ASCII ONLY - non-ASCII breaks the scheduled tasks (see CLAUDE.md).
# ============================================================================

param(
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# ---- resolve the storage root from .env ------------------------------------
$StorageRoot = $null
$EnvFile = Join-Path $RepoRoot '.env'
if (Test-Path $EnvFile) {
    $m = Select-String -Path $EnvFile -Pattern '^\s*LOCAL_STORAGE_PATH\s*=\s*(.+?)\s*$'
    if ($m) {
        $StorageRoot = $m.Matches[0].Groups[1].Value.Trim() -replace '/', '\'
        $StorageRoot = $StorageRoot -replace '^([A-Za-z]:)(?![\\])', '$1\'
    }
}
if (-not $StorageRoot) {
    Write-Host 'LOCAL_STORAGE_PATH is not set in .env - nothing to consolidate onto.' -ForegroundColor Yellow
    exit 0
}
$Volume = [System.IO.Path]::GetPathRoot($StorageRoot)
if (-not (Test-Path $Volume)) {
    Write-Host "LOCAL_STORAGE_PATH is $StorageRoot but volume $Volume is not mounted." -ForegroundColor Red
    exit 1
}

# ---- what moves where ------------------------------------------------------
# Business data goes to the top level. QA output is regenerable scratch, so it
# is kept in its own subtree rather than sitting beside the ledgers and bills.
$Map = @(
    @{ Repo = 'backups';      Target = (Join-Path $StorageRoot 'backups') }
    @{ Repo = 'reports';      Target = (Join-Path $StorageRoot 'reports') }
    @{ Repo = 'data';         Target = (Join-Path $StorageRoot 'data') }
    @{ Repo = 'mobile-shots'; Target = (Join-Path $StorageRoot 'dev-artifacts\mobile-shots') }
    @{ Repo = '.screenshots'; Target = (Join-Path $StorageRoot 'dev-artifacts\screenshots') }
)

Write-Host ''
Write-Host "  storage root : $StorageRoot"
Write-Host ''

function Test-IsLink($path) {
    $i = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if (-not $i) { return $false }
    return [bool]($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

foreach ($entry in $Map) {
    $repoPath = Join-Path $RepoRoot $entry.Repo
    $target   = $entry.Target
    $name     = $entry.Repo

    if (-not (Test-Path $repoPath)) {
        Write-Host ("  --    {0,-16} not present" -f $name) -ForegroundColor DarkGray
        continue
    }
    if (Test-IsLink $repoPath) {
        $t = (Get-Item -LiteralPath $repoPath -Force).Target
        Write-Host ("  OK    {0,-16} already a junction -> {1}" -f $name, $t) -ForegroundColor DarkGray
        continue
    }

    $files = @(Get-ChildItem -LiteralPath $repoPath -Recurse -File -ErrorAction SilentlyContinue)

    # Re-test locks HERE, not from an earlier survey: a process can open a file
    # between the survey and the move, and a half-moved directory is worse than
    # an unmoved one.
    $locked = @()
    foreach ($f in $files) {
        try { $h = [System.IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None'); $h.Close() }
        catch { $locked += $f.FullName }
    }
    if ($locked.Count) {
        Write-Host ("  SKIP  {0,-16} {1} file(s) held open - close the process and rerun" -f $name, $locked.Count) -ForegroundColor Yellow
        $locked | Select-Object -First 3 | ForEach-Object { Write-Host "          $_" -ForegroundColor Yellow }
        continue
    }

    $sizeMB = if ($files.Count) { [math]::Round(($files | Measure-Object Length -Sum).Sum/1MB, 1) } else { 0 }

    if ($WhatIf) {
        Write-Host ("  WOULD {0,-16} {1} files, {2} MB  ->  {3}" -f $name, $files.Count, $sizeMB, $target)
        continue
    }

    New-Item -ItemType Directory -Force -Path $target | Out-Null

    # Merge, never clobber. Anything already on the data drive under the same
    # name is a different history, not a stale duplicate of this one.
    $collisions = 0
    foreach ($item in (Get-ChildItem -LiteralPath $repoPath -Force)) {
        $dest = Join-Path $target $item.Name
        if (Test-Path $dest) {
            $stamp = $item.LastWriteTime.ToString('yyyyMMdd-HHmmss')
            $dest = Join-Path $target ("{0}.from-repo-{1}" -f $item.Name, $stamp)
            $collisions++
        }
        Move-Item -LiteralPath $item.FullName -Destination $dest
    }

    $leftover = @(Get-ChildItem -LiteralPath $repoPath -Force -ErrorAction SilentlyContinue)
    if ($leftover.Count) {
        Write-Host ("  FAIL  {0,-16} {1} item(s) would not move - junction NOT created" -f $name, $leftover.Count) -ForegroundColor Red
        continue
    }

    Remove-Item -LiteralPath $repoPath -Force
    New-Item -ItemType Junction -Path $repoPath -Target $target | Out-Null

    # Prove it: the junction must resolve and expose the same file count.
    $after = @(Get-ChildItem -LiteralPath $repoPath -Recurse -File -ErrorAction SilentlyContinue).Count
    $direct = @(Get-ChildItem -LiteralPath $target -Recurse -File -ErrorAction SilentlyContinue).Count
    if ($after -ne $direct) {
        Write-Host ("  FAIL  {0,-16} junction shows {1} files, target has {2}" -f $name, $after, $direct) -ForegroundColor Red
        continue
    }

    $note = if ($collisions) { " ($collisions renamed to avoid a collision)" } else { '' }
    Write-Host ("  MOVE  {0,-16} {1} files, {2} MB  ->  {3}{4}" -f $name, $files.Count, $sizeMB, $target, $note) -ForegroundColor Green
}

Write-Host ''
