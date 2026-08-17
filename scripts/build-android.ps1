# ============================================================================
#  build-android.ps1  -  one command from source to an uploadable .aab
#
#  Usage (from the repo root):
#      powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1
#      powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1 -ApiUrl https://staging.example.com
#      powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1 -Bump patch
#
#  WHY A SCRIPT AND NOT FOUR COMMANDS
#  The release built on 15-08-2026 was assembled by hand and shipped a bundle
#  that pointed every request at http://127.0.0.1:3300 - the handset itself.
#  It installed, launched, painted its shell and failed every call. Nothing in
#  the build complained, because from Gradle's point of view nothing was wrong.
#  The checks at the end of this file exist so that specific failure can never
#  leave this machine again:
#     1. the API origin is actually baked into the JS bundle,
#     2. the inlined env object is not empty (the 15-08 defect),
#     3. the bundle is signed with the upload key, not left unsigned.
#
#  ASCII ONLY - non-ASCII breaks the scheduled tasks (see CLAUDE.md).
# ============================================================================

param(
    [string]$ApiUrl = 'https://prasadtransport.com',
    [ValidateSet('none','patch','minor','major')]
    [string]$Bump = 'none',
    [switch]$SkipWebBuild
)

$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$AndroidDir = Join-Path $RepoRoot 'android'
$AabPath    = Join-Path $AndroidDir 'app\build\outputs\bundle\release\app-release.aab'

function Fail($msg) {
    Write-Host ''
    Write-Host "BUILD FAILED: $msg" -ForegroundColor Red
    exit 1
}
function Step($msg) {
    Write-Host ''
    Write-Host "==> $msg" -ForegroundColor Cyan
}

Set-Location $RepoRoot

# ---------------------------------------------------------------- preflight
Step 'Preflight'

# The API base is an ORIGIN, not an endpoint. Callers append /api/v1/...
# themselves, so a value ending in /api produces /api/api/v1/... and 404s
# every request. deploy/aws/sync/PUSH-TO-AWS.md gets this wrong; do not copy
# the command from there.
if ($ApiUrl -match '/api/?$') {
    Fail "-ApiUrl must be an origin, not an endpoint. Callers append /api/v1 themselves, so '$ApiUrl' would produce /api/api/v1/... Use https://prasadtransport.com"
}
if ($ApiUrl -notmatch '^https://') {
    Fail "-ApiUrl must be https. The manifest sets usesCleartextTraffic=false, so plain HTTP is blocked on the device anyway."
}
$ApiUrl = $ApiUrl.TrimEnd('/')

$KeystoreProps = Join-Path $AndroidDir 'keystore.properties'
if (-not (Test-Path $KeystoreProps)) {
    Fail "android/keystore.properties is missing. Without it the release build is UNSIGNED and Play rejects the upload."
}
$StoreLine = Select-String -Path $KeystoreProps -Pattern '^storeFile=(.+)$'
if (-not $StoreLine) { Fail "storeFile is not set in android/keystore.properties." }
$StoreFile = $StoreLine.Matches[0].Groups[1].Value.Trim()
if (-not (Test-Path $StoreFile)) {
    Fail "Upload keystore not found at $StoreFile. This key is the ONLY way to ship an update to an existing listing - if it is genuinely lost, Play support has to reset the upload key."
}
Write-Host "    keystore  : $StoreFile"

# JDK. The system java on this box is 1.8, which Android Gradle Plugin 8.x
# refuses outright.
$Jbr = 'C:\Program Files\Android\Android Studio\jbr'
if (-not (Test-Path (Join-Path $Jbr 'bin\java.exe'))) {
    Fail "Android Studio JBR not found at $Jbr. The system java is 1.8 and cannot run Android Gradle Plugin 8.x."
}
$env:JAVA_HOME = $Jbr
Write-Host "    java home : $Jbr"
Write-Host "    api origin: $ApiUrl"

# ---------------------------------------------------------------- version
if ($Bump -ne 'none') {
    Step "Bumping version ($Bump)"
    node (Join-Path $RepoRoot 'scripts\bump-android-version.cjs') $Bump
    if ($LASTEXITCODE -ne 0) { Fail 'version bump failed' }
}

$VersionFile = Join-Path $AndroidDir 'version.properties'
$VersionCode = (Select-String -Path $VersionFile -Pattern '^VERSION_CODE=(\d+)$').Matches[0].Groups[1].Value
$VersionName = (Select-String -Path $VersionFile -Pattern '^VERSION_NAME=(.+)$').Matches[0].Groups[1].Value.Trim()
Write-Host "    version   : $VersionName (code $VersionCode)"

# ---------------------------------------------------------------- web build
if (-not $SkipWebBuild) {
    Step 'Building the web bundle (vite)'
    # This is the whole point of the script: the origin must be baked in HERE.
    # Vite inlines import.meta.env at build time, so setting the variable after
    # the build does nothing at all.
    $env:VITE_AGENT_API_URL = $ApiUrl
    npx vite build
    if ($LASTEXITCODE -ne 0) { Fail 'vite build failed' }
} else {
    Step 'Skipping web build (-SkipWebBuild)'
    Write-Host '    WARNING: dist/ is reused as-is. If it was built without' -ForegroundColor Yellow
    Write-Host '    VITE_AGENT_API_URL the checks below will catch it.' -ForegroundColor Yellow
}

# ---------------------------------------------------------------- capacitor
Step 'Syncing web assets into the Android project (capacitor)'
npx cap sync android
if ($LASTEXITCODE -ne 0) { Fail 'cap sync failed' }

# ---------------------------------------------------------------- gradle
Step 'Assembling the signed release bundle (gradle)'
if (Test-Path $AabPath) { Remove-Item $AabPath -Force }
Set-Location $AndroidDir
& (Join-Path $AndroidDir 'gradlew.bat') bundleRelease --no-daemon
$GradleExit = $LASTEXITCODE
Set-Location $RepoRoot
if ($GradleExit -ne 0) { Fail 'gradle bundleRelease failed' }
if (-not (Test-Path $AabPath)) { Fail "gradle reported success but $AabPath does not exist." }

# ---------------------------------------------------------------- verify
Step 'Verifying the bundle'

$Work = Join-Path $env:TEMP ('aabverify-' + $VersionCode)
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
New-Item -ItemType Directory -Path $Work | Out-Null
$ZipCopy = Join-Path $Work 'bundle.zip'
Copy-Item $AabPath $ZipCopy
Expand-Archive -Path $ZipCopy -DestinationPath (Join-Path $Work 'x') -Force

$JsDir = Join-Path $Work 'x\base\assets\public\assets'
if (-not (Test-Path $JsDir)) {
    Fail 'the bundle has no web assets at base/assets/public/assets - cap sync did not run.'
}

# CHECK 1 - the origin is present in the shipped JavaScript.
$HasApi = Get-ChildItem -Path $JsDir -Filter *.js | Select-String -SimpleMatch $ApiUrl -List
if (-not $HasApi) {
    Fail "'$ApiUrl' does not appear anywhere in the shipped JavaScript. VITE_AGENT_API_URL did not reach the build, and this bundle would fall back to a default on every device."
}
Write-Host "    [ok] api origin baked in: $ApiUrl"

# CHECK 2 - the inlined env object is not empty. In the 15-08 bundle the
# resolver read from a literal '{}', so nothing could ever override the
# loopback fallback.
$EmptyEnv = Get-ChildItem -Path $JsDir -Filter *.js | Select-String -SimpleMatch 'VITE_AGENT_API_URL' -List
if (-not $EmptyEnv) {
    Fail 'the resolver code is missing from the bundle - src/lib/apiBase.ts did not make it in.'
}
Write-Host '    [ok] resolver present and configured'

# CHECK 3 - signed with the upload key, not left unsigned.
$SigDir = Join-Path $Work 'x\META-INF'
$Signed = $false
if (Test-Path $SigDir) {
    $Blocks = Get-ChildItem -Path $SigDir -Recurse -ErrorAction SilentlyContinue |
              Where-Object { $_.Extension -in '.RSA','.DSA','.EC' }
    if ($Blocks) { $Signed = $true }
}
if (-not $Signed) {
    Fail 'the bundle carries no signature block. keystore.properties was not picked up and Play will reject this file.'
}
Write-Host '    [ok] bundle is signed'

Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- done
$Size = [math]::Round((Get-Item $AabPath).Length / 1MB, 2)
Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' RELEASE BUNDLE READY' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host "  file        : $AabPath"
Write-Host "  size        : $Size MB"
Write-Host "  version     : $VersionName (code $VersionCode)"
Write-Host "  talks to    : $ApiUrl"
Write-Host ''
Write-Host '  Upload at: Play Console > Test and release > Internal testing'
Write-Host '             > Create new release > upload this .aab'
Write-Host ''
Write-Host '  Every future upload needs a HIGHER versionCode:'
Write-Host '     node scripts/bump-android-version.cjs patch'
Write-Host ''
