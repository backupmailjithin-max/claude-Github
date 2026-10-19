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
; install.ps1/dcim-upgrade.ps1/dcim-repair.ps1 all start with
; #Requires -RunAsAdministrator. Inno Setup's [Icons] section has no "run
; elevated" flag ("runas" is not valid here - confirmed by ISCC rejecting it
; outright; that flag only exists in a different sense for [Run] entries),
; and the correct way to make a .lnk request elevation (patching a specific
; bit in the shortcut file after SHCreateShellLink creates it) is its own
; untested bit of Pascal Script, not worth adding sight-unseen right now.
; What IS fixed here: without -NoExit, a rejection from #Requires was
; invisible - the console flashed and closed before anyone could read it,
; which is the exact same "looks successful but did nothing" symptom as a
; prior silent failure (commit 0250bac). Now the window stays open and the
; real PowerShell error ("this script requires administrator privileges")
; is readable, telling you to right-click the shortcut -> "Run as
; administrator" instead of looking like nothing happened at all.
Name: "{group}\DCIM Setup"; Filename: "powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -InstallDir ""{app}"""
Name: "{group}\DCIM Upgrade Utility"; Filename: "powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\dcim-upgrade.ps1"" -InstallDir ""{app}"""
Name: "{group}\DCIM Repair Utility"; Filename: "powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\dcim-repair.ps1"" -InstallDir ""{app}"""
Name: "{group}\DCIM Service Status"; Filename: "powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\dcim-service.ps1"" -Action status"
Name: "{group}\DCIM Configuration Wizard"; Filename: "{code:GetAppUrl}setup-wizard.html"
Name: "{group}\DCIM Deployment Dashboard"; Filename: "{code:GetAppUrl}deployment-dashboard.html"
Name: "{group}\Uninstall DCIM"; Filename: "{uninstallexe}"

[Run]
Filename: "{code:GetAppUrl}"; Description: "Open DCIM in your browser now"; Flags: postinstall shellexec skipifsilent
Filename: "notepad.exe"; Parameters: """{app}\INSTALL-SUMMARY.txt"""; Description: "View installation summary (admin account, port, database, config)"; Flags: postinstall skipifsilent unchecked

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"" -InstallDir ""{app}"""; \
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
    '"Bundled" uses a private MariaDB instance (MySQL-compatible) that DCIM installs and manages for you.',
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

function EscapeForPowerShell(const S: String): String;
var
  R: String;
begin
  { This string ends up inside a double-quoted argument on the raw Win32
    command line that Exec() hands to CreateProcess, parsed by powershell.exe
    via the standard CommandLineToArgvW rules - NOT PowerShell's own script
    syntax. Those rules escape an embedded quote with a backslash (\"), not
    a backtick; a backtick is literal to CommandLineToArgvW and would close
    the quoted argument early, corrupting everything after it on the line
    (every later -DbName/-DbUser/-AdminUser/... would merge or be dropped). }
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
    P := P + ' -DbName "' + EscapeForPowerShell(EmbeddedDbPage.Values[0]) + '"';
    P := P + ' -DbUser "' + EscapeForPowerShell(EmbeddedDbPage.Values[1]) + '"';
    if EmbeddedDbPage.Values[2] <> '' then
      P := P + ' -DbPassword "' + EscapeForPowerShell(EmbeddedDbPage.Values[2]) + '"';
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

{ MsgBox is NOT suppressed by /SILENT, /VERYSILENT or /SUPPRESSMSGBOXES -
  those only cover Setup's own built-in dialogs, never a custom MsgBox call
  from [Code]. Found the hard way: a silent/unattended run (CI, or a real
  customer deploying via SCCM/Intune) that hits an install.ps1 failure would
  show this dialog and then hang forever waiting for a click that will never
  come, turning a reportable failure into an indefinite stall. Log() always
  writes to the install log (visible with /LOG=, or in "Show Details" after
  an interactive run); MsgBox only pops up when there's actually someone
  there to see it. }
procedure ReportInstallFailure(const S: String);
begin
  Log(S);
  if not WizardSilent then MsgBox(S, mbError, MB_OK);
end;

{ install.ps1 is launched here (rather than as a plain [Run] entry) so a
  failure can actually be shown to the user. A [Run] entry's exit code isn't
  checked by Setup by default - found via a real install where install.ps1
  failed partway through (before writing .env or INSTALL-SUMMARY.txt) and
  Setup still sailed through to a Finish page that looked like a success. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: String;
begin
  if CurStep = ssPostInstall then
  begin
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}') +
      '\install.ps1" -InstallDir "' + ExpandConstant('{app}') + '" -Yes ' + GetInstallParams('');
    if not Exec('powershell.exe', Params, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
    begin
      ReportInstallFailure('Could not launch install.ps1. DCIM''s files have been copied to ' + ExpandConstant('{app}') +
        ' but are not yet configured - no database, no service, no .env. ' +
        'Re-run install.ps1 manually from an elevated PowerShell prompt in that folder to see the full error.');
    end
    else if ResultCode <> 0 then
    begin
      ReportInstallFailure('DCIM setup did not finish successfully (install.ps1 exited with code ' + IntToStr(ResultCode) +
        '). .env, the database, and the Windows services may not be fully configured. ' +
        'Re-run install.ps1 manually from an elevated PowerShell prompt in ' + ExpandConstant('{app}') +
        ' to see the full error and retry.');
    end;
  end;
end;
