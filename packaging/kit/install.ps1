# Top-level launcher for the DCIM Enterprise Offline Distribution Kit on
# Windows. This is a thin dispatcher only - it contains NO install logic of
# its own. It identifies the Windows edition (for logging / support-bundle
# purposes only - Windows doesn't need branching the way Linux distros do,
# since there's only one native installer) and launches the already-built,
# already-tested windows\DCIM-Setup*.exe, passing through any arguments.
param(
  [switch]$Silent,
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$Rest
)
$ErrorActionPreference = "Stop"
$KitDir = $PSScriptRoot

function Log($msg) { Write-Host "[dcim-kit] $msg" }

$os = Get-CimInstance Win32_OperatingSystem
Log "Detected: $($os.Caption) (build $($os.BuildNumber))"

$exe = Get-ChildItem -Path (Join-Path $KitDir "windows") -Filter "DCIM-Setup*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
  throw "No DCIM-Setup*.exe found under $KitDir\windows - this kit was not assembled correctly."
}

$argList = @()
if ($Silent) { $argList += "/VERYSILENT" }
if ($Rest) { $argList += $Rest }

Log "Launching native installer: $($exe.FullName) $argList"
Start-Process -FilePath $exe.FullName -ArgumentList $argList -Wait -NoNewWindow
