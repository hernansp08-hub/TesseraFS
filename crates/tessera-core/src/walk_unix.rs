//! Motor de recorrido de Linux (y otros Unix). Da la misma salida que el de Windows (`walk.rs`): un
//! [`RawTree`] con las mismas reglas, así que árbol, búsqueda, slice, duplicados, historial, rescan y CLI
//! funcionan igual.
//!
//! - Cada carpeta se abre con `openat` relativo a la de su padre (`O_DIRECTORY | O_NOFOLLOW`), se lee con
//!   `getdents64` en un búfer por hilo y cada entrada se consulta con `fstatat` relativo a la carpeta
//!   (`AT_SYMLINK_NOFOLLOW`): nunca se abre un archivo ni se resuelven rutas completas. Las subcarpetas
//!   se reparten en un pool rayon con robo de trabajo. Para no agotar los descriptores (`RLIMIT_NOFILE`,
//!   a menudo 1024), sólo la mitad del límite puede quedar abierta esperando a sus hijas; por encima,
//!   las hijas se abren por su ruta completa.
//! - Llamadas con `libc` (ya estaba en el árbol de dependencias; `rustix` añadiría crates). Medido en WSL
//!   con la caché caliente y el mismo acumulador, es ~10 % más rápido que `std::fs::read_dir` +
//!   `DirEntry::metadata` (que abre cada carpeta por su ruta completa y reserva un búfer por carpeta):
//!   486 000 entradas en 0,10 s frente a 0,11–0,13 s con 16 hilos.
//! - Nunca se siguen enlaces simbólicos: un enlace es un archivo con el tamaño del propio enlace y
//!   `FLAG.REPARSE`.
//! - No se cruza a otros sistemas de archivos: una carpeta que es punto de montaje según
//!   `/proc/self/mountinfo` (salvo la raíz escaneada) queda como hoja con `FLAG.REPARSE`, igual que un
//!   volumen montado en una carpeta de Windows, y si no es un pseudo-sistema (proc, tmpfs…) se devuelve en
//!   [`WalkOutput::other_mounts`] (aviso `scan.otherMounts`). No se mira `st_dev`: las subvolúmenes de
//!   btrfs que no son puntos de montaje sí se recorren.
//! - size = `st_size`; alloc = `st_blocks * 512`; mtime en segundos Unix (u32, como en Windows). Flags:
//!   DIR, HIDDEN (nombre que empieza por `.`), REPARSE (enlaces y puntos de montaje), SPARSE (archivo
//!   regular con alloc + `st_blksize` < size) y HARDLINK: el mismo `(st_dev, st_ino)` con `st_nlink > 1`
//!   asigna espacio una sola vez (como la deduplicación por FileId de Windows: la segunda aparición y
//!   siguientes llevan alloc 0 y HARDLINK). COMPRESSED y CLOUD, nunca.
//! - Fifos, sockets y dispositivos son archivos con su `st_size` (normalmente 0).
//! - Permiso denegado → `denied`; otros errores → `errors` (con el texto del sistema). Si una carpeta se
//!   puede listar pero no consultar (permiso de lectura sin el de paso), sus entradas quedan con tamaño 0
//!   y la carpeta cuenta como denegada.
//! - Los nombres se guardan en UTF-8; los que no lo son, con pérdida (U+FFFD) para poder mostrarlos. Las
//!   acciones sobre esos elementos (abrir, papelera…) fallan con `action.failed`: limitación conocida.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStringExt;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

use libc::c_int;

use crate::build::RawTree;
use crate::msg;
use crate::posix::{self, Mount};
use crate::scan::Progress;
use crate::tree::NONE;
use crate::types::{flag, EngineMessage};

pub struct WalkOptions {
    pub threads: usize,
    /// Búfer por hilo para `getdents64`.
    pub buf_size: usize,
    /// Carpetas que pueden quedar abiertas esperando a sus hijas (0 = la mitad de `RLIMIT_NOFILE`).
    pub fd_budget: usize,
}

pub struct WalkOutput {
    pub raw: RawTree,
    /// Carpetas sin permiso de lectura y algunas de sus rutas.
    pub denied: u64,
    pub denied_samples: Vec<String>,
    /// Carpetas con otros errores de lectura y algunas rutas con el texto del error.
    pub errors: u64,
    pub error_samples: Vec<String>,
    pub hardlinks: u64,
    /// Puntos de montaje dentro de la raíz que no se recorrieron, sin los pseudo-sistemas, por ruta.
    pub other_mounts: Vec<String>,
}

/// Descriptor de archivo propio (se cierra al soltarlo).
pub(crate) struct Fd(c_int);

impl Drop for Fd {
    fn drop(&mut self) {
        unsafe { libc::close(self.0) };
    }
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO)
}

const DIR_FLAGS: c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;

#[cfg(target_os = "linux")]
const STAT_FLAGS: c_int = libc::AT_SYMLINK_NOFOLLOW | libc::AT_NO_AUTOMOUNT;
#[cfg(not(target_os = "linux"))]
const STAT_FLAGS: c_int = libc::AT_SYMLINK_NOFOLLOW;

/// Abre la carpeta raíz de un recorrido. Sigue los enlaces simbólicos (como en Windows la raíz sigue
/// las junctions); dentro del recorrido, nunca.
pub(crate) fn open_root(path: &str) -> std::io::Result<Fd> {
    let c = CString::new(path).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let fd = unsafe { libc::open(c.as_ptr(), DIR_FLAGS) };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(Fd(fd))
    }
}

/// Abre una subcarpeta sin seguir un enlace en el último componente: relativa a `dir`, o por su ruta
/// completa con `libc::AT_FDCWD`.
fn open_at(dir: c_int, name: &CStr) -> Result<Fd, i32> {
    let fd = unsafe { libc::openat(dir, name.as_ptr(), DIR_FLAGS | libc::O_NOFOLLOW) };
    if fd < 0 {
        Err(errno())
    } else {
        Ok(Fd(fd))
    }
}

/// Lee las entradas de la carpeta `fd` con `getdents64`: `f(nombre, d_type)` (incluye `.` y `..`).
#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_dir(fd: c_int, buf: &mut [u8], mut f: impl FnMut(&CStr, u8)) -> Result<(), i32> {
    // struct linux_dirent64 { u64 d_ino; i64 d_off; u16 d_reclen; u8 d_type; char d_name[]; }
    const NAME_AT: usize = 19;
    let len = buf.len().min(i32::MAX as usize) as libc::c_uint;
    loop {
        let n = unsafe { libc::syscall(libc::SYS_getdents64, fd, buf.as_mut_ptr(), len) };
        if n < 0 {
            match errno() {
                libc::EINTR => continue,
                e => return Err(e),
            }
        }
        if n == 0 {
            return Ok(());
        }
        let data = &buf[..n as usize];
        let mut o = 0usize;
        while o + NAME_AT < data.len() {
            let reclen = u16::from_ne_bytes([data[o + 16], data[o + 17]]) as usize;
            if reclen <= NAME_AT {
                break;
            }
            let end = (o + reclen).min(data.len());
            if let Ok(name) = CStr::from_bytes_until_nul(&data[o + NAME_AT..end]) {
                f(name, data[o + 18]);
            }
            o += reclen;
        }
    }
}

/// Otros Unix: `readdir` sobre una copia del descriptor (`fdopendir` se queda con él).
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn read_dir(fd: c_int, _buf: &mut [u8], mut f: impl FnMut(&CStr, u8)) -> Result<(), i32> {
    let d = unsafe { libc::dup(fd) };
    if d < 0 {
        return Err(errno());
    }
    let dir = unsafe { libc::fdopendir(d) };
    if dir.is_null() {
        let e = errno();
        unsafe { libc::close(d) };
        return Err(e);
    }
    loop {
        let e = unsafe { libc::readdir(dir) };
        if e.is_null() {
            break;
        }
        let (name, dtype) = unsafe { (CStr::from_ptr((*e).d_name.as_ptr()), (*e).d_type) };
        f(name, dtype);
    }
    unsafe { libc::closedir(dir) };
    Ok(())
}

fn mtime_of(st: &libc::stat) -> u32 {
    #[allow(clippy::unnecessary_cast)] // `time_t` cambia entre plataformas
    let t = st.st_mtime as i64;
    t.clamp(0, u32::MAX as i64) as u32
}

/// Una entrada leída, antes de pasar al acumulador del hilo.
#[derive(Clone, Copy, Default)]
struct Ent {
    /// Nombre en bytes exactos dentro de `Scratch::names`.
    name_off: u32,
    name_len: u32,
    size: u64,
    alloc: u64,
    mtime: u32,
    flags: u16,
    /// `(st_dev, st_ino)` de los archivos con varios nombres; 0 si no hay que deduplicar.
    key: u128,
    /// Carpeta que hay que recorrer (no los enlaces, ni lo que no se pudo consultar).
    descend: bool,
}

/// Entrada a partir de su `stat` (sin seguir enlaces).
#[allow(clippy::unnecessary_cast)] // los tipos de `stat` cambian entre plataformas
fn entry_of(st: &libc::stat, hidden: bool) -> Ent {
    let kind = st.st_mode as u32 & libc::S_IFMT as u32;
    let (dir, link, regular) = (kind == libc::S_IFDIR as u32, kind == libc::S_IFLNK as u32, kind == libc::S_IFREG as u32);
    let size = if dir { 0 } else { (st.st_size as i64).max(0) as u64 };
    let alloc = if dir { 0 } else { ((st.st_blocks as i64).max(0) as u64).saturating_mul(512) };
    let mut flags = 0;
    if dir {
        flags |= flag::DIR;
    }
    if hidden {
        flags |= flag::HIDDEN;
    }
    if link {
        flags |= flag::REPARSE;
    }
    if regular && alloc.saturating_add((st.st_blksize as i64).max(0) as u64) < size {
        flags |= flag::SPARSE;
    }
    let key = if !dir && st.st_nlink as u64 > 1 { (u128::from(st.st_dev as u64) << 64) | u128::from(st.st_ino as u64) } else { 0 };
    Ent { size, alloc, mtime: mtime_of(st), flags, key, descend: dir, ..Ent::default() }
}

#[derive(Default)]
struct Acc {
    id: Vec<u32>,
    parent: Vec<u32>,
    size: Vec<u64>,
    alloc: Vec<u64>,
    mtime: Vec<u32>,
    flags: Vec<u16>,
    name_off: Vec<u32>,
    name_len: Vec<u16>,
    names: Vec<u8>,
    /// `(st_dev, st_ino)` → id de los archivos con varios nombres.
    links: Vec<(u128, u32)>,
}

/// Búferes por hilo: el de `getdents64` y las entradas de la carpeta en curso.
#[derive(Default)]
struct Scratch {
    buf: Vec<u8>,
    ents: Vec<Ent>,
    names: Vec<u8>,
}

thread_local! {
    static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch::default());
}

const MAX_SAMPLES: usize = 20;

struct Ctx<'a> {
    next_id: AtomicU32,
    accs: Vec<Mutex<Acc>>,
    buf_size: usize,
    denied: AtomicU64,
    errors: AtomicU64,
    denied_samples: Mutex<Vec<String>>,
    error_samples: Mutex<Vec<String>>,
    /// Puntos de montaje dentro de la raíz, con las rutas del recorrido → ¿pseudo-sistema?
    mounts: HashMap<Vec<u8>, bool>,
    /// Los que se encontraron (y no se cruzaron): (ruta, pseudo).
    found_mounts: Mutex<Vec<(Vec<u8>, bool)>>,
    /// Carpetas abiertas esperando a sus hijas y el máximo.
    kept: AtomicUsize,
    budget: usize,
    prog: &'a Progress,
    cancel: &'a AtomicBool,
}

impl Ctx<'_> {
    fn error(&self, path: &[u8], e: i32) {
        let p = String::from_utf8_lossy(path);
        if e == libc::EACCES || e == libc::EPERM {
            self.denied.fetch_add(1, Relaxed);
            let mut s = self.denied_samples.lock().unwrap();
            if s.len() < MAX_SAMPLES {
                s.push(p.into_owned());
            }
        } else {
            self.errors.fetch_add(1, Relaxed);
            let mut s = self.error_samples.lock().unwrap();
            if s.len() < MAX_SAMPLES {
                s.push(format!("{p}: {}", crate::sys::error_text(e)));
            }
        }
    }
}

/// Carpeta abierta que sus hijas usan para `openat`; cuenta para el límite de descriptores.
struct Kept<'a> {
    fd: Fd,
    open: &'a AtomicUsize,
}

impl Drop for Kept<'_> {
    fn drop(&mut self) {
        self.open.fetch_sub(1, Relaxed);
    }
}

/// Una subcarpeta pendiente.
struct Task<'a> {
    id: u32,
    /// Ruta completa con NUL final.
    path: Box<[u8]>,
    /// Dónde empieza el nombre dentro de `path` (para `openat` relativo al padre).
    name_at: usize,
    /// El padre abierto, si se quedó esperando (si no, se abre por la ruta completa).
    parent: Option<Arc<Kept<'a>>>,
}

fn dir_task<'s>(ctx: &'s Ctx<'s>, scope: &rayon::Scope<'s>, task: Task<'s>) {
    let Task { id, path, name_at, parent } = task;
    let shown = &path[..path.len() - 1];
    if ctx.cancel.load(Relaxed) {
        return;
    }
    let opened = match (CStr::from_bytes_with_nul(&path), CStr::from_bytes_with_nul(&path[name_at..])) {
        (Ok(full), Ok(name)) => match &parent {
            Some(p) => open_at(p.fd.0, name),
            None => open_at(libc::AT_FDCWD, full),
        },
        _ => Err(libc::EINVAL),
    };
    drop(parent);
    match opened {
        Ok(fd) => enumerate(ctx, scope, fd, id, shown),
        Err(e) => ctx.error(shown, e),
    }
}

fn enumerate<'s>(ctx: &'s Ctx<'s>, scope: &rayon::Scope<'s>, fd: Fd, id: u32, path: &[u8]) {
    if ctx.prog.want_detail.load(Relaxed) && ctx.prog.want_detail.swap(false, Relaxed) {
        *ctx.prog.detail.lock().unwrap() = Some(String::from_utf8_lossy(path).into_owned());
    }
    let mut subdirs: Vec<(u32, Box<[u8]>, usize)> = Vec::new();
    let (mut n_entries, mut n_bytes) = (0u64, 0u64);
    SCRATCH.with(|cell| {
        let mut sc = cell.borrow_mut();
        let Scratch { buf, ents, names } = &mut *sc;
        ents.clear();
        names.clear();
        if buf.len() < ctx.buf_size {
            buf.resize(ctx.buf_size, 0);
        }
        let mut stat_err = None;
        let listed = read_dir(fd.0, buf, |name, dtype| {
            let nb = name.to_bytes();
            if nb == b"." || nb == b".." {
                return;
            }
            let hidden = nb[0] == b'.';
            let mut st = MaybeUninit::<libc::stat>::uninit();
            let e = if unsafe { libc::fstatat(fd.0, name.as_ptr(), st.as_mut_ptr(), STAT_FLAGS) } == 0 {
                entry_of(unsafe { st.assume_init_ref() }, hidden)
            } else {
                let e = errno();
                if e == libc::ENOENT {
                    return; // se borró entre el listado y la consulta
                }
                stat_err.get_or_insert(e);
                let mut flags = if dtype == libc::DT_DIR { flag::DIR } else { 0 };
                if hidden {
                    flags |= flag::HIDDEN;
                }
                Ent { flags, ..Ent::default() }
            };
            ents.push(Ent { name_off: names.len() as u32, name_len: nb.len() as u32, ..e });
            names.extend_from_slice(nb);
        });
        // Un solo aviso por carpeta: no se pudo listar (entera o en parte) o consultar alguna entrada
        if let Some(e) = listed.err().or(stat_err) {
            ctx.error(path, e);
        }
        if ents.is_empty() {
            return;
        }
        let base = ctx.next_id.fetch_add(ents.len() as u32, Relaxed);
        // Subcarpetas: ruta completa; los puntos de montaje quedan como hojas
        for (k, e) in ents.iter_mut().enumerate() {
            if !e.descend {
                continue;
            }
            let raw = &names[e.name_off as usize..][..e.name_len as usize];
            let mut p = Vec::with_capacity(path.len() + raw.len() + 2);
            p.extend_from_slice(path);
            if path.last() != Some(&b'/') {
                p.push(b'/');
            }
            let name_at = p.len();
            p.extend_from_slice(raw);
            if let Some(&pseudo) = ctx.mounts.get(&p) {
                e.flags |= flag::REPARSE;
                ctx.found_mounts.lock().unwrap().push((p, pseudo));
                continue;
            }
            p.push(0);
            subdirs.push((base + k as u32, p.into_boxed_slice(), name_at));
        }
        let tidx = rayon::current_thread_index().unwrap_or(0) % ctx.accs.len();
        let mut acc = ctx.accs[tidx].lock().unwrap();
        for (k, e) in ents.iter().enumerate() {
            let eid = base + k as u32;
            let raw = &names[e.name_off as usize..][..e.name_len as usize];
            let off = acc.names.len() as u32;
            match std::str::from_utf8(raw) {
                Ok(_) => acc.names.extend_from_slice(raw),
                Err(_) => acc.names.extend_from_slice(String::from_utf8_lossy(raw).as_bytes()),
            }
            let blen = acc.names.len() as u32 - off;
            acc.id.push(eid);
            acc.parent.push(id);
            acc.size.push(e.size);
            acc.alloc.push(e.alloc);
            acc.mtime.push(e.mtime);
            acc.flags.push(e.flags);
            acc.name_off.push(off);
            acc.name_len.push(blen.min(u16::MAX as u32) as u16);
            if e.key != 0 {
                acc.links.push((e.key, eid));
            }
            if e.flags & flag::DIR == 0 {
                n_bytes += e.size;
            }
        }
        n_entries = ents.len() as u64;
    });
    ctx.prog.entries.fetch_add(n_entries, Relaxed);
    ctx.prog.bytes.fetch_add(n_bytes, Relaxed);
    if subdirs.is_empty() {
        return;
    }
    // Las hijas abren relativo a esta carpeta mientras quede presupuesto de descriptores
    let parent = if ctx.kept.fetch_add(1, Relaxed) < ctx.budget {
        Some(Arc::new(Kept { fd, open: &ctx.kept }))
    } else {
        ctx.kept.fetch_sub(1, Relaxed);
        drop(fd);
        None
    };
    for (cid, p, name_at) in subdirs {
        let task = Task { id: cid, path: p, name_at, parent: parent.clone() };
        scope.spawn(move |s| dir_task(ctx, s, task));
    }
}

/// Pool de hilos del recorrido.
pub(crate) fn pool(threads: usize) -> Result<rayon::ThreadPool, EngineMessage> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads.max(1))
        .thread_name(|i| format!("tessera-walk-{i}"))
        .build()
        .map_err(|e| msg::internal(&e.to_string()))
}

/// La mitad del límite de descriptores del proceso (entre 16 y 4096).
fn fd_budget() -> usize {
    let mut rl = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    let soft = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) } == 0 { rl.rlim_cur } else { 1024 };
    (soft.min(1 << 20) as usize / 2).clamp(16, 4096)
}

/// Recorre `root` (ruta absoluta) y devuelve las entradas en bruto (id 0 = raíz).
pub fn walk(root: &str, opts: &WalkOptions, prog: &Progress, cancel: &AtomicBool) -> Result<WalkOutput, EngineMessage> {
    let rh = open_root(root).map_err(|e| msg::cannot_open(root, &crate::sys::io_error_text(&e)))?;
    walk_in(&pool(opts.threads)?, rh, root, opts, prog, cancel)
}

/// Recorre la carpeta ya abierta `rh` (`root` es su ruta: la del árbol, el progreso y los avisos) en `pool`.
pub(crate) fn walk_in(
    pool: &rayon::ThreadPool,
    rh: Fd,
    root: &str,
    opts: &WalkOptions,
    prog: &Progress,
    cancel: &AtomicBool,
) -> Result<WalkOutput, EngineMessage> {
    walk_with(pool, rh, root, &crate::sys::mounts(), opts, prog, cancel)
}

/// `path` sin la barra final de `/` (para pegarle `/nombre`).
fn base_of(path: &[u8]) -> &[u8] {
    path.strip_suffix(b"/").unwrap_or(path)
}

/// Como [`walk_in`] con la tabla de montajes dada (las pruebas usan una sintética).
fn walk_with(
    pool: &rayon::ThreadPool,
    rh: Fd,
    root: &str,
    mounts: &[Mount],
    opts: &WalkOptions,
    prog: &Progress,
    cancel: &AtomicBool,
) -> Result<WalkOutput, EngineMessage> {
    let mut st = MaybeUninit::<libc::stat>::uninit();
    let root_mtime = if unsafe { libc::fstat(rh.0, st.as_mut_ptr()) } == 0 { mtime_of(unsafe { st.assume_init_ref() }) } else { 0 };
    // Los puntos de montaje están en rutas reales; la raíz puede pasar por enlaces simbólicos
    // (/var/run → /run): se traducen a las rutas del recorrido
    let real = std::fs::canonicalize(root).map(|p| p.into_os_string().into_vec()).unwrap_or_else(|_| root.as_bytes().to_vec());
    let (real_base, shown_base) = (base_of(&real), base_of(root.as_bytes()));
    let mount_map: HashMap<Vec<u8>, bool> = posix::mounts_under(mounts, &real)
        .into_iter()
        .map(|m| ([shown_base, &m.point[real_base.len()..]].concat(), posix::is_pseudo(m)))
        .collect();
    let threads = pool.current_num_threads().max(1);
    let ctx = Ctx {
        next_id: AtomicU32::new(1),
        accs: (0..threads).map(|_| Mutex::new(Acc::default())).collect(),
        buf_size: opts.buf_size.max(32 * 1024),
        denied: AtomicU64::new(0),
        errors: AtomicU64::new(0),
        denied_samples: Mutex::new(Vec::new()),
        error_samples: Mutex::new(Vec::new()),
        mounts: mount_map,
        found_mounts: Mutex::new(Vec::new()),
        kept: AtomicUsize::new(0),
        budget: if opts.fd_budget > 0 { opts.fd_budget } else { fd_budget() },
        prog,
        cancel,
    };
    {
        let ctx = &ctx;
        pool.install(|| rayon::scope(|s| enumerate(ctx, s, rh, 0, root.as_bytes())));
    }
    if cancel.load(Relaxed) {
        return Err(msg::cancelled());
    }

    // Unir los acumuladores por hilo en un RawTree indexado por id
    let n = ctx.next_id.load(Relaxed) as usize;
    let accs: Vec<Acc> = ctx.accs.into_iter().map(|m| m.into_inner().unwrap()).collect();
    let names_total: usize = accs.iter().map(|a| a.names.len()).sum();
    if names_total > u32::MAX as usize {
        return Err(msg::internal("Too many names for the name store"));
    }
    let mut raw = RawTree {
        parent: vec![NONE; n],
        size: vec![0; n],
        alloc: vec![0; n],
        mtime: vec![0; n],
        flags: vec![0; n],
        name_off: vec![0; n],
        name_len: vec![0; n],
        names: Vec::with_capacity(names_total),
        root: 0,
        frn: Vec::new(),
    };
    raw.flags[0] = flag::DIR;
    raw.mtime[0] = root_mtime;
    let mut links: Vec<(u128, u32)> = Vec::new();
    for a in &accs {
        let base = raw.names.len() as u32;
        raw.names.extend_from_slice(&a.names);
        for j in 0..a.id.len() {
            let i = a.id[j] as usize;
            raw.parent[i] = a.parent[j];
            raw.size[i] = a.size[j];
            raw.alloc[i] = a.alloc[j];
            raw.mtime[i] = a.mtime[j];
            raw.flags[i] = a.flags[j];
            raw.name_off[i] = base + a.name_off[j];
            raw.name_len[i] = a.name_len[j];
        }
        links.extend_from_slice(&a.links);
    }
    drop(accs);
    // Enlaces duros: el mismo (st_dev, st_ino) bajo varios nombres asigna espacio una sola vez
    let mut hardlinks = 0u64;
    if !links.is_empty() {
        use rayon::slice::ParallelSliceMut;
        links.par_sort_unstable();
        for w in 1..links.len() {
            if links[w].0 == links[w - 1].0 {
                let i = links[w].1 as usize;
                raw.alloc[i] = 0;
                raw.flags[i] |= flag::HARDLINK;
                hardlinks += 1;
            }
        }
    }
    let mut other: Vec<Vec<u8>> = std::mem::take(&mut *ctx.found_mounts.lock().unwrap()).into_iter().filter(|(_, pseudo)| !pseudo).map(|(p, _)| p).collect();
    other.sort_unstable();
    other.dedup();
    let denied_samples = std::mem::take(&mut *ctx.denied_samples.lock().unwrap());
    let error_samples = std::mem::take(&mut *ctx.error_samples.lock().unwrap());
    Ok(WalkOutput {
        raw,
        denied: ctx.denied.load(Relaxed),
        denied_samples,
        errors: ctx.errors.load(Relaxed),
        error_samples,
        hardlinks,
        other_mounts: other.into_iter().map(|p| String::from_utf8_lossy(&p).into_owned()).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::Tree;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

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
        fn s(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            // Devuelve los permisos que las pruebas quitan antes de borrar
            fn open_up(p: &Path) {
                if let Ok(rd) = std::fs::read_dir(p) {
                    for e in rd.flatten() {
                        if e.file_type().is_ok_and(|t| t.is_dir()) {
                            let _ = std::fs::set_permissions(e.path(), std::fs::Permissions::from_mode(0o755));
                            open_up(&e.path());
                        }
                    }
                }
            }
            open_up(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn opts() -> WalkOptions {
        WalkOptions { threads: 4, buf_size: 64 * 1024, fd_budget: 0 }
    }

    fn walk_tree(root: &str, mounts: &[Mount], o: &WalkOptions) -> (WalkOutput, Tree) {
        let (prog, cancel) = (Progress::new(), AtomicBool::new(false));
        let mut out = walk_with(&pool(o.threads).unwrap(), open_root(root).unwrap(), root, mounts, o, &prog, &cancel).unwrap();
        let t = crate::build::build(std::mem::take(&mut out.raw), root.to_string(), &[]).unwrap();
        (out, t)
    }

    fn find(t: &Tree, path: &Path) -> u32 {
        let want = path.to_string_lossy();
        (0..t.len() as u32).find(|&i| t.path(i) == want).unwrap_or_else(|| panic!("no está {want}"))
    }

    fn has(t: &Tree, path: &Path) -> bool {
        let want = path.to_string_lossy();
        (0..t.len() as u32).any(|i| t.path(i) == want)
    }

    #[test]
    fn links_hidden_sparse_special_and_names() {
        let d = TempDir::new("unix-walk");
        let a = d.file("a.bin", 10_000);
        d.file("sub/b.txt", 100);
        d.file("sub/deep/c.DAT", 5_000);
        d.file(".oculto", 5);
        d.file(".carpeta/x", 1);
        std::fs::hard_link(&a, d.0.join("sub/a-enlace.bin")).unwrap();
        std::os::unix::fs::symlink("sub", d.0.join("enlace-carpeta")).unwrap();
        std::os::unix::fs::symlink("/no/existe/nunca", d.0.join("roto")).unwrap();
        // Disperso: 64 MiB sin datos (truncate -s)
        std::fs::File::create(d.0.join("disperso.img")).unwrap().set_len(64 << 20).unwrap();
        let fifo = CString::new(d.0.join("tubo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
        // Nombre que no es UTF-8
        let bad = d.0.join(std::ffi::OsStr::from_bytes(b"mal\xffnombre.txt"));
        std::fs::write(&bad, b"xyz").unwrap();

        let (out, t) = walk_tree(&d.s(), &[], &opts());
        assert_eq!((out.denied, out.errors, out.hardlinks), (0, 0, 1));
        assert!(out.other_mounts.is_empty());
        // Enlaces simbólicos: archivos con el tamaño del enlace, REPARSE y sin seguir
        let l = find(&t, &d.0.join("enlace-carpeta"));
        assert_eq!((t.is_dir(l), t.size(l), t.flags(l) & flag::REPARSE, t.child_count(l)), (false, 3, flag::REPARSE, 0));
        let r = find(&t, &d.0.join("roto"));
        assert_eq!((t.size(r), t.flags(r) & flag::REPARSE), (16, flag::REPARSE));
        assert!(!has(&t, &d.0.join("enlace-carpeta/b.txt")));
        // Enlace duro: un nombre lleva el asignado y el otro HARDLINK con 0
        let (x, y) = (find(&t, &a), find(&t, &d.0.join("sub/a-enlace.bin")));
        let (with, without) = if t.flags(x) & flag::HARDLINK != 0 { (y, x) } else { (x, y) };
        assert!(t.alloc(with) >= 10_000);
        assert_eq!((t.alloc(without), t.flags(without) & flag::HARDLINK, t.size(without)), (0, flag::HARDLINK, 10_000));
        // Ocultos
        assert_eq!(t.flags(find(&t, &d.0.join(".oculto"))) & flag::HIDDEN, flag::HIDDEN);
        let c = find(&t, &d.0.join(".carpeta"));
        assert_eq!(t.flags(c) & (flag::HIDDEN | flag::DIR), flag::HIDDEN | flag::DIR);
        assert_eq!(t.flags(find(&t, &a)) & flag::HIDDEN, 0);
        // Disperso
        let s = find(&t, &d.0.join("disperso.img"));
        assert_eq!((t.size(s), t.flags(s) & flag::SPARSE), (64 << 20, flag::SPARSE));
        assert!(t.alloc(s) < 1 << 20);
        assert_eq!(t.flags(find(&t, &a)) & flag::SPARSE, 0);
        // Fifo: un archivo de tamaño 0
        let f = find(&t, &d.0.join("tubo"));
        assert_eq!((t.is_dir(f), t.size(f)), (false, 0));
        // Nombre no UTF-8: con pérdida
        let m = find(&t, &d.0.join("mal\u{FFFD}nombre.txt"));
        assert_eq!(t.size(m), 3);
        // Carpetas, totales y nada de COMPRESSED ni CLOUD
        let deep = find(&t, &d.0.join("sub/deep"));
        assert_eq!((t.files(deep), t.size(deep)), (1, 5_000));
        assert_eq!(t.dirs(0), 3, "sub, deep y .carpeta");
        assert_eq!(t.files(0), 11);
        assert_eq!(t.size(0), 10_000 * 2 + 100 + 5_000 + 5 + 1 + 3 + 16 + (64 << 20) + 3);
        assert!((0..t.len() as u32).all(|i| t.flags(i) & (flag::COMPRESSED | flag::CLOUD) == 0));
        let mt = t.mtime(find(&t, &a)) as u64;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        assert!(mt <= now && now - mt < 3600, "mtime en segundos Unix");
        assert!(t.mtime(0) > 0);
        // Con un presupuesto de 1 descriptor (las hijas se abren por la ruta completa) sale lo mismo
        let (out2, t2) = walk_tree(&d.s(), &[], &WalkOptions { fd_budget: 1, threads: 3, ..opts() });
        assert_eq!((out2.hardlinks, t2.len(), t2.size(0), t2.alloc(0), t2.files(0), t2.dirs(0)), (1, t.len(), t.size(0), t.alloc(0), 11, 3));
    }

    #[test]
    fn permission_denied_is_reported() {
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("permission_denied_is_reported: como root no falla el permiso; se omite");
            return;
        }
        let d = TempDir::new("unix-denied");
        d.file("cerrada/secreto.bin", 1000);
        d.file("sinpaso/a.bin", 500);
        d.file("abierta/b.bin", 10);
        std::fs::set_permissions(d.0.join("cerrada"), std::fs::Permissions::from_mode(0o000)).unwrap();
        // Se puede listar pero no consultar ni entrar
        std::fs::set_permissions(d.0.join("sinpaso"), std::fs::Permissions::from_mode(0o444)).unwrap();
        let (out, t) = walk_tree(&d.s(), &[], &opts());
        assert_eq!((out.denied, out.errors), (2, 0));
        let mut samples = out.denied_samples.clone();
        samples.sort();
        assert_eq!(samples, [d.0.join("cerrada").to_string_lossy(), d.0.join("sinpaso").to_string_lossy()]);
        let c = find(&t, &d.0.join("cerrada"));
        assert_eq!((t.is_dir(c), t.child_count(c), t.size(c)), (true, 0, 0));
        let s = find(&t, &d.0.join("sinpaso"));
        assert_eq!((t.child_count(s), t.size(s)), (1, 0), "el nombre sí, el tamaño no");
        assert_eq!(t.size(0), 10);
    }

    #[test]
    fn mount_points_are_not_crossed() {
        let d = TempDir::new("unix-mounts");
        d.file("disco/dentro.bin", 1000);
        d.file("ram/x.bin", 50);
        d.file("normal/y.bin", 7);
        d.file("normal/usb/z.bin", 3);
        let real = std::fs::canonicalize(&d.0).unwrap();
        let m = |rel: &str, fs: &str| Mount { dev: (0, 99), root: b"/".to_vec(), point: real.join(rel).as_os_str().as_bytes().to_vec(), fs: fs.into(), source: "/dev/x".into() };
        // ext4 en disco/, tmpfs en ram/, otro en normal/usb y la propia raíz (no cuenta)
        let mounts = [Mount { point: real.as_os_str().as_bytes().to_vec(), ..m("", "ext4") }, m("disco", "ext4"), m("ram", "tmpfs"), m("normal/usb", "vfat")];
        let (out, t) = walk_tree(&d.s(), &mounts, &opts());
        assert_eq!(out.other_mounts, [d.0.join("disco").to_string_lossy(), d.0.join("normal/usb").to_string_lossy()], "sin el tmpfs");
        for rel in ["disco", "ram", "normal/usb"] {
            let i = find(&t, &d.0.join(rel));
            assert_eq!((t.flags(i) & (flag::DIR | flag::REPARSE), t.child_count(i)), (flag::DIR | flag::REPARSE, 0), "{rel}");
        }
        assert!(!has(&t, &d.0.join("disco/dentro.bin")) && !has(&t, &d.0.join("ram/x.bin")) && !has(&t, &d.0.join("normal/usb/z.bin")));
        assert_eq!(t.size(0), 7);
        assert_eq!(t.flags(find(&t, &d.0.join("normal"))) & flag::REPARSE, 0);
        // Por un enlace simbólico a la raíz: los montajes se traducen a las rutas del recorrido
        let link = TempDir::new("unix-mounts-link");
        let via = link.0.join("arbol");
        std::os::unix::fs::symlink(&d.0, &via).unwrap();
        let (out, t) = walk_tree(&via.to_string_lossy(), &mounts, &opts());
        assert_eq!(out.other_mounts, [via.join("disco").to_string_lossy(), via.join("normal/usb").to_string_lossy()]);
        assert_eq!(t.size(0), 7);
        // Escanear el propio punto de montaje sí lo recorre
        let (out, t) = walk_tree(&d.0.join("disco").to_string_lossy(), &mounts, &opts());
        assert!(out.other_mounts.is_empty());
        assert_eq!(t.size(0), 1000);
    }

    #[test]
    fn cancel_and_errors() {
        let d = TempDir::new("unix-cancel");
        d.file("a/b.bin", 10);
        let (prog, cancel) = (Progress::new(), AtomicBool::new(true));
        let r = walk_with(&pool(2).unwrap(), open_root(&d.s()).unwrap(), &d.s(), &[], &opts(), &prog, &cancel);
        assert_eq!(r.err().unwrap().code, "error.cancelled");
        let e = walk(&d.0.join("no-existe").to_string_lossy(), &opts(), &prog, &AtomicBool::new(false)).err().unwrap();
        assert_eq!(e.code, "error.cannotOpen");
        assert_eq!(e.get("error"), Some(&crate::types::Param::Str("No such file or directory".into())));
        assert!(open_root(&d.0.join("a/b.bin").to_string_lossy()).is_err(), "un archivo no es una carpeta");
    }
}
