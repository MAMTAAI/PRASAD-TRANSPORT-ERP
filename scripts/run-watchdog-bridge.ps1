# Launcher for the watchdog bridge. The company and environment live here rather
# than in the task arguments so the same task definition can be copied to the
# AWS box and to Jaiswal with one line changed.
$env:WATCHDOG_COMPANY = 'PRASAD'
$env:WATCHDOG_ENV     = 'LOCAL'
$env:WATCHDOG_API     = 'http://127.0.0.1:3300'
$env:LOG_DIR          = 'F:\Prasad_Transport_Data\logs'
Set-Location 'F:\Prasad_Transport_System\PRASAD-TRANSPORT-ERP'
& node scripts\watchdog-bridge.cjs --watch
