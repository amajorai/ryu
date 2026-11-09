; Tauri NSIS installer hooks for every Ryu desktop bundle (Ryu, Ryu (Dev),
; Ryu Bot and standalone app builds all inherit `bundle.windows.nsis` from
; tauri.conf.json).
;
; Tauri keeps the installer's own registry key under the publisher:
; `Software\<bundle.publisher>\<productName>`. Its default value is the install
; folder, which the next installer restores and the reinstall page uninstalls
; from. Until `bundle.publisher` was set, Tauri used the identifier's second
; segment (`ai.amajor.ryu.*`), so that key and the Control Panel "Publisher"
; read "amajor". The hooks below move a folder recorded under that legacy key
; to the current one, so an upgrade keeps a custom install folder and the
; reinstall page still uninstalls the right copy.
;
; Tauri includes this file before it defines ${MANUFACTURER} and
; ${PRODUCTNAME}, so the publisher is spelled out here and the product name is
; read at run time through $(^Name). apps/desktop/src/lib/installer-publisher.test.ts
; pins RYU_PUBLISHER_KEY to `bundle.publisher` and the legacy key to the
; identifier's second segment.

!define RYU_PUBLISHER_KEY "Software\A Major Pte. Ltd."
!define RYU_LEGACY_PUBLISHER_KEY "Software\amajor"

; Copies the install folder recorded under the legacy key to the current key
; and points $INSTDIR at it. Does nothing when the current key already records
; a folder or there is no legacy key, so a folder the user picks afterwards on
; the directory page is kept.
Function RyuAdoptLegacyInstallLocation
  Push $0
  ReadRegStr $0 SHCTX "${RYU_PUBLISHER_KEY}\$(^Name)" ""
  StrCmp $0 "" 0 ryu_adopt_done
  ReadRegStr $0 SHCTX "${RYU_LEGACY_PUBLISHER_KEY}\$(^Name)" ""
  StrCmp $0 "" ryu_adopt_done
  WriteRegStr SHCTX "${RYU_PUBLISHER_KEY}\$(^Name)" "" $0
  StrCpy $INSTDIR $0
  ryu_adopt_done:
  Pop $0
FunctionEnd

; Interactive and passive (updater) runs: adopt the legacy folder before the
; reinstall and directory pages read the key. Modern UI calls this from
; .onGUIInit, which runs after Tauri's .onInit has set its default $INSTDIR.
!define MUI_CUSTOMFUNCTION_GUIINIT RyuAdoptLegacyInstallLocation

; Silent runs (/S) have no GUI init, so adopt the folder here instead, before
; any file is copied. In GUI runs the key is already set and this is a no-op.
!macro NSIS_HOOK_PREINSTALL
  Call RyuAdoptLegacyInstallLocation
  SetOutPath $INSTDIR
!macroend

; After a successful install the current key records the folder, so drop the
; legacy key (and its parent once no other Ryu product uses it).
!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey SHCTX "${RYU_LEGACY_PUBLISHER_KEY}\$(^Name)"
  DeleteRegKey /ifempty SHCTX "${RYU_LEGACY_PUBLISHER_KEY}"
!macroend
