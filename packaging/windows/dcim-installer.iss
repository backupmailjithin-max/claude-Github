; Inno Setup script for DCIM. Produces a single dcim-setup-<version>.exe.
; Compiled by CI (windows-latest runner, Inno Setup preinstalled) -- see
; .github/workflows/build-packages.yml. To compile locally, install Inno
; Setup (jrsoftware.org) and run: iscc dcim-installer.iss
;
; Expects, relative to this file:
;   ..\..\dcim\webapp\        the application payload
;   runtime\node\             bundled Node runtime (run fetch-node-runtime.ps1 first)
;   tools\nssm.exe            service wrapper (run fetch-nssm.ps1 first)

#define AppName "DCIM"
#define AppVersion "3.2.2"
#define AppPublisher "DCIM Packaging"

[Setup]
AppId={{B6E2B6B2-3B1E-4C7E-9C77-DCIM00000001}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName=C:\DCIM
DisableDirPage=no
DefaultGroupName=DCIM
OutputBaseFilename=dcim-setup-{#AppVersion}
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

[Icons]
Name: "{group}\DCIM Setup / Repair"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -InstallDir ""{app}"""
Name: "{group}\DCIM Upgrade Utility"; Filename: "powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\dcim-upgrade.ps1"" -InstallDir ""{app}"""
Name: "{group}\DCIM Repair Utility"; Filename: "powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\dcim-repair.ps1"" -InstallDir ""{app}"""
Name: "{group}\DCIM Service Status"; Filename: "powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\dcim-service.ps1"" -Action status"
Name: "{group}\DCIM Configuration Wizard"; Filename: "http://localhost:8974/setup-wizard.html"
Name: "{group}\DCIM Deployment Dashboard"; Filename: "http://localhost:8974/deployment-dashboard.html"
Name: "{group}\Uninstall DCIM"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -InstallDir ""{app}"" -Yes"; \
  StatusMsg: "Configuring and starting the DCIM service..."; Flags: runascurrentuser waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"" -InstallDir ""{app}"""; \
  RunOnceId: "DcimServiceRemove"; Flags: waituntilterminated
