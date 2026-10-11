; Ganchos del instalador NSIS de TesseraFS (bundle > windows > nsis > installerHooks en tauri.conf.json).
;
; «Analizar con TesseraFS» en el menú del clic derecho de las carpetas, del fondo de una carpeta abierta y de las
; unidades. Se escribe sólo para el usuario que instala (HKCU\Software\Classes, sin administrador) y la
; desinstalación lo quita. En Windows 11 aparece dentro de «Mostrar más opciones» (Mayús+F10).
; La app recibe la ruta como primer argumento y la escanea al abrirse (SystemInfo.launchPath).

Var TesseraMenuText

; ROOT: Directory, Directory\Background o Drive. ARG: cómo se pasa la ruta (%V es la carpeta o la unidad).
!macro TESSERA_MENU_KEY ROOT ARG
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\TesseraFS" "" "$TesseraMenuText"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\TesseraFS" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\TesseraFS\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" ${ARG}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; El texto del menú, en el idioma elegido en el instalador (identificadores de idioma de Windows)
  StrCpy $TesseraMenuText "Analyze with TesseraFS"
  StrCmp $LANGUAGE "1034" 0 +2
    StrCpy $TesseraMenuText "Analizar con TesseraFS"
  StrCmp $LANGUAGE "1046" 0 +2
    StrCpy $TesseraMenuText "Analisar com o TesseraFS"
  StrCmp $LANGUAGE "1036" 0 +2
    StrCpy $TesseraMenuText "Analyser avec TesseraFS"
  StrCmp $LANGUAGE "1031" 0 +2
    StrCpy $TesseraMenuText "Mit TesseraFS analysieren"
  ; Carpetas: entre comillas por los espacios. Unidades: sin comillas, porque «"C:\"» llegaría como «C:"»
  !insertmacro TESSERA_MENU_KEY "Directory" "$\"%V$\""
  !insertmacro TESSERA_MENU_KEY "Directory\Background" "$\"%V$\""
  !insertmacro TESSERA_MENU_KEY "Drive" "%V"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\TesseraFS"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\TesseraFS"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\TesseraFS"
!macroend
