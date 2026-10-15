#Requires -RunAsAdministrator
# Restores application files, .env, and the database from a snapshot taken
# automatically by install.ps1 before an Upgrade or Repair.
param(
  [string]$InstallDir = "C:\DCIM",
  [string]$SnapshotDir
)
$ErrorActionPreference = "Stop"
$ServiceName = "DCIM"

function Log($msg) { Write-Host "[dcim-rollback] $msg" }

if (-not $SnapshotDir) {
  $marker = Join-Path $InstallDir ".last-pre-change-backup"
  if (-not (Test-Path $marker)) { throw "No -SnapshotDir given and no recorded last snapshot at $marker." }
  # .Trim() matters: Get-Content -Raw returns the file's exact bytes, including
  # the trailing newline Set-Content wrote when install.ps1 recorded this path -
  # without it, Test-Path below is asked about "...\20261015-200935\r\n" and
  # fails even though the real directory exists (confirmed via real execution).
  $SnapshotDir = (Get-Content $marker -Raw).Trim()
  Log "Using most recent recorded snapshot: $SnapshotDir"
}
if (-not (Test-Path $SnapshotDir)) { throw "Snapshot directory not found: $SnapshotDir" }

$confirm = Read-Host "This will stop DCIM, restore .env from $SnapshotDir, and restore the database if a dump is present. Continue? [y/N]"
if ($confirm -ne "y" -and $confirm -ne "Y") { throw "Aborted." }

Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue

$envPath = Join-Path $InstallDir "webapp\.env"
$snapEnv = Join-Path $SnapshotDir ".env"
if (Test-Path $snapEnv) { Copy-Item $snapEnv $envPath -Force; Log "Restored .env" }

$zip = Join-Path $SnapshotDir "database.sql.zip"
if (Test-Path $zip) {
  $mysql = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if (-not $mysql) {
    Log "WARNING: mysql.exe not found; database was NOT restored. Extract $zip and import it manually."
  } else {
    $extractDir = Join-Path $env:TEMP "dcim-rollback-extract"
    Expand-Archive -Path $zip -DestinationPath $extractDir -Force
    $envMap = @{}
    Get-Content $envPath | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $envMap[$matches[1]] = $matches[2] } }
    $args = @("-h", $envMap.DB_HOST, "-u", $envMap.DB_USER)
    if ($envMap.DB_PASSWORD) { $args += "-p$($envMap.DB_PASSWORD)" }
    Log "Restoring database '$($envMap.DB_NAME)' ..."
    cmd /c "`"$($mysql.Source)`" $($args -join ' ') $($envMap.DB_NAME) < `"$extractDir\database.sql`""
    Log "Database restored."
  }
} else {
  Log "No database.sql.zip in this snapshot; database was left as-is."
}

Start-Service -Name $ServiceName
Log "Rollback complete. Check: Get-Service $ServiceName"
