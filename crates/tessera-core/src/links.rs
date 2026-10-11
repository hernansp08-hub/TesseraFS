//! Enlaces rotos (`brokenLinks`): enlaces simbólicos, uniones (junctions) y carpetas montadas bajo una
//! carpeta del árbol cuyo destino ya no existe. Cada candidato se comprueba en el momento sobre el disco;
//! no se cambia ni el árbol ni el disco.
//!
//! - Windows: candidatos = nodos con `flag::REPARSE`. La etiqueta se vuelve a leer de la carpeta que los
//!   contiene (`FindFirstFileExW` → `dwReserved0`, sin abrir el enlace) y sólo cuentan los enlaces
//!   simbólicos y las uniones o puntos de montaje ([`checks_tag`]). Roto = abrirlo siguiendo el enlace
//!   (`CreateFileW` con `FILE_FLAG_BACKUP_SEMANTICS` y acceso 0) falla con `ERROR_FILE_NOT_FOUND`,
//!   `ERROR_PATH_NOT_FOUND` o `ERROR_CANT_RESOLVE_FILENAME` (bucle); cualquier otro error (acceso
//!   denegado, red caída…) no permite saberlo y no se informa.
//! - Linux: candidatos = enlaces simbólicos (archivos con REPARSE; las carpetas montadas son DIR|REPARSE y
//!   no se miran). Roto = `stat` siguiendo el enlace falla con `ENOENT`, `ENOTDIR` o `ELOOP`.

use rayon::prelude::*;

use crate::attrs::{TAG_MOUNT_POINT, TAG_SYMLINK};
use crate::msg;
use crate::tree::Tree;
use crate::types::{flag, EngineMessage, SearchResponse, SearchRow};
use crate::NativePath;

/// Comprobaciones como mucho por petición: con más candidatos se miran los primeros y se avisa en el registro.
pub const MAX_CHECKS: usize = 200_000;

/// Etiquetas de reparse que se comprueban: las que sustituyen un nombre (bit 29) y Windows resuelve como
/// enlace, es decir, enlaces simbólicos y uniones o puntos de montaje. Fuera quedan las demás: enlaces de WSL
/// (`IO_REPARSE_TAG_LX_SYMLINK`, que Windows no sigue), las de contenedores, la nube, WOF, deduplicación y
/// alias de aplicaciones (`APPEXECLINK`).
pub fn checks_tag(tag: u32) -> bool {
    tag & 0x2000_0000 != 0 && (tag == TAG_SYMLINK || tag == TAG_MOUNT_POINT)
}

/// Candidato según las banderas del árbol (ver la cabecera del módulo).
fn is_candidate(flags: u16) -> bool {
    flags & flag::REPARSE != 0 && (cfg!(windows) || flags & flag::DIR == 0)
}

/// Candidatos vivos bajo `root` (incluido), con su ruta exacta, en preorden y como mucho [`MAX_CHECKS`].
/// `error.invalidNode` si `root` no vale. Sólo lee el árbol.
pub fn candidates(t: &Tree, root: u32) -> Result<Vec<(u32, NativePath)>, EngineMessage> {
    if !t.live(root) {
        return Err(msg::invalid_node(root));
    }
    let (mut out, mut seen) = (Vec::new(), 0usize);
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        if is_candidate(t.flags(id)) {
            seen += 1;
            if out.len() < MAX_CHECKS {
                out.push((id, crate::native_path(t, id)));
            }
        }
        if t.is_dir(id) {
            let kids = t.kids(id);
            for i in (0..kids.len()).rev() {
                stack.push(kids.get(i));
            }
        }
    }
    if seen > MAX_CHECKS {
        eprintln!("broken_links: {seen} links under {}; only the first {MAX_CHECKS} were checked", t.path(root));
    }
    Ok(out)
}

/// Ids de los candidatos cuyo destino ya no existe (en paralelo; sin el árbol).
pub fn check(items: &[(u32, NativePath)]) -> Vec<u32> {
    items.par_iter().filter(|(_, p)| imp::is_broken(p)).map(|&(id, _)| id).collect()
}

/// Clave de orden por ruta: sin distinguir mayúsculas y por componentes (el separador va antes que
/// cualquier carácter: `a\x` antes que `a b\y`), como el motor Bun.
fn path_key(path: &str, sep: char) -> String {
    path.to_lowercase().replace(sep, "\0")
}

/// La respuesta con los rotos que siguen vivos en el árbol: `total` y `totalBytes` de todos, `rows` = los
/// `limit` primeros por ruta.
pub fn response(t: &Tree, broken: Vec<u32>, limit: u32) -> SearchResponse {
    let sep = t.sep();
    let mut v: Vec<(String, String, u32)> = broken
        .into_iter()
        .filter(|&id| t.live(id))
        .map(|id| {
            let p = t.path(id);
            (path_key(&p, sep), p, id)
        })
        .collect();
    v.sort_unstable();
    let total = v.len() as u64;
    let total_bytes = v.iter().map(|&(_, _, id)| t.size(id)).sum();
    let rows = v.into_iter().take(limit as usize).map(|(_, path, id)| SearchRow { node: t.row(id), path }).collect();
    SearchResponse { total, total_bytes, rows, error: None }
}

/// Enlaces rotos bajo `root` de una vez (CLI y pruebas): el escritorio usa [`candidates`], [`check`] y
/// [`response`] para no tener el árbol bloqueado mientras mira el disco. Un nodo no válido va en `error`.
pub fn broken_links(t: &Tree, root: u32, limit: u32) -> SearchResponse {
    match candidates(t, root) {
        Ok(c) => response(t, check(&c), limit),
        Err(e) => SearchResponse { error: Some(e), ..Default::default() },
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, WIN32_FIND_DATAW,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{SetThreadErrorMode, SEM_FAILCRITICALERRORS, SEM_NOOPENFILEERRORBOX};

    use crate::attrs::ATTR_REPARSE;

    const ERROR_FILE_NOT_FOUND: u32 = 2;
    const ERROR_PATH_NOT_FOUND: u32 = 3;
    const ERROR_CANT_RESOLVE_FILENAME: u32 = 1921;

    /// Error al seguir el enlace que dice que el destino no existe (o que es un bucle).
    pub(super) fn is_broken_error(code: u32) -> bool {
        matches!(code, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND | ERROR_CANT_RESOLVE_FILENAME)
    }

    /// Atributos y etiqueta de reparse según la carpeta que lo contiene (no abre el enlace).
    fn find_data(path_z: &[u16]) -> Option<(u32, u32)> {
        let mut fd: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
        let h = unsafe {
            FindFirstFileExW(path_z.as_ptr(), FindExInfoBasic, &mut fd as *mut _ as *mut _, FindExSearchNameMatch, std::ptr::null(), 0)
        };
        if h == INVALID_HANDLE_VALUE {
            return None;
        }
        unsafe { FindClose(h) };
        Some((fd.dwFileAttributes, fd.dwReserved0))
    }

    pub(super) fn is_broken(path: &[u16]) -> bool {
        let mut p = crate::walk::verbatim_wide(path.to_vec());
        p.push(0);
        // Sin el diálogo «no hay disco en la unidad» si el destino está en una unidad extraíble vacía
        let mut old = 0;
        unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX, &mut old) };
        let r = match find_data(&p) {
            Some((attrs, tag)) if attrs & ATTR_REPARSE != 0 && super::checks_tag(tag) => {
                let h = unsafe {
                    CreateFileW(
                        p.as_ptr(),
                        0,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        std::ptr::null(),
                        OPEN_EXISTING,
                        FILE_FLAG_BACKUP_SEMANTICS,
                        std::ptr::null_mut(),
                    )
                };
                if h == INVALID_HANDLE_VALUE {
                    is_broken_error(unsafe { GetLastError() })
                } else {
                    unsafe { CloseHandle(h) };
                    false
                }
            }
            _ => false,
        };
        unsafe { SetThreadErrorMode(old, std::ptr::null_mut()) };
        r
    }
}

#[cfg(unix)]
mod imp {
    use std::path::Path;

    /// Error de `stat` siguiendo el enlace que dice que el destino no existe (o que es un bucle).
    pub(super) fn is_broken_error(code: i32) -> bool {
        matches!(code, libc::ENOENT | libc::ENOTDIR | libc::ELOOP)
    }

    pub(super) fn is_broken(path: &Path) -> bool {
        // Sigue siendo un enlace simbólico (no se quitó ni se cambió desde el escaneo)
        if !std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
        match std::fs::metadata(path) {
            Ok(_) => false,
            Err(e) => e.raw_os_error().is_some_and(is_broken_error),
        }
    }
}

#[cfg(not(any(windows, unix)))]
mod imp {
    pub(super) fn is_broken(_path: &std::path::Path) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{build, RawTree};
    use crate::tree::NONE;

    #[test]
    fn tags() {
        assert!(checks_tag(0xA000_000C), "enlace simbólico");
        assert!(checks_tag(0xA000_0003), "unión o punto de montaje");
        for tag in [
            crate::attrs::TAG_LX_SYMLINK, // WSL
            0x9000_001A, // nube
            0x9000_601A,
            0x8000_0017, // WOF
            0x8000_0013, // deduplicación
            0x8000_001B, // APPEXECLINK
            0xA000_001F, // tombstone de contenedores
            0xA000_0027, // WCI_LINK_1
            0,
        ] {
            assert!(!checks_tag(tag), "{tag:#X}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn broken_errors() {
        assert!(imp::is_broken_error(2) && imp::is_broken_error(3) && imp::is_broken_error(1921));
        assert!(!imp::is_broken_error(5) && !imp::is_broken_error(53) && !imp::is_broken_error(21), "acceso denegado, red, no preparado");
    }

    #[cfg(unix)]
    #[test]
    fn broken_errors() {
        assert!(imp::is_broken_error(libc::ENOENT) && imp::is_broken_error(libc::ENOTDIR) && imp::is_broken_error(libc::ELOOP));
        assert!(!imp::is_broken_error(libc::EACCES) && !imp::is_broken_error(libc::EIO));
    }

    /// root ─ b\ ─ Zeta (enlace), alfa (enlace) ; a b\ (enlace, carpeta) ; c.txt ; d (enlace, archivo)
    fn sample() -> Tree {
        let mut r = RawTree::with_capacity(8);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        let b = r.push(root, b"b", 0, 0, 0, flag::DIR);
        r.push(b, b"Zeta", 10, 0, 0, flag::REPARSE);
        r.push(b, b"alfa", 20, 0, 0, flag::REPARSE);
        r.push(root, b"a b", 0, 0, 0, flag::DIR | flag::REPARSE);
        r.push(root, b"c.txt", 5, 0, 0, 0);
        r.push(root, b"d", 3, 0, 0, flag::REPARSE);
        r.root = root;
        build(r, if cfg!(windows) { "C:\\x".into() } else { "/x".into() }, &[]).unwrap()
    }

    fn find(t: &Tree, name: &str) -> u32 {
        (0..t.len() as u32).find(|&i| t.name(i) == name).unwrap()
    }

    #[test]
    fn candidates_and_response() {
        let t = sample();
        let names = |ids: Vec<u32>| ids.into_iter().map(|i| t.name(i).into_owned()).collect::<Vec<_>>();
        let mut c = names(candidates(&t, 0).unwrap().into_iter().map(|(id, _)| id).collect());
        c.sort();
        // En Linux, una carpeta con REPARSE es un punto de montaje: no se mira
        let want: &[&str] = if cfg!(windows) { &["Zeta", "a b", "alfa", "d"] } else { &["Zeta", "alfa", "d"] };
        assert_eq!(c, want);
        // El propio root cuenta si es un enlace
        assert_eq!(names(candidates(&t, find(&t, "d")).unwrap().into_iter().map(|(id, _)| id).collect()), ["d"]);
        assert_eq!(candidates(&t, 999).unwrap_err().code, "error.invalidNode");
        assert_eq!(broken_links(&t, 999, 10).error.unwrap().code, "error.invalidNode");
        // Orden por ruta sin distinguir mayúsculas y por componentes; total y bytes de todos; `limit` filas
        let all = ["Zeta", "alfa", "a b", "d"].map(|n| find(&t, n)).to_vec();
        let r = response(&t, all.clone(), 10);
        let s = if cfg!(windows) { "\\" } else { "/" };
        let paths: Vec<String> = r.rows.iter().map(|x| x.path.clone()).collect();
        let root = t.root_path();
        assert_eq!(paths, [format!("{root}{s}a b"), format!("{root}{s}b{s}alfa"), format!("{root}{s}b{s}Zeta"), format!("{root}{s}d")]);
        assert_eq!((r.total, r.total_bytes, r.error.is_none()), (4, 33, true));
        assert_eq!(r.rows[2].node.name, "Zeta");
        let r = response(&t, all, 1);
        assert_eq!((r.total, r.total_bytes, r.rows.len()), (4, 33, 1));
        assert_eq!(response(&t, Vec::new(), 10).total, 0);
        // En el árbol no queda nada que no exista en el disco: ninguno roto
        assert_eq!(broken_links(&t, 0, 10).total, 0);
    }

    #[test]
    fn dead_nodes_are_dropped() {
        let mut t = sample();
        let (b, d) = (find(&t, "b"), find(&t, "d"));
        t.remove(b).unwrap();
        let r = response(&t, vec![find(&t, "Zeta"), d], 10);
        assert_eq!((r.total, r.rows[0].node.name.as_str()), (1, "d"));
        assert_eq!(names_of(candidates(&t, 0).unwrap()), if cfg!(windows) { vec!["a b", "d"] } else { vec!["d"] });
    }

    fn names_of(c: Vec<(u32, NativePath)>) -> Vec<String> {
        let mut v: Vec<String> = c
            .into_iter()
            .map(|(_, p)| {
                #[cfg(windows)]
                let s = String::from_utf16_lossy(&p);
                #[cfg(not(windows))]
                let s = p.to_string_lossy().into_owned();
                s.rsplit(['\\', '/']).next().unwrap().to_string()
            })
            .collect();
        v.sort();
        v
    }
}
