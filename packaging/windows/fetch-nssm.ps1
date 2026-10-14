# Downloads and stages nssm.exe (used to register DCIM as a Windows Service),
# since Windows has no native way to run an arbitrary console app as a
# service that responds correctly to the Service Control Manager.
# Run at package-build time -- not committed to git, and not run by install.ps1.
param(
  [string]$NssmVersion = "2.24",
  [string]$OutDir = (Join-Path $PSScriptRoot "tools")
)
$ErrorActionPreference = "Stop"

$url = "https://nssm.cc/release/nssm-$NssmVersion.zip"
$zipPath = Join-Path $env:TEMP "nssm-$NssmVersion.zip"
$extractDir = Join-Path $env:TEMP "nssm-extract"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }

Write-Host "[fetch-nssm] downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

Copy-Item (Join-Path $extractDir "nssm-$NssmVersion\win64\nssm.exe") (Join-Path $OutDir "nssm.exe") -Force
Remove-Item $zipPath -Force
Remove-Item -Recurse -Force $extractDir

Write-Host "[fetch-nssm] staged $OutDir\nssm.exe"
