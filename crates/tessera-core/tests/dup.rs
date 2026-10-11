//! Pruebas de la búsqueda de duplicados sobre carpetas temporales creadas aquí mismo (Windows y Linux).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::Mutex;

use tessera_core::types::flag;
use tessera_core::{duplicates, scan, DupPhase, DupProgress, DupResult, EngineChoice, Param, ScanOptions, Tree};

const BIG: usize = 200 * 1024;
const SMALL: usize = 10_000;
const TAIL: usize = 150 * 1024;
const UNIQUE: usize = 12_345;
const PREFIX: u64 = 64 * 1024;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("tessera-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn write(&self, rel: &str, data: &[u8]) -> PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, data).unwrap();
        p
    }
    /// Nombre con punto final: en Windows sólo se puede crear (y abrir) con `\\?\`.
    fn odd(&self) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"\\?\{}\copia.", self.0.join("x").display()))
        } else {
            self.0.join("x/copia.")
        }
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.odd());
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Contenido pseudoaleatorio reproducible.
fn data(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.wrapping_mul(2_654_435_761) | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

fn hex(b: &[u8]) -> String {
    blake3::hash(b).to_hex().to_string()
}

/// 3 copias grandes en carpetas distintas, 3 pequeñas (una con punto final), 2 del mismo tamaño
/// y mismo prefijo pero distinto final, una única con un enlace duro y dos vacías.
fn fixture(tag: &str) -> TempDir {
    let d = TempDir::new(tag);
    let big = data(BIG, 1);
    d.write("a/big.bin", &big);
    d.write("B/big copia.bin", &big);
    d.write("c/d/big.bin", &big);
    let small = data(SMALL, 2);
    d.write("small.txt", &small);
    d.write("x/Small (2).txt", &small);
    std::fs::write(d.odd(), &small).unwrap();
    let mut tail = data(TAIL, 3);
    d.write("tail1.bin", &tail);
    *tail.last_mut().unwrap() ^= 0xFF;
    d.write("y/tail2.bin", &tail);
    let u = d.write("unique.bin", &data(UNIQUE, 4));
    std::fs::create_dir_all(d.0.join("e")).unwrap();
    std::fs::hard_link(&u, d.0.join("e/unique-enlace.bin")).unwrap();
    d.write("empty1.txt", &[]);
    d.write("empty2.txt", &[]);
    d
}

fn run(p: &Path) -> tessera_core::Scan {
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
    (0..t.len() as u32).find(|&i| norm(&t.path(i)) == want).unwrap_or_else(|| panic!("no está {want}"))
}

fn dups(t: &Tree, root: u32, min: u64, limit: u32) -> DupResult {
    duplicates(t, root, min, limit, &|_| {}, &AtomicBool::new(false)).unwrap()
}

fn paths(r: &DupResult, g: usize) -> Vec<String> {
    r.groups[g].files.iter().map(|f| f.path.clone()).collect()
}

#[test]
fn finds_groups_in_three_passes() {
    let d = fixture("dup");
    let s = run(&d.0);
    let t = &s.tree;
    let p = |rel: &str| d.0.join(rel).to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR);
    // El enlace duro: uno de los dos nombres lleva la marca
    let (u, l) = (find(t, &d.0.join("unique.bin")), find(t, &d.0.join("e/unique-enlace.bin")));
    assert_eq!((t.flags(u) | t.flags(l)) & flag::HARDLINK, flag::HARDLINK);

    let log = Mutex::new(Vec::<DupProgress>::new());
    let r = duplicates(t, 0, 0, 100, &|x| log.lock().unwrap().push(x), &AtomicBool::new(false)).unwrap();
    assert_eq!(r.total_groups, 2);
    assert_eq!(r.groups.len(), 2);
    assert_eq!(r.candidates, 8, "3 grandes + 3 pequeños + 2 con el mismo tamaño");
    assert_eq!(r.skipped.hardlinks, 1);
    assert_eq!(r.skipped.cloud, 0);
    assert_eq!(r.wasted, 2 * BIG as u64 + 2 * SMALL as u64);
    let prefix_bytes = 5 * PREFIX + 3 * SMALL as u64;
    let full_bytes = 3 * BIG as u64 + 2 * TAIL as u64;
    assert_eq!(r.read_bytes, prefix_bytes + full_bytes);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    // Más espacio recuperable primero; hash = BLAKE3 del contenido completo
    assert_eq!(r.groups[0].size, BIG as u64);
    assert_eq!(r.groups[0].hash, hex(&data(BIG, 1)));
    assert_eq!(r.groups[1].size, SMALL as u64);
    assert_eq!(r.groups[1].hash, hex(&data(SMALL, 2)));
    assert_eq!(r.groups[1].hash.len(), 64);
    // Rutas sin distinguir mayúsculas (por bytes, «B» iría antes que «a» y «Small» antes que «copia.»)
    assert_eq!(paths(&r, 0), [p("a/big.bin"), p("B/big copia.bin"), p("c/d/big.bin")]);
    assert_eq!(paths(&r, 1), [p("small.txt"), p("x/copia."), p("x/Small (2).txt")]);
    let row = &r.groups[1].files[1];
    assert_eq!((row.node.name.as_str(), row.node.size, row.node.is_dir), ("copia.", SMALL as u64, false));
    assert_eq!(row.node.id, find(t, &d.0.join("x/copia.")));

    // Progreso: size → prefix → full → done, con los totales de cada pasada
    let log = log.into_inner().unwrap();
    let order = |ph: DupPhase| [DupPhase::Size, DupPhase::Prefix, DupPhase::Full, DupPhase::Done].iter().position(|&x| x == ph).unwrap();
    assert!(log.windows(2).all(|w| order(w[0].phase) <= order(w[1].phase)));
    assert_eq!((log[0].phase, log[0].files, log[0].total_files, log[0].bytes), (DupPhase::Size, 8, 8, 0));
    let first = |ph| log.iter().find(|x| x.phase == ph).unwrap();
    assert_eq!((first(DupPhase::Prefix).files, first(DupPhase::Prefix).total_files, first(DupPhase::Prefix).total_bytes), (0, 8, prefix_bytes));
    assert_eq!((first(DupPhase::Full).total_files, first(DupPhase::Full).total_bytes), (5, full_bytes));
    assert!(log.iter().all(|x| x.files <= x.total_files && x.bytes <= x.total_bytes));
    let last = log.last().unwrap();
    assert_eq!((last.phase, last.bytes, last.files), (DupPhase::Done, r.read_bytes, 8));

    // JSON del contrato
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["totalGroups"], 2);
    assert_eq!(v["skipped"], serde_json::json!({ "hardlinks": 1, "cloud": 0 }));
    assert_eq!(v["groups"][1]["files"][1]["path"], p("x/copia."));
    assert_eq!(v["groups"][1]["files"][1]["name"], "copia.");
    for k in ["groups", "totalGroups", "wasted", "candidates", "readBytes", "skipped", "elapsedMs", "warnings"] {
        assert!(v.get(k).is_some(), "falta {k}");
    }
    let j = serde_json::to_value(last).unwrap();
    assert_eq!(j["phase"], "done");
    assert!(j.get("totalFiles").is_some() && j.get("totalBytes").is_some() && j.get("elapsedMs").is_some());

    // `limit` recorta los grupos pero no los totales (0 cuenta como 1)
    let r1 = dups(t, 0, 0, 0);
    assert_eq!((r1.groups.len(), r1.total_groups, r1.wasted), (1, 2, r.wasted));
    assert_eq!(r1.groups[0].size, BIG as u64);
    // Tamaño mínimo: sólo los grandes y los del mismo tamaño
    let r2 = dups(t, 0, 100_000, 10);
    assert_eq!((r2.candidates, r2.total_groups, r2.wasted), (5, 1, 2 * BIG as u64));
    assert_eq!(r2.read_bytes, 5 * PREFIX + full_bytes);
    // Raíz en una subcarpeta y en un archivo
    let x = find(t, &d.0.join("x"));
    let r3 = dups(t, x, 0, 10);
    assert_eq!((r3.candidates, r3.total_groups), (2, 1));
    assert_eq!(paths(&r3, 0), [p("x/copia."), p("x/Small (2).txt")]);
    let a = find(t, &d.0.join("a/big.bin"));
    let r4 = dups(t, a, 0, 10);
    assert_eq!((r4.candidates, r4.total_groups, r4.read_bytes), (0, 0, 0));
}

#[test]
fn cancellation_and_read_errors() {
    let d = fixture("dup-err");
    let s = run(&d.0);
    let t = &s.tree;
    let none = |_: DupProgress| {};
    // Cancelada antes de empezar y a mitad (al entrar en la pasada completa)
    let e = duplicates(t, 0, 0, 10, &none, &AtomicBool::new(true)).unwrap_err();
    assert_eq!(e.code, "error.cancelled");
    let cancel = AtomicBool::new(false);
    let e = duplicates(t, 0, 0, 10, &|p: DupProgress| if p.phase == DupPhase::Full { cancel.store(true, Relaxed) }, &cancel).unwrap_err();
    assert_eq!(e.code, "error.cancelled");
    // Nodo no válido
    let e = duplicates(t, 999_999, 0, 10, &none, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(e.code, "error.invalidNode");
    // Un archivo que ya no existe sale de su grupo y se avisa
    std::fs::remove_file(d.0.join("x/Small (2).txt")).unwrap();
    let r = dups(t, 0, 0, 10);
    assert_eq!(r.candidates, 8);
    assert_eq!((r.total_groups, r.wasted), (2, 2 * BIG as u64 + SMALL as u64));
    assert_eq!(r.groups[1].files.len(), 2);
    assert_eq!(r.warnings.len(), 1);
    assert_eq!(r.warnings[0].code, "dup.readErrors");
    assert_eq!(r.warnings[0].get("count"), Some(&Param::Int(1)));
    assert_eq!(r.warnings[0].message, "1 file couldn't be read and was left out");
    // Un archivo que cambió de tamaño desde el escaneo tampoco cuenta
    std::fs::write(d.0.join("small.txt"), data(SMALL + 1, 2)).unwrap();
    let r = dups(t, 0, 0, 10);
    assert_eq!(r.total_groups, 1);
    assert_eq!(r.warnings[0].get("count"), Some(&Param::Int(2)));
    assert_eq!(r.warnings[0].message, "2 files couldn't be read and were left out");
}
