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
Name: "startuplink"; Description: "Windows 시작 시 자동 실행"; GroupDescription: "추가 옵션:"; Flags: checked

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
; Type: files; Name: "{userprofile}\.orbit-config.json"

[Code]
// ── 전역 변수 ──────────────────────────────────────────────────────────────────
var
  TokenPage: TWizardPage;
  TokenEdit: TEdit;
  TokenLabel: TLabel;
  TokenDescLabel: TLabel;
  InputToken: string;

// ── 토큰 페이지 생성 ───────────────────────────────────────────────────────────
procedure CreateTokenPage;
begin
  TokenPage := CreateCustomPage(wpSelectDir, '설치 코드 입력', '관리자로부터 받은 설치 코드를 입력하세요.');

  TokenDescLabel := TLabel.Create(WizardForm);
  TokenDescLabel.Parent := TokenPage.Surface;
  TokenDescLabel.Left := 0;
  TokenDescLabel.Top := 0;
  TokenDescLabel.Width := TokenPage.SurfaceWidth;
  TokenDescLabel.Height := 40;
  TokenDescLabel.AutoSize := False;
  TokenDescLabel.WordWrap := True;
  TokenDescLabel.Caption := '관리자로부터 받은 설치 코드를 아래에 붙여넣기 하세요.' + #13#10 +
                             '코드가 없으면 비워두고 설치 후 직접 설정할 수 있습니다.';

  TokenLabel := TLabel.Create(WizardForm);
  TokenLabel.Parent := TokenPage.Surface;
  TokenLabel.Left := 0;
  TokenLabel.Top := 55;
  TokenLabel.Caption := '설치 코드:';

  TokenEdit := TEdit.Create(WizardForm);
  TokenEdit.Parent := TokenPage.Surface;
  TokenEdit.Left := 0;
  TokenEdit.Top := 73;
  TokenEdit.Width := TokenPage.SurfaceWidth;
  TokenEdit.PasswordChar := #0;  // 평문 표시 (붙여넣기 편의)
end;

// ── 커맨드라인 /TOKEN 파라미터 처리 ────────────────────────────────────────────
function GetTokenParam: string;
var
  i: Integer;
  Param: string;
begin
  Result := '';
  for i := 1 to ParamCount do
  begin
    Param := ParamStr(i);
    if Pos('/TOKEN=', UpperCase(Param)) = 1 then
    begin
      Result := Copy(Param, 8, Length(Param));
      // 따옴표 제거
      if (Length(Result) >= 2) and (Result[1] = '"') then
        Result := Copy(Result, 2, Length(Result) - 2);
      Exit;
    end;
  end;
end;

// ── 페이지 표시 여부: /TOKEN 파라미터 있으면 페이지 건너뜀 ─────────────────────
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (TokenPage <> nil) and (PageID = TokenPage.ID) then
  begin
    if GetTokenParam <> '' then
      Result := True;
  end;
end;

// ── Node.js 다운로드 및 압축 해제 (PowerShell 사용) ──────────────────────────
procedure DownloadNodeJS;
var
  NodeDestDir: string;
  ResultCode: Integer;
  PSCmd: string;
begin
  NodeDestDir := ExpandConstant('{app}\node');
  ForceDirectories(NodeDestDir);

  Log('Node.js 다운로드 + 설치 시작 (PowerShell)');

  // PowerShell 단일 명령으로 다운로드 + 압축해제 + 정리
  PSCmd := '-WindowStyle Hidden -ExecutionPolicy Bypass -Command "' +
    '$ErrorActionPreference=''Stop''; ' +
    '$url=''https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip''; ' +
    '$zip=Join-Path $env:TEMP ''node-v22.zip''; ' +
    '$dest=''' + NodeDestDir + '''; ' +
    'Write-Host ''Downloading Node.js...''; ' +
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ' +
    '(New-Object Net.WebClient).DownloadFile($url,$zip); ' +
    'Write-Host ''Extracting...''; ' +
    'Expand-Archive -Force $zip $dest; ' +
    '$sub=Get-ChildItem $dest -Directory|Select-Object -First 1; ' +
    'if($sub){Copy-Item -Recurse -Force (Join-Path $sub.FullName ''*'') $dest; Remove-Item -Recurse -Force $sub.FullName}; ' +
    'Remove-Item $zip -Force -ErrorAction SilentlyContinue; ' +
    'Write-Host ''Node.js installed''"';

  Exec('powershell.exe', PSCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  if ResultCode <> 0 then
  begin
    MsgBox('Node.js 다운로드 실패 (코드: ' + IntToStr(ResultCode) + ').' + #13#10 +
           '네트워크 연결을 확인하세요.', mbError, MB_OK);
    Exit;
  end;

  Log('Node.js 설치 완료');
end;

// ── 설정 파일 작성 ─────────────────────────────────────────────────────────────
procedure WriteConfigFile(Token: string);
var
  ConfigPath: string;
  ConfigContent: string;
begin
  ConfigPath := ExpandConstant('{userprofile}\.orbit-config.json');
  ConfigContent := '{' + #13#10 +
    '  "token": "' + Token + '",' + #13#10 +
    '  "serverUrl": "https://sparkling-determination-production-c88b.up.railway.app",' + #13#10 +
    '  "installedAt": "' + GetDateTimeString('yyyy/mm/dd hh:nn:ss', '-', ':') + '"' + #13#10 +
    '}';

  if SaveStringToFile(ConfigPath, ConfigContent, False) then
    Log('설정 파일 작성 완료: ' + ConfigPath)
  else
    Log('설정 파일 작성 실패: ' + ConfigPath);
end;

// ── 시작 프로그램 바로가기 생성 ────────────────────────────────────────────────
procedure CreateStartupShortcut;
var
  ShortcutPath: string;
begin
  ShortcutPath := ExpandConstant('{userstartup}\Orbit AI.lnk');
  CreateShellLink(
    ShortcutPath,
    'Orbit AI 에이전트 자동 시작',
    'wscript.exe',
    '"' + ExpandConstant('{app}\daemon\orbit-launcher.vbs') + '"',
    ExpandConstant('{app}'),
    '',
    0,
    SW_SHOWNORMAL
  );
  Log('시작 프로그램 바로가기 생성: ' + ShortcutPath);
end;

// ── 설치 초기화 ────────────────────────────────────────────────────────────────
procedure InitializeWizard;
begin
  CreateTokenPage;

  // /TOKEN 파라미터가 있으면 미리 채워둠
  InputToken := GetTokenParam;
  if InputToken <> '' then
    TokenEdit.Text := InputToken;
end;

// ── 설치 완료 후 후처리 ────────────────────────────────────────────────────────
procedure CurStepChanged(CurStep: TSetupStep);
var
  Token: string;
begin
  if CurStep = ssPostInstall then
  begin
    // 토큰 결정
    if GetTokenParam <> '' then
      Token := GetTokenParam
    else if TokenEdit <> nil then
      Token := Trim(TokenEdit.Text)
    else
      Token := '';

    // 설정 파일 작성
    WriteConfigFile(Token);

    // Node.js 다운로드 (node.exe 없을 때만)
    if not FileExists(ExpandConstant('{app}\node\node.exe')) then
    begin
      WizardForm.StatusLabel.Caption := 'Node.js 다운로드 중... (잠시 기다려 주세요)';
      DownloadNodeJS;
    end;

    // 시작 프로그램 바로가기
    CreateStartupShortcut;
  end;
end;

// ── 언인스톨: 데몬 프로세스 종료 ──────────────────────────────────────────────
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    // 시작 프로그램 바로가기 삭제
    DeleteFile(ExpandConstant('{userstartup}\Orbit AI.lnk'));

    // node 프로세스 강제 종료 (orbit-daemon 경로에서 실행 중인 것만)
    Exec('powershell.exe',
      '-WindowStyle Hidden -Command "Get-Process node -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.Path -like ''*orbit-daemon*'' } | Stop-Process -Force"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

