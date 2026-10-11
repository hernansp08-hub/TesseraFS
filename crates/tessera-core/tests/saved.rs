//! Pruebas del escaneo guardado (`.tessera`) sobre carpetas temporales creadas aquí mismo: guardar,
//! abrir, ida y vuelta (mismo árbol, mismo slice byte a byte), estado «sin conexión» y lo que se quita
//! del árbol (papelera, volver a escanear). La exportación y el historial van siempre a carpetas
//! temporales (TESSERA_EXPORT_DIR y TESSERA_HISTORY_DIR). Windows y Linux.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};

use tessera_core::{ops, rescan, saved, scan, slice, EngineChoice, History, Scan, ScanOptions, SortKey, Tree};

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

/// Las variables de entorno son del proceso: las pruebas de este archivo van de una en una.
static ENV: Mutex<()> = Mutex::new(());

struct Env {
    _lock: MutexGuard<'static, ()>,
    export: TempDir,
    _history: TempDir,
}

fn env() -> Env {
    let lock = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let (history, export) = (TempDir::new("saved-hist"), TempDir::new("saved-export"));
    std::env::set_var("TESSERA_HISTORY_DIR", &history.0);
    std::env::set_var("TESSERA_EXPORT_DIR", &export.0);
    Env { _lock: lock, export, _history: history }
}

fn run(p: &Path) -> Scan {
    let cancel = AtomicBool::new(false);
    scan(&p.to_string_lossy(), EngineChoice::Walk, &ScanOptions::default(), &|_| {}, &cancel).unwrap()
}

/// Archivos de varios tamaños, nombres raros, una carpeta vacía y un archivo oculto.
fn fixture() -> TempDir {
    let d = TempDir::new("saved");
    d.file("docs/report.pdf", 2 << 20);
    d.file("docs/notes.TXT", 10_000);
    d.file("docs/deep/ñandú 😀.bin", 3);
    d.file(if cfg!(windows) { "docs/deep/coma, 'apóstrofo'.txt" } else { "docs/deep/coma, \"comillas\"\\.txt" }, 77);
    d.file("a.tar.gz", 5_000);
    d.file("b.tar.gz", 5_000);
    d.file("sin extensión", 1);
    std::fs::create_dir_all(d.0.join("vacía")).unwrap();
    hidden(&d.0.join(if cfg!(windows) { "oculto.ini" } else { ".oculto" }));
    d
}

#[cfg(windows)]
fn hidden(p: &Path) {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create_new(true).attributes(2).open(p).unwrap();
}

#[cfg(not(windows))]
fn hidden(p: &Path) {
    std::fs::write(p, b"x").unwrap();
}

/// Todas las columnas de cada nodo, por id (el árbol abierto de un escaneo recién hecho tiene los mismos ids).
fn same_tree(a: &Tree, b: &Tree) {
    assert_eq!((a.len(), a.root_path()), (b.len(), b.root_path()));
    for id in 0..a.len() as u32 {
        let row = |t: &Tree| (t.parent(id), t.name_bytes(id).to_vec(), t.size(id), t.alloc(id), t.files(id), t.dirs(id), t.mtime(id), t.flags(id), t.ext(id).to_string(), t.kids(id).to_vec());
        assert_eq!(row(a), row(b), "nodo {id}: {}", a.path(id));
    }
}

/// Ruta → (tamaño, asignado, flags) de los nodos vivos.
fn by_path(t: &Tree) -> BTreeMap<String, (u64, u64, u16, u32, u32)> {
    let mut m = BTreeMap::new();
    let mut stack = vec![0u32];
    while let Some(id) = stack.pop() {
        m.insert(t.path(id), (t.size(id), t.alloc(id), t.flags(id), t.files(id), t.dirs(id)));
        stack.extend(t.kids(id).to_vec());
    }
    m
}

#[test]
fn save_and_open_round_trip() {
    let env = env();
    let d = fixture();
    let s = run(&d.0);
    assert!(s.offline().is_none() && s.result.offline.is_none());
    let r = saved::save_scan(&s).unwrap();
    let p = PathBuf::from(&r.path);
    assert_eq!(p.parent().unwrap(), env.export.0.as_path());
    let name = p.file_name().unwrap().to_string_lossy().into_owned();
    let label = saved::root_label(&s.result.root_path);
    assert_eq!(name, saved::file_name(&s.result.root_path, s.scanned_at));
    assert!(name.starts_with(&format!("{label} 20")) && name.ends_with(".tessera"), "{name}");
    // Otra vez: « (2)»
    let r2 = saved::save_scan(&s).unwrap();
    assert_eq!(PathBuf::from(&r2.path).file_name().unwrap().to_string_lossy(), name.replace(".tessera", " (2).tessera"));

    // El formato: gzip de JSON con la cabecera y una fila por nodo, con flags
    let bytes = std::fs::read(&p).unwrap();
    let mut json = String::new();
    flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut json).unwrap();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!((v["v"].as_u64(), v["kind"].as_str(), v["app"].as_str()), (Some(1), Some("tesserafs-scan"), Some(env!("CARGO_PKG_VERSION"))));
    assert_eq!((v["path"].as_str(), v["scannedAt"].as_u64(), v["engine"].as_str()), (Some(s.result.root_path.as_str()), Some(s.scanned_at), Some("walk")));
    assert_eq!(v["host"].as_str().map(str::to_string), saved::host_name());
    assert_eq!(v["volume"]["fs"], serde_json::to_value(&s.result.volume).unwrap()["fs"]);
    let nodes = v["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), s.tree.len());
    assert_eq!(nodes[0], serde_json::json!([-1, s.result.root_path, 1, s.tree.size(0), s.tree.alloc(0), s.tree.files(0), s.tree.dirs(0), s.tree.mtime(0), s.tree.flags(0)]));
    assert!(nodes.iter().all(|n| n.as_array().unwrap().len() == 9));
    // Preorden: cada nodo después de su padre
    assert!(nodes.iter().enumerate().skip(1).all(|(i, n)| (n[0].as_i64().unwrap() as usize) < i));
    let hid = nodes.iter().find(|n| n[1] == if cfg!(windows) { "oculto.ini" } else { ".oculto" }).unwrap();
    assert_eq!(hid[8].as_u64().unwrap() & 2, 2, "flag oculto");

    // Abrir: el mismo árbol, el mismo slice byte a byte, mismas búsquedas y tipos
    let o = saved::open_scan(&bytes).unwrap();
    same_tree(&s.tree, &o.tree);
    for (min, max) in [(0.0, 20_000), (1000.0, 5), (0.0, 1)] {
        assert_eq!(slice::encode_slice(&o.tree, 0, min, max), slice::encode_slice(&s.tree, 0, min, max));
    }
    for q in ["", "ext:gz", "type:dir", "attr:hidden", "size:>1k", "path:deep"] {
        let (a, b) = (ops::search(&s.tree, q, 0, 100), ops::search(&o.tree, q, 0, 100));
        assert_eq!(serde_json::to_value(&a).unwrap(), serde_json::to_value(&b).unwrap(), "{q}");
    }
    assert_eq!(ops::ext_stats(&o.tree, 0).unwrap(), ops::ext_stats(&s.tree, 0).unwrap());
    let kids = |t: &Tree| serde_json::to_value(ops::children(t, 0, 0, 100, SortKey::Name, false).unwrap()).unwrap();
    assert_eq!(kids(&o.tree), kids(&s.tree));
    // ScanResult: lo guardado y offline
    let res = &o.result;
    assert_eq!((res.root_id, res.root_path.as_str(), res.engine, res.entries, res.files, res.dirs, res.bytes), (0, s.result.root_path.as_str(), s.result.engine, s.result.entries, s.result.files, s.result.dirs, s.result.bytes));
    assert_eq!(serde_json::to_value(&res.volume).unwrap(), serde_json::to_value(&s.result.volume).unwrap());
    assert!(res.warnings.is_empty());
    assert_eq!(res.can_refresh, Some(false));
    let off = res.offline.clone().unwrap();
    assert_eq!((off.scanned_at, off.host.clone(), off.app.as_deref()), (s.scanned_at, saved::host_name(), Some(env!("CARGO_PKG_VERSION"))));
    assert_eq!(o.scanned_at, s.scanned_at);
    let j = serde_json::to_value(res).unwrap();
    assert_eq!(j["offline"]["scannedAt"], s.scanned_at);
    assert_eq!(saved::open_file(&p).unwrap().tree.len(), s.tree.len());
    assert!(saved::is_saved_scan(&r.path) && !saved::is_saved_scan(&d.0.to_string_lossy()));

    // Volver a guardar lo abierto conserva scannedAt, host y app (aunque no sean los de este equipo)
    let mut o = o;
    o.result.offline = Some(tessera_core::SavedScanInfo { scanned_at: s.scanned_at, host: Some("SERVIDOR-NAS".into()), app: Some("0.0.1".into()) });
    let again = saved::open_scan(&std::fs::read(saved::save_scan(&o).unwrap().path).unwrap()).unwrap();
    assert_eq!(again.result.offline.unwrap(), tessera_core::SavedScanInfo { scanned_at: s.scanned_at, host: Some("SERVIDOR-NAS".into()), app: Some("0.0.1".into()) });
    same_tree(&s.tree, &again.tree);
}

#[test]
fn offline_scan_refuses_disk_and_history() {
    let _env = env();
    let d = fixture();
    let s = run(&d.0);
    let h = History::open().unwrap();
    let e = h.save(&s).unwrap();
    let mut o = saved::open_scan(&std::fs::read(saved::save_scan(&s).unwrap().path).unwrap()).unwrap();
    let docs = (0..o.tree.len() as u32).find(|&i| o.tree.name(i) == "docs").unwrap();
    let cancel = AtomicBool::new(false);
    let code = |r: Result<(), tessera_core::EngineMessage>| r.unwrap_err().code;
    assert_eq!(code(h.save(&o).map(drop)), "scan.offline");
    assert_eq!(code(h.compare(&o, &e.id, 10).map(drop)), "scan.offline");
    assert_eq!(code(h.node_trend(&o, docs).map(drop)), "scan.offline");
    assert_eq!(code(rescan(&mut o, docs, &ScanOptions::default(), &|_| {}, &cancel).map(drop)), "scan.offline");
    assert_eq!(code(tessera_core::refresh(&mut o, &ScanOptions::default(), &|_| {}, &cancel).map(drop)), "scan.offline");
    assert_eq!(code(o.check_online()), "scan.offline");
    // Lo que no toca el disco funciona igual
    assert!(ops::children(&o.tree, docs, 0, 10, SortKey::Size, true).is_ok());
    assert_eq!(ops::search(&o.tree, "report", 0, 10).total, 1);
    assert!(saved::save_scan(&o).is_ok());
    // Un escaneo nuevo no está «sin conexión»
    let fresh = run(&d.0);
    assert!(fresh.check_online().is_ok() && h.node_trend(&fresh, 0).is_ok());
    assert_eq!(h.list().unwrap().len(), 1, "el escaneo abierto no se guardó en el historial");
}

#[test]
fn saves_only_live_nodes() {
    let _env = env();
    let d = fixture();
    let mut s = run(&d.0);
    // Papelera (sólo en el árbol) y volver a escanear una carpeta que cambió
    let t = &s.tree;
    let gz = (0..t.len() as u32).find(|&i| t.name(i) == "a.tar.gz").unwrap();
    s.tree.remove(gz).unwrap();
    d.file("docs/deep/nuevo.bin", 12_345);
    std::fs::remove_file(d.0.join("docs/deep/ñandú 😀.bin")).unwrap();
    let deep = (0..s.tree.len() as u32).find(|&i| s.tree.name(i) == "deep").unwrap();
    rescan(&mut s, deep, &ScanOptions::default(), &|_| {}, &AtomicBool::new(false)).unwrap();
    let mut buf = Vec::new();
    let n = saved::write_scan(&mut buf, &s).unwrap();
    let o = saved::open_scan(&buf).unwrap();
    assert_eq!(n as usize, o.tree.len());
    assert!(o.tree.len() < s.tree.len(), "sin lo muerto");
    assert_eq!(by_path(&o.tree), by_path(&s.tree));
    assert!(!by_path(&o.tree).keys().any(|p| p.ends_with("a.tar.gz") || p.contains("ñandú")));
    assert!(by_path(&o.tree).keys().any(|p| p.ends_with("nuevo.bin")));
    assert_eq!((o.result.bytes, o.result.files, o.result.dirs), (s.tree.size(0), s.tree.files(0) as u64, s.tree.dirs(0) as u64));
}
