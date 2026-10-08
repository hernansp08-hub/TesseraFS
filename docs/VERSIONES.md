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

```bash
bun run release auto --dry   # muestra la versión y la entrada del CHANGELOG sin tocar nada
bun run release auto         # sube la versión, escribe el CHANGELOG, hace commit y etiqueta
git push --follow-tags       # publica (cuando haya repositorio remoto)
```

Otras formas: `patch`, `minor`, `major`, `minor --pre=beta` (→ `0.2.0-beta.1`), `pre` (→ `beta.2`), `final` (quita el sufijo) o un número exacto.

Antes de publicar, comprueba que todo esté en verde:
```bash
bun test && cargo test --workspace
```

Más adelante, un flujo de GitHub Actions podrá reaccionar a cada etiqueta `v*`: compilará el exe de escritorio y la carpeta portable, los firmará y creará la *release* con las notas del CHANGELOG.
