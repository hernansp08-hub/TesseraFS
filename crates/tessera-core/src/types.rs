//! Tipos del contrato con la interfaz (espejo de `packages/protocol/src/types.ts`).
//! Los nombres JSON van en camelCase; los tamaños en bytes (< 2^53) y las fechas en segundos Unix.

use serde::{Deserialize, Serialize};

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
            _ => Err(format!("Motor desconocido: «{s}» (usa auto, walk o mft)")),
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
    pub warnings: Vec<String>,
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
    pub error: Option<String>,
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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElevationInfo {
    pub elevated: bool,
    pub can_elevate: bool,
}
