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
Name: "{group}\DCIM Configuration Wizard"; Filename: "{code:GetAppUrl}setup-wizard.html"
Name: "{group}\DCIM Deployment Dashboard"; Filename: "{code:GetAppUrl}deployment-dashboard.html"
Name: "{group}\Uninstall DCIM"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -InstallDir ""{app}"" -Yes {code:GetInstallParams}"; \
  StatusMsg: "Configuring and starting the DCIM service..."; Flags: runascurrentuser waituntilterminated
Filename: "{code:GetAppUrl}"; Description: "Open DCIM in your browser now"; Flags: postinstall shellexec skipifsilent
Filename: "notepad.exe"; Parameters: """{app}\INSTALL-SUMMARY.txt"""; Description: "View installation summary (admin account, port, database, config)"; Flags: postinstall skipifsilent unchecked

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"" -InstallDir ""{app}"""; \
  RunOnceId: "DcimServiceRemove"; Flags: waituntilterminated

[Code]
var
  DbStrategyPage: TInputOptionWizardPage;
  DbConnectionPage: TInputQueryWizardPage;
  AppSettingsPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  { Database strategy: the one real fork in the installer (see
    docs/guides/installation-guide.md's "Database Strategy - pick one"). }
  DbStrategyPage := CreateInputOptionPage(wpSelectDir,
    'Database Configuration', 'How should DCIM connect to a database?',
    'Choose one, then click Next. You can change this later by re-running Repair.',
    True, False);
  DbStrategyPage.Add('Use a bundled, private database (recommended - no setup required)');
  DbStrategyPage.Add('Connect to an existing MySQL / MariaDB server');
  DbStrategyPage.SelectedValueIndex := 0;

  DbConnectionPage := CreateInputQueryPage(DbStrategyPage.ID,
    'Database Connection', 'Enter the connection details for your existing database server.',
    'DCIM will verify this connection before anything else is installed.');
  DbConnectionPage.Add('Host:', False);
  DbConnectionPage.Add('Port:', False);
  DbConnectionPage.Add('Username:', False);
  DbConnectionPage.Add('Password:', True);
  DbConnectionPage.Add('Database name:', False);
  DbConnectionPage.Values[0] := 'localhost';
  DbConnectionPage.Values[1] := '3306';
  DbConnectionPage.Values[2] := 'dcim';
  DbConnectionPage.Values[4] := 'dcim';

  AppSettingsPage := CreateInputQueryPage(DbConnectionPage.ID,
    'Application Settings', 'Set the web port and, optionally, your own administrator account.',
    'Leave the admin fields blank to sign in as admin / admin and change the password on first use.');
  AppSettingsPage.Add('HTTP port:', False);
  AppSettingsPage.Add('Administrator username (optional):', False);
  AppSettingsPage.Add('Administrator password (optional):', True);
  AppSettingsPage.Add('Confirm password:', True);
  AppSettingsPage.Values[0] := '8974';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  { Only ask for connection details when "existing server" was chosen - the
    embedded path needs nothing more than the choice itself. }
  if (PageID = DbConnectionPage.ID) and (DbStrategyPage.SelectedValueIndex = 0) then
    Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  PortNum: Longint;
begin
  Result := True;
  if CurPageID = DbConnectionPage.ID then
  begin
    if (Trim(DbConnectionPage.Values[0]) = '') or (Trim(DbConnectionPage.Values[2]) = '') then
    begin
      MsgBox('Please enter at least a host and username for your database server.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = AppSettingsPage.ID then
  begin
    PortNum := StrToIntDef(Trim(AppSettingsPage.Values[0]), -1);
    if (PortNum < 1) or (PortNum > 65535) then
    begin
      MsgBox('Please enter a valid HTTP port (1-65535).', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    { Admin account is optional, but if any of the three fields were
      touched, all of them must agree - never silently half-apply it. }
    if (AppSettingsPage.Values[2] <> '') or (AppSettingsPage.Values[3] <> '') then
    begin
      if AppSettingsPage.Values[2] <> AppSettingsPage.Values[3] then
      begin
        MsgBox('The administrator passwords do not match.', mbError, MB_OK);
        Result := False;
        Exit;
      end;
      if Trim(AppSettingsPage.Values[1]) = '' then
      begin
        MsgBox('Enter an administrator username, or leave all three admin fields blank to keep the default account.', mbError, MB_OK);
        Result := False;
        Exit;
      end;
    end;
  end;
end;

function EscapeForPowerShell(const S: String): String;
var
  R: String;
begin
  { A password containing a double-quote would otherwise terminate the
    quoted argument early and corrupt the command line. }
  R := S;
  StringChangeEx(R, '"', '`"', True);
  Result := R;
end;

{ Scripted constant used by both [Run] (extra install.ps1 parameters) and
  the Icons section (the real port, instead of a hardcoded one). }
function GetInstallParams(Param: String): String;
var
  P: String;
begin
  P := '-Port ' + Trim(AppSettingsPage.Values[0]);
  if DbStrategyPage.SelectedValueIndex = 0 then
  begin
    P := P + ' -EmbeddedDb';
  end
  else
  begin
    P := P + ' -DbHost "' + EscapeForPowerShell(DbConnectionPage.Values[0]) + '"';
    P := P + ' -DbPort ' + Trim(DbConnectionPage.Values[1]);
    P := P + ' -DbUser "' + EscapeForPowerShell(DbConnectionPage.Values[2]) + '"';
    P := P + ' -DbPassword "' + EscapeForPowerShell(DbConnectionPage.Values[3]) + '"';
    P := P + ' -DbName "' + EscapeForPowerShell(DbConnectionPage.Values[4]) + '"';
  end;
  if Trim(AppSettingsPage.Values[1]) <> '' then
  begin
    P := P + ' -AdminUser "' + EscapeForPowerShell(AppSettingsPage.Values[1]) + '"';
    P := P + ' -AdminPassword "' + EscapeForPowerShell(AppSettingsPage.Values[2]) + '"';
  end;
  Result := P;
end;

function GetAppUrl(Param: String): String;
begin
  Result := 'http://localhost:' + Trim(AppSettingsPage.Values[0]) + '/';
end;
