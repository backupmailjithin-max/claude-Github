; Inno Setup script for the standalone "DCIM Repair Utility" (DCIM-Repair-<version>.exe).
; Same rationale as dcim-upgrade-utility.iss: reuses the exact same payload
; and install.js logic as dcim-installer.iss, forcing -Mode repair
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
; Node.js, not PowerShell - see the matching [Files] comment in
; dcim-installer.iss for why.
Source: "install.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "rollback.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "dcim-service.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dcim\webapp\*"; DestDir: "{app}\webapp"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".env,license.lic,.trial-state,.license-clock,tools\license-*.js,tools\Run-License-Generator.bat,tools\LICENSE-ISSUE-TEMPLATE.txt,tools\Build-License-Generator-Exe.bat,tools\sea-config.json,tools\sea-prep.blob,tools\dcim-license-generator-v2*.exe,uploads\*,backups\*,logs\*"
Source: "runtime\node\*"; DestDir: "{app}\runtime\node"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "runtime\mariadb\*"; DestDir: "{app}\runtime\mariadb"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "tools\nssm.exe"; DestDir: "{app}\tools"; Flags: ignoreversion skipifsourcedoesntexist

[Dirs]
Name: "{app}\webapp\uploads"
Name: "{app}\webapp\backups"
Name: "{app}\webapp\logs"

[UninstallRun]
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\uninstall.js"" -InstallDir ""{app}"""; \
  RunOnceId: "DcimServiceRemove"; Flags: waituntilterminated

[Code]
{ MsgBox is NOT suppressed by /SILENT, /VERYSILENT or /SUPPRESSMSGBOXES - see
  the matching comment in dcim-installer.iss's [Code] section for the full
  story (a silent/unattended run that hits a failure would otherwise hang
  forever waiting for a click that never comes). }
procedure ReportInstallFailure(const S: String);
begin
  Log(S);
  if not WizardSilent then MsgBox(S, mbError, MB_OK);
end;

{ install.js is launched here (rather than as a plain [Run] entry) so a
  failure can actually be shown to the user - see the matching comment in
  dcim-installer.iss's [Code] section for the full story. Runs the bundled
  node.exe directly, not PowerShell - see the matching [Files] comment in
  dcim-installer.iss. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  NodeExe, Params: String;
begin
  if CurStep = ssPostInstall then
  begin
    NodeExe := ExpandConstant('{app}') + '\runtime\node\node.exe';
    Params := '"' + ExpandConstant('{app}') + '\install.js" -InstallDir "' +
      ExpandConstant('{app}') + '" -Mode repair -Yes';
    if not Exec(NodeExe, Params, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
    begin
      ReportInstallFailure('Could not launch install.js. The repair did not run. Re-run it manually ' +
        'from an elevated Command Prompt (' + NodeExe + ' "' + ExpandConstant('{app}') +
        '\install.js" -Mode repair -InstallDir "' + ExpandConstant('{app}') + '" -Yes) to see the full error.');
    end
    else if ResultCode <> 0 then
    begin
      ReportInstallFailure('The repair did not finish successfully (install.js exited with code ' + IntToStr(ResultCode) +
        '). See ' + ExpandConstant('{app}') + '\install.log for the full error, or re-run it manually ' +
        'from an elevated Command Prompt in ' + ExpandConstant('{app}') + ' to see it live and retry.');
    end;
  end;
end;
