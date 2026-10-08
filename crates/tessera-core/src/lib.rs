//! tessera-core: motor de TesseraFS.
//!
//! - [`scan::scan`] escanea una ruta con el motor MFT (NTFS + administrador) o con el
//!   recorrido de directorios, y devuelve un [`tree::Tree`] compacto.
//! - [`slice::encode_slice`], [`ops::children`], [`ops::search`] y [`ops::ext_stats`]
//!   responden a la interfaz según el contrato de `docs/ARQUITECTURA.md`.

pub mod attrs;
pub mod build;
pub mod mft;
pub mod names;
pub mod ops;
pub mod query;
pub mod scan;
pub mod slice;
pub mod sys;
pub mod tree;
pub mod types;
#[cfg(windows)]
pub mod walk;

pub use scan::{scan, Progress, Scan, ScanOptions};
pub use tree::Tree;
pub use types::*;

/// Ejecuta una acción del Shell sobre una ruta exacta (UTF-16 sin terminador).
pub fn run_action(kind: ActionKind, path: &[u16]) -> Result<(), String> {
    match kind {
        ActionKind::Open => sys::open(path),
        ActionKind::Reveal => sys::reveal(path),
        ActionKind::Properties => sys::properties(path),
        ActionKind::Trash => sys::trash(path),
    }
}

/// Ejecuta una acción sobre un nodo. Tras `trash` con éxito el nodo sale del árbol.
pub fn action(tree: &mut Tree, kind: ActionKind, id: u32) -> ActionResult {
    if id == 0 && kind == ActionKind::Trash {
        return ActionResult { ok: false, message: Some("No se puede enviar la raíz del escaneo a la papelera".into()) };
    }
    if !tree.live(id) {
        return ActionResult { ok: false, message: Some(format!("Id no válido: {id}")) };
    }
    let path = tree.path_wide(id);
    let r = run_action(kind, &path);
    if r.is_ok() && kind == ActionKind::Trash {
        let _ = tree.remove(id);
    }
    match r {
        Ok(()) => ActionResult { ok: true, message: (kind == ActionKind::Trash).then(|| "Movido a la papelera".to_string()) },
        Err(e) => ActionResult { ok: false, message: Some(e) },
    }
}
