; Orbit AI 에이전트 - Inno Setup 6 설치 스크립트
; 관리자 권한 불필요, 사용자 앱데이터에 설치

#define MyAppName "Orbit AI 에이전트"
#define MyAppVersion "2.0.0"
#define MyAppPublisher "Orbit AI"
#define MyAppURL "https://sparkling-determination-production-c88b.up.railway.app"
#define MyAppExeName "orbit-launcher.vbs"

[Setup]
AppId={{B7A2C3D4-E5F6-4789-ABCD-EF0123456789}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={userappdata}\orbit-daemon
DisableProgramGroupPage=yes
; 관리자 권한 불필요
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
LicenseFile=privacy-notice.txt
OutputDir=..\dist
OutputBaseFilename=OrbitAI-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=Modern
; 한국어
ShowLanguageDialog=no
; 언인스톨러
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\daemon\orbit-launcher.vbs

[Languages]
Name: "default"; MessagesFile: "compiler:Default.isl"

[Messages]
; 라이선스 화면 대신 개인정보 안내로 대체
WizardLicense=개인정보 보호 안내
LicenseLabel3=Orbit AI 에이전트 설치 전에 아래 개인정보 보호 정책을 읽어주세요.
LicenseAccepted=위 내용을 읽었으며 동의합니다(&A)
LicenseNotAccepted=동의하지 않습니다(&D)

[Tasks]
Name: "startuplink"; Description: "Windows Startup"; GroupDescription: "Options:"

[Files]
; daemon 폴더
Source: "..\daemon\*"; DestDir: "{app}\daemon"; Flags: ignoreversion recursesubdirs createallsubdirs
; src 폴더
Source: "..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
; package.json
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; 시작 프로그램 바로가기 (태스크 선택 시)
Name: "{userstartup}\Orbit AI"; Filename: "wscript.exe"; Parameters: """{app}\daemon\orbit-launcher.vbs"""; Tasks: startuplink

[Run]
; npm install --production
Filename: "{app}\node\node.exe"; Parameters: "{app}\node\npm\node_modules\npm\bin\npm-cli.js install --production"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; StatusMsg: "패키지 설치 중..."; Check: FileExists('{app}\node\node.exe')
; 트레이 앱 즉시 실행
Filename: "wscript.exe"; Parameters: """{app}\daemon\orbit-launcher.vbs"""; Flags: nowait postinstall skipifsilent; Description: "Orbit AI 지금 시작"

[UninstallRun]
; 언인스톨 전 데몬 프로세스 종료
Filename: "taskkill.exe"; Parameters: "/F /IM node.exe /FI ""WINDOWTITLE eq orbit*"""; Flags: runhidden; RunOnceId: "KillDaemon"
Filename: "powershell.exe"; Parameters: "-WindowStyle Hidden -Command ""Get-Process node -ErrorAction SilentlyContinue | Where-Object {{ $_.MainModule.FileName -like '*orbit*' }} | Stop-Process -Force"""; Flags: runhidden; RunOnceId: "KillDaemonPS"

[UninstallDelete]
; 시작 프로그램 바로가기 제거
Type: files; Name: "{userstartup}\Orbit AI.lnk"
; 설정 파일 (선택적 - 남겨두는 경우가 많으나 여기선 제거)
; Type: files; Name: "{%USERPROFILE}\.orbit-config.json"

[Code]
var
  TokenPage: TWizardPage;
  TokenEdit: TEdit;
  InputToken: string;

procedure CreateTokenPage;
var
  Lbl: TLabel;
begin
  TokenPage := CreateCustomPage(wpSelectDir, '설치 코드 입력', '관리자로부터 받은 설치 코드를 입력하세요.');
  Lbl := TLabel.Create(WizardForm);
  Lbl.Parent := TokenPage.Surface;
  Lbl.Caption := '설치 코드:';
  Lbl.Left := 0;
  Lbl.Top := 10;
  TokenEdit := TEdit.Create(WizardForm);
  TokenEdit.Parent := TokenPage.Surface;
  TokenEdit.Left := 0;
  TokenEdit.Top := 30;
  TokenEdit.Width := TokenPage.SurfaceWidth;
end;

function GetTokenParam: string;
var
  i: Integer;
  P: string;
begin
  Result := '';
  for i := 1 to ParamCount do
  begin
    P := ParamStr(i);
    if Pos('/TOKEN=', UpperCase(P)) = 1 then
    begin
      Result := Copy(P, 8, Length(P));
      if (Length(Result) >= 2) and (Result[1] = '"') then
        Result := Copy(Result, 2, Length(Result) - 2);
      Exit;
    end;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (TokenPage <> nil) and (PageID = TokenPage.ID) then
    if GetTokenParam <> '' then
      Result := True;
end;

procedure WriteConfigFile(Token: string);
var
  S: string;
begin
  S := '{' + #13#10 +
    '  "token": "' + Token + '",' + #13#10 +
    '  "serverUrl": "https://sparkling-determination-production-c88b.up.railway.app",' + #13#10 +
    '  "installedAt": "' + GetDateTimeString('yyyy/mm/dd hh:nn:ss', '-', ':') + '"' + #13#10 + '}';
  SaveStringToFile(ExpandConstant('{%USERPROFILE}\.orbit-config.json'), S, False);
end;

procedure DownloadNodeJS;
var
  RC: Integer;
  Dest: string;
begin
  Dest := ExpandConstant('{app}\node');
  ForceDirectories(Dest);
  Exec('powershell.exe',
    '-WindowStyle Hidden -ExecutionPolicy Bypass -Command "' +
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ' +
    '$z=Join-Path $env:TEMP ''node22.zip''; ' +
    '(New-Object Net.WebClient).DownloadFile(''https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip'',$z); ' +
    'Expand-Archive -Force $z ''' + Dest + '''; ' +
    '$d=Get-ChildItem ''' + Dest + ''' -Directory|Select-Object -First 1; ' +
    'if($d){Copy-Item (Join-Path $d.FullName ''*'') ''' + Dest + ''' -Recurse -Force; Remove-Item $d.FullName -Recurse -Force}; ' +
    'Remove-Item $z -Force -EA SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, RC);
end;

procedure InitializeWizard;
begin
  CreateTokenPage;
  InputToken := GetTokenParam;
  if InputToken <> '' then
    TokenEdit.Text := InputToken;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  T: string;
begin
  if CurStep = ssPostInstall then
  begin
    if GetTokenParam <> '' then T := GetTokenParam
    else if TokenEdit <> nil then T := Trim(TokenEdit.Text)
    else T := '';
    WriteConfigFile(T);
    if not FileExists(ExpandConstant('{app}\node\node.exe')) then
      DownloadNodeJS;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  RC: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    DeleteFile(ExpandConstant('{userstartup}\Orbit AI.lnk'));
    Exec('powershell.exe',
      '-WindowStyle Hidden -Command "Get-Process node -EA SilentlyContinue | ' +
      'Where-Object {$_.Path -like ''*orbit*''} | Stop-Process -Force"',
      '', SW_HIDE, ewWaitUntilTerminated, RC);
  end;
end;
