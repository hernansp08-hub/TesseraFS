# TesseraFS en Linux

La edición de escritorio funciona en Linux con la misma interfaz, el mismo mapa y los mismos filtros que en Windows. Lo que cambia es cómo se lee el disco y qué propone para liberar espacio.

## Descargar e instalar

En cada [release](https://github.com/hernansp08-hub/TesseraFS/releases) hay tres paquetes para Linux x86_64:

| Paquete | Para | Cómo |
|---|---|---|
| `TesseraFS-X.Y.Z-linux-x86_64.AppImage` | Cualquier distribución reciente, sin instalar nada | `chmod +x TesseraFS-*.AppImage` y ábrelo |
| `TesseraFS-X.Y.Z-linux-amd64.deb` | Ubuntu, Debian, Linux Mint, Pop!_OS… | `sudo apt install ./TesseraFS-*-linux-amd64.deb`: aparece en el menú de aplicaciones. Se desinstala con `sudo apt remove tessera-fs` |
| `TesseraFS-X.Y.Z-cli-linux-x64.tar.gz` | Servidores y tareas programadas, sin ventana | `tar xzf TesseraFS-*-cli-linux-x64.tar.gz` y usa `tessera-cli` ([guía](linea-de-comandos.md)) |

Comprueba las descargas con `sha256sum -c SHA256SUMS.txt --ignore-missing`.

**Requisitos:** x86_64 y WebKitGTK 4.1, que traen Ubuntu 22.04 o posterior, Debian 12, Fedora 37, Linux Mint 21, Pop!_OS 22.04, openSUSE Tumbleweed y Arch. El paquete `.deb` lo instala solo; con la AppImage, si tu distribución no lo tiene, instala `libwebkit2gtk-4.1-0` (o el paquete equivalente).

## Qué cambia respecto a Windows

| | Windows | Linux |
|---|---|---|
| Lectura del disco | MFT con administrador (lo más rápido) o recorrido de carpetas | Siempre recorrido de carpetas en paralelo: un Ubuntu con 650.000 elementos, en un cuarto de segundo con la caché del sistema caliente |
| Unidades | Letras (`C:`, `D:`) | Puntos de montaje (`/`, `/home`, `/mnt/datos`…) |
| Otros discos dentro de la carpeta | Las carpetas montadas no se recorren | Igual: aparecen como carpetas vacías y un aviso dice cuáles quedaron fuera, para analizarlos por separado |
| Carpetas sin permiso | Se omiten (con aviso) | Se omiten (con aviso). Para incluirlas: `sudo tessera-cli top /` |
| Actualizar (F5) | Con el diario USN, sólo lo que cambió | Vuelve a escanear la carpeta del mapa |
| Papelera | Papelera de reciclaje | La papelera del escritorio (`~/.local/share/Trash`) |
| Mostrar en… | El Explorador | El gestor de archivos (Archivos, Dolphin, Thunar…) |
| Propiedades, OneDrive | Sí | No |
| Ocultos | Atributo de Windows | Nombre que empieza por punto |
| Enlaces | Enlaces duros contados una vez | Igual; los enlaces simbólicos no se siguen (`attr:reparse` los encuentra) |
| Historial | `%LOCALAPPDATA%\TesseraFS\history` | `~/.local/share/TesseraFS/history` |
| Exportar | `Descargas\TesseraFS` | Tu carpeta de descargas (la de XDG) `/TesseraFS` |

> [!IMPORTANT]
> No abras la aplicación con `sudo`: las aplicaciones gráficas con root pueden dejar archivos de tu usuario con otro dueño. Si necesitas ver carpetas protegidas (`/root`, los datos de Docker…), usa la línea de comandos con `sudo`.

## Liberar espacio en Linux

La pestaña **Liberar espacio** tiene reglas propias de Linux: la caché de tu carpeta personal, los paquetes descargados por APT/DNF/pacman, los registros de journald, Docker y Podman, versiones antiguas de snap, Flatpak, máquinas virtuales, instantáneas de Timeshift y la papelera, además de las de desarrollo (`target`, `node_modules`, `.venv`). Detalles en [Liberar espacio](liberar-espacio.md#en-linux).

Muchas órdenes de limpieza del sistema empiezan por `sudo` (por ejemplo `sudo apt clean`): la tarjeta te la deja copiada, pero la ejecutas tú en una terminal.

## Problemas frecuentes

| Problema | Solución |
|---|---|
| La ventana sale en blanco o parpadea (sobre todo con NVIDIA o Wayland) | La app ya arranca con `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Si sigue en blanco, ábrela con `WEBKIT_DISABLE_COMPOSITING_MODE=1` delante |
| La AppImage no arranca y habla de FUSE | Instala `libfuse2` (en Ubuntu 24.04, `libfuse2t64`) o ejecútala con `--appimage-extract-and-run` |
| `/home` aparece vacío al escanear `/` | Está en otro sistema de archivos: elígelo en la lista de unidades |
| En WSL, `/mnt/c` va muy lento | Las unidades de Windows llegan a WSL por red interna: analízalas con la edición de Windows |
| Docker aparece casi vacío | `/var/lib/docker` sólo lo puede leer root: `sudo tessera-cli top /var/lib/docker` |
| Textos muy pequeños en pantallas de alta densidad | Ábrela con `GDK_SCALE=2` |
