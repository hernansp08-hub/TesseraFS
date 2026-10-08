//! Atributos de Windows → bits de `flags` del contrato (compartido por ambos motores).

use crate::types::flag;

pub const ATTR_HIDDEN: u32 = 0x2;
pub const ATTR_SYSTEM: u32 = 0x4;
pub const ATTR_DIRECTORY: u32 = 0x10;
pub const ATTR_SPARSE: u32 = 0x200;
pub const ATTR_REPARSE: u32 = 0x400;
pub const ATTR_COMPRESSED: u32 = 0x800;
pub const ATTR_OFFLINE: u32 = 0x1000;
pub const ATTR_RECALL_ON_OPEN: u32 = 0x4_0000;
pub const ATTR_RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;

pub const TAG_WOF: u32 = 0x8000_0017;
pub const TAG_APPEXECLINK: u32 = 0x8000_001B;

/// Bits de `flags` a partir de atributos y etiqueta de reparse.
pub fn flags_of(attrs: u32, tag: u32) -> u16 {
    let mut f = 0;
    if attrs & ATTR_DIRECTORY != 0 {
        f |= flag::DIR;
    }
    if attrs & ATTR_HIDDEN != 0 {
        f |= flag::HIDDEN;
    }
    if attrs & ATTR_SYSTEM != 0 {
        f |= flag::SYSTEM;
    }
    if attrs & ATTR_COMPRESSED != 0 || tag == TAG_WOF {
        f |= flag::COMPRESSED;
    }
    if attrs & ATTR_SPARSE != 0 {
        f |= flag::SPARSE;
    }
    if attrs & (ATTR_RECALL_ON_DATA_ACCESS | ATTR_RECALL_ON_OPEN | ATTR_OFFLINE) != 0 || is_cloud_tag(tag) {
        f |= flag::CLOUD;
    }
    if attrs & ATTR_REPARSE != 0 && (is_link_tag(tag) || tag == 0) {
        f |= flag::REPARSE;
    }
    f
}

/// Junctions, symlinks, montajes y alias de ejecución: no se siguen.
pub fn is_link_tag(tag: u32) -> bool {
    tag & 0x2000_0000 != 0 || tag == TAG_APPEXECLINK
}

/// `IO_REPARSE_TAG_CLOUD` y sus variantes 0x9000x01A.
pub fn is_cloud_tag(tag: u32) -> bool {
    tag & 0xFFFF_0FFF == 0x9000_001A
}

pub fn filetime_to_unix(ft: i64) -> u32 {
    if ft <= 0 {
        return 0;
    }
    let s = ft / 10_000_000 - 11_644_473_600;
    s.clamp(0, u32::MAX as i64) as u32
}

