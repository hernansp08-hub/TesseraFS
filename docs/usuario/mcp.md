# Asistentes de IA (MCP)

`tessera-cli mcp` convierte TesseraFS en un **servidor MCP** ([Model Context Protocol](https://modelcontextprotocol.io)): Claude, GitHub Copilot en VS Code, Cursor y otros asistentes pueden preguntarle qué ocupa tu disco y contestarte con datos reales, en lugar de adivinar.

La edición portable trae el mismo servidor, `bun.exe tesserafs.js mcp`, sin ningún ejecutable propio: sirve donde el antivirus no deja ejecutar `tessera-cli.exe` ([cómo conectarla](#con-la-edición-portable)).

```mermaid
flowchart LR
    A["Asistente<br/>Claude · Copilot · Cursor"] -->|"MCP (stdio)"| M["tessera-cli mcp<br/>o bun.exe tesserafs.js mcp"]
    M -->|motor de TesseraFS| D[("Tu disco<br/>sólo lectura")]
```

Le puedes pedir cosas como:

- «¿Qué ocupa tanto en C:? Dime las 10 carpetas más grandes de mi perfil.»
- «Busca modelos de IA locales de más de 1 GB y dime de qué programa son.»
- «¿Qué ha crecido en el disco desde el último escaneo guardado?»
- «¿Hay archivos duplicados de más de 100 MB en Descargas?»
- «Explícame qué es `C:\ProgramData\Package Cache` y si se puede limpiar.»
- «¿Qué puedo limpiar sin riesgo en mi carpeta de proyectos?»

## Qué hace y qué no

- **Sólo lee.** Escanea, busca, compara y busca duplicados. **Nunca borra, mueve ni cambia** tus archivos: si el asistente propone limpiar algo, lo haces tú (desde la app, que envía a la Papelera, o con la orden que te indique).
- La única escritura es `save_snapshot`, que guarda un resumen en el historial de TesseraFS, igual que la app al escanear.
- **Privacidad:** TesseraFS no envía nada a ningún sitio, pero **el asistente sí ve lo que le devuelven las herramientas** (rutas, nombres de archivo, tamaños y fechas) y lo procesa con su modelo, en la nube si no es local. No lo conectes si los nombres de tus archivos son confidenciales.
- Los escaneos se quedan en memoria mientras el asistente tiene abierto el servidor: la primera pregunta escanea y las siguientes contestan al instante. Cada respuesta dice cuándo se hizo el escaneo; el asistente puede pedir `refresh` para ponerlo al día.

## Dónde está `tessera-cli`

| Instalación | Ruta para la configuración |
|---|---|
| Instalador de Windows | `%LOCALAPPDATA%\TesseraFS\tessera-cli.exe`, p. ej. `C:\Users\ana\AppData\Local\TesseraFS\tessera-cli.exe` (o la carpeta que elegiste al instalar). El instalador añade esa carpeta a tu `PATH` |
| Zip de la edición de escritorio | `tessera-cli.exe` está en la carpeta donde lo descomprimiste, p. ej. `C:\Herramientas\TesseraFS\tessera-cli.exe` |
| [Scoop](https://scoop.sh) | `tessera-cli` (ya está en el `PATH`) |
| Linux, paquete `.deb` | `/usr/bin/tessera-cli` (ya está en el `PATH`) |
| Linux, AppImage | Va dentro, pero hay que sacarlo una vez, p. ej. a `~/.local/bin/tessera-cli` ([cómo](linux.md#la-línea-de-comandos)) |
| Linux (`TesseraFS-X.Y.Z-cli-linux-x64.tar.gz`) | Donde lo copiaste, p. ej. `/usr/local/bin/tessera-cli` |
| Edición portable | No lleva `tessera-cli`: el servidor lo ejecuta `bun.exe` con `tesserafs.js`, los dos en la carpeta portable ([cómo](#con-la-edición-portable)) |

En los ejemplos se usa `tessera-cli`; si no está en el `PATH`, pon la ruta completa (en JSON, con las barras dobladas: `C:\\Users\\ana\\AppData\\Local\\TesseraFS\\tessera-cli.exe`). Los programas que ya estaban abiertos al instalar no ven el `PATH` nuevo hasta que los reinicias; con la ruta completa funciona siempre.

## Conectarlo

### Claude Desktop

**Settings › Developer › Edit Config** (Configuración › Desarrollador) abre `claude_desktop_config.json`. Añade:

```json
{
  "mcpServers": {
    "tesserafs": {
      "command": "C:\\Users\\ana\\AppData\\Local\\TesseraFS\\tessera-cli.exe",
      "args": ["mcp"]
    }
  }
}
```

Reinicia Claude Desktop. Las herramientas de TesseraFS aparecen en el botón de herramientas del chat.

### Claude Code

```bash
claude mcp add --scope user tesserafs -- tessera-cli mcp
```

`--scope user` lo deja disponible en todos tus proyectos. Compruébalo con `claude mcp list`.

### VS Code (GitHub Copilot, modo agente)

Paleta de comandos › **MCP: Add Server…** › **Command (stdio)** y escribe `tessera-cli mcp`. O a mano, en `.vscode/mcp.json` del proyecto (o en la configuración de usuario):

```json
{
  "servers": {
    "tesserafs": {
      "type": "stdio",
      "command": "tessera-cli",
      "args": ["mcp"]
    }
  }
}
```

### Cursor y otros

Cursor (`~/.cursor/mcp.json`), Windsurf, Gemini CLI y la mayoría de clientes usan el mismo bloque que Claude Desktop: `"command"` con la ruta de `tessera-cli` y `"args": ["mcp"]`.

### Con la edición portable

La portable no trae `tessera-cli.exe`. El servidor lo ejecuta el `bun.exe` firmado de su carpeta, el mismo que abre la app, así que funciona donde el antivirus bloquea los ejecutables sin firmar. En la configuración:

- `"command"`: la ruta de `bun.exe` de la carpeta portable.
- `"args"`: la ruta de `tesserafs.js` de esa misma carpeta, seguida de `"mcp"`.

Con la carpeta en `C:\Herramientas\TesseraFS-portable`, el bloque de Claude Desktop, Cursor y la mayoría de clientes queda así:

```json
{
  "mcpServers": {
    "tesserafs": {
      "command": "C:\\Herramientas\\TesseraFS-portable\\bun.exe",
      "args": ["C:\\Herramientas\\TesseraFS-portable\\tesserafs.js", "mcp"]
    }
  }
}
```

En VS Code es igual, dentro de `"servers"` y con `"type": "stdio"`. En Claude Code:

```bash
claude mcp add --scope user tesserafs -- "C:\Herramientas\TesseraFS-portable\bun.exe" "C:\Herramientas\TesseraFS-portable\tesserafs.js" mcp
```

Pon siempre las dos rutas completas, y cámbialas si mueves la carpeta. No sirven `TesseraFS.cmd` ni `TesseraFS.vbs`: abren la ventana de la app, no el servidor MCP.

Tiene las mismas herramientas que `tessera-cli mcp`, con los mismos argumentos y las mismas respuestas. Lo que cambia:

| | `tessera-cli mcp` (escritorio) | `bun.exe tesserafs.js mcp` (portable) |
|---|---|---|
| Sistemas | Windows y Linux | Sólo Windows |
| `scan` con `refresh` en una unidad entera | Con administrador, se pone al día en un momento con el diario de cambios de NTFS | Se vuelve a escanear entera. La respuesta lo avisa en `note` |
| `scan` con `refresh` en una carpeta de dentro | Vuelve a escanear sólo esa carpeta | Igual |
| Memoria | Unos 110 MB por cada 1,5 millones de elementos; hasta 4 escaneos | Unos 500 MB por cada 1,5 millones de elementos; hasta 4 escaneos y 3 millones de elementos entre todos. Al pasar de ahí olvida el usado hace más tiempo, que se vuelve a escanear si el asistente lo pide |
| Duplicados | Compara el contenido con BLAKE3 | Con SHA-256 (el resultado es el mismo) |

El historial es el mismo para las dos ediciones: un resumen guardado con una se compara desde la otra.

## Herramientas

| Herramienta | Para qué |
|---|---|
| `list_volumes` | Unidades y espacio libre, sin escanear |
| `scan` | Escanea una unidad o carpeta (o abre un `.tessera`) y la deja en memoria; con `refresh` la pone al día |
| `largest` | Los archivos y las carpetas más grandes bajo una carpeta |
| `list_folder` | El contenido de una carpeta ordenado por tamaño, nombre, fecha, archivos o cambio |
| `search` | Búsqueda con el [lenguaje de filtros](filtros.md): `ext:gguf size:>1g`, `age:>2y size:>500m`… |
| `file_types` | Espacio por extensión |
| `cleanup_candidates` | Qué se puede limpiar, con las mismas reglas que la pestaña [Liberar espacio](liberar-espacio.md): cada candidato con su riesgo (seguro, revisar o no borrar a mano), tamaño, por qué, cómo y la orden del propio programa (`cargo clean`, `npm cache clean --force`…). Con `risk` se filtra por riesgo (`ok`, `warn`, `bad`) |
| `find_duplicates` | Archivos con el mismo contenido (lee los archivos: puede tardar) |
| `broken_links` | Enlaces simbólicos, uniones y puntos de montaje rotos |
| `history` | Los resúmenes guardados en el [historial](guia.md#qué-ha-cambiado-historial-y-comparación) |
| `compare_snapshot` | Qué creció, qué se redujo y qué desapareció desde un resumen. Por defecto usa el más reciente hecho con el mismo motor, y marca lo que sólo es efecto de comparar escaneos hechos con permisos distintos (carpetas que esta vez no se pudieron leer, metadatos de NTFS) |
| `size_trend` | El tamaño de una carpeta o archivo en todos los resúmenes |
| `save_snapshot` | Guarda un resumen en el historial para comparar más adelante |

Todas aceptan rutas absolutas (`C:\Users\ana\Downloads` o `/home/ana`). Sin ruta, usan el último escaneo. Si una ruta no está en ningún escaneo en memoria, se escanea antes.

## Rendimiento y permisos

- El asistente lanza `tessera-cli` con tus permisos. Con administrador se lee la MFT: una unidad entera en segundos. Sin administrador, se recorre carpeta a carpeta, y en un disco de sistema grande eso va de unos 15 s a un par de minutos (1,8 millones de elementos: 15 s con las carpetas en la caché de Windows, casi 2 minutos el primer escaneo tras encender el equipo). Para ir más rápido, abre el asistente como administrador o pídele sólo la carpeta que te interesa (tu perfil, Descargas…).
- Si el asistente corta el primer escaneo de una unidad por tiempo, súbele el límite de espera de las herramientas (en Claude Code, la variable de entorno `MCP_TOOL_TIMEOUT`, en milisegundos) o escanea una carpeta más pequeña. Mientras escanea, TesseraFS le avisa del progreso cada segundo.
- La portable tarda algo más: unos 5 s para 1,6 millones de elementos en un disco NVMe, y bastante más la primera vez tras encender el equipo, cuando Windows aún no tiene las carpetas en caché. Con administrador también lee la MFT.
- Lo que no puedes leer (otras cuentas, carpetas protegidas del sistema) no aparece; el resultado de `scan` lo avisa.
- Un escaneo o una búsqueda de duplicados largos muestran progreso y se pueden cancelar desde el asistente.
- Para probarlo sin asistente: [MCP Inspector](https://github.com/modelcontextprotocol/inspector) con `npx @modelcontextprotocol/inspector tessera-cli mcp` (con la portable, `npx @modelcontextprotocol/inspector "C:\Herramientas\TesseraFS-portable\bun.exe" "C:\Herramientas\TesseraFS-portable\tesserafs.js" mcp`).
