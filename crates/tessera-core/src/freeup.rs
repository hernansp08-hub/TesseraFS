//! Liberar espacio de OneDrive (acción `freeUp`): los archivos de la nube descargados pasan a
//! «sólo en línea» con `SetFileAttributesW` (`attrib +U -P`, lo mismo que «Liberar espacio» del
//! Explorador). El proveedor los vacía después, en segundo plano: siguen en la nube y vuelven a
//! bajar al abrirlos. Nunca se borra nada y el árbol no cambia (la interfaz vuelve a escanear la
//! carpeta pasados unos segundos).

use crate::attrs::{
    ATTR_ARCHIVE, ATTR_HIDDEN, ATTR_NOT_CONTENT_INDEXED, ATTR_OFFLINE, ATTR_PINNED, ATTR_READONLY, ATTR_RECALL_ON_DATA_ACCESS, ATTR_SYSTEM,
    ATTR_TEMPORARY, ATTR_UNPINNED,
};
use crate::msg;
use crate::sys;
use crate::tree::Tree;
use crate::types::{flag, ActionResult, EngineMessage};

/// Atributos que admite `SetFileAttributesW` y que se conservan; el resto sale de la máscara.
pub const SETTABLE: u32 = ATTR_READONLY
    | ATTR_HIDDEN
    | ATTR_SYSTEM
    | ATTR_ARCHIVE
    | ATTR_TEMPORARY
    | ATTR_OFFLINE
    | ATTR_NOT_CONTENT_INDEXED
    | ATTR_PINNED
    | ATTR_UNPINNED;

/// Atributos que dejan «sólo en línea» un elemento con atributos `attrs`: sin PINNED, con UNPINNED
/// y sin los bits que no se pueden fijar. `None` si ya lo está (OFFLINE o RECALL_ON_DATA_ACCESS).
pub fn online_only_attrs(attrs: u32) -> Option<u32> {
    if attrs & (ATTR_OFFLINE | ATTR_RECALL_ON_DATA_ACCESS) != 0 {
        return None;
    }
    Some((attrs & SETTABLE & !ATTR_PINNED) | ATTR_UNPINNED)
}

/// Un elemento de la nube bajo el nodo pedido, con su ruta exacta.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// UTF-16 sin terminador (como `Tree::path_wide`).
    pub path: Vec<u16>,
    /// Espacio asignado, lo que se liberará; 0 en las carpetas.
    pub alloc: u64,
    pub is_dir: bool,
}

/// El nodo `id` y sus descendientes vivos con `flag::CLOUD`, en preorden: archivos descargados
/// (`alloc > 0`) y carpetas (se marcan para que lo nuevo llegue «sólo en línea», pero no cuentan).
/// Se recorre todo el subárbol: puede haber nube bajo carpetas que no lo son.
pub fn candidates(t: &Tree, id: u32) -> Vec<Candidate> {
    let mut out = Vec::new();
    if !t.live(id) {
        return out;
    }
    let mut stack = vec![id];
    while let Some(n) = stack.pop() {
        let dir = t.is_dir(n);
        if t.flags(n) & flag::CLOUD != 0 && (dir || t.alloc(n) > 0) {
            out.push(Candidate { path: t.path_wide(n), alloc: if dir { 0 } else { t.alloc(n) }, is_dir: dir });
        }
        let kids = t.kids(n);
        stack.extend((0..kids.len()).rev().map(|i| kids.get(i)));
    }
    out
}

/// Pasa los candidatos a «sólo en línea» (sin el árbol: se puede llamar sin bloquearlo).
pub fn free_up(items: &[Candidate]) -> ActionResult {
    apply(items, sys::file_attributes, sys::set_file_attributes)
}

/// [`free_up`] con las operaciones de atributos aparte (las pruebas no tocan archivos). Sin archivos
/// descargados no se toca nada. Primero los archivos y después las carpetas: así marcar una carpeta
/// no hace que el proveedor se adelante y el recuento sale exacto. Resultado:
/// - algún archivo cambiado → `action.freedUp {count, bytes}` (asignado de los cambiados);
/// - ninguno y algo falló → el primer error (`action.failed`, archivos antes que carpetas);
/// - si no (los descargados ya no lo estaban) → `action.nothingToFree`.
fn apply(
    items: &[Candidate],
    mut get: impl FnMut(&[u16]) -> Result<u32, EngineMessage>,
    mut set: impl FnMut(&[u16], u32) -> Result<(), EngineMessage>,
) -> ActionResult {
    if items.iter().all(|c| c.is_dir) {
        return ActionResult::fail(msg::nothing_to_free());
    }
    let (mut count, mut bytes, mut first_err) = (0u64, 0u64, None);
    let (files, dirs) = (items.iter().filter(|c| !c.is_dir), items.iter().filter(|c| c.is_dir));
    for c in files.chain(dirs) {
        let changed = get(&c.path).and_then(|a| match online_only_attrs(a) {
            Some(new) => set(&c.path, new).map(|()| true),
            None => Ok(false),
        });
        match changed {
            Ok(true) if !c.is_dir => {
                count += 1;
                bytes += c.alloc;
            }
            Ok(_) => {}
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    match first_err {
        _ if count > 0 => ActionResult::ok_with(msg::freed_up(count, bytes)),
        Some(e) => ActionResult::fail(e),
        None => ActionResult::fail(msg::nothing_to_free()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attrs::{ATTR_COMPRESSED, ATTR_DIRECTORY, ATTR_RECALL_ON_OPEN, ATTR_REPARSE, ATTR_SPARSE};
    use crate::build::{build, RawTree};
    use crate::tree::NONE;
    use crate::types::Param;
    use std::collections::HashMap;

    #[test]
    fn attribute_math() {
        // PINNED fuera, UNPINNED dentro, los ajustables se conservan
        assert_eq!(online_only_attrs(ATTR_ARCHIVE), Some(ATTR_ARCHIVE | ATTR_UNPINNED));
        assert_eq!(online_only_attrs(ATTR_ARCHIVE | ATTR_PINNED), Some(ATTR_ARCHIVE | ATTR_UNPINNED));
        let keep = ATTR_READONLY | ATTR_HIDDEN | ATTR_SYSTEM | ATTR_ARCHIVE | ATTR_TEMPORARY | ATTR_NOT_CONTENT_INDEXED;
        assert_eq!(online_only_attrs(keep | ATTR_PINNED), Some(keep | ATTR_UNPINNED));
        // Ya UNPINNED pero aún descargado (el proveedor no lo ha vaciado): se vuelve a fijar
        assert_eq!(online_only_attrs(ATTR_UNPINNED), Some(ATTR_UNPINNED));
        // Bits que no se pueden fijar: fuera (carpeta, reanálisis, disperso, comprimido, cifrado, RECALL_ON_OPEN…)
        let fixed = ATTR_DIRECTORY | ATTR_REPARSE | ATTR_SPARSE | ATTR_COMPRESSED | 0x4000 | 0x8000 | ATTR_RECALL_ON_OPEN | 0x8000_0000;
        assert_eq!(online_only_attrs(fixed | ATTR_HIDDEN | ATTR_PINNED), Some(ATTR_HIDDEN | ATTR_UNPINNED));
        assert_eq!(online_only_attrs(0), Some(ATTR_UNPINNED));
        // Ya «sólo en línea»: se salta
        assert_eq!(online_only_attrs(ATTR_OFFLINE), None);
        assert_eq!(online_only_attrs(ATTR_RECALL_ON_DATA_ACCESS | ATTR_ARCHIVE | ATTR_PINNED), None);
        assert_eq!(online_only_attrs(ATTR_OFFLINE | ATTR_UNPINNED), None);
    }

    /// Árbol de usuario con OneDrive: descargados, sólo en línea, una carpeta sin nube con un archivo
    /// de la nube dentro y un archivo de la nube ya enviado a la papelera.
    fn sample() -> Tree {
        let c = flag::CLOUD;
        let mut r = RawTree::with_capacity(16);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        let od = r.push(root, b"OneDrive", 0, 0, 0, flag::DIR | c);
        r.push(od, b"a.docx", 4000, 4096, 0, c);
        r.push(od, b"b.pdf", 90_000, 0, 0, c);
        let fotos = r.push(od, b"Fotos", 0, 0, 0, flag::DIR | c);
        r.push(fotos, b"c.jpg", 8000, 8192, 0, c);
        r.push(fotos, b"papelera.jpg", 100, 4096, 0, c);
        let docs = r.push(root, b"Docs", 0, 0, 0, flag::DIR);
        r.push(docs, b"d.txt", 100, 4096, 0, 0);
        r.push(docs, b"e.xlsx", 1000, 1024, 0, c | flag::HIDDEN);
        r.push(root, b"f.bin", 50, 4096, 0, 0);
        r.root = root;
        let mut t = build(r, "C:\\Users\\u".into(), &[]).unwrap();
        t.remove(id(&t, "papelera.jpg")).unwrap();
        t
    }

    fn id(t: &Tree, name: &str) -> u32 {
        (0..t.len() as u32).find(|&i| t.name(i) == name).unwrap()
    }

    fn paths(v: &[Candidate]) -> Vec<String> {
        v.iter().map(|c| String::from_utf16(&c.path).unwrap()).collect()
    }

    #[test]
    fn candidate_selection() {
        let t = sample();
        let all = candidates(&t, 0);
        let p = paths(&all);
        let mut sorted = p.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            [
                "C:\\Users\\u\\Docs\\e.xlsx",
                "C:\\Users\\u\\OneDrive",
                "C:\\Users\\u\\OneDrive\\Fotos",
                "C:\\Users\\u\\OneDrive\\Fotos\\c.jpg",
                "C:\\Users\\u\\OneDrive\\a.docx",
            ]
        );
        // Cada carpeta antes que lo que contiene
        let at = |s: &str| p.iter().position(|x| x.ends_with(s)).unwrap();
        assert!(at("OneDrive") < at("a.docx") && at("OneDrive") < at("Fotos") && at("Fotos") < at("c.jpg"));
        // Asignado de los archivos; las carpetas, 0
        let get = |s: &str| &all[at(s)];
        assert_eq!((get("a.docx").alloc, get("a.docx").is_dir), (4096, false));
        assert_eq!((get("Fotos").alloc, get("Fotos").is_dir), (0, true));
        assert_eq!(all.iter().filter(|c| !c.is_dir).map(|c| c.alloc).sum::<u64>(), 4096 + 8192 + 1024);
        // Sobre un archivo o una carpeta concretos
        assert_eq!(paths(&candidates(&t, id(&t, "a.docx"))), ["C:\\Users\\u\\OneDrive\\a.docx"]);
        assert!(candidates(&t, id(&t, "b.pdf")).is_empty(), "sólo en línea (asignado 0)");
        assert!(candidates(&t, id(&t, "f.bin")).is_empty(), "sin FLAG.CLOUD");
        assert_eq!(paths(&candidates(&t, id(&t, "Docs"))), ["C:\\Users\\u\\Docs\\e.xlsx"]);
        assert_eq!(candidates(&t, id(&t, "Fotos")).len(), 2, "la carpeta y c.jpg; no lo enviado a la papelera");
        assert!(candidates(&t, id(&t, "papelera.jpg")).is_empty());
        assert!(candidates(&t, 999).is_empty());
    }

    /// Sistema de archivos falso: atributos por ruta; `fail` = rutas cuyo cambio falla.
    struct Fake {
        attrs: HashMap<String, u32>,
        fail: Vec<&'static str>,
        calls: Vec<String>,
    }

    fn item(path: &str, alloc: u64, is_dir: bool) -> Candidate {
        Candidate { path: path.encode_utf16().collect(), alloc, is_dir }
    }

    fn run(fs: &mut Fake, items: &[Candidate]) -> ActionResult {
        let attrs = std::cell::RefCell::new(std::mem::take(&mut fs.attrs));
        let calls = std::cell::RefCell::new(Vec::new());
        let fail = fs.fail.clone();
        let key = |p: &[u16]| String::from_utf16(p).unwrap();
        let r = apply(
            items,
            |p| attrs.borrow().get(&key(p)).copied().ok_or_else(|| msg::action_failed("The system cannot find the file specified.")),
            |p, a| {
                calls.borrow_mut().push(key(p));
                if fail.contains(&key(p).as_str()) {
                    return Err(msg::action_failed("Access is denied."));
                }
                attrs.borrow_mut().insert(key(p), a);
                Ok(())
            },
        );
        fs.attrs = attrs.into_inner();
        fs.calls = calls.into_inner();
        r
    }

    #[test]
    fn apply_results() {
        let mut fs = Fake {
            attrs: HashMap::from([
                ("od".to_string(), ATTR_DIRECTORY | ATTR_PINNED),
                ("a".to_string(), ATTR_ARCHIVE | ATTR_PINNED),
                ("c".to_string(), ATTR_ARCHIVE),
                ("solo".to_string(), ATTR_ARCHIVE | ATTR_RECALL_ON_DATA_ACCESS),
                ("roto".to_string(), ATTR_ARCHIVE),
            ]),
            fail: vec!["roto"],
            calls: Vec::new(),
        };
        let items = [
            item("od", 0, true),
            item("a", 4096, false),
            item("solo", 4096, false),
            item("no-existe", 4096, false),
            item("roto", 4096, false),
            item("c", 8192, false),
        ];
        // Dos cambiados (los fallos y lo ya «sólo en línea» no cuentan; la carpeta tampoco)
        let r = run(&mut fs, &items);
        assert!(r.ok);
        assert_eq!(r.code.as_deref(), Some("action.freedUp"));
        let p = r.params.unwrap();
        assert_eq!((p["count"].clone(), p["bytes"].clone()), (Param::Int(2), Param::Int(4096 + 8192)));
        assert_eq!(fs.attrs["a"], ATTR_ARCHIVE | ATTR_UNPINNED);
        assert_eq!(fs.attrs["od"], ATTR_UNPINNED);
        assert_eq!(fs.attrs["solo"], ATTR_ARCHIVE | ATTR_RECALL_ON_DATA_ACCESS);
        // Primero los archivos, después las carpetas; nunca SetFileAttributesW en lo que se salta
        assert_eq!(fs.calls, ["a", "roto", "c", "od"]);

        // Ya todo «sólo en línea»: nada que liberar (la carpeta sí se marca)
        fs.attrs.insert("od".into(), ATTR_DIRECTORY | ATTR_PINNED);
        let r = run(&mut fs, &[item("od", 0, true), item("solo", 4096, false)]);
        assert_eq!((r.ok, r.code.as_deref(), r.params), (false, Some("action.nothingToFree"), None));
        assert_eq!((fs.calls.as_slice(), fs.attrs["od"]), (["od".to_string()].as_slice(), ATTR_UNPINNED));
        // Sin archivos descargados no se toca nada
        fs.attrs.insert("od".into(), ATTR_DIRECTORY | ATTR_PINNED);
        let r = run(&mut fs, &[item("od", 0, true)]);
        assert_eq!((r.code.as_deref(), fs.calls.len(), fs.attrs["od"]), (Some("action.nothingToFree"), 0, ATTR_DIRECTORY | ATTR_PINNED));
        assert_eq!(run(&mut fs, &[]).code.as_deref(), Some("action.nothingToFree"));
        // Ningún archivo cambiado y una carpeta que falla: su error
        fs.fail = vec!["od", "roto", "c"];
        let r = run(&mut fs, &[item("od", 0, true), item("solo", 4096, false)]);
        assert_eq!((r.code.as_deref(), r.message.as_deref()), (Some("action.failed"), Some("Access is denied.")));
        // Todos fallaron: el primer error de los archivos (texto del sistema)
        let r = run(&mut fs, &[item("od", 0, true), item("no-existe", 1, false), item("roto", 1, false), item("c", 1, false)]);
        assert!(!r.ok);
        assert_eq!(r.code.as_deref(), Some("action.failed"));
        assert_eq!(r.message.as_deref(), Some("The system cannot find the file specified."));
        assert_eq!(r.params.unwrap()["error"], Param::Str("The system cannot find the file specified.".into()));
    }

    /// De principio a fin sobre archivos temporales creados aquí (nunca sobre archivos del usuario):
    /// escaneo real, FLAG.CLOUD puesto a mano y SetFileAttributesW con rutas exactas.
    #[cfg(windows)]
    #[test]
    fn free_up_temp_files() {
        use crate::scan::ScanOptions;
        use crate::types::{ActionKind, EngineChoice};
        use std::os::windows::ffi::OsStrExt;
        let dir = std::env::temp_dir().join(format!("tessera-freeup-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        struct Clean(std::path::PathBuf);
        impl Drop for Clean {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _clean = Clean(dir.clone());
        // PINNED/UNPINNED: sólo en NTFS
        let root = dir.to_string_lossy().into_owned();
        if sys::volume_root_of(&root).and_then(|v| sys::volume_info(&v)).is_none_or(|v| v.fs != "NTFS") {
            eprintln!("free_up_temp_files: la carpeta temporal no está en NTFS; se omite");
            return;
        }
        let data = vec![7u8; 20_000];
        for f in ["a.bin", "sub\\b.bin", "solo.bin", "normal.bin"] {
            std::fs::write(dir.join(f), &data).unwrap();
        }
        // Nombre con punto y espacio finales: sólo se alcanza con la ruta exacta (\\?\)
        let odd = format!("\\\\?\\{root}\\raro. ");
        std::fs::write(&odd, &data).unwrap();
        let w = |p: &std::path::Path| p.as_os_str().encode_wide().collect::<Vec<u16>>();
        sys::set_file_attributes(&w(&dir.join("a.bin")), ATTR_ARCHIVE | ATTR_PINNED).unwrap();
        sys::set_file_attributes(&w(&dir.join("solo.bin")), ATTR_ARCHIVE | ATTR_OFFLINE).unwrap();

        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut s = crate::scan::scan(&root, EngineChoice::Walk, &ScanOptions::default(), &|_| {}, &cancel).unwrap();
        let t = &mut s.tree;
        let find = |t: &Tree, n: &str| (0..t.len() as u32).find(|&i| t.name(i) == n).unwrap_or_else(|| panic!("no está {n}"));
        for n in ["sub", "a.bin", "b.bin", "solo.bin", "raro. "] {
            let i = find(t, n);
            t.flags[i as usize] |= flag::CLOUD;
        }
        let expected = ["a.bin", "b.bin", "raro. "].iter().map(|n| t.alloc(find(t, n))).sum::<u64>();
        assert!(expected >= 3 * 20_000);
        let before = (t.size(0), t.alloc(0), t.files(0));

        let r = crate::action(t, ActionKind::FreeUp, 0);
        assert!(r.ok, "{:?}", r.message);
        assert_eq!(r.code.as_deref(), Some("action.freedUp"));
        let p = r.params.unwrap();
        assert_eq!((p["count"].clone(), p["bytes"].clone()), (Param::Int(3), Param::Int(expected as i64)));
        let attrs = |p: &[u16]| sys::file_attributes(p).unwrap();
        for f in [w(&dir.join("a.bin")), w(&dir.join("sub")), w(&dir.join("sub\\b.bin")), odd.encode_utf16().collect()] {
            let a = attrs(&f);
            assert_eq!(a & (ATTR_UNPINNED | ATTR_PINNED), ATTR_UNPINNED, "{}", String::from_utf16_lossy(&f));
        }
        assert_eq!(attrs(&w(&dir.join("a.bin"))) & ATTR_ARCHIVE, ATTR_ARCHIVE);
        assert_eq!(attrs(&w(&dir.join("solo.bin"))) & ATTR_UNPINNED, 0, "ya «sólo en línea»: se salta");
        assert_eq!(attrs(&w(&dir.join("normal.bin"))) & ATTR_UNPINNED, 0, "sin FLAG.CLOUD");
        // El árbol no cambia
        assert_eq!((t.size(0), t.alloc(0), t.files(0)), before);
        assert!(t.live(find(t, "a.bin")));
        // Sobre un archivo sin FLAG.CLOUD
        let n = find(t, "normal.bin");
        assert_eq!(crate::action(t, ActionKind::FreeUp, n).code.as_deref(), Some("action.nothingToFree"));
    }
}
