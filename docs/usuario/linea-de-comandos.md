# Línea de comandos

`tessera-cli.exe` viene en el zip de la **edición de escritorio**, junto a `tesserafs-desktop.exe`. Usa el mismo motor que la app (MFT con administrador, recorrido sin él), así que sirve para scripts, informes periódicos y avisos de poco espacio en equipos que administras.

```powershell
tessera-cli --help
```

## Lo más grande: `top`

```powershell
# Los 20 archivos más grandes de C:\ y las 10 carpetas más grandes de primer nivel
tessera-cli top C:\ --files 20 --folders 10

# Las carpetas de segundo nivel de los perfiles de usuario, en CSV para Excel
tessera-cli top C:\Users --folders 30 --depth 2 --format csv --out carpetas.csv

# JSON para otro programa
tessera-cli top D:\Proyectos --files 50 --format json --out top.json
```

| Opción | Qué hace |
|---|---|
| `--files N` | Los N archivos más grandes, a cualquier profundidad |
| `--folders N` | Las N carpetas más grandes a la profundidad `--depth` (1 = hijas directas de la ruta) |
| `--format table\|csv\|json` | Tabla legible (por defecto), CSV (UTF-8, comas, tamaños en bytes, fechas ISO en UTC) o JSON |
| `--out ARCHIVO` | Escribe en un archivo en lugar de en pantalla |
| `--engine auto\|walk\|mft` | Motor; `auto` usa la MFT si hay permisos |

Sin `--files` ni `--folders` muestra 10 de cada.

## Avisar de poco espacio: `check`

No escanea: sólo mira el espacio libre del volumen que contiene la ruta. Termina con un **código de salida** que entienden las tareas programadas y las herramientas de monitorización:

| Código | Significa |
|---|---|
| `0` | Hay al menos el espacio pedido |
| `2` | Hay menos |
| `1` | Error (ruta inexistente, argumento no válido…) |

```powershell
tessera-cli check C:\ --min-free 10%
# BAJO · C:\ · 30.16 GiB libres de 404.72 GiB (7.5 %) · mínimo 10 % (40.47 GiB)

tessera-cli check D:\ --min-free 50GB
```

El umbral puede ser un porcentaje (`10%`) o un tamaño (`500MB`, `20GB`, `1.5TB`; KB, MB, GB y TB valen 1024, como en el Explorador).

### Ejemplo: aviso diario con el Programador de tareas

```powershell
# check-espacio.ps1: deja una entrada en el registro de eventos si queda poco espacio en C:
& "C:\Herramientas\TesseraFS\tessera-cli.exe" check C:\ --min-free 10%
if ($LASTEXITCODE -eq 2) {
  Write-EventLog -LogName Application -Source "TesseraFS" -EntryType Warning -EventId 1001 -Message "Poco espacio libre en C:"
}
```

```powershell
schtasks /Create /TN "TesseraFS · espacio libre" /SC DAILY /ST 09:00 /TR "powershell -NoProfile -File C:\Herramientas\TesseraFS\check-espacio.ps1"
```

> [!NOTE]
> `Write-EventLog` necesita que el origen «TesseraFS» exista; créalo una vez, como administrador, con `New-EventLog -LogName Application -Source TesseraFS`. Puedes cambiarlo por un correo, un mensaje a Teams o lo que use tu equipo.

## Historial: `scan` e `history`

Las mismas instantáneas que guarda la app (ver [Qué ha cambiado](guia.md#qué-ha-cambiado-historial-y-comparación)):

```powershell
tessera-cli scan C:\ --history-save                    # escanea y guarda un resumen
tessera-cli history list                               # lista los resúmenes (JSON)
tessera-cli scan C:\ --history-compare <id> --children # compara con uno y muestra las carpetas por cambio
tessera-cli history delete <id>
tessera-cli history clear
```

`scan` también admite `--dups <bytes>` (busca duplicados de ese tamaño o más) y `--dups-out duplicados.json`.

## Escaneo completo para abrirlo en otro equipo: `--save`

```bash
tessera-cli scan /srv/datos --save datos.tessera      # en el servidor o el NAS
tessera-cli top datos.tessera                          # lo más grande, sin volver a escanear
tessera-cli check datos.tessera --min-free 10%         # con el espacio que tenía la unidad al escanear
```

El `.tessera` se abre después en la app (Exportar › **Abrir un escaneo guardado…**) en cualquier equipo, Windows o Linux. `scan`, `top` y `check` aceptan un `.tessera` en lugar de una carpeta; `check` usa el espacio que tenía la unidad al escanear y añade la fecha del escaneo.

Para ver cómo ha cambiado una carpeta en los resúmenes del historial:

```bash
tessera-cli scan C:\ --history-trend Users\ana\Downloads    # ruta absoluta o relativa a la raíz
```

> [!TIP]
> La variable de entorno `TESSERA_HISTORY_DIR` cambia la carpeta del historial, por ejemplo para guardar los resúmenes de varios equipos en una carpeta compartida.
