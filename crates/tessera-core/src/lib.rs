//! tessera-core: motor de TesseraFS.
//!
//! - [`scan::scan`] escanea una ruta con el motor MFT (NTFS + administrador) o con el
//!   recorrido de directorios (en Linux, [`walk_unix`]), y devuelve un [`tree::Tree`] compacto.
//! - [`slice::encode_slice`], [`ops::children`], [`ops::search`] y [`ops::ext_stats`]
//!   responden a la interfaz según el contrato de `docs/ARQUITECTURA.md`.
//! - [`dup::duplicates`] busca archivos duplicados (tamaño, primeros 64 KiB y BLAKE3 completo).
//! - [`history::History`] guarda resúmenes de los escaneos y compara el escaneo cargado con uno de ellos.
//! - [`export`] guarda los archivos exportados en Descargas\TesseraFS (Linux: descargas de XDG).
//! - [`rescan`] vuelve a escanear una carpeta del árbol cargado y actualiza con el diario USN ([`usn`]).
//! - [`action`] abre, muestra, envía a la papelera o libera espacio de OneDrive ([`freeup`]); en Linux,
//!   sólo abrir, mostrar y papelera ([`system_info`]).

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
#[cfg(any(unix, test))]
pub mod posix;
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
#[cfg(unix)]
pub mod walk_unix;

pub use dup::duplicates;
pub use history::{Comparison, History};
pub use rescan::{refresh, refresh_shared, rescan, rescan_shared};
pub use scan::{scan, Progress, Scan, ScanOptions};
pub use tree::Tree;
pub use types::*;

/// Ruta exacta de un nodo para las acciones del sistema: UTF-16 sin terminador en Windows (admite
/// suplentes sueltos y nombres con punto o espacio final), `PathBuf` en el resto. En Linux los nombres
/// que no son UTF-8 se guardan con pérdida (U+FFFD), así que las acciones sobre ellos fallan con
/// `action.failed` (limitación conocida).
#[cfg(windows)]
pub type NativePath = Vec<u16>;
#[cfg(not(windows))]
pub type NativePath = std::path::PathBuf;

/// [`NativePath`] del nodo `id`.
#[cfg(windows)]
pub fn native_path(tree: &Tree, id: u32) -> NativePath {
    tree.path_wide(id)
}

/// [`NativePath`] del nodo `id`.
#[cfg(not(windows))]
pub fn native_path(tree: &Tree, id: u32) -> NativePath {
    std::path::PathBuf::from(tree.path(id))
}

/// La plataforma para la interfaz: sistema, separador de rutas y acciones disponibles (Windows: open,
/// reveal, properties, trash y freeUp; Linux: open, reveal y trash).
pub fn system_info() -> SystemInfo {
    use ActionKind::*;
    if cfg!(windows) {
        SystemInfo { os: Os::Windows, sep: "\\".into(), actions: vec![Open, Reveal, Properties, Trash, FreeUp] }
    } else {
        let os = if cfg!(target_os = "macos") { Os::Macos } else { Os::Linux };
        SystemInfo { os, sep: "/".into(), actions: vec![Open, Reveal, Trash] }
    }
}

/// Lo que una acción necesita del árbol: se toma bajo lectura y la acción corre después sin bloquearlo.
pub enum ActionTarget {
    /// Ruta exacta del nodo ([`NativePath`]): open, reveal, properties y trash.
    Path(NativePath),
    /// Archivos y carpetas de la nube bajo el nodo: freeUp.
    FreeUp(Vec<freeup::Candidate>),
}

/// Comprueba el nodo (`error.invalidNode`, `action.trashRoot`) y toma del árbol lo que la acción necesita.
/// Las acciones que la plataforma no tiene (Linux: properties y freeUp) dan `error.unsupportedPlatform`.
pub fn action_target(tree: &Tree, kind: ActionKind, id: u32) -> Result<ActionTarget, EngineMessage> {
    if !tree.live(id) {
        return Err(msg::invalid_node(id));
    }
    if !system_info().actions.contains(&kind) {
        return Err(msg::unsupported_platform());
    }
    Ok(match kind {
        ActionKind::Trash if id == 0 => return Err(msg::trash_root()),
        ActionKind::FreeUp => ActionTarget::FreeUp(freeup::candidates(tree, id)),
        _ => ActionTarget::Path(native_path(tree, id)),
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
