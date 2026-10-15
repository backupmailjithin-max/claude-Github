# Dedicated Repair utility ("DCIM Repair Utility" Start Menu shortcut).
# Internally reuses install.ps1's -Mode repair logic unchanged -- this is a
# thin, memorable entry point, not a separate implementation.
param([string]$InstallDir = "C:\DCIM")
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $ScriptDir "install.ps1") -Mode repair -InstallDir $InstallDir -Yes
