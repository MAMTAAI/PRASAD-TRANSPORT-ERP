# =============================================================================
# DRIVE ISOLATION GUARD  (ASCII only - project rule)
#
# God rule 2026-08-15, permanent:
#   C:\  OS + Ollama/DeepSeek ONLY   (never application data)
#   F:\Prasad_Transport_Data   Prasad Transport ONLY
#   H:\Jaiswal_Capital_Data    Jaiswal Capital ONLY (tick data, VEG models,
#                              algorithmic trading tables)
#
# This is the CHECKER, not a mover. It reports cross-contamination in both
# directions and exits non-zero when it finds any, so it can be wired into a
# scheduled task or a pre-flight check. It deliberately does not delete or
# relocate anything: deciding where a business document belongs is a human
# call, and a guard that silently moves files is how data goes missing.
#
#   .\scripts\drive-isolation-guard.ps1
#   .\scripts\drive-isolation-guard.ps1 -Quiet    (exit code only)
# =============================================================================
param([switch]$Quiet)

$ErrorActionPreference = 'SilentlyContinue'

$PRASAD_ROOT  = 'F:\Prasad_Transport_Data'
$JAISWAL_ROOT = 'H:\Jaiswal_Capital_Data'

# Names that identify the OTHER company. Kept deliberately narrow: broad words
# like "data" or "report" would flag half the disk and train people to ignore
# this check.
$PRASAD_MARK  = 'prasad|iocl|bilty|lorry|tanker|\bATF\b'
$JAISWAL_MARK = 'jaiswal|rudra|mamta|shool|sthambh|banknifty|finnifty|\bveg[_\-]|tick_data'

$issues = @()

function Scan([string]$root, [string]$foreignPattern, [string]$owner, [string]$foreign) {
  if (-not (Test-Path $root)) {
    $script:issues += [pscustomobject]@{ Kind = 'MISSING_ROOT'; Owner = $owner; Path = $root }
    return
  }
  # Match the LEAF NAME only. Matching the whole relative path made one
  # mixed-name ancestor ("all data prasad and jaiswal") flag every one of the
  # 4,500 files beneath it - thousands of findings for a single naming choice,
  # which is exactly how a check trains people to ignore it.
  Get-ChildItem $root -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -match $foreignPattern) {
      $script:issues += [pscustomobject]@{
        Kind = 'FOREIGN_DATA'; Owner = $owner; Foreign = $foreign; Path = $_.FullName
      }
    }
  }
  # Report mixed-ownership FOLDERS once each, as advisory - they are a human
  # filing decision, not a contamination bug.
  Get-ChildItem $root -Recurse -Force -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -match $PRASAD_MARK -and $_.Name -match $JAISWAL_MARK) {
      $script:issues += [pscustomobject]@{
        Kind = 'MIXED_FOLDER_NAME'; Owner = $owner; Foreign = 'BOTH'; Path = $_.FullName
      }
    }
  }
}

Scan $JAISWAL_ROOT $PRASAD_MARK  'JAISWAL(H:)' 'PRASAD'
Scan $PRASAD_ROOT  $JAISWAL_MARK 'PRASAD(F:)'  'JAISWAL'

# FORBIDDEN DRIVES: C: and E: must hold no application data of either company.
#
# This block used to look at Desktop, Documents and Downloads only, and E: was
# not checked at all. That is exactly why the 2026-08-18 consolidation found a
# live Firebase project at C:\Users\<user>\Prasad_Transport_System, design
# assets under Pictures\, and the whole ERP still running from E: -- while this
# guard reported CLEAN throughout. A checker that watches three folders on one
# drive is not a drive rule, so both the breadth and the drive list widen here.
#
# AppData is excluded deliberately: Claude/Gemini/npm caches keyed by project
# name live there by design and are tool state, not business data. Flagging
# them would produce permanent noise and train people to ignore this report.
$FORBIDDEN = @()
$U = $env:USERPROFILE
if ($U -and (Test-Path $U)) {
  $FORBIDDEN += Get-ChildItem $U -Force -Directory -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -notin @('AppData','.claude','.gemini','.cache','.vscode','.ssh') } |
                  Select-Object -ExpandProperty FullName
}
if (Test-Path 'E:\') {
  $FORBIDDEN += Get-ChildItem 'E:\' -Force -Directory -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -notmatch 'RECYCLE|System Volume Information' } |
                  Select-Object -ExpandProperty FullName
}

foreach ($d in $FORBIDDEN) {
  if (-not (Test-Path $d)) { continue }
  $drive = ($d.Substring(0,1)).ToUpper()
  $kind  = 'ON_' + $drive + '_DRIVE'

  # The FOLDER name alone is enough to convict: a directory called
  # "Prasad_Transport_System" is company data even when every file inside it is
  # named index.js. Checking file names only is how a whole project stays
  # invisible to this guard, which is precisely what happened.
  $leaf = Split-Path $d -Leaf
  if ($leaf -match $PRASAD_MARK -or $leaf -match $JAISWAL_MARK) {
    $script:issues += [pscustomobject]@{
      Kind = $kind; Owner = ($drive + ':'); Foreign = 'EITHER'; Path = $d }
    continue    # tree already condemned; do not also list every file beneath it
  }

  Get-ChildItem $d -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    # Source repos and .git internals are tooling, not business data.
    if ($_.FullName -match '\\.git\|\node_modules\') { return }
    if ($_.Name -match $PRASAD_MARK -or $_.Name -match $JAISWAL_MARK) {
      $script:issues += [pscustomobject]@{
        Kind = $kind; Owner = ($drive + ':'); Foreign = 'EITHER'; Path = $_.FullName }
    }
  }
}

if (-not $Quiet) {
  Write-Host "=== DRIVE ISOLATION GUARD ===" -ForegroundColor Cyan
  Write-Host ("  F: Prasad   {0}" -f $(if (Test-Path $PRASAD_ROOT)  { 'present' } else { 'MISSING' }))
  Write-Host ("  H: Jaiswal  {0}" -f $(if (Test-Path $JAISWAL_ROOT) { 'present' } else { 'MISSING' }))
  Write-Host ""
  if ($issues.Count -eq 0) {
    Write-Host "  CLEAN - no cross-contamination, no project data on C: or E:" -ForegroundColor Green
  } else {
    Write-Host ("  {0} ISSUE(S):" -f $issues.Count) -ForegroundColor Yellow
    $issues | Group-Object Kind | ForEach-Object {
      Write-Host ("   [{0}] {1}" -f $_.Name, $_.Count) -ForegroundColor Yellow
      $_.Group | Select-Object -First 8 | ForEach-Object { Write-Host ("     {0}" -f $_.Path) -ForegroundColor DarkYellow }
      if ($_.Count -gt 8) { Write-Host ("     ... and {0} more" -f ($_.Count - 8)) -ForegroundColor DarkYellow }
    }
    Write-Host ""
    Write-Host "  Move each item to its owner's drive. This guard never moves files itself." -ForegroundColor DarkGray
  }
}

exit $(if ($issues.Count -eq 0) { 0 } else { 1 })
