# Dedicated Upgrade utility ("DCIM Upgrade Utility" Start Menu shortcut).
# Internally reuses install.ps1's -Mode upgrade logic unchanged -- this is a
# thin, memorable entry point, not a separate implementation.
param([string]$InstallDir = "C:\DCIM")
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $ScriptDir "install.ps1") -Mode upgrade -InstallDir $InstallDir -Yes
