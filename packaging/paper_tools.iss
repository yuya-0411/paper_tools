#define AppVersion GetEnv("PAPER_TOOLS_VERSION")
#if AppVersion == ""
  #define AppVersion "0.2.0"
#endif

[Setup]
AppId={{6CC74B29-C4C9-4B37-91A0-BBC702D504F6}
AppName=paper_tools
AppVersion={#AppVersion}
AppPublisher=paper_tools contributors
AppPublisherURL=https://github.com/yuya-0411/paper_tools
AppSupportURL=https://github.com/yuya-0411/paper_tools/issues
AppUpdatesURL=https://github.com/yuya-0411/paper_tools/releases/latest
DefaultDirName={localappdata}\Programs\paper_tools
DefaultGroupName=paper_tools
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist\installer
OutputBaseFilename=paper-tools-setup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\paper_tools.exe
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "デスクトップにショートカットを作成する"; GroupDescription: "追加アイコン:"; Flags: unchecked

[Files]
Source: "..\dist\paper_tools\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{group}\paper_tools"; Filename: "{app}\paper_tools.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\paper_tools"; Filename: "{app}\paper_tools.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\paper_tools.exe"; Description: "paper_toolsを起動する"; Flags: nowait postinstall skipifsilent
