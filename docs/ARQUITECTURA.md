# Arquitectura de TesseraFS

TesseraFS es un analizador de espacio en disco para Windows. Una sola interfaz web (`packages/ui`) funciona sobre dos motores intercambiables que cumplen el mismo contrato:

| Edición | Motor | Ventana | Binarios que se distribuyen |
|---|---|---|---|
| **Escritorio** (`apps/desktop`) | Rust (`crates/tessera-core`) | Tauri 2 + WebView2 | `tesserafs.exe` propio (hay que firmarlo) |
| **Portable** (`apps/portable`) | TypeScript sobre Bun (`packages/core-bun`, `bun:ffi`) | Microsoft Edge en modo app | Sólo `bun.exe` (firmado por su editor) + `tesserafs.js` |
| Demo (artifact) | Datos de ejemplo en el navegador | Navegador | Ninguno |

## Por qué Edge en modo app para la edición portable

Evaluación del 7 de octubre de 2026 en esta máquina (`Get-AuthenticodeSignature`):

| Envoltorio | Ejecutables propios | Firma |
|---|---|---|
| Edge `--app` | `msedge.exe` ya instalado en Windows 10/11 | Microsoft Corporation |
| Bun 1.3 | `bun.exe` 93,9 MB | Codeblog CORP |
| Neutralino 6.10 | `neutralino-win_x64.exe` 2,3 MB | Sin firmar |
| NW.js 0.117 | `nw.exe`, `nw.dll` (308 MB), `node.dll`… 539 MB | 11 de 13 sin firmar |
| Buntralino 1.0/1.2 | Neutralino + `bun build --compile` | Sin firmar; sin publicar desde feb-2025 |
| `bun build --compile` | exe nuevo de 93,9 MB | Sin firmar |

En entornos corporativos el antivirus bloquea por **falta de firma y reputación**, no por lenguaje. Con Bun + Edge no se distribuye ningún binario sin firmar.

## Estructura del repositorio

```
packages/protocol   Tipos, codec binario "slice" y lenguaje de búsqueda (TS, compartido)
packages/ui         Interfaz (TS + Canvas). Backends: demo, tauri, http
packages/core-bun   Motor en Bun: recorrido FFI, lector MFT FFI, almacén SoA, API
apps/portable       Servidor Bun + lanzador Edge + script de empaquetado portable
apps/desktop        Tauri 2 (src-tauri) usando tessera-core
crates/tessera-core Motor en Rust: recorrido, lector MFT, almacén SoA, slice, búsqueda
```

## Contrato entre interfaz y motor

Tipos en [`packages/protocol/src/types.ts`](../packages/protocol/src/types.ts). Todos los tamaños son bytes (`number` en TS, `u64` en Rust serializado como número JSON; < 2^53). Fechas en segundos Unix (UTC). Ids: `u32`, la raíz del escaneo puede tener cualquier id.

| Operación | Tauri (comando) | HTTP (Bun) | Respuesta |
|---|---|---|---|
| Unidades | `volumes` | `GET /api/volumes` | `VolumeInfo[]` |
| Escanear | `scan {path, engine, onProgress: Channel<ScanProgress>}` | `POST /api/scan` + eventos SSE en `GET /api/events` | `ScanResult` |
| Porción para el mapa | `slice {root, minBytes, maxNodes}` | `GET /api/slice?root=&min=&max=` | **binario** (ver abajo) |
| Hijos (árbol) | `children {id, offset, limit, sort, desc}` | `GET /api/children?id=&offset=&limit=&sort=&desc=` | `ChildrenResponse` |
| Búsqueda | `search {query, root, limit}` | `GET /api/search?q=&root=&limit=` | `SearchResponse` |
| Tipos de archivo | `ext_stats {root}` | `GET /api/ext?root=` | `ExtStat[]` (orden: tamaño desc) |
| Ruta | `node_path {id}` | `GET /api/path?id=` | `string` |
| Nodo | `node_info {id}` | `GET /api/node?id=` | `NodeRow` |
| Acción | `action {kind, id}` | `POST /api/action` `{kind,id}` | `ActionResult` |
| Elevación | `elevation` / `relaunch_elevated` | `GET /api/elevation` / `POST /api/relaunch-elevated` | `ElevationInfo` |

Progreso: `ScanProgress.fraction` (0–1) es opcional; los motores lo envían cuando conocen el total de trabajo (lectura de la MFT). Sin él, la interfaz estima el avance con `bytes` frente al espacio usado de la unidad, y en carpetas sueltas lo muestra como indeterminado.

Seguridad HTTP: el servidor escucha sólo en `127.0.0.1`, puerto aleatorio, y exige la cabecera `X-Tessera-Token` (token aleatorio inyectado en el HTML). Sin cabeceras CORS: otras webs no pueden llamar a la API.

### Formato binario "slice" v1 (little-endian)

Subárbol podado para dibujar el mapa sin transferir millones de nodos. Se incluyen los nodos con `size >= minBytes` recorriendo **por niveles** (BFS) hasta `maxNodes`; se emiten en **preorden**, hijos ordenados por tamaño descendente. Lo podado de cada carpeta se resume en `restSize`/`restCount`.

```
Cabecera (32 B)
  0  u32 magic 0x314C5354 ("TSL1")   4  u32 version = 1
  8  u32 count                        12 u32 extCount
  16 u32 namesBytes                   20 u32 extBytes
  24 f64 minBytes
Tabla de extensiones (extBytes): extCount × (u8 len, utf8)  · minúsculas, sin punto; "" = sin extensión
Relleno con ceros hasta múltiplo de 8
Registros: count × 64 B
  0 u32 id            4 i32 parent (índice en el slice; -1 en el primero)
  8 f64 size          16 f64 alloc          24 f64 restSize
  32 u32 restCount    36 u32 files          40 u32 dirs          44 u32 mtime
  48 u16 extIdx (0xFFFF = carpeta)          50 u16 flags
  52 u32 nameOff      56 u16 nameLen        58 u16 depth (relativa a la raíz del slice)
  60 u32 childCount (hijos directos en el árbol completo)
Nombres: blob utf8 (namesBytes)
```

`flags`: `DIR=1 HIDDEN=2 SYSTEM=4 HARDLINK=8 COMPRESSED=16 REPARSE=32 CLOUD=64 SPARSE=128`.

### Lenguaje de búsqueda

Implementado en [`packages/protocol/src/query.ts`](../packages/protocol/src/query.ts); el motor Rust lo replica.

- Espacio = Y. `OR` o `|` = O. Prefijo `-` = NO. Comillas para espacios: `"Cities Skylines"`.
- `ext:gguf,bin` · `ext:none` (sin extensión)
- `size:>1g` `size:<10m` `size:1g..5g` (alias `tam:`) · `alloc:>100m` (alias `asig:`). Unidades b k m g t, base 1024.
- `age:<30d` modificado hace menos de 30 días · `age:>1y` (alias `edad:`). Unidades d w mo y.
- `path:node_modules` subcadena de la ruta completa (alias `ruta:`) · `name:VT*` comodín sobre el nombre (alias `nombre:`)
- `re:^VT[._]` expresión regular sobre el nombre · `type:dir|file` (alias `tipo:carpeta|archivo`)
- Palabra suelta: comodín si lleva `*` o `?`; si no, subcadena del nombre. Todo sin distinguir mayúsculas.
- Sin `type:`, sólo se devuelven archivos.
- Resultados ordenados por tamaño descendente; `total`/`totalBytes` cuentan todas las coincidencias y `rows` trae las `limit` primeras. Consulta vacía = todos los archivos bajo `root` (la lista de "más grandes"). `path` es la ruta completa de Windows (`C:\Windows\WinSxS`; la raíz es `C:\`).
- `children` ordena según `sort`/`desc` y desempata por nombre.

### Reglas comunes de los dos motores

- La raíz del escaneo se llama con su ruta completa (`C:\`) y `parentId = -1`. `entries` = archivos + carpetas, sin contar la raíz. La búsqueda nunca devuelve la raíz.
- Enlaces duros: el primer nombre conserva tamaño y asignado; los demás llevan `HARDLINK` con tamaño y asignado 0, así cada carpeta suma exactamente lo de sus hijos.
- Puntos de reanálisis (junctions, symlinks): hojas con `REPARSE`, nunca se siguen. Las carpetas de OneDrive sí se recorren; los marcadores en la nube llevan `CLOUD` y no se abren (abrirlos los descargaría).
- Sin administrador, las carpetas sin permiso se omiten y se cuentan como aviso. Un segundo escaneo mientras hay uno en curso se rechaza.
- Tras `trash` con éxito, el nodo sale del árbol y se descuenta de todos sus antepasados.

### Rendimiento medido (C:\, 1,47 M elementos, sin administrador, i5-13450HX + NVMe)

| Motor | Tiempo | Memoria |
|---|---|---|
| Rust, recorrido con 16 hilos (`NtQueryDirectoryFile`, búfer de 1 MiB) | 4,2–5,1 s | ≈107 MiB el árbol, ≈270 MiB de pico |
| Bun, recorrido con 8 workers (`NtQueryDirectoryFile` vía `bun:ffi`) | 4,7–5,8 s | ≈525 MB tras el escaneo, ≈800 MB de pico |
| Referencia: Python `os.scandir` con 4 hilos | 15,1 s | — |

El modo MFT (administrador) sólo se ha probado con registros sintéticos. Para probarlo en real, desde una terminal elevada: `target\release\tessera-cli.exe scan C:\ --compare` (compara MFT y recorrido carpeta a carpeta).

## Elevación

Sin administrador no se puede abrir `\\.\C:` y ambos motores recorren directorios. Con administrador, leen la MFT. MVP: relanzar el proceso con el verbo `runas` (Tauri: la app; portable: `bun.exe` con el mismo script, la ventana de Edge sigue sin elevar). Fase siguiente: helper elevado mínimo con tubería con nombre.
