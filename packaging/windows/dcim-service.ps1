# Convenience wrapper so admins don't have to remember Get-Service/-Name DCIM.
param([Parameter(Mandatory=$true)][ValidateSet("start","stop","restart","status")] [string]$Action)
$ServiceName = "DCIM"
switch ($Action) {
  "start"   { Start-Service -Name $ServiceName }
  "stop"    { Stop-Service -Name $ServiceName }
  "restart" { Restart-Service -Name $ServiceName }
  "status"  { Get-Service -Name $ServiceName | Format-List * }
}
