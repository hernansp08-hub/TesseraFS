<div align="center">

# TesseraFS

**Mira tu disco como un mosaico. Encuentra lo que ocupa en segundos.**

Analizador de espacio en disco para Windows, de código abierto, rápido y local.

![TesseraFS: mapa de teselas, árbol de carpetas y panel de detalle](docs/img/principal.png)

<sub>Captura de la edición demo con datos de ejemplo.</sub>

</div>

## Qué hace

- **Mapa de teselas:** cada archivo es una tesela con área proporcional a su tamaño, agrupada bajo la cabecera de su carpeta. Lo grande salta a la vista.
- **Todo enlazado:** un clic en el mapa ubica el archivo en el árbol y el árbol marca su tesela. El panel de detalle muestra ruta, tamaño, espacio en disco y acciones.
- **Rápido de verdad:** lee la tabla maestra de archivos de NTFS. **1,5 millones de elementos en 1,8 s** con permisos de administrador, y 4–5 s sin ellos.
- **Tres formas de colorear:** por categoría (vídeo, juegos, compilación…), por extensión o por antigüedad, para encontrar lo que lleva años sin tocarse.
- **Filtros potentes:** `ext:gguf size:>1g`, `age:>2y size:>500m`, `path:Downloads ext:msi,exe`…
- **Liberar espacio con criterio:** propone candidatos como Seguro, Revisar o No borrar a mano, con la orden o el ajuste correcto para cada uno.
- **Privado y prudente:** nada sale de tu equipo; sólo lee el disco; borra únicamente a la Papelera y siempre con confirmación.

<table>
<tr>
<td><img src="docs/img/limpieza.png" alt="Liberar espacio"/><br/><sub><b>Liberar espacio</b>: candidatos con su nivel de riesgo</sub></td>
<td><img src="docs/img/antiguedad.png" alt="Color por antigüedad"/><br/><sub><b>Antigüedad</b>: de reciente (ámbar) a olvidado (índigo)</sub></td>
</tr>
<tr>
<td><img src="docs/img/relieve-extension.png" alt="Estilo relieve"/><br/><sub><b>Relieve</b> con color por extensión</sub></td>
<td><img src="docs/img/escaneo.png" alt="Escaneo en curso"/><br/><sub><b>Escaneo</b> con progreso real</sub></td>
</tr>
</table>

## Ediciones

| | Escritorio | Portable |
|---|---|---|
| Qué es | `tesserafs-desktop.exe` (≈11 MB) | Carpeta con `bun.exe` + `tesserafs.js` + lanzador |
| Motor | Rust | TypeScript sobre Bun |
| Ventana | Tauri 2 + WebView2 | Microsoft Edge en modo aplicación |
| C:\ con 1,5 M elementos | **1,8 s** con admin · 4–5 s sin admin | 9 s con admin · 5–6 s sin admin |
| Para | Tu equipo | Empresas donde el antivirus bloquea ejecutables sin firma: **no lleva ningún binario propio** |

Las dos comparten la misma interfaz y dan los mismos resultados.

## Empezar

**Usar:** descarga el zip de la edición que prefieras desde **[Releases](../../releases/latest)**, desbloquéalo (Propiedades › Desbloquear), descomprímelo y ábrelo; no hay instalación. Todo se explica en la **[Guía de usuario](docs/usuario/guia.md#descargar)**.

**Compilar** (Windows 10/11, [Bun](https://bun.sh) ≥ 1.3, [Rust](https://rustup.rs) estable):

```bash
bun install
```
```bash
bun run ui:build
```
```bash
bun run portable:dev
```
```bash
bun run desktop:dev
```

Sin compilar nada, `packages/ui/dist/index.html` abierto en el navegador es una demo con datos de ejemplo.

## Documentación

| Para usuarios | Para desarrolladores |
|---|---|
| [Guía de usuario](docs/usuario/guia.md) | [Arquitectura](docs/tecnica/arquitectura.md) |
| [Filtros](docs/usuario/filtros.md) | [Motores de escaneo](docs/tecnica/motores.md) |
| [Liberar espacio](docs/usuario/liberar-espacio.md) | [Interfaz y renderizado](docs/tecnica/interfaz.md) |
| [Preguntas frecuentes](docs/usuario/preguntas-frecuentes.md) | [Contrato interfaz ↔ motor](docs/ARQUITECTURA.md) |
| | [Guía de desarrollo](docs/tecnica/desarrollo.md) |
| | [Versiones y commits](docs/VERSIONES.md) · [Cambios](CHANGELOG.md) |

## Cómo funciona, en una imagen

```mermaid
flowchart LR
    UI["Interfaz<br/>TypeScript + Canvas"] -->|contrato común| D["Escritorio<br/>Tauri + Rust"]
    UI -->|contrato común| P["Portable<br/>Bun + Edge"]
    D --> W[("NTFS / Win32<br/>MFT · NtQueryDirectoryFile")]
    P --> W
```

El árbol completo (millones de nodos) vive en el motor. La interfaz sólo pide lo que va a mostrar: una porción binaria para el mapa, páginas de hijos para el árbol y búsquedas ya filtradas. Detalles en [Arquitectura](docs/tecnica/arquitectura.md).

## Licencia

A tu elección, [MIT](LICENSE-MIT) o [Apache-2.0](LICENSE-APACHE). Las fuentes incrustadas (Bricolage Grotesque e IBM Plex) se distribuyen bajo la SIL Open Font License 1.1: ver `packages/ui/fonts/licencias/`.
