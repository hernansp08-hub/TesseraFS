//! Catálogo de mensajes de los motores: cada función crea el [`EngineMessage`] de un código
//! de docs/tecnica/i18n.md («Mensajes de los motores») con sus parámetros y el texto de
//! reserva en inglés. La interfaz traduce `engine.<code>`; los detalles técnicos internos
//! viajan en inglés dentro del parámetro `error`.

use crate::types::EngineMessage;

fn plural(n: u64, one: &str, other: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { other })
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
