//! Lector de la MFT de NTFS (sólo con administrador). Implementación propia a partir de la
//! documentación pública del formato (Linux-NTFS, libyal, MS-FSCC); no deriva de código GPL.
//!
//! Etapas: abrir `\\.\X:` → `FSCTL_GET_NTFS_VOLUME_DATA` → extents de `$MFT`
//! (`FSCTL_GET_RETRIEVAL_POINTERS`, o la lista de runs del registro 0) → lecturas de 4 MiB
//! alineadas, en paralelo, parseando cada bloque en el mismo hilo → enlace por referencia al
//! padre → `RawTree`.
//!
//! Reglas de contabilidad:
//! - Sólo registros en uso con firma "FILE" y fixups correctos.
//! - Los registros de extensión se fusionan con su registro base (comprobando la secuencia).
//! - `$FILE_NAME` en espacio DOS (8.3) se ignora; cada nombre restante es un nodo.
//! - Tamaño = `$DATA` sin nombre (instancia con LowestVCN = 0). Asignado = suma de todos los
//!   `$DATA` (también ADS y `WofCompressedData`); en comprimidos/dispersos se usa el campo de
//!   tamaño comprimido (0x40). Los datos residentes viven dentro de la MFT: asignado 0.
//! - Enlaces duros: el primer nombre lleva el asignado; los demás, `HARDLINK` y asignado 0.
//! - Las carpetas no suman su índice `$I30`; los metadatos `$MFT`, `$LogFile`… se muestran
//!   en la raíz como archivos ocultos de sistema.

use crate::build::RawTree;
use crate::names;
use crate::tree::NONE;
use crate::types::flag;
use crate::attrs::{filetime_to_unix, flags_of};

pub const ROOT_FRN: u64 = 5;
const REF_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;

const ST_IN_USE: u8 = 1;
const ST_DIR: u8 = 2;

/// Datos por número de registro (FRN) de los registros base.
#[derive(Default)]
pub struct FrnTable {
    pub state: Vec<u8>,
    pub seq: Vec<u16>,
    pub attrs: Vec<u32>,
    pub mtime: Vec<u32>,
    pub size: Vec<u64>,
    pub alloc: Vec<u64>,
    pub tag: Vec<u32>,
}

impl FrnTable {
    pub fn new(n: usize) -> Self {
        FrnTable {
            state: vec![0; n],
            seq: vec![0; n],
            attrs: vec![0; n],
            mtime: vec![0; n],
            size: vec![0; n],
            alloc: vec![0; n],
            tag: vec![0; n],
        }
    }
    pub fn len(&self) -> usize {
        self.state.len()
    }
    pub fn is_empty(&self) -> bool {
        self.state.is_empty()
    }
    /// Parte la tabla en tramos disjuntos consecutivos (para parsear en paralelo).
    pub fn split(&mut self, lens: &[usize]) -> Vec<FrnSlice<'_>> {
        let mut out = Vec::with_capacity(lens.len());
        let (mut st, mut sq, mut at, mut mt, mut sz, mut al, mut tg) = (
            &mut self.state[..],
            &mut self.seq[..],
            &mut self.attrs[..],
            &mut self.mtime[..],
            &mut self.size[..],
            &mut self.alloc[..],
            &mut self.tag[..],
        );
        for &l in lens {
            let l = l.min(st.len());
            let (a, b) = std::mem::take(&mut st).split_at_mut(l);
            st = b;
            let (c, d) = std::mem::take(&mut sq).split_at_mut(l);
            sq = d;
            let (e, f) = std::mem::take(&mut at).split_at_mut(l);
            at = f;
            let (g, h) = std::mem::take(&mut mt).split_at_mut(l);
            mt = h;
            let (i, j) = std::mem::take(&mut sz).split_at_mut(l);
            sz = j;
            let (k, m) = std::mem::take(&mut al).split_at_mut(l);
            al = m;
            let (n, o) = std::mem::take(&mut tg).split_at_mut(l);
            tg = o;
            out.push(FrnSlice { state: a, seq: c, attrs: e, mtime: g, size: i, alloc: k, tag: n });
        }
        out
    }
}

pub struct FrnSlice<'a> {
    pub state: &'a mut [u8],
    pub seq: &'a mut [u16],
    pub attrs: &'a mut [u32],
    pub mtime: &'a mut [u32],
    pub size: &'a mut [u64],
    pub alloc: &'a mut [u64],
    pub tag: &'a mut [u32],
}

/// Un `$FILE_NAME` válido: registro base, referencia al padre y nombre en `pool`.
#[derive(Clone, Copy, Debug)]
pub struct NameRec {
    pub frn: u64,
    /// Secuencia esperada del registro base (sólo para nombres en registros de extensión).
    pub base_seq: Option<u16>,
    pub parent: u64,
    pub off: u32,
    pub len: u16,
}

#[derive(Clone, Copy, Debug)]
pub enum ExtKind {
    Data { unnamed: bool, size: u64, alloc: u64 },
    Std { attrs: u32, mtime: u32 },
    Reparse(u32),
}

/// Atributo hallado en un registro de extensión, a fusionar con su base.
#[derive(Clone, Copy, Debug)]
pub struct ExtFact {
    pub base: u64,
    pub kind: ExtKind,
}

#[derive(Default)]
pub struct ChunkOut {
    pub names: Vec<NameRec>,
    pub pool: Vec<u8>,
    pub ext: Vec<ExtFact>,
    pub records: u64,
    pub bytes: u64,
}

#[inline]
fn r16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
#[inline]
fn r32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
#[inline]
fn r64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

/// Aplica los fixups (update sequence array). `false` si el registro está roto.
pub fn apply_fixups(rec: &mut [u8]) -> bool {
    let rs = rec.len();
    if rs < 512 || rs % 512 != 0 {
        return false;
    }
    let usa_off = r16(rec, 4) as usize;
    let usa_cnt = r16(rec, 6) as usize;
    if usa_cnt != rs / 512 + 1 || usa_off < 0x28 || usa_off % 2 != 0 || usa_off + usa_cnt * 2 > rs {
        return false;
    }
    let usn = r16(rec, usa_off);
    for i in 1..usa_cnt {
        let end = i * 512 - 2;
        if r16(rec, end) != usn {
            return false;
        }
        let fix = r16(rec, usa_off + i * 2);
        rec[end..end + 2].copy_from_slice(&fix.to_le_bytes());
    }
    true
}

/// Parsea un registro FILE (`rec` mide `BytesPerFileRecordSegment`).
/// `slot` es la posición del registro dentro de `sl`.
pub fn parse_record(rec: &mut [u8], frn: u64, sl: &mut FrnSlice, slot: usize, out: &mut ChunkOut) {
    if rec.len() < 0x30 || &rec[0..4] != b"FILE" {
        return;
    }
    if !apply_fixups(rec) {
        return;
    }
    let rflags = r16(rec, 0x16);
    if rflags & 1 == 0 {
        return;
    }
    out.records += 1;
    let seq = r16(rec, 0x10);
    let base_ref = r64(rec, 0x20);
    let base = base_ref & REF_MASK;
    let is_ext = base != 0;
    let used = (r32(rec, 0x18) as usize).min(rec.len());
    if !is_ext {
        sl.state[slot] = ST_IN_USE | if rflags & 2 != 0 { ST_DIR } else { 0 };
        sl.seq[slot] = seq;
    }
    let target = if is_ext { base } else { frn };
    let mut a = r16(rec, 0x14) as usize;
    while a + 16 <= used {
        let ty = r32(rec, a);
        if ty == 0xFFFF_FFFF {
            break;
        }
        let len = r32(rec, a + 4) as usize;
        if len < 16 || a + len > used {
            break;
        }
        let nonres = rec[a + 8] != 0;
        let name_len = rec[a + 9];
        let aflags = r16(rec, a + 12);
        let (voff, vlen) = if nonres { (0, 0) } else { (r16(rec, a + 0x14) as usize, r32(rec, a + 0x10) as usize) };
        let value_ok = !nonres && len >= 0x18 && voff + vlen <= len;
        match ty {
            0x10 if value_ok && vlen >= 0x24 => {
                let v = a + voff;
                let mtime = filetime_to_unix(r64(rec, v + 8) as i64);
                let attrs = r32(rec, v + 0x20);
                if is_ext {
                    out.ext.push(ExtFact { base: base_ref, kind: ExtKind::Std { attrs, mtime } });
                } else {
                    sl.attrs[slot] = attrs;
                    sl.mtime[slot] = mtime;
                }
            }
            0x30 if value_ok && vlen >= 0x42 => {
                let v = a + voff;
                let parent = r64(rec, v);
                let nlen = rec[v + 0x40] as usize;
                let ns = rec[v + 0x41];
                if ns != 2 && 0x42 + nlen * 2 <= vlen {
                    let mut w = [0u16; 255];
                    for (i, c) in w[..nlen].iter_mut().enumerate() {
                        *c = r16(rec, v + 0x42 + 2 * i);
                    }
                    let off = out.pool.len() as u32;
                    names::push_utf16(&mut out.pool, &w[..nlen]);
                    let bl = (out.pool.len() as u32 - off) as u16;
                    out.names.push(NameRec { frn: target, base_seq: is_ext.then_some((base_ref >> 48) as u16), parent, off, len: bl });
                }
            }
            0x80 => {
                let lowest = if nonres && len >= 0x40 { r64(rec, a + 0x10) } else { 0 };
                if lowest == 0 && (nonres && len >= 0x40 || value_ok) {
                    let (size, alloc) = if nonres {
                        let packed = aflags & 0x00FF != 0 || aflags & 0x8000 != 0;
                        let has_field = len >= 0x48 && r16(rec, a + 0x20) as usize >= 0x48;
                        let alloc = if packed && has_field { r64(rec, a + 0x40) } else { r64(rec, a + 0x28) };
                        (r64(rec, a + 0x30), alloc)
                    } else {
                        (vlen as u64, 0)
                    };
                    let unnamed = name_len == 0;
                    if is_ext {
                        out.ext.push(ExtFact { base: base_ref, kind: ExtKind::Data { unnamed, size, alloc } });
                    } else {
                        if unnamed {
                            sl.size[slot] = size;
                            out.bytes += size;
                        }
                        sl.alloc[slot] += alloc;
                    }
                }
            }
            0xC0 if value_ok && vlen >= 4 => {
                let tag = r32(rec, a + voff);
                if is_ext {
                    out.ext.push(ExtFact { base: base_ref, kind: ExtKind::Reparse(tag) });
                } else {
                    sl.tag[slot] = tag;
                }
            }
            _ => {}
        }
        a += len;
    }
}

/// Parsea un bloque de registros consecutivos que empieza en `first_frn`.
pub fn parse_chunk(data: &mut [u8], rs: usize, first_frn: u64, sl: &mut FrnSlice, out: &mut ChunkOut) {
    let n = (data.len() / rs).min(sl.state.len());
    for i in 0..n {
        parse_record(&mut data[i * rs..(i + 1) * rs], first_frn + i as u64, sl, i, out);
    }
}

pub struct LinkStats {
    pub orphans: u64,
    pub hardlinks: u64,
}

/// Fusiona extensiones, crea un nodo por nombre y enlaza por referencia al padre.
pub fn link(t: &mut FrnTable, outs: Vec<ChunkOut>) -> Result<(RawTree, LinkStats), String> {
    let n = t.len();
    let valid = |t: &FrnTable, r: u64| -> Option<usize> {
        let f = (r & REF_MASK) as usize;
        (f < n && t.state[f] & ST_IN_USE != 0 && t.seq[f] == (r >> 48) as u16).then_some(f)
    };
    for o in &outs {
        for e in &o.ext {
            let Some(f) = valid(t, e.base) else { continue };
            match e.kind {
                ExtKind::Data { unnamed, size, alloc } => {
                    if unnamed {
                        t.size[f] = size;
                    }
                    t.alloc[f] += alloc;
                }
                ExtKind::Std { attrs, mtime } => {
                    t.attrs[f] = attrs;
                    t.mtime[f] = mtime;
                }
                ExtKind::Reparse(tag) => t.tag[f] = tag,
            }
        }
    }
    let total_names: usize = outs.iter().map(|o| o.names.len()).sum();
    let mut raw = RawTree::with_capacity(total_names);
    let mut parents: Vec<u64> = Vec::with_capacity(total_names);
    let mut node_of = vec![NONE; n];
    let mut stats = LinkStats { orphans: 0, hardlinks: 0 };
    for o in &outs {
        for nm in &o.names {
            let f = nm.frn as usize;
            if f >= n || t.state[f] & ST_IN_USE == 0 {
                continue;
            }
            if let Some(s) = nm.base_seq {
                if t.seq[f] != s {
                    continue;
                }
            }
            let dir = t.state[f] & ST_DIR != 0;
            let mut fl = flags_of(t.attrs[f], t.tag[f]) & !flag::DIR;
            if dir {
                fl |= flag::DIR;
            }
            let first = node_of[f] == NONE;
            if dir && !first {
                continue; // una carpeta no puede tener enlaces duros
            }
            let alloc = if first { t.alloc[f] } else { 0 };
            if !first {
                fl |= flag::HARDLINK;
                stats.hardlinks += 1;
            }
            let name = &o.pool[nm.off as usize..nm.off as usize + nm.len as usize];
            let id = raw.push(NONE, name, if dir { 0 } else { t.size[f] }, alloc, t.mtime[f], fl);
            if first {
                node_of[f] = id;
            }
            parents.push(nm.parent);
        }
    }
    let r5 = ROOT_FRN as usize;
    if r5 < n && node_of[r5] == NONE && t.state[r5] & ST_DIR != 0 {
        node_of[r5] = raw.push(NONE, b".", 0, 0, t.mtime[r5], flag::DIR);
        parents.push(0);
    }
    let root = node_of.get(r5).copied().unwrap_or(NONE);
    if root == NONE {
        return Err("La MFT no contiene la carpeta raíz (registro 5)".into());
    }
    for (id, &pref) in parents.iter().enumerate() {
        if id as u32 == root {
            continue;
        }
        match valid(t, pref) {
            Some(pf) if t.state[pf] & ST_DIR != 0 && node_of[pf] != NONE => raw.parent[id] = node_of[pf],
            _ => stats.orphans += 1,
        }
    }
    raw.root = root;
    raw.flags[root as usize] |= flag::DIR;
    if !raw.parent.contains(&root) {
        return Err("La carpeta raíz de la MFT no tiene hijos".into());
    }
    Ok((raw, stats))
}

/// Decodifica una lista de runs: (VCN, LCN, clústeres). LCN = -1 en runs dispersos.
pub fn decode_runs(b: &[u8], start_vcn: u64) -> Result<Vec<(u64, i64, u64)>, String> {
    let mut out = Vec::new();
    let (mut i, mut vcn, mut lcn) = (0usize, start_vcn, 0i64);
    while i < b.len() && b[i] != 0 {
        let h = b[i];
        let (ls, os) = ((h & 0x0F) as usize, (h >> 4) as usize);
        i += 1;
        if ls == 0 || ls > 8 || os > 8 || i + ls + os > b.len() {
            return Err("Lista de runs corrupta".into());
        }
        let mut len = 0u64;
        for k in 0..ls {
            len |= (b[i + k] as u64) << (8 * k);
        }
        i += ls;
        if os == 0 {
            out.push((vcn, -1, len));
        } else {
            let mut d = 0i64;
            for k in 0..os {
                d |= (b[i + k] as i64) << (8 * k);
            }
            if b[i + os - 1] & 0x80 != 0 && os < 8 {
                d |= -1i64 << (8 * os); // extensión de signo
            }
            lcn += d;
            out.push((vcn, lcn, len));
        }
        i += os;
        vcn += len;
    }
    Ok(out)
}

/// Extents de `$MFT` a partir del registro 0 (ya con fixups): el `$DATA` sin nombre.
pub fn mft_runs_from_record0(rec: &[u8]) -> Result<Vec<(u64, i64, u64)>, String> {
    let used = (r32(rec, 0x18) as usize).min(rec.len());
    let mut a = r16(rec, 0x14) as usize;
    while a + 16 <= used {
        let ty = r32(rec, a);
        if ty == 0xFFFF_FFFF {
            break;
        }
        let len = r32(rec, a + 4) as usize;
        if len < 16 || a + len > used {
            break;
        }
        if ty == 0x20 {
            return Err("El registro 0 usa $ATTRIBUTE_LIST: hacen falta los punteros de recuperación".into());
        }
        if ty == 0x80 && rec[a + 8] != 0 && rec[a + 9] == 0 && len >= 0x40 {
            let lowest = r64(rec, a + 0x10);
            let ro = r16(rec, a + 0x20) as usize;
            return decode_runs(&rec[a + ro..a + len], lowest);
        }
        a += len;
    }
    Err("El registro 0 no tiene $DATA".into())
}

#[cfg(windows)]
pub use io::*;

#[cfg(windows)]
mod io {
    use super::*;
    use crate::scan::Progress;
    use crate::walk::{wide, Handle};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_MORE_DATA, GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_NO_BUFFERING, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::{FSCTL_GET_NTFS_VOLUME_DATA, FSCTL_GET_RETRIEVAL_POINTERS, NTFS_VOLUME_DATA_BUFFER};
    use windows_sys::Win32::System::IO::{DeviceIoControl, OVERLAPPED};

    const CHUNK: usize = 4 << 20;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    pub struct MftOutput {
        pub raw: RawTree,
        pub records: u64,
        pub orphans: u64,
        pub hardlinks: u64,
        pub mft_bytes: u64,
    }

    /// Búfer alineado a página (requisito de `FILE_FLAG_NO_BUFFERING`).
    struct AlignedBuf {
        ptr: *mut u8,
        len: usize,
    }
    unsafe impl Send for AlignedBuf {}
    impl AlignedBuf {
        fn new(len: usize) -> Self {
            let layout = std::alloc::Layout::from_size_align(len, 4096).unwrap();
            let ptr = unsafe { std::alloc::alloc_zeroed(layout) };
            assert!(!ptr.is_null(), "sin memoria");
            AlignedBuf { ptr, len }
        }
        fn as_mut(&mut self) -> &mut [u8] {
            unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
        }
    }
    impl Drop for AlignedBuf {
        fn drop(&mut self) {
            unsafe { std::alloc::dealloc(self.ptr, std::alloc::Layout::from_size_align(self.len, 4096).unwrap()) };
        }
    }

    fn open_volume(letter: char) -> Result<Handle, String> {
        let w = wide(&format!(r"\\.\{letter}:"));
        let h = unsafe {
            CreateFileW(
                w.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_NO_BUFFERING,
                std::ptr::null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(format!("No se pudo abrir el volumen {letter}: {}", crate::sys::last_error_text()));
        }
        Ok(Handle(h))
    }

    fn volume_data(h: &Handle) -> Result<NTFS_VOLUME_DATA_BUFFER, String> {
        let mut vd: NTFS_VOLUME_DATA_BUFFER = unsafe { std::mem::zeroed() };
        let mut got = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                h.0,
                FSCTL_GET_NTFS_VOLUME_DATA,
                std::ptr::null(),
                0,
                &mut vd as *mut _ as *mut _,
                std::mem::size_of::<NTFS_VOLUME_DATA_BUFFER>() as u32,
                &mut got,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!("FSCTL_GET_NTFS_VOLUME_DATA: {}", crate::sys::last_error_text()));
        }
        Ok(vd)
    }

    /// Extents de `$MFT` pedidos al sistema (resuelve también `$ATTRIBUTE_LIST`).
    fn extents_fsctl(letter: char) -> Result<Vec<(u64, i64, u64)>, String> {
        let w = wide(&format!(r"\\.\{letter}:\$MFT::$DATA"));
        let h = unsafe {
            CreateFileW(
                w.as_ptr(),
                FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(crate::sys::last_error_text());
        }
        let h = Handle(h);
        let mut out = Vec::new();
        let mut start: i64 = 0;
        let mut buf = vec![0u64; 4096];
        loop {
            let mut got = 0u32;
            let ok = unsafe {
                DeviceIoControl(
                    h.0,
                    FSCTL_GET_RETRIEVAL_POINTERS,
                    &start as *const i64 as *const _,
                    8,
                    buf.as_mut_ptr() as *mut _,
                    (buf.len() * 8) as u32,
                    &mut got,
                    std::ptr::null_mut(),
                )
            };
            let more = ok == 0 && unsafe { GetLastError() } == ERROR_MORE_DATA;
            if ok == 0 && !more {
                return Err(crate::sys::last_error_text());
            }
            let len = if more { buf.len() * 8 } else { got as usize };
            let b: &[u8] = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, len) };
            if b.len() < 16 {
                break;
            }
            let count = r32(b, 0) as usize;
            let mut vcn = r64(b, 8);
            for i in 0..count {
                let o = 16 + i * 16;
                if o + 16 > b.len() {
                    break;
                }
                let next = r64(b, o);
                let lcn = r64(b, o + 8) as i64;
                out.push((vcn, lcn, next - vcn));
                vcn = next;
            }
            if !more || count == 0 {
                break;
            }
            start = vcn as i64;
        }
        Ok(out)
    }

    fn read_at(h: &Handle, buf: &mut [u8], offset: u64) -> Result<usize, String> {
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.Anonymous.Anonymous.Offset = offset as u32;
        ov.Anonymous.Anonymous.OffsetHigh = (offset >> 32) as u32;
        let mut got = 0u32;
        let ok = unsafe { ReadFile(h.0, buf.as_mut_ptr(), buf.len() as u32, &mut got, &mut ov) };
        if ok == 0 {
            return Err(crate::sys::last_error_text());
        }
        Ok(got as usize)
    }

    fn extents_record0(h: &Handle, vd: &NTFS_VOLUME_DATA_BUFFER) -> Result<Vec<(u64, i64, u64)>, String> {
        let rs = vd.BytesPerFileRecordSegment as usize;
        let sector = (vd.BytesPerSector as usize).max(512);
        let mut buf = AlignedBuf::new(rs.div_ceil(sector) * sector);
        let off = vd.MftStartLcn as u64 * vd.BytesPerCluster as u64;
        read_at(h, buf.as_mut(), off)?;
        let rec = &mut buf.as_mut()[..rs];
        if &rec[0..4] != b"FILE" || !apply_fixups(rec) {
            return Err("Registro 0 de la MFT ilegible".into());
        }
        mft_runs_from_record0(rec)
    }

    struct Task<'a> {
        disk: u64,
        len: usize,
        first_frn: u64,
        sl: FrnSlice<'a>,
        out: ChunkOut,
        err: Option<String>,
    }

    /// Lee y parsea toda la MFT del volumen `letter`.
    pub fn read_mft(letter: char, prog: &Progress, cancel: &AtomicBool) -> Result<MftOutput, String> {
        let vol = open_volume(letter)?;
        let vd = volume_data(&vol)?;
        let rs = vd.BytesPerFileRecordSegment as usize;
        let cs = vd.BytesPerCluster as u64;
        let sector = (vd.BytesPerSector as u64).max(512);
        if rs < 512 || rs % 512 != 0 || cs == 0 {
            return Err(format!("Geometría NTFS no soportada (registro {rs} B, clúster {cs} B)"));
        }
        let valid = vd.MftValidDataLength as u64;
        let extents = match extents_fsctl(letter) {
            Ok(e) if !e.is_empty() => e,
            _ => extents_record0(&vol, &vd)?,
        };
        drop(vol);
        let n_records = (valid / rs as u64) as usize;
        // Bloques de hasta 4 MiB dentro de cada extent, recortados a MftValidDataLength
        let mut plan: Vec<(u64, usize, u64)> = Vec::new(); // (disco, bytes, primer FRN)
        let mut sorted = extents.clone();
        sorted.sort_by_key(|e| e.0);
        let mut expect_vcn = 0u64;
        for &(vcn, lcn, clusters) in &sorted {
            if lcn < 0 || vcn != expect_vcn {
                return Err("Extents de la MFT no contiguos".into());
            }
            expect_vcn = vcn + clusters;
            let mft_off = vcn * cs;
            if mft_off >= valid {
                break;
            }
            if mft_off % rs as u64 != 0 {
                return Err("Extent de la MFT no alineado a registro".into());
            }
            let ext_len = (clusters * cs).min(valid - mft_off);
            let mut done = 0u64;
            while done < ext_len {
                let piece = (ext_len - done).min(CHUNK as u64);
                let piece = piece - piece % rs as u64;
                if piece == 0 {
                    break;
                }
                plan.push((lcn as u64 * cs + done, piece as usize, (mft_off + done) / rs as u64));
                done += piece;
            }
        }
        let mut table = FrnTable::new(n_records);
        let lens: Vec<usize> = plan.iter().map(|p| p.1 / rs).collect();
        let slices = table.split(&lens);
        let tasks: Vec<Task> = plan
            .iter()
            .zip(slices)
            .map(|(&(disk, len, first_frn), sl)| Task { disk, len, first_frn, sl, out: ChunkOut::default(), err: None })
            .collect();
        // N lectores, cada uno con su handle y su búfer alineado, toman bloques en orden:
        // varias lecturas de 4 MiB en vuelo y el parseo en el mismo hilo que leyó.
        let workers = rayon::current_num_threads().clamp(1, 8);
        prog.work_total.store(tasks.iter().map(|t| t.len as u64).sum(), Relaxed);
        let tasks: Vec<Mutex<Task>> = tasks.into_iter().map(Mutex::new).collect();
        let next = AtomicUsize::new(0);
        rayon::scope(|s| {
            for _ in 0..workers {
                s.spawn(|_| {
                    let h = open_volume(letter);
                    let mut buf = AlignedBuf::new(CHUNK + 4096);
                    loop {
                        let i = next.fetch_add(1, Relaxed);
                        if i >= tasks.len() || cancel.load(Relaxed) {
                            break;
                        }
                        let mut t = tasks[i].lock().unwrap();
                        let h = match &h {
                            Ok(h) => h,
                            Err(e) => {
                                t.err = Some(e.clone());
                                continue;
                            }
                        };
                        let want = (t.len as u64).div_ceil(sector) * sector;
                        let b = &mut buf.as_mut()[..want as usize];
                        match read_at(h, b, t.disk) {
                            Ok(got) if got >= t.len => {
                                let t = &mut *t;
                                parse_chunk(&mut b[..t.len], rs, t.first_frn, &mut t.sl, &mut t.out);
                                prog.entries.fetch_add(t.out.records, Relaxed);
                                prog.bytes.fetch_add(t.out.bytes, Relaxed);
                                prog.work_done.fetch_add(t.len as u64, Relaxed);
                            }
                            Ok(_) => t.err = Some("Lectura incompleta de la MFT".into()),
                            Err(e) => t.err = Some(e),
                        }
                    }
                });
            }
        });
        let tasks: Vec<Task> = tasks.into_iter().map(|m| m.into_inner().unwrap()).collect();
        if cancel.load(Relaxed) {
            return Err("Escaneo cancelado".into());
        }
        if let Some(e) = tasks.iter().find_map(|t| t.err.clone()) {
            return Err(format!("Error leyendo la MFT: {e}"));
        }
        let records: u64 = tasks.iter().map(|t| t.out.records).sum();
        let outs: Vec<ChunkOut> = tasks.into_iter().map(|t| t.out).collect();
        prog.set_phase(crate::types::ScanPhase::Link);
        let (raw, st) = link(&mut table, outs)?;
        Ok(MftOutput { raw, records, orphans: st.orphans, hardlinks: st.hardlinks, mft_bytes: valid })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RS: usize = 1024;

    /// Construye un registro FILE sintético con fixups aplicados como en disco.
    struct Rec {
        b: Vec<u8>,
        a: usize,
    }
    impl Rec {
        fn new(seq: u16, flags: u16, base_ref: u64) -> Self {
            let mut b = vec![0u8; RS];
            b[0..4].copy_from_slice(b"FILE");
            b[4..6].copy_from_slice(&0x30u16.to_le_bytes()); // USA
            b[6..8].copy_from_slice(&3u16.to_le_bytes());
            b[0x10..0x12].copy_from_slice(&seq.to_le_bytes());
            b[0x14..0x16].copy_from_slice(&0x38u16.to_le_bytes());
            b[0x16..0x18].copy_from_slice(&flags.to_le_bytes());
            b[0x20..0x28].copy_from_slice(&base_ref.to_le_bytes());
            Rec { b, a: 0x38 }
        }
        fn attr(&mut self, ty: u32, body: &[u8], nonres: bool, name_len: u8, aflags: u16) -> &mut Self {
            let a = self.a;
            let len = (body.len() + 7) & !7;
            self.b[a..a + 4].copy_from_slice(&ty.to_le_bytes());
            self.b[a + 4..a + 8].copy_from_slice(&(len as u32).to_le_bytes());
            self.b[a + 8] = nonres as u8;
            self.b[a + 9] = name_len;
            self.b[a + 12..a + 14].copy_from_slice(&aflags.to_le_bytes());
            self.b[a + 10..a + 12].copy_from_slice(&body[10..12]);
            self.b[a + 16..a + body.len()].copy_from_slice(&body[16..]);
            self.a += len;
            self
        }
        fn resident(&mut self, ty: u32, value: &[u8]) -> &mut Self {
            let mut body = vec![0u8; 0x18 + value.len()];
            body[0x10..0x14].copy_from_slice(&(value.len() as u32).to_le_bytes());
            body[0x14..0x16].copy_from_slice(&0x18u16.to_le_bytes());
            body[0x18..].copy_from_slice(value);
            self.attr(ty, &body, false, 0, 0)
        }
        fn std_info(&mut self, attrs: u32, mtime_ft: u64) -> &mut Self {
            let mut v = vec![0u8; 0x48];
            v[8..16].copy_from_slice(&mtime_ft.to_le_bytes());
            v[0x20..0x24].copy_from_slice(&attrs.to_le_bytes());
            self.resident(0x10, &v)
        }
        fn file_name(&mut self, parent: u64, name: &str, ns: u8) -> &mut Self {
            let w: Vec<u16> = name.encode_utf16().collect();
            let mut v = vec![0u8; 0x42 + w.len() * 2];
            v[0..8].copy_from_slice(&parent.to_le_bytes());
            v[0x40] = w.len() as u8;
            v[0x41] = ns;
            for (i, c) in w.iter().enumerate() {
                v[0x42 + 2 * i..0x44 + 2 * i].copy_from_slice(&c.to_le_bytes());
            }
            self.resident(0x30, &v)
        }
        /// `$DATA` no residente; `name` != "" crea un flujo con nombre (ADS).
        fn data_nonres(&mut self, size: u64, alloc: u64, compressed: Option<u64>, lowest_vcn: u64, name: &str) -> &mut Self {
            let hdr = if compressed.is_some() { 0x48 } else { 0x40 };
            let w: Vec<u16> = name.encode_utf16().collect();
            let mut body = vec![0u8; hdr + w.len() * 2 + 8];
            body[0x10..0x18].copy_from_slice(&lowest_vcn.to_le_bytes());
            body[0x20..0x22].copy_from_slice(&((hdr + w.len() * 2) as u16).to_le_bytes()); // runs (vacíos)
            body[0x28..0x30].copy_from_slice(&alloc.to_le_bytes());
            body[0x30..0x38].copy_from_slice(&size.to_le_bytes());
            body[0x38..0x40].copy_from_slice(&size.to_le_bytes());
            if let Some(c) = compressed {
                body[0x40..0x48].copy_from_slice(&c.to_le_bytes());
            }
            body[0x0A..0x0C].copy_from_slice(&(hdr as u16).to_le_bytes());
            for (i, c) in w.iter().enumerate() {
                body[hdr + 2 * i..hdr + 2 * i + 2].copy_from_slice(&c.to_le_bytes());
            }
            let aflags = if compressed.is_some() { 0x0001 } else { 0 };
            self.attr(0x80, &body, true, w.len() as u8, aflags)
        }
        fn finish(&mut self) -> Vec<u8> {
            let a = self.a;
            self.b[a..a + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
            self.b[0x18..0x1C].copy_from_slice(&((a + 8) as u32).to_le_bytes());
            self.b[0x1C..0x20].copy_from_slice(&(RS as u32).to_le_bytes());
            // Fixups: guardar los 2 últimos bytes de cada sector y poner el USN
            let usn = 0x0007u16;
            self.b[0x30..0x32].copy_from_slice(&usn.to_le_bytes());
            for s in 1..=2 {
                let end = s * 512 - 2;
                let orig = [self.b[end], self.b[end + 1]];
                self.b[0x30 + s * 2..0x32 + s * 2].copy_from_slice(&orig);
                self.b[end..end + 2].copy_from_slice(&usn.to_le_bytes());
            }
            self.b.clone()
        }
    }

    fn fref(frn: u64, seq: u16) -> u64 {
        frn | ((seq as u64) << 48)
    }

    #[test]
    fn synthetic_mft() {
        const FT: u64 = 133_500_000_000_000_000; // ≈ 2024
        let n = 24usize;
        let mut mft = vec![0u8; n * RS];
        let mut put = |frn: usize, r: Vec<u8>| mft[frn * RS..(frn + 1) * RS].copy_from_slice(&r);
        // 5: raíz "." (padre = sí misma)
        put(5, Rec::new(5, 3, 0).std_info(0x16, FT).file_name(fref(5, 5), ".", 3).finish());
        // 16: carpeta "Datos"
        put(16, Rec::new(1, 3, 0).std_info(0x10, FT).file_name(fref(5, 5), "Datos", 1).finish());
        // 17: archivo con nombre largo + DOS, 2 enlaces duros y un ADS
        put(
            17,
            Rec::new(2, 1, 0)
                .std_info(0x20 | 0x2, FT)
                .file_name(fref(16, 1), "INFORM~1.TXT", 2)
                .file_name(fref(16, 1), "Informe largo.txt", 1)
                .file_name(fref(5, 5), "copia.txt", 1)
                .data_nonres(10_000, 12_288, None, 0, "")
                .data_nonres(100, 4096, None, 0, "Zone.Identifier")
                .finish(),
        );
        // 18: archivo comprimido: asignado = campo 0x40
        put(
            18,
            Rec::new(1, 1, 0).std_info(0x800, FT).file_name(fref(16, 1), "big.log", 1).data_nonres(1 << 20, 1 << 20, Some(65536), 0, "").finish(),
        );
        // 19: archivo cuyo $DATA vive en el registro de extensión 20
        put(19, Rec::new(4, 1, 0).std_info(0, FT).file_name(fref(16, 1), "frag.bin", 1).finish());
        put(20, Rec::new(1, 1, fref(19, 4)).data_nonres(5_000_000, 5_001_216, None, 0, "").data_nonres(0, 0, None, 77, "").finish());
        // 21: archivo residente pequeño
        put(21, Rec::new(1, 1, 0).std_info(0, FT).file_name(fref(5, 5), "mini.txt", 3).resident(0x80, b"hola").finish());
        // 22: registro no en uso (se ignora)
        put(22, Rec::new(9, 0, 0).std_info(0, FT).file_name(fref(5, 5), "borrado.txt", 1).finish());
        // 23: huérfano (padre con secuencia vieja)
        put(23, Rec::new(1, 1, 0).std_info(0, FT).file_name(fref(16, 99), "huerfano.txt", 1).data_nonres(1, 4096, None, 0, "").finish());
        // 12: registro roto (fixup incorrecto)
        let mut torn = Rec::new(1, 1, 0).std_info(0, FT).file_name(fref(5, 5), "roto", 1).finish();
        torn[510] ^= 0xFF;
        put(12, torn);

        let mut table = FrnTable::new(n);
        // Dos bloques para ejercitar el reparto en tramos
        let lens = [16usize, 8];
        let mut outs = Vec::new();
        {
            let slices = table.split(&lens);
            let mut first = 0u64;
            for (mut sl, &l) in slices.into_iter().zip(&lens) {
                let mut out = ChunkOut::default();
                let s = first as usize * RS;
                parse_chunk(&mut mft[s..s + l * RS], RS, first, &mut sl, &mut out);
                outs.push(out);
                first += l as u64;
            }
        }
        let (raw, st) = link(&mut table, outs).unwrap();
        assert_eq!(st.orphans, 1);
        assert_eq!(st.hardlinks, 1);
        let t = crate::build::build(raw, "X:\\".into(), &[]).unwrap();
        let find = |p: &str| (0..t.len() as u32).find(|&i| t.path(i) == p).unwrap_or_else(|| panic!("falta {p}"));
        let inf = find("X:\\Datos\\Informe largo.txt");
        assert_eq!(t.size(inf), 10_000);
        assert_eq!(t.alloc(inf), 12_288 + 4096); // ADS incluido
        assert_eq!(t.flags(inf) & flag::HIDDEN, flag::HIDDEN);
        assert_eq!(t.mtime(inf), 1_705_526_400);
        let copia = find("X:\\copia.txt");
        assert_eq!(t.size(copia), 10_000);
        assert_eq!(t.alloc(copia), 0);
        assert_eq!(t.flags(copia) & flag::HARDLINK, flag::HARDLINK);
        let big = find("X:\\Datos\\big.log");
        assert_eq!((t.size(big), t.alloc(big)), (1 << 20, 65536));
        assert_eq!(t.flags(big) & flag::COMPRESSED, flag::COMPRESSED);
        let frag = find("X:\\Datos\\frag.bin");
        assert_eq!((t.size(frag), t.alloc(frag)), (5_000_000, 5_001_216));
        let mini = find("X:\\mini.txt");
        assert_eq!((t.size(mini), t.alloc(mini)), (4, 0));
        assert!((0..t.len() as u32).all(|i| !t.name(i).contains("INFORM~1") && t.name(i) != "borrado.txt" && t.name(i) != "roto"));
        // Totales: raíz = Datos + copia + mini
        assert_eq!(t.files(0), 5);
        assert_eq!(t.dirs(0), 1);
        assert_eq!(t.size(0), 10_000 + (1 << 20) + 5_000_000 + 10_000 + 4);
        assert_eq!(t.alloc(0), 16_384 + 65_536 + 5_001_216);
    }

    #[test]
    fn runlist() {
        // Ejemplo de Linux-NTFS: 0x30 @0x60, 0x10 @0x160, 0x20 @0x140 (delta negativo)
        let b = [0x11, 0x30, 0x60, 0x21, 0x10, 0x00, 0x01, 0x11, 0x20, 0xE0, 0x00];
        let r = decode_runs(&b, 0).unwrap();
        assert_eq!(r, vec![(0, 0x60, 0x30), (0x30, 0x160, 0x10), (0x40, 0x140, 0x20)]);
        let sparse = [0x01, 0x05, 0x00];
        assert_eq!(decode_runs(&sparse, 10).unwrap(), vec![(10, -1, 5)]);
    }

    #[test]
    fn torn_record_rejected() {
        let mut r = Rec::new(1, 1, 0).std_info(0, 0).finish();
        assert!(apply_fixups(&mut r.clone()));
        r[1022] ^= 1;
        assert!(!apply_fixups(&mut r));
    }
}
