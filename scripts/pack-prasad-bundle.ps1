<#
  pack-prasad-bundle.ps1 -- build a deployment bundle for the dedicated Prasad
  box, and refuse to build it if Jaiswal Capital material is inside.

      powershell -ExecutionPolicy Bypass -File pack-prasad-bundle.ps1            # audit only
      powershell -ExecutionPolicy Bypass -File pack-prasad-bundle.ps1 -Execute   # audit, then pack

  THE AUDIT IS THE POINT, NOT THE ZIP

  Anyone can tar a folder. The reason this script exists is the distinction that
  a naive grep for "jaiswal" gets wrong, in both directions:

    JAISWAL ENTERPRISE  is a TRANSPORT FLEET OWNER in the Prasad ERP. It owns
                        trucks, it appears in trips, ledgers and IOCL bills, and
                        tools/iocl_recon/jaiswal_token.json is its Gmail token
                        (jaiswalenterprise2016@gmail.com, gmail.readonly).
                        This BELONGS in the bundle. Stripping it would corrupt
                        the ERP's own party data.

    JAISWAL CAPITAL     is the TRADING COMPANY. Algo engine, MongoDB, MCX/NSE
                        symbols, pine scripts, trading knowledge graph. NONE of
                        this may ship.

  So the scanner matches on trading-specific signals, not on the word "jaiswal".
  A hit is reported with its file and line so a human can judge it; the pack is
  refused while any CRITICAL hit stands.
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$OutDir = 'F:\Prasad_Transport_Data\deploy-bundles'
)

$ErrorActionPreference = 'Stop'
$STAMP = Get-Date -Format 'yyyyMMdd-HHmmss'

# Paths never packed: build output, dependencies, local caches, and anything
# holding a live credential that must be provisioned on the target instead.
$EXCLUDE_DIRS = @(
  'node_modules', '.git', 'dist', '.vite', 'coverage', '__pycache__',
  '.wwebjs_auth', '.wwebjs_cache', 'uploads', 'backups', '.claude'
)
# Secrets are deliberately NOT bundled -- they are placed on the target box by
# hand. A bundle that carries .env is a bundle that leaks when it is copied.
$EXCLUDE_FILES = @('.env', '.env.api', '.env.production.local', '*.pem', '*.key', 'gmail_token.json', 'jaiswal_token.json', 'gmail_credentials.json')

# CRITICAL = Jaiswal Capital trading material. Blocks the pack.
$CRITICAL = @(
  @{ Name = 'trading knowledge graph'; Pattern = 'mamta-kg-trading|domain\s*=\s*.trading.|seed-trading' }
  @{ Name = 'algo engine';             Pattern = 'Algo-Engine|algo_engine|autotrader|jaiswal-algo' }
  @{ Name = 'trading mongo';           Pattern = 'MONGO_URI|mongodb\+srv' }
  @{ Name = 'broker/market keys';      Pattern = 'KITE_API|ZERODHA|DHAN_|ANGEL_|SMARTAPI|FYERS|UPSTOX' }
  @{ Name = 'terminal codes';          Pattern = 'Terminal Codes \(Final\)|jaiswal-terminal|JAISWAL_CAPITAL_SERVER' }
  @{ Name = 'jaiswal capital db';      Pattern = 'jaiswal_capital_db|jaiswal_app' }
)
# WARN = mentions worth a human glance, never a blocker.
$WARN = @(
  @{ Name = 'jaiswal capital (text)';  Pattern = 'Jaiswal\s*Capital' }
  @{ Name = 'trading vocabulary';      Pattern = '\bMCX\b|\bNSE\b|pine\s*script|option\s*chain' }
)

function Get-Candidates {
  param($Root)
  Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
    $rel = $_.FullName.Substring($Root.Length).TrimStart('\')
    $parts = $rel -split '\\'
    -not ($parts | Where-Object { $EXCLUDE_DIRS -contains $_ })
  }
}

Write-Output "pack-prasad-bundle  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Output "source: $Source"
Write-Output ("mode  : {0}" -f $(if ($Execute) { 'AUDIT + PACK' } else { 'AUDIT ONLY' }))
Write-Output ''

if (-not (Test-Path -LiteralPath $Source)) { throw "source not found: $Source" }

Write-Output 'scanning (this walks every packable file)...'
$files = @(Get-Candidates -Root $Source)
Write-Output ("  {0:N0} files in scope after exclusions" -f $files.Count)
Write-Output ''

$critHits = @(); $warnHits = @()
# Only text-ish files can be scanned meaningfully.
$textExt = @('.js','.cjs','.mjs','.ts','.tsx','.jsx','.json','.py','.ps1','.sh','.sql','.md','.yml','.yaml','.env','.txt','.conf','.cfg','.ini','.html','.css')

# A COMMENT ABOUT the other company is not contamination; CODE THAT READS FROM
# it is. The first run flagged 22 criticals and nearly all were prose: this
# script's own pattern list, the docs describing the split, a slide reading
# "prasad_erp / jaiswal_capital_db". Meanwhile the three that mattered --
# erp_auto_healer.cjs defaulting to Jaiswal's bridge TOKEN, and erp_system_log
# writing into their repo -- sat undifferentiated in the same list.
#
# So prose extensions and this script itself can never raise a CRITICAL. They
# are still scanned for WARN, where a human can skim them.
$PROSE_EXT = @('.md', '.txt', '.html')
$SELF_PATH = $MyInvocation.MyCommand.Path

foreach ($f in $files) {
  if ($textExt -notcontains $f.Extension.ToLower()) { continue }
  if ($f.Length -gt 2MB) { continue }
  $text = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
  if (-not $text) { continue }
  $rel = $f.FullName.Substring($Source.Length).TrimStart('\')

  # Build output is a copy of sources already scanned; it doubles every hit.
  $isBuildArtifact = $f.FullName -match 'android\\app\\build\\' -or $f.FullName -match 'mergeReleaseAssets'
  $canBeCritical = ($PROSE_EXT -notcontains $f.Extension.ToLower()) -and
                   ($f.FullName -ne $SELF_PATH) -and (-not $isBuildArtifact)

  foreach ($rule in $CRITICAL) {
    if ($canBeCritical -and $text -match $rule.Pattern) {
      $line = ($text -split "`n" | Select-String -Pattern $rule.Pattern | Select-Object -First 1)
      $critHits += [pscustomobject]@{ Rule = $rule.Name; File = $rel; Line = ($line -replace '\s+',' ').Trim() }
    }
  }
  foreach ($rule in $WARN) {
    if ($text -match $rule.Pattern) {
      $warnHits += [pscustomobject]@{ Rule = $rule.Name; File = $rel }
    }
  }
}

Write-Output '================= CRITICAL (blocks the pack) ================='
if ($critHits.Count -eq 0) {
  Write-Output '  none -- no Jaiswal Capital trading material found'
} else {
  foreach ($h in $critHits) {
    Write-Output ("  [{0}] {1}" -f $h.Rule, $h.File)
    if ($h.Line) { Write-Output ("        {0}" -f $h.Line.Substring(0, [Math]::Min(110, $h.Line.Length))) }
  }
}

Write-Output ''
Write-Output '================= WARN (review, not blocking) ================='
if ($warnHits.Count -eq 0) { Write-Output '  none' }
else { $warnHits | Group-Object Rule | ForEach-Object { Write-Output ("  {0}: {1} file(s)" -f $_.Name, $_.Count); $_.Group | Select-Object -First 5 | ForEach-Object { Write-Output ("        {0}" -f $_.File) } } }

Write-Output ''
Write-Output '================= EXCLUDED FROM BUNDLE ================='
Write-Output ("  dirs : {0}" -f ($EXCLUDE_DIRS -join ', '))
Write-Output ("  files: {0}" -f ($EXCLUDE_FILES -join ', '))
Write-Output '  Secrets are provisioned on the target, never shipped inside a bundle.'

if (-not $Execute) {
  Write-Output ''
  Write-Output 'AUDIT ONLY -- re-run with -Execute to pack.'
  return
}
if ($critHits.Count -gt 0) {
  Write-Output ''
  Write-Output 'REFUSING TO PACK: critical hits above must be resolved first.'
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path $OutDir "prasad-erp-bundle-$STAMP.zip"
$staging = Join-Path $env:TEMP "prasad-bundle-$STAMP"

Write-Output ''
Write-Output "staging -> $staging"
$xd = ($EXCLUDE_DIRS | ForEach-Object { "/XD `"$Source\$_`"" }) -join ' '
$xf = ($EXCLUDE_FILES | ForEach-Object { "/XF `"$_`"" }) -join ' '
$cmd = "robocopy `"$Source`" `"$staging`" /E /R:1 /W:1 /NFL /NDL /NJH /NJS $xd $xf"
Invoke-Expression $cmd | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE" }

Write-Output "compressing -> $zip"
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal -Force
Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
Write-Output ''
Write-Output "bundle : $zip"
Write-Output "size   : $mb MB"
Write-Output "sha256 : $hash"
Write-Output ''
Write-Output 'The bundle carries NO .env and NO tokens. Provision those on the target box.'
