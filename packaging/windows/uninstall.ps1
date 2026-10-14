#Requires -RunAsAdministrator
param(
  [string]$InstallDir = "C:\DCIM",
  [switch]$PurgeData
)
$ErrorActionPreference = "Stop"
$ServiceName = "DCIM"

function Log($msg) { Write-Host "[dcim-uninstall] $msg" }

$nssm = Join-Path $InstallDir "tools\nssm.exe"
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  if (Test-Path $nssm) {
    & $nssm stop $ServiceName | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
  } else {
    Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
  }
  Log "Service '$ServiceName' stopped and removed."
} else {
  Log "No '$ServiceName' service found; nothing to remove."
}

if ($PurgeData) {
  Log "Removing $InstallDir (application files, uploads, backups, logs, .env) ..."
  Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
  Log "Note: the MySQL/MariaDB database itself was NOT touched. Drop it manually if desired."
} else {
  Log "Application files left in place at $InstallDir (use -PurgeData to remove them too)."
}

Log "Uninstall complete."
