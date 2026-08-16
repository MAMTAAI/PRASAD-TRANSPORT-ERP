# Unlock H:\ by applying the DACL the backup file DESCRIBES but cannot /restore
# (its path line is blank, so icacls /restore exits 2 with 0 files processed).
# Set-Acl takes the SDDL directly, so this applies exactly the backed-up intent
# rather than a hand-guessed approximation.
# ASCII only (CLAUDE.md).
$ErrorActionPreference = 'Continue'
$log  = 'E:\PRASAD-TRANSPORT-ERP\scripts\acl-restore-H.log'
$sddl = 'D:(A;;FA;;;BA)(A;OICIIO;GA;;;BA)(A;;FA;;;SY)(A;OICIIO;GA;;;SY)(A;;0x1301bf;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)'

"=== APPLY SDDL ===" | Out-File $log -Encoding ascii
try {
  $d = Get-Item 'H:\' -Force -ErrorAction Stop
  $sec = $d.GetAccessControl()
  $sec.SetSecurityDescriptorSddlForm($sddl)
  $d.SetAccessControl($sec)
  "applied OK" | Out-File $log -Append -Encoding ascii
} catch {
  "APPLY FAILED: $($_.Exception.Message)" | Out-File $log -Append -Encoding ascii
}

"=== AFTER (H:) ===" | Out-File $log -Append -Encoding ascii
icacls H:\ | Out-File $log -Append -Encoding ascii

# Did the lockdown also break inheritance on the children? If a child has an
# explicit protected DACL, fixing the root alone leaves it unreachable.
"=== CHILD INHERITANCE SAMPLE ===" | Out-File $log -Append -Encoding ascii
try {
  Get-ChildItem H:\ -Force -Directory -ErrorAction Stop | Select-Object -First 6 | ForEach-Object {
    $a = $_.GetAccessControl()
    "$($_.Name) : protected=$($a.AreAccessRulesProtected)" | Out-File $log -Append -Encoding ascii
  }
} catch { "child scan failed: $($_.Exception.Message)" | Out-File $log -Append -Encoding ascii }

"=== F: STATE (report only, not modified) ===" | Out-File $log -Append -Encoding ascii
icacls F:\ | Out-File $log -Append -Encoding ascii
