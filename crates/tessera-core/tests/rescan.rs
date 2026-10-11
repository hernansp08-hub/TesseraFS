//! Pruebas de volver a escanear una carpeta y de `refresh` sobre carpetas temporales creadas aquí mismo.
//! La lectura real del diario USN necesita administrador: esa prueba es `#[ignore]` y, sin elevación,
//! no hace nada. El resto de `refresh` (FRN, resolución, conjunto mínimo, injerto) se prueba con
//! registros sintéticos hechos con los FRN reales de las carpetas temporales (sólo en Windows; en Linux
//! no hay diario y `refresh` responde `refresh.unavailable`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Mutex, RwLock};

use tessera_core::{ops, refresh, rescan, rescan_shared, scan, slice, EngineChoice, History, Param, Scan, ScanOptions, ScanPhase, ScanProgress, SortKey, Tree};

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
    fn path(&self, rel: &str) -> String {
        let p = if rel.is_empty() { self.0.clone() } else { self.0.join(rel) };
        p.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(p: &Path, keep_frn: bool) -> Scan {
    let cancel = AtomicBool::new(false);
    let opts = ScanOptions { keep_frn, ..Default::default() };
    scan(&p.to_string_lossy(), EngineChoice::Walk, &opts, &|_| {}, &cancel).unwrap()
}

/// Ruta para comparar: en Windows con `\` y sin distinguir mayúsculas; en Linux, tal cual.
fn norm(p: &str) -> String {
    if cfg!(windows) {
        p.replace('/', "\\").to_lowercase()
    } else {
        p.to_string()
    }
}

fn find(t: &Tree, path: &str) -> u32 {
    let want = norm(path);
    (0..t.len() as u32).find(|&i| t.live(i) && norm(&t.path(i)) == want).unwrap_or_else(|| panic!("no está {want}"))
}

fn names(t: &Tree, id: u32) -> Vec<String> {
    ops::children(t, id, 0, 100, SortKey::Name, false).unwrap().rows.into_iter().map(|r| r.name).collect()
}

/// keep.txt 100 · work/{a.txt 1000, del.log 5000, old/o.dat 300} · other/x.bin 2000
fn fixture(tag: &str) -> TempDir {
    let d = TempDir::new(tag);
    d.file("keep.txt", 100);
    d.file("work/a.txt", 1000);
    d.file("work/del.log", 5000);
    d.file("work/old/o.dat", 300);
    d.file("other/x.bin", 2000);
    d
}

/// En work: + new.bin 2 MiB, − del.log, + fresh/deep.txt 10 (sub-subcarpeta nueva).
fn modify(d: &TempDir) {
    d.file("work/new.bin", 2 * MIB);
    std::fs::remove_file(d.0.join("work/del.log")).unwrap();
    d.file("work/fresh/deep.txt", 10);
}

#[test]
fn rescan_grafts_the_folder() {
    let d = fixture("rescan");
    let hist = TempDir::new("rescan-hist");
    let mut s = run(&d.0, false);
    let t = &s.tree;
    let (root_size, root_alloc) = (t.size(0), t.alloc(0));
    let work = find(t, &d.path("work"));
    let (old_dir, del) = (find(t, &d.path("work/old")), find(t, &d.path("work/del.log")));
    let other = find(t, &d.path("other"));
    assert_eq!((t.size(work), t.files(work), t.dirs(work)), (6300, 3, 1));
    // Sin administrador no hay diario ni FRN. Elevado (los runners de GitHub Actions lo están) puede haberlos.
    if !tessera_core::sys::elevation().elevated {
        assert_eq!(s.result.can_refresh, Some(false), "sin administrador no hay diario");
        assert!(!t.has_frn(), "sin refresh no se guardan los FRN");
    }
    let ext_before = ops::ext_stats(t, 0).unwrap();
    // Comparación activa con un resumen del mismo escaneo
    let h = History::at(&hist.0);
    let e = h.save(&s).unwrap();
    h.compare(&s, &e.id, 10).unwrap();
    assert!(s.tree.comparison().is_some());

    modify(&d);
    let (work_alloc_before, events) = (s.tree.alloc(work), Mutex::new(Vec::<ScanProgress>::new()));
    let cancel = AtomicBool::new(false);
    let r = rescan(&mut s, work, &ScanOptions::default(), &|p| events.lock().unwrap().push(p), &cancel).unwrap();
    let t = &s.tree;
    // Misma carpeta, valores nuevos
    let new_size = 1000 + 300 + 2 * MIB as u64 + 10;
    assert_eq!(r.row.id, work);
    assert_eq!((r.before, r.row.size, r.row.files, r.row.dirs, r.row.child_count), (6300, new_size, 4, 2, 4));
    assert_eq!(r.entries, 6, "a.txt, new.bin, old, old/o.dat, fresh, fresh/deep.txt");
    assert!(r.warnings.is_empty());
    assert!(r.row.prev.is_none() && r.row.fresh.is_none());
    // Antepasados por diferencia; el resto, intacto
    assert_eq!(t.size(0), root_size - 6300 + new_size);
    assert_eq!(t.alloc(0), root_alloc - work_alloc_before + t.alloc(work));
    assert_eq!((t.files(0), t.dirs(0)), (2 + 4, 2 + 2));
    assert_eq!((s.result.bytes, s.result.files, s.result.dirs), (t.size(0), 6, 4));
    assert_eq!(find(t, &d.path("other")), other, "fuera de la carpeta, los mismos ids");
    assert_eq!(t.kids(0).get(0), work, "la raíz vuelve a ordenar sus hijos");
    // Hijos nuevos visibles en children y search
    assert_eq!(names(t, work), ["a.txt", "fresh", "new.bin", "old"]);
    let fresh = find(t, &d.path("work/fresh"));
    assert_eq!(names(t, fresh), ["deep.txt"]);
    let q = ops::search(t, "new.bin", 0, 10);
    assert_eq!((q.total, q.rows[0].path.to_lowercase()), (1, d.path("work/new.bin").to_lowercase()));
    assert_eq!(ops::search(t, "del.log", 0, 10).total, 0);
    assert_eq!(ops::search(t, "", work, 100).total, 4);
    assert_eq!(ops::search(t, "", 0, 100).total, 6);
    // Los ids antiguos de dentro ya no valen
    assert!(!t.live(old_dir) && !t.live(del));
    assert_eq!(ops::children(t, old_dir, 0, 10, SortKey::Size, true).unwrap_err().code, "error.invalidNode");
    assert_eq!(ops::ext_stats(t, del).unwrap_err().code, "error.invalidNode");
    assert_eq!(s.rescan_job(old_dir).unwrap_err().code, "error.invalidNode");
    assert_eq!(t.path(t.parent(find(t, &d.path("work/old/o.dat"))).unwrap()), t.path(find(t, &d.path("work/old"))));
    // Tipos de archivo coherentes
    let ext = ops::ext_stats(t, 0).unwrap();
    let get = |v: &[tessera_core::ExtStat], e: &str| v.iter().find(|x| x.ext == e).map(|x| (x.size, x.count)).unwrap_or((0, 0));
    assert_eq!(get(&ext, "bin"), (get(&ext_before, "bin").0 + 2 * MIB as u64, 2));
    assert_eq!(get(&ext, "log"), (0, 0));
    assert_eq!(get(&ext, "txt"), (get(&ext_before, "txt").0 + 10, 3));
    assert_eq!(ext.iter().map(|x| x.size).sum::<u64>(), t.size(0));
    // Slice coherente: lo nuevo y con sus tamaños; nada muerto
    let (nodes, _) = slice::decode_slice(&slice::encode_slice(t, 0, 0.0, 10_000)).unwrap();
    assert_eq!(nodes.len(), 1 + 3 + 4 + 1 + 1 + 1, "raíz, sus 3 hijos, los 4 de work y el de other, old y fresh");
    assert!(nodes.iter().all(|n| t.live(n.id)));
    let w = nodes.iter().find(|n| n.id == work).unwrap();
    assert_eq!((w.size, w.child_count, w.rest_count), (new_size as f64, 4, 0));
    assert_eq!(nodes[0].size, t.size(0) as f64);
    // La comparación se quitó
    assert!(t.comparison().is_none());
    assert!(t.row(work).prev.is_none());
    // Progreso: `walk` con la ruta y al final `done`
    let ev = events.into_inner().unwrap();
    assert_eq!(ev.first().unwrap().phase, ScanPhase::Walk);
    let last = ev.last().unwrap();
    assert_eq!((last.phase, last.entries, last.bytes), (ScanPhase::Done, 6, new_size));
    assert!(ev.iter().filter_map(|p| p.detail.as_deref()).all(|x| x.to_lowercase().starts_with(&d.path("work").to_lowercase())));
    // Otra vez sobre lo nuevo (ids nuevos dentro de una carpeta nueva)
    std::fs::remove_file(d.0.join("work/fresh/deep.txt")).unwrap();
    let r = rescan(&mut s, fresh, &ScanOptions::default(), &|_| {}, &cancel).unwrap();
    assert_eq!((r.before, r.row.size, s.tree.size(work), s.tree.size(0)), (10, 0, new_size - 10, root_size - 6300 + new_size - 10));
    // Lo que no se puede
    assert_eq!(rescan(&mut s, 0, &ScanOptions::default(), &|_| {}, &cancel).unwrap_err().code, "rescan.root");
    let f = find(&s.tree, &d.path("keep.txt"));
    let e = rescan(&mut s, f, &ScanOptions::default(), &|_| {}, &cancel).unwrap_err();
    assert_eq!(e.code, "error.notFolder");
    assert_eq!(e.get("path"), Some(&Param::Str(s.tree.path(f))));
    assert_eq!(rescan(&mut s, 999_999, &ScanOptions::default(), &|_| {}, &cancel).unwrap_err().code, "error.invalidNode");
}

#[test]
fn cancelled_or_failed_rescan_leaves_the_tree() {
    let d = fixture("rescan-cancel");
    let mut s = run(&d.0, false);
    let work = find(&s.tree, &d.path("work"));
    let (len, size) = (s.tree.len(), s.tree.size(0));
    let kids = s.tree.kids(work).to_vec();
    modify(&d);
    // Cancelado en cuanto empieza (cancel_scan llega con el primer evento)
    let cancel = AtomicBool::new(false);
    let events = Mutex::new(Vec::new());
    let e = rescan(
        &mut s,
        work,
        &ScanOptions::default(),
        &|p| {
            cancel.store(true, SeqCst);
            events.lock().unwrap().push(p.phase);
        },
        &cancel,
    )
    .unwrap_err();
    assert_eq!(e.code, "error.cancelled");
    assert_eq!(events.into_inner().unwrap().last(), Some(&ScanPhase::Error));
    assert_eq!((s.tree.len(), s.tree.size(0), s.tree.kids(work).to_vec()), (len, size, kids.clone()));
    assert!(kids.iter().all(|&k| s.tree.live(k)));
    // Ya cancelado antes de llamar
    let e = rescan(&mut s, work, &ScanOptions::default(), &|_| {}, &cancel).unwrap_err();
    assert_eq!(e.code, "error.cancelled");
    // La carpeta ya no existe: error.cannotOpen y nada cambia
    std::fs::remove_dir_all(d.0.join("work")).unwrap();
    let ok = AtomicBool::new(false);
    let e = rescan(&mut s, work, &ScanOptions::default(), &|_| {}, &ok).unwrap_err();
    assert_eq!(e.code, "error.cannotOpen");
    assert!(e.get("error").is_some());
    assert_eq!((s.tree.len(), s.tree.size(0)), (len, size));
}

#[test]
fn rescan_on_the_shared_scan() {
    let d = fixture("rescan-shared");
    let lock: RwLock<Option<Scan>> = RwLock::new(None);
    let cancel = AtomicBool::new(false);
    assert_eq!(rescan_shared(&lock, 1, &ScanOptions::default(), &|_| {}, &cancel).unwrap_err().code, "error.noScan");
    *lock.write().unwrap() = Some(run(&d.0, false));
    let work = find(&lock.read().unwrap().as_ref().unwrap().tree, &d.path("work"));
    modify(&d);
    // Mientras se lee el disco el árbol no está bloqueado: el primer evento puede tomar la escritura
    let free = AtomicBool::new(false);
    let r = rescan_shared(
        &lock,
        work,
        &ScanOptions::default(),
        &|p| {
            if p.phase == ScanPhase::Walk && p.entries == 0 {
                free.store(lock.try_write().is_ok(), SeqCst);
            }
        },
        &cancel,
    )
    .unwrap();
    assert!(free.load(SeqCst));
    assert_eq!(r.row.size, 1000 + 300 + 2 * MIB as u64 + 10);
    let g = lock.read().unwrap();
    let t = &g.as_ref().unwrap().tree;
    assert_eq!(names(t, work), ["a.txt", "fresh", "new.bin", "old"]);
    drop(g);
    assert_eq!(rescan_shared(&lock, 0, &ScanOptions::default(), &|_| {}, &cancel).unwrap_err().code, "rescan.root");
}

/// Linux: sin diario, `canRefresh` es `false` y `refresh` responde `refresh.unavailable`; el árbol no guarda FRN.
#[cfg(not(windows))]
#[test]
fn refresh_is_unavailable_without_a_journal() {
    let d = fixture("sin-diario");
    let mut s = run(&d.0, false);
    assert_eq!(s.result.can_refresh, Some(false));
    assert!(!s.tree.has_frn());
    let cancel = AtomicBool::new(false);
    assert_eq!(refresh(&mut s, &ScanOptions::default(), &|_| {}, &cancel).unwrap_err().code, "refresh.unavailable");
}

#[cfg(windows)]
#[test]
fn folder_frns_and_refresh_plumbing() {
    use tessera_core::rescan::walk_jobs;
    use tessera_core::usn::{path_frn, UsnChanges, UsnCursor, UsnRecord};
    use tessera_core::Progress;
    let d = fixture("frn");
    let mut s = run(&d.0, true);
    let t = &s.tree;
    // FRN del recorrido = el del sistema (64 bits de NTFS: registro | secuencia << 48)
    let work = find(t, &d.path("work"));
    let old = find(t, &d.path("work/old"));
    for (id, rel) in [(0, ""), (work, "work"), (old, "work/old")] {
        let want = path_frn(&d.path(rel)).expect("FRN del sistema");
        assert_eq!(t.frn_of(id), Some(want), "{rel}");
        assert_eq!(t.dir_by_frn(want), Some(id));
    }
    assert_eq!(t.frn_of(find(t, &d.path("keep.txt"))), None, "los archivos no llevan");
    let (work_frn, old_frn, other_frn, root_frn) = (t.frn_of(work).unwrap(), t.frn_of(old).unwrap(), t.frn_of(find(t, &d.path("other"))).unwrap(), t.frn_of(0).unwrap());
    // Sin administrador no hay posición del diario y refresh no está disponible; elevado, funciona sin cambios
    let cancel = AtomicBool::new(false);
    if tessera_core::sys::elevation().elevated {
        let r = refresh(&mut s, &ScanOptions::default(), &|_| {}, &cancel).unwrap();
        assert_eq!(r.before, r.after);
    } else {
        assert_eq!(refresh(&mut s, &ScanOptions::default(), &|_| {}, &cancel).unwrap_err().code, "refresh.unavailable");
    }

    // Cambios: carpeta nueva work/old/n1/n2 con un archivo (padres desconocidos), un archivo en other
    // y un registro de fuera de la raíz
    d.file("work/old/n1/n2/z.bin", 4096);
    d.file("other/y.bin", 50);
    let (n1, n2) = (path_frn(&d.path("work/old/n1")).unwrap(), path_frn(&d.path("work/old/n1/n2")).unwrap());
    let f = |frn, parent, dir: bool| UsnRecord { usn: 0, frn, parent, reason: 0x100, attrs: if dir { 0x10 } else { 0x20 } };
    let recs = [
        f(1 << 40, n2, false),
        f(n2, n1, true),
        f(n1, old_frn, true),
        f(2 << 40, other_frn, false),
        f(3 << 40, 0x0005_0000_0000_0005, false),
        f(4 << 40, work_frn, false),
    ];
    let changes = UsnChanges::from_records(&recs, 12345);
    let jobs = s.refresh_jobs(&changes).unwrap();
    let mut got: Vec<String> = jobs.iter().map(|j| j.path.to_lowercase()).collect();
    got.sort();
    assert_eq!(got, [d.path("other").to_lowercase(), d.path("work").to_lowercase()], "work/old queda dentro de work");
    s.usn = Some(UsnCursor { letter: 'C', journal_id: 7, next_usn: 100 });
    let before = s.tree.size(0);
    let prog = Progress::new();
    let walked = walk_jobs(&jobs, &ScanOptions::default(), &prog, &cancel, true).unwrap();
    let r = s.apply_refresh(&jobs, walked, &changes, 1).unwrap();
    assert_eq!((r.folders, r.records, r.before, r.after), (2, 6, before, before + 4096 + 50));
    assert_eq!(s.usn.unwrap().next_usn, 12345, "posición nueva");
    let t = &s.tree;
    let n2_id = find(t, &d.path("work/old/n1/n2"));
    assert_eq!(names(t, n2_id), ["z.bin"]);
    // Las carpetas nuevas también tienen FRN
    assert_eq!(t.dir_by_frn(n2), Some(n2_id));
    assert_eq!(t.frn_of(find(t, &d.path("work/old/n1"))), Some(n1));
    assert_eq!(t.dir_by_frn(path_frn(&d.path("work")).unwrap()), Some(work));
    assert_eq!(names(t, find(t, &d.path("other"))), ["x.bin", "y.bin"]);
    // La raíz en el conjunto → journalReset (más de 2000 carpetas: prueba unitaria de rescan.rs)
    let root = UsnChanges::from_records(&[f(9 << 40, root_frn, false)], 0);
    assert_eq!(s.refresh_jobs(&root).unwrap_err().code, "refresh.journalReset");
    // Una carpeta que desapareció entre la lectura del diario y el recorrido se quita
    let jobs = s.refresh_jobs(&UsnChanges::from_records(&[f(5 << 40, n2, false)], 0)).unwrap();
    std::fs::remove_dir_all(d.0.join("work/old/n1")).unwrap();
    let walked = walk_jobs(&jobs, &ScanOptions::default(), &prog, &cancel, true).unwrap();
    let size = s.tree.size(0);
    s.apply_refresh(&jobs, walked, &UsnChanges::default(), 1).unwrap();
    assert!(!s.tree.live(n2_id));
    assert_eq!(s.tree.size(0), size - 4096);
}

/// Necesita administrador: `cargo test -p tessera-core --release -- --ignored usn_refresh` en una consola
/// elevada. Sin elevación no hace nada.
#[cfg(windows)]
#[test]
#[ignore]
fn usn_refresh_elevated() {
    if !tessera_core::sys::elevation().elevated {
        eprintln!("usn_refresh_elevated: sin administrador, no se prueba");
        return;
    }
    let d = fixture("usn");
    let mut s = run(&d.0, false);
    assert_eq!(s.result.can_refresh, Some(true), "temp en un volumen NTFS local");
    assert!(s.tree.has_frn() && s.usn.is_some());
    let cancel = AtomicBool::new(false);
    // Sin cambios en la raíz escaneada (puede haber registros de fuera, que se ignoran)
    let r = refresh(&mut s, &ScanOptions::default(), &|_| {}, &cancel).unwrap();
    assert_eq!(r.before, r.after);
    modify(&d);
    d.file("other/deep/er/z.bin", 3000);
    let before = s.tree.size(0);
    let r = refresh(&mut s, &ScanOptions::default(), &|_| {}, &cancel).unwrap();
    assert!(r.records >= 4 && r.folders >= 2, "{r:?}");
    assert_eq!((r.before, r.after), (before, before - 5000 + 2 * MIB as u64 + 10 + 3000));
    assert_eq!(s.tree.size(0), r.after);
    let t = &s.tree;
    assert_eq!(names(t, find(t, &d.path("work"))), ["a.txt", "fresh", "new.bin", "old"]);
    assert_eq!(names(t, find(t, &d.path("other/deep/er"))), ["z.bin"]);
    // Y otra vez, ya sin nada nuevo
    let r = refresh(&mut s, &ScanOptions::default(), &|_| {}, &cancel).unwrap();
    assert_eq!(r.before, r.after);
}
