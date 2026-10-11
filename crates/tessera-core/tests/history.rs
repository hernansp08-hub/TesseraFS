//! Pruebas del historial, la comparación y la exportación sobre carpetas temporales creadas aquí mismo.
//! El historial y la exportación van siempre a carpetas temporales (TESSERA_HISTORY_DIR y
//! TESSERA_EXPORT_DIR): nunca se toca el historial real ni las Descargas del usuario. Windows y Linux.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};

use tessera_core::history::{entry_id, path_hash, KEEP};
use tessera_core::{export, ops, scan, EngineChoice, History, Param, Scan, ScanOptions, SortKey, Tree};

const MIB: usize = 1 << 20;

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

/// Las variables de entorno son del proceso: las pruebas de este archivo van de una en una,
/// cada una con sus carpetas temporales de historial y exportación.
static ENV: Mutex<()> = Mutex::new(());

struct Env {
    _lock: MutexGuard<'static, ()>,
    history: TempDir,
    export: TempDir,
}

fn env() -> Env {
    let lock = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let (history, export) = (TempDir::new("hist"), TempDir::new("export"));
    std::env::set_var("TESSERA_HISTORY_DIR", &history.0);
    // Una subcarpeta que todavía no existe: la exportación la crea
    std::env::set_var("TESSERA_EXPORT_DIR", export.0.join("TesseraFS"));
    Env { _lock: lock, history, export }
}

fn run(p: &Path) -> Scan {
    let cancel = AtomicBool::new(false);
    scan(&p.to_string_lossy(), EngineChoice::Walk, &ScanOptions::default(), &|_| {}, &cancel).unwrap()
}

/// Ruta como la escribe el árbol: en Windows con `\` y sin distinguir mayúsculas; en Linux, tal cual.
fn norm(p: &str) -> String {
    if cfg!(windows) {
        p.replace('/', "\\").to_lowercase()
    } else {
        p.to_string()
    }
}

fn find(t: &Tree, path: &Path) -> u32 {
    let want = norm(&path.to_string_lossy());
    (0..t.len() as u32).find(|&i| t.live(i) && norm(&t.path(i)) == want).unwrap_or_else(|| panic!("no está {want}"))
}

fn same(a: &str, b: &Path) -> bool {
    norm(a) == norm(&b.to_string_lossy())
}

/// docs/report.pdf 2 MiB · docs/notes.txt 10 KB · old/archive.bin 2 MiB · keep/small.txt 100 B ·
/// keep/big.iso 1,5 MiB · top.txt 500 B
fn fixture() -> TempDir {
    let d = TempDir::new("cmp");
    d.file("docs/report.pdf", 2 * MIB);
    d.file("docs/notes.txt", 10_000);
    d.file("old/archive.bin", 2 * MIB);
    d.file("keep/small.txt", 100);
    d.file("keep/big.iso", 3 * MIB / 2);
    d.file("top.txt", 500);
    d
}

#[test]
fn save_compare_and_clear() {
    let env = env();
    let h = History::open().unwrap();
    assert_eq!(h.dir(), env.history.0.as_path());
    assert!(h.list().unwrap().is_empty());

    let d = fixture();
    let s1 = run(&d.0);
    let before_bytes = (2 * MIB + 10_000 + 2 * MIB + 100 + 3 * MIB / 2 + 500) as u64;
    assert_eq!(s1.result.bytes, before_bytes);
    let e = h.save(&s1).unwrap();
    assert!(e.id.ends_with(&format!("-{:08x}", path_hash(&s1.result.root_path))));
    assert_eq!(e.id.len(), entry_id(0, "x").len());
    assert_eq!((e.path.as_str(), e.scanned_at, e.bytes, e.files, e.dirs), (s1.result.root_path.as_str(), s1.scanned_at, before_bytes, 6, 3));
    // Raíz + 3 carpetas + report, archive y big.iso (los pequeños no se guardan)
    assert_eq!(e.nodes, 7);
    assert!(env.history.0.join(format!("{}.json", e.id)).is_file());
    assert_eq!(std::fs::metadata(env.history.0.join(format!("{}.snap.gz", e.id))).unwrap().len(), e.file_bytes);
    assert_eq!(h.list().unwrap(), std::slice::from_ref(&e));

    // Cambios: carpeta nueva con 3 MiB, report.pdf 2 → 5 MiB, fuera old/ (2 MiB) y keep/small.txt
    d.file("new/clip.bin", 3 * MIB);
    d.file("docs/report.pdf", 5 * MIB);
    std::fs::remove_dir_all(d.0.join("old")).unwrap();
    std::fs::remove_file(d.0.join("keep/small.txt")).unwrap();
    let s2 = run(&d.0);
    let t = &s2.tree;
    assert!(t.comparison().is_none());
    let r = h.compare(&s2, &e.id, 50).unwrap();
    assert_eq!(r.entry, e);
    assert_eq!((r.before.bytes, r.before.files, r.before.dirs), (before_bytes, 6, 3));
    let after_bytes = (5 * MIB + 10_000 + 3 * MIB / 2 + 500 + 3 * MIB) as u64;
    assert_eq!((r.after.bytes, r.after.files, r.after.dirs), (after_bytes, 5, 3));

    // grew: los dos archivos (+3 MiB cada uno; a igualdad, por ruta); ni new/ ni docs/ ni la raíz,
    // porque un hijo explica todo su crecimiento
    let grew: Vec<(&str, i64, Option<u64>, Option<bool>)> =
        r.grew.iter().map(|c| (c.row.node.name.as_str(), c.row.node.size as i64 - c.prev.unwrap_or(0) as i64, c.prev, c.row.node.fresh)).collect();
    assert_eq!(grew, [("report.pdf", 3 * MIB as i64, Some(2 * MIB as u64), None), ("clip.bin", 3 * MIB as i64, None, Some(true))]);
    assert!(same(&r.grew[0].row.path, &d.0.join("docs/report.pdf")));
    assert!(same(&r.grew[1].row.path, &d.0.join("new/clip.bin")));
    assert!(r.grew.iter().all(|c| c.row.node.prev.is_none()), "el prev va en ChangeRow");
    // shrank: keep/ perdió un archivo pequeño que no estaba en el resumen, así que lo explica la carpeta
    assert_eq!(r.shrank.len(), 1);
    assert_eq!((r.shrank[0].row.node.name.as_str(), r.shrank[0].prev, r.shrank[0].row.node.size), ("keep", Some((3 * MIB / 2 + 100) as u64), (3 * MIB / 2) as u64));
    // removed: sólo lo más alto (old/, no old/archive.bin)
    assert_eq!(r.removed.len(), 1);
    assert!(same(&r.removed[0].path, &d.0.join("old")));
    assert_eq!((r.removed[0].is_dir, r.removed[0].size), (true, 2 * MIB as u64));
    // JSON del contrato
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["grew"][1]["prev"], serde_json::Value::Null);
    assert_eq!(v["grew"][1]["fresh"], true);
    assert_eq!(v["grew"][0]["prev"], 2 * MIB);
    assert!(v["grew"][0].get("fresh").is_none());
    assert_eq!(v["removed"][0]["isDir"], true);
    assert_eq!(v["entry"]["id"], e.id.as_str());

    // children con prev/fresh y orden delta (a igualdad, por nombre)
    let names = |sort: SortKey, desc: bool| ops::children(t, 0, 0, 10, sort, desc).unwrap().rows.into_iter().map(|r| r.name).collect::<Vec<_>>();
    assert_eq!(names(SortKey::Delta, true), ["docs", "new", "top.txt", "keep"]);
    assert_eq!(names(SortKey::Delta, false), ["keep", "top.txt", "docs", "new"]);
    let rows = ops::children(t, 0, 0, 10, SortKey::Delta, true).unwrap().rows;
    let pf = |n: &str| rows.iter().find(|r| r.name == n).map(|r| (r.prev, r.fresh)).unwrap();
    assert_eq!(pf("docs"), (Some((2 * MIB + 10_000) as u64), None));
    assert_eq!(pf("new"), (None, Some(true)));
    assert_eq!(pf("top.txt"), (None, None), "archivo pequeño: desconocido");
    assert_eq!(pf("keep"), (Some((3 * MIB / 2 + 100) as u64), None));
    let docs = find(t, &d.0.join("docs"));
    let kids = ops::children(t, docs, 0, 10, SortKey::Delta, true).unwrap().rows;
    assert_eq!(kids.iter().map(|r| (r.name.as_str(), r.prev)).collect::<Vec<_>>(), [("report.pdf", Some(2 * MIB as u64)), ("notes.txt", None)]);
    // node info y búsqueda también
    let clip = find(t, &d.0.join("new/clip.bin"));
    assert_eq!(t.row(clip).fresh, Some(true));
    let sr = ops::search(t, "clip", 0, 10);
    assert_eq!((sr.rows[0].node.fresh, sr.rows[0].node.prev), (Some(true), None));
    let j = serde_json::to_value(t.row(docs)).unwrap();
    assert_eq!(j["prev"], 2 * MIB + 10_000);
    assert!(j.get("fresh").is_none());

    // Lo que se quita del árbol (papelera) cambia el tamaño actual pero no prev
    let mut s2 = s2;
    let iso = find(&s2.tree, &d.0.join("keep/big.iso"));
    let keep = find(&s2.tree, &d.0.join("keep"));
    s2.tree.remove(iso).unwrap();
    let row = s2.tree.row(keep);
    assert_eq!((row.size, row.prev), (0, Some((3 * MIB / 2 + 100) as u64)));

    // compareClear: sin prev/fresh y delta = 0 (orden por nombre)
    let t = &s2.tree;
    t.set_comparison(None);
    let rows = ops::children(t, 0, 0, 10, SortKey::Delta, true).unwrap().rows;
    assert!(rows.iter().all(|r| r.prev.is_none() && r.fresh.is_none()));
    assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["docs", "keep", "new", "top.txt"]);
    assert!(serde_json::to_value(t.row(docs)).unwrap().get("prev").is_none());
    // Un escaneo nuevo no trae comparación
    h.compare(&s2, &e.id, 5).unwrap();
    assert!(s2.tree.comparison().is_some());
    assert!(run(&d.0).tree.comparison().is_none());

    // Errores: otra ruta, id inexistente o no válido, resumen dañado
    let sub = run(&d.0.join("keep"));
    let err = h.compare(&sub, &e.id, 10).unwrap_err();
    assert_eq!(err.code, "history.otherRoot");
    assert_eq!(err.get("path"), Some(&Param::Str(e.path.clone())));
    assert!(sub.tree.comparison().is_none());
    for bad in ["20000101T000000Z-00000000", "..\\x", "a.json", ""] {
        let err = h.compare(&s2, bad, 10).unwrap_err();
        assert_eq!(err.code, "history.notFound", "{bad}");
        assert_eq!(err.get("id"), Some(&Param::Str(bad.into())));
    }
    let broken = "20000101T000000Z-deadbeef";
    let mut fake = e.clone();
    fake.id = broken.into();
    std::fs::write(env.history.0.join(format!("{broken}.json")), serde_json::to_vec(&fake).unwrap()).unwrap();
    std::fs::write(env.history.0.join(format!("{broken}.snap.gz")), b"not gzip").unwrap();
    assert_eq!(h.compare(&s2, broken, 10).unwrap_err().code, "history.readFailed");
    // .json ilegible o sin su .snap.gz: list los ignora
    std::fs::write(env.history.0.join("20000101T000000Z-00000001.json"), b"{").unwrap();
    std::fs::write(env.history.0.join("20000101T000000Z-00000002.json"), serde_json::to_vec(&e).unwrap()).unwrap();
    std::fs::write(env.history.0.join("otro.txt"), b"x").unwrap();
    let ids: Vec<String> = h.list().unwrap().into_iter().map(|x| x.id).collect();
    assert_eq!(ids, [e.id.clone(), broken.to_string()]);

    // delete y clear: clear borra todo lo que tiene nombre de resumen (también lo suelto o dañado)
    // y no toca otros archivos de la carpeta
    assert!(h.delete(broken).unwrap());
    assert!(!h.delete(broken).unwrap());
    assert_eq!(h.delete("../x").unwrap_err().code, "history.notFound");
    let e2 = h.save(&sub).unwrap();
    assert_eq!(h.list().unwrap().len(), 2);
    assert_eq!(h.clear().unwrap(), 4, "e, e2 y los dos .json sueltos");
    assert!(h.list().unwrap().is_empty());
    assert!(!env.history.0.join(format!("{}.snap.gz", e2.id)).exists());
    assert!(!env.history.0.join("20000101T000000Z-00000001.json").exists());
    assert!(env.history.0.join("otro.txt").is_file());
    assert_eq!(h.clear().unwrap(), 0);
}

#[test]
fn retention_keeps_twenty_per_path() {
    let env = env();
    let h = History::open().unwrap();
    let d = fixture();
    let other = run(&d.0.join("docs"));
    let kept_other = h.save(&other).unwrap();
    let s = run(&d.0);
    let saved: Vec<String> = (0..KEEP + 1).map(|_| h.save(&s).unwrap().id).collect();
    let all = h.list().unwrap();
    assert_eq!(all.len(), KEEP + 1, "20 de la raíz + 1 de docs");
    let mine: Vec<String> = all.iter().filter(|x| x.path == s.result.root_path).map(|x| x.id.clone()).collect();
    assert_eq!(mine.len(), KEEP);
    // Se borró el más antiguo; el resto, del más reciente al más antiguo
    let mut want: Vec<String> = saved[1..].to_vec();
    want.reverse();
    assert_eq!(mine, want);
    assert!(!env.history.0.join(format!("{}.json", saved[0])).exists());
    assert!(!env.history.0.join(format!("{}.snap.gz", saved[0])).exists());
    assert!(all.iter().any(|x| x.id == kept_other.id));
    assert_eq!(h.clear().unwrap(), KEEP as u64 + 1);
}

#[test]
fn export_files() {
    let env = env();
    let dir = export::export_dir().unwrap();
    assert_eq!(dir, env.export.0.join("TesseraFS"));
    let r = export::export_file("informe.csv", "a,b\nñ,1\n", false).unwrap();
    assert_eq!(PathBuf::from(&r.path), dir.join("informe.csv"));
    assert_eq!(std::fs::read_to_string(&r.path).unwrap(), "a,b\nñ,1\n");
    let r2 = export::export_file("informe.csv", "otro", false).unwrap();
    assert_eq!(PathBuf::from(&r2.path), dir.join("informe (2).csv"));
    let r3 = export::export_file("informe.csv", "", false).unwrap();
    assert_eq!(PathBuf::from(&r3.path), dir.join("informe (3).csv"));
    assert_eq!(std::fs::read_to_string(&r.path).unwrap(), "a,b\nñ,1\n", "no se sobrescribe");
    let r4 = export::export_file("datos", "AAEC/w==", true).unwrap();
    assert_eq!(std::fs::read(&r4.path).unwrap(), [0, 1, 2, 255]);
    assert_eq!(PathBuf::from(&export::export_file("datos", "AA==", true).unwrap().path), dir.join("datos (2)"));
    assert_eq!(export::export_file("x.bin", "no es base64!", true).unwrap_err().code, "export.failed");
    for bad in ["", ".", "..", "..\\x.csv", "a/b.csv", "C:\\x.csv", "a:b", "a*b", "a?", "a\"b", "a<b", "a>b", "a|b", "a\tb"] {
        let err = export::export_file(bad, "x", false).unwrap_err();
        assert_eq!(err.code, "export.invalidName", "{bad:?}");
        assert_eq!(err.get("name"), Some(&Param::Str(bad.into())));
    }
    assert_eq!(export::export_file(&"a".repeat(201), "x", false).unwrap_err().code, "export.invalidName");

    // revealExport sólo para archivos de la carpeta de exportación (nunca con uno válido: abriría el Explorador)
    let outside = env.export.0.join("fuera.txt");
    std::fs::write(&outside, b"x").unwrap();
    let missing = dir.join("no-existe.csv");
    let s = std::path::MAIN_SEPARATOR;
    let climb = format!("{}{s}..{s}fuera.txt", dir.display());
    let sibling = format!("{}2{s}x.csv", dir.display());
    let foreign = if cfg!(windows) { "C:\\Windows\\notepad.exe" } else { "/etc/hostname" };
    // En Linux, otra mayúscula es otra carpeta
    let upper = if cfg!(windows) { String::new() } else { r.path.replace("/TesseraFS/", "/tesserafs/") };
    for p in [outside.to_string_lossy().into_owned(), missing.to_string_lossy().into_owned(), climb, sibling, dir.to_string_lossy().into_owned(), "informe.csv".into(), String::new(), foreign.into(), upper] {
        let err = export::reveal_export(&p).unwrap_err();
        assert_eq!(err.code, "export.notFound", "{p}");
        assert_eq!(err.get("path"), Some(&Param::Str(p.clone())));
    }
}
