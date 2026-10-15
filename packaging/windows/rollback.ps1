#Requires -RunAsAdministrator
# Restores application files, .env, and the database from a snapshot taken
# automatically by install.ps1 before an Upgrade or Repair.
param(
  [string]$InstallDir = "C:\DCIM",
  [string]$SnapshotDir,
  [switch]$Yes
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

if (-not $Yes) {
  # Found via real execution: `echo y | rollback.ps1` (the natural way to script a
  # yes-answer, and the pattern the Linux rollback.sh test already used successfully)
  # does NOT satisfy Read-Host on Windows - PowerShell pipeline input and console
  # stdin are different things, unlike a POSIX shell's `read`. A real -Yes switch
  # (matching install.ps1's own convention) is the only way to automate this.
  $confirm = Read-Host "This will stop DCIM, restore .env from $SnapshotDir, and restore the database if a dump is present. Continue? [y/N]"
  if ($confirm -ne "y" -and $confirm -ne "Y") { throw "Aborted." }
}

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
    Log "Restoring database '$($envMap.DB_NAME)' ..."
    # Found via real execution: the previous `cmd /c "mysql ... < file"` never
    # checked its exit code, so a failed import was silently treated as success
    # (the log said "Database restored" even when nothing was actually
    # restored). Using Process/ProcessStartInfo directly instead of cmd.exe
    # redirection also avoids manually quoting arguments (ArgumentList lets
    # .NET escape each one correctly - DB_PASSWORD can contain characters that
    # are awkward for a hand-built cmd.exe command line) and streams the dump
    # file as raw bytes rather than through a text pipeline that could
    # re-encode it.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $mysql.Source
    $psi.ArgumentList.Add("-h"); $psi.ArgumentList.Add($envMap.DB_HOST)
    $psi.ArgumentList.Add("-u"); $psi.ArgumentList.Add($envMap.DB_USER)
    if ($envMap.DB_PASSWORD) { $psi.ArgumentList.Add("-p$($envMap.DB_PASSWORD)") }
    $psi.ArgumentList.Add($envMap.DB_NAME)
    $psi.RedirectStandardInput = $true
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $extractDir "database.sql"))
    $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $proc.StandardInput.Close()
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) { throw "mysql restore exited with code $($proc.ExitCode) - the database was NOT restored." }
    Log "Database restored."
  }
} else {
  Log "No database.sql.zip in this snapshot; database was left as-is."
}

Start-Service -Name $ServiceName
Log "Rollback complete. Check: Get-Service $ServiceName"
