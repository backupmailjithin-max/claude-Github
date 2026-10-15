# Downloads and stages nssm.exe (used to register DCIM as a Windows Service),
# since Windows has no native way to run an arbitrary console app as a
# service that responds correctly to the Service Control Manager.
# Run at package-build time -- not committed to git, and not run by install.ps1.
#
# Tries Chocolatey first (its CDN has proven far more reliable in CI than
# downloading from nssm.cc directly -- that direct download returned a real
# "503 Service Temporarily Unavailable" during development), then falls back
# to a retried direct download from nssm.cc if Chocolatey isn't available.
param(
  [string]$NssmVersion = "2.24",
  [string]$OutDir = (Join-Path $PSScriptRoot "tools")
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-NssmViaChoco {
  $choco = Get-Command choco.exe -ErrorAction SilentlyContinue
  if (-not $choco) { return $false }
  Write-Host "[fetch-nssm] installing via Chocolatey"
  & $choco.Source install nssm --version=$NssmVersion --no-progress -y 2>&1 | Out-Null

  # Get-Command's .Source for a freshly-shimmed Chocolatey exe can be a
  # relative path (confirmed in CI: "..\lib\NSSM\tools\nssm.exe"), which
  # Copy-Item then resolves against the wrong working directory. Search the
  # actual Chocolatey lib folder directly instead of trusting .Source.
  $chocoRoot = $env:ChocolateyInstall
  if (-not $chocoRoot) { $chocoRoot = Join-Path ${env:ProgramData} "chocolatey" }
  $found = Get-ChildItem -Path (Join-Path $chocoRoot "lib") -Filter "nssm.exe" -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $found) { return $false }
  Copy-Item $found.FullName (Join-Path $OutDir "nssm.exe") -Force
  return $true
}

function Get-NssmViaDirectDownload {
  $url = "https://nssm.cc/release/nssm-$NssmVersion.zip"
  $zipPath = Join-Path $env:TEMP "nssm-$NssmVersion.zip"
  $extractDir = Join-Path $env:TEMP "nssm-extract"
  if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }

  $maxAttempts = 4
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      Write-Host "[fetch-nssm] downloading $url (attempt $attempt/$maxAttempts)"
      Invoke-WebRequest -Uri $url -OutFile $zipPath -TimeoutSec 30
      break
    } catch {
      if ($attempt -eq $maxAttempts) { throw }
      $delay = [Math]::Pow(2, $attempt)
      Write-Warning "[fetch-nssm] download failed ($($_.Exception.Message)); retrying in ${delay}s"
      Start-Sleep -Seconds $delay
    }
  }
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  Copy-Item (Join-Path $extractDir "nssm-$NssmVersion\win64\nssm.exe") (Join-Path $OutDir "nssm.exe") -Force
  Remove-Item $zipPath -Force
  Remove-Item -Recurse -Force $extractDir
}

if (-not (Get-NssmViaChoco)) {
  Write-Host "[fetch-nssm] Chocolatey unavailable or failed; falling back to direct download"
  Get-NssmViaDirectDownload
}

& (Join-Path $OutDir "nssm.exe") version
Write-Host "[fetch-nssm] staged $OutDir\nssm.exe"
