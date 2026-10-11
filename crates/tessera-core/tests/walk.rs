//! Pruebas del motor de recorrido sobre carpetas temporales creadas aquí mismo.
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use tessera_core::types::flag;
use tessera_core::{links, ops, scan, ActionKind, EngineChoice, ScanOptions, Tree};

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

/// Unión (junction) con `mklink /J` (no necesita administrador).
fn junction(link: &Path, target: &Path) -> bool {
    std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[test]
fn broken_links_are_checked_on_disk() {
    let d = TempDir::new("enlaces");
    d.file("destino/x.txt", 10);
    std::fs::create_dir_all(d.0.join("borrado")).unwrap();
    std::fs::create_dir_all(d.0.join("sub")).unwrap();
    assert!(junction(&d.0.join("bueno"), &d.0.join("destino")), "mklink /J");
    let roto_path = d.0.join("sub").join("roto");
    assert!(junction(&roto_path, &d.0.join("borrado")));
    // Su destino desaparece: queda rota (lo de dentro de la carpeta temporal y nada más)
    std::fs::remove_dir(d.0.join("borrado")).unwrap();
    // Enlaces simbólicos (con administrador o el modo de desarrollador): a un archivo y a una carpeta que no
    // existen, a un archivo que sí y un bucle
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let sym = symlink_file(d.0.join("no-existe.txt"), d.0.join("sim-roto")).is_ok();
    if sym {
        symlink_dir(d.0.join("no-existe"), d.0.join("sim-carpeta")).unwrap();
        symlink_file(d.0.join("destino").join("x.txt"), d.0.join("sim-bueno")).unwrap();
        symlink_file(d.0.join("bucle-b"), d.0.join("bucle-a")).unwrap();
        symlink_file(d.0.join("bucle-a"), d.0.join("bucle-b")).unwrap();
    } else {
        eprintln!("broken_links_are_checked_on_disk: sin permiso para crear enlaces simbólicos; sólo uniones");
    }

    let s = run(&d.0);
    let t = &s.tree;
    let snapshot = |t: &Tree| (0..t.len() as u32).map(|i| (t.live(i), t.size(i), t.files(i), t.flags(i))).collect::<Vec<_>>();
    let before = snapshot(t);
    let roto = find(t, &roto_path);
    assert_eq!(t.flags(roto) & (flag::DIR | flag::REPARSE), flag::DIR | flag::REPARSE);
    let rel = |r: &tessera_core::SearchResponse| r.rows.iter().map(|x| x.path[d.0.as_os_str().len() + 1..].to_string()).collect::<Vec<_>>();
    let r = links::broken_links(t, 0, 10);
    assert!(r.error.is_none());
    // Ordenados por ruta; la unión buena y el enlace al archivo que existe no salen
    let want: &[&str] = if sym { &["bucle-a", "bucle-b", "sim-carpeta", "sim-roto", "sub\\roto"] } else { &["sub\\roto"] };
    assert_eq!(rel(&r), want);
    assert_eq!(r.total, want.len() as u64);
    assert_eq!(r.total_bytes, r.rows.iter().map(|x| x.node.size).sum::<u64>());
    assert_eq!(r.rows.last().unwrap().node.id, roto);
    assert!(r.rows.iter().all(|x| x.node.flags & flag::REPARSE != 0));
    // `limit`: total de todos, filas las primeras
    let r1 = links::broken_links(t, 0, 1);
    assert_eq!((r1.total, r1.rows.len(), rel(&r1)[0].as_str()), (r.total, 1, want[0]));
    assert_eq!(links::broken_links(t, 0, 0).rows.len(), 0);
    // Bajo una subcarpeta, y el propio nodo si es un enlace
    assert_eq!(rel(&links::broken_links(t, find(t, &d.0.join("sub")), 10)), ["sub\\roto"]);
    assert_eq!(links::broken_links(t, roto, 10).total, 1);
    assert_eq!(links::broken_links(t, find(t, &d.0.join("bueno")), 10).total, 0);
    assert_eq!(links::broken_links(t, 999_999, 10).error.unwrap().code, "error.invalidNode");
    // Se mira en el momento: el destino vuelve a existir → ya no está rota
    std::fs::create_dir_all(d.0.join("borrado")).unwrap();
    assert_eq!(links::broken_links(t, find(t, &d.0.join("sub")), 10).total, 0);
    // Ni el árbol ni el disco cambian
    assert_eq!(snapshot(t), before);
    assert!(std::fs::symlink_metadata(&roto_path).is_ok_and(|m| m.file_type().is_symlink() || m.is_dir()));
    assert!(d.0.join("destino/x.txt").exists());
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
