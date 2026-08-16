<#
  drive-lockdown.ps1 -- NTFS lockdown for F:\ (Prasad) and H:\ (Jaiswal).

  RUN THIS FROM AN ELEVATED (Administrator) PowerShell. It changes ACLs on two
  drive roots. Read the rules below before you type Y; a wrong ACL on a drive
  root is painful to undo and can lock you out of your own data.

      powershell -ExecutionPolicy Bypass -File drive-lockdown.ps1            # preview
      powershell -ExecutionPolicy Bypass -File drive-lockdown.ps1 -Execute   # asks for Y

  Always run the preview first and read the "AFTER" block it prints.

  ---------------------------------------------------------------------------
  EXACTLY WHAT IT DOES, AND WHY

  On each of F:\ and H:\ ROOT ONLY:

    1. Back up the current ACL to a .acl file next to this script. That file is
       the undo:  icacls F:\ /restore <backup>
    2. Remove ALL access-control entries for:
         Everyone
         BUILTIN\Users
         NT AUTHORITY\Authenticated Users
       These are the generic identities that let any process, service or logged
       in account drop a folder into the root.
    3. Grant, explicitly:
         NT AUTHORITY\SYSTEM        (OI)(CI)F   full, inherited
         BUILTIN\Administrators     (OI)(CI)F   full, inherited
         <the account you run as>   (OI)(CI)M   modify, inherited
       Modify, not Full, for your own account: it can read, write, create and
       delete data, but cannot rewrite the ACL itself. Changing permissions then
       needs a deliberate elevation, which is the point of a lockdown.
    4. Deny WRITE OF NEW FOLDERS AT THE ROOT for your account, while leaving
       everything inside the existing folders writable:
         icacls F:\ /deny "<you>:(WD,AD)"   applied to THIS FOLDER ONLY
       WD = write data / create files, AD = append data / create folders. With
       no (OI)(CI) inheritance flags the deny lands on the root container alone.
       Result: you can still work freely inside F:\Prasad_Transport_Data, but a
       drag-and-drop onto the root of F:\ is refused by the filesystem.
       This is the drag-and-drop guard you asked for.

  WHAT IT DELIBERATELY DOES NOT DO

    - It does not touch C:\ or E:\.
    - It does not recurse. Only the two roots are modified; every existing file
      and folder keeps its own ACL, so nothing that currently works stops
      working. If you later want depth, that is a separate, slower decision.
    - It does not remove Administrators. Locking out every admin identity on a
      drive root is how people end up booting a rescue disk.
    - It does not touch drive C: even if you edit $DRIVES to include it -- see
      the guard below.

  KNOWN CONSEQUENCE, READ THIS

  Any service running as a DIFFERENT account (a scheduled task set to run as
  SYSTEM is fine; one running as a dedicated service user is NOT) loses write
  access to these roots. The pm2 apps and the ERP run as your own account, so
  they are covered. If you add a service account later, it needs its own grant.
#>
[CmdletBinding()]
param([switch]$Execute)

$ErrorActionPreference = 'Stop'

$DRIVES = @('F:\', 'H:\')
$ME     = "$env:USERDOMAIN\$env:USERNAME"

# Guard: this script must never touch the OS drive.
foreach ($d in $DRIVES) {
  if ($d -match '^[Cc]:') { throw "REFUSED: $d is the OS drive. This script never modifies C:." }
}

$STAMP  = Get-Date -Format 'yyyyMMdd-HHmmss'
$BACKUP = $PSScriptRoot

function Show-Acl {
  param($Path, $Label)
  Write-Output "  --- $Label $Path"
  $acl = Get-Acl -LiteralPath $Path
  foreach ($a in $acl.Access) {
    Write-Output ("      {0,-42} {1,-6} {2}" -f $a.IdentityReference, $a.AccessControlType, $a.FileSystemRights)
  }
}

Write-Output "drive-lockdown  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Output ("mode: {0}" -f $(if ($Execute) { 'EXECUTE (will ask for confirmation)' } else { 'PREVIEW -- nothing will change' }))
Write-Output ("account to be granted Modify: {0}" -f $ME)
Write-Output ''

# Elevation check -- icacls silently half-fails without it.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output ("elevated: {0}" -f $(if ($admin) { 'YES' } else { 'NO -- run as Administrator or this will fail' }))
Write-Output ''

Write-Output '================= CURRENT ACLs ================='
foreach ($d in $DRIVES) { Show-Acl -Path $d -Label 'BEFORE' }

Write-Output ''
Write-Output '================= PLANNED CHANGES ================='
foreach ($d in $DRIVES) {
  Write-Output "  $d"
  Write-Output "     backup ACL  -> $BACKUP\acl-backup-$($d[0])-$STAMP.acl"
  Write-Output "     remove      : Everyone, BUILTIN\Users, NT AUTHORITY\Authenticated Users"
  Write-Output "     grant       : SYSTEM (OI)(CI)F | Administrators (OI)(CI)F | $ME (OI)(CI)M"
  Write-Output "     deny        : $ME (WD,AD) on THIS FOLDER ONLY  <- blocks drag-drop into the root"
  Write-Output ''
}

if (-not $Execute) {
  Write-Output 'PREVIEW ONLY -- nothing was changed. Re-run with -Execute to apply.'
  return
}
if (-not $admin) { throw 'Refusing to apply ACLs without elevation. Re-run this window as Administrator.' }

Write-Output "This will change NTFS permissions on $($DRIVES -join ' and ')."
Write-Output "Undo for each drive:  icacls <drive> /restore $BACKUP\acl-backup-<letter>-$STAMP.acl"
$answer = Read-Host 'Type Y to apply the lockdown, anything else to abort'
if ($answer -ne 'Y') { Write-Output "aborted (answered '$answer')"; return }

foreach ($d in $DRIVES) {
  $letter = $d[0]
  $bak    = "$BACKUP\acl-backup-$letter-$STAMP.acl"
  Write-Output ''
  Write-Output "=== $d"

  # 1. undo file first -- if this fails, change nothing.
  & icacls $d /save $bak /T /C 2>&1 | Select-Object -Last 1 | Out-Null
  if (-not (Test-Path $bak)) { Write-Output "    could not save ACL backup -- SKIPPING $d"; continue }
  Write-Output "    ACL backed up -> $bak"

  # 2. drop the generic identities
  foreach ($id in @('Everyone', 'BUILTIN\Users', 'NT AUTHORITY\Authenticated Users')) {
    & icacls $d /remove:g $id 2>&1 | Out-Null
    & icacls $d /remove:d $id 2>&1 | Out-Null
    Write-Output "    removed  $id"
  }

  # 3. explicit grants
  & icacls $d /grant "*S-1-5-18:(OI)(CI)F"   2>&1 | Out-Null   # SYSTEM, by SID
  & icacls $d /grant "*S-1-5-32-544:(OI)(CI)F" 2>&1 | Out-Null # Administrators, by SID
  & icacls $d /grant "${ME}:(OI)(CI)M"       2>&1 | Out-Null
  Write-Output "    granted  SYSTEM=F  Administrators=F  $ME=M"

  # 4. root-only deny: no new files or folders directly in the root.
  #    No (OI)(CI) => this folder only => subfolders stay fully writable.
  & icacls $d /deny "${ME}:(WD,AD)" 2>&1 | Out-Null
  Write-Output "    denied   $ME create-file/create-folder AT ROOT ONLY (drag-drop guard)"
}

Write-Output ''
Write-Output '================= RESULTING ACLs ================='
foreach ($d in $DRIVES) { Show-Acl -Path $d -Label 'AFTER' }

Write-Output ''
Write-Output 'Verify now, before you trust it:'
foreach ($d in $DRIVES) {
  Write-Output "  New-Item -ItemType Directory '$($d)ZZ_should_fail' -ErrorAction SilentlyContinue   # expect DENIED"
}
Write-Output "  New-Item -ItemType File 'F:\Prasad_Transport_Data\_writetest.txt'                    # expect OK"
Write-Output ''
Write-Output "Undo:  icacls <drive> /restore $BACKUP\acl-backup-<letter>-$STAMP.acl"
