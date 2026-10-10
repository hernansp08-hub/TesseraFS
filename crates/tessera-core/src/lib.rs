//! tessera-core: motor de TesseraFS.
//!
//! - [`scan::scan`] escanea una ruta con el motor MFT (NTFS + administrador) o con el
//!   recorrido de directorios, y devuelve un [`tree::Tree`] compacto.
//! - [`slice::encode_slice`], [`ops::children`], [`ops::search`] y [`ops::ext_stats`]
//!   responden a la interfaz según el contrato de `docs/ARQUITECTURA.md`.
//! - [`dup::duplicates`] busca archivos duplicados (tamaño, primeros 64 KiB y BLAKE3 completo).
//! - [`history::History`] guarda resúmenes de los escaneos y compara el escaneo cargado con uno de ellos.
//! - [`export`] guarda los archivos exportados en Descargas\TesseraFS.
//! - [`rescan`] vuelve a escanear una carpeta del árbol cargado y actualiza con el diario USN ([`usn`]).

pub mod attrs;
pub mod build;
pub mod dup;
pub mod export;
pub mod history;
pub mod mft;
pub mod msg;
pub mod names;
pub mod ops;
pub mod query;
pub mod rescan;
pub mod scan;
pub mod slice;
pub mod sys;
pub mod tree;
pub mod types;
pub mod usn;
#[cfg(windows)]
pub mod walk;

pub use dup::duplicates;
pub use history::{Comparison, History};
pub use rescan::{refresh, refresh_shared, rescan, rescan_shared};
pub use scan::{scan, Progress, Scan, ScanOptions};
pub use tree::Tree;
pub use types::*;

/// Ejecuta una acción del Shell sobre una ruta exacta (UTF-16 sin terminador).
/// El error ya lleva su código (`action.failed`, `action.cancelled`, `action.trashNotMoved`…).
pub fn run_action(kind: ActionKind, path: &[u16]) -> Result<(), EngineMessage> {
    match kind {
        ActionKind::Open => sys::open(path),
        ActionKind::Reveal => sys::reveal(path),
        ActionKind::Properties => sys::properties(path),
        ActionKind::Trash => sys::trash(path),
    }
}

/// Resultado de una acción que terminó bien: `action.trashed` en la papelera; nada en el resto.
pub fn action_done(kind: ActionKind) -> ActionResult {
    if kind == ActionKind::Trash {
        ActionResult::ok_with(msg::trashed())
    } else {
        ActionResult::done()
    }
}

/// Ejecuta una acción sobre un nodo. Tras `trash` con éxito el nodo sale del árbol.
pub fn action(tree: &mut Tree, kind: ActionKind, id: u32) -> ActionResult {
    if id == 0 && kind == ActionKind::Trash {
        return ActionResult::fail(msg::trash_root());
    }
    if !tree.live(id) {
        return ActionResult::fail(msg::invalid_node(id));
    }
    let path = tree.path_wide(id);
    match run_action(kind, &path) {
        Ok(()) => {
            if kind == ActionKind::Trash {
                let _ = tree.remove(id);
            }
            action_done(kind)
        }
        Err(e) => ActionResult::fail(e),
    }
}
