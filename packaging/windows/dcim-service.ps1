# Convenience wrapper so admins don't have to remember Get-Service/-Name DCIM.
# "status" needs no elevation (read-only); start/stop/restart do, and without
# $ErrorActionPreference = "Stop" an access-denied from running those without
# elevation was a non-terminating error - printed to the console but the
# script still exited 0, looking successful even though nothing happened.
param([Parameter(Mandatory=$true)][ValidateSet("start","stop","restart","status")] [string]$Action)
$ErrorActionPreference = "Stop"
$ServiceName = "DCIM"
switch ($Action) {
  "start"   { Start-Service -Name $ServiceName }
  "stop"    { Stop-Service -Name $ServiceName }
  "restart" { Restart-Service -Name $ServiceName }
  "status"  { Get-Service -Name $ServiceName | Format-List * }
}
