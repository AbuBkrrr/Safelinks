; SAFE_Links — Inno Setup script
; ---------------------------------------------------------------------
; What this does: packages the already-built app in
; dist\SAFE_Links-win32-x64\ (produced by `npm run package:win` — see
; README.md) into a normal Windows installer: Setup.exe that installs
; to Program Files, adds a Start Menu entry, an optional Desktop icon,
; and a proper uninstaller.
;
; HOW TO USE:
;   1. Run `npm run package:win` first (see README.md) — this script
;      expects dist\SAFE_Links-win32-x64\SAFE_Links.exe to already
;      exist. It packages what's already built; it doesn't build it.
;   2. Open Inno Setup Compiler.
;   3. File -> Open -> select this file (SAFE_Links.iss).
;   4. Build -> Compile (or press F9).
;   5. The finished installer lands in Output\SAFE_Links-Setup.exe by
;      default (see OutputDir below).
;
; This script assumes it sits in the same folder as the "dist" folder
; (i.e. at the project root, alongside package.json) — that's where it
; is in the zip you were given. If you move it, update SourceBaseDir.
; ---------------------------------------------------------------------

#define AppName "SAFE_Links"
#define AppPublisher "A I Brains Ventures"
#define AppVersion "1.0.0"
#define AppExeName "SAFE_Links.exe"
#define SourceBaseDir "dist\SAFE_Links-win32-x64"

[Setup]
AppId={{B7B7E6D2-6C6E-4C6E-9C1B-8D0F6E5D6A11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=mailto:aibrainsventures@gmail.com
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Per-user install by default — no admin prompt needed to install just
; for the current user. Switch to "admin" + remove the
; PrivilegesRequiredOverridesAllowed line if you specifically want a
; machine-wide (all users) install instead.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename=SAFE_Links-Setup
SetupIconFile=build\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Electron apps are large (Chromium + Node runtime bundled in) — this
; is normal, not a packaging mistake. ~350MB unpacked is expected.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; Everything electron-packager produced — the .exe, Chromium/Node
; runtime files (.dll/.pak/.bin), locales, and our app code inside
; resources\app.asar. recursesubdirs pulls in the locales\ folder etc.
Source: "{#SourceBaseDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName} now"; Flags: nowait postinstall skipifsilent
