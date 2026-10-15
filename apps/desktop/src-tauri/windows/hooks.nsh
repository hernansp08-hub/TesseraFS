; Ganchos del instalador NSIS de TesseraFS (bundle > windows > nsis > installerHooks en tauri.conf.json).
;
; «Analizar con TesseraFS» en el menú del clic derecho de las carpetas, del fondo de una carpeta abierta y de las
; unidades. Se escribe sólo para el usuario que instala (HKCU\Software\Classes, sin administrador) y la
; desinstalación lo quita. En Windows 11 aparece dentro de «Mostrar más opciones» (Mayús+F10).
; La app recibe la ruta como primer argumento y la escanea al abrirse (SystemInfo.launchPath).
;
; tessera-cli.exe (la línea de comandos y el servidor MCP) va junto a la app: lo copia y lo borra la plantilla
; de Tauri (bundle > externalBin, que añade scripts/package.ts). Su carpeta se pone en el PATH del usuario
; (HKCU\Environment, nunca el del sistema) y la desinstalación la quita. Lo hace la app (--add-to-path,
; --remove-from-path) porque NSIS corta las cadenas a 1024 caracteres y un PATH más largo quedaría truncado.

Var TesseraMenuText

; ROOT: Directory, Directory\Background o Drive. ARG: cómo se pasa la ruta (%V es la carpeta o la unidad).
!macro TESSERA_MENU_KEY ROOT ARG
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\TesseraFS" "" "$TesseraMenuText"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\TesseraFS" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\TesseraFS\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" ${ARG}"
!macroend

; Un asistente de IA puede tener abierto el servidor MCP (tessera-cli mcp), y entonces su exe no se puede
; reemplazar ni borrar: como con la app, se pide cerrarlo (en silencio, se cierra)
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\tessera-cli.exe" "tessera-cli"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --add-to-path'
  Pop $0
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
  ; Escaneo programado: al actualizar, el instalador desinstala antes la versión anterior, que quita la tarea;
  ; si había uno guardado (schedule.json queda, como el historial), la app vuelve a crear la tarea
  ${If} ${FileExists} "$LOCALAPPDATA\TesseraFS\schedule.json"
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --restore-schedule'
    Pop $0
  ${EndIf}
!macroend

; El PATH se quita con la app todavía instalada, después de cerrarla (y a tessera-cli): si se cancela,
; la desinstalación se detiene sin haber tocado nada
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\tessera-cli.exe" "tessera-cli"
  nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --remove-from-path'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\TesseraFS"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\TesseraFS"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\TesseraFS"
  ; La tarea del escaneo programado, que sin la app fallaría cada vez (si no hay, schtasks sólo da un error)
  ${If} $UpdateMode <> 1
    nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /F /TN "TesseraFS scheduled scan"'
    Pop $0
  ${EndIf}
!macroend
