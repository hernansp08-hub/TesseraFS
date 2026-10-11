//! Catálogo de mensajes de los motores: cada función crea el [`EngineMessage`] de un código
//! de docs/tecnica/i18n.md («Mensajes de los motores») con sus parámetros y el texto de
//! reserva en inglés. La interfaz traduce `engine.<code>`; los detalles técnicos internos
//! viajan en inglés dentro del parámetro `error`.

use crate::types::EngineMessage;

fn plural(n: u64, one: &str, other: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { other })
}

/// Tamaño legible para los textos de reserva y el aviso del escaneo programado (KB = 1024 bytes, como el
/// Explorador; un decimal: «12.3 GB»).
pub(crate) fn human_bytes(b: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    let (mut v, mut i) = (b as f64, 0);
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { plural(b, "byte", "bytes") } else { format!("{v:.1} {}", UNITS[i]) }
}

/// Añade al texto de reserva (sólo registros y CLI) hasta 5 ejemplos, uno por línea.
fn with_samples(mut message: String, samples: &[String]) -> String {
    for s in samples.iter().take(5) {
        message.push_str("\n  ");
        message.push_str(s);
    }
    message
}

/// Parámetro `sample` del contrato (igual que el motor Bun): hasta 3 rutas separadas por comas.
fn sample_param(m: EngineMessage, samples: &[String]) -> EngineMessage {
    if samples.is_empty() { return m; }
    m.param("sample", samples.iter().take(3).cloned().collect::<Vec<_>>().join(", "))
}

// ---- Avisos del escaneo (ScanResult.warnings) ----

pub fn mft_needs_admin() -> EngineMessage {
    EngineMessage::new("scan.mftNeedsAdmin", "MFT unavailable without administrator rights: walked the folders instead")
}

pub fn mft_unsupported_fs(fs: &str) -> EngineMessage {
    EngineMessage::new("scan.mftUnsupportedFs", format!("The MFT can only be read on local NTFS volumes ({fs}): walked the folders instead"))
        .param("fs", fs)
}

pub fn mft_network_path() -> EngineMessage {
    EngineMessage::new("scan.mftNetworkPath", "The MFT cannot be read on network paths: walked the folders instead")
}

pub fn mft_failed(error: &str) -> EngineMessage {
    EngineMessage::new("scan.mftFailed", format!("Could not use the MFT ({error}): walked the folders instead")).param("error", error)
}

pub fn mft_orphans(count: u64) -> EngineMessage {
    let (n, are) = (plural(count, "entry", "entries"), if count == 1 { "is" } else { "are" });
    EngineMessage::new("scan.mftOrphans", format!("{n} without a valid parent folder (the disk changed during the scan) {are} not shown"))
        .param("count", count)
}

pub fn access_denied(count: u64, samples: &[String]) -> EngineMessage {
    let (n, its) = (plural(count, "folder", "folders"), if count == 1 { "its" } else { "their" });
    let m = format!("{n} could not be read (access denied); {its} contents are not counted");
    sample_param(EngineMessage::new("scan.accessDenied", with_samples(m, samples)).param("count", count), samples)
}

pub fn read_errors(count: u64, samples: &[String]) -> EngineMessage {
    let (n, its) = (plural(count, "folder", "folders"), if count == 1 { "its" } else { "their" });
    let m = format!("{n} could not be read; {its} contents are not counted");
    sample_param(EngineMessage::new("scan.readErrors", with_samples(m, samples)).param("count", count), samples)
}

/// Linux: sistemas de archivos montados dentro de la carpeta escaneada que no se recorrieron (sin contar
/// los pseudo-sistemas como proc o tmpfs). `paths`: hasta 5 rutas separadas por ", ".
pub fn other_mounts(count: u64, paths: &[String]) -> EngineMessage {
    let list = paths.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
    let (n, were, them) = if count == 1 {
        ("1 mounted file system".to_string(), "was", "it")
    } else {
        (format!("{count} mounted file systems"), "were", "them")
    };
    EngineMessage::new("scan.otherMounts", format!("{n} {were} not included (analyze {them} separately): {list}"))
        .param("count", count)
        .param("paths", list)
}

// ---- Avisos de la búsqueda de duplicados (DupResult.warnings) ----

pub fn dup_read_errors(count: u64) -> EngineMessage {
    let (n, were) = (plural(count, "file", "files"), if count == 1 { "was" } else { "were" });
    EngineMessage::new("dup.readErrors", format!("{n} couldn't be read and {were} left out")).param("count", count)
}

// ---- Errores de las operaciones (Tauri: Err(EngineMessage)) ----

pub fn invalid_path(path: &str) -> EngineMessage {
    EngineMessage::new("error.invalidPath", format!("Invalid path: \"{path}\"")).param("path", path)
}

pub fn not_folder(path: &str) -> EngineMessage {
    EngineMessage::new("error.notFolder", format!("Not a folder: {path}")).param("path", path)
}

/// `error`: texto del sistema (FormatMessage, ya localizado por Windows).
pub fn cannot_open(path: &str, error: &str) -> EngineMessage {
    EngineMessage::new("error.cannotOpen", format!("Could not open {path}: {error}")).param("path", path).param("error", error)
}

pub fn scan_busy() -> EngineMessage {
    EngineMessage::new("error.scanBusy", "A scan is already running")
}

/// También rechaza un escaneo nuevo mientras dura la búsqueda.
pub fn dup_busy() -> EngineMessage {
    EngineMessage::new("error.dupBusy", "A duplicate search is already in progress")
}

pub fn no_scan() -> EngineMessage {
    EngineMessage::new("error.noScan", "No scan has been loaded yet")
}

pub fn invalid_node(id: u32) -> EngineMessage {
    EngineMessage::new("error.invalidNode", format!("Invalid node id: {id}")).param("id", id)
}

pub fn cancelled() -> EngineMessage {
    EngineMessage::new("error.cancelled", "Scan cancelled")
}

/// También las acciones que la plataforma no tiene (en Linux, `properties` y `freeUp`).
pub fn unsupported_platform() -> EngineMessage {
    EngineMessage::new("error.unsupportedPlatform", "Only available on Windows")
}

/// Cualquier otro fallo; `error` es un texto técnico en inglés o del sistema.
pub fn internal(error: &str) -> EngineMessage {
    EngineMessage::new("error.internal", format!("Internal error: {error}")).param("error", error)
}

// ---- Resultados de las acciones (ActionResult) ----

pub fn trashed() -> EngineMessage {
    EngineMessage::new("action.trashed", "Moved to the Recycle Bin")
}

/// `count`: archivos de la nube que pasaron a «sólo en línea»; `bytes`: su espacio asignado, que
/// el proveedor (OneDrive) libera poco después.
pub fn freed_up(count: u64, bytes: u64) -> EngineMessage {
    let n = plural(count, "file", "files");
    EngineMessage::new("action.freedUp", format!("{n} set to online-only; {} will be freed shortly", human_bytes(bytes)))
        .param("count", count)
        .param("bytes", bytes)
}

pub fn nothing_to_free() -> EngineMessage {
    EngineMessage::new("action.nothingToFree", "There are no downloaded cloud files here to free up")
}

pub fn trash_root() -> EngineMessage {
    EngineMessage::new("action.trashRoot", "The scan root cannot be sent to the Recycle Bin")
}

pub fn trash_not_moved() -> EngineMessage {
    EngineMessage::new("action.trashNotMoved", "Windows did not move the item to the Recycle Bin")
}

pub fn action_cancelled() -> EngineMessage {
    EngineMessage::new("action.cancelled", "The operation was cancelled")
}

/// `error`: texto del sistema (FormatMessage, ya localizado por Windows); es también el `message`.
pub fn action_failed(error: &str) -> EngineMessage {
    EngineMessage::new("action.failed", error).param("error", error)
}

pub fn unknown_action(kind: &str) -> EngineMessage {
    EngineMessage::new("action.unknown", format!("Unknown action: \"{kind}\"")).param("kind", kind)
}

pub fn elevation_failed(error: &str) -> EngineMessage {
    EngineMessage::new("elevation.failed", format!("Could not restart with administrator rights: {error}")).param("error", error)
}

// ---- Historial y exportación ----

pub fn history_not_found(id: &str) -> EngineMessage {
    EngineMessage::new("history.notFound", format!("Snapshot not found: \"{id}\"")).param("id", id)
}

/// `path`: la ruta del resumen.
pub fn history_other_root(path: &str) -> EngineMessage {
    EngineMessage::new("history.otherRoot", format!("That snapshot is of another folder ({path})")).param("path", path)
}

pub fn history_save_failed(error: &str) -> EngineMessage {
    EngineMessage::new("history.saveFailed", format!("Couldn't save the scan to the history: {error}")).param("error", error)
}

pub fn history_read_failed(error: &str) -> EngineMessage {
    EngineMessage::new("history.readFailed", format!("Couldn't read the snapshot: {error}")).param("error", error)
}

pub fn export_invalid_name(name: &str) -> EngineMessage {
    EngineMessage::new("export.invalidName", format!("Invalid file name: \"{name}\"")).param("name", name)
}

pub fn export_failed(error: &str) -> EngineMessage {
    EngineMessage::new("export.failed", format!("Couldn't save the file: {error}")).param("error", error)
}

pub fn export_not_found(path: &str) -> EngineMessage {
    EngineMessage::new("export.notFound", format!("Not an exported file: {path}")).param("path", path)
}

// ---- Escaneo guardado (.tessera) ----

/// El escaneo cargado se abrió desde un archivo: las operaciones sobre el disco (acciones, volver a
/// escanear, actualizar, duplicados, enlaces rotos) y el historial no están disponibles.
pub fn scan_offline() -> EngineMessage {
    EngineMessage::new("scan.offline", "This scan was opened from a file: actions on the disk aren't available")
}

/// `error`: texto breve en inglés (gzip o JSON rotos, otra versión, nodos inconsistentes…).
pub fn scan_open_failed(error: &str) -> EngineMessage {
    EngineMessage::new("scan.openFailed", format!("Couldn't open the saved scan: {error}")).param("error", error)
}

// ---- Volver a escanear una carpeta y actualizar con el diario USN ----

/// Se pidió volver a escanear la raíz por partes (hay que escanearla entera).
pub fn rescan_root() -> EngineMessage {
    EngineMessage::new("rescan.root", "The scan root can't be rescanned on its own: scan it again")
}

/// Sin diario USN utilizable: portable, sin administrador, no NTFS o sin letra de unidad.
pub fn refresh_unavailable() -> EngineMessage {
    EngineMessage::new("refresh.unavailable", "Quick update needs the desktop edition with administrator rights on a local NTFS drive")
}

/// El diario se reinició, perdió registros o cambió demasiado: hace falta un escaneo completo.
pub fn refresh_journal_reset() -> EngineMessage {
    EngineMessage::new("refresh.journalReset", "The change journal can't tell everything that changed since the last scan: a full scan is needed")
}

// ---- Escaneo programado (ver crate::schedule) ----

/// La edición portable, o un sistema sin Programador de tareas ni systemd del usuario (WSL sin systemd…).
pub fn schedule_unsupported() -> EngineMessage {
    EngineMessage::new("schedule.unsupported", "Scheduled scans need the desktop edition on Windows, or Linux with systemd")
}

/// `error`: la salida de schtasks o systemctl, resumida (texto del sistema).
pub fn schedule_failed(error: &str) -> EngineMessage {
    EngineMessage::new("schedule.failed", format!("Couldn't change the scheduled scan: {error}")).param("error", error)
}

/// `error`: qué está mal, en inglés (hora, día, porcentaje o carpeta).
pub fn schedule_invalid(error: &str) -> EngineMessage {
    EngineMessage::new("schedule.invalid", format!("Invalid schedule: {error}")).param("error", error)
}

// ---- Errores de sintaxis de la búsqueda (SearchResponse.error), igual que packages/protocol/src/query.ts ----

pub fn query_invalid_value(value: &str) -> EngineMessage {
    EngineMessage::new("query.invalidValue", format!("Invalid value: \"{value}\"")).param("value", value)
}

pub fn query_invalid_type(value: &str) -> EngineMessage {
    EngineMessage::new("query.invalidType", format!("Invalid type: \"{value}\" (use dir or file)")).param("value", value)
}

pub fn query_unknown_key(key: &str) -> EngineMessage {
    EngineMessage::new("query.unknownKey", format!("Unknown key: \"{key}\"")).param("key", key)
}

pub fn query_invalid_regex(error: &str) -> EngineMessage {
    EngineMessage::new("query.invalidRegex", format!("Invalid regular expression: {error}")).param("error", error)
}
