; Uninstall cleanup, inserted into Tauri's NSIS template.
;
; $APPDATA\<id> holds stored data (raid history, map tiles, map data, paired sites);
; $LOCALAPPDATA\<id> holds the webview profile, where preferences live.
; Deleting data is the default answer; preferences are kept unless asked. Updates (/UPDATE),
; passive (/P) and silent (/S) runs never prompt and keep both. When Tauri's own "Delete the
; application data" box was ticked, both folders are already gone and nothing is asked.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
    SetShellVarContext current
    ${If} ${FileExists} "$APPDATA\${BUNDLEID}\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "Delete the data ${PRODUCTNAME} stored?$\r$\n$\r$\nRaid history, positions, events, map tiles, map data and paired sites. Your game files are not touched.$\r$\n$\r$\nChoose No if you are reinstalling and want to keep it." /SD IDNO IDNO +2
        RmDir /r "$APPDATA\${BUNDLEID}"
    ${EndIf}
    ${If} ${FileExists} "$LOCALAPPDATA\${BUNDLEID}\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your ${PRODUCTNAME} preferences?$\r$\n$\r$\nWindow, map, mini mode, connection and auto-screenshot settings." /SD IDNO IDNO +2
        RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
    ${EndIf}
  ${EndIf}
!macroend
