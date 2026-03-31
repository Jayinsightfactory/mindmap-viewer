; Minimal test ISS - no Korean, no DownloadTemporaryFile
#define MyAppName "Orbit AI Test"
#define MyAppVersion "1.0.0"

[Setup]
AppId={{B7A2C3D4-E5F6-4789-ABCD-EF0123456789}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={userappdata}\orbit-test
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=OrbitAI-Test
Compression=lzma2
SolidCompression=yes

[Languages]
Name: "default"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\daemon\*"; DestDir: "{app}\daemon"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
