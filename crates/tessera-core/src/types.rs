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
    /// `true` si `refresh` puede actualizar con el diario USN (ver [`crate::rescan`]). El motor Rust
    /// siempre lo da (`true` o `false`); falta en el JSON sólo si es `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_refresh: Option<bool>,
    /// Escaneo abierto desde un archivo `.tessera` (ver [`crate::saved`]), no leído del disco ahora: las
    /// acciones sobre el disco, volver a escanear, actualizar, duplicados e historial dan `scan.offline`.
    /// Falta en el JSON en un escaneo normal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offline: Option<SavedScanInfo>,
}

/// De dónde viene un escaneo abierto desde archivo (`ScanResult.offline`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedScanInfo {
    /// Cuándo se escaneó (segundos Unix).
    pub scanned_at: u64,
    /// Nombre del equipo donde se escaneó, si se sabe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Versión de TesseraFS que lo guardó.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
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
    /// Sólo con una comparación activa (ver [`crate::history`]): tamaño en el escaneo anterior, si se conoce.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev: Option<u64>,
    /// Sólo con una comparación activa: `Some(true)` si no existía en el escaneo anterior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh: Option<bool>,
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
    /// Crecimiento desde el escaneo comparado: size − prev; lo nuevo cuenta entero; lo desconocido, 0.
    Delta,
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
    /// Pasa a «sólo en línea» los archivos de la nube descargados (ver [`crate::freeup`]).
    #[serde(rename = "freeUp")]
    FreeUp,
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
            "freeUp" => Ok(Self::FreeUp),
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

/// Sistema operativo (`SystemInfo.os`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Windows,
    Linux,
    Macos,
}

/// La plataforma, para la interfaz (comando `system`, ver [`crate::system_info`]).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: Os,
    /// Separador de rutas: `\` en Windows, `/` en el resto.
    pub sep: String,
    /// Acciones disponibles aquí; la interfaz oculta las demás.
    pub actions: Vec<ActionKind>,
    /// Carpeta o unidad pedida al abrir la app (ver [`crate::launch`]); la pone el escritorio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_path: Option<String>,
}

// ---------- Duplicados (ver crate::dup) ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DupRequest {
    pub root: u32,
    pub min_size: u64,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DupPhase {
    Size,
    Prefix,
    Full,
    Done,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DupProgress {
    pub phase: DupPhase,
    /// Archivos leídos en la pasada actual y candidatos de la pasada.
    pub files: u64,
    pub total_files: u64,
    /// Bytes leídos en la pasada actual y bytes que leerá.
    pub bytes: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    /// Tamaño de cada copia.
    pub size: u64,
    /// BLAKE3 del contenido en hex (64 caracteres en minúsculas).
    pub hash: String,
    /// ≥ 2, ordenados por ruta sin distinguir mayúsculas.
    pub files: Vec<SearchRow>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DupSkipped {
    pub hardlinks: u64,
    pub cloud: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DupResult {
    /// Los `limit` primeros por espacio recuperable, (n − 1) × size, de mayor a menor.
    pub groups: Vec<DupGroup>,
    pub total_groups: u64,
    /// Espacio recuperable de todos los grupos encontrados.
    pub wasted: u64,
    /// Archivos con tamaño repetido (primera pasada).
    pub candidates: u64,
    pub read_bytes: u64,
    pub skipped: DupSkipped,
    pub elapsed_ms: u64,
    pub warnings: Vec<EngineMessage>,
}

// ---------- Historial, comparación y exportación (ver crate::history y crate::export) ----------

/// Número JSON entero no negativo; admite también decimales (los de otra edición) y los trunca.
fn de_u64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let n = f64::deserialize(d)?;
    Ok(if n.is_finite() && n > 0.0 { n as u64 } else { 0 })
}

/// Resumen de un escaneo guardado en el historial (`<id>.json`; formato en docs/ARQUITECTURA.md).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// `20261010T174512Z-1a2b3c4d`: fecha UTC del guardado + FNV-1a de la ruta en minúsculas.
    pub id: String,
    pub path: String,
    /// Cuándo terminó el escaneo, en segundos Unix.
    #[serde(deserialize_with = "de_u64")]
    pub scanned_at: u64,
    pub engine: Engine,
    #[serde(deserialize_with = "de_u64")]
    pub bytes: u64,
    #[serde(deserialize_with = "de_u64")]
    pub files: u64,
    #[serde(deserialize_with = "de_u64")]
    pub dirs: u64,
    /// Nodos guardados.
    #[serde(deserialize_with = "de_u64")]
    pub nodes: u64,
    /// Lo que ocupa el `.snap.gz`.
    #[serde(deserialize_with = "de_u64")]
    pub file_bytes: u64,
}

/// Tamaño de un nodo del escaneo cargado en un resumen del historial (`historyTrend`, ver
/// [`crate::history`]); `size: null` si no estaba (o era un archivo de menos de 1 MiB, que el resumen no guarda).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub id: String,
    pub scanned_at: u64,
    pub size: Option<u64>,
}

/// Un elemento actual con su tamaño anterior; `prev: null` = no existía.
/// (El `prev` de la fila va aquí, no en `row.node.prev`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRow {
    #[serde(flatten)]
    pub row: SearchRow,
    pub prev: Option<u64>,
}

/// Lo que existía y ya no: sólo el elemento más alto (no sus descendientes).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemovedRow {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub bytes: u64,
    pub files: u64,
    pub dirs: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub entry: HistoryEntry,
    pub before: Totals,
    pub after: Totals,
    /// Lo que creció (o es nuevo) sin que un solo hijo explique el 75 % o más; delta desc.
    pub grew: Vec<ChangeRow>,
    /// Igual para lo que se redujo, el que más primero.
    pub shrank: Vec<ChangeRow>,
    /// Por tamaño desc.
    pub removed: Vec<RemovedRow>,
}

// ---------- Volver a escanear y actualizar (ver crate::rescan) ----------

/// Resultado de volver a escanear una carpeta: la misma carpeta (mismo id) con su contenido nuevo.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RescanResult {
    /// La carpeta ya actualizada.
    pub row: NodeRow,
    /// Su tamaño antes.
    pub before: u64,
    /// Elementos leídos.
    pub entries: u64,
    pub elapsed_ms: u64,
    /// `scan.accessDenied` / `scan.readErrors`, como en el escaneo.
    pub warnings: Vec<EngineMessage>,
}

/// Resultado de `refresh`: lo que el diario USN dijo que cambió, ya vuelto a escanear.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    /// Carpetas vueltas a escanear.
    pub folders: u64,
    /// Registros del diario leídos.
    pub records: u64,
    /// Tamaño de la raíz antes y después.
    pub before: u64,
    pub after: u64,
    pub elapsed_ms: u64,
    pub warnings: Vec<EngineMessage>,
}

/// Archivo exportado en Descargas\TesseraFS.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
}

// ---------- Escaneo programado (ver crate::schedule) ----------

/// Cada cuánto se repite el escaneo programado.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleEvery {
    Daily,
    Weekly,
}

/// Textos de la notificación de poco espacio, ya traducidos por la interfaz al crear la programación:
/// `{drive}`, `{free}` y `{pct}` se sustituyen al avisar. `sizes`: cómo escribe el idioma un tamaño en KB,
/// MB, GB y TB, con `{int}` y `{frac}` en lugar de las cifras («{int},{frac} Go»).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ScheduleMessages {
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizes: Option<Vec<String>>,
}

/// Porcentaje entero no negativo (el JSON de JavaScript puede traer `10.0`); otra cosa es un error.
fn de_pct<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let n = f64::deserialize(d)?;
    if n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= f64::from(u32::MAX) {
        Ok(n as u32)
    } else {
        Err(serde::de::Error::custom(format!("minFreePct must be a whole number from 0 to 99, not {n}")))
    }
}

/// El escaneo programado (sólo hay uno): se guarda tal cual en `schedule.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfig {
    /// Unidad o carpeta que se escanea.
    pub path: String,
    pub every: ScheduleEvery,
    /// Hora local, «HH:MM».
    pub time: String,
    /// Con `weekly`: día de la semana, 0 = domingo … 6 = sábado.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekday: Option<u8>,
    /// Avisar si el espacio libre baja de este porcentaje (0 = no avisar nunca).
    #[serde(deserialize_with = "de_pct")]
    pub min_free_pct: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<ScheduleMessages>,
}

/// Resultado de la última ejecución del escaneo programado (`schedule-last.json`).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    /// Cuándo terminó (segundos Unix).
    #[serde(deserialize_with = "de_u64")]
    pub at: u64,
    pub ok: bool,
    /// Bytes escaneados y espacio libre de la unidad en ese momento.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Si avisó por poco espacio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alerted: Option<bool>,
    /// Error, si falló.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<EngineMessage>,
}

/// Lo que la interfaz necesita del escaneo programado (`scheduleGet` / `scheduleSet`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInfo {
    /// Esta edición y este sistema pueden programar escaneos.
    pub supported: bool,
    /// El escaneo programado actual, o null.
    pub schedule: Option<ScheduleConfig>,
    /// La última vez que se ejecutó, si se sabe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<ScheduleRun>,
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
            can_refresh: None,
            offline: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("canRefresh").is_none());
        assert!(v.get("offline").is_none());
        // Escaneo abierto desde archivo: offline con scannedAt y, si se saben, host y app
        let info = SavedScanInfo { scanned_at: 1_791_700_000, host: Some("PC-1".into()), app: None };
        let o = serde_json::to_value(ScanResult { offline: Some(info.clone()), ..r.clone() }).unwrap();
        assert_eq!(o["offline"], serde_json::json!({ "scannedAt": 1_791_700_000u64, "host": "PC-1" }));
        assert_eq!(serde_json::from_value::<ScanResult>(o).unwrap().offline, Some(info));
        let t = TrendPoint { id: "x".into(), scanned_at: 5, size: None };
        assert_eq!(serde_json::to_value(&t).unwrap(), serde_json::json!({ "id": "x", "scannedAt": 5, "size": null }));
        assert_eq!(serde_json::to_value(TrendPoint { size: Some(7), ..t }).unwrap()["size"], 7);
        assert_eq!(serde_json::to_value(msg::scan_offline()).unwrap(), serde_json::json!({ "code": "scan.offline", "message": "This scan was opened from a file: actions on the disk aren't available" }));
        let f = msg::scan_open_failed("Not a gzip file");
        assert_eq!((f.code.as_str(), f.message.as_str(), f.get("error")), ("scan.openFailed", "Couldn't open the saved scan: Not a gzip file", Some(&Param::Str("Not a gzip file".into()))));
        assert_eq!(v["warnings"][0]["code"], "scan.mftOrphans");
        let v = serde_json::to_value(ScanResult { can_refresh: Some(false), ..r.clone() }).unwrap();
        assert_eq!(v["canRefresh"], false);
        let back: ScanResult = serde_json::from_str(r#"{"rootId":0,"rootPath":"C:\\","engine":"mft","entries":0,"files":0,"dirs":0,"bytes":0,"elapsedMs":0,"volume":null,"warnings":[],"canRefresh":true}"#).unwrap();
        assert_eq!(back.can_refresh, Some(true));
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
        assert_eq!("freeUp".parse::<ActionKind>(), Ok(ActionKind::FreeUp));
        assert_eq!(serde_json::to_value(ActionKind::FreeUp).unwrap(), "freeUp");
        assert_eq!(serde_json::from_str::<ActionKind>(r#""freeUp""#).unwrap(), ActionKind::FreeUp);
        let a = serde_json::to_value(ActionResult::ok_with(msg::freed_up(2, 3 << 20))).unwrap();
        assert_eq!(a["params"], serde_json::json!({ "count": 2, "bytes": 3 << 20 }));
        assert_eq!(a["message"], "2 files set to online-only; 3.0 MB will be freed shortly");
        let a = serde_json::to_value(ActionResult::fail(msg::nothing_to_free())).unwrap();
        assert_eq!((a["ok"].clone(), a["code"].clone(), a.get("params")), (false.into(), "action.nothingToFree".into(), None));
    }

    #[test]
    fn system_info_and_other_mounts_json() {
        let s = SystemInfo { os: Os::Linux, sep: "/".into(), actions: vec![ActionKind::Open, ActionKind::Reveal, ActionKind::Trash], launch_path: None };
        assert_eq!(serde_json::to_value(&s).unwrap(), serde_json::json!({ "os": "linux", "sep": "/", "actions": ["open", "reveal", "trash"] }));
        let w = SystemInfo { os: Os::Windows, sep: "\\".into(), actions: vec![ActionKind::Properties, ActionKind::FreeUp], launch_path: None };
        assert_eq!(serde_json::to_string(&w).unwrap(), r#"{"os":"windows","sep":"\\","actions":["properties","freeUp"]}"#);
        // launchPath sólo si se pidió una carpeta al abrir
        let l = SystemInfo { launch_path: Some("C:\\Datos".into()), ..w.clone() };
        assert_eq!(serde_json::to_value(&l).unwrap()["launchPath"], "C:\\Datos");
        assert_eq!(serde_json::from_value::<SystemInfo>(serde_json::to_value(&w).unwrap()).unwrap(), w);
        assert_eq!(serde_json::to_value(Os::Macos).unwrap(), "macos");
        let here = crate::system_info();
        assert_eq!(here.sep, std::path::MAIN_SEPARATOR_STR);
        assert_eq!(here.launch_path, None);
        assert!(here.actions.contains(&ActionKind::Open) && here.actions.contains(&ActionKind::Trash));
        assert_eq!(here.actions.contains(&ActionKind::FreeUp), cfg!(windows));
        let paths: Vec<String> = ["/home", "/boot", "/mnt/c", "/srv", "/media/usb", "/opt"].iter().map(|s| s.to_string()).collect();
        let m = msg::other_mounts(6, &paths);
        assert_eq!(m.code, "scan.otherMounts");
        assert_eq!(m.get("count"), Some(&Param::Int(6)));
        assert_eq!(m.get("paths"), Some(&Param::Str("/home, /boot, /mnt/c, /srv, /media/usb".into())));
        assert_eq!(m.message, "6 mounted file systems were not included (analyze them separately): /home, /boot, /mnt/c, /srv, /media/usb");
        assert_eq!(msg::other_mounts(1, &paths[..1]).message, "1 mounted file system was not included (analyze it separately): /home");
    }

    #[test]
    fn dup_json() {
        let p = DupProgress { phase: DupPhase::Prefix, files: 1, total_files: 2, bytes: 3, total_bytes: 4, elapsed_ms: 5 };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"phase":"prefix","files":1,"totalFiles":2,"bytes":3,"totalBytes":4,"elapsedMs":5}"#
        );
        let r = DupResult {
            groups: vec![DupGroup { size: 7, hash: "ab".into(), files: vec![] }],
            total_groups: 1,
            wasted: 7,
            candidates: 2,
            read_bytes: 14,
            skipped: DupSkipped { hardlinks: 1, cloud: 0 },
            elapsed_ms: 9,
            warnings: vec![msg::dup_read_errors(1)],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({
                "groups": [{ "size": 7, "hash": "ab", "files": [] }], "totalGroups": 1, "wasted": 7, "candidates": 2, "readBytes": 14,
                "skipped": { "hardlinks": 1, "cloud": 0 }, "elapsedMs": 9,
                "warnings": [{ "code": "dup.readErrors", "params": { "count": 1 }, "message": "1 file couldn't be read and was left out" }],
            })
        );
        let q: DupRequest = serde_json::from_str(r#"{"root":3,"minSize":1048576,"limit":200}"#).unwrap();
        assert_eq!(q, DupRequest { root: 3, min_size: 1 << 20, limit: 200 });
        assert_eq!(msg::dup_read_errors(2).message, "2 files couldn't be read and were left out");
        assert_eq!(msg::dup_busy().code, "error.dupBusy");
    }

    #[test]
    fn rescan_json() {
        let r = RescanResult { row: node(None, None), before: 4, entries: 2, elapsed_ms: 3, warnings: vec![msg::access_denied(1, &[])] };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["row"]["id"], 3);
        assert_eq!((v["before"].clone(), v["entries"].clone(), v["elapsedMs"].clone()), (4.into(), 2.into(), 3.into()));
        assert_eq!(v["warnings"][0]["code"], "scan.accessDenied");
        assert_eq!(serde_json::from_value::<RescanResult>(v).unwrap(), r);
        let f = RefreshResult { folders: 1, records: 2, before: 3, after: 4, elapsed_ms: 5, warnings: vec![] };
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({ "folders": 1, "records": 2, "before": 3, "after": 4, "elapsedMs": 5, "warnings": [] })
        );
        assert_eq!(serde_json::to_value(msg::rescan_root()).unwrap(), serde_json::json!({ "code": "rescan.root", "message": "The scan root can't be rescanned on its own: scan it again" }));
        assert_eq!(msg::refresh_unavailable().code, "refresh.unavailable");
        assert_eq!(msg::refresh_journal_reset().code, "refresh.journalReset");
        assert!(msg::refresh_journal_reset().params.is_none());
    }

    fn node(prev: Option<u64>, fresh: Option<bool>) -> NodeRow {
        NodeRow {
            id: 3,
            parent_id: 0,
            name: "a.bin".into(),
            is_dir: false,
            size: 5,
            alloc: 8,
            files: 0,
            dirs: 0,
            mtime: 9,
            ext: "bin".into(),
            flags: 0,
            child_count: 0,
            prev,
            fresh,
        }
    }

    #[test]
    fn history_json() {
        // Sin comparación no aparecen prev ni fresh
        let base = serde_json::json!({
            "id": 3, "parentId": 0, "name": "a.bin", "isDir": false, "size": 5, "alloc": 8, "files": 0, "dirs": 0,
            "mtime": 9, "ext": "bin", "flags": 0, "childCount": 0,
        });
        assert_eq!(serde_json::to_value(node(None, None)).unwrap(), base);
        let mut with = base.clone();
        with["prev"] = serde_json::json!(2);
        assert_eq!(serde_json::to_value(node(Some(2), None)).unwrap(), with);
        let mut fresh = base.clone();
        fresh["fresh"] = serde_json::json!(true);
        assert_eq!(serde_json::to_value(node(None, Some(true))).unwrap(), fresh);
        let back: NodeRow = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(back, node(None, None));
        assert_eq!(serde_json::to_string(&SortKey::Delta).unwrap(), "\"delta\"");
        assert_eq!(serde_json::from_str::<SortKey>("\"delta\"").unwrap(), SortKey::Delta);

        // ChangeRow: la fila + path + prev (null si es nuevo)
        let c = ChangeRow { row: SearchRow { node: node(None, Some(true)), path: "C:\\a.bin".into() }, prev: None };
        let mut j = fresh.clone();
        j["path"] = serde_json::json!("C:\\a.bin");
        j["prev"] = serde_json::Value::Null;
        assert_eq!(serde_json::to_value(&c).unwrap(), j);
        let back: ChangeRow = serde_json::from_value(j).unwrap();
        assert_eq!((back.prev, back.row.node.fresh, back.row.node.prev), (None, Some(true), None));
        let c = ChangeRow { row: SearchRow { node: node(None, None), path: "C:\\a.bin".into() }, prev: Some(2) };
        assert_eq!(serde_json::to_value(&c).unwrap()["prev"], 2);

        let e = HistoryEntry {
            id: "20261010T174512Z-1a2b3c4d".into(),
            path: "C:\\".into(),
            scanned_at: 1_791_654_312,
            engine: Engine::Mft,
            bytes: 10,
            files: 2,
            dirs: 1,
            nodes: 3,
            file_bytes: 99,
        };
        let ej = serde_json::json!({
            "id": "20261010T174512Z-1a2b3c4d", "path": "C:\\", "scannedAt": 1_791_654_312u64, "engine": "mft",
            "bytes": 10, "files": 2, "dirs": 1, "nodes": 3, "fileBytes": 99,
        });
        assert_eq!(serde_json::to_value(&e).unwrap(), ej);
        assert_eq!(serde_json::from_value::<HistoryEntry>(ej).unwrap(), e);
        // Números con decimales (otra edición) se truncan
        let f: HistoryEntry = serde_json::from_str(
            r#"{"id":"x","path":"C:\\","scannedAt":1791654312.7,"engine":"walk","bytes":10.0,"files":2,"dirs":1,"nodes":3,"fileBytes":99}"#,
        )
        .unwrap();
        assert_eq!((f.scanned_at, f.bytes, f.engine), (1_791_654_312, 10, Engine::Walk));

        let r = CompareResult {
            entry: e,
            before: Totals { bytes: 1, files: 2, dirs: 3 },
            after: Totals { bytes: 4, files: 5, dirs: 6 },
            grew: vec![],
            shrank: vec![],
            removed: vec![RemovedRow { path: "C:\\old".into(), is_dir: true, size: 7 }],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["before"], serde_json::json!({ "bytes": 1, "files": 2, "dirs": 3 }));
        assert_eq!(v["after"], serde_json::json!({ "bytes": 4, "files": 5, "dirs": 6 }));
        assert_eq!(v["removed"], serde_json::json!([{ "path": "C:\\old", "isDir": true, "size": 7 }]));
        assert_eq!(v["entry"]["fileBytes"], 99);
        for k in ["entry", "before", "after", "grew", "shrank", "removed"] {
            assert!(v.get(k).is_some(), "falta {k}");
        }
        assert_eq!(serde_json::to_string(&ExportResult { path: "C:\\x.csv".into() }).unwrap(), r#"{"path":"C:\\x.csv"}"#);
        // Mensajes nuevos
        let m = serde_json::to_value(msg::history_other_root("D:\\")).unwrap();
        assert_eq!(m, serde_json::json!({ "code": "history.otherRoot", "params": { "path": "D:\\" }, "message": "That snapshot is of another folder (D:\\)" }));
        assert_eq!(msg::history_not_found("x").get("id"), Some(&Param::Str("x".into())));
        assert_eq!(msg::history_save_failed("disk full").code, "history.saveFailed");
        assert_eq!(msg::history_read_failed("bad gzip").get("error"), Some(&Param::Str("bad gzip".into())));
        assert_eq!(msg::export_invalid_name("a/b").get("name"), Some(&Param::Str("a/b".into())));
        assert_eq!(msg::export_failed("e").code, "export.failed");
        assert_eq!(msg::export_not_found("C:\\x").get("path"), Some(&Param::Str("C:\\x".into())));
    }
}
