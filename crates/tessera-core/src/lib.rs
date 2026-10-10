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
//! - [`action`] abre, muestra, envía a la papelera o libera espacio de OneDrive ([`freeup`]).

pub mod attrs;
pub mod build;
pub mod dup;
pub mod export;
pub mod freeup;
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

/// Lo que una acción necesita del árbol: se toma bajo lectura y la acción corre después sin bloquearlo.
pub enum ActionTarget {
    /// Ruta exacta del nodo (UTF-16 sin terminador): open, reveal, properties y trash.
    Path(Vec<u16>),
    /// Archivos y carpetas de la nube bajo el nodo: freeUp.
    FreeUp(Vec<freeup::Candidate>),
}

/// Comprueba el nodo (`error.invalidNode`, `action.trashRoot`) y toma del árbol lo que la acción necesita.
pub fn action_target(tree: &Tree, kind: ActionKind, id: u32) -> Result<ActionTarget, EngineMessage> {
    if !tree.live(id) {
        return Err(msg::invalid_node(id));
    }
    Ok(match kind {
        ActionKind::Trash if id == 0 => return Err(msg::trash_root()),
        ActionKind::FreeUp => ActionTarget::FreeUp(freeup::candidates(tree, id)),
        _ => ActionTarget::Path(tree.path_wide(id)),
    })
}

/// Ejecuta una acción sin el árbol. Los errores ya llevan su código (`action.failed`,
/// `action.cancelled`, `action.trashNotMoved`…); `trash` termina en `action.trashed` y `freeUp` en
/// `action.freedUp` o `action.nothingToFree`. Quitar del árbol lo enviado a la papelera es cosa de quien llama.
pub fn run_action(kind: ActionKind, target: &ActionTarget) -> ActionResult {
    let path = match target {
        ActionTarget::FreeUp(items) => return freeup::free_up(items),
        ActionTarget::Path(path) => path,
    };
    let r = match kind {
        ActionKind::Open => sys::open(path),
        ActionKind::Reveal => sys::reveal(path),
        ActionKind::Properties => sys::properties(path),
        ActionKind::Trash => sys::trash(path),
        // `action_target` da siempre ActionTarget::FreeUp
        ActionKind::FreeUp => Err(msg::internal("freeUp needs its candidates")),
    };
    match r {
        Ok(()) if kind == ActionKind::Trash => ActionResult::ok_with(msg::trashed()),
        Ok(()) => ActionResult::done(),
        Err(e) => ActionResult::fail(e),
    }
}

/// Ejecuta una acción sobre un nodo. Tras `trash` con éxito el nodo sale del árbol; `freeUp` no lo
/// cambia (el proveedor vacía los archivos más tarde).
pub fn action(tree: &mut Tree, kind: ActionKind, id: u32) -> ActionResult {
    let r = match action_target(tree, kind, id) {
        Ok(target) => run_action(kind, &target),
        Err(e) => return ActionResult::fail(e),
    };
    if r.ok && kind == ActionKind::Trash {
        let _ = tree.remove(id);
    }
    r
}
