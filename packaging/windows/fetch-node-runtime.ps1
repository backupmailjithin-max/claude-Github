# Downloads and stages a standalone Node.js runtime for bundling into the Windows package.
# Run at package-build time (locally or in CI) -- not committed to git, and not run by install.ps1.
param(
  [string]$NodeVersion = "20.18.1",
  [string]$OutDir = (Join-Path $PSScriptRoot "runtime")
)
$ErrorActionPreference = "Stop"

$dist = "node-v$NodeVersion-win-x64"
$url = "https://nodejs.org/dist/v$NodeVersion/$dist.zip"
$zipPath = Join-Path $env:TEMP "$dist.zip"

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "[fetch-node-runtime] downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $OutDir -Force
Move-Item (Join-Path $OutDir $dist) (Join-Path $OutDir "node")
Remove-Item $zipPath -Force

& (Join-Path $OutDir "node\node.exe") --version
Write-Host "[fetch-node-runtime] staged bundled runtime at $OutDir\node"
