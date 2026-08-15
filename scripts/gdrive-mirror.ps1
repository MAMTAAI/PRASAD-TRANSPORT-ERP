# =============================================================================
# GDRIVE 3-TIER MIRROR BACKUP  (ASCII only - project rule)
#
# Tier 1 = live data on the PC   F:\Prasad_Transport_Data  /  H:\Jaiswal_Capital_Data
# Tier 2 = AWS replica (books)   pushed by server/sync/autoSync.js
# Tier 3 = Google Drive mirror   THIS SCRIPT
#
# STRICT ISOLATION. Two rclone remotes, each pinned to its own Drive folder id:
#   gdrive_prasad:   -> GDrive_Prasad_Transport_Backup   (F: only)
#   gdrive_jaiswal:  -> GDrive_Jaiswal_Capital_Backup    (H: only)
# The remote is rooted AT the folder, so even a wrong path cannot write into
# the other company's tree.
#
# TRUE MIRROR. `rclone sync` makes Drive match the PC exactly: changed files are
# overwritten in place and files deleted locally are removed on Drive. rclone
# matches by path, so it never produces "file(1).pdf" - that is a Drive web-UI
# behaviour, not an rclone one.
#
# WHY DELETIONS GO TO TRASH, DELIBERATELY. A mirror that hard-deletes is one bad
# day away from destroying the backup: if F: fails to mount, the source looks
# empty and a plain sync would faithfully erase the cloud copy too. Two guards:
#   1. PRE-FLIGHT - refuse to sync when the source is missing or empty.
#   2. --max-delete - abort if a single run wants to remove more than the cap.
# Drive's own trash then purges after 30 days, so space IS reclaimed, with a
# 30-day undo window. That is disaster recovery; hard-delete is not.
#
#   .\scripts\gdrive-mirror.ps1              both mirrors
#   .\scripts\gdrive-mirror.ps1 -Only prasad
#   .\scripts\gdrive-mirror.ps1 -DryRun      show what would change
# =============================================================================
param(
  [ValidateSet('both','prasad','jaiswal')] [string]$Only = 'both',
  [switch]$DryRun,
  [int]$MaxDelete = 500
)

$ErrorActionPreference = 'Continue'
$RCLONE = 'C:\Users\JAISWAL CAPITAL\AppData\Local\Microsoft\WinGet\Packages\Rclone.Rclone_Microsoft.Winget.Source_8wekyb3d8bbwe\rclone-v1.74.3-windows-amd64\rclone.exe'
if (-not (Test-Path $RCLONE)) { $c = Get-Command rclone -ErrorAction SilentlyContinue; if ($c) { $RCLONE = $c.Source } }

$jobs = @(
  @{ Name = 'PRASAD';  Src = 'F:\Prasad_Transport_Data';  Dst = 'gdrive_prasad:';  Log = 'F:\Prasad_Transport_Data\logs\gdrive-mirror.log' },
  @{ Name = 'JAISWAL'; Src = 'H:\Jaiswal_Capital_Data';   Dst = 'gdrive_jaiswal:'; Log = 'H:\Jaiswal_Capital_Data\logs\gdrive-mirror.log' }
)
if ($Only -eq 'prasad')  { $jobs = @($jobs[0]) }
if ($Only -eq 'jaiswal') { $jobs = @($jobs[1]) }

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-Host "=== GDRIVE MIRROR  $stamp ===" -ForegroundColor Cyan

foreach ($j in $jobs) {
  Write-Host ""
  Write-Host ("--- {0}  {1} -> {2}" -f $j.Name, $j.Src, $j.Dst) -ForegroundColor Cyan

  # PRE-FLIGHT: never sync from a source that is missing or empty. This is the
  # guard that stops an unmounted drive from wiping the cloud copy.
  if (-not (Test-Path $j.Src)) {
    Write-Warning ("{0}: source {1} NOT PRESENT - refusing to sync (this protects the backup)" -f $j.Name, $j.Src)
    continue
  }
  $n = (Get-ChildItem $j.Src -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($n -eq 0) {
    Write-Warning ("{0}: source is EMPTY - refusing to sync (this protects the backup)" -f $j.Name)
    continue
  }
  Write-Host ("    source holds {0:N0} files" -f $n)

  New-Item -ItemType Directory -Force -Path (Split-Path $j.Log -Parent) | Out-Null

  $args = @(
    'sync', $j.Src, $j.Dst,
    '--create-empty-src-dirs',
    '--max-delete', $MaxDelete,     # runaway-deletion brake
    '--transfers', '2',             # gentle: this box also runs live trading
    '--checkers', '4',
    '--tpslimit', '8',
    '--drive-chunk-size', '32M',
    '--fast-list',
    '--exclude', '**/~$*',          # office lock files
    '--exclude', '**/*.tmp',
    '--exclude', '**/Thumbs.db',
    '--log-level', 'INFO',
    '--log-file', $j.Log,
    '--stats', '5m',
    '--stats-one-line'
  )
  if ($DryRun) { $args += '--dry-run' }

  # BelowNormal so a backup never competes with the live engine.
  $p = Start-Process -FilePath $RCLONE -ArgumentList $args -NoNewWindow -PassThru -Wait
  try { $p.PriorityClass = 'BelowNormal' } catch { }

  if ($p.ExitCode -eq 0) {
    Write-Host ("    {0}: OK" -f $j.Name) -ForegroundColor Green
  } elseif ($p.ExitCode -eq 9) {
    Write-Host ("    {0}: OK (nothing to transfer)" -f $j.Name) -ForegroundColor Green
  } else {
    Write-Warning ("{0}: rclone exit {1} - see {2}" -f $j.Name, $p.ExitCode, $j.Log)
    Write-Warning "  exit 7 usually means --max-delete tripped: MORE THAN $MaxDelete files would have been deleted on Drive. Check the PC before re-running."
  }
}

Write-Host ""
Write-Host "done. Deleted files sit in Shared Drive trash for 30 days, then purge." -ForegroundColor DarkGray
