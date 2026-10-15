# Downloads and stages a standalone MariaDB server for bundling into the
# Windows package's embedded-database option (-EmbeddedDb on install.ps1).
# Run at package-build time (locally or in CI) -- not committed to git, and
# not run by install.ps1 itself. Same pattern as fetch-node-runtime.ps1.
param(
  [string]$MariaDbVersion = "11.4.4",
  [string]$OutDir = (Join-Path $PSScriptRoot "runtime")
)
$ErrorActionPreference = "Stop"

$dist = "mariadb-$MariaDbVersion-winx64"
$url = "https://archive.mariadb.org/mariadb-$MariaDbVersion/winx64-packages/$dist.zip"
$zipPath = Join-Path $env:TEMP "$dist.zip"
$mariadbDir = Join-Path $OutDir "mariadb"

if (Test-Path $mariadbDir) { Remove-Item -Recurse -Force $mariadbDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "[fetch-mariadb-runtime] downloading $url"
try {
  Invoke-WebRequest -Uri $url -OutFile $zipPath
} catch {
  Write-Error "[fetch-mariadb-runtime] could not download $url - MariaDB may have moved/retired this version; check https://archive.mariadb.org/ for the current winx64-packages path and pass -MariaDbVersion accordingly."
  exit 1
}
Expand-Archive -Path $zipPath -DestinationPath $OutDir -Force
Move-Item (Join-Path $OutDir $dist) $mariadbDir
Remove-Item $zipPath -Force

& (Join-Path $mariadbDir "bin\mariadbd.exe") --version
Write-Host "[fetch-mariadb-runtime] staged bundled MariaDB at $mariadbDir"
