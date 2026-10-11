# Cambios

Todas las versiones de TesseraFS. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/). Las entradas se generan con `bun run release` a partir de los mensajes de commit (ver [docs/VERSIONES.md](docs/VERSIONES.md)).

## [Sin publicar]

## [0.9.0] - 2026-10-11

### Linux
- **Edición de escritorio para Linux:** AppImage, paquete `.deb` y `tessera-cli` para x86_64, con la misma interfaz, mapa, filtros, duplicados, historial y exportación que en Windows.
- Motor de recorrido para Linux: en paralelo, sin seguir enlaces simbólicos, contando una vez los enlaces duros y sin cruzar a otros sistemas de archivos montados (avisa de cuáles quedaron fuera).
- Unidades como puntos de montaje, papelera del escritorio, «Mostrar en el gestor de archivos» y textos adaptados al sistema en los cinco idiomas.
- «Liberar espacio» con reglas de Linux: `~/.cache`, paquetes de APT/DNF/pacman/zypper, journald, volcados de fallos, Docker y Podman, Flatpak, versiones de snap, máquinas virtuales, Timeshift, papelera y archivo de intercambio; y «¿Qué es esto?» para las carpetas del sistema.
- La demo simula un Ubuntu con `#os=linux`.
- Guía nueva: docs/usuario/linux.md.

### Añadido
- **linux:** edición de escritorio para Linux (AppImage, .deb y línea de comandos)

## [0.8.1] - 2026-10-11

### Corregido
- **cloud:** Liberar espacio de OneDrive sólo con Archivos a petición

## [0.8.0] - 2026-10-10

### Nube y compresión
- **Liberar espacio de OneDrive sin borrar nada:** tarjeta en Liberar espacio, botón en el panel de detalle y en el menú del clic derecho. Deja los archivos descargados sólo en línea, como el Explorador.
- La tarjeta de cada juego propone comprimirlo con `compact /exe:lzx` si aún no está comprimido.
- El panel de detalle distingue los archivos de la nube descargados de los que están sólo en línea, y muestra cuánto ahorra la compresión.
- Filtro `attr:` (`atrib:`) por atributos: nube, oculto, sistema, comprimido, enlace duro, disperso y punto de reanálisis.

### Añadido
- **cloud:** liberar espacio de OneDrive sin borrar, compresión y filtro attr:

### Corregido
- **tests:** las pruebas de rescan aceptan ejecutarse con administrador

## [0.7.0] - 2026-10-10

### Línea de comandos
- `tessera-cli top`: los archivos y carpetas más grandes en tabla, CSV o JSON.
- `tessera-cli check --min-free 10%`: aviso de poco espacio con código de salida para tareas programadas.
- `tessera-cli.exe` va ahora en el zip de la edición de escritorio, con su guía en docs/usuario/linea-de-comandos.md.

### Añadido
- **rescan:** volver a escanear una carpeta, actualizar con el diario USN y línea de comandos completa

## [0.6.0] - 2026-10-10

### Añadido
- **history:** historial de escaneos, comparación y exportación

## [0.5.0] - 2026-10-10

### Añadido
- **dups:** búsqueda de archivos duplicados en los dos motores y pestaña Duplicados

## [0.4.0] - 2026-10-10

### Añadido
- **ui:** «¿Qué es esto?» en el panel de detalle y siete reglas de limpieza nuevas
- **ui:** cesta «Para borrar» con selección múltiple y envío por lotes a la papelera
- **ui:** cancelar el escaneo y pantalla de unidades al inicio

### Corregido
- **build:** la comprobación de firma de bun.exe funciona en GitHub Actions

## [0.3.0] - 2026-10-10

### Distribución
- Un único `README.txt` en los cinco idiomas dentro de cada zip, en lugar de `LEEME.txt`.

### Documentación
- Diseño de la internacionalización ([docs/tecnica/i18n.md](docs/tecnica/i18n.md)): catálogos, mensajes de los motores, formatos por idioma, pseudolocalización, flujo para traductores y cómo añadir un idioma.

### Corregido
- **core-bun:** una ruta inexistente o que no es una carpeta ya no descarta el escaneo anterior.
- **core:** en una unidad FAT32 o de red, el aviso dice que la MFT no está disponible ahí, en lugar de pedir administrador.

### Añadido
- **i18n:** interfaz en English, Español, Português (Brasil), Français y Deutsch
- **core:** avisos, errores y acciones con código traducible

## [0.2.0] - 2026-10-08

### Documentación
- Guía de usuario, filtros, liberar espacio y preguntas frecuentes.
- Documentación técnica (arquitectura, motores, interfaz y desarrollo) con 24 diagramas y capturas con datos de ejemplo.

### Distribución
- Versiones empaquetadas en zip en GitHub Releases, una por edición, con LEEME, licencias, avisos de terceros y sumas SHA-256 (`bun run package --publish`).

### Añadido
- **ui:** enlaces directos a vistas con #archivos, #limpieza, #extension, #antiguedad, #relieve y #guia

### Corregido
- **ui:** el porcentaje de la tarjeta de progreso no salta de línea al llegar a 100 %

## [0.1.1] - 2026-10-08

- Mantenimiento.

## [0.1.0] - 2026-10-07

Primera versión funcional.

### Añadido
- Motor en Rust (`tessera-core`): lectura directa de la MFT con administrador y recorrido paralelo de carpetas sin él, árbol compacto, búsqueda, porciones binarias para el mapa y acciones de archivo (abrir, mostrar en el Explorador, propiedades, papelera).
- Edición de escritorio con Tauri 2 (`tesserafs-desktop.exe`, 10,8 MB, sin dependencias de VC++).
- Motor en Bun (`core-bun`) y edición portable: `bun.exe` firmado + `tesserafs.js` + ventana de Edge en modo aplicación, sin ningún ejecutable sin firmar.
- Interfaz compartida: mapa de teselas con cabeceras de carpeta (estilos Mosaico y Relieve), color por categoría, extensión o antigüedad, árbol enlazado, lista de archivos, filtros con sintaxis propia y pestaña Liberar espacio con riesgos explicados.
- Tarjeta de progreso con avance real, divisores redimensionables, sangría adaptativa y recorte de nombres por el medio.
- Herramienta de línea de comandos `tessera-cli` con comparación MFT/recorrido.
- Fuentes incrustadas: la interfaz no hace ninguna petición a internet.

### Rendimiento (C:\ con 1,5 M elementos)
- Escritorio, MFT con administrador: 1,8 s.
- Escritorio, recorrido sin administrador: 4,2–5,1 s.
- Portable, recorrido sin administrador: 4,7–5,8 s; MFT: 9,3 s.

[Sin publicar]: ../../compare/v0.9.0...HEAD
[0.9.0]: ../../compare/v0.8.1...v0.9.0
[0.8.1]: ../../compare/v0.8.0...v0.8.1
[0.8.0]: ../../compare/v0.7.0...v0.8.0
[0.7.0]: ../../compare/v0.6.0...v0.7.0
[0.6.0]: ../../compare/v0.5.0...v0.6.0
[0.5.0]: ../../compare/v0.4.0...v0.5.0
[0.4.0]: ../../compare/v0.3.0...v0.4.0
[0.3.0]: ../../compare/v0.2.0...v0.3.0
[0.2.0]: ../../compare/v0.1.1...v0.2.0
[0.1.1]: ../../compare/v0.1.0...v0.1.1
[0.1.0]: ../../releases/tag/v0.1.0
