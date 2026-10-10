//! Motor de recorrido (sin administrador, cualquier sistema de archivos).
//!
//! Cada carpeta se abre con `NtCreateFile` relativo al handle de su padre y se lee con
//! `NtQueryDirectoryFile` (`FileIdExtdDirectoryInformation`, con caída a las clases 38 y 2)
//! en un búfer grande por hilo. Las subcarpetas se reparten en un pool rayon con robo de
//! trabajo. Nunca se abre el contenido de un archivo (no se hidratan marcadores de la nube),
//! no se siguen junctions ni symlinks y un acceso denegado sólo deja la carpeta vacía.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{NtCreateFile, NtQueryDirectoryFile, NtQueryInformationFile};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, UNICODE_STRING};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileTime, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

use crate::build::RawTree;
use crate::msg;
use crate::names;
use crate::scan::Progress;
use crate::tree::NONE;
use crate::attrs::*;
use crate::types::{flag, EngineMessage};

const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_OPEN: u32 = 1;
const FILE_DIRECTORY_FILE: u32 = 0x1;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x4000;
const FILE_OPEN_REPARSE_POINT: u32 = 0x20_0000;
const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
const FILE_READ_ATTRIBUTES: u32 = 0x80;

const STATUS_NO_MORE_FILES: i32 = 0x8000_0006_u32 as i32;
const STATUS_NO_SUCH_FILE: i32 = 0xC000_000F_u32 as i32;
const STATUS_INVALID_INFO_CLASS: i32 = 0xC000_0003_u32 as i32;
const STATUS_INVALID_PARAMETER: i32 = 0xC000_000D_u32 as i32;
const STATUS_NOT_SUPPORTED: i32 = 0xC000_00BB_u32 as i32;
const STATUS_INVALID_DEVICE_REQUEST: i32 = 0xC000_0010_u32 as i32;
const STATUS_ACCESS_DENIED: i32 = 0xC000_0022_u32 as i32;

const CLASS_ID_EXTD: i32 = 60; // FileIdExtdDirectoryInformation
const CLASS_ID_FULL: i32 = 38; // FileIdFullDirectoryInformation
const CLASS_FULL: i32 = 2; // FileFullDirectoryInformation

pub(crate) struct Handle(pub HANDLE);
// Un HANDLE de archivo se puede usar desde cualquier hilo.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub(crate) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
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
    fid: Vec<u128>,
    /// Asignado real de archivos que el listado da como 0 (comprimidos con WOF).
    fix: Vec<(u32, u64)>,
}

pub struct WalkOptions {
    pub threads: usize,
    pub buf_size: usize,
    /// Detectar enlaces duros por FileId (sólo NTFS/ReFS).
    pub dedupe_links: bool,
}

pub struct WalkOutput {
    pub raw: RawTree,
    /// Carpetas sin permiso de lectura y algunas de sus rutas.
    pub denied: u64,
    pub denied_samples: Vec<String>,
    /// Carpetas con otros errores de lectura y algunas rutas con su NTSTATUS.
    pub errors: u64,
    pub error_samples: Vec<String>,
    pub hardlinks: u64,
}

struct Ctx<'a> {
    next_id: AtomicU32,
    accs: Vec<Mutex<Acc>>,
    class: AtomicI32,
    buf_size: usize,
    denied: AtomicU64,
    errors: AtomicU64,
    denied_samples: Mutex<Vec<String>>,
    error_samples: Mutex<Vec<String>>,
    prog: &'a Progress,
    cancel: &'a AtomicBool,
    with_ids: bool,
}

thread_local! {
    static BUF: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

const MAX_SAMPLES: usize = 20;

impl Ctx<'_> {
    fn error(&self, path: &str, status: i32) {
        if status == STATUS_ACCESS_DENIED {
            self.denied.fetch_add(1, Relaxed);
            let mut s = self.denied_samples.lock().unwrap();
            if s.len() < MAX_SAMPLES {
                s.push(path.to_string());
            }
        } else {
            self.errors.fetch_add(1, Relaxed);
            let mut s = self.error_samples.lock().unwrap();
            if s.len() < MAX_SAMPLES {
                s.push(format!("{path}: NTSTATUS 0x{:08X}", status as u32));
            }
        }
    }
}

fn open_rel(parent: &Handle, name: &[u16]) -> Result<Handle, i32> {
    open_rel_with(
        parent,
        name,
        FILE_LIST_DIRECTORY | SYNCHRONIZE,
        FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
    )
}

/// Asignado según el sistema (el filtro WOF lo informa aquí y no en el listado).
/// Sólo pide atributos: no lee datos ni hidrata nada.
fn real_alloc(dir: &Handle, name: &[u16]) -> Option<u64> {
    let h = open_rel_with(dir, name, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT).ok()?;
    let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let mut info = [0i64; 3]; // FILE_STANDARD_INFORMATION: AllocationSize, EndOfFile, …
    let st = unsafe { NtQueryInformationFile(h.0, &mut iosb, info.as_mut_ptr() as *mut _, 24, 5) };
    (st >= 0 && info[0] > 0).then_some(info[0] as u64)
}

fn open_rel_with(parent: &Handle, name: &[u16], access: u32, options: u32) -> Result<Handle, i32> {
    let us = UNICODE_STRING {
        Length: (name.len() * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_ptr() as *mut u16,
    };
    let oa = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.0,
        ObjectName: &us,
        Attributes: 0,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut h: HANDLE = std::ptr::null_mut();
    let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let st = unsafe {
        NtCreateFile(
            &mut h,
            access,
            &oa,
            &mut iosb,
            std::ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            options,
            std::ptr::null(),
            0,
        )
    };
    if st < 0 {
        Err(st)
    } else {
        Ok(Handle(h))
    }
}

/// Ruta con prefijo `\\?\` para abrir rutas largas.
pub(crate) fn verbatim(path: &str) -> String {
    if path.starts_with(r"\\?\") || path.starts_with(r"\\.\") {
        path.to_string()
    } else if let Some(unc) = path.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{unc}")
    } else {
        format!(r"\\?\{path}")
    }
}

fn open_root(path: &str) -> Result<Handle, EngineMessage> {
    let w = wide(&verbatim(path));
    let h = unsafe {
        CreateFileW(
            w.as_ptr(),
            FILE_LIST_DIRECTORY | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return Err(msg::cannot_open(path, &crate::sys::last_error_text()));
    }
    Ok(Handle(h))
}

#[inline]
fn rd32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
#[inline]
fn rd64(b: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

fn dir_task<'s>(ctx: &'s Ctx<'s>, scope: &rayon::Scope<'s>, parent: Arc<Handle>, name: Box<[u16]>, id: u32, path: Arc<str>) {
    if ctx.cancel.load(Relaxed) {
        return;
    }
    let h = match open_rel(&parent, &name) {
        Ok(h) => h,
        Err(st) => {
            ctx.error(&path, st);
            return;
        }
    };
    drop(parent);
    enumerate(ctx, scope, Arc::new(h), id, path);
}

fn enumerate<'s>(ctx: &'s Ctx<'s>, scope: &rayon::Scope<'s>, h: Arc<Handle>, id: u32, path: Arc<str>) {
    if ctx.prog.want_detail.load(Relaxed) && ctx.prog.want_detail.swap(false, Relaxed) {
        *ctx.prog.detail.lock().unwrap() = Some(path.to_string());
    }
    let mut subdirs: Vec<(u32, Box<[u16]>)> = Vec::new();
    let mut wof: Vec<(u32, Box<[u16]>)> = Vec::new();
    let (mut n_entries, mut n_bytes) = (0u64, 0u64);
    BUF.with(|cell| {
        let mut buf = cell.borrow_mut();
        if buf.len() * 8 < ctx.buf_size {
            buf.resize(ctx.buf_size / 8, 0);
        }
        let bytes: &mut [u8] = unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, buf.len() * 8) };
        let mut first = true;
        loop {
            let class = ctx.class.load(Relaxed);
            let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
            let st = unsafe {
                NtQueryDirectoryFile(
                    h.0,
                    std::ptr::null_mut(),
                    None,
                    std::ptr::null(),
                    &mut iosb,
                    bytes.as_mut_ptr() as *mut _,
                    bytes.len() as u32,
                    class,
                    false,
                    std::ptr::null(),
                    false,
                )
            };
            if st == STATUS_NO_MORE_FILES || st == STATUS_NO_SUCH_FILE {
                break;
            }
            if st < 0 {
                if first
                    && matches!(st, STATUS_INVALID_INFO_CLASS | STATUS_INVALID_PARAMETER | STATUS_NOT_SUPPORTED | STATUS_INVALID_DEVICE_REQUEST)
                    && class != CLASS_FULL
                {
                    let lower = if class == CLASS_ID_EXTD { CLASS_ID_FULL } else { CLASS_FULL };
                    let _ = ctx.class.compare_exchange(class, lower, Relaxed, Relaxed);
                    continue;
                }
                ctx.error(&path, st);
                break;
            }
            first = false;
            let len = iosb.Information.min(bytes.len());
            if len == 0 {
                break;
            }
            let data = &bytes[..len];
            let (name_at, id_at) = match class {
                CLASS_ID_EXTD => (88usize, Some(72usize)),
                CLASS_ID_FULL => (80, Some(72)),
                _ => (68, None),
            };
            // Contar entradas (sin "." ni "..") para reservar ids de una vez
            let is_dot = |o: usize| -> bool {
                let nl = rd32(data, o + 60) as usize;
                let n0 = o + name_at;
                (nl == 2 && data[n0] == b'.' && data[n0 + 1] == 0)
                    || (nl == 4 && data[n0] == b'.' && data[n0 + 1] == 0 && data[n0 + 2] == b'.' && data[n0 + 3] == 0)
            };
            let mut count = 0u32;
            let mut o = 0usize;
            loop {
                if !is_dot(o) {
                    count += 1;
                }
                let next = rd32(data, o) as usize;
                if next == 0 || o + next >= len {
                    break;
                }
                o += next;
            }
            if count == 0 {
                continue;
            }
            let base = ctx.next_id.fetch_add(count, Relaxed);
            let tidx = rayon::current_thread_index().unwrap_or(0) % ctx.accs.len();
            let mut acc = ctx.accs[tidx].lock().unwrap();
            let mut k = 0u32;
            let mut o = 0usize;
            let mut wname: [u16; 512] = [0; 512];
            loop {
                if !is_dot(o) {
                    let eid = base + k;
                    k += 1;
                    let mtime = filetime_to_unix(rd64(data, o + 24));
                    let eof = rd64(data, o + 40).max(0) as u64;
                    let alloc = rd64(data, o + 48).max(0) as u64;
                    let attrs = rd32(data, o + 56);
                    let nl = (rd32(data, o + 60) as usize / 2).min(512);
                    let ea_or_tag = rd32(data, o + 64);
                    let tag = if class == CLASS_ID_EXTD { rd32(data, o + 68) } else if attrs & ATTR_REPARSE != 0 { ea_or_tag } else { 0 };
                    let n0 = o + name_at;
                    for (i, w) in wname[..nl].iter_mut().enumerate() {
                        *w = u16::from_le_bytes([data[n0 + 2 * i], data[n0 + 2 * i + 1]]);
                    }
                    let is_dir = attrs & ATTR_DIRECTORY != 0;
                    let fl = flags_of(attrs, tag);
                    let off = acc.names.len() as u32;
                    names::push_utf16(&mut acc.names, &wname[..nl]);
                    let blen = acc.names.len() as u32 - off;
                    acc.id.push(eid);
                    acc.parent.push(id);
                    acc.size.push(if is_dir { 0 } else { eof });
                    acc.alloc.push(if is_dir { 0 } else { alloc });
                    acc.mtime.push(mtime);
                    acc.flags.push(fl);
                    acc.name_off.push(off);
                    acc.name_len.push(blen.min(u16::MAX as u32) as u16);
                    if ctx.with_ids {
                        let fid = match id_at {
                            Some(at) if !is_dir && class == CLASS_ID_EXTD => u128::from_le_bytes(data[o + at..o + at + 16].try_into().unwrap()),
                            Some(at) if !is_dir => rd64(data, o + at) as u64 as u128,
                            _ => 0,
                        };
                        acc.fid.push(fid);
                    }
                    n_entries += 1;
                    if is_dir {
                        // Las junctions y symlinks quedan como hojas; las carpetas de la nube sí se recorren
                        if !(attrs & ATTR_REPARSE != 0 && (is_link_tag(tag) || tag == 0)) {
                            subdirs.push((eid, wname[..nl].into()));
                        }
                    } else {
                        n_bytes += eof;
                        // Asignado 0 con datos fuera de la MFT: suele ser un archivo comprimido con WOF
                        if alloc == 0 && eof > 4096 && attrs & ATTR_REPARSE == 0 && fl & (flag::CLOUD | flag::SPARSE) == 0 {
                            wof.push((eid, wname[..nl].into()));
                        }
                    }
                }
                let next = rd32(data, o) as usize;
                if next == 0 || o + next >= len {
                    break;
                }
                o += next;
            }
        }
    });
    if !wof.is_empty() {
        let fixed: Vec<(u32, u64)> = wof.iter().filter_map(|(eid, name)| real_alloc(&h, name).map(|a| (*eid, a))).collect();
        if !fixed.is_empty() {
            let tidx = rayon::current_thread_index().unwrap_or(0) % ctx.accs.len();
            ctx.accs[tidx].lock().unwrap().fix.extend(fixed);
        }
    }
    ctx.prog.entries.fetch_add(n_entries, Relaxed);
    ctx.prog.bytes.fetch_add(n_bytes, Relaxed);
    for (cid, cname) in subdirs {
        let h2 = h.clone();
        let mut p = String::with_capacity(path.len() + cname.len() + 1);
        p.push_str(&path);
        if !p.ends_with('\\') {
            p.push('\\');
        }
        p.push_str(&String::from_utf16_lossy(&cname));
        let p: Arc<str> = p.into();
        scope.spawn(move |s| dir_task(ctx, s, h2, cname, cid, p));
    }
}

/// Recorre `root` (ruta absoluta) y devuelve las entradas en bruto (id 0 = raíz).
pub fn walk(root: &str, opts: &WalkOptions, prog: &Progress, cancel: &AtomicBool) -> Result<WalkOutput, EngineMessage> {
    let rh = open_root(root)?;
    let mut ft: FILETIME = unsafe { std::mem::zeroed() };
    let root_mtime = if unsafe { GetFileTime(rh.0, std::ptr::null_mut(), std::ptr::null_mut(), &mut ft) } != 0 {
        filetime_to_unix(((ft.dwHighDateTime as i64) << 32) | ft.dwLowDateTime as i64)
    } else {
        0
    };
    let threads = opts.threads.max(1);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("tessera-walk-{i}"))
        .build()
        .map_err(|e| e.to_string())?;
    let ctx = Ctx {
        next_id: AtomicU32::new(1),
        accs: (0..threads).map(|_| Mutex::new(Acc::default())).collect(),
        class: AtomicI32::new(CLASS_ID_EXTD),
        buf_size: opts.buf_size.max(64 * 1024),
        denied: AtomicU64::new(0),
        errors: AtomicU64::new(0),
        denied_samples: Mutex::new(Vec::new()),
        error_samples: Mutex::new(Vec::new()),
        prog,
        cancel,
        with_ids: opts.dedupe_links,
    };
    let root_path: Arc<str> = root.into();
    {
        let ctx = &ctx;
        pool.install(|| rayon::scope(|s| enumerate(ctx, s, Arc::new(rh), 0, root_path)));
    }
    if cancel.load(Relaxed) {
        return Err(msg::cancelled());
    }
    drop(pool);

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
    };
    raw.flags[0] = flag::DIR;
    raw.mtime[0] = root_mtime;
    let mut fids: Vec<(u128, u32)> = Vec::new();
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
            if ctx.with_ids && a.fid[j] != 0 {
                fids.push((a.fid[j], a.id[j]));
            }
        }
        for &(i, al) in &a.fix {
            raw.alloc[i as usize] = al;
            if al < raw.size[i as usize] {
                raw.flags[i as usize] |= flag::COMPRESSED;
            }
        }
    }
    drop(accs);
    // Enlaces duros: el mismo FileId bajo varios nombres asigna espacio una sola vez
    let mut hardlinks = 0u64;
    if !fids.is_empty() {
        use rayon::slice::ParallelSliceMut;
        fids.par_sort_unstable();
        for w in 1..fids.len() {
            if fids[w].0 == fids[w - 1].0 {
                let i = fids[w].1 as usize;
                raw.alloc[i] = 0;
                raw.flags[i] |= flag::HARDLINK;
                hardlinks += 1;
            }
        }
    }
    let denied_samples = std::mem::take(&mut *ctx.denied_samples.lock().unwrap());
    let error_samples = std::mem::take(&mut *ctx.error_samples.lock().unwrap());
    Ok(WalkOutput { raw, denied: ctx.denied.load(Relaxed), denied_samples, errors: ctx.errors.load(Relaxed), error_samples, hardlinks })
}
