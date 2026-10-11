//! Volver a escanear una carpeta del árbol cargado (`rescan`) y actualizar con el diario USN de NTFS
//! (`refresh`).
//!
//! - `rescan`: la carpeta se recorre aparte con el motor de recorrido (aunque el escaneo fuera por MFT)
//!   y con sus mismas reglas, y sólo al terminar se injerta en el árbol ([`Tree::graft`]): si se cancela,
//!   el árbol queda como estaba. La carpeta conserva su id; su contenido recibe ids nuevos y los antiguos
//!   quedan muertos (como tras la papelera). Se quita la comparación activa.
//! - `refresh`: lee el diario desde la posición guardada con el escaneo ([`UsnCursor`]), resuelve qué
//!   carpetas cambiaron (FRN → carpeta), se queda con el conjunto mínimo y vuelve a escanear cada una
//!   como `rescan`, todo en la misma operación; la posición nueva sólo se guarda si todo fue bien.
//!
//! Con el escaneo compartido ([`rescan_shared`], [`refresh_shared`]) el disco se lee sin cerrojo y el
//! injerto se hace bajo escritura: las consultas siguen respondiendo mientras tanto. Quien llama debe
//! impedir que un escaneo nuevo sustituya al cargado mientras tanto (si pasa, `error.noScan`).
//!
//! Limitaciones: los enlaces duros sólo se detectan dentro de lo vuelto a escanear (si el mismo archivo
//! tiene otro nombre fuera de la carpeta, su espacio asignado vuelve a contar); los nodos muertos ocupan
//! memoria hasta el próximo escaneo completo.
//!
//! En Linux `rescan` usa el recorrido de Unix ([`crate::walk_unix`]); no hay diario, así que `refresh`
//! responde siempre `refresh.unavailable` (`ScanResult.canRefresh` es `false`).

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::RwLock;

use crate::build::RawTree;
use crate::msg;
use crate::scan::{ticking, Progress, Scan, ScanOptions};
use crate::tree::{Tree, NONE};
use crate::types::{flag, EngineMessage, RefreshResult, RescanResult, ScanPhase, ScanProgress};
use crate::usn::{minimal_set, UsnChanges, UsnCursor, MAX_FOLDERS};

/// Una carpeta que volver a escanear, ya validada.
#[derive(Clone, Debug)]
pub struct RescanJob {
    pub id: u32,
    pub path: String,
    #[cfg_attr(not(windows), allow(dead_code))]
    wide: Vec<u16>,
    /// Sistema de archivos del volumen, en mayúsculas.
    #[cfg_attr(not(windows), allow(dead_code))]
    fs: String,
    /// Guardar el FRN de las carpetas nuevas (el árbol lo tiene).
    #[cfg_attr(not(windows), allow(dead_code))]
    frn: bool,
    /// Punto de reanálisis (junction, symlink…): no se sigue, la carpeta queda como está.
    link: bool,
}

/// Lo leído de una carpeta, listo para injertar.
pub struct Walked {
    /// `None`: la carpeta queda como está (punto de reanálisis).
    tree: Option<Tree>,
    /// Ya no existe (sólo en `refresh`): se quita del árbol.
    gone: bool,
    /// Flags de la carpeta según el sistema, si se pudieron leer.
    root_flags: Option<u16>,
    entries: u64,
    denied: u64,
    denied_samples: Vec<String>,
    errors: u64,
    error_samples: Vec<String>,
    /// Linux: sistemas de archivos montados dentro que no se recorrieron (sin los pseudo-sistemas).
    other_mounts: Vec<String>,
}

impl Walked {
    fn unchanged() -> Self {
        Walked {
            tree: None,
            gone: false,
            root_flags: None,
            entries: 0,
            denied: 0,
            denied_samples: Vec::new(),
            errors: 0,
            error_samples: Vec::new(),
            other_mounts: Vec::new(),
        }
    }

    /// Sin permiso para listar la propia carpeta: queda vacía y con el aviso, como en el escaneo.
    #[cfg(any(windows, unix))]
    fn denied(path: &str) -> Self {
        let mut r = RawTree::with_capacity(1);
        r.push(NONE, b"", 0, 0, 0, flag::DIR);
        let tree = crate::build::build(r, path.to_string(), &[]).ok();
        Walked { tree, denied: 1, denied_samples: vec![path.to_string()], ..Walked::unchanged() }
    }

    #[cfg(any(windows, unix))]
    fn gone() -> Self {
        Walked { gone: true, ..Walked::unchanged() }
    }
}

/// `scan.accessDenied` / `scan.readErrors` / `scan.otherMounts` de varias lecturas juntas.
fn warnings_of(walked: &[Walked]) -> Vec<EngineMessage> {
    let mut v = Vec::new();
    let denied: u64 = walked.iter().map(|w| w.denied).sum();
    if denied > 0 {
        let samples: Vec<String> = walked.iter().flat_map(|w| w.denied_samples.iter().cloned()).take(20).collect();
        v.push(msg::access_denied(denied, &samples));
    }
    let errors: u64 = walked.iter().map(|w| w.errors).sum();
    if errors > 0 {
        let samples: Vec<String> = walked.iter().flat_map(|w| w.error_samples.iter().cloned()).take(20).collect();
        v.push(msg::read_errors(errors, &samples));
    }
    let mounts: Vec<String> = walked.iter().flat_map(|w| w.other_mounts.iter().cloned()).collect();
    if !mounts.is_empty() {
        v.push(msg::other_mounts(mounts.len() as u64, &mounts));
    }
    v
}

impl Scan {
    /// Valida `id` para volver a escanearlo: `error.invalidNode` (no existe o se quitó), `rescan.root`
    /// (la raíz) o `error.notFolder` (un archivo).
    pub fn rescan_job(&self, id: u32) -> Result<RescanJob, EngineMessage> {
        let t = &self.tree;
        if !t.live(id) {
            return Err(msg::invalid_node(id));
        }
        if id == 0 {
            return Err(msg::rescan_root());
        }
        if !t.is_dir(id) {
            return Err(msg::not_folder(&t.path(id)));
        }
        Ok(RescanJob {
            id,
            path: t.path(id),
            wide: t.path_wide(id),
            fs: self.result.volume.as_ref().map(|v| v.fs.to_ascii_uppercase()).unwrap_or_default(),
            frn: t.has_frn(),
            link: t.flags(id) & flag::REPARSE != 0,
        })
    }

    /// Injerta lo leído de `job`. `error.invalidNode` si la carpeta ya no está (p. ej. se envió a la
    /// papelera mientras se leía).
    pub fn apply_rescan(&mut self, job: &RescanJob, walked: Walked, elapsed_ms: u64) -> Result<RescanResult, EngineMessage> {
        if !self.tree.live(job.id) {
            return Err(msg::invalid_node(job.id));
        }
        let before = self.tree.size(job.id);
        let warnings = warnings_of(std::slice::from_ref(&walked));
        let entries = walked.entries;
        self.graft(job, walked)?;
        Ok(RescanResult { row: self.tree.row(job.id), before, entries, elapsed_ms, warnings })
    }

    fn graft(&mut self, job: &RescanJob, w: Walked) -> Result<(), EngineMessage> {
        if w.gone {
            let _ = self.tree.remove(job.id);
        } else if let Some(sub) = w.tree {
            self.tree.graft(job.id, sub, w.root_flags).map_err(|e| msg::internal(&e))?;
        }
        self.tree.set_comparison(None);
        let t = &self.tree;
        let r = &mut self.result;
        (r.files, r.dirs, r.bytes) = (t.files(0) as u64, t.dirs(0) as u64, t.size(0));
        r.entries = r.files + r.dirs;
        Ok(())
    }

    /// Posición del diario para `refresh`; `refresh.unavailable` si el escaneo no la guardó.
    pub fn refresh_cursor(&self) -> Result<UsnCursor, EngineMessage> {
        self.usn.filter(|_| self.tree.has_frn()).ok_or_else(msg::refresh_unavailable)
    }

    /// Carpetas que volver a escanear según `changes`: el conjunto mínimo de las que cambiaron. Si queda
    /// la raíz o más de [`MAX_FOLDERS`], `refresh.journalReset` (sale más a cuenta un escaneo completo).
    pub fn refresh_jobs(&self, changes: &UsnChanges) -> Result<Vec<RescanJob>, EngineMessage> {
        let ids = changes.resolve(|f| self.tree.dir_by_frn(f));
        let set = minimal_set(&self.tree, &ids);
        if set.contains(&0) || set.len() > MAX_FOLDERS {
            return Err(msg::refresh_journal_reset());
        }
        set.into_iter().map(|id| self.rescan_job(id)).collect()
    }

    /// Injerta lo leído de cada carpeta (lo que ya no está en el árbol se salta) y guarda la posición
    /// nueva del diario y la fecha del escaneo.
    pub fn apply_refresh(&mut self, jobs: &[RescanJob], walked: Vec<Walked>, changes: &UsnChanges, elapsed_ms: u64) -> Result<RefreshResult, EngineMessage> {
        let before = self.tree.size(0);
        let warnings = warnings_of(&walked);
        for (job, w) in jobs.iter().zip(walked) {
            if self.tree.live(job.id) {
                self.graft(job, w)?;
            }
        }
        if let Some(c) = self.usn.as_mut() {
            c.next_usn = changes.next_usn;
        }
        self.scanned_at = crate::query::now_secs() as u64;
        Ok(RefreshResult { folders: jobs.len() as u64, records: changes.records, before, after: self.tree.size(0), elapsed_ms, warnings })
    }
}

impl RescanJob {
    /// Lee la carpeta con el motor de recorrido, sin tocar el árbol. Sin permiso para listarla, queda
    /// vacía con el aviso; si ya no existe, `error.cannotOpen` (con `gone_ok`, se quitará del árbol).
    #[cfg(windows)]
    fn walk(&self, pool: &rayon::ThreadPool, opts: &ScanOptions, prog: &Progress, cancel: &AtomicBool, gone_ok: bool) -> Result<Walked, EngineMessage> {
        use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};
        if cancel.load(Relaxed) {
            return Err(msg::cancelled());
        }
        if self.link {
            return Ok(Walked::unchanged());
        }
        let rh = match crate::walk::open_dir_wide(&self.wide) {
            Ok(h) => h,
            Err(ERROR_ACCESS_DENIED) => return Ok(Walked::denied(&self.path)),
            Err(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) if gone_ok => return Ok(Walked::gone()),
            Err(code) => return Err(msg::cannot_open(&self.path, &crate::sys::error_text(code as i32))),
        };
        let wo = crate::scan::walk_options(&self.path, &self.fs, self.frn, pool.current_num_threads(), opts);
        let out = crate::walk::walk_in(pool, rh, &self.path, &wo, prog, cancel)?;
        let root_flags = (out.root_attrs != 0).then(|| crate::attrs::flags_of(out.root_attrs, out.root_tag) | flag::DIR);
        let path = self.path.clone();
        let tree = pool.install(|| crate::build::build(out.raw, path, &[])).map_err(|e| msg::internal(&e))?;
        Ok(Walked {
            entries: tree.files(0) as u64 + tree.dirs(0) as u64,
            tree: Some(tree),
            gone: false,
            root_flags,
            denied: out.denied,
            denied_samples: out.denied_samples,
            errors: out.errors,
            error_samples: out.error_samples,
            other_mounts: Vec::new(),
        })
    }

    /// Como en Windows, con el recorrido de Unix (no cruza a otros sistemas de archivos y avisa de ellos).
    #[cfg(unix)]
    fn walk(&self, pool: &rayon::ThreadPool, opts: &ScanOptions, prog: &Progress, cancel: &AtomicBool, gone_ok: bool) -> Result<Walked, EngineMessage> {
        if cancel.load(Relaxed) {
            return Err(msg::cancelled());
        }
        if self.link {
            return Ok(Walked::unchanged());
        }
        let rh = match crate::walk_unix::open_root(&self.path) {
            Ok(h) => h,
            Err(e) => match e.raw_os_error() {
                Some(libc::EACCES | libc::EPERM) => return Ok(Walked::denied(&self.path)),
                Some(libc::ENOENT | libc::ENOTDIR) if gone_ok => return Ok(Walked::gone()),
                _ => return Err(msg::cannot_open(&self.path, &crate::sys::io_error_text(&e))),
            },
        };
        let wo = crate::scan::walk_options(pool.current_num_threads(), opts);
        let out = crate::walk_unix::walk_in(pool, rh, &self.path, &wo, prog, cancel)?;
        let path = self.path.clone();
        let tree = pool.install(|| crate::build::build(out.raw, path, &[])).map_err(|e| msg::internal(&e))?;
        Ok(Walked {
            entries: tree.files(0) as u64 + tree.dirs(0) as u64,
            tree: Some(tree),
            gone: false,
            root_flags: None,
            denied: out.denied,
            denied_samples: out.denied_samples,
            errors: out.errors,
            error_samples: out.error_samples,
            other_mounts: out.other_mounts,
        })
    }
}

/// Lee cada carpeta con el motor de recorrido, en orden y con un único pool (el progreso se acumula en
/// `prog`). Con `gone_ok`, una carpeta que ya no existe se quitará del árbol en vez de dar error.
#[cfg(any(windows, unix))]
pub fn walk_jobs(jobs: &[RescanJob], opts: &ScanOptions, prog: &Progress, cancel: &AtomicBool, gone_ok: bool) -> Result<Vec<Walked>, EngineMessage> {
    if jobs.is_empty() {
        return Ok(Vec::new());
    }
    let threads = if opts.threads == 0 { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) } else { opts.threads };
    #[cfg(windows)]
    let pool = crate::walk::pool(threads)?;
    #[cfg(unix)]
    let pool = crate::walk_unix::pool(threads)?;
    jobs.iter().map(|j| j.walk(&pool, opts, prog, cancel, gone_ok)).collect()
}

#[cfg(not(any(windows, unix)))]
pub fn walk_jobs(jobs: &[RescanJob], _opts: &ScanOptions, _prog: &Progress, _cancel: &AtomicBool, _gone_ok: bool) -> Result<Vec<Walked>, EngineMessage> {
    if jobs.is_empty() {
        Ok(Vec::new())
    } else {
        Err(msg::unsupported_platform())
    }
}

// ---------- Acceso al escaneo: propio o compartido ----------

trait Access {
    fn read<T>(&self, f: impl FnOnce(&Scan) -> Result<T, EngineMessage>) -> Result<T, EngineMessage>;
    fn write<T>(&self, f: impl FnOnce(&mut Scan) -> Result<T, EngineMessage>) -> Result<T, EngineMessage>;
}

struct Owned<'a>(RefCell<&'a mut Scan>);

impl Access for Owned<'_> {
    fn read<T>(&self, f: impl FnOnce(&Scan) -> Result<T, EngineMessage>) -> Result<T, EngineMessage> {
        f(&self.0.borrow())
    }
    fn write<T>(&self, f: impl FnOnce(&mut Scan) -> Result<T, EngineMessage>) -> Result<T, EngineMessage> {
        f(&mut self.0.borrow_mut())
    }
}

/// Cerrojo de lectura para validar y resolver, de escritura sólo para injertar. Comprueba que el
/// escaneo sigue siendo el mismo entre una toma y otra.
struct Shared<'a> {
    lock: &'a RwLock<Option<Scan>>,
    serial: Cell<Option<u64>>,
}

impl Shared<'_> {
    fn same(&self, s: &Scan) -> Result<(), EngineMessage> {
        match self.serial.get() {
            None => {
                self.serial.set(Some(s.serial));
                Ok(())
            }
            Some(x) if x == s.serial => Ok(()),
            Some(_) => Err(msg::no_scan()),
        }
    }
}

fn poisoned<T>(_: T) -> EngineMessage {
    msg::internal("State lock poisoned")
}

impl Access for Shared<'_> {
    fn read<T>(&self, f: impl FnOnce(&Scan) -> Result<T, EngineMessage>) -> Result<T, EngineMessage> {
        let g = self.lock.read().map_err(poisoned)?;
        let s = g.as_ref().ok_or_else(msg::no_scan)?;
        self.same(s)?;
        f(s)
    }
    fn write<T>(&self, f: impl FnOnce(&mut Scan) -> Result<T, EngineMessage>) -> Result<T, EngineMessage> {
        let mut g = self.lock.write().map_err(poisoned)?;
        let s = g.as_mut().ok_or_else(msg::no_scan)?;
        self.same(s)?;
        f(s)
    }
}

/// Último evento de progreso: `done` con (entradas, bytes) o `error` (el error viaja en el Err).
fn finish<T>(prog: &Progress, on_progress: &(dyn Fn(ScanProgress) + Sync), r: &Result<T, EngineMessage>, totals: impl Fn(&T) -> (u64, u64)) {
    let p = match r {
        Ok(x) => {
            let (entries, bytes) = totals(x);
            prog.set_phase(ScanPhase::Done);
            ScanProgress { phase: ScanPhase::Done, entries, bytes, elapsed_ms: prog.elapsed_ms(), detail: None, fraction: Some(1.0) }
        }
        Err(_) => {
            prog.set_phase(ScanPhase::Error);
            let mut p = prog.snapshot();
            p.detail = None;
            p
        }
    };
    on_progress(p);
}

fn rescan_with(acc: &impl Access, id: u32, opts: &ScanOptions, on_progress: &(dyn Fn(ScanProgress) + Sync), cancel: &AtomicBool) -> Result<RescanResult, EngineMessage> {
    let prog = Progress::new();
    prog.set_phase(ScanPhase::Walk);
    let job = acc.read(|s| s.rescan_job(id))?;
    on_progress(prog.snapshot());
    let r = ticking(&prog, opts.tick, on_progress, || {
        let walked = walk_jobs(std::slice::from_ref(&job), opts, &prog, cancel, false)?.pop().ok_or_else(|| msg::internal("Nothing walked"))?;
        // Una cancelación que llega al final tampoco toca el árbol
        if cancel.load(Relaxed) {
            return Err(msg::cancelled());
        }
        acc.write(|s| s.apply_rescan(&job, walked, prog.elapsed_ms()))
    });
    finish(&prog, on_progress, &r, |r| (r.entries, r.row.size));
    r
}

fn refresh_with(acc: &impl Access, opts: &ScanOptions, on_progress: &(dyn Fn(ScanProgress) + Sync), cancel: &AtomicBool) -> Result<RefreshResult, EngineMessage> {
    let prog = Progress::new();
    let cursor = acc.read(|s| s.refresh_cursor())?;
    *prog.detail.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(format!("{}:\\", cursor.letter));
    on_progress(prog.snapshot());
    let r = ticking(&prog, opts.tick, on_progress, || {
        // 1) Diario (fase `starting`; `entries` = registros leídos)
        let changes = crate::usn::read_changes(&cursor, &prog, cancel)?;
        // 2) Carpetas que cambiaron
        let jobs = acc.read(|s| s.refresh_jobs(&changes))?;
        // 3) Volver a escanearlas (fase `walk`, progreso acumulado) y 4) injertarlas juntas
        prog.set_phase(ScanPhase::Walk);
        prog.entries.store(0, Relaxed);
        prog.bytes.store(0, Relaxed);
        let walked = walk_jobs(&jobs, opts, &prog, cancel, true)?;
        if cancel.load(Relaxed) {
            return Err(msg::cancelled());
        }
        acc.write(|s| s.apply_refresh(&jobs, walked, &changes, prog.elapsed_ms()))
    });
    let entries = prog.entries.load(Relaxed);
    finish(&prog, on_progress, &r, |r| (entries, r.after));
    r
}

/// Vuelve a escanear la carpeta `id` del escaneo `scan` (ver el módulo). Progreso como el del escaneo
/// (`walk` y al final `done`); con `cancel` → `error.cancelled` y el árbol queda como estaba.
pub fn rescan(scan: &mut Scan, id: u32, opts: &ScanOptions, on_progress: &(dyn Fn(ScanProgress) + Sync), cancel: &AtomicBool) -> Result<RescanResult, EngineMessage> {
    rescan_with(&Owned(RefCell::new(scan)), id, opts, on_progress, cancel)
}

/// [`rescan`] sobre el escaneo compartido: lee el disco sin cerrojo e injerta bajo escritura.
pub fn rescan_shared(
    lock: &RwLock<Option<Scan>>,
    id: u32,
    opts: &ScanOptions,
    on_progress: &(dyn Fn(ScanProgress) + Sync),
    cancel: &AtomicBool,
) -> Result<RescanResult, EngineMessage> {
    rescan_with(&Shared { lock, serial: Cell::new(None) }, id, opts, on_progress, cancel)
}

/// Actualiza con el diario USN (ver el módulo): `refresh.unavailable` sin `canRefresh`,
/// `refresh.journalReset` si el diario no sirve, `error.cancelled` (el árbol queda como estaba).
pub fn refresh(scan: &mut Scan, opts: &ScanOptions, on_progress: &(dyn Fn(ScanProgress) + Sync), cancel: &AtomicBool) -> Result<RefreshResult, EngineMessage> {
    refresh_with(&Owned(RefCell::new(scan)), opts, on_progress, cancel)
}

/// [`refresh`] sobre el escaneo compartido: lee el disco sin cerrojo e injerta bajo escritura.
pub fn refresh_shared(lock: &RwLock<Option<Scan>>, opts: &ScanOptions, on_progress: &(dyn Fn(ScanProgress) + Sync), cancel: &AtomicBool) -> Result<RefreshResult, EngineMessage> {
    refresh_with(&Shared { lock, serial: Cell::new(None) }, opts, on_progress, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Engine, ScanResult};
    use crate::usn::UsnRecord;

    /// Raíz con `n` carpetas, cada una con su FRN (1000 + i) y un archivo.
    fn scan_with(n: u32) -> Scan {
        let mut r = RawTree::with_capacity(2 * n as usize + 1);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        r.frn.push((root, 5));
        for i in 0..n {
            let d = r.push(root, format!("d{i}").as_bytes(), 0, 0, 0, flag::DIR);
            r.push(d, b"f.bin", 10, 16, 0, 0);
            r.frn.push((d, 1000 + i as u64));
        }
        r.root = root;
        let tree = crate::build::build(r, "C:\\x".into(), &[]).unwrap();
        let result = ScanResult {
            root_id: 0,
            root_path: "C:\\x".into(),
            engine: Engine::Walk,
            entries: 0,
            files: 0,
            dirs: 0,
            bytes: 0,
            elapsed_ms: 0,
            volume: None,
            warnings: vec![],
            can_refresh: Some(true),
        };
        Scan { tree, result, scanned_at: 0, usn: Some(UsnCursor { letter: 'C', journal_id: 1, next_usn: 0 }), serial: 0 }
    }

    fn changes(dirs: std::ops::Range<u64>) -> UsnChanges {
        let recs: Vec<UsnRecord> = dirs.map(|f| UsnRecord { usn: 0, frn: 1 << 40 | f, parent: f, reason: 2, attrs: 0 }).collect();
        UsnChanges::from_records(&recs, 9)
    }

    #[test]
    fn too_many_folders_or_the_root() {
        let s = scan_with(MAX_FOLDERS as u32 + 1);
        assert_eq!(s.refresh_cursor().unwrap().journal_id, 1);
        assert_eq!(s.refresh_jobs(&changes(1000..1000 + MAX_FOLDERS as u64)).unwrap().len(), MAX_FOLDERS);
        assert_eq!(s.refresh_jobs(&changes(1000..1001 + MAX_FOLDERS as u64)).unwrap_err().code, "refresh.journalReset");
        assert_eq!(s.refresh_jobs(&changes(5..6)).unwrap_err().code, "refresh.journalReset");
        // Fuera de la raíz: nada que hacer
        assert!(s.refresh_jobs(&changes(1..4)).unwrap().is_empty());
        let mut s2 = scan_with(1);
        s2.usn = None;
        assert_eq!(s2.refresh_cursor().unwrap_err().code, "refresh.unavailable");
        s2.usn = Some(UsnCursor { letter: 'C', journal_id: 1, next_usn: 0 });
        s2.tree.drop_frn();
        assert_eq!(s2.refresh_cursor().unwrap_err().code, "refresh.unavailable");
    }

    #[test]
    fn job_validation_and_warnings() {
        let s = scan_with(2);
        assert_eq!(s.rescan_job(0).unwrap_err().code, "rescan.root");
        let d = s.tree.kids(0).get(0);
        let f = s.tree.kids(d).get(0);
        let j = s.rescan_job(d).unwrap();
        assert_eq!((j.id, j.path.as_str(), j.frn, j.link), (d, s.tree.path(d).as_str(), true, false));
        assert_eq!(s.rescan_job(f).unwrap_err().code, "error.notFolder");
        assert_eq!(s.rescan_job(99).unwrap_err().code, "error.invalidNode");
        let w = |denied: u64, errors: u64, p: &str| Walked {
            denied,
            errors,
            denied_samples: vec![format!("{p}-d")],
            error_samples: vec![format!("{p}-e")],
            ..Walked::unchanged()
        };
        let v = warnings_of(&[w(1, 0, "a"), w(2, 3, "b")]);
        assert_eq!(v.len(), 2);
        assert_eq!((v[0].code.as_str(), v[0].get("count")), ("scan.accessDenied", Some(&crate::types::Param::Int(3))));
        assert_eq!(v[1].get("count"), Some(&crate::types::Param::Int(3)));
        assert_eq!(v[0].get("sample"), Some(&crate::types::Param::Str("a-d, b-d".into())));
        assert!(warnings_of(&[Walked::unchanged()]).is_empty());
        let m = |p: &str| Walked { other_mounts: vec![p.to_string()], ..Walked::unchanged() };
        let v = warnings_of(&[m("/srv/a"), Walked::unchanged(), m("/srv/b")]);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].code.as_str(), v[0].get("count")), ("scan.otherMounts", Some(&crate::types::Param::Int(2))));
        assert_eq!(v[0].get("paths"), Some(&crate::types::Param::Str("/srv/a, /srv/b".into())));
    }

    #[test]
    fn link_folders_stay_as_they_are() {
        // Un punto de reanálisis no se sigue: la carpeta queda igual (y se quita la comparación)
        let mut s = scan_with(1);
        let d = s.tree.kids(0).get(0);
        s.tree.flags[d as usize] |= flag::REPARSE;
        s.tree.set_comparison(Some(std::sync::Arc::new(crate::history::Comparison::default())));
        let (len, size) = (s.tree.len(), s.tree.size(0));
        let r = rescan(&mut s, d, &ScanOptions::default(), &|_| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!((r.before, r.row.size, r.entries, s.tree.len(), s.tree.size(0)), (10, 10, 0, len, size));
        assert!(s.tree.comparison().is_none());
    }
}
