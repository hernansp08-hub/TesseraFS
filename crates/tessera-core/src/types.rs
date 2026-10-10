//! Tipos del contrato con la interfaz (espejo de `packages/protocol/src/types.ts`).
//! Los nombres JSON van en camelCase; los tamaños en bytes (< 2^53) y las fechas en segundos Unix.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Valor de un parámetro de [`EngineMessage`]: número o texto (`string | number` en types.ts).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Param {
    Int(i64),
    Num(f64),
    Str(String),
}

impl std::fmt::Display for Param {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Param::Int(n) => write!(f, "{n}"),
            Param::Num(n) => write!(f, "{n}"),
            Param::Str(s) => f.write_str(s),
        }
    }
}

impl From<&str> for Param {
    fn from(s: &str) -> Self {
        Param::Str(s.to_string())
    }
}
impl From<String> for Param {
    fn from(s: String) -> Self {
        Param::Str(s)
    }
}
impl From<f64> for Param {
    fn from(n: f64) -> Self {
        Param::Num(n)
    }
}
macro_rules! param_int {
    ($($t:ty),*) => {$(
        impl From<$t> for Param {
            fn from(n: $t) -> Self {
                Param::Int(i64::try_from(n).unwrap_or(i64::MAX))
            }
        }
    )*};
}
param_int!(i32, i64, u32, u64, usize);

/// Parámetros de un mensaje, en orden estable.
pub type Params = BTreeMap<String, Param>;

/// Mensaje para el usuario: la interfaz traduce `code` (clave `engine.<code>`) con `params`;
/// `message` es el texto en inglés, de reserva y para registros. Ver docs/tecnica/i18n.md
/// y el catálogo de códigos en [`crate::msg`].
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineMessage {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Params>,
    pub message: String,
}

impl EngineMessage {
    /// `EngineMessage::new("scan.mftNeedsAdmin", "MFT unavailable without administrator rights: …")`
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        EngineMessage { code: code.into(), params: None, message: message.into() }
    }

    /// Añade un parámetro: `.param("fs", "FAT32")`, `.param("count", 3)`.
    pub fn param(mut self, key: &str, value: impl Into<Param>) -> Self {
        self.params.get_or_insert_with(Params::new).insert(key.to_string(), value.into());
        self
    }

    /// Valor de un parámetro.
    pub fn get(&self, key: &str) -> Option<&Param> {
        self.params.as_ref()?.get(key)
    }
}

impl std::fmt::Display for EngineMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EngineMessage {}

/// Un fallo técnico sin código propio (texto interno en inglés) → `error.internal`.
impl From<String> for EngineMessage {
    fn from(error: String) -> Self {
        crate::msg::internal(&error)
    }
}
impl From<&str> for EngineMessage {
    fn from(error: &str) -> Self {
        crate::msg::internal(error)
    }
}

/// Bits de `flags` (iguales a `FLAG` en types.ts).
pub mod flag {
    pub const DIR: u16 = 1;
    pub const HIDDEN: u16 = 2;
    pub const SYSTEM: u16 = 4;
    pub const HARDLINK: u16 = 8;
    pub const COMPRESSED: u16 = 16;
    pub const REPARSE: u16 = 32;
    pub const CLOUD: u16 = 64;
    pub const SPARSE: u16 = 128;
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Mft,
    Walk,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EngineChoice {
    #[default]
    Auto,
    Mft,
    Walk,
}

impl std::str::FromStr for EngineChoice {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "auto" => Ok(Self::Auto),
            "mft" => Ok(Self::Mft),
            "walk" => Ok(Self::Walk),
            _ => Err(format!("Unknown engine: \"{s}\" (use auto, walk or mft)")),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub path: String,
    pub label: String,
    pub fs: String,
    pub total: u64,
    pub free: u64,
    pub cluster_size: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ScanPhase {
    Starting,
    MftRead,
    Walk,
    Link,
    Aggregate,
    Done,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: ScanPhase,
    pub entries: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 0..1 cuando se conoce el total de trabajo (lectura de la MFT).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root_id: u32,
    pub root_path: String,
    pub engine: Engine,
    pub entries: u64,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub volume: Option<VolumeInfo>,
    pub warnings: Vec<EngineMessage>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeRow {
    pub id: u32,
    pub parent_id: i64,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub alloc: u64,
    pub files: u32,
    pub dirs: u32,
    pub mtime: u32,
    pub ext: String,
    pub flags: u16,
    pub child_count: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SortKey {
    #[default]
    Size,
    Alloc,
    Name,
    Files,
    Mtime,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChildrenResponse {
    pub total: u32,
    pub rows: Vec<NodeRow>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchRow {
    #[serde(flatten)]
    pub node: NodeRow,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub total: u64,
    pub total_bytes: u64,
    pub rows: Vec<SearchRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<EngineMessage>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtStat {
    pub ext: String,
    pub size: u64,
    pub alloc: u64,
    pub count: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActionKind {
    Open,
    Reveal,
    Properties,
    Trash,
}

impl std::str::FromStr for ActionKind {
    /// La acción desconocida se devuelve tal cual (para `action.unknown`).
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "open" => Ok(Self::Open),
            "reveal" => Ok(Self::Reveal),
            "properties" => Ok(Self::Properties),
            "trash" => Ok(Self::Trash),
            _ => Err(s.to_string()),
        }
    }
}

/// Resultado de una acción: `code` + `params` se traducen en la interfaz; `message` es el
/// texto del sistema (ya localizado por Windows) o el de reserva en inglés.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Params>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ActionResult {
    /// Éxito sin mensaje (abrir, mostrar en el Explorador, propiedades).
    pub fn done() -> Self {
        ActionResult { ok: true, code: None, params: None, message: None }
    }
    /// Éxito con mensaje (p. ej. `action.trashed`).
    pub fn ok_with(m: EngineMessage) -> Self {
        ActionResult { ok: true, code: Some(m.code), params: m.params, message: Some(m.message) }
    }
    pub fn fail(m: EngineMessage) -> Self {
        ActionResult { ok: false, code: Some(m.code), params: m.params, message: Some(m.message) }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElevationInfo {
    pub elevated: bool,
    pub can_elevate: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg;

    #[test]
    fn engine_message_json() {
        let w = msg::mft_unsupported_fs("FAT32");
        let j = serde_json::to_string(&w).unwrap();
        assert_eq!(
            j,
            r#"{"code":"scan.mftUnsupportedFs","params":{"fs":"FAT32"},"message":"The MFT can only be read on local NTFS volumes (FAT32): walked the folders instead"}"#
        );
        // Sin parámetros no hay clave `params`
        let j = serde_json::to_string(&msg::mft_needs_admin()).unwrap();
        assert_eq!(j, r#"{"code":"scan.mftNeedsAdmin","message":"MFT unavailable without administrator rights: walked the folders instead"}"#);
        // Los números viajan como números y las claves en orden estable
        let v = serde_json::to_value(msg::cannot_open(r"C:\x", "Access is denied.")).unwrap();
        assert_eq!(v["params"], serde_json::json!({ "error": "Access is denied.", "path": "C:\\x" }));
        let v = serde_json::to_value(msg::access_denied(3, &[])).unwrap();
        assert_eq!(v["params"]["count"], serde_json::json!(3));
        assert_eq!(v["message"], "3 folders could not be read (access denied); their contents are not counted");
        assert_eq!(msg::read_errors(1, &[]).message, "1 folder could not be read; its contents are not counted");
        // Ida y vuelta
        let back: EngineMessage = serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
        assert_eq!(back, w);
        assert_eq!(back.get("fs"), Some(&Param::Str("FAT32".into())));
    }

    #[test]
    fn scan_result_warnings_and_action_result_json() {
        let r = ScanResult {
            root_id: 0,
            root_path: "C:\\".into(),
            engine: Engine::Walk,
            entries: 0,
            files: 0,
            dirs: 0,
            bytes: 0,
            elapsed_ms: 0,
            volume: None,
            warnings: vec![msg::mft_orphans(7)],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["warnings"][0]["code"], "scan.mftOrphans");
        assert_eq!(v["warnings"][0]["params"]["count"], 7);
        assert_eq!(serde_json::to_string(&ActionResult::done()).unwrap(), r#"{"ok":true}"#);
        let a = serde_json::to_value(ActionResult::fail(msg::action_failed("Acceso denegado."))).unwrap();
        assert_eq!(a, serde_json::json!({ "ok": false, "code": "action.failed", "params": { "error": "Acceso denegado." }, "message": "Acceso denegado." }));
        let a = serde_json::to_value(ActionResult::ok_with(msg::trashed())).unwrap();
        assert_eq!(a, serde_json::json!({ "ok": true, "code": "action.trashed", "message": "Moved to the Recycle Bin" }));
        let e: EngineMessage = String::from("boom").into();
        assert_eq!(serde_json::to_value(e).unwrap(), serde_json::json!({ "code": "error.internal", "params": { "error": "boom" }, "message": "Internal error: boom" }));
        assert_eq!("trash".parse::<ActionKind>(), Ok(ActionKind::Trash));
        assert_eq!("nuke".parse::<ActionKind>(), Err("nuke".to_string()));
    }
}
