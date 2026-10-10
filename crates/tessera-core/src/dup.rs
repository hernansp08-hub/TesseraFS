//! Búsqueda de archivos duplicados sobre un árbol ya escaneado (mismo algoritmo que el motor Bun).
//!
//! Tres pasadas: tamaño (sin leer nada), los primeros 64 KiB y el contenido completo, con BLAKE3.
//! En los archivos de hasta 64 KiB el hash del prefijo ya es el del contenido completo. Quedan fuera
//! los enlaces duros (borrar uno no libera nada), los archivos sólo en la nube (leerlos los
//! descargaría) y los puntos de reanálisis. Cada archivo se abre por su ruta UTF-16 exacta con
//! `\\?\`, compartiendo lectura, escritura y borrado, y se lee en bloques de 1 MiB en un pool fijo.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{ErrorKind, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use rayon::prelude::*;

use crate::msg;
use crate::names;
use crate::tree::Tree;
use crate::types::{flag, DupGroup, DupPhase, DupProgress, DupResult, DupSkipped, EngineMessage, SearchRow};

/// Bytes que lee la segunda pasada.
pub const PREFIX: u64 = 64 * 1024;
/// Máximo de grupos devueltos (`limit` se recorta a 1..=MAX_LIMIT).
pub const MAX_LIMIT: u32 = 5000;
const BUF_SIZE: usize = 1 << 20;
const THREADS: usize = 4;
const TICK: Duration = Duration::from_millis(100);

type Hash = [u8; 32];
/// (tamaño, hash, ids)
type Group = (u64, Hash, Vec<u32>);

thread_local! {
    static BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Busca duplicados bajo `root`. `prog` se llama desde los hilos de lectura (como mucho cada
/// 100 ms por pasada) y una última vez con `done`. Con `cancel` activo → `error.cancelled`.
pub fn duplicates(
    tree: &Tree,
    root: u32,
    min_size: u64,
    limit: u32,
    prog: &(dyn Fn(DupProgress) + Sync),
    cancel: &AtomicBool,
) -> Result<DupResult, EngineMessage> {
    let start = Instant::now();
    if !tree.live(root) {
        return Err(msg::invalid_node(root));
    }
    if cancel.load(Relaxed) {
        return Err(msg::cancelled());
    }
    let elapsed = || start.elapsed().as_millis() as u64;

    // 1) Tamaño: sólo sobreviven los tamaños repetidos
    let mut skipped = DupSkipped::default();
    let mut files = collect(tree, root, min_size.max(1), &mut skipped);
    files.sort_unstable();
    let mut cand: Vec<(u32, u64)> = files.chunk_by(|a, b| a.0 == b.0).filter(|r| r.len() >= 2).flatten().map(|&(s, id)| (id, s)).collect();
    drop(files);
    // Por id: orden del árbol, carpeta a carpeta (lecturas más cercanas en disco)
    cand.sort_unstable();
    let candidates = cand.len() as u64;
    prog(DupProgress { phase: DupPhase::Size, files: candidates, total_files: candidates, bytes: 0, total_bytes: 0, elapsed_ms: elapsed() });

    let mut groups: Vec<Group> = Vec::new();
    let (mut read_bytes, mut errors) = (0, 0);
    if !cand.is_empty() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(THREADS)
            .thread_name(|i| format!("tessera-dup-{i}"))
            .build()
            .map_err(|e| msg::internal(&e.to_string()))?;
        let ctx = Ctx { tree, prog, cancel, start, pool, read_bytes: AtomicU64::new(0), errors: AtomicU64::new(0) };
        // 2) Primeros 64 KiB: en los archivos pequeños ya es el contenido completo
        let hashes = ctx.pass(DupPhase::Prefix, &cand)?;
        let mut full: Vec<(u32, u64)> = Vec::new();
        for g in regroup(&cand, hashes) {
            if g.0 <= PREFIX {
                groups.push(g);
            } else {
                full.extend(g.2.iter().map(|&id| (id, g.0)));
            }
        }
        // 3) Contenido completo
        if !full.is_empty() {
            full.sort_unstable();
            let hashes = ctx.pass(DupPhase::Full, &full)?;
            groups.extend(regroup(&full, hashes));
        }
        read_bytes = ctx.read_bytes.load(Relaxed);
        errors = ctx.errors.load(Relaxed);
    }

    let wasted_of = |g: &Group| (g.2.len() as u64 - 1).saturating_mul(g.0);
    // Espacio recuperable desc, tamaño desc y hash (desempate estable entre motores)
    groups.sort_unstable_by(|a, b| wasted_of(b).cmp(&wasted_of(a)).then(b.0.cmp(&a.0)).then(a.1.cmp(&b.1)));
    let total_groups = groups.len() as u64;
    let wasted = groups.iter().map(wasted_of).sum();
    groups.truncate(limit.clamp(1, MAX_LIMIT) as usize);
    let groups = groups
        .into_iter()
        .map(|(size, hash, ids)| {
            let mut files: Vec<SearchRow> = ids.into_iter().map(|id| SearchRow { node: tree.row(id), path: tree.path(id) }).collect();
            files.sort_by(|a, b| names::cmp_ci(a.path.as_bytes(), b.path.as_bytes()));
            DupGroup { size, hash: blake3::Hash::from_bytes(hash).to_hex().to_string(), files }
        })
        .collect();
    let mut warnings = Vec::new();
    if errors > 0 {
        warnings.push(msg::dup_read_errors(errors));
    }
    let elapsed_ms = elapsed();
    prog(DupProgress { phase: DupPhase::Done, files: candidates, total_files: candidates, bytes: read_bytes, total_bytes: read_bytes, elapsed_ms });
    Ok(DupResult { groups, total_groups, wasted, candidates, read_bytes, skipped, elapsed_ms, warnings })
}

/// Archivos bajo `root` (o `root` si es un archivo) con `size >= min`, como (tamaño, id).
/// Cuenta los enlaces duros y los archivos en la nube que deja fuera; los puntos de
/// reanálisis se omiten sin contarlos.
fn collect(t: &Tree, root: u32, min: u64, skipped: &mut DupSkipped) -> Vec<(u64, u32)> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let f = t.flags(id);
        if f & flag::DIR != 0 {
            if id == root || f & flag::REPARSE == 0 {
                let kids = t.kids(id);
                stack.extend((0..kids.len()).map(|i| kids.get(i)));
            }
            continue;
        }
        let size = t.size(id);
        if size < min || f & flag::REPARSE != 0 {
            continue;
        }
        if f & flag::HARDLINK != 0 {
            skipped.hardlinks += 1;
        } else if f & flag::CLOUD != 0 {
            skipped.cloud += 1;
        } else {
            out.push((size, id));
        }
    }
    out
}

/// Agrupa por (tamaño, hash) los que se pudieron leer y deja los grupos de 2 o más.
fn regroup(items: &[(u32, u64)], hashes: Vec<Option<Hash>>) -> Vec<Group> {
    let mut map: HashMap<(u64, Hash), Vec<u32>> = HashMap::new();
    for (&(id, size), h) in items.iter().zip(hashes) {
        if let Some(h) = h {
            map.entry((size, h)).or_default().push(id);
        }
    }
    map.into_iter().filter(|(_, v)| v.len() >= 2).map(|((size, h), v)| (size, h, v)).collect()
}

struct Ctx<'a> {
    tree: &'a Tree,
    prog: &'a (dyn Fn(DupProgress) + Sync),
    cancel: &'a AtomicBool,
    start: Instant,
    pool: rayon::ThreadPool,
    read_bytes: AtomicU64,
    /// Archivos que no se pudieron abrir o leer (cada uno sale de su grupo una sola vez).
    errors: AtomicU64,
}

impl Ctx<'_> {
    /// Hash de cada archivo (`None` si no se pudo leer). En `prefix` lee los primeros 64 KiB;
    /// en `full`, el archivo entero.
    fn pass(&self, phase: DupPhase, items: &[(u32, u64)]) -> Result<Vec<Option<Hash>>, EngineMessage> {
        let want = |size: u64| if phase == DupPhase::Prefix { size.min(PREFIX) } else { size };
        let m = Meter {
            phase,
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            total_files: items.len() as u64,
            total_bytes: items.iter().map(|&(_, s)| want(s)).sum(),
            last: Mutex::new(Instant::now()),
            ctx: self,
        };
        m.emit();
        let out: Vec<Option<Hash>> = self.pool.install(|| {
            items
                .par_iter()
                .map(|&(id, size)| {
                    if self.cancel.load(Relaxed) {
                        return None;
                    }
                    let w = want(size);
                    let h = hash_file(&m, id, w, w == size);
                    m.files.fetch_add(1, Relaxed);
                    m.tick();
                    h
                })
                .collect()
        });
        self.read_bytes.fetch_add(m.bytes.load(Relaxed), Relaxed);
        if self.cancel.load(Relaxed) {
            return Err(msg::cancelled());
        }
        self.errors.fetch_add(out.iter().filter(|h| h.is_none()).count() as u64, Relaxed);
        Ok(out)
    }
}

/// Contadores de una pasada; publica el progreso el hilo que encuentre libre el turno.
struct Meter<'a> {
    phase: DupPhase,
    files: AtomicU64,
    bytes: AtomicU64,
    total_files: u64,
    total_bytes: u64,
    last: Mutex<Instant>,
    ctx: &'a Ctx<'a>,
}

impl Meter<'_> {
    fn snapshot(&self) -> DupProgress {
        DupProgress {
            phase: self.phase,
            files: self.files.load(Relaxed),
            total_files: self.total_files,
            bytes: self.bytes.load(Relaxed),
            total_bytes: self.total_bytes,
            elapsed_ms: self.ctx.start.elapsed().as_millis() as u64,
        }
    }

    /// Publica ya (inicio de la pasada).
    fn emit(&self) {
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        *last = Instant::now();
        (self.ctx.prog)(self.snapshot());
    }

    /// Publica si pasó `TICK` desde la última vez, sin esperar a otro hilo.
    fn tick(&self) {
        if let Ok(mut last) = self.last.try_lock() {
            if last.elapsed() >= TICK {
                *last = Instant::now();
                (self.ctx.prog)(self.snapshot());
            }
        }
    }
}

/// BLAKE3 de los primeros `want` bytes; `None` si no se pudo leer o se canceló. Con `whole`,
/// `want` es el tamaño del árbol y el archivo no puede haber cambiado de tamaño desde el escaneo.
fn hash_file(m: &Meter, id: u32, want: u64, whole: bool) -> Option<Hash> {
    let cancel = m.ctx.cancel;
    let mut f = open(m.ctx.tree, id).ok()?;
    let mut h = blake3::Hasher::new();
    BUF.with_borrow_mut(|buf| {
        if buf.len() < BUF_SIZE {
            buf.resize(BUF_SIZE, 0);
        }
        let mut left = want;
        while left > 0 {
            if cancel.load(Relaxed) {
                return None;
            }
            let n = left.min(BUF_SIZE as u64) as usize;
            let got = match f.read(&mut buf[..n]) {
                Ok(0) => return None, // se acortó
                Ok(k) => k,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return None,
            };
            h.update(&buf[..got]);
            left -= got as u64;
            m.bytes.fetch_add(got as u64, Relaxed);
            m.tick();
        }
        // Con el contenido completo, un byte más significa que creció
        if whole && !matches!(f.read(&mut buf[..1]), Ok(0)) {
            return None;
        }
        Some(*h.finalize().as_bytes())
    })
}

/// Antepone `\\?\` (o `\\?\UNC\`) para que la ruta llegue tal cual a Windows: rutas largas y
/// nombres con punto o espacio final.
#[cfg(windows)]
fn verbatim_wide(path: Vec<u16>) -> Vec<u16> {
    let w = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    if path.starts_with(&w(r"\\?\")) || path.starts_with(&w(r"\\.\")) {
        return path;
    }
    let (mut out, rest) = match path.strip_prefix(&w(r"\\")[..]) {
        Some(unc) => (w(r"\\?\UNC\"), unc),
        None => (w(r"\\?\"), &path[..]),
    };
    out.extend_from_slice(rest);
    out
}

/// Abre para lectura secuencial sin bloquear a otros procesos ni recuperar datos remotos.
#[cfg(windows)]
fn open(t: &Tree, id: u32) -> std::io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_NO_RECALL, FILE_FLAG_SEQUENTIAL_SCAN, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let path = std::ffi::OsString::from_wide(&verbatim_wide(t.path_wide(id)));
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_SEQUENTIAL_SCAN | FILE_FLAG_OPEN_NO_RECALL)
        .open(path)
}

#[cfg(not(windows))]
fn open(t: &Tree, id: u32) -> std::io::Result<std::fs::File> {
    std::fs::File::open(t.path(id))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn verbatim_paths() {
        let v = |s: &str| String::from_utf16(&verbatim_wide(s.encode_utf16().collect())).unwrap();
        assert_eq!(v(r"C:\a\b. "), r"\\?\C:\a\b. ");
        assert_eq!(v(r"\\srv\share\x"), r"\\?\UNC\srv\share\x");
        assert_eq!(v(r"\\?\C:\x"), r"\\?\C:\x");
    }
}
