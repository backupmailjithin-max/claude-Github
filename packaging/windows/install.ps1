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
  [switch]$EmbeddedDb,
  [int]$EmbeddedDbPort = 3307,
  [string]$CorsOrigin = "",
  [string]$AdminUser = "",
  [string]$AdminPassword = "",
  [ValidateSet("enforce", "report-only", "off")]
  [string]$CspMode = "report-only",
  [int]$AuditRetentionDays = 365,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$ServiceName = "DCIM"
# Which parameters the caller actually passed on the command line, captured
# before any function runs - lets Upgrade/Repair tell "-Port was really
# given" apart from "-Port is just sitting at its default value".
$script:ExplicitParams = $PSBoundParameters.Keys
$MinNodeMajor = 18
$MinFreeMB = 500

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PayloadWebapp = Join-Path $ScriptDir "webapp"
if (-not (Test-Path $PayloadWebapp)) { $PayloadWebapp = Join-Path $ScriptDir "..\..\dcim\webapp" }
$PayloadRuntime = Join-Path $ScriptDir "runtime\node"
$PayloadNssm = Join-Path $ScriptDir "tools\nssm.exe"
$PayloadMariadb = Join-Path $ScriptDir "runtime\mariadb"
$EmbeddedDbServiceName = "DCIMMariaDB"

function Log($msg)  { Write-Host "[dcim-install] $msg" }
function Die($msg)  { Write-Error "[dcim-install] ERROR: $msg"; exit 1 }

function Test-ExistingInstall {
  (Test-Path (Join-Path $InstallDir "webapp\.env"))
}

# Found via real execution of the "Lost Configuration" repair scenario:
# Invoke-Repair's own entry guard used Test-ExistingInstall (which requires
# .env), so when .env is exactly the thing that's missing, repair refused to
# even start before ever reaching its own .env self-heal logic. Repair needs
# a looser signal that an install exists at all - the webapp directory or
# the registered Windows service - since recovering a missing/corrupted
# .env is a scenario repair must support, not reject.
function Test-RepairTargetPresent {
  (Test-Path (Join-Path $InstallDir "webapp")) -or (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
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
  if ($AuditRetentionDays -lt 0) { Die "-AuditRetentionDays must be a non-negative whole number." }
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
CSP_MODE=$CspMode
AUDIT_RETENTION_DAYS=$AuditRetentionDays
NODE_ENV=production
"@ | Set-Content -Path $envPath -Encoding ascii
  Log "Wrote $envPath with a freshly generated JWT secret."
}

function Sync-Payload {
  Log "Syncing application files to $InstallDir\webapp ..."
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $dest = Join-Path $InstallDir "webapp"
  robocopy $PayloadWebapp $dest /MIR /XD uploads backups logs /XF .env /NFL /NDL /NJH /NJS | Out-Null
  # robocopy's exit codes are a bitmask, not a plain success/failure flag:
  # 0-7 all mean success (0 = nothing to do, 1 = files copied, etc., combined
  # by addition); only 8 and above indicate a real failure (e.g. a file
  # locked by antivirus or a stale process). $ErrorActionPreference = "Stop"
  # does not make a non-zero exit from a native command terminate the
  # script, so this was previously never checked at all - a failed copy here
  # left Install-WindowsService/Wait-ForHealth proceeding as if the (possibly
  # stale or partial) webapp files were correct.
  if ($LASTEXITCODE -ge 8) { Die "robocopy failed copying the application files to $dest (exit $LASTEXITCODE)." }
  foreach ($d in "uploads", "backups", "logs") {
    New-Item -ItemType Directory -Force -Path (Join-Path $dest $d) | Out-Null
  }
  if (Test-Path $PayloadRuntime) {
    $rtDest = Join-Path $InstallDir "runtime\node"
    New-Item -ItemType Directory -Force -Path (Split-Path $rtDest) | Out-Null
    robocopy $PayloadRuntime $rtDest /MIR /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { Die "robocopy failed copying the Node.js runtime to $rtDest (exit $LASTEXITCODE)." }
  }
}

function Invoke-Nssm {
  # Every other native-command call in this file that matters (mariadb-
  # install-db.exe, mysql.exe, robocopy) checks $LASTEXITCODE; the nssm
  # "install"/"set" calls that configure the Windows service didn't, found
  # via review. A failed "set AppDirectory"/"set DependOnService"/etc. would
  # otherwise go unnoticed - the service still gets created and started, just
  # missing the config that made it actually work (wrong working directory,
  # no dependency ordering on the embedded DB, ...).
  param($NssmPath)
  $rest = $args
  & $NssmPath @rest | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "nssm $($rest -join ' ') failed (exit $LASTEXITCODE)." }
}

function Ensure-NssmBinary {
  # Setup-EmbeddedDb and Install-WindowsService each register their own NSSM
  # service and both need nssm.exe staged under $InstallDir\tools. Found via
  # real CI execution: when embedded-DB mode runs first, its nssm.exe copy
  # becomes the live process image of the DCIMMariaDB service it just
  # registered, so a second unconditional Copy-Item -Force from
  # Install-WindowsService fails with "The process cannot access the file
  # ... because it is being used by another process."
  $nssm = Join-Path $InstallDir "tools\nssm.exe"
  New-Item -ItemType Directory -Force -Path (Split-Path $nssm) | Out-Null
  if (Test-Path $nssm) {
    if ((Get-FileHash $PayloadNssm).Hash -eq (Get-FileHash $nssm).Hash) { return $nssm }
  }
  try {
    Copy-Item $PayloadNssm $nssm -Force
  } catch {
    # Only swallow the "in use by another process" case when the staged copy
    # is already byte-identical to the payload (the embedded-DB-then-service
    # ordering above) - a genuinely different nssm.exe (e.g. a version bump
    # shipped by an upgrade) must still fail loudly rather than silently
    # keep the old binary running.
    if ((Get-FileHash $PayloadNssm).Hash -eq (Get-FileHash $nssm).Hash) {
      Log "nssm.exe already staged and in use by a just-registered service; reusing it."
    } else {
      throw
    }
  }
  return $nssm
}

function Setup-EmbeddedDb {
  $mariadbdExe = Join-Path $PayloadMariadb "bin\mariadbd.exe"
  if (-not (Test-Path $mariadbdExe)) { Die "-EmbeddedDb requires a bundled MariaDB runtime (run fetch-mariadb-runtime.ps1 at package-build time)." }
  $dbDir = Join-Path $InstallDir "mariadb"
  $engineDir = Join-Path $dbDir "engine"
  $dataDir = Join-Path $dbDir "data"
  $marker = Join-Path $dbDir ".initialized"

  if (Test-Path $engineDir) { Remove-Item -Recurse -Force $engineDir }
  New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
  Copy-Item (Join-Path $PayloadMariadb "*") $engineDir -Recurse -Force

  $firstInit = $false
  if (-not (Test-Path $dataDir)) {
    $firstInit = $true
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Log "Initializing embedded MariaDB data directory..."
    $installDbExe = Join-Path $engineDir "bin\mariadb-install-db.exe"
    if (-not (Test-Path $installDbExe)) { $installDbExe = Join-Path $engineDir "bin\mysql_install_db.exe" }
    if (-not (Test-Path $installDbExe)) { Die "Could not find mariadb-install-db.exe in the bundled MariaDB runtime." }
    # Found via real execution: the Windows mariadb-install-db.exe (11.4.4)
    # rejects --auth-root-authentication-method outright ("unknown variable")
    # - unlike the Linux build, it doesn't support this option at all. Its
    # Windows default already creates root with no password, which is exactly
    # what the Linux --auth-root-authentication-method=normal flag was used to
    # guarantee, so simply omitting it reaches the same end state here.
    & $installDbExe "--datadir=$dataDir" | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "mariadb-install-db.exe failed (exit $LASTEXITCODE)." }
  }

  $nssm = Ensure-NssmBinary
  if (Get-Service -Name $EmbeddedDbServiceName -ErrorAction SilentlyContinue) {
    & $nssm stop $EmbeddedDbServiceName | Out-Null
    & $nssm remove $EmbeddedDbServiceName confirm | Out-Null
  }
  Invoke-Nssm $nssm install $EmbeddedDbServiceName $mariadbdExe "--datadir=""$dataDir"" --port=$EmbeddedDbPort --bind-address=127.0.0.1"
  Invoke-Nssm $nssm set $EmbeddedDbServiceName Start SERVICE_AUTO_START
  Invoke-Nssm $nssm set $EmbeddedDbServiceName AppExit Default Restart
  Start-Service -Name $EmbeddedDbServiceName

  Log "Waiting for embedded MariaDB to become available..."
  $mysqladminExe = Join-Path $engineDir "bin\mysqladmin.exe"
  $mysqlExe = Join-Path $engineDir "bin\mysql.exe"
  $up = $false
  # 90s, not 30s: a first-ever start right after mariadb-install-db.exe has to
  # initialize the data directory, and on a real machine (antivirus scanning
  # every new file, a slower disk than a CI runner) that can take well over
  # 30s even though the service does come up fine - found via a real install
  # on real hardware timing out here while the service kept starting in the
  # background anyway (NSSM's AppExit Default Restart) and came up seconds later.
  for ($i = 0; $i -lt 90; $i++) {
    & $mysqladminExe -h 127.0.0.1 -P $EmbeddedDbPort -u root ping 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $up = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $up) { Die "Embedded MariaDB did not start within 90s. Check: Get-Service $EmbeddedDbServiceName" }

  if ($firstInit) {
    $chars = (48..57) + (65..90) + (97..122)
    # Respect a password the installer's wizard (or -DbPassword directly)
    # actually supplied for the embedded DB's app user - only generate one
    # when the caller left it blank, instead of always discarding it.
    if ($DbPassword) { $script:DbPassword = $DbPassword }
    else { $script:DbPassword = -join ((1..32) | ForEach-Object { [char](Get-Random -InputObject $chars) }) }
    $rootPw = -join ((1..32) | ForEach-Object { [char](Get-Random -InputObject $chars) })
    # SQL-escape anything that can now come from the wizard (DbName/DbUser/
    # DbPassword) rather than always being a random alphanumeric string -
    # an unescaped apostrophe (a common, even recommended, password
    # character) would otherwise close the SQL string literal early and
    # fail with a syntax error that gives a non-technical admin no clue
    # what actually went wrong.
    $sqlEsc = { param($s) $s -replace "'", "''" }
    $escDbName = & $sqlEsc $DbName
    $escDbUser = & $sqlEsc $DbUser
    $escDbPw = & $sqlEsc $script:DbPassword
    $escRootPw = & $sqlEsc $rootPw
    $sql = "ALTER USER 'root'@'localhost' IDENTIFIED BY '$escRootPw';`nCREATE DATABASE IF NOT EXISTS ``$escDbName`` CHARACTER SET utf8mb4;`nCREATE USER IF NOT EXISTS '$escDbUser'@'127.0.0.1' IDENTIFIED BY '$escDbPw';`nGRANT ALL PRIVILEGES ON ``$escDbName``.* TO '$escDbUser'@'127.0.0.1';`nFLUSH PRIVILEGES;`n"
    $sql | & $mysqlExe -h 127.0.0.1 -P $EmbeddedDbPort -u root
    if ($LASTEXITCODE -ne 0) { Die "Could not create the embedded database/user (mysql exited $LASTEXITCODE)." }
    Set-Content -Path (Join-Path $dbDir ".root-password") -Value $rootPw
    New-Item -ItemType File -Force -Path $marker | Out-Null
    Log "Embedded MariaDB initialized: database '$DbName', user '$DbUser'. Root password saved to $dbDir\.root-password (needed only for advanced maintenance)."
  } else {
    # Repair / re-run: reuse the existing DB_PASSWORD from .env rather than
    # generating a new one - generating one here without also updating
    # MariaDB's own stored password for the user would just lock the app out.
    $envPath = Join-Path $InstallDir "webapp\.env"
    if (Test-Path $envPath) {
      $line = Get-Content $envPath | Where-Object { $_ -match '^DB_PASSWORD=(.*)$' } | Select-Object -First 1
      if ($line -match '^DB_PASSWORD=(.*)$') { $script:DbPassword = $matches[1] }
    }
    if (-not $script:DbPassword) { Die "Embedded MariaDB data already exists but no existing DB_PASSWORD was found in .env to reuse. Restore it from backup, or remove $dbDir to reinitialize (data loss)." }
    Log "Embedded MariaDB already initialized; reusing the existing database and credentials."
  }

  $script:DbHost = "127.0.0.1"
  $script:DbPort = $EmbeddedDbPort
}

function Install-WindowsService {
  $nodeBin = if (Test-Path (Join-Path $InstallDir "runtime\node\node.exe")) { Join-Path $InstallDir "runtime\node\node.exe" } else { $script:NodeBin }
  $appDir = Join-Path $InstallDir "webapp"
  $nssm = Ensure-NssmBinary

  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    & $nssm stop $ServiceName | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
  }
  Invoke-Nssm $nssm install $ServiceName $nodeBin "server.js"
  Invoke-Nssm $nssm set $ServiceName AppDirectory $appDir
  Invoke-Nssm $nssm set $ServiceName AppStdout (Join-Path $appDir "logs\service-stdout.log")
  Invoke-Nssm $nssm set $ServiceName AppStderr (Join-Path $appDir "logs\service-stderr.log")
  Invoke-Nssm $nssm set $ServiceName AppRotateFiles 1
  Invoke-Nssm $nssm set $ServiceName Start SERVICE_AUTO_START
  Invoke-Nssm $nssm set $ServiceName AppExit Default Restart
  # If an embedded MariaDB instance is in use (auto-detected, same as the
  # Linux systemd Requires= wiring), tell the Windows Service Control Manager
  # to start it before DCIM, via NSSM's DependOnService.
  if (Test-Path (Join-Path $InstallDir "mariadb\data")) {
    Invoke-Nssm $nssm set $ServiceName DependOnService $EmbeddedDbServiceName
  }
  Start-Service -Name $ServiceName
  Log "Installed Windows service '$ServiceName' (auto-start on boot)."
}

function Sync-PortsFromEnv {
  # On Upgrade/Repair, the caller frequently doesn't know or re-pass -Port /
  # -EmbeddedDbPort - the Start Menu "DCIM Upgrade Utility" / "DCIM Repair
  # Utility" shortcuts and the standalone DCIM-Upgrade/DCIM-Repair installers
  # never do. Found via real review: Wait-ForHealth and Set-AdminAccount
  # would then silently poll the wrong (default 8974) port for any install
  # that used a different one, reporting a false "did not report healthy"
  # failure even though the app was running fine - and Setup-EmbeddedDb
  # would re-register the embedded DB's Windows service pointing at the
  # wrong (default 3307) port too, breaking a non-default one entirely.
  $envPath = Join-Path $InstallDir "webapp\.env"
  if (-not (Test-Path $envPath)) { return }
  $envLines = Get-Content $envPath
  if ($script:ExplicitParams -notcontains 'Port') {
    $line = $envLines | Where-Object { $_ -match '^PORT=(.+)$' } | Select-Object -First 1
    if ($line -match '^PORT=(.+)$') { $script:Port = [int]$matches[1] }
  }
  if ($script:ExplicitParams -notcontains 'EmbeddedDbPort') {
    $line = $envLines | Where-Object { $_ -match '^DB_PORT=(.+)$' } | Select-Object -First 1
    if ($line -match '^DB_PORT=(.+)$') { $script:EmbeddedDbPort = [int]$matches[1] }
  }
}

function Backup-BeforeChange {
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDir = "C:\ProgramData\dcim-backups\$ts"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  $envPath = Join-Path $InstallDir "webapp\.env"
  if (Test-Path $envPath) { Copy-Item $envPath (Join-Path $backupDir ".env") }

  $dump = Get-Command mysqldump.exe -ErrorAction SilentlyContinue
  if ($dump -and (Test-Path $envPath)) {
    $env = @{}
    Get-Content $envPath | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $env[$matches[1]] = $matches[2] } }
    $dumpArgs = @("-h", $env.DB_HOST, "-u", $env.DB_USER)
    if ($env.DB_PASSWORD) { $dumpArgs += "-p$($env.DB_PASSWORD)" }
    # --set-gtid-purged=OFF: found via real execution against MySQL 8 (choco's
    # mysql package) - mysqldump failed outright with "Couldn't execute
    # 'FLUSH TABLES': Access denied; you need (at least one of) the RELOAD or
    # FLUSH_TABLES privilege(s)". MySQL 8 attempts to record GTID state (which
    # needs that FLUSH TABLES call) even with --single-transaction, unless
    # told not to - and a least-privilege DB user scoped to just this app's
    # database (exactly what this installer itself asks customers to grant)
    # will never have that global privilege. This avoids the GTID lookup
    # entirely instead of requiring a broader grant just to take a backup.
    # Feature-detected, not assumed present: also found via real execution
    # that MariaDB's mysqldump does NOT recognize this MySQL-specific flag at
    # all ("unknown option") - DB_HOST can legitimately point at either engine.
    $gtidFlag = @()
    if ((& $dump.Source --help 2>$null | Select-String -Quiet -SimpleMatch '--set-gtid-purged')) { $gtidFlag = @("--set-gtid-purged=OFF") }
    $dumpArgs += @("--single-transaction") + $gtidFlag + @("--routines", "--triggers", $env.DB_NAME)
    $sqlPath = Join-Path $backupDir "database.sql"
    try {
      # Native `>` redirection (not `| Out-File`): Out-File would capture
      # mysqldump's stdout as a PowerShell array-of-strings and re-encode it,
      # whereas `>` on a native command writes its raw output bytes directly -
      # safer for a SQL dump, which must round-trip byte-for-byte for the
      # restore below to import cleanly.
      & $dump.Source @dumpArgs 2> (Join-Path $backupDir "mysqldump.err") > $sqlPath
      if ($LASTEXITCODE -ne 0) { throw "mysqldump exited with code $LASTEXITCODE - see $backupDir\mysqldump.err" }
      Compress-Archive -Path $sqlPath -DestinationPath "$sqlPath.zip" -Force
      Remove-Item $sqlPath
      Log "Database snapshot saved to $sqlPath.zip"
    } catch {
      Log "WARNING: mysqldump failed ($($_.Exception.Message)); only config snapshot was taken. Consider running the app's own Backup/Restore before continuing."
    }
  } else {
    Log "mysqldump.exe not found; only config snapshot was taken. Consider running the app's own Backup/Restore before continuing."
  }
  Set-Content -Path (Join-Path $InstallDir ".last-pre-change-backup") -Value $backupDir
  Log "Pre-change snapshot saved to $backupDir"
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

function Set-AdminAccount {
  if (-not $AdminUser -and -not $AdminPassword) { return }
  try {
    $login = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/auth/login" -Method Post -ContentType "application/json" `
      -Body (@{ username = "admin"; password = "admin" } | ConvertTo-Json) -TimeoutSec 10 -ErrorAction Stop
  } catch {
    Log "Skipping -AdminUser/-AdminPassword: the default admin/admin login no longer works (already customized on a previous run, or this is an Upgrade/Repair, not a fresh install)."
    return
  }
  $body = @{}
  if ($AdminUser) { $body.newUsername = $AdminUser }
  if ($AdminPassword) { $body.newPassword = $AdminPassword }
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/setup/admin-account" -Method Post -ContentType "application/json" `
      -Headers @{ Authorization = "Bearer $($login.token)" } -Body ($body | ConvertTo-Json) -TimeoutSec 10 -ErrorAction Stop | Out-Null
    Log "Admin account customized (username/password applied as requested)."
  } catch {
    Write-Warning "Could not apply -AdminUser/-AdminPassword; the seeded admin/admin account is still in place. Re-run with -Mode repair or sign in and change it via the Setup Wizard."
  }
}

function Show-HealthValidation {
  $loginUser = if ($AdminUser) { $AdminUser } else { "admin" }
  $loginPass = if ($AdminPassword) { $AdminPassword } else { "admin" }
  try {
    $login = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/auth/login" -Method Post -ContentType "application/json" `
      -Body (@{ username = $loginUser; password = $loginPass } | ConvertTo-Json) -TimeoutSec 10 -ErrorAction Stop
  } catch {
    Log "Health validation skipped (could not sign in as '$loginUser' - expected if the admin password was already changed). View it at: http://127.0.0.1:$Port/api/health/validate (after signing in via the dashboard)."
    return
  }
  try {
    $report = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health/validate" -Headers @{ Authorization = "Bearer $($login.token)" } -TimeoutSec 15 -ErrorAction Stop
  } catch {
    Log "Health validation: could not reach /api/health/validate."
    return
  }
  Write-Host ""
  Write-Host "  Health Validation"
  Write-Host "  -----------------"
  foreach ($c in $report.checks) {
    Write-Host ("  {0,-8}{1,-18}{2}" -f $c.status, $c.name, $c.detail)
  }
  Write-Host ""
  Write-Host "  Overall: $($report.overall)"
  Write-Host ""
}

function Show-Summary {
  $ip = $null
  try {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -First 1 -ExpandProperty IPAddress)
  } catch { }
  if (-not $ip) { $ip = "<this-server-ip>" }

  # Re-read the installed .env so this is accurate even on an upgrade/repair
  # run where -Db*/-Port weren't re-passed and the parameter defaults don't
  # reflect what's actually running.
  $envPath = Join-Path $InstallDir "webapp\.env"
  if (Test-Path $envPath) {
    $envLines = Get-Content $envPath
    function Get-EnvValue($name) {
      $line = $envLines | Where-Object { $_ -match "^$name=(.*)$" } | Select-Object -First 1
      if ($line -match "^$name=(.*)$") { return $matches[1] }
      return $null
    }
    $v = Get-EnvValue "PORT"; if ($v) { $script:Port = [int]$v }
    $v = Get-EnvValue "DB_HOST"; if ($v) { $script:DbHost = $v }
    $v = Get-EnvValue "DB_PORT"; if ($v) { $script:DbPort = [int]$v }
    $v = Get-EnvValue "DB_USER"; if ($v) { $script:DbUser = $v }
    $v = Get-EnvValue "DB_NAME"; if ($v) { $script:DbName = $v }
    $v = Get-EnvValue "DB_PASSWORD"; $script:DbPassword = $v
    $v = Get-EnvValue "CSP_MODE"; if ($v) { $script:CspMode = $v }
    $v = Get-EnvValue "AUDIT_RETENTION_DAYS"; if ($v) { $script:AuditRetentionDays = [int]$v }
  }
  if (Test-Path (Join-Path $InstallDir "mariadb\data")) { $script:EmbeddedDb = $true }

  $dbDesc = if ($EmbeddedDb) { "Embedded (bundled private MariaDB)" } else { "External MySQL/MariaDB" }
  if ($AdminUser -or $AdminPassword) {
    $adminUserShown = if ($AdminUser) { $AdminUser } else { "admin" }
    $adminPassShown = "(the password you provided)"
  } else {
    $adminUserShown = "admin"
    $adminPassShown = "admin   <- you MUST change this on first sign-in"
  }

  $lines = @(
    ""
    "======================================================================"
    " DCIM Installation Summary - SAVE THIS INFORMATION"
    "======================================================================"
    " Web UI (from this machine): http://localhost:$Port/"
    " Web UI (from the network):  http://${ip}:$Port/"
    ""
    " Administrator account:"
    "   Username: $adminUserShown"
    "   Password: $adminPassShown"
    ""
    " Database ($dbDesc):"
    "   Host:Port: ${DbHost}:${DbPort}"
    "   Database:  $DbName"
    "   DB user:   $DbUser"
  )
  if ($EmbeddedDb) {
    $lines += "   DB password: $DbPassword   (auto-generated; also saved in $envPath)"
  }
  $lines += ""
  $lines += " Security: CSP mode=$CspMode, audit log retention=${AuditRetentionDays}d (0=forever)"
  $lines += ""
  $lines += " Install directory: $InstallDir"
  $lines += " Config file:        $envPath"
  $lines += " Service:            Get-Service $ServiceName"
  $lines += "======================================================================"
  $lines += ""

  $lines | ForEach-Object { Write-Host $_ }
  try {
    $lines | Set-Content -Path (Join-Path $InstallDir "INSTALL-SUMMARY.txt") -Encoding UTF8
    Log "This summary was also saved to $InstallDir\INSTALL-SUMMARY.txt"
  } catch { }
}

function Invoke-Install {
  Invoke-Validations
  Sync-Payload
  if ($EmbeddedDb) { Setup-EmbeddedDb }
  Write-EnvFile
  Test-DbConnection
  Install-WindowsService
  Wait-ForHealth
  Set-AdminAccount
  Show-HealthValidation
  Log "DCIM installed."
  Show-Summary
}

function Invoke-Upgrade {
  if (-not (Test-ExistingInstall)) { Die "No existing installation found at $InstallDir; use -Mode install instead." }
  Invoke-Validations
  Sync-PortsFromEnv
  Backup-BeforeChange
  Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
  Sync-Payload
  Install-WindowsService
  Wait-ForHealth
  Show-HealthValidation
  Log "DCIM upgraded in place. Previous config snapshot kept under C:\ProgramData\dcim-backups\."
  Show-Summary
}

function Invoke-Repair {
  if (-not (Test-RepairTargetPresent)) { Die "No existing installation found at $InstallDir; use -Mode install instead." }
  Invoke-Validations
  Backup-BeforeChange
  # Found via real execution of the "Lost Configuration" repair scenario:
  # Sync-Payload only ever touches webapp files, never recreates .env, so a
  # repair run had no recovery path when .env itself was the thing missing -
  # it would restart the service with no DB password/JWT secret and fail.
  # Self-heal from the most recent backup that still has one (every prior
  # Backup-BeforeChange call captured .env whenever it existed at the time);
  # if none exists, fail loudly rather than leave the service silently
  # unable to connect to its database.
  $envPath = Join-Path $InstallDir "webapp\.env"
  if (-not (Test-Path $envPath)) {
    $latestEnv = Get-ChildItem -Path "C:\ProgramData\dcim-backups\*\.env" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestEnv) {
      Log "No .env found at $envPath; restoring the most recent one from backup: $($latestEnv.FullName)"
      New-Item -ItemType Directory -Force -Path (Split-Path $envPath) | Out-Null
      Copy-Item $latestEnv.FullName $envPath -Force
    } else {
      Die "No .env found at $envPath and no prior backup contains one; repair cannot recover the configuration. Restore it manually (e.g. from an external backup) or reinstall with -Mode install."
    }
  }
  Sync-PortsFromEnv
  # Found via real execution (test-lifecycle.yml): without stopping the
  # service first, Sync-Payload's Copy-Item of tools\nssm.exe fails with
  # "The process cannot access the file ... because it is being used by
  # another process" - nssm.exe IS the running service's process image.
  # Invoke-Upgrade already does this; Repair needs the same guard.
  Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
  Sync-Payload
  # Auto-detect: a repair run doesn't need -EmbeddedDb re-passed to know an
  # embedded instance is in use, since its data directory is the evidence.
  if ((Test-Path (Join-Path $InstallDir "mariadb\data")) -or $EmbeddedDb) { Setup-EmbeddedDb }
  Install-WindowsService
  Wait-ForHealth
  Show-HealthValidation
  Log "DCIM repaired (files and service re-applied; your .env and data were preserved)."
  Show-Summary
}

Select-Mode
switch ($Mode) {
  "install" { Invoke-Install }
  "upgrade" { Invoke-Upgrade }
  "repair"  { Invoke-Repair }
}
