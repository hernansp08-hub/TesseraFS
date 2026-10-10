//! Orquestación del escaneo: elección de motor, progreso periódico y construcción del árbol.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::build::{build, RawTree};
use crate::msg;
use crate::sys;
use crate::tree::Tree;
use crate::types::{Engine, EngineChoice, EngineMessage, ScanPhase, ScanProgress, ScanResult, VolumeInfo};

/// Contadores compartidos con los motores; un hilo los publica a ~15 Hz.
pub struct Progress {
    phase: AtomicU8,
    pub entries: AtomicU64,
    pub bytes: AtomicU64,
    pub want_detail: AtomicBool,
    pub detail: Mutex<Option<String>>,
    /// Trabajo hecho y total (bytes de la MFT); con total > 0 se publica `fraction`.
    pub work_done: AtomicU64,
    pub work_total: AtomicU64,
    start: Instant,
}

const PHASES: [ScanPhase; 7] =
    [ScanPhase::Starting, ScanPhase::MftRead, ScanPhase::Walk, ScanPhase::Link, ScanPhase::Aggregate, ScanPhase::Done, ScanPhase::Error];

impl Progress {
    pub fn new() -> Self {
        Progress {
            phase: AtomicU8::new(0),
            entries: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            want_detail: AtomicBool::new(true),
            detail: Mutex::new(None),
            work_done: AtomicU64::new(0),
            work_total: AtomicU64::new(0),
            start: Instant::now(),
        }
    }
    pub fn set_phase(&self, p: ScanPhase) {
        let i = PHASES.iter().position(|&x| x == p).unwrap_or(0);
        self.phase.store(i as u8, Relaxed);
    }
    pub fn phase(&self) -> ScanPhase {
        PHASES[self.phase.load(Relaxed) as usize % PHASES.len()]
    }
    pub fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
    pub fn snapshot(&self) -> ScanProgress {
        let detail = self.detail.lock().unwrap().take();
        self.want_detail.store(true, Relaxed);
        let phase = self.phase();
        let total = self.work_total.load(Relaxed);
        let fraction = match phase {
            ScanPhase::MftRead if total > 0 => Some((self.work_done.load(Relaxed) as f64 / total as f64).min(1.0)),
            ScanPhase::Link | ScanPhase::Aggregate if total > 0 => Some(1.0),
            _ => None,
        };
        ScanProgress {
            phase,
            entries: self.entries.load(Relaxed),
            bytes: self.bytes.load(Relaxed),
            elapsed_ms: self.elapsed_ms(),
            detail,
            fraction,
        }
    }
}

impl Default for Progress {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug)]
pub struct ScanOptions {
    /// Hilos del recorrido (0 = núcleos lógicos).
    pub threads: usize,
    /// Búfer por hilo para `NtQueryDirectoryFile` (local; en red se usan 64 KiB).
    pub buf_size: usize,
    /// Intervalo de progreso.
    pub tick: Duration,
}

impl Default for ScanOptions {
    fn default() -> Self {
        ScanOptions { threads: 0, buf_size: 1 << 20, tick: Duration::from_millis(66) }
    }
}

pub struct Scan {
    pub tree: Tree,
    pub result: ScanResult,
    /// Cuándo terminó, en segundos Unix (para el historial).
    pub scanned_at: u64,
}

/// Normaliza a ruta absoluta: "C:" → "C:\\", sin barra final salvo en la raíz.
pub fn normalize_path(path: &str) -> Result<String, EngineMessage> {
    let p = path.trim().trim_matches('"');
    if p.is_empty() {
        return Err(msg::invalid_path(path));
    }
    let p = if p.len() == 2 && p.as_bytes()[1] == b':' { format!("{p}\\") } else { p.to_string() };
    let abs = std::path::absolute(&p).map_err(|_| msg::invalid_path(path))?;
    let mut s = abs.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = if let Some(unc) = rest.strip_prefix(r"UNC\") { format!(r"\\{unc}") } else { rest.to_string() };
    }
    let is_drive_root = s.len() == 3 && s.ends_with(":\\");
    while s.ends_with('\\') && !is_drive_root && s.len() > 3 && !s.ends_with(":\\") {
        s.pop();
    }
    if s.len() == 3 && s.as_bytes()[1] == b':' {
        s.make_ascii_uppercase();
    } else if s.as_bytes().get(1) == Some(&b':') {
        let first = s[..1].to_ascii_uppercase();
        s.replace_range(..1, &first);
    }
    Ok(s)
}

fn drive_letter(root: &str) -> Option<char> {
    let b = root.as_bytes();
    (b.len() == 3 && b[1] == b':' && b[2] == b'\\' && b[0].is_ascii_alphabetic()).then(|| b[0].to_ascii_uppercase() as char)
}

/// Escanea `path` y devuelve el árbol. `on_progress` se llama a ~15 Hz desde otro hilo.
pub fn scan(
    path: &str,
    choice: EngineChoice,
    opts: &ScanOptions,
    on_progress: &(dyn Fn(ScanProgress) + Sync),
    cancel: &AtomicBool,
) -> Result<Scan, EngineMessage> {
    let prog = Progress::new();
    let root = normalize_path(path)?;
    sys::check_folder(&root)?;
    on_progress(prog.snapshot());
    let vol_root = sys::volume_root_of(&root).unwrap_or_else(|| root.clone());
    let volume: Option<VolumeInfo> = sys::volume_info(&vol_root);
    let fs = volume.as_ref().map(|v| v.fs.to_ascii_uppercase()).unwrap_or_default();
    let whole_volume = root.eq_ignore_ascii_case(vol_root.trim_end_matches('\\')) || root.eq_ignore_ascii_case(&vol_root);
    let mut warnings: Vec<EngineMessage> = Vec::new();
    let want_mft = match choice {
        EngineChoice::Walk => false,
        EngineChoice::Mft => true,
        EngineChoice::Auto => whole_volume,
    };
    let done = AtomicBool::new(false);
    let threads = if opts.threads == 0 { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) } else { opts.threads };

    let outcome = std::thread::scope(|s| {
        s.spawn(|| {
            let mut last = Instant::now();
            while !done.load(Relaxed) {
                std::thread::sleep(Duration::from_millis(10));
                if last.elapsed() >= opts.tick && !done.load(Relaxed) {
                    last = Instant::now();
                    on_progress(prog.snapshot());
                }
            }
        });
        let r = run_engines(&root, &vol_root, &fs, whole_volume, want_mft, threads, opts, &prog, cancel, &mut warnings);
        done.store(true, Relaxed);
        r
    });
    let (tree, engine) = match outcome {
        Ok(x) => x,
        Err(e) => {
            // El error viaja en el Err; `detail` sólo lleva rutas
            prog.set_phase(ScanPhase::Error);
            let mut p = prog.snapshot();
            p.detail = None;
            on_progress(p);
            return Err(e);
        }
    };
    let result = ScanResult {
        root_id: 0,
        root_path: root,
        engine,
        entries: tree.files(0) as u64 + tree.dirs(0) as u64,
        files: tree.files(0) as u64,
        dirs: tree.dirs(0) as u64,
        bytes: tree.size(0),
        elapsed_ms: prog.elapsed_ms(),
        volume,
        warnings,
    };
    prog.set_phase(ScanPhase::Done);
    on_progress(ScanProgress {
        phase: ScanPhase::Done,
        entries: result.entries,
        bytes: result.bytes,
        elapsed_ms: result.elapsed_ms,
        detail: None,
        fraction: Some(1.0),
    });
    Ok(Scan { tree, result, scanned_at: crate::query::now_secs() as u64 })
}

#[allow(clippy::too_many_arguments)]
fn run_engines(
    root: &str,
    vol_root: &str,
    fs: &str,
    whole_volume: bool,
    want_mft: bool,
    threads: usize,
    opts: &ScanOptions,
    prog: &Progress,
    cancel: &AtomicBool,
    warnings: &mut Vec<EngineMessage>,
) -> Result<(Tree, Engine), EngineMessage> {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(|e| e.to_string())?;
    if want_mft {
        let letter = drive_letter(vol_root);
        // Primero lo que no funcionaría ni con administrador
        if sys::is_network(vol_root) {
            warnings.push(msg::mft_network_path());
        } else if fs != "NTFS" || letter.is_none() {
            warnings.push(msg::mft_unsupported_fs(if fs.is_empty() { "?" } else { fs }));
        } else if !sys::elevation().elevated {
            warnings.push(msg::mft_needs_admin());
        } else {
            #[cfg(windows)]
            {
                prog.set_phase(ScanPhase::MftRead);
                *prog.detail.lock().unwrap() = Some(vol_root.to_string());
                match pool.install(|| crate::mft::read_mft(letter.unwrap(), prog, cancel)) {
                    Ok(out) => {
                        if out.orphans > 0 {
                            warnings.push(msg::mft_orphans(out.orphans));
                        }
                        prog.set_phase(ScanPhase::Aggregate);
                        let sub: Vec<String> = if whole_volume {
                            Vec::new()
                        } else {
                            root[vol_root.len()..].split('\\').filter(|c| !c.is_empty()).map(str::to_string).collect()
                        };
                        let display = if whole_volume { vol_root.to_string() } else { root.to_string() };
                        match pool.install(|| build(out.raw, display, &sub)) {
                            Ok(tree) => return Ok((tree, Engine::Mft)),
                            Err(e) => warnings.push(msg::mft_failed(&e)),
                        }
                    }
                    Err(_) if cancel.load(Relaxed) => return Err(msg::cancelled()),
                    Err(e) => warnings.push(msg::mft_failed(&e)),
                }
            }
        }
    }
    prog.set_phase(ScanPhase::Walk);
    prog.entries.store(0, Relaxed);
    prog.bytes.store(0, Relaxed);
    let raw = walk_engine(root, fs, threads, opts, prog, cancel, warnings)?;
    prog.set_phase(ScanPhase::Aggregate);
    let tree = pool.install(|| build(raw, root.to_string(), &[]))?;
    Ok((tree, Engine::Walk))
}

#[cfg(windows)]
fn walk_engine(
    root: &str,
    fs: &str,
    threads: usize,
    opts: &ScanOptions,
    prog: &Progress,
    cancel: &AtomicBool,
    warnings: &mut Vec<EngineMessage>,
) -> Result<RawTree, EngineMessage> {
    let remote = root.starts_with(r"\\");
    let wo = crate::walk::WalkOptions {
        threads,
        buf_size: if remote { 64 * 1024 } else { opts.buf_size },
        dedupe_links: matches!(fs, "NTFS" | "REFS"),
    };
    let out = crate::walk::walk(root, &wo, prog, cancel)?;
    if out.denied > 0 {
        warnings.push(msg::access_denied(out.denied, &out.denied_samples));
    }
    if out.errors > 0 {
        warnings.push(msg::read_errors(out.errors, &out.error_samples));
    }
    Ok(out.raw)
}

#[cfg(not(windows))]
fn walk_engine(
    _root: &str,
    _fs: &str,
    _threads: usize,
    _opts: &ScanOptions,
    _prog: &Progress,
    _cancel: &AtomicBool,
    _warnings: &mut Vec<EngineMessage>,
) -> Result<RawTree, EngineMessage> {
    Err(msg::unsupported_platform())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize_path("c:").unwrap(), "C:\\");
        assert_eq!(normalize_path("C:\\").unwrap(), "C:\\");
        assert_eq!(normalize_path("c:\\Windows\\").unwrap(), "C:\\Windows");
        assert_eq!(normalize_path("\"C:\\Program Files\"").unwrap(), "C:\\Program Files");
        assert_eq!(drive_letter("D:\\"), Some('D'));
        assert_eq!(drive_letter("\\\\srv\\x\\"), None);
        assert_eq!(normalize_path("  ").unwrap_err().code, "error.invalidPath");
    }
}
