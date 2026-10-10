# Versiones y commits

## Número de versión: SemVer, uno para todo el producto

`MAYOR.MENOR.PARCHE`, por ejemplo `0.3.2`. Las dos ediciones, la interfaz, los motores y la CLI comparten **un único número**, porque se publican juntas y deben entenderse entre sí. Ese número vive en `package.json` (raíz y paquetes), `Cargo.toml` (`[workspace.package]`) y `tauri.conf.json`. Nunca se edita a mano: lo cambia `bun run release`. La interfaz lo muestra en la barra de estado (`· v0.1.0`), lo que ayuda con los informes de errores.

| Sube | Cuándo | Ejemplo |
|---|---|---|
| PARCHE | Correcciones sin cambios visibles de comportamiento | 0.1.0 → 0.1.1 |
| MENOR | Funciones nuevas | 0.1.1 → 0.2.0 |
| MAYOR | Cambios incompatibles (formato de escaneos guardados, CLI, contrato) | 1.4.0 → 2.0.0 |

Mientras la versión empiece por `0.`, el proyecto se considera en desarrollo: los cambios incompatibles suben la MENOR. La **1.0.0** llega cuando se cumpla esto:
- el modo MFT está probado en varios equipos;
- el ejecutable está firmado y tiene instalador;
- el contrato entre interfaz y motores no va a cambiar a menudo.

Para probar antes de publicar se usan prerreleases: `0.2.0-beta.1`, `0.2.0-beta.2`… y luego `0.2.0`.

El formato binario "slice" lleva su propio número (`version = 1` en la cabecera, ver [ARQUITECTURA.md](ARQUITECTURA.md)). Sólo sube si cambia ese formato.

## Mensajes de commit: Conventional Commits

```
tipo(ámbito opcional): descripción en imperativo
```

| Tipo | Para | Entra en el CHANGELOG como |
|---|---|---|
| `feat` | Función nueva | Añadido |
| `fix` | Corrección | Corregido |
| `perf` | Mejora de rendimiento | Rendimiento |
| `refactor` | Cambio interno sin efecto visible | Cambiado |
| `docs`, `test`, `build`, `ci`, `chore` | Lo demás | No aparece |

Un `!` tras el tipo (`feat(protocol)!: …`) o la línea `BREAKING CHANGE:` en el cuerpo marcan un cambio incompatible.

Ámbitos habituales: `ui`, `core` (Rust), `core-bun`, `portable`, `desktop`, `cli`, `protocol`.

Ejemplos:
- `feat(ui): divisores para redimensionar los paneles`
- `fix(core-bun): no contar dos veces los enlaces duros`
- `perf(core-bun): leer la MFT con varios hilos`

## Ramas

Desarrollo en **tronco**:
- `main` siempre compila y pasa las pruebas;
- cada cambio va en una rama corta (`feat/cancelar-escaneo`, `fix/rutas-largas`) que se integra en `main`;
- las versiones son etiquetas `vX.Y.Z` sobre `main`. Una corrección urgente para una versión antigua sale de su etiqueta en una rama `release/0.3`.

## Publicar una versión

Publicar es **crear la etiqueta y subirla**. GitHub Actions hace el resto: compila, prueba, empaqueta y crea la *release* con los zips.

```bash
bun run release auto --dry
```
Muestra la versión siguiente y la entrada del CHANGELOG sin tocar nada.

```bash
bun run release auto
```
Sube el número en todos los manifiestos, escribe el CHANGELOG, hace el commit `chore(release): vX.Y.Z` y crea la etiqueta.

```bash
git push --follow-tags
```
Sube el commit y la etiqueta: esto **lanza la publicación automática**.

Otras formas de `release`: `patch`, `minor`, `major`, `minor --pre=beta` (→ `0.2.0-beta.1`), `pre` (→ `beta.2`), `final` (quita el sufijo) o un número exacto.

### Qué hace GitHub Actions

```mermaid
flowchart LR
    R["bun run release auto<br/>commit + etiqueta vX.Y.Z"] --> P["git push --follow-tags"]
    P --> A{{"GitHub Actions<br/>.github/workflows/release.yml<br/>windows-latest"}}
    A --> C["¿Etiqueta = versión<br/>de package.json?"]
    C --> T["bun test<br/>cargo test"]
    T --> B["bun run package --publish<br/>interfaz · exe · portable"]
    B --> G["Release vX.Y.Z<br/>zips + SHA256SUMS + notas"]
```

| Paso | Detalle |
|---|---|
| Comprobación | La etiqueta (`v0.3.0`) debe coincidir con la versión de `package.json`; si no, el flujo se detiene |
| Herramientas | Bun **1.3.14** fijado en el flujo (es el `bun.exe` que viaja en la portable) y Rust estable, con caché de compilación |
| Pruebas | `bun test` y `cargo test --workspace --release`. Si fallan, **no se publica nada** |
| Publicación | `bun run package --publish`. Si la release ya existe, reemplaza sus archivos y notas, así que el flujo se puede relanzar |
| Duración y coste | Unos 15–25 min con caché. En un repositorio privado consume minutos de Actions (los de Windows cuentan doble) |

Sigue el progreso en la pestaña **Actions** del repositorio o con `gh run watch`.

**Probar sin publicar:** en *Actions › Publicar versión › Run workflow* (o `gh workflow run release.yml`), el flujo compila y empaqueta la rama elegida. Los zips quedan como artefacto del flujo durante 7 días, sin crear ninguna release.

### Qué se publica

| Archivo | Contenido |
|---|---|
| `TesseraFS-X.Y.Z-escritorio-win-x64.zip` | `tesserafs-desktop.exe`, `tessera-cli.exe` ([línea de comandos](usuario/linea-de-comandos.md)), `README.txt` (en los cinco idiomas), `LICENCIAS-TERCEROS.txt` (crates de Rust incluidos) y `licencias/` |
| `TesseraFS-X.Y.Z-portable-win-x64.zip` | `bun.exe` (firmado, sin modificar), `tesserafs.js`, lanzadores, `README.txt` (en los cinco idiomas), avisos de Bun y `licencias/` |
| `SHA256SUMS.txt` | Sumas para comprobar las descargas (`Get-FileHash archivo.zip`) |

Las versiones con sufijo (`-beta.1`) se publican como *prerelease*.

### Publicar desde tu equipo (alternativa)

Si GitHub Actions no está disponible, el mismo script funciona en local con `gh` autenticado:

```bash
bun run package --publish
```

Sin `--publish` sólo deja los archivos en `dist/release/vX.Y.Z/` para revisarlos; `--skip-build` reutiliza lo ya compilado.

### Pendiente: firma de código

Cuando haya certificado (SignPath Foundation para proyectos open source, o Azure Artifact Signing), se añadirá al flujo un paso que firme `tesserafs-desktop.exe` antes de empaquetarlo. Así desaparece el aviso de SmartScreen y los antivirus confían más en el ejecutable.
