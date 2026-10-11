//! Pruebas de Linux de la API pública sobre carpetas temporales creadas aquí mismo: escaneo, avisos,
//! errores con código, acciones que no lanzan programas y volúmenes. El recorrido en sí (enlaces,
//! permisos, dispersos, puntos de montaje…) se prueba en `walk_unix.rs`.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use tessera_core::types::flag;
use tessera_core::{ops, scan, sys, ActionKind, Engine, EngineChoice, Os, ScanOptions, Tree};

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("tessera-{tag}-{}-{nanos}", std::process::id()));
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

fn run(p: &Path, engine: EngineChoice) -> tessera_core::Scan {
    let cancel = AtomicBool::new(false);
    scan(&p.to_string_lossy(), engine, &ScanOptions::default(), &|_| {}, &cancel).unwrap()
}

fn find(t: &Tree, path: &Path) -> u32 {
    let want = path.to_string_lossy();
    (0..t.len() as u32).find(|&i| t.live(i) && t.path(i) == want).unwrap_or_else(|| panic!("no está {want}"))
}

#[test]
fn scan_result_and_engine_choice() {
    let d = TempDir::new("unix-scan");
    d.file("a/b.bin", 4000);
    d.file("A/b.bin", 10);
    std::os::unix::fs::symlink("a", d.0.join("enlace")).unwrap();
    let details = std::sync::Mutex::new(Vec::new());
    let cancel = AtomicBool::new(false);
    // Barra final y `.`: la raíz queda normalizada
    let root = format!("{}/./", d.0.display());
    let s = scan(&root, EngineChoice::Auto, &ScanOptions::default(), &|p| details.lock().unwrap().extend(p.detail), &cancel).unwrap();
    let r = &s.result;
    assert_eq!(r.root_path, d.0.to_string_lossy());
    assert_eq!((r.engine, r.files, r.dirs, r.bytes, r.can_refresh), (Engine::Walk, 3, 2, 4011, Some(false)));
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let v = r.volume.as_ref().expect("volumen de la carpeta temporal");
    assert!(v.path.starts_with('/') && !v.fs.is_empty() && v.total >= v.free && v.total > 0, "{v:?}");
    assert!(d.0.canonicalize().unwrap().starts_with(&v.path));
    // Distingue mayúsculas: a y A son carpetas distintas
    assert_ne!(find(&s.tree, &d.0.join("a")), find(&s.tree, &d.0.join("A")));
    assert_eq!(s.tree.flags(find(&s.tree, &d.0.join("enlace"))) & flag::REPARSE, flag::REPARSE);
    assert_eq!(ops::search(&s.tree, "path:a/b.bin", 0, 10).total, 2, "la búsqueda no distingue mayúsculas");
    // `detail` del progreso: sólo rutas, nunca frases
    assert!(details.into_inner().unwrap().iter().all(|p| p.starts_with(&r.root_path)));
    // Sin MFT: `mft` avisa como con un sistema de archivos no compatible y recorre
    let s = run(&d.0, EngineChoice::Mft);
    assert_eq!(s.result.engine, Engine::Walk);
    assert_eq!(s.result.warnings.len(), 1);
    assert_eq!(s.result.warnings[0].code, "scan.mftUnsupportedFs");
    assert_eq!(run(&d.0, EngineChoice::Walk).result.bytes, 4011);
}

#[test]
fn coded_errors_and_actions_without_side_effects() {
    let d = TempDir::new("unix-errores");
    let f = d.file("archivo.txt", 10);
    let run_err = |p: &str| {
        let cancel = AtomicBool::new(false);
        scan(p, EngineChoice::Auto, &ScanOptions::default(), &|_| {}, &cancel).err().expect("debía fallar")
    };
    assert_eq!(run_err("").code, "error.invalidPath");
    let e = run_err(&f.to_string_lossy());
    assert_eq!((e.code.as_str(), e.get("path")), ("error.notFolder", Some(&tessera_core::Param::Str(f.to_string_lossy().into_owned()))));
    let e = run_err(&d.0.join("no-existe").to_string_lossy());
    assert_eq!(e.code, "error.cannotOpen");
    assert_eq!(e.get("error"), Some(&tessera_core::Param::Str("No such file or directory".into())));
    let cancel = AtomicBool::new(true);
    let e = scan(&d.0.to_string_lossy(), EngineChoice::Walk, &ScanOptions::default(), &|_| {}, &cancel).err().unwrap();
    assert_eq!(e.code, "error.cancelled");

    let mut s = run(&d.0, EngineChoice::Walk);
    let id = find(&s.tree, &f);
    let code = |r: tessera_core::ActionResult| (r.ok, r.code);
    assert_eq!(code(tessera_core::action(&mut s.tree, ActionKind::Trash, 0)), (false, Some("action.trashRoot".into())));
    assert_eq!(code(tessera_core::action(&mut s.tree, ActionKind::Open, 999_999)), (false, Some("error.invalidNode".into())));
    // Lo que Linux no tiene
    for k in [ActionKind::Properties, ActionKind::FreeUp] {
        assert_eq!(code(tessera_core::action(&mut s.tree, k, id)), (false, Some("error.unsupportedPlatform".into())), "{k:?}");
    }
    // Un archivo que ya no existe: `action.failed` sin lanzar ningún programa ni tocar la papelera
    std::fs::remove_file(&f).unwrap();
    for k in [ActionKind::Open, ActionKind::Reveal, ActionKind::Trash] {
        let r = tessera_core::action(&mut s.tree, k, id);
        assert_eq!((r.ok, r.code.as_deref()), (false, Some("action.failed")), "{k:?}");
        assert_eq!(r.message.as_deref(), Some("No such file or directory"));
    }
    assert!(s.tree.live(id), "un fallo no quita el nodo");
    // freeUp no tiene candidatos (no hay nube en Linux)
    assert!(tessera_core::freeup::candidates(&s.tree, 0).is_empty());
}

#[test]
fn platform_information() {
    let info = tessera_core::system_info();
    assert_eq!((info.sep.as_str(), info.actions.len()), ("/", 3));
    if cfg!(target_os = "linux") {
        assert_eq!(info.os, Os::Linux);
    }
    let el = sys::elevation();
    assert!(!el.can_elevate);
    assert_eq!(el.elevated, euid_is_root());
    assert_eq!(sys::relaunch_elevated("").unwrap_err().code, "error.unsupportedPlatform");
    // Volúmenes: rutas absolutas sin barra final, sin repetir, `/` primero si está
    let vols = sys::volumes();
    let paths: Vec<&str> = vols.iter().map(|v| v.path.as_str()).collect();
    assert!(paths.iter().all(|p| p.starts_with('/') && (*p == "/" || !p.ends_with('/'))), "{paths:?}");
    let mut sorted = paths.clone();
    sorted.dedup();
    assert_eq!(sorted.len(), paths.len());
    if let Some(i) = paths.iter().position(|p| *p == "/") {
        assert_eq!(i, 0);
    }
    assert!(vols.iter().all(|v| v.total >= v.free && !v.fs.is_empty() && !v.label.is_empty()), "{vols:?}");
    let tmp = std::env::temp_dir().canonicalize().unwrap();
    let root = sys::volume_root_of(&tmp.to_string_lossy()).expect("montaje de la carpeta temporal");
    assert!(tmp.starts_with(&root));
    if cfg!(target_os = "linux") {
        let (rss, peak, virt) = sys::process_memory().expect("memoria de /proc/self/status");
        assert!(rss > 0 && peak >= rss && virt >= peak);
    }
    // El historial y la exportación tienen carpeta (no se crea nada)
    if std::env::var_os("HOME").is_some() {
        assert!(sys::local_app_data().unwrap().is_absolute());
        assert!(sys::downloads_dir().unwrap().is_absolute());
    }
}

fn euid_is_root() -> bool {
    // El uid efectivo de /proc/self/status (campo «Uid: real efectivo guardado fs»)
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("Uid:")).and_then(|l| l.split_whitespace().nth(2)).map(|u| u == "0"))
        .unwrap_or(false)
}
