# Motores de escaneo

Los dos motores (Rust en `crates/tessera-core` y TypeScript en `packages/core-bun`) hacen lo mismo con las mismas reglas: eligen cómo leer el disco, construyen un árbol compacto y responden a las operaciones del [contrato](../ARQUITECTURA.md).

```mermaid
flowchart TD
    S["scan(path, engine)"] --> Q{"¿engine = auto o mft?<br/>¿administrador?<br/>¿NTFS local?"}
    Q -->|Sí| M["Motor MFT"]
    Q -->|No| W["Motor de recorrido"]
    M -->|"error o resultado incoherente"| W
    M --> B["Construcción del árbol"]
    W --> B
    B --> A["Agregación ascendente:<br/>tamaño, asignado, archivos, carpetas, fecha"]
    A --> O["Hijos ordenados por tamaño desc."]
    O --> R["ScanResult + árbol listo para<br/>slice · children · search · extStats"]
```

Si el modo MFT no está disponible o falla, el motor recorre las carpetas y lo indica en `warnings` (por ejemplo: «MFT no disponible sin administrador: se usó el recorrido»).

## Modelo de datos: árbol en arreglos (SoA)

En vez de un objeto por archivo, el árbol se guarda como **columnas**: un arreglo por campo, indexado por id.

| Columna | Tipo | Notas |
|---|---|---|
| `parent` | u32 | Rust: los ids siguen el orden por niveles, así que el padre siempre es menor que sus hijos |
| `first_child` · `child_count` | u32 | Rust: los hijos de cada carpeta son **contiguos** y ya están ordenados por tamaño |
| `size` · `alloc` | u64 (Rust) / f64 (Bun) | Tamaño lógico y espacio asignado |
| `files` · `dirs` | u32 | Descendientes |
| `mtime` | u32 | Segundos Unix |
| `ext` | u16 | Índice en una tabla de extensiones internadas |
| `flags` | u16 | `DIR HIDDEN SYSTEM HARDLINK COMPRESSED REPARSE CLOUD SPARSE` |
| nombre | desplazamiento + longitud | Un único búfer: WTF-8 en Rust (admite UTF-16 mal formado), UTF-16 sin decodificar en Bun |

En Rust ocupa unos **50 bytes por nodo más los nombres**: 107 MiB para 1,47 M nodos, de los que 38,5 MB son nombres.

```mermaid
flowchart LR
    subgraph IDS["ids por niveles (Rust)"]
        direction LR
        r0["0 · raíz C:"] --- r1["1 · Program Files"] --- r2["2 · Users"] --- r3["3 · Windows"] --- r4["4 · Steam"] --- r5["5 · …"]
    end
    r0 -.->|"first_child=1, count=3"| r1
    r1 -.->|"first_child=4, …"| r4
```

La **agregación** es una sola pasada en orden inverso de ids: cada nodo suma lo suyo a su padre. Como el padre siempre tiene un id menor, al llegar a él ya está completo.

## Reglas comunes

| Situación | Regla |
|---|---|
| Enlaces duros | El primer nombre conserva tamaño y asignado. Los demás llevan `HARDLINK` con 0 bytes, de modo que cada carpeta suma exactamente lo de sus hijos. En el recorrido se detectan por el id de archivo de NTFS. |
| Junctions y symlinks | Hojas con `REPARSE`; nunca se siguen, así que no hay bucles ni doble conteo |
| OneDrive y similares | Las carpetas se recorren. Los marcadores sólo en la nube llevan `CLOUD` y **nunca se abren**, porque abrirlos los descargaría. |
| Acceso denegado | La carpeta se omite y se suma a un aviso; el escaneo continúa |
| Raíz | Se llama con su ruta (`C:\`) y `parentId = -1`. `entries` = archivos + carpetas, sin contar la raíz. |
| Metadatos NTFS (`$MFT`, `$LogFile`…) | En modo MFT aparecen en la raíz como ocultos y de sistema, porque ocupan espacio real |
| Papelera | Tras `action("trash")` con éxito, el nodo se quita del árbol y se descuenta de todos sus antepasados |

## Motor MFT

La **Master File Table** de NTFS contiene un registro de 1 KiB (normalmente) por cada archivo y carpeta del volumen. Leerla entera de forma secuencial es mucho más rápido que preguntar a Windows carpeta por carpeta.

```mermaid
flowchart LR
    A["CreateFileW(\\.\C:)<br/>sólo lectura, sin búfer"] --> B["FSCTL_GET_NTFS_VOLUME_DATA<br/>clúster · tamaño de registro · MftValidDataLength"]
    B --> C["Extents de la MFT<br/>FSCTL_GET_RETRIEVAL_POINTERS<br/>o runlist del registro 0"]
    C --> D["Lecturas alineadas de 4 MiB<br/>Rust: 8 lectores en paralelo"]
    D --> E["Fixups<br/>(update sequence array)"]
    E --> F["Atributos:<br/>$STANDARD_INFORMATION<br/>$FILE_NAME · $DATA<br/>$REPARSE_POINT"]
    F --> G["Fusión de registros<br/>de extensión"]
    G --> H["Enlace por referencia<br/>al padre"]
    H --> I["Árbol"]
```

Cada registro pasa por estos pasos:
1. **Fixups.** Los dos últimos bytes de cada sector de 512 B se guardan aparte en el *update sequence array*. Se comprueban y se restauran; si no cuadran, el registro está dañado y se descarta.
2. **En uso.** Los registros libres se saltan.
3. **`$FILE_NAME`.** Puede haber varios. Se ignora el espacio de nombres DOS (8.3) y cada nombre restante aporta un padre. Varios nombres con padres distintos son un enlace duro.
4. **`$DATA` sin nombre.** El tamaño y el asignado salen del atributo residente o no residente. En los comprimidos o dispersos se usa el campo de tamaño comprimido. En los archivos con compresión WOF (CompactOS), el asignado sale del flujo `WofCompressedData`.
5. **Registros de extensión.** Cuando un archivo no cabe en un registro, sus atributos siguen en otros que apuntan a su registro base. Se fusionan con él, aunque aparezcan antes. Sólo cuenta el fragmento de `$DATA` con VCN inicial 0, para no sumar dos veces.

| | Rust | Bun |
|---|---|---|
| Lectura | 8 hilos con su propio handle y búfer alineado; el parseo se hace en el mismo hilo que leyó | Un hilo, secuencial, cediendo el bucle de eventos cada 30 ms |
| C:\ con 1,5 M registros | **1,8 s** | 9,3 s |
| Progreso | `fraction` = bytes de la MFT leídos ÷ total | Igual |

> [!NOTE]
> Es una implementación propia a partir de documentación pública (Linux-NTFS, libyal, MS-FSCC); no deriva de código GPL. El parser se prueba con registros sintéticos: fixups correctos y dañados, nombres DOS, registros borrados, extensiones fuera de orden, enlaces duros, compresión, WOF, junctions y huérfanos.

## Motor de recorrido

Funciona sin administrador y con cualquier sistema de archivos. La clave es usar **`NtQueryDirectoryFile`** en lugar de `FindFirstFile`: una sola llamada devuelve por entrada el tamaño, el asignado, los atributos, la etiqueta de *reparse* y el id de archivo.

```mermaid
flowchart LR
    Q[("Cola de carpetas<br/>pendientes")] --> W1["Hilo 1"] & W2["Hilo 2"] & W3["Hilo …"]
    W1 --> O["NtCreateFile relativo<br/>al handle del padre"]
    O --> L["NtQueryDirectoryFile<br/>búfer de 1 MiB<br/>(64 KiB en red)"]
    L --> E{"Entrada"}
    E -->|carpeta normal| Q
    E -->|"archivo, junction<br/>o marcador en la nube"| T["Hoja del árbol"]
```

| | Rust | Bun |
|---|---|---|
| Paralelismo | Robo de trabajo con rayon: un hilo por núcleo lógico | *Workers* persistentes: la mitad de los núcleos, entre 2 y 8. Nunca se terminan, porque `worker.terminate()` cuelga Bun 1.3 en Windows. |
| Clases de información | `FileIdExtdDirectoryInformation`, con caída a `FileIdFullDirectoryInformation` (38) y `FileFullDirectoryInformation` (2) | La misma cadena |
| Archivos comprimidos al vuelo (`compact /exe`) | El listado da 0 bytes asignados, así que se consulta el asignado real leyendo sólo atributos | — |
| C:\ con 1,47 M elementos | **4,2–5,1 s** (16 hilos) | 4,7–5,8 s (8 workers) |

El coste está en el núcleo de Windows y en los filtros del antivirus: abrir una carpeta cuesta unos 100 µs, cada consulta 25 µs y cerrarla 40 µs. Por eso el paralelismo importa más que el lenguaje.

## Progreso

```mermaid
stateDiagram-v2
    direction LR
    [*] --> starting
    starting --> mft_read: MFT disponible
    starting --> walk: sin MFT
    mft_read --> link
    link --> aggregate
    walk --> aggregate
    aggregate --> done
    starting --> error
    mft_read --> walk: fallo → recorrido
```

Cada evento `ScanProgress` lleva la fase, los elementos, los bytes, el tiempo, un detalle (la ruta actual) y, cuando se conoce, `fraction` entre 0 y 1. Sin `fraction`, la interfaz estima el avance con los bytes leídos frente al espacio usado de la unidad.

## Búsqueda y estadísticas

- La consulta se compila una vez (`compileQuery` en TS, `query.rs` en Rust) a una lista de grupos O de condiciones Y.
- Se recorre el subárbol de `root` manteniendo los `limit` mayores (top-k por tamaño), mientras se cuentan el total y los bytes de **todas** las coincidencias.
- La ruta completa sólo se construye si la consulta usa `path:` o si la fila entra en el resultado.
- 80–140 ms (Rust) y 140–300 ms (Bun) sobre 1,46 M nodos.

Las 21 consultas de la prueba cruzada (`crates/tessera-cli/tests/crosscheck.ts`) dan los mismos totales, bytes, orden y rutas en Rust y en TypeScript.

## Duplicados

`crates/tessera-core/src/dup.rs` y `packages/core-bun/src/dup.ts` siguen el mismo algoritmo sobre el árbol ya cargado, en tres pasadas que leen cada vez menos archivos:

```mermaid
flowchart LR
    A["Archivos bajo root<br/>≥ minSize"] -->|"fuera: enlaces duros,<br/>sólo en la nube, reanálisis"| B["1. Por tamaño<br/>(sin leer)"]
    B -->|"tamaños repetidos"| C["2. Primeros 64 KiB<br/>(hash)"]
    C -->|"≤ 64 KiB: ya es el contenido"| E["Grupos"]
    C -->|"> 64 KiB"| D["3. Contenido completo<br/>(hash de 256 bits)"]
    D --> E
```

| | Rust | Bun |
|---|---|---|
| Hash | BLAKE3 | SHA-256 (`Bun.CryptoHasher`, ≈1 GB/s) |
| Lectura | 4 hilos (rayon) en las pasadas 2 y 3, bloques de 1 MiB, `FILE_FLAG_SEQUENTIAL_SCAN` y `FILE_FLAG_OPEN_NO_RECALL` | Asíncrona: 16 archivos a la vez en la pasada 2 y 2 en la 3, bloques de 1 MiB con lectura anticipada |
| Rutas | UTF-16 exacta del árbol con `\\?\` | Ruta completa con `\\?\` (`\\?\UNC\` en red) |

Reglas comunes:

- **Fuera:** los enlaces duros (son el mismo archivo: borrar uno no libera nada), los archivos sólo en la nube (leerlos los descargaría) y los puntos de reanálisis.
- **Archivos que cambiaron** desde el escaneo (no existen, o su tamaño ya no coincide) quedan fuera y se avisan con `dup.readErrors`.
- **Orden:** grupos por espacio recuperable `(n − 1) × tamaño`, luego tamaño y luego hash; archivos de cada grupo por ruta sin distinguir mayúsculas.
- **Progreso** por pasada (`size`, `prefix`, `full`, `done`) cada ≈100 ms, y cancelación entre archivos y cada MiB leído.
- Mientras dura la búsqueda no se puede escanear (`error.dupBusy`), ni buscar mientras se escanea (`error.scanBusy`). En el escritorio, lo que se manda a la papelera durante una búsqueda va a la Papelera en el acto y sale del árbol al terminar.

Los dos motores dan los mismos grupos, candidatos y bytes leídos. Para comprobarlo en un disco real: `tessera-cli scan <ruta> --dups <bytes> --dups-out dups.json`. Medido sobre la carpeta `target` del repositorio (7,75 GiB, 14.049 archivos, mínimo 1 MiB): 268 candidatos, 241 enlaces duros fuera, 3 grupos y 132 MiB leídos en 1,0 s.

## Historial y comparación

`crates/tessera-core/src/history.rs` y `packages/core-bun/src/history.ts` escriben y leen **los mismos archivos**: un resumen guardado con una edición se compara desde la otra (formato en [el contrato](../ARQUITECTURA.md)).

```mermaid
flowchart LR
    S["Escaneo cargado"] -->|"historySave"| W["Preorden: carpetas +<br/>archivos ≥ 1 MiB"]
    W --> G["&lt;id&gt;.snap.gz<br/>(gzip, JSON)"] --> M["&lt;id&gt;.json<br/>(HistoryEntry)"]
    M -->|"compare"| E["Emparejar por nombre<br/>sin mayúsculas, desde la raíz"]
    E --> P["prev / fresh por nodo<br/>(comparación activa)"]
    P --> R["grew · shrank · removed"]
```

- **id** = fecha UTC del guardado + FNV-1a de 32 bits de la ruta en minúsculas (`20261010T174512Z-1cf80bec`). Se escribe primero el `.snap.gz` y después el `.json`, que es el que «confirma» el resumen. Se conservan los 20 más recientes de cada ruta.
- **Emparejamiento:** raíz con raíz y, bajando, cada nodo del resumen con el hijo actual del mismo nombre (sin distinguir mayúsculas) y mismo tipo. Lo emparejado tiene `prev`; lo que no estaba es `fresh` si es una carpeta, un archivo de 1 MiB o más, o cuelga de algo `fresh`; un archivo pequeño sin pareja queda «desconocido».
- **Lo que explica el cambio:** en `grew` entra un nodo que creció si ningún hijo explica el 75 % o más de su crecimiento; así, una carpeta nueva con un único archivo aparece como el archivo, no como toda la cadena de carpetas padre. `shrank` es simétrico y `removed` lista lo más alto de lo que ya no existe.
- **Comparación activa:** queda en el árbol cargado (Rust, con su propio cerrojo para no esperar a una búsqueda de duplicados; Bun, en `store.cmp`) y todas las filas salen con `prev`/`fresh`; `children` admite `sort: 'delta'`. Un escaneo nuevo la quita.

| | Rust | Bun |
|---|---|---|
| Compresión | gzip, nivel más rápido | `Bun.gzipSync` |
| `C:\Windows` (317 k entradas, ≈114 k nodos guardados) | guardar ≈0,2 s (2,2 MiB) · comparar ≈0,5 s | guardar ≈0,5 s (1,8 MiB) · comparar ≈0,3–0,4 s |

Para comprobar a mano: `tessera-cli scan <ruta> --history-save`, `tessera-cli scan <ruta> --history-compare <id> [--children]` y `tessera-cli history [list | delete <id> | clear]`, con `TESSERA_HISTORY_DIR` para no tocar el historial real.

## Volver a escanear una carpeta

`rescan(id)` (Rust `rescan.rs`, Bun `Store.graft`) recorre una carpeta aparte, sin bloquear el árbol, y al terminar la **injerta**:

```mermaid
flowchart LR
    W["Recorrido de la carpeta<br/>(árbol aparte, cancelable)"] --> G["Injerto"]
    G --> K["La carpeta conserva su id;<br/>sus descendientes quedan muertos"]
    G --> N["Contenido nuevo al final<br/>(cada padre antes que sus hijos)"]
    G --> A["Antepasados: tamaños,<br/>archivos y carpetas por diferencia"]
    G --> C["Cachés de orden y extensiones<br/>invalidadas · comparación fuera"]
```

- Los ids de fuera no cambian; los de dentro, sí (los antiguos dan `error.invalidNode`). Lo muerto no se recupera hasta el siguiente escaneo completo.
- Siempre con el motor de recorrido, aunque el escaneo fuera por MFT: las cifras pueden diferir un poco (la MFT cuenta, por ejemplo, los flujos alternativos).
- Los enlaces duros se detectan sólo dentro de la carpeta: un archivo con otro nombre fuera de ella puede contarse dos veces hasta el siguiente escaneo completo.
- Cancelar antes del injerto deja el árbol exactamente como estaba.

## Actualizar con el diario USN (escritorio)

Con administrador, en un volumen NTFS local, el escaneo guarda la **posición del diario de cambios** de NTFS (al empezar, para no perder lo que cambie mientras dura) y el **FRN** de cada carpeta (de la MFT o del FileId del recorrido). `refresh()` (`usn.rs`):

1. Lee `FSCTL_READ_USN_JOURNAL` desde esa posición; si el diario cambió de id o perdió registros → `refresh.journalReset` (la interfaz hace un escaneo completo).
2. De cada registro toma la carpeta padre y, si es una carpeta, la propia; resuelve los FRN a carpetas del árbol, subiendo por las carpetas nuevas del mismo lote.
3. Se queda con el conjunto mínimo (sin carpetas dentro de otras); si incluye la raíz o pasa de 2000 → escaneo completo.
4. Recorre esas carpetas con un único grupo de hilos y las injerta todas de una vez; sólo entonces guarda la nueva posición del diario.

La lectura real del diario necesita administrador y no se ejecuta en las pruebas automáticas (`usn_refresh_elevated` está marcada `#[ignore]`); el analizador de registros, la resolución de carpetas y el conjunto mínimo sí tienen pruebas con datos sintéticos. La portable responde siempre `refresh.unavailable`.

## Exportar

`exportFile` escribe en `Descargas\TesseraFS` (carpeta conocida de Descargas, o `TESSERA_EXPORT_DIR`): el nombre no puede llevar rutas ni caracteres reservados, y si ya existe se añade « (2)». `revealExport` sólo abre el Explorador para archivos dentro de esa carpeta. Los CSV, JSON, informes HTML y PNG los compone la interfaz; el motor sólo guarda los bytes.

## Slice: el subárbol para el mapa

```mermaid
flowchart LR
    A["Raíz del mapa"] --> B["1. Selección por niveles (BFS)<br/>incluye hijos ≥ minBytes<br/>hasta maxNodes"]
    B --> C["2. Emisión en preorden<br/>hijos por tamaño desc."]
    C --> D["3. Por carpeta: restSize, restCount<br/>(lo no incluido)"]
    D --> E["Cabecera 32 B · extensiones<br/>registros de 64 B · nombres UTF-8"]
```

La selección por niveles gasta el presupuesto primero en lo que más se ve. El resultado es **idéntico byte a byte** en Rust y en TypeScript; la prueba cruzada recodifica el mismo árbol en ambos y compara los 397.575 bytes.

## Memoria

| Motor | Árbol de 1,47 M nodos | Pico durante el escaneo |
|---|---|---|
| Rust | ≈107 MiB | ≈270 MiB |
| Bun | ≈525 MB tras el escaneo | ≈800–900 MB (incluye 25–40 MB por *worker*) |

## Pendiente

- Saltar los registros libres con `$MFT:$BITMAP` (≈40 % menos de E/S).
- Lectura de la MFT con E/S solapada y varios hilos en Bun.
- Actualización en vivo con el diario USN (`FSCTL_READ_USN_JOURNAL`), sin volver a escanear.
- Proceso auxiliar elevado y mínimo, en lugar de relanzar la app completa.
