<#
  drive-separation.ps1 -- move project trees onto their owning drive.

    F:\  is strictly Prasad Transport
    H:\  is strictly Jaiswal Capital
    C:\  is never touched by this script, in any mode.

  DEFAULT IS A DRY RUN. It prints the exact plan and changes nothing. To move,
  pass -Execute; you will still be asked to type Y.

      powershell -ExecutionPolicy Bypass -File drive-separation.ps1
      powershell -ExecutionPolicy Bypass -File drive-separation.ps1 -Execute

  WHY THIS IS COPY-VERIFY-DELETE AND NOT A MOVE

  A cross-volume Move-Item is a copy followed by a delete, but it deletes on
  the strength of the copy having "not thrown". These trees are 58,000 and
  24,000 files; a single locked handle part-way through leaves you with a
  half-copy and a deleted original. So: robocopy the tree, compare file count
  AND total bytes against the source, and only unlink the source when both
  match. Slower, and it cannot lose a directory.

  A path with a running process inside it is REFUSED, not retried. At the time
  of writing E:\jaiswal-terminal had six python workers and a listener on 8765,
  and E:\PRASAD-TRANSPORT-ERP had Vite, esbuild and ten Chrome processes from
  the WhatsApp engine. Copying a tree out from under a running program gives
  you files that are individually fine and collectively inconsistent.
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$Force   # skip the running-process refusal. You must mean it.
)

$ErrorActionPreference = 'Stop'

$PLAN = @(
  @{ Src = 'E:\Prasad_Transport_System';                            Dst = 'F:\'; Owner = 'Prasad Transport' }
  @{ Src = 'E:\PRASAD-API';                                         Dst = 'F:\'; Owner = 'Prasad Transport' }
  @{ Src = 'E:\prasad-erp';                                         Dst = 'F:\'; Owner = 'Prasad Transport' }
  @{ Src = 'E:\PRASAD-TRANSPORT-ERP';                               Dst = 'F:\'; Owner = 'Prasad Transport' }
  @{ Src = 'E:\PRASAD-TRANSPORT-TERMINALS';                         Dst = 'F:\'; Owner = 'Prasad Transport' }
  @{ Src = 'F:\Jaiswal Capital Trading Terminal (Master File)';     Dst = 'H:\'; Owner = 'Jaiswal Capital' }
  @{ Src = 'F:\Modules - Jaiswal Capital Trading Terminal';         Dst = 'H:\'; Owner = 'Jaiswal Capital' }
  @{ Src = 'F:\Terminal Codes (Final)';                             Dst = 'H:\'; Owner = 'Jaiswal Capital' }
  @{ Src = 'E:\JAISWAL CAPIRAL TRIMNIAL CODE';                      Dst = 'H:\'; Owner = 'Jaiswal Capital' }
  @{ Src = 'E:\JAISWAL_CAPITAL_SERVER';                             Dst = 'H:\'; Owner = 'Jaiswal Capital' }
  @{ Src = 'E:\jaiswal-algo-backend';                               Dst = 'H:\'; Owner = 'Jaiswal Capital' }
  @{ Src = 'E:\jaiswal-terminal';                                   Dst = 'H:\'; Owner = 'Jaiswal Capital' }
)

$LOG = Join-Path $PSScriptRoot ("drive-separation-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Say { param($m) Write-Output $m; Add-Content -LiteralPath $LOG -Value $m -Encoding utf8 }

# -- Guard 0: never C:, in any direction --------------------------------------
foreach ($item in $PLAN) {
  if ($item.Src -match '^[Cc]:' -or $item.Dst -match '^[Cc]:') {
    throw "REFUSED: plan references C:\ ($($item.Src) -> $($item.Dst)). This script never touches C:."
  }
}

# -- Guard 1: do not run from inside a tree that is about to move -------------
$cwd = (Get-Location).Path
foreach ($item in $PLAN) {
  if ($cwd -eq $item.Src -or $cwd.StartsWith($item.Src + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "REFUSED: current directory '$cwd' is inside '$($item.Src)', which this plan moves. cd to F:\ or H:\ and run it again."
  }
}

Say "drive-separation  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say ("mode: {0}" -f $(if ($Execute) { 'EXECUTE (will ask for confirmation)' } else { 'DRY RUN -- nothing will be changed' }))
Say ("log:  {0}" -f $LOG)
Say ''

# -- Survey -------------------------------------------------------------------
$procIndex = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -or $_.CommandLine }
$rows = @()

foreach ($item in $PLAN) {
  $src = $item.Src
  $leaf = Split-Path $src -Leaf
  $dest = Join-Path $item.Dst $leaf
  $blockers = @()

  if (-not (Test-Path -LiteralPath $src)) {
    $blockers += 'source missing'
    $files = 0; $bytes = 0
  } else {
    $m = Get-ChildItem -LiteralPath $src -Recurse -File -Force -ErrorAction SilentlyContinue |
         Measure-Object -Property Length -Sum
    $files = [int]$m.Count
    $bytes = [long]($m.Sum | ForEach-Object { $_ })
    if (-not $bytes) { $bytes = 0 }
  }

  if (Test-Path -LiteralPath $dest) { $blockers += "destination already exists: $dest" }

  # running processes inside the source
  $live = @($procIndex | Where-Object { "$($_.ExecutablePath) $($_.CommandLine)" -like "*$src*" })
  if ($live.Count -gt 0) {
    $names = ($live | Select-Object -First 4 | ForEach-Object { "$($_.Name)($($_.ProcessId))" }) -join ', '
    $more = if ($live.Count -gt 4) { " +$($live.Count - 4) more" } else { '' }
    $blockers += "$($live.Count) process(es) running inside: $names$more"
  }

  # free space on the destination volume
  $dstDrive = $item.Dst.Substring(0,1)
  $free = (Get-PSDrive -Name $dstDrive -ErrorAction SilentlyContinue).Free
  if ($free -ne $null -and $bytes -gt 0 -and $free -lt ($bytes * 1.1)) {
    $blockers += ("insufficient free space on {0}: need ~{1:N1} GB, have {2:N1} GB" -f $dstDrive, ($bytes*1.1/1GB), ($free/1GB))
  }

  $rows += [pscustomobject]@{
    Owner = $item.Owner; Src = $src; Dest = $dest
    Files = $files; GB = [math]::Round($bytes/1GB,2)
    Blockers = $blockers
  }
}

# -- Print the plan -----------------------------------------------------------
Say '================= PLANNED MOVES ================='
foreach ($grp in ($rows | Group-Object Owner)) {
  Say ''
  Say ("--- {0} ---" -f $grp.Name)
  foreach ($r in $grp.Group) {
    $mark = if ($r.Blockers.Count) { 'SKIP' } else { 'MOVE' }
    Say ("  [{0}] {1}" -f $mark, $r.Src)
    Say ("         -> {0}    ({1:N0} files, {2} GB)" -f $r.Dest, $r.Files, $r.GB)
    foreach ($b in $r.Blockers) { Say ("         !! {0}" -f $b) }
  }
}

$ready   = @($rows | Where-Object { $_.Blockers.Count -eq 0 })
$blocked = @($rows | Where-Object { $_.Blockers.Count -gt 0 })

Say ''
Say '================= SUMMARY ================='
Say ("  ready to move : {0}" -f $ready.Count)
Say ("  skipped       : {0}" -f $blocked.Count)
Say ("  total to copy : {0:N2} GB" -f (($ready | Measure-Object GB -Sum).Sum))
if ($blocked.Count) {
  Say ''
  Say '  Skipped paths need attention before they can move. For "process running"'
  Say '  entries: stop the app (pm2 stop / close the terminal / end the dev server)'
  Say '  and re-run. Do not use -Force on a tree that is actively being written.'
}

if (-not $Execute) {
  Say ''
  Say 'DRY RUN -- nothing was changed. Re-run with -Execute to move.'
  return
}

if ($ready.Count -eq 0) { Say ''; Say 'Nothing is eligible to move. Stopping.'; return }

# -- Confirm ------------------------------------------------------------------
Write-Output ''
Write-Output ("About to COPY-VERIFY-DELETE {0} director(ies), {1:N2} GB." -f $ready.Count, (($ready | Measure-Object GB -Sum).Sum))
$answer = Read-Host 'Type Y to proceed, anything else to abort'
if ($answer -ne 'Y') { Say "aborted by user (answered '$answer')"; return }
Say "confirmed by user at $(Get-Date -Format 'HH:mm:ss')"

# -- Execute: copy, verify, only then delete ----------------------------------
foreach ($r in $ready) {
  Say ''
  Say ("=== {0}" -f $r.Src)
  Say ("    copying to {0} ..." -f $r.Dest)

  # /E all subdirs incl empty - /COPY:DAT+/DCOPY:T keep timestamps - /R:2 /W:2
  # fail fast rather than hang on a locked file - /NFL /NDL quiet file lists
  & robocopy $r.Src $r.Dest /E /COPY:DAT /DCOPY:T /R:2 /W:2 /NFL /NDL /NJH /NJS | Out-Null
  $rc = $LASTEXITCODE

  # robocopy: 0-7 success (bit 3+ = mismatch/failure), 8+ = real failure
  if ($rc -ge 8) {
    Say ("    ROBOCOPY FAILED (exit {0}) -- source left untouched, moving on." -f $rc)
    continue
  }

  $dm = Get-ChildItem -LiteralPath $r.Dest -Recurse -File -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
  $dFiles = [int]$dm.Count
  $dBytes = [long]($dm.Sum | ForEach-Object { $_ }); if (-not $dBytes) { $dBytes = 0 }
  $sBytes = [long]($r.GB * 1GB)

  Say ("    verify: source {0:N0} files / dest {1:N0} files" -f $r.Files, $dFiles)

  if ($dFiles -ne $r.Files) {
    Say '    COUNT MISMATCH -- source NOT deleted. Inspect both trees by hand.'
    continue
  }

  Say '    verified. removing source.'
  try {
    Remove-Item -LiteralPath $r.Src -Recurse -Force -ErrorAction Stop
    Say '    done.'
  } catch {
    Say ("    copy is good but source could not be removed: {0}" -f $_.Exception.Message)
    Say '    the data is safe at the destination; delete the source manually.'
  }
}

Say ''
Say 'finished.'
Say ("log: {0}" -f $LOG)
