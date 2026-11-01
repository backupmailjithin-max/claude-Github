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
; Node.js, not PowerShell: real execution kept surfacing PowerShell-
; environment problems unrelated to this project's own logic (an escaping
; mismatch, MsgBox hanging under /SILENT, robocopy refusing to mirror a
; directory onto itself, and finally Windows PowerShell 5.1's own module
; auto-loading breaking Get-FileHash itself). Node is already a required
; bundled runtime dependency of this app, so install.js runs under the
; exact same node.exe instead of shelling out to a second, fragile shell.
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

[Icons]
; install.js checks for administrator privileges itself (the "net session"
; trick) and exits with a clear error if it isn't elevated - run via
; node.exe, there is no #Requires-style annotation to reject it up front,
; so -NoExit on cmd.exe is what keeps that error on screen long enough to
; read instead of flashing closed, telling you to right-click the shortcut
; -> "Run as administrator" instead of looking like nothing happened.
Name: "{group}\DCIM Setup"; Filename: "cmd.exe"; Parameters: "/K ""{app}\runtime\node\node.exe"" ""{app}\install.js"" -InstallDir ""{app}"""
Name: "{group}\DCIM Upgrade Utility"; Filename: "cmd.exe"; Parameters: "/K ""{app}\runtime\node\node.exe"" ""{app}\install.js"" -Mode upgrade -InstallDir ""{app}"" -Yes"
Name: "{group}\DCIM Repair Utility"; Filename: "cmd.exe"; Parameters: "/K ""{app}\runtime\node\node.exe"" ""{app}\install.js"" -Mode repair -InstallDir ""{app}"" -Yes"
Name: "{group}\DCIM Service Status"; Filename: "cmd.exe"; Parameters: "/K ""{app}\runtime\node\node.exe"" ""{app}\dcim-service.js"" status"
Name: "{group}\DCIM Configuration Wizard"; Filename: "{code:GetAppUrl}setup-wizard.html"
Name: "{group}\DCIM Deployment Dashboard"; Filename: "{code:GetAppUrl}deployment-dashboard.html"
Name: "{group}\Uninstall DCIM"; Filename: "{uninstallexe}"

[Run]
Filename: "{code:GetAppUrl}"; Description: "Open DCIM in your browser now"; Flags: postinstall shellexec skipifsilent
Filename: "notepad.exe"; Parameters: """{app}\INSTALL-SUMMARY.txt"""; Description: "View installation summary (admin account, port, database, config)"; Flags: postinstall skipifsilent unchecked

[UninstallRun]
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\uninstall.js"" -InstallDir ""{app}"""; \
  RunOnceId: "DcimServiceRemove"; Flags: waituntilterminated

[Code]
var
  DbStrategyPage: TInputOptionWizardPage;
  EmbeddedDbPage: TInputQueryWizardPage;
  DbConnectionPage: TInputQueryWizardPage;
  AppSettingsPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  { Database strategy: the one real fork in the installer (see
    docs/guides/installation-guide.md's "Database Strategy - pick one").
    The bundled engine is MariaDB specifically (a drop-in, MySQL-protocol-
    compatible server) - there is no separate "MySQL" bundled option to
    choose between, which is why only one option is offered here. }
  DbStrategyPage := CreateInputOptionPage(wpSelectDir,
    'Database Configuration', 'How should DCIM connect to a database?',
    'Choose one, then click Next. You can change this later by re-running Repair. ' +
    '"Bundled" installs and manages a private MariaDB instance for you - no separate database ' +
    'software needed. The other option connects to a MySQL or MariaDB server you already have running.',
    True, False);
  DbStrategyPage.Add('Use a bundled, private database (recommended - MariaDB, installed automatically)');
  DbStrategyPage.Add('Connect to an existing MySQL / MariaDB server');
  DbStrategyPage.SelectedValueIndex := 0;

  { Even the bundled/embedded path lets you set the database name, app
    username and password yourself - only the fields that don't apply to a
    private, localhost-only database (host, port) are skipped for it. }
  EmbeddedDbPage := CreateInputQueryPage(DbStrategyPage.ID,
    'Bundled Database Account', 'Set the database name and login DCIM''s app will use.',
    'Leave the password blank to have DCIM generate a secure random one for you (shown on the summary screen at the end).');
  EmbeddedDbPage.Add('Database name:', False);
  EmbeddedDbPage.Add('Username:', False);
  EmbeddedDbPage.Add('Password (optional):', True);
  EmbeddedDbPage.Add('Confirm password:', True);
  EmbeddedDbPage.Values[0] := 'dcim';
  EmbeddedDbPage.Values[1] := 'dcim';

  DbConnectionPage := CreateInputQueryPage(EmbeddedDbPage.ID,
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
  { Each DB page only applies to the strategy it belongs to. }
  if (PageID = EmbeddedDbPage.ID) and (DbStrategyPage.SelectedValueIndex <> 0) then
    Result := True;
  if (PageID = DbConnectionPage.ID) and (DbStrategyPage.SelectedValueIndex = 0) then
    Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  PortNum: Longint;
begin
  Result := True;
  if CurPageID = EmbeddedDbPage.ID then
  begin
    if (Trim(EmbeddedDbPage.Values[0]) = '') or (Trim(EmbeddedDbPage.Values[1]) = '') then
    begin
      MsgBox('Please enter a database name and username (or leave this at its defaults).', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    { "root" is reserved for the bundled database engine's own admin
      account (install.js re-passwords it separately for its own
      maintenance use) - caught right here, not left to surface only after
      the wizard closes as an install failure. }
    if Lowercase(Trim(EmbeddedDbPage.Values[1])) = 'root' then
    begin
      MsgBox('Username cannot be "root" - that name is reserved for the database engine''s own admin account. Please choose a different username (for example, "dcim").', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if EmbeddedDbPage.Values[2] <> EmbeddedDbPage.Values[3] then
    begin
      MsgBox('The passwords do not match.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = DbConnectionPage.ID then
  begin
    if (Trim(DbConnectionPage.Values[0]) = '') or (Trim(DbConnectionPage.Values[2]) = '') then
    begin
      MsgBox('Please enter at least a host and username for your database server.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    { Unvalidated, this reached install.ps1 as -DbPort <empty-or-garbage>,
      which PowerShell's parameter binder rejects with a raw .NET error
      after files were already copied - instead of this friendly message
      before anything has been touched. }
    PortNum := StrToIntDef(Trim(DbConnectionPage.Values[1]), -1);
    if (PortNum < 1) or (PortNum > 65535) then
    begin
      MsgBox('Please enter a valid database port (1-65535).', mbError, MB_OK);
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

function EscapeForArg(const S: String): String;
var
  R: String;
begin
  { This string ends up inside a double-quoted argument on the raw Win32
    command line that Exec() hands to CreateProcess, parsed by node.exe via
    the standard CommandLineToArgvW rules every ordinary Windows console app
    uses. Those rules escape an embedded quote with a backslash (\"). }
  R := S;
  StringChangeEx(R, '"', '\"', True);
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
    P := P + ' -DbName "' + EscapeForArg(EmbeddedDbPage.Values[0]) + '"';
    P := P + ' -DbUser "' + EscapeForArg(EmbeddedDbPage.Values[1]) + '"';
    if EmbeddedDbPage.Values[2] <> '' then
      P := P + ' -DbPassword "' + EscapeForArg(EmbeddedDbPage.Values[2]) + '"';
  end
  else
  begin
    P := P + ' -DbHost "' + EscapeForArg(DbConnectionPage.Values[0]) + '"';
    P := P + ' -DbPort ' + Trim(DbConnectionPage.Values[1]);
    P := P + ' -DbUser "' + EscapeForArg(DbConnectionPage.Values[2]) + '"';
    P := P + ' -DbPassword "' + EscapeForArg(DbConnectionPage.Values[3]) + '"';
    P := P + ' -DbName "' + EscapeForArg(DbConnectionPage.Values[4]) + '"';
  end;
  if Trim(AppSettingsPage.Values[1]) <> '' then
  begin
    P := P + ' -AdminUser "' + EscapeForArg(AppSettingsPage.Values[1]) + '"';
    P := P + ' -AdminPassword "' + EscapeForArg(AppSettingsPage.Values[2]) + '"';
  end;
  Result := P;
end;

function GetAppUrl(Param: String): String;
begin
  Result := 'http://localhost:' + Trim(AppSettingsPage.Values[0]) + '/';
end;

{ MsgBox is NOT suppressed by /SILENT, /VERYSILENT or /SUPPRESSMSGBOXES -
  those only cover Setup's own built-in dialogs, never a custom MsgBox call
  from [Code]. A silent/unattended run (CI, or a real customer deploying via
  SCCM/Intune) that hits an install.js failure would show this dialog and
  then hang forever waiting for a click that will never come, turning a
  reportable failure into an indefinite stall. Log() always writes to the
  install log (visible with /LOG=, or in "Show Details" after an
  interactive run); MsgBox only pops up when there's actually someone there
  to see it. }
procedure ReportInstallFailure(const S: String);
begin
  Log(S);
  if not WizardSilent then MsgBox(S, mbError, MB_OK);
end;

{ install.js is launched here (rather than as a plain [Run] entry) so a
  failure can actually be shown to the user. A [Run] entry's exit code isn't
  checked by Setup by default - found via a real install where the installer
  failed partway through (before writing .env or INSTALL-SUMMARY.txt) and
  Setup still sailed through to a Finish page that looked like a success.
  Runs the bundled node.exe directly rather than relying on a system-wide
  Node install - DCIM's installer is meant to be fully self-sufficient. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  NodeExe, Params: String;
begin
  if CurStep = ssPostInstall then
  begin
    NodeExe := ExpandConstant('{app}') + '\runtime\node\node.exe';
    Params := '"' + ExpandConstant('{app}') + '\install.js" -InstallDir "' +
      ExpandConstant('{app}') + '" -Yes ' + GetInstallParams('');
    if not Exec(NodeExe, Params, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
    begin
      ReportInstallFailure('Could not launch install.js. DCIM''s files have been copied to ' + ExpandConstant('{app}') +
        ' but are not yet configured - no database, no service, no .env. ' +
        'Re-run it manually from an elevated Command Prompt (' + NodeExe + ' "' + ExpandConstant('{app}') +
        '\install.js" -InstallDir "' + ExpandConstant('{app}') + '") to see the full error.');
    end
    else if ResultCode <> 0 then
    begin
      ReportInstallFailure('DCIM setup did not finish successfully (install.js exited with code ' + IntToStr(ResultCode) +
        '). .env, the database, and the Windows services may not be fully configured. ' +
        'See ' + ExpandConstant('{app}') + '\install.log for the full error, or re-run it manually ' +
        'from an elevated Command Prompt in ' + ExpandConstant('{app}') + ' to see it live and retry.');
    end;
  end;
end;
