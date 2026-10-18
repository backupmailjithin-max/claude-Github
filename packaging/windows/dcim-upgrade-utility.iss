; Inno Setup script for the standalone "DCIM Upgrade Utility" (DCIM-Upgrade-<version>.exe).
; This is NOT a new install engine - it reuses the exact same payload and the
; exact same install.ps1 logic as dcim-installer.iss (dcim-installer.iss's own
; "DCIM Upgrade Utility" Start Menu shortcut only re-applies the CURRENTLY
; installed files, since it runs from inside the existing install directory;
; it has no new version to apply). This utility instead carries the NEW
; version's payload with it - exactly like running the new DCIM-Setup.exe
; itself - but forces -Mode upgrade explicitly instead of installer-style
; auto-detection, and shares the main installer's AppId so Inno Setup
; recognizes it as an update to the same product and reuses its existing
; install location automatically.
;
; Compiled by CI the same way as dcim-installer.iss - see
; .github/workflows/build-packages.yml. To compile locally: iscc dcim-upgrade-utility.iss
;
; Expects, relative to this file (same as dcim-installer.iss):
;   ..\..\dcim\webapp\        the application payload (the NEW version)
;   runtime\node\             bundled Node runtime
;   tools\nssm.exe            service wrapper

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
OutputBaseFilename=DCIM-Upgrade-{#AppVersion}
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

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"" -InstallDir ""{app}"""; \
  RunOnceId: "DcimServiceRemove"; Flags: waituntilterminated

[Code]
{ install.ps1 is launched here (rather than as a plain [Run] entry) so a
  failure can actually be shown to the user - see the matching comment in
  dcim-installer.iss's [Code] section for the full story. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: String;
begin
  if CurStep = ssPostInstall then
  begin
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}') +
      '\install.ps1" -InstallDir "' + ExpandConstant('{app}') + '" -Mode upgrade -Yes';
    if not Exec('powershell.exe', Params, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
    begin
      MsgBox('Could not launch install.ps1. The new files have been copied to ' + ExpandConstant('{app}') +
        ' but the upgrade did not run. Re-run install.ps1 -Mode upgrade manually from an elevated ' +
        'PowerShell prompt in that folder to see the full error.', mbError, MB_OK);
    end
    else if ResultCode <> 0 then
    begin
      MsgBox('The upgrade did not finish successfully (install.ps1 exited with code ' + IntToStr(ResultCode) +
        '). Re-run install.ps1 -Mode upgrade manually from an elevated PowerShell prompt in ' +
        ExpandConstant('{app}') + ' to see the full error and retry.', mbError, MB_OK);
    end;
  end;
end;
