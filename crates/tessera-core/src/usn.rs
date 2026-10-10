//! Diario de cambios USN de NTFS: análisis de los registros que devuelve `FSCTL_READ_USN_JOURNAL`
//! (USN_RECORD_V2 y V3), qué carpetas del árbol cambiaron y lectura del diario (sólo Windows, con
//! administrador). Ver [`crate::rescan`] para cómo se usa en `refresh`.
//!
//! Formato (MS-FSCC / winioctl.h), little-endian, cada registro alineado a 8 bytes:
//! - común: `RecordLength` u32 @0, `MajorVersion` u16 @4, `MinorVersion` u16 @6;
//! - V2: FRN u64 @8, padre u64 @16, `Usn` @24, `TimeStamp` @32, `Reason` @40, `SourceInfo` @44,
//!   `SecurityId` @48, `FileAttributes` @52, longitud y desplazamiento del nombre @56/@58, nombre @60;
//! - V3: FRN y padre como FILE_ID_128 @8 y @24 (en NTFS valen los 64 bits bajos), `Usn` @40,
//!   `TimeStamp` @48, `Reason` @56, `SourceInfo` @60, `SecurityId` @64, `FileAttributes` @68,
//!   nombre @72/@74, nombre @76.
//!
//! La salida de `FSCTL_READ_USN_JOURNAL` empieza con el USN siguiente (8 bytes) y sigue con los registros.

use std::collections::{HashMap, HashSet};

use crate::tree::Tree;

/// Más carpetas que esto (o la raíz) → `refresh.journalReset`: sale más a cuenta un escaneo completo.
pub const MAX_FOLDERS: usize = 2000;

const ATTR_DIRECTORY: u32 = 0x10;
const V2_MIN: usize = 60;
const V3_MIN: usize = 76;

/// Lo que interesa de un registro del diario.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsnRecord {
    pub usn: i64,
    /// FRN del archivo o carpeta y de su carpeta padre (64 bits: registro | secuencia << 48).
    pub frn: u64,
    pub parent: u64,
    pub reason: u32,
    pub attrs: u32,
}

impl UsnRecord {
    pub fn is_dir(&self) -> bool {
        self.attrs & ATTR_DIRECTORY != 0
    }
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

/// Analiza el registro que empieza en `b`: (registro, longitud). `None` si es de otra versión (se salta
/// con su longitud); error si está truncado o mal formado.
pub fn parse_record(b: &[u8]) -> Result<(Option<UsnRecord>, usize), String> {
    if b.len() < 8 {
        return Err(format!("Truncated USN record header ({} bytes)", b.len()));
    }
    let len = r32(b, 0) as usize;
    let major = r16(b, 4);
    if len < 8 || len % 8 != 0 {
        return Err(format!("Invalid USN record length {len}"));
    }
    if len > b.len() {
        return Err(format!("Truncated USN record ({len} bytes, {} available)", b.len()));
    }
    let (min, names_at) = match major {
        2 => (V2_MIN, 56),
        3 => (V3_MIN, 72),
        _ => return Ok((None, len)),
    };
    if len < min {
        return Err(format!("USN record V{major} too short ({len} bytes)"));
    }
    let (name_len, name_off) = (r16(b, names_at) as usize, r16(b, names_at + 2) as usize);
    if name_off + name_len > len {
        return Err("USN record name out of bounds".into());
    }
    let r = if major == 2 {
        UsnRecord { frn: r64(b, 8), parent: r64(b, 16), usn: r64(b, 24) as i64, reason: r32(b, 40), attrs: r32(b, 52) }
    } else {
        UsnRecord { frn: r64(b, 8), parent: r64(b, 24), usn: r64(b, 40) as i64, reason: r32(b, 56), attrs: r32(b, 68) }
    };
    Ok((Some(r), len))
}

/// Analiza la salida de `FSCTL_READ_USN_JOURNAL`: llama a `each` con cada registro V2/V3 y devuelve el
/// USN desde el que seguir leyendo.
pub fn parse_buffer(b: &[u8], mut each: impl FnMut(UsnRecord)) -> Result<i64, String> {
    if b.len() < 8 {
        return Err(format!("USN journal buffer too short ({} bytes)", b.len()));
    }
    let next = r64(b, 0) as i64;
    let mut o = 8;
    while o < b.len() {
        let (r, len) = parse_record(&b[o..])?;
        if let Some(r) = r {
            each(r);
        }
        o += len;
    }
    Ok(next)
}

/// Lo que dice un lote de registros: las carpetas padre de lo que cambió y, de los registros de
/// carpetas, FRN → padre (el último visto) para resolver las carpetas nuevas.
#[derive(Default, Debug, Clone)]
pub struct UsnChanges {
    /// Registros leídos.
    pub records: u64,
    /// USN desde el que seguirá el próximo `refresh`.
    pub next_usn: i64,
    parents: HashSet<u64>,
    dirs: HashMap<u64, u64>,
}

impl UsnChanges {
    pub fn add(&mut self, r: &UsnRecord) {
        self.records += 1;
        self.parents.insert(r.parent);
        if r.is_dir() {
            self.dirs.insert(r.frn, r.parent);
        }
    }

    pub fn from_records(records: &[UsnRecord], next_usn: i64) -> Self {
        let mut c = UsnChanges { next_usn, ..Default::default() };
        for r in records {
            c.add(r);
        }
        c
    }

    /// Carpetas del árbol que cambiaron (ids sin repetir, en orden). Cada padre se busca con `known`
    /// (FRN → carpeta del árbol); uno desconocido, si es una carpeta de este lote (creada después del
    /// escaneo), se resuelve subiendo por sus padres hasta una conocida. Lo que no se resuelve está
    /// fuera de la raíz escaneada y se ignora.
    pub fn resolve(&self, known: impl Fn(u64) -> Option<u32>) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::new();
        for &p in &self.parents {
            let mut f = p;
            // Cada paso consume una carpeta del lote: ciclos (movimientos raros) no cuelgan nada
            for _ in 0..=self.dirs.len() {
                if let Some(id) = known(f) {
                    out.push(id);
                    break;
                }
                match self.dirs.get(&f) {
                    Some(&up) if up != f => f = up,
                    _ => break,
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }
}

/// Conjunto mínimo: quita las carpetas que están dentro de otra del conjunto (volver a escanear la de
/// fuera ya las incluye). En orden de id.
pub fn minimal_set(t: &Tree, ids: &[u32]) -> Vec<u32> {
    let set: HashSet<u32> = ids.iter().copied().collect();
    let mut v: Vec<u32> = set
        .iter()
        .copied()
        .filter(|&id| {
            let mut a = t.parent(id);
            while let Some(p) = a {
                if set.contains(&p) {
                    return false;
                }
                a = t.parent(p);
            }
            true
        })
        .collect();
    v.sort_unstable();
    v
}

/// Posición en el diario de un volumen: desde dónde leer en el próximo `refresh`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsnCursor {
    pub letter: char,
    pub journal_id: u64,
    pub next_usn: i64,
}

/// Estado del diario de un volumen (`FSCTL_QUERY_USN_JOURNAL`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JournalInfo {
    pub journal_id: u64,
    pub next_usn: i64,
    pub lowest_valid_usn: i64,
}

#[cfg(windows)]
pub use io::*;

/// Sin Windows no hay diario USN.
#[cfg(not(windows))]
pub fn read_changes(
    _cursor: &UsnCursor,
    _prog: &crate::scan::Progress,
    _cancel: &std::sync::atomic::AtomicBool,
) -> Result<UsnChanges, crate::types::EngineMessage> {
    Err(crate::msg::refresh_unavailable())
}

#[cfg(windows)]
mod io {
    use super::*;
    use crate::msg;
    use crate::scan::Progress;
    use crate::types::EngineMessage;
    use crate::walk::{wide, Handle};
    use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_HANDLE_EOF, ERROR_JOURNAL_DELETE_IN_PROGRESS, ERROR_JOURNAL_ENTRY_DELETED, ERROR_JOURNAL_NOT_ACTIVE, GENERIC_READ,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Ioctl::{FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, READ_USN_JOURNAL_DATA_V1, USN_JOURNAL_DATA_V0};
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const BUF: usize = 1 << 20;

    /// Diario reiniciado, borrado o inactivo: hace falta un escaneo completo.
    fn is_reset(code: u32) -> bool {
        matches!(code, ERROR_JOURNAL_ENTRY_DELETED | ERROR_JOURNAL_NOT_ACTIVE | ERROR_JOURNAL_DELETE_IN_PROGRESS)
    }

    fn error_of(code: u32) -> EngineMessage {
        if is_reset(code) {
            msg::refresh_journal_reset()
        } else {
            msg::internal(&format!("USN journal: {}", crate::sys::error_text(code as i32)))
        }
    }

    /// `\\.\X:` (hace falta administrador). El error es el de Win32.
    fn open_volume(letter: char) -> Result<Handle, u32> {
        let w = wide(&format!(r"\\.\{letter}:"));
        let h = unsafe {
            CreateFileW(
                w.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(unsafe { GetLastError() });
        }
        Ok(Handle(h))
    }

    fn query_handle(h: &Handle) -> Result<JournalInfo, u32> {
        // Hueco para V0, V1 o V2 (el sistema rellena lo que conoce)
        let mut buf = [0u64; 16];
        let mut got = 0u32;
        let ok = unsafe {
            DeviceIoControl(h.0, FSCTL_QUERY_USN_JOURNAL, std::ptr::null(), 0, buf.as_mut_ptr() as *mut _, 128, &mut got, std::ptr::null_mut())
        };
        if ok == 0 {
            return Err(unsafe { GetLastError() });
        }
        if (got as usize) < std::mem::size_of::<USN_JOURNAL_DATA_V0>() {
            return Err(windows_sys::Win32::Foundation::ERROR_INVALID_DATA);
        }
        let d: USN_JOURNAL_DATA_V0 = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const USN_JOURNAL_DATA_V0) };
        Ok(JournalInfo { journal_id: d.UsnJournalID, next_usn: d.NextUsn, lowest_valid_usn: d.LowestValidUsn })
    }

    /// `FSCTL_QUERY_USN_JOURNAL` del volumen `letter` (sólo funciona con administrador).
    pub fn query(letter: char) -> Result<JournalInfo, u32> {
        query_handle(&open_volume(letter)?)
    }

    /// Lee el diario desde `cursor` hasta el final que tenía al empezar. Diario con otro id, `nextUsn`
    /// anterior al primero válido o ERROR_JOURNAL_ENTRY_DELETED / NOT_ACTIVE / DELETE_IN_PROGRESS →
    /// `refresh.journalReset`; con `cancel` → `error.cancelled`. Cuenta los registros en `prog.entries`.
    pub fn read_changes(cursor: &UsnCursor, prog: &Progress, cancel: &AtomicBool) -> Result<UsnChanges, EngineMessage> {
        let h = open_volume(cursor.letter).map_err(|code| msg::internal(&format!("Could not open volume {}: {}", cursor.letter, crate::sys::error_text(code as i32))))?;
        let info = query_handle(&h).map_err(error_of)?;
        if info.journal_id != cursor.journal_id || cursor.next_usn < info.lowest_valid_usn || cursor.next_usn > info.next_usn {
            return Err(msg::refresh_journal_reset());
        }
        let mut changes = UsnChanges { next_usn: cursor.next_usn, ..Default::default() };
        let mut buf = vec![0u64; BUF / 8];
        let mut start = cursor.next_usn;
        // Hasta el final de ahora: lo que se escriba mientras tanto queda para la próxima vez
        while start < info.next_usn {
            if cancel.load(Relaxed) {
                return Err(msg::cancelled());
            }
            let input = READ_USN_JOURNAL_DATA_V1 {
                StartUsn: start,
                ReasonMask: u32::MAX,
                ReturnOnlyOnClose: 0,
                Timeout: 0,
                BytesToWaitFor: 0,
                UsnJournalID: cursor.journal_id,
                MinMajorVersion: 2,
                MaxMajorVersion: 3,
            };
            let mut got = 0u32;
            let ok = unsafe {
                DeviceIoControl(
                    h.0,
                    FSCTL_READ_USN_JOURNAL,
                    &input as *const _ as *const _,
                    std::mem::size_of::<READ_USN_JOURNAL_DATA_V1>() as u32,
                    buf.as_mut_ptr() as *mut _,
                    BUF as u32,
                    &mut got,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                match unsafe { GetLastError() } {
                    ERROR_HANDLE_EOF => break,
                    code => return Err(error_of(code)),
                }
            }
            let b: &[u8] = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, (got as usize).min(BUF)) };
            let before = changes.records;
            let next = parse_buffer(b, |r| changes.add(&r)).map_err(|e| msg::internal(&e))?;
            prog.entries.fetch_add(changes.records - before, Relaxed);
            if next <= start {
                break;
            }
            start = next;
        }
        changes.next_usn = start;
        Ok(changes)
    }

    /// FRN de una carpeta (o archivo) por su ruta: el número de índice del sistema de archivos.
    pub fn path_frn(path: &str) -> Option<u64> {
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES};
        let w = wide(&crate::walk::verbatim(path));
        let h = unsafe {
            CreateFileW(
                w.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return None;
        }
        let h = Handle(h);
        let mut fi: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(h.0, &mut fi) } != 0;
        ok.then_some(((fi.nFileIndexHigh as u64) << 32) | fi.nFileIndexLow as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{build, RawTree};
    use crate::tree::NONE;
    use crate::types::flag;

    fn put16(b: &mut [u8], o: usize, v: u16) {
        b[o..o + 2].copy_from_slice(&v.to_le_bytes());
    }
    fn put32(b: &mut [u8], o: usize, v: u32) {
        b[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put64(b: &mut [u8], o: usize, v: u64) {
        b[o..o + 8].copy_from_slice(&v.to_le_bytes());
    }

    /// USN_RECORD_V2 con nombre UTF-16, rellenado a 8 bytes.
    fn v2(frn: u64, parent: u64, usn: i64, reason: u32, attrs: u32, name: &str) -> Vec<u8> {
        let nm: Vec<u16> = name.encode_utf16().collect();
        let len = (V2_MIN + nm.len() * 2).div_ceil(8) * 8;
        let mut b = vec![0u8; len];
        put32(&mut b, 0, len as u32);
        put16(&mut b, 4, 2);
        put64(&mut b, 8, frn);
        put64(&mut b, 16, parent);
        put64(&mut b, 24, usn as u64);
        put64(&mut b, 32, 133_500_000_000_000_000);
        put32(&mut b, 40, reason);
        put32(&mut b, 52, attrs);
        put16(&mut b, 56, (nm.len() * 2) as u16);
        put16(&mut b, 58, V2_MIN as u16);
        for (i, c) in nm.iter().enumerate() {
            put16(&mut b, V2_MIN + 2 * i, *c);
        }
        b
    }

    /// USN_RECORD_V3: ids de 128 bits con basura en la mitad alta (sólo cuentan los 64 bits bajos).
    fn v3(frn: u64, parent: u64, usn: i64, reason: u32, attrs: u32, name: &str) -> Vec<u8> {
        let nm: Vec<u16> = name.encode_utf16().collect();
        let len = (V3_MIN + nm.len() * 2).div_ceil(8) * 8;
        let mut b = vec![0u8; len];
        put32(&mut b, 0, len as u32);
        put16(&mut b, 4, 3);
        put64(&mut b, 8, frn);
        put64(&mut b, 16, 0xDEAD_BEEF);
        put64(&mut b, 24, parent);
        put64(&mut b, 32, 0xFEED);
        put64(&mut b, 40, usn as u64);
        put32(&mut b, 56, reason);
        put32(&mut b, 68, attrs);
        put16(&mut b, 72, (nm.len() * 2) as u16);
        put16(&mut b, 74, V3_MIN as u16);
        for (i, c) in nm.iter().enumerate() {
            put16(&mut b, V3_MIN + 2 * i, *c);
        }
        b
    }

    fn buffer(next: i64, recs: &[Vec<u8>]) -> Vec<u8> {
        let mut b = (next as u64).to_le_bytes().to_vec();
        for r in recs {
            b.extend_from_slice(r);
        }
        b
    }

    const FILE_CREATE: u32 = 0x100;
    const DATA_EXTEND: u32 = 0x2;

    #[test]
    fn parses_v2_and_v3() {
        let a = v2(0x0001_0000_0000_0040, 0x0005_0000_0000_0005, 100, FILE_CREATE, ATTR_DIRECTORY, "nueva");
        assert_eq!(a.len() % 8, 0);
        let (r, len) = parse_record(&a).unwrap();
        assert_eq!(len, a.len());
        let r = r.unwrap();
        assert_eq!((r.frn, r.parent, r.usn, r.reason), (0x0001_0000_0000_0040, 0x0005_0000_0000_0005, 100, FILE_CREATE));
        assert!(r.is_dir());
        let b = v3(0x0002_0000_0000_0041, 0x0001_0000_0000_0040, 200, DATA_EXTEND, 0x20, "archivo con nombre largo.txt");
        let r = parse_record(&b).unwrap().0.unwrap();
        assert_eq!((r.frn, r.parent, r.usn, r.reason, r.attrs), (0x0002_0000_0000_0041, 0x0001_0000_0000_0040, 200, DATA_EXTEND, 0x20));
        assert!(!r.is_dir());
    }

    #[test]
    fn parses_buffers() {
        // Varios registros mezclados, uno de una versión desconocida (se salta) y el USN siguiente
        let mut v4 = vec![0u8; 40];
        put32(&mut v4, 0, 40);
        put16(&mut v4, 4, 4);
        let recs = [v2(1, 5, 10, FILE_CREATE, 0, "a"), v4, v3(2, 5, 20, DATA_EXTEND, 0, "bb"), v2(3, 1, 30, FILE_CREATE, ATTR_DIRECTORY, "ccc")];
        let mut got = Vec::new();
        let next = parse_buffer(&buffer(4096, &recs), |r| got.push(r)).unwrap();
        assert_eq!(next, 4096);
        assert_eq!(got.iter().map(|r| (r.frn, r.parent, r.usn)).collect::<Vec<_>>(), [(1, 5, 10), (2, 5, 20), (3, 1, 30)]);
        // Sólo el USN siguiente: final del diario
        assert_eq!(parse_buffer(&buffer(77, &[]), |_| panic!("no hay registros")).unwrap(), 77);
        assert!(parse_buffer(&[0u8; 4], |_| {}).is_err());
    }

    #[test]
    fn rejects_truncated_and_malformed() {
        let a = v2(1, 5, 10, FILE_CREATE, 0, "archivo.txt");
        let mut b = buffer(99, &[a.clone(), a.clone()]);
        b.truncate(b.len() - 9);
        let mut n = 0;
        let e = parse_buffer(&b, |_| n += 1).unwrap_err();
        assert!(e.contains("Truncated"), "{e}");
        assert_eq!(n, 1, "el primero sí se analizó");
        // Cabecera cortada, longitud 0 (no avanzaría), no alineada y menor que el mínimo de V2
        assert!(parse_record(&a[..6]).is_err());
        let mut z = a.clone();
        put32(&mut z, 0, 0);
        assert!(parse_record(&z).is_err());
        put32(&mut z, 0, 61);
        assert!(parse_record(&z).is_err());
        put32(&mut z, 0, 56);
        assert!(parse_record(&z).is_err());
        // Nombre fuera del registro
        let mut x = a.clone();
        put16(&mut x, 56, 400);
        assert!(parse_record(&x).is_err());
        // V3 truncado a la longitud de un V2
        let c = v3(1, 5, 10, 0, 0, "");
        assert!(parse_record(&c[..64]).is_err());
    }

    /// raíz(FRN 5) → A(10) → A1(11) ; B(20) ; f.txt
    fn tree() -> Tree {
        let mut r = RawTree::with_capacity(8);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        let a = r.push(root, b"A", 0, 0, 0, flag::DIR);
        let a1 = r.push(a, b"A1", 0, 0, 0, flag::DIR);
        r.push(a1, b"x.bin", 5, 8, 0, 0);
        let b = r.push(root, b"B", 0, 0, 0, flag::DIR);
        r.push(b, b"y.bin", 9, 16, 0, 0);
        r.push(root, b"f.txt", 1, 8, 0, 0);
        r.frn = vec![(root, 5), (a, 10), (a1, 11), (b, 20)];
        r.root = root;
        build(r, "C:\\".into(), &[]).unwrap()
    }

    fn sorted(v: &[u32]) -> Vec<u32> {
        let mut v = v.to_vec();
        v.sort_unstable();
        v
    }

    fn rec(frn: u64, parent: u64, dir: bool) -> UsnRecord {
        UsnRecord { usn: 0, frn, parent, reason: FILE_CREATE, attrs: if dir { ATTR_DIRECTORY } else { 0 } }
    }

    #[test]
    fn resolves_new_folders() {
        let t = tree();
        let id = |name: &str| (0..t.len() as u32).find(|&i| t.name(i) == name).unwrap();
        let (a, a1, b) = (id("A"), id("A1"), id("B"));
        assert_eq!((t.dir_by_frn(10), t.dir_by_frn(11), t.dir_by_frn(20), t.dir_by_frn(5)), (Some(a), Some(a1), Some(b), Some(0)));
        // Carpeta nueva N(30) dentro de otra nueva M(31) creada en A1; un archivo dentro de N
        let c = UsnChanges::from_records(&[rec(31, 11, true), rec(30, 31, true), rec(40, 30, false)], 0);
        assert_eq!(c.records, 3);
        assert_eq!(c.resolve(|f| t.dir_by_frn(f)), vec![a1]);
        // Un archivo cambiado en B y otro fuera de la raíz escaneada (padre desconocido sin registro)
        let c = UsnChanges::from_records(&[rec(41, 20, false), rec(42, 999, false), rec(43, 20, false)], 0);
        assert_eq!(c.resolve(|f| t.dir_by_frn(f)), vec![b]);
        // Una carpeta movida de A1 a B: los dos padres; la última posición resuelve lo de dentro
        let c = UsnChanges::from_records(&[rec(50, 11, true), rec(50, 20, true), rec(51, 50, false)], 0);
        assert_eq!(c.resolve(|f| t.dir_by_frn(f)), sorted(&[a1, b]));
        // Un ciclo de carpetas desconocidas no cuelga
        let c = UsnChanges::from_records(&[rec(60, 61, true), rec(61, 60, true), rec(62, 60, false)], 0);
        assert!(c.resolve(|f| t.dir_by_frn(f)).is_empty());
        // Lo quitado (papelera) ya no se resuelve
        let mut t2 = tree();
        t2.remove(b).unwrap();
        assert_eq!(t2.dir_by_frn(20), None);
        assert_eq!(t2.dir_by_frn(10), Some(a));
    }

    #[test]
    fn minimal_folder_set() {
        let t = tree();
        let id = |name: &str| (0..t.len() as u32).find(|&i| t.name(i) == name).unwrap();
        let (a, a1, b) = (id("A"), id("A1"), id("B"));
        assert_eq!(minimal_set(&t, &[a1, a, b, a1]), sorted(&[a, b]));
        assert_eq!(minimal_set(&t, &[a1, b]), sorted(&[a1, b]));
        assert_eq!(minimal_set(&t, &[a1, 0, b]), vec![0]);
        assert!(minimal_set(&t, &[]).is_empty());
    }
}
