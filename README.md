# TesseraFS

Analizador de espacio en disco para Windows. Dibuja la unidad como un mosaico: cada tesela es un archivo y su área es su tamaño. Las carpetas agrupan sus teselas bajo una cabecera y el árbol de la izquierda ubica cualquier tesela con un clic.

- **Rápido:** con permisos de administrador en NTFS lee la tabla maestra de archivos (MFT) directamente; sin ellos, recorre las carpetas en paralelo.
- **Explica antes de borrar:** la pestaña *Liberar espacio* clasifica cada candidato en Seguro, Revisar o No borrar a mano, con la orden o el ajuste de Windows adecuados.
- **Local:** nada sale del equipo.

## Ediciones

| Edición | Motor | Ventana | Qué se distribuye |
|---|---|---|---|
| Escritorio (`apps/desktop`) | Rust (`crates/tessera-core`) | Tauri 2 + WebView2 | `TesseraFS.exe` |
| Portable (`apps/portable`) | Bun (`packages/core-bun`) | Microsoft Edge en modo aplicación | `bun.exe` + `tesserafs.js` + lanzador |
| Demo (`packages/ui`) | Datos de ejemplo | Navegador | `packages/ui/dist/index.html` |

La edición portable no contiene ningún ejecutable propio: sólo el `bun.exe` firmado por su editor y Edge, que ya viene con Windows. Pensada para equipos donde el antivirus bloquea ejecutables sin firma.

## Desarrollo

```bash
bun run ui:build          # interfaz → packages/ui/dist/index.html (ábrelo en el navegador: modo demo)
bun run portable:dev      # edición portable desde el código
bun run portable:pack     # carpeta portable en apps/portable/dist
bun run desktop:dev       # edición de escritorio (Tauri)
bun test                  # pruebas de TypeScript
cargo test                # pruebas del motor Rust
```

Arquitectura y contrato entre interfaz y motores: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Versiones, commits y publicación: [docs/VERSIONES.md](docs/VERSIONES.md). Historial: [CHANGELOG.md](CHANGELOG.md).

## Licencia

A tu elección, [MIT](LICENSE-MIT) o [Apache-2.0](LICENSE-APACHE). Las fuentes incrustadas (Bricolage Grotesque e IBM Plex) se distribuyen bajo la SIL Open Font License 1.1: ver `packages/ui/fonts/licencias/`.
