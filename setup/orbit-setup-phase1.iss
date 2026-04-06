; Orbit AI 트래커 (기본) - Inno Setup 6 설치 스크립트
; 관리자 권한 불필요, 사용자 앱데이터에 설치

#define MyAppName "Orbit AI 트래커 (기본)"
#define MyAppVersion "2.0.0-phase1"
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
OutputBaseFilename=OrbitAI-Setup-Phase1-{#MyAppVersion}
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
LicenseLabel3=Orbit AI 트래커 (기본) 설치 전에 아래 개인정보 보호 정책을 읽어주세요.
LicenseAccepted=위 내용을 읽었으며 동의합니다(&A)
LicenseNotAccepted=동의하지 않습니다(&D)

[Tasks]
Name: "startuplink"; Description: "Windows Startup"; GroupDescription: "Options:"

[Files]
; daemon 폴더
Source: "..\daemon\*"; DestDir: "{app}\daemon"; Flags: ignoreversion recursesubdirs createallsubdirs
; src 폴더
Source: "..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
; package.json (원본 — Phase1에서 교체됨)
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
; package-phase1.json (uiohook-napi 제거 버전)
Source: "..\package-phase1.json"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; 시작 프로그램 바로가기 (태스크 선택 시)
Name: "{userstartup}\Orbit AI"; Filename: "wscript.exe"; Parameters: """{app}\daemon\orbit-launcher.vbs"""; Tasks: startuplink

[Run]
; 트레이 앱 즉시 실행 (npm install은 CurStepChanged에서 재시도 로직으로 처리)
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
  VerifiedUserName: string;  // 토큰 확인 후 저장되는 사용자 이름

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

function VerifyTokenOnServer(Token: string): Boolean;
var
  RC: Integer;
  TmpFile, ResultStr: string;
begin
  Result := False;
  if Token = '' then Exit;
  TmpFile := ExpandConstant('{tmp}\orbit-token-verify.txt');
  Exec('powershell.exe',
    '-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -Command "' +
    'try { ' +
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ' +
    '$h=@{Authorization=''Bearer ' + Token + '''}; ' +
    '$r=Invoke-RestMethod -Uri ''https://sparkling-determination-production-c88b.up.railway.app/api/auth/verify'' -Headers $h -Method Get -TimeoutSec 10; ' +
    'if($r.ok){''OK:'' + $r.name + '' ('' + $r.email + '')''}else{''FAIL''} ' +
    '} catch { ''FAIL:'' + $_.Exception.Message } | Out-File ''' + TmpFile + ''' -Encoding ASCII"',
    '', SW_HIDE, ewWaitUntilTerminated, RC);
  if LoadStringFromFile(TmpFile, ResultStr) then
  begin
    Result := Pos('OK:', ResultStr) > 0;
    // 사용자 이름 추출 (OK:이름 형식에서 이름 부분)
    if Result then
    begin
      VerifiedUserName := Copy(ResultStr, Pos('OK:', ResultStr) + 3, Length(ResultStr));
      // 줄바꿈/공백 제거
      VerifiedUserName := Trim(VerifiedUserName);
    end;
    DeleteFile(TmpFile);
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  T: string;
begin
  Result := True;
  if (TokenPage <> nil) and (CurPageID = TokenPage.ID) then
  begin
    T := Trim(TokenEdit.Text);
    if T = '' then
    begin
      MsgBox('설치 코드를 입력해주세요.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    TokenEdit.Text := T;
    if not VerifyTokenOnServer(T) then
    begin
      if MsgBox('서버에서 토큰 확인에 실패했습니다.' + #13#10 +
                '네트워크 문제일 수 있습니다.' + #13#10#13#10 +
                '그래도 계속 설치하시겠습니까?',
                mbConfirmation, MB_YESNO) = IDNO then
        Result := False;
    end
    else
    begin
      if VerifiedUserName <> '' then
        MsgBox('✅ 토큰 확인 완료!' + #13#10 +
               '사용자: ' + VerifiedUserName + #13#10#13#10 +
               '이 PC는 위 계정으로 연동됩니다.', mbInformation, MB_OK)
      else
        MsgBox('토큰 확인 완료! 설치를 진행합니다.', mbInformation, MB_OK);
    end;
  end;
end;

procedure WriteConfigFile(Token: string);
var
  S: string;
begin
  Token := Trim(Token);
  S := '{' + #13#10 +
    '  "token": "' + Token + '",' + #13#10 +
    '  "serverUrl": "https://sparkling-determination-production-c88b.up.railway.app",' + #13#10 +
    '  "installedAt": "' + GetDateTimeString('yyyy/mm/dd hh:nn:ss', '-', ':') + '"' + #13#10 + '}';
  SaveStringToFile(ExpandConstant('{%USERPROFILE}\.orbit-config.json'), S, False);
end;

procedure DownloadNodeJS;
// Node.js 다운로드 — 실패 시 대체 URL 자동 재시도 (3회)
var
  RC: Integer;
  Dest: string;
  Script: string;
begin
  Dest := ExpandConstant('{app}\node');
  ForceDirectories(Dest);
  // 3개 URL 순서대로 시도: nodejs.org → npmmirror(중국거울) → nodejs.org v20 LTS
  Script :=
    '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ' +
    '$urls=@(' +
      '''https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip'',' +
      '''https://registry.npmmirror.com/-/binary/node/v22.14.0/node-v22.14.0-win-x64.zip'',' +
      '''https://nodejs.org/dist/v20.18.3/node-v20.18.3-win-x64.zip''' +
    '); ' +
    '$dest=''' + Dest + '''; ' +
    '$ok=$false; ' +
    'foreach($url in $urls){ ' +
      'try{ ' +
        'Write-Host "다운로드 시도: $url"; ' +
        '$z=Join-Path $env:TEMP ''node-orbit.zip''; ' +
        '$wc=New-Object Net.WebClient; ' +
        '$wc.DownloadFile($url,$z); ' +
        'if((Get-Item $z).length -gt 5MB){ ' +
          'Expand-Archive -Force $z $dest; ' +
          '$d=Get-ChildItem $dest -Directory|Select-Object -First 1; ' +
          'if($d){Copy-Item (Join-Path $d.FullName ''*'') $dest -Recurse -Force -EA SilentlyContinue; Remove-Item $d.FullName -Recurse -Force -EA SilentlyContinue}; ' +
          'Remove-Item $z -Force -EA SilentlyContinue; ' +
          '$ok=$true; break ' +
        '} ' +
      '}catch{ Write-Warning "실패: $_" } ' +
    '}; ' +
    'if(-not $ok){ Write-Error "Node.js 다운로드 실패 — 네트워크를 확인하세요" }';
  Exec('powershell.exe',
    '-WindowStyle Hidden -ExecutionPolicy Bypass -Command "' + Script + '"',
    '', SW_HIDE, ewWaitUntilTerminated, RC);
end;

procedure InstallNpmPackages;
// npm install — 실패 시 2회 재시도 (V3/네트워크 일시 차단 대비)
var
  RC, Attempt: Integer;
  NodeExe, NpmCli: string;
begin
  NodeExe := ExpandConstant('{app}\node\node.exe');
  NpmCli  := ExpandConstant('{app}\node\npm\node_modules\npm\bin\npm-cli.js');
  if not FileExists(NodeExe) then Exit;
  for Attempt := 1 to 3 do
  begin
    Exec('powershell.exe',
      '-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -Command "' +
      'Set-Location ''' + ExpandConstant('{app}') + '''; ' +
      '& ''' + NodeExe + ''' ''' + NpmCli + ''' install --production --prefer-offline 2>&1 | Out-Null; ' +
      'exit $LASTEXITCODE"',
      '', SW_HIDE, ewWaitUntilTerminated, RC);
    if RC = 0 then Break;
    // 실패 시 잠시 대기 후 재시도 (V3 검사 완료 대기)
    Exec('cmd.exe', '/c timeout /t 3 /nobreak >nul', '', SW_HIDE, ewWaitUntilTerminated, RC);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  RC: Integer;
begin
  Result := '';
  NeedsRestart := False;
  // 1. 기존 데몬 프로세스 종료
  Exec('taskkill.exe', '/F /IM node.exe /FI "WINDOWTITLE eq orbit*"', '', SW_HIDE, ewWaitUntilTerminated, RC);
  Exec('powershell.exe',
    '-WindowStyle Hidden -NonInteractive -Command "Get-Process node -EA SilentlyContinue | Where-Object {$_.Path -like ''*orbit*'' -or $_.Path -like ''*mindmap*''} | Stop-Process -Force -EA SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, RC);
  // 2. 기존 mindmap-viewer 폴더 정리 (git repo — .orbit-config.json은 보존)
  if DirExists(ExpandConstant('{%USERPROFILE}\mindmap-viewer')) then
  begin
    Exec('powershell.exe',
      '-WindowStyle Hidden -NonInteractive -Command "' +
      'Remove-Item -Recurse -Force ''$env:USERPROFILE\mindmap-viewer\node_modules'' -EA SilentlyContinue; ' +
      'Remove-Item -Recurse -Force ''$env:USERPROFILE\mindmap-viewer\.git'' -EA SilentlyContinue"',
      '', SW_HIDE, ewWaitUntilTerminated, RC);
  end;
  // 3. 기존 Startup 바로가기 제거
  DeleteFile(ExpandConstant('{userstartup}\Orbit AI.lnk'));
  DeleteFile(ExpandConstant('{userstartup}\orbit-daemon.vbs'));
  DeleteFile(ExpandConstant('{userstartup}\orbit-daemon.bat'));
  // 4. Defender + 임시폴더 예외 미리 등록 (파일 추출 전 — 타이밍 핵심)
  Exec('powershell.exe',
    '-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -Command "' +
    'Add-MpPreference -ExclusionPath ''' + ExpandConstant('{app}') + ''' -EA SilentlyContinue; ' +
    'Add-MpPreference -ExclusionPath ''' + ExpandConstant('{%USERPROFILE}\mindmap-viewer') + ''' -EA SilentlyContinue; ' +
    'Add-MpPreference -ExclusionPath ''' + ExpandConstant('{%USERPROFILE}\.orbit') + ''' -EA SilentlyContinue; ' +
    'Add-MpPreference -ExclusionPath $env:TEMP -EA SilentlyContinue; ' +
    'Add-MpPreference -ExclusionExtension ''.node'' -EA SilentlyContinue; ' +
    'Add-MpPreference -ExclusionProcess ''node.exe'' -EA SilentlyContinue; ' +
    'Add-MpPreference -ExclusionProcess ''wscript.exe'' -EA SilentlyContinue"',
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
  RC: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    // 0. Phase1: package-phase1.json → package.json (uiohook-napi 제거)
    if FileExists(ExpandConstant('{app}\package-phase1.json')) then
    begin
      RenameFile(ExpandConstant('{app}\package.json'), ExpandConstant('{app}\package-orig.json'));
      FileCopy(ExpandConstant('{app}\package-phase1.json'), ExpandConstant('{app}\package.json'), False);
    end;
    // 1. 토큰 설정 파일 저장
    if GetTokenParam <> '' then T := GetTokenParam
    else if TokenEdit <> nil then T := Trim(TokenEdit.Text)
    else T := '';
    WriteConfigFile(T);

    // 2. Windows Defender 예외 먼저 등록 (npm install 전 차단 방지)
    Exec('powershell.exe',
      '-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -Command "' +
      'Add-MpPreference -ExclusionPath ''' + ExpandConstant('{app}') + ''' -EA SilentlyContinue; ' +
      'Add-MpPreference -ExclusionPath ''' + ExpandConstant('{%USERPROFILE}') + '\.orbit'' -EA SilentlyContinue; ' +
      'Add-MpPreference -ExclusionProcess ''node.exe'' -EA SilentlyContinue"',
      '', SW_HIDE, ewWaitUntilTerminated, RC);

    // 3. Node.js 없으면 다운로드 (3개 URL 자동 재시도)
    if not FileExists(ExpandConstant('{app}\node\node.exe')) then
      DownloadNodeJS;

    // 4. npm install (최대 3회 재시도 — V3/네트워크 일시 차단 대비)
    InstallNpmPackages;
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
