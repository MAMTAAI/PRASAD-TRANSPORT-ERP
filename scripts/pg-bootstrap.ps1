# scripts/pg-bootstrap.ps1
# -----------------------------------------------------------------------------
# Local PostgreSQL bootstrap for Prasad Transport ERP.
#
#   powershell -ExecutionPolicy Bypass -File scripts/pg-bootstrap.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/pg-bootstrap.ps1 -Install
#
# Idempotent -- safe to re-run. It escalates only as far as it needs to:
#
#   1. service already running        -> nothing to do
#   2. service installed but stopped  -> start it
#   3. not installed                  -> install (only with -Install)
#   4. role + database missing        -> create them
#   5. migrations pending             -> apply them
#
# Installing PostgreSQL is a system-wide change requiring Administrator, so it
# is gated behind -Install rather than happening as a side effect of a status
# check. Without the flag this script reports what it would do and stops.
# -----------------------------------------------------------------------------
[CmdletBinding()]
param(
  [switch]$Install,                       # allow a system-wide PostgreSQL install
  [string]$PgVersion   = '16',
  [string]$AppUser     = 'prasad_app',
  [string]$AppDatabase = 'prasad_erp',
  [string]$AppPassword,                   # omit -> generated and written to .env
  [switch]$SkipMigrate
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Say  ($m) { Write-Host "[pg-bootstrap] $m" }
function Warn ($m) { Write-Host "[pg-bootstrap] ! $m" -ForegroundColor Yellow }
function Fail ($m) { Write-Host "[pg-bootstrap] x $m" -ForegroundColor Red }
function Good ($m) { Write-Host "[pg-bootstrap] + $m" -ForegroundColor Green }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# -- 1. Is a postgres service present? ---------------------------------------
$svc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1

if ($svc -and $svc.Status -eq 'Running') {
  Good "service '$($svc.Name)' already running"
}
elseif ($svc) {
  Say "service '$($svc.Name)' is $($svc.Status) -- starting"
  try {
    Start-Service $svc.Name
    Start-Sleep -Seconds 3
    $svc.Refresh()
    if ($svc.Status -eq 'Running') { Good "service started" }
    else { Fail "service did not reach Running (state: $($svc.Status))"; exit 1 }
  } catch {
    Fail "could not start service: $($_.Exception.Message)"
    Warn "starting a service needs Administrator -- re-run this script elevated"
    exit 1
  }
}
else {
  # -- 2. Not installed ------------------------------------------------------
  Warn "no PostgreSQL service found on this machine"

  if (-not $Install) {
    Write-Host ""
    Say "To install it, re-run with -Install from an ELEVATED PowerShell:"
    Write-Host "    powershell -ExecutionPolicy Bypass -File scripts/pg-bootstrap.ps1 -Install" -ForegroundColor Cyan
    Write-Host ""
    Say "Or skip local entirely and point the ERP at AWS RDS by setting in .env:"
    Write-Host "    RDS_PGHOST=<your-instance>.rds.amazonaws.com" -ForegroundColor Cyan
    Write-Host "    RDS_PGPASSWORD=<password>" -ForegroundColor Cyan
    Write-Host "    PGSSL=true" -ForegroundColor Cyan
    Say "server/db/pool.js falls back to RDS automatically when local is down."
    exit 2
  }

  if (-not (Test-Admin)) {
    Fail "-Install requires Administrator. Re-run from an elevated PowerShell."
    exit 1
  }

  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say "installing PostgreSQL $PgVersion via winget (this takes a few minutes)"
    # --silent avoids the GUI wizard; the EnterpriseDB installer defaults the
    # superuser to 'postgres' and prompts for its password unless preseeded.
    winget install --id "PostgreSQL.PostgreSQL.$PgVersion" --silent `
      --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0) { $installed = $true } else { Warn "winget exited $LASTEXITCODE" }
  }
  if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) {
    Say "falling back to chocolatey"
    choco install postgresql$PgVersion -y --no-progress
    if ($LASTEXITCODE -eq 0) { $installed = $true } else { Warn "choco exited $LASTEXITCODE" }
  }
  if (-not $installed) { Fail "install failed -- install PostgreSQL manually, then re-run"; exit 1 }

  Good "PostgreSQL installed"
  Start-Sleep -Seconds 5
  $svc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($svc -and $svc.Status -ne 'Running') { Start-Service $svc.Name; Start-Sleep -Seconds 3 }
}

# -- 3. Locate psql ----------------------------------------------------------
$psql = (Get-Command psql -ErrorAction SilentlyContinue).Source
if (-not $psql) {
  $candidate = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
               Sort-Object FullName -Descending | Select-Object -First 1
  if ($candidate) {
    $psql = $candidate.FullName
    # Put it on PATH for this session so later steps and manual use both work.
    $env:PATH = "$(Split-Path -Parent $psql);$env:PATH"
    Say "using psql at $psql"
  }
}
if (-not $psql) {
  Fail "psql not found. Add <PostgreSQL>\bin to PATH, then re-run."
  exit 1
}

# -- 4. Create the app role and database -------------------------------------
# These run as the 'postgres' superuser. If it needs a password, PGPASSWORD in
# the environment is honoured; otherwise psql prompts.
if (-not $AppPassword) {
  # Base64url of 24 random bytes -- no shell-hostile characters in the value.
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $AppPassword = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  Say "generated a password for role '$AppUser'"
}

$escaped = $AppPassword.Replace("'", "''")
$roleSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$AppUser') THEN
    CREATE ROLE $AppUser WITH LOGIN PASSWORD '$escaped';
    RAISE NOTICE 'role $AppUser created';
  ELSE
    ALTER ROLE $AppUser WITH LOGIN PASSWORD '$escaped';
    RAISE NOTICE 'role $AppUser password updated';
  END IF;
END
`$`$;
"@

Say "ensuring role '$AppUser'"
$roleSql | & $psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
if ($LASTEXITCODE -ne 0) { Fail "role creation failed (wrong postgres password?)"; exit 1 }

# CREATE DATABASE cannot run inside a DO block, so it is guarded by a lookup.
$dbExists = & $psql -U postgres -d postgres -tAc `
  "SELECT 1 FROM pg_database WHERE datname = '$AppDatabase'"
if ($dbExists -eq '1') {
  Good "database '$AppDatabase' already exists"
} else {
  Say "creating database '$AppDatabase'"
  & $psql -U postgres -d postgres -v ON_ERROR_STOP=1 `
    -c "CREATE DATABASE $AppDatabase OWNER $AppUser ENCODING 'UTF8'"
  if ($LASTEXITCODE -ne 0) { Fail "database creation failed"; exit 1 }
  Good "database created"
}

# The migrations CREATE EXTENSION (pgcrypto, citext, pg_trgm), which needs
# superuser. Doing it here keeps 001_core.sql runnable by the app role.
foreach ($ext in @('pgcrypto','citext','pg_trgm')) {
  & $psql -U postgres -d $AppDatabase -q -c "CREATE EXTENSION IF NOT EXISTS $ext" | Out-Null
}
Good "extensions ready (pgcrypto, citext, pg_trgm)"

# -- 5. Write credentials into .env ------------------------------------------
$envPath = Join-Path $repoRoot '.env'
if (-not (Test-Path $envPath)) { New-Item -ItemType File -Path $envPath | Out-Null }
$envLines = @(Get-Content $envPath -ErrorAction SilentlyContinue)

function Set-EnvVar($lines, $key, $value) {
  $set = $false
  $out = foreach ($line in $lines) {
    if ($line -match "^\s*$key\s*=") { "$key=$value"; $set = $true } else { $line }
  }
  if (-not $set) { $out = @($out) + "$key=$value" }
  return $out
}

foreach ($pair in @(
  @('DB_TARGET','local'), @('PGHOST','127.0.0.1'), @('PGPORT','5432'),
  @('PGDATABASE',$AppDatabase), @('PGUSER',$AppUser), @('PGPASSWORD',$AppPassword))) {
  $envLines = Set-EnvVar $envLines $pair[0] $pair[1]
}
# .env is gitignored, so the generated password is not committed.
Set-Content -Path $envPath -Value $envLines -Encoding utf8
Good "credentials written to .env (gitignored)"

# -- 6. Apply migrations -----------------------------------------------------
if ($SkipMigrate) {
  Say "-SkipMigrate set -- run 'npm run db:migrate' when ready"
} else {
  Say "applying migrations"
  Push-Location $repoRoot
  try {
    & node server/db/migrate.js
    if ($LASTEXITCODE -eq 0) { Good "migrations applied" }
    else { Fail "migrations failed -- see output above"; exit 1 }
  } finally { Pop-Location }
}

Write-Host ""
Good "local PostgreSQL ready:  postgresql://$AppUser@127.0.0.1:5432/$AppDatabase"
Say  "next:  npm run api        (API on http://127.0.0.1:3300)"
Say  "       npm run db:status  (migration state)"
