# scripts/ghostSweeper.ps1 -- Windows ghost-process sweeper (RAM reclaimer).
#
#   powershell -ExecutionPolicy Bypass -File scripts/ghostSweeper.ps1           # kill ghosts
#   powershell -ExecutionPolicy Bypass -File scripts/ghostSweeper.ps1 -DryRun   # census only
#
# WHAT COUNTS AS A GHOST (precision rules -- all must hold):
#   OFFICE APPS (WINWORD/EXCEL/POWERPNT/MSACCESS/MSPUB/VISIO/ONENOTE/AcroRd32/Acrobat):
#     - MainWindowHandle -eq 0 (no visible window)
#     - working set > 10 MB
#     - started > 5 minutes ago (never kills a doc that is still opening/printing)
#   BROWSERS (chrome/msedge/firefox/brave/opera):
#     - judged as a WHOLE PROCESS TREE, never per-process: Chrome renderers
#       legitimately have no window while the browser is open. Only when NOT A
#       SINGLE process in the tree owns a visible window AND the tree is > 5
#       minutes old is it a crashed/ghost browser -- then the tree dies together.
#
# NEVER TOUCHED (hard exclusions):
#   postgres* ollama* node* code* msedgewebview2 (owned by host apps: WhatsApp
#   Desktop, Teams, widgets -- they never own windows, that is normal), anything
#   in session 0 (services), explorer/dwm/csrss and all other system processes.
#   Targeting is ALLOWLIST-ONLY: a process not on the target list is never
#   considered, no matter how windowless it looks.
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'SilentlyContinue'

$officeTargets  = @('WINWORD','EXCEL','POWERPNT','MSACCESS','MSPUB','VISIO','ONENOTE','AcroRd32','Acrobat')
$browserTargets = @('chrome','msedge','firefox','brave','opera')
$minAgeMin = 5
$minWsMB   = 10

function Get-RamUsedMB {
  $o = Get-CimInstance Win32_OperatingSystem
  [math]::Round(($o.TotalVisibleMemorySize - $o.FreePhysicalMemory) / 1024)
}

$ramBefore = Get-RamUsedMB
$now = Get-Date
$killed = @()
$skipped = @()

# ---- 1. OFFICE GHOSTS (per-process) -----------------------------------------
foreach ($name in $officeTargets) {
  foreach ($p in (Get-Process -Name $name -ErrorAction SilentlyContinue)) {
    if ($p.SessionId -eq 0) { continue }                       # never a service
    $ageMin = ($now - $p.StartTime).TotalMinutes
    $wsMB = [math]::Round($p.WorkingSet64 / 1MB)
    if ($p.MainWindowHandle -eq 0 -and $wsMB -gt $minWsMB -and $ageMin -gt $minAgeMin) {
      $killed += [pscustomobject]@{ Kind='OFFICE-GHOST'; Name=$p.Name; Id=$p.Id; MB=$wsMB }
      if (-not $DryRun) { Stop-Process -Id $p.Id -Force -Confirm:$false }
    } elseif ($p.MainWindowHandle -eq 0) {
      $skipped += "skip $($p.Name) pid=$($p.Id) (age/size below threshold)"
    }
  }
}

# ---- 2. BROWSER GHOST TREES (whole-tree judgement) ---------------------------
foreach ($name in $browserTargets) {
  $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 })
  if (-not $procs) { continue }

  # Build parent map to find tree roots (a root's parent is not the same exe).
  $byId = @{}; foreach ($p in $procs) { $byId[$p.Id] = $p }
  $cim = @{}; foreach ($c in (Get-CimInstance Win32_Process -Filter "Name='$name.exe'")) { $cim[[int]$c.ProcessId] = [int]$c.ParentProcessId }

  $roots = @($procs | Where-Object { -not $byId.ContainsKey($cim[$_.Id]) })
  foreach ($root in $roots) {
    # Collect the tree under this root.
    $tree = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($root.Id)
    while ($queue.Count) {
      $id = $queue.Dequeue()
      if ($byId.ContainsKey($id)) { [void]$tree.Add($byId[$id]) }
      foreach ($childId in ($cim.Keys | Where-Object { $cim[$_] -eq $id })) { $queue.Enqueue($childId) }
    }
    $hasWindow = ($tree | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0
    $ageMin = ($now - $root.StartTime).TotalMinutes
    if (-not $hasWindow -and $ageMin -gt $minAgeMin) {
      $treeMB = [math]::Round(($tree | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
      $killed += [pscustomobject]@{ Kind='BROWSER-GHOST-TREE'; Name="$name x$($tree.Count)"; Id=$root.Id; MB=$treeMB }
      if (-not $DryRun) { foreach ($p in $tree) { Stop-Process -Id $p.Id -Force -Confirm:$false } }
    } else {
      $skipped += "skip $name tree root=$($root.Id) ($($tree.Count) procs) -- ALIVE: has visible window"
    }
  }
}

# ---- report ------------------------------------------------------------------
Start-Sleep -Seconds 2
$ramAfter = Get-RamUsedMB

Write-Host ""
Write-Host ("[ghostSweeper] {0}ghosts found: {1}" -f ($(if ($DryRun) {'DRY RUN -- '} else {''}), $killed.Count))
foreach ($k in $killed) { Write-Host ("  {0} {1,-22} pid={2,-7} ~{3} MB" -f $k.Kind, $k.Name, $k.Id, $k.MB) }
if (-not $killed.Count) { Write-Host "  none -- every windowless browser process belongs to a LIVE window tree" }
foreach ($s in ($skipped | Select-Object -First 6)) { Write-Host ("  {0}" -f $s) -ForegroundColor DarkGray }
Write-Host ("[ghostSweeper] RAM used: {0} MB -> {1} MB (reclaimed {2} MB)" -f $ramBefore, $ramAfter, [math]::Max(0, $ramBefore - $ramAfter))
Write-Host "[ghostSweeper] protected: postgres ollama node code webviews services"
