#Requires -RunAsAdministrator
<#
  DCIM installer for Windows. Supports fresh install, upgrade, and repair.
  Registers the app as a Windows Service (via bundled NSSM) with auto-start on boot.
#>
param(
  [ValidateSet("install", "upgrade", "repair")]
  [string]$Mode,
  [string]$InstallDir = "C:\DCIM",
  [int]$Port = 8974,
  [string]$DbHost = "localhost",
  [int]$DbPort = 3306,
  [string]$DbUser = "dcim",
  [string]$DbPassword = "",
  [string]$DbName = "dcim",
  [string]$CorsOrigin = "",
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$ServiceName = "DCIM"
$MinNodeMajor = 18
$MinFreeMB = 500

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PayloadWebapp = Join-Path $ScriptDir "webapp"
if (-not (Test-Path $PayloadWebapp)) { $PayloadWebapp = Join-Path $ScriptDir "..\..\dcim\webapp" }
$PayloadRuntime = Join-Path $ScriptDir "runtime\node"
$PayloadNssm = Join-Path $ScriptDir "tools\nssm.exe"

function Log($msg)  { Write-Host "[dcim-install] $msg" }
function Die($msg)  { Write-Error "[dcim-install] ERROR: $msg"; exit 1 }

function Test-ExistingInstall {
  (Test-Path (Join-Path $InstallDir "webapp\.env"))
}

# ---------- Validation ----------

function Resolve-NodeBinary {
  if (Test-Path (Join-Path $PayloadRuntime "node.exe")) {
    Log "Using bundled Node.js runtime."
    return (Join-Path $PayloadRuntime "node.exe")
  }
  $sys = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($sys) {
    Log "No bundled runtime found; using system Node.js at $($sys.Source)"
    return $sys.Source
  }
  Die "No Node.js runtime found (bundled or system). Install Node.js $MinNodeMajor+ or use the packaged installer that bundles it."
}

function Test-NodeVersion($nodeBin) {
  $ver = & $nodeBin --version
  $major = [int]($ver.TrimStart("v").Split(".")[0])
  if ($major -lt $MinNodeMajor) { Die "Node.js $ver found, but DCIM requires >= v$MinNodeMajor." }
  Log "Node.js version check passed ($ver)."
}

function Test-DiskSpace {
  $drive = (Split-Path -Qualifier $InstallDir).TrimEnd(":")
  $free = (Get-PSDrive -Name $drive).Free / 1MB
  if ($free -lt $MinFreeMB) { Die ("Only {0:N0}MB free on {1}:; at least {2}MB required." -f $free, $drive, $MinFreeMB) }
  Log ("Disk space check passed ({0:N0}MB available)." -f $free)
}

function Test-PortAvailable {
  $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($inUse) {
    if ($Mode -eq "install") { Die "Port $Port is already in use. Choose a different -Port or stop the conflicting process." }
    Log "Port $Port is in use (expected: the existing DCIM service)."
  } else {
    Log "Port $Port check passed (available)."
  }
}

function Test-WritePermission {
  $parent = Split-Path -Parent $InstallDir
  if (-not (Test-Path $parent)) { try { New-Item -ItemType Directory -Path $parent -Force | Out-Null } catch { Die "No write permission under $parent." } }
  $probe = Join-Path $parent (".dcim-install-write-test-" + [System.Guid]::NewGuid())
  try { [IO.File]::WriteAllText($probe, "x") } catch { Die "No write permission under $parent." }
  Remove-Item $probe -Force
  Log "Write permission check passed ($parent)."
}

function Invoke-Validations {
  Log "Running pre-flight validation..."
  $script:NodeBin = Resolve-NodeBinary
  Test-NodeVersion $script:NodeBin
  Test-DiskSpace
  Test-PortAvailable
  Test-WritePermission
  if (-not (Test-Path $PayloadNssm)) { Die "nssm.exe not found at $PayloadNssm (required to register the Windows service). Run fetch-nssm.ps1 first." }
  Log "All validation checks passed."
}

# ---------- Mode selection ----------

function Select-Mode {
  if ($Mode) { return }
  if ($Yes) { $script:Mode = if (Test-ExistingInstall) { "upgrade" } else { "install" }; return }
  Write-Host ""
  Write-Host "  DCIM Setup"
  Write-Host "  ----------"
  Write-Host "  1) Install DCIM"
  Write-Host "  2) Upgrade Existing DCIM"
  Write-Host "  3) Repair Existing DCIM"
  Write-Host ""
  if (Test-ExistingInstall) { Log "Existing installation detected at $InstallDir." } else { Log "No existing installation detected." }
  $choice = Read-Host "Select an option [1-3]"
  $script:Mode = switch ($choice) { "1" {"install"} "2" {"upgrade"} "3" {"repair"} default { Die "Invalid selection." } }
}

# ---------- Actions ----------

function New-RandomSecret {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { "{0:x2}" -f $_ })
}

function Test-DbConnection {
  $mysql = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if (-not $mysql) { Log "mysql client not found on PATH; skipping live connection test (server will validate on first start)."; return }
  $mysqlArgs = @("-h", $DbHost, "-P", $DbPort, "-u", $DbUser)
  if ($DbPassword) { $mysqlArgs += "-p$DbPassword" }
  $mysqlArgs += @("-e", "SELECT 1;")
  & $mysql.Source @mysqlArgs > $null 2>&1
  if ($LASTEXITCODE -ne 0) { Die "Could not connect to MySQL/MariaDB at ${DbHost}:${DbPort} as $DbUser. Check the DB is running and credentials are correct." }
  Log "Database connection test passed ($DbHost`:$DbPort as $DbUser)."
}

function Write-EnvFile {
  $secret = New-RandomSecret
  $envPath = Join-Path $InstallDir "webapp\.env"
  @"
PORT=$Port
DB_HOST=$DbHost
DB_PORT=$DbPort
DB_USER=$DbUser
DB_PASSWORD=$DbPassword
DB_NAME=$DbName
JWT_SECRET=$secret
CORS_ORIGIN=$CorsOrigin
NODE_ENV=production
"@ | Set-Content -Path $envPath -Encoding ascii
  Log "Wrote $envPath with a freshly generated JWT secret."
}

function Sync-Payload {
  Log "Syncing application files to $InstallDir\webapp ..."
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $dest = Join-Path $InstallDir "webapp"
  robocopy $PayloadWebapp $dest /MIR /XD uploads backups logs /XF .env /NFL /NDL /NJH /NJS | Out-Null
  foreach ($d in "uploads", "backups", "logs") {
    New-Item -ItemType Directory -Force -Path (Join-Path $dest $d) | Out-Null
  }
  if (Test-Path $PayloadRuntime) {
    $rtDest = Join-Path $InstallDir "runtime\node"
    New-Item -ItemType Directory -Force -Path (Split-Path $rtDest) | Out-Null
    robocopy $PayloadRuntime $rtDest /MIR /NFL /NDL /NJH /NJS | Out-Null
  }
}

function Install-WindowsService {
  $nodeBin = if (Test-Path (Join-Path $InstallDir "runtime\node\node.exe")) { Join-Path $InstallDir "runtime\node\node.exe" } else { $script:NodeBin }
  $appDir = Join-Path $InstallDir "webapp"
  $nssm = Join-Path $InstallDir "tools\nssm.exe"
  New-Item -ItemType Directory -Force -Path (Split-Path $nssm) | Out-Null
  Copy-Item $PayloadNssm $nssm -Force

  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    & $nssm stop $ServiceName | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
  }
  & $nssm install $ServiceName $nodeBin "server.js" | Out-Null
  & $nssm set $ServiceName AppDirectory $appDir | Out-Null
  & $nssm set $ServiceName AppStdout (Join-Path $appDir "logs\service-stdout.log") | Out-Null
  & $nssm set $ServiceName AppStderr (Join-Path $appDir "logs\service-stderr.log") | Out-Null
  & $nssm set $ServiceName AppRotateFiles 1 | Out-Null
  & $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
  & $nssm set $ServiceName AppExit Default Restart | Out-Null
  Start-Service -Name $ServiceName
  Log "Installed Windows service '$ServiceName' (auto-start on boot)."
}

function Import-SchemaIfFresh {
  $mysql = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if (-not $mysql) { Log "mysql client not found; the application will create/verify the schema on first start."; return }
  $mysqlArgs = @("-h", $DbHost, "-P", $DbPort, "-u", $DbUser)
  if ($DbPassword) { $mysqlArgs += "-p$DbPassword" }
  $check = & $mysql.Source @mysqlArgs @("-e", "USE ``$DbName``; SHOW TABLES;") 2>$null
  if (-not $check) {
    Log "Importing schema.sql into database '$DbName' ..."
    $schemaPath = Join-Path $InstallDir "webapp\schema.sql"
    cmd /c "`"$($mysql.Source)`" $($mysqlArgs -join ' ') $DbName < `"$schemaPath`""
  } else {
    Log "Database '$DbName' already has tables; skipping schema import."
  }
}

function Backup-BeforeChange {
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDir = "C:\ProgramData\dcim-backups\$ts"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  $envPath = Join-Path $InstallDir "webapp\.env"
  if (Test-Path $envPath) { Copy-Item $envPath (Join-Path $backupDir ".env") }
  Log "Pre-change config snapshot saved to $backupDir (use the app's Backup/Restore for full DB backups)."
}

function Wait-ForHealth {
  Log "Waiting for the service to report healthy ..."
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -ErrorAction Stop
      if ($resp.status -eq "ok") { Log "Health check passed: http://127.0.0.1:$Port/api/health"; return }
    } catch { }
    Start-Sleep -Seconds 1
  }
  Write-Warning "Service did not report healthy within 30s. Check Windows Event Viewer / $InstallDir\webapp\logs\service-stderr.log"
}

function Invoke-Install {
  Invoke-Validations
  Sync-Payload
  Write-EnvFile
  Test-DbConnection
  Import-SchemaIfFresh
  Install-WindowsService
  Wait-ForHealth
  Log "DCIM installed. Sign in as admin / admin and change the password immediately."
}

function Invoke-Upgrade {
  if (-not (Test-ExistingInstall)) { Die "No existing installation found at $InstallDir; use -Mode install instead." }
  Invoke-Validations
  Backup-BeforeChange
  Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
  Sync-Payload
  Install-WindowsService
  Wait-ForHealth
  Log "DCIM upgraded in place. Previous config snapshot kept under C:\ProgramData\dcim-backups\."
}

function Invoke-Repair {
  if (-not (Test-ExistingInstall)) { Die "No existing installation found at $InstallDir; use -Mode install instead." }
  Invoke-Validations
  Backup-BeforeChange
  Sync-Payload
  Install-WindowsService
  Wait-ForHealth
  Log "DCIM repaired (files and service re-applied; your .env and data were preserved)."
}

Select-Mode
switch ($Mode) {
  "install" { Invoke-Install }
  "upgrade" { Invoke-Upgrade }
  "repair"  { Invoke-Repair }
}
