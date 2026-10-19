#Requires -RunAsAdministrator
param(
  [string]$InstallDir = "C:\DCIM",
  [switch]$PurgeData
)
$ErrorActionPreference = "Stop"
$ServiceName = "DCIM"
$EmbeddedDbServiceName = "DCIMMariaDB"

function Log($msg) { Write-Host "[dcim-uninstall] $msg" }

function Remove-DcimService($name, $nssmPath) {
  if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
    Log "No '$name' service found; nothing to remove."
    return
  }
  if (Test-Path $nssmPath) {
    & $nssmPath stop $name | Out-Null
    & $nssmPath remove $name confirm | Out-Null
  } else {
    Stop-Service -Name $name -ErrorAction SilentlyContinue
    sc.exe delete $name | Out-Null
  }
  Log "Service '$name' stopped and removed."
}

$nssm = Join-Path $InstallDir "tools\nssm.exe"
Remove-DcimService $ServiceName $nssm
# The embedded database (if -EmbeddedDb was used at install time) runs as
# its own separate service - found via real review: this was never stopped
# or removed here, so with -PurgeData it kept its data files open (Remove-Item
# below silently left them behind despite reporting as removed) and became an
# orphaned service afterward, pointing at files that no longer fully exist.
Remove-DcimService $EmbeddedDbServiceName $nssm

if ($PurgeData) {
  Log "Removing $InstallDir (application files, uploads, backups, logs, .env, and the embedded database if one was used) ..."
  Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
  Log "Note: an EXTERNAL MySQL/MariaDB database (the -DbHost option, not the bundled one) is never touched by this uninstaller. Drop it manually if desired."
} else {
  Log "Application files left in place at $InstallDir (use -PurgeData to remove them too)."
}

Log "Uninstall complete."
