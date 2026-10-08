# Preguntas frecuentes y solución de problemas

## Resultados

### ¿Por qué el total no coincide con el que muestra el Explorador?

Hay varias razones, y todas son correctas:

| Causa | Efecto |
|---|---|
| **Tamaño frente a espacio en disco** | Un archivo comprimido o disperso ocupa menos en disco que su tamaño. Un archivo de 1 byte ocupa un clúster entero (4 KB). Mira las columnas **Tamaño** y **En disco**. |
| **Enlaces duros** | Un mismo archivo puede aparecer en varias carpetas (`WinSxS` y `System32` comparten miles). TesseraFS lo cuenta **una sola vez**: el primer nombre lleva el tamaño y los demás aparecen en cursiva con 0 bytes. |
| **Carpetas sin permiso** | En modo normal, las carpetas que Windows no te deja abrir (como `C:\Program Files\WindowsApps`) no se cuentan. El modo rápido sí las ve. |
| **Archivos en la nube** | Los archivos de OneDrive que sólo están en la nube muestran su tamaño, pero apenas ocupan espacio local |
| **Archivos del sistema NTFS** | En modo rápido aparecen en la raíz `$MFT`, `$LogFile` y similares, porque ocupan espacio real |
| **Espacio reservado** | Windows reserva varios GB para actualizaciones. Cuentan como «usado» en la unidad, pero no son archivos. |

### ¿Por qué el modo rápido encuentra más elementos que el normal?

Porque lee la tabla maestra de archivos completa e incluye carpetas protegidas a las que tu usuario no tiene acceso. En un equipo típico la diferencia ronda el 5 %.

### ¿Qué es la tesela gris rayada?

Son los elementos de una carpeta demasiado pequeños para dibujarse uno a uno, agrupados. Pasa el puntero para ver cuántos son y cuánto suman; haz doble clic para entrar en la carpeta y verlos.

### ¿Por qué un archivo aparece en cursiva con 0 bytes?

Es un enlace duro: el mismo archivo ya está contado en otra carpeta. Borrarlo de ese sitio no libera espacio mientras exista el otro nombre.

## Permisos y velocidad

### ¿Por qué pide permisos de administrador el modo rápido? ¿Es seguro?

Windows sólo deja leer el disco directamente (`\\.\C:`) a los administradores. TesseraFS abre el volumen **en modo sólo lectura** para leer la MFT; nunca escribe en él.

### ¿Puedo usarlo sin permisos de administrador?

Sí. Es el modo normal: recorre las carpetas con varios hilos y en un disco NVMe tarda de 4 a 6 segundos con 1,5 millones de elementos. Sólo pierdes las carpetas protegidas.

### La primera vez tardó mucho más

Tras reiniciar, Windows aún no tiene la información de las carpetas en memoria y el primer recorrido lee más del disco. El segundo escaneo suele ser varias veces más rápido. También influyen otros programas que lean el disco a la vez: antivirus, instaladores, indexadores u otros analizadores.

### ¿Funciona con discos externos, FAT32, exFAT o unidades de red?

Sí, con el modo normal. El modo rápido sólo funciona en volúmenes **NTFS locales**.

## Antivirus y arranque

### El antivirus o SmartScreen bloquea `tesserafs-desktop.exe`

El ejecutable de escritorio todavía no está firmado digitalmente, y los antivirus desconfían de los ejecutables nuevos sin firma. Tienes tres opciones:
1. En SmartScreen, pulsa **Más información › Ejecutar de todas formas**.
2. Pide a tu departamento de TI que lo autorice.
3. Usa la **edición portable**, que sólo ejecuta programas firmados (`bun.exe` y Edge).

### La edición portable no abre ninguna ventana

1. Comprueba que Microsoft Edge esté instalado.
2. Abre una terminal en la carpeta y ejecuta:
   ```bat
   bun.exe tesserafs.js --debug
   ```
   La consola quedará visible con los mensajes. Si Edge no arranca, la app intenta abrir tu navegador predeterminado.
3. Algunas políticas de empresa bloquean los scripts `.vbs`: usa `TesseraFS.cmd`.

### Al pulsar «Modo rápido» no pasa nada

Debe aparecer el aviso de Control de cuentas de usuario de Windows. Si tu cuenta no es de administrador, Windows te pedirá la contraseña de una que lo sea. Si lo cancelas, la app sigue en modo normal. Al aceptarlo se abre una ventana nueva con permisos y la anterior se cierra.

## Datos y configuración

### ¿TesseraFS envía datos a internet?

No. La interfaz no hace ninguna petición externa (hasta las fuentes van incluidas). La edición portable usa un servidor que sólo escucha en tu propio equipo (`127.0.0.1`) y exige un código secreto en cada petición.

### ¿Dónde guarda la configuración?

Sólo guarda preferencias de interfaz: tema y tamaño de los paneles.

| Edición | Carpeta |
|---|---|
| Escritorio | `%LOCALAPPDATA%\dev.tesserafs.app` |
| Portable | `%LOCALAPPDATA%\TesseraFS\edge-profile` |

### ¿Cómo lo desinstalo?

Borra el ejecutable o la carpeta portable y, si quieres, la carpeta de configuración de la tabla anterior. No toca el registro ni instala servicios.

### ¿Puedo borrar archivos desde TesseraFS?

Sí, pero sólo a la **Papelera de reciclaje** y siempre con confirmación en el panel de detalle. Desde la Papelera puedes restaurarlos.
