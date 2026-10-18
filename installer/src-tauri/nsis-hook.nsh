; NSIS Hook - Register safelinks-installer:// protocol handler
; Called after installation

!include "x64.nsh"

Function .onInstSuccess
  ; Register the protocol handler in registry
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    SetRegView 32
  ${EndIf}
  
  ; Create registry entries for safelinks-installer:// protocol
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.safelinks\UserChoice" "" ""
  WriteRegStr HKCR "safelinks-installer" "" "URL:SAFE Links Installer"
  WriteRegStr HKCR "safelinks-installer" "URL Protocol" ""
  WriteRegStr HKCR "safelinks-installer\shell\open\command" "" '"$INSTDIR\SAFE_Links Installer.exe" "%%1"'
  
  ; For current user registry
  WriteRegStr HKCU "Software\Classes\safelinks-installer" "" "URL:SAFE Links Installer"
  WriteRegStr HKCU "Software\Classes\safelinks-installer" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\safelinks-installer\shell\open\command" "" '"$INSTDIR\SAFE_Links Installer.exe" "%%1"'
FunctionEnd

Function un.onUninstall
  ; Remove protocol handler on uninstall
  DeleteRegKey HKCR "safelinks-installer"
  DeleteRegKey HKCU "Software\Classes\safelinks-installer"
FunctionEnd
