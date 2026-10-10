//! Pruebas del motor de recorrido sobre carpetas temporales creadas aquí mismo.
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use tessera_core::types::flag;
use tessera_core::{ops, scan, ActionKind, EngineChoice, ScanOptions, Tree};

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("tessera-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn file(&self, rel: &str, len: usize) -> PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![7u8; len]).unwrap();
        p
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn find(t: &Tree, path: &Path) -> u32 {
    let want = path.to_string_lossy().replace('/', "\\").to_lowercase();
    (0..t.len() as u32).find(|&i| t.path(i).to_lowercase() == want).unwrap_or_else(|| panic!("no está {want}"))
}

fn run(p: &Path) -> tessera_core::Scan {
    let cancel = AtomicBool::new(false);
    scan(&p.to_string_lossy(), EngineChoice::Walk, &ScanOptions::default(), &|_| {}, &cancel).unwrap()
}

#[test]
fn walk_counts_links_and_junctions() {
    let d = TempDir::new("walk");
    let a = d.file("a.bin", 10_000);
    d.file("sub/b.txt", 100);
    d.file("sub/deep/c.DAT", 5_000);
    d.file("sub/deep/ñandú 😀.txt", 3);
    std::fs::create_dir_all(d.0.join("vacía")).unwrap();
    std::fs::hard_link(&a, d.0.join("sub/a-enlace.bin")).unwrap();
    // Junction hacia sub: no debe seguirse
    let ok = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(d.0.join("junction"))
        .arg(d.0.join("sub"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let s = run(&d.0);
    let t = &s.tree;
    assert_eq!(s.result.files, 5, "a.bin, b.txt, c.DAT, ñandú, enlace");
    assert_eq!(s.result.dirs, 3 + ok as u64, "sub, deep, vacía (+ junction)");
    assert_eq!(s.result.bytes, 10_000 * 2 + 100 + 5_000 + 3);
    let a_id = find(t, &a);
    let l_id = find(t, &d.0.join("sub/a-enlace.bin"));
    // Un nombre lleva el asignado y el otro queda marcado como enlace duro
    let (with, without) = if t.flags(a_id) & flag::HARDLINK != 0 { (l_id, a_id) } else { (a_id, l_id) };
    assert!(t.alloc(with) >= 10_000);
    assert_eq!(t.alloc(without), 0);
    assert_eq!(t.flags(without) & flag::HARDLINK, flag::HARDLINK);
    let c = find(t, &d.0.join("sub/deep/c.DAT"));
    assert_eq!(t.ext(c), "dat");
    assert_eq!(t.name(find(t, &d.0.join("sub/deep/ñandú 😀.txt"))), "ñandú 😀.txt");
    if ok {
        let j = find(t, &d.0.join("junction"));
        assert!(t.is_dir(j));
        assert_eq!(t.flags(j) & flag::REPARSE, flag::REPARSE);
        assert_eq!(t.child_count(j), 0);
    }
    // Hijos contiguos y ordenados por tamaño desc
    let k = t.kids(0).to_vec();
    assert!(k.windows(2).all(|w| t.size(w[0]) >= t.size(w[1])));
    assert_eq!(t.name(k[0]), "sub"); // 10.000 (enlace) + 5.103
    // Búsqueda con ruta completa
    let r = ops::search(t, "path:deep", 0, 10);
    assert_eq!(r.total, 2);
}

#[test]
fn access_denied_does_not_abort() {
    // System32 tiene subcarpetas protegidas: el escaneo termina y avisa
    let details = std::sync::Mutex::new(Vec::new());
    let cancel = AtomicBool::new(false);
    let cb = |p: tessera_core::ScanProgress| details.lock().unwrap().extend(p.detail);
    let s = scan(r"C:\Windows\System32", EngineChoice::Walk, &ScanOptions::default(), &cb, &cancel).unwrap();
    assert_eq!(s.result.root_path, r"C:\Windows\System32");
    assert!(s.result.files > 1000);
    let w = s.result.warnings.iter().find(|w| w.code == "scan.accessDenied" || w.code == "scan.readErrors").expect("aviso de carpetas ilegibles");
    assert!(matches!(w.get("count"), Some(tessera_core::Param::Int(n)) if *n > 0));
    // `detail` del progreso: sólo rutas, nunca frases
    assert!(details.into_inner().unwrap().iter().all(|d| d.starts_with(r"C:\Windows\System32")));
}

#[test]
fn coded_errors() {
    let d = TempDir::new("errores");
    let f = d.file("archivo.txt", 10);
    let run_err = |p: &str| {
        let cancel = AtomicBool::new(false);
        scan(p, EngineChoice::Auto, &ScanOptions::default(), &|_| {}, &cancel).err().expect("debía fallar")
    };
    assert_eq!(run_err("").code, "error.invalidPath");
    let e = run_err(&f.to_string_lossy());
    assert_eq!(e.code, "error.notFolder");
    assert_eq!(e.get("path"), Some(&tessera_core::Param::Str(f.to_string_lossy().into_owned())));
    let e = run_err(&d.0.join("no-existe").to_string_lossy());
    assert_eq!(e.code, "error.cannotOpen");
    assert!(e.get("error").is_some());
    // Cancelado antes de empezar
    let cancel = AtomicBool::new(true);
    let e = scan(&d.0.to_string_lossy(), EngineChoice::Walk, &ScanOptions::default(), &|_| {}, &cancel).err().unwrap();
    assert_eq!(e.code, "error.cancelled");
    // Acciones sin efectos: raíz a la papelera, id desconocido y archivo que ya no existe
    let mut s = run(&d.0);
    let r = tessera_core::action(&mut s.tree, ActionKind::Trash, 0);
    assert_eq!((r.ok, r.code.as_deref()), (false, Some("action.trashRoot")));
    let r = tessera_core::action(&mut s.tree, ActionKind::Open, 999_999);
    assert_eq!((r.ok, r.code.as_deref()), (false, Some("error.invalidNode")));
    let id = find(&s.tree, &f);
    std::fs::remove_file(&f).unwrap();
    let r = tessera_core::action(&mut s.tree, ActionKind::Trash, id);
    assert_eq!((r.ok, r.code.as_deref()), (false, Some("action.failed")));
    assert!(r.params.unwrap().contains_key("error"));
    assert!(s.tree.live(id), "un fallo no quita el nodo");
}

#[test]
fn free_up_without_cloud_files() {
    let d = TempDir::new("liberar");
    let f = d.file("sub/a.bin", 20_000);
    d.file("b.txt", 10);
    let mut s = run(&d.0);
    // Sin archivos de la nube no hay candidatos: nunca se llega a SetFileAttributesW
    assert!(tessera_core::freeup::candidates(&s.tree, 0).is_empty(), "la carpeta temporal no debía tener archivos de la nube");
    let before = (s.tree.size(0), s.tree.alloc(0), s.tree.files(0));
    for id in [0, find(&s.tree, &d.0.join("sub")), find(&s.tree, &f)] {
        let r = tessera_core::action(&mut s.tree, ActionKind::FreeUp, id);
        assert_eq!((r.ok, r.code.as_deref(), r.params.is_none()), (false, Some("action.nothingToFree"), true));
        assert!(r.message.is_some());
    }
    assert_eq!((s.tree.size(0), s.tree.alloc(0), s.tree.files(0)), before, "el árbol no cambia");
    let r = tessera_core::action(&mut s.tree, ActionKind::FreeUp, 999_999);
    assert_eq!((r.ok, r.code.as_deref()), (false, Some("error.invalidNode")));
}

/// Envía un archivo temporal a la Papelera: `cargo test -- --ignored papelera`.
#[test]
#[ignore]
fn papelera_quita_el_nodo() {
    let d = TempDir::new("papelera");
    let f = d.file("x/borrame.bin", 50_000);
    d.file("x/queda.bin", 10);
    let mut s = run(&d.0);
    let id = find(&s.tree, &f);
    let before = s.tree.size(0);
    let r = tessera_core::action(&mut s.tree, ActionKind::Trash, id);
    assert!(r.ok, "{:?}", r.message);
    assert_eq!(r.code.as_deref(), Some("action.trashed"));
    assert!(!f.exists());
    assert_eq!(s.tree.size(0), before - 50_000);
    assert_eq!(s.tree.files(0), 1);
    assert_eq!(ops::search(&s.tree, "borrame", 0, 5).total, 0);
    let x = s.tree.parent(id).unwrap();
    assert_eq!(s.tree.child_count(x), 1);
    // Un id ya quitado no admite más acciones
    assert!(!tessera_core::action(&mut s.tree, ActionKind::Open, id).ok);
}
