; Inno Setup script for the standalone "DCIM Repair Utility" (DCIM-Repair-<version>.exe).
; Same rationale as dcim-upgrade-utility.iss: reuses the exact same payload
; and install.ps1 logic as dcim-installer.iss, forcing -Mode repair
; explicitly, sharing the main installer's AppId so it targets the existing
; install location automatically. Repair re-applies files/service/permissions
; without touching .env or application data (same guarantee install.ps1's
; Invoke-Repair already provides and that was validated in test-lifecycle.yml).
;
; Compiled by CI the same way as dcim-installer.iss - see
; .github/workflows/build-packages.yml. To compile locally: iscc dcim-repair-utility.iss

#define AppName "DCIM"
#define AppVersion "3.2.2"
#define AppPublisher "DCIM Packaging"

[Setup]
AppId={{B6E2B6B2-3B1E-4C7E-9C77-DCIM00000001}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName=C:\DCIM
DisableDirPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
DefaultGroupName=DCIM
OutputBaseFilename=DCIM-Repair-{#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
WizardStyle=modern

[Files]
Source: "install.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "rollback.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "dcim-service.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "dcim-upgrade.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "dcim-repair.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dcim\webapp\*"; DestDir: "{app}\webapp"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".env,uploads\*,backups\*,logs\*"
Source: "runtime\node\*"; DestDir: "{app}\runtime\node"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "runtime\mariadb\*"; DestDir: "{app}\runtime\mariadb"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "tools\nssm.exe"; DestDir: "{app}\tools"; Flags: ignoreversion skipifsourcedoesntexist

[Dirs]
Name: "{app}\webapp\uploads"
Name: "{app}\webapp\backups"
Name: "{app}\webapp\logs"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -InstallDir ""{app}"" -Mode repair -Yes"; \
  StatusMsg: "Repairing DCIM (files, service, and permissions - .env and data are preserved)..."; Flags: runascurrentuser waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"" -InstallDir ""{app}"""; \
  RunOnceId: "DcimServiceRemove"; Flags: waituntilterminated
