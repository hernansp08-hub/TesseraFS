//! Escaneo guardado: el árbol COMPLETO en un archivo `.tessera`, para abrirlo después en otro equipo o
//! en otro momento (docs/ARQUITECTURA.md › Escaneo guardado). El formato es el mismo en las dos
//! ediciones (versión 1): gzip de
//!
//! ```text
//! {"v":1,"kind":"tesserafs-scan","app":"0.11.0","host":"NOMBRE-PC","path":"C:\\","scannedAt":1791700000,
//!  "engine":"mft","volume":{…VolumeInfo…}|null,"nodes":[[parent,name,isDir,size,alloc,files,dirs,mtime,flags],…]}
//! ```
//!
//! como el resumen del historial (`<id>.snap.gz`, ver [`crate::history`]) pero con todos los nodos y una
//! columna más, `flags` (sólo los bits públicos de [`flag`]). Preorden: `nodes[0]` es la raíz (`parent` −1
//! y la ruta como nombre), cada nodo va después de su padre y los hijos de una carpeta, en el orden del
//! árbol. `host` y `app` son opcionales. Los nombres con suplentes sueltos (Windows) se escriben como
//! `\udXXX`, igual que `JSON.stringify`, y se leen tal cual (WTF-8).
//!
//! Al abrir, las carpetas toman los totales de lo que contienen (como al escanear: lo guardado en
//! `size`/`alloc`/`files`/`dirs` de las carpetas no se usa) y `ext` sale del nombre. El escaneo abierto
//! queda «sin conexión» (`ScanResult.offline`): lo que mira o cambia el disco y el historial responden
//! `scan.offline` ([`Scan::check_online`]).

use std::fmt;
use std::io::{self, BufWriter, Read, Write};
use std::time::Instant;

use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;

use crate::build::{build, RawTree};
use crate::export;
use crate::msg;
use crate::names;
use crate::scan::{next_serial, Scan};
use crate::tree::NONE;
use crate::types::{flag, Engine, EngineMessage, ExportResult, SavedScanInfo, ScanResult, VolumeInfo};

/// Versión del formato.
pub const VERSION: u32 = 1;
/// Valor de `kind`.
pub const KIND: &str = "tesserafs-scan";
/// Extensión de los archivos (sin el punto).
pub const EXT: &str = "tessera";
/// Tamaño máximo del archivo y de su JSON descomprimido: un archivo dañado (o una bomba gzip) no agota la memoria.
pub const MAX_BYTES: u64 = 1 << 30;
/// Nodos como máximo.
pub const MAX_NODES: usize = 50_000_000;
/// Bits públicos de `flags` (los de [`flag`]); nunca bits internos.
const PUBLIC: u16 = 0xFF;

impl Scan {
    /// De dónde viene el escaneo, si se abrió desde un archivo.
    pub fn offline(&self) -> Option<&SavedScanInfo> {
        self.result.offline.as_ref()
    }

    /// `scan.offline` si el escaneo se abrió desde un archivo: lo que mira o cambia el disco (acciones,
    /// volver a escanear, actualizar, duplicados, enlaces rotos) y el historial no están disponibles.
    pub fn check_online(&self) -> Result<(), EngineMessage> {
        match self.result.offline {
            Some(_) => Err(msg::scan_offline()),
            None => Ok(()),
        }
    }
}

// ---------- Guardar ----------

/// Nombre del equipo (`COMPUTERNAME` en Windows, `gethostname` en Linux), si se sabe.
#[cfg(windows)]
pub fn host_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok().filter(|h| !h.trim().is_empty())
}

/// Nombre del equipo (`COMPUTERNAME` en Windows, `gethostname` en Linux), si se sabe.
#[cfg(unix)]
pub fn host_name() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: búfer propio con su longitud; gethostname no escribe más allá
    if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned()).filter(|h| !h.trim().is_empty())
}

#[cfg(not(any(windows, unix)))]
pub fn host_name() -> Option<String> {
    None
}

/// Escritor que no deja pasar más de `left` bytes (el JSON de un escaneo que luego no se podría abrir).
struct Limited<W> {
    inner: W,
    left: u64,
}

impl<W: Write> Write for Limited<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() as u64 > self.left {
            return Err(io::Error::other(format!("the scan is too large to save (more than {} MiB of data)", MAX_BYTES >> 20)));
        }
        let n = self.inner.write(buf)?;
        self.left -= n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Escribe el escaneo completo (gzip) en `w`: los nodos vivos (sin lo enviado a la papelera ni lo
/// sustituido al volver a escanear). Un escaneo abierto desde archivo conserva su `app` y su `host`.
/// Devuelve los nodos escritos. Un JSON de más de [`MAX_BYTES`] (que no se podría abrir) es un error.
pub fn write_scan<W: Write>(w: W, scan: &Scan) -> io::Result<u64> {
    write_limited(w, scan, MAX_BYTES)
}

fn write_limited<W: Write>(w: W, scan: &Scan, limit: u64) -> io::Result<u64> {
    let t = &scan.tree;
    let (app, host) = match &scan.result.offline {
        Some(o) => (o.app.clone(), o.host.clone()),
        None => (Some(env!("CARGO_PKG_VERSION").to_string()), host_name()),
    };
    // Nivel 1, como el historial: medido con C:\Windows (317 000 nodos, 28 MB de JSON), 0,18 s y 6,7 MB
    // frente a 1,2 s y 5,0 MB con el nivel 6
    let gz = GzEncoder::new(w, Compression::fast());
    let mut w = BufWriter::with_capacity(1 << 16, Limited { inner: gz, left: limit });
    write!(w, "{{\"v\":{VERSION},\"kind\":\"{KIND}\"")?;
    if let Some(app) = &app {
        w.write_all(b",\"app\":")?;
        serde_json::to_writer(&mut w, app)?;
    }
    if let Some(host) = &host {
        w.write_all(b",\"host\":")?;
        serde_json::to_writer(&mut w, host)?;
    }
    w.write_all(b",\"path\":")?;
    serde_json::to_writer(&mut w, t.root_path())?;
    write!(w, ",\"scannedAt\":{},\"engine\":", scan.scanned_at)?;
    serde_json::to_writer(&mut w, &scan.result.engine)?;
    w.write_all(b",\"volume\":")?;
    serde_json::to_writer(&mut w, &scan.result.volume)?;
    w.write_all(b",\"nodes\":[")?;
    let mut n = 0u64;
    // Preorden: (id en el árbol, índice del padre en `nodes`); los hijos, en el orden del árbol
    let mut stack: Vec<(u32, i64)> = vec![(0, -1)];
    while let Some((id, parent)) = stack.pop() {
        if n > 0 {
            w.write_all(b",")?;
        }
        write!(w, "[{parent},")?;
        write_name(&mut w, t.name_bytes(id))?;
        let dir = t.is_dir(id);
        let flags = t.flags(id) & PUBLIC;
        write!(w, ",{},{},{},{},{},{},{flags}]", u8::from(dir), t.size(id), t.alloc(id), t.files(id), t.dirs(id), t.mtime(id))?;
        let me = n as i64;
        n += 1;
        if dir {
            let kids = t.kids(id);
            for i in (0..kids.len()).rev() {
                stack.push((kids.get(i), me));
            }
        }
    }
    w.write_all(b"]}")?;
    w.into_inner().map_err(|e| e.into_error())?.inner.finish()?;
    Ok(n)
}

/// Nombre en JSON. WTF-8 con suplentes sueltos: cada uno como `\udXXX` (lo mismo que `JSON.stringify`).
fn write_name(w: &mut impl Write, b: &[u8]) -> io::Result<()> {
    if let Ok(s) = std::str::from_utf8(b) {
        return serde_json::to_writer(w, s).map_err(io::Error::from);
    }
    let mut out = String::with_capacity(b.len() + 8);
    out.push('"');
    for cp in names::code_points(b) {
        match char::from_u32(cp) {
            Some('"') => out.push_str("\\\""),
            Some('\\') => out.push_str("\\\\"),
            Some('\n') => out.push_str("\\n"),
            Some('\r') => out.push_str("\\r"),
            Some('\t') => out.push_str("\\t"),
            Some('\u{8}') => out.push_str("\\b"),
            Some('\u{c}') => out.push_str("\\f"),
            Some(c) if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            Some(c) => out.push(c),
            // Suplente suelto
            None => out.push_str(&format!("\\u{cp:04x}")),
        }
    }
    out.push('"');
    w.write_all(out.as_bytes())
}

/// Fecha local: (año, mes, día, hora, minuto).
#[cfg(windows)]
pub(crate) fn local_time(secs: u64) -> Option<(i64, u32, u32, u32, u32)> {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
    let ticks = secs.checked_add(11_644_473_600)?.checked_mul(10_000_000)?;
    let ft = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    // SAFETY: estructuras propias; con NULL se usa la zona horaria activa (y su horario de verano en esa fecha)
    let (mut utc, mut local): (SYSTEMTIME, SYSTEMTIME) = unsafe { (std::mem::zeroed(), std::mem::zeroed()) };
    if unsafe { FileTimeToSystemTime(&ft, &mut utc) } == 0 || unsafe { SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) } == 0 {
        return None;
    }
    Some((local.wYear as i64, local.wMonth as u32, local.wDay as u32, local.wHour as u32, local.wMinute as u32))
}

/// Fecha local: (año, mes, día, hora, minuto).
#[cfg(unix)]
pub(crate) fn local_time(secs: u64) -> Option<(i64, u32, u32, u32, u32)> {
    let t = libc::time_t::try_from(secs).ok()?;
    // SAFETY: `tm` propio; localtime_r es la versión reentrante
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return None;
    }
    Some((tm.tm_year as i64 + 1900, tm.tm_mon as u32 + 1, tm.tm_mday as u32, tm.tm_hour as u32, tm.tm_min as u32))
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn local_time(_secs: u64) -> Option<(i64, u32, u32, u32, u32)> {
    None
}

/// Lo que da nombre al archivo: la letra en una unidad de Windows (`C`), el último componente en una
/// carpeta (`Datos`, `share` en `\\srv\share`), `raiz` en `/`; sin caracteres reservados (pasan a `_`)
/// ni punto o espacio final, y como mucho 100 unidades UTF-16.
pub fn root_label(root: &str) -> String {
    let trimmed = root.trim_end_matches(['\\', '/']);
    let b = trimmed.as_bytes();
    let base = if b.len() == 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        trimmed[..1].to_ascii_uppercase()
    } else {
        trimmed.rsplit(['\\', '/']).next().unwrap_or_default().to_string()
    };
    let mut out = String::new();
    let mut units = 0;
    for c in base.chars() {
        units += c.len_utf16();
        if units > 100 {
            break;
        }
        let bad = c < ' ' || c == '\u{7f}' || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        out.push(if bad { '_' } else { c });
    }
    out.truncate(out.trim_end_matches(['.', ' ']).len());
    if out.is_empty() {
        "raiz".into()
    } else {
        out
    }
}

/// `<raíz> <AAAA-MM-DD HHMM>.tessera` con la fecha local del escaneo ([`root_label`]); UTC si no se
/// puede saber la hora local.
pub fn file_name(root: &str, scanned_at: u64) -> String {
    let (y, mo, d, h, mi) = local_time(scanned_at).unwrap_or_else(|| {
        let s = crate::history::utc_stamp(scanned_at); // YYYYMMDDTHHMMSSZ
        let n = |r: std::ops::Range<usize>| s[r].parse::<u32>().unwrap_or(0);
        (n(0..4) as i64, n(4..6), n(6..8), n(9..11), n(11..13))
    });
    format!("{} {y:04}-{mo:02}-{d:02} {h:02}{mi:02}.{EXT}", root_label(root))
}

/// Guarda el escaneo cargado completo en la carpeta de exportación (Descargas\TesseraFS o
/// `TESSERA_EXPORT_DIR`, como [`export::export_file`]) con el nombre de [`file_name`]; si ya existe,
/// « (2)», « (3)»… Un escaneo abierto desde archivo se puede volver a guardar (conserva su `scannedAt`,
/// `host` y `app`). Errores de escritura: `export.failed`.
pub fn save_scan(scan: &Scan) -> Result<ExportResult, EngineMessage> {
    let mut name = file_name(scan.tree.root_path(), scan.scanned_at);
    if !export::valid_name(&name) {
        name = file_name("/", scan.scanned_at);
    }
    export::write_new(&name, |f| write_scan(f, scan).map(drop))
}

// ---------- Abrir ----------

/// Descomprime: como mucho `limit` bytes de entrada y otros tantos de salida.
fn gunzip(data: &[u8], limit: u64) -> Result<Vec<u8>, String> {
    if data.len() as u64 > limit {
        return Err("The file is too large".into());
    }
    if !data.starts_with(&[0x1f, 0x8b]) {
        return Err("Not a gzip file".into());
    }
    // El tamaño original (módulo 2^32) va al final del gzip: sólo como pista, acotada
    let hint = data.len().checked_sub(4).map_or(0, |p| u32::from_le_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]) as usize);
    let mut out = Vec::with_capacity(hint.min(data.len().saturating_mul(64)).min(limit as usize));
    MultiGzDecoder::new(data).take(limit + 1).read_to_end(&mut out).map_err(|e| format!("Invalid gzip data ({e})"))?;
    if out.len() as u64 > limit {
        return Err(format!("The saved scan is too large (more than {} MiB uncompressed)", limit >> 20));
    }
    Ok(out)
}

/// Número JSON (o booleano: true = 1) como f64.
struct Num(f64);

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = Num;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a number")
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Num, E> {
                Ok(Num(v))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Num, E> {
                Ok(Num(v as f64))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Num, E> {
                Ok(Num(v as f64))
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Num, E> {
                Ok(Num(f64::from(u8::from(v))))
            }
        }
        d.deserialize_any(V)
    }
}

/// Entero no negativo (con decimales, se trunca; negativos, NaN o infinitos → 0).
fn uint(x: f64) -> u64 {
    if x.is_finite() && x > 0.0 {
        x as u64
    } else {
        0
    }
}

/// WTF-8 bien formado: UTF-8 que admite suplentes sueltos (ED A0..BF 80..BF).
fn valid_wtf8(mut b: &[u8]) -> bool {
    loop {
        match std::str::from_utf8(b) {
            Ok(_) => return true,
            Err(e) => {
                let rest = &b[e.valid_up_to()..];
                if rest.len() >= 3 && rest[0] == 0xED && (0xA0..=0xBF).contains(&rest[1]) && (0x80..=0xBF).contains(&rest[2]) {
                    b = &rest[3..];
                } else {
                    return false;
                }
            }
        }
    }
}

/// Nombre de un nodo: se añade, en WTF-8, al bloque de nombres (serde_json da los suplentes sueltos
/// de `\udXXX` en WTF-8 al leerlos como bytes).
struct NameSeed<'a>(&'a mut Vec<u8>);

impl<'de> DeserializeSeed<'de> for NameSeed<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_bytes(self)
    }
}

impl<'de> Visitor<'de> for NameSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a name")
    }
    fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<(), E> {
        self.0.extend_from_slice(v);
        Ok(())
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<(), E> {
        self.visit_bytes(v.as_bytes())
    }
}

/// Un nodo `[parent, name, isDir, size, alloc, files, dirs, mtime, flags]` → una entrada de `raw` (los
/// índices del archivo son los ids en bruto). `flags` puede faltar (0) y lo que sobre se ignora.
struct NodeSeed<'a> {
    raw: &'a mut RawTree,
    i: usize,
}

impl<'de> DeserializeSeed<'de> for NodeSeed<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for NodeSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a node array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let (raw, i) = (self.raw, self.i);
        let missing = || <A::Error as de::Error>::custom(format!("Incomplete node {i}"));
        let num = |x: Option<Num>| x.map(|n| n.0).ok_or_else(missing);
        let parent = num(seq.next_element()?)?;
        let parent = if i == 0 {
            if parent >= 0.0 {
                return Err(de::Error::custom("The first node must be the root"));
            }
            NONE
        } else if parent >= 0.0 && parent < i as f64 && parent.fract() == 0.0 && raw.flags[parent as usize] & flag::DIR != 0 {
            parent as u32
        } else {
            return Err(de::Error::custom(format!("Invalid parent in node {i}")));
        };
        let off = raw.names.len();
        seq.next_element_seed(NameSeed(&mut raw.names))?.ok_or_else(missing)?;
        let len = raw.names.len() - off;
        if len > u16::MAX as usize || !valid_wtf8(&raw.names[off..]) {
            return Err(de::Error::custom(format!("Invalid name in node {i}")));
        }
        let dir = num(seq.next_element()?)? != 0.0;
        let size = uint(num(seq.next_element()?)?);
        let alloc = uint(num(seq.next_element()?)?);
        // files y dirs: al construir el árbol se recalculan
        seq.next_element::<IgnoredAny>()?.ok_or_else(missing)?;
        seq.next_element::<IgnoredAny>()?.ok_or_else(missing)?;
        let mtime = uint(num(seq.next_element()?)?).min(u32::MAX as u64) as u32;
        let flags = seq.next_element::<Num>()?.map_or(0, |n| (uint(n.0) & PUBLIC as u64) as u16);
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        if i == 0 {
            if !dir {
                return Err(de::Error::custom("The root must be a folder"));
            }
            // La raíz se llama como su ruta (`path`)
            raw.names.truncate(off);
        }
        raw.parent.push(parent);
        raw.size.push(size);
        raw.alloc.push(alloc);
        raw.mtime.push(mtime);
        raw.flags.push(if dir { flags | flag::DIR } else { flags & !flag::DIR });
        raw.name_off.push(off as u32);
        raw.name_len.push((raw.names.len() - off) as u16);
        if raw.names.len() > u32::MAX as usize {
            return Err(de::Error::custom("Too many names"));
        }
        Ok(())
    }
}

/// `nodes`: todos los nodos, en preorden.
struct NodesSeed<'a>(&'a mut RawTree);

impl<'de> DeserializeSeed<'de> for NodesSeed<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for NodesSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of nodes")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let raw = self.0;
        let mut i = 0;
        while seq.next_element_seed(NodeSeed { raw: &mut *raw, i })?.is_some() {
            i += 1;
            if i > MAX_NODES {
                return Err(de::Error::custom(format!("Too many nodes (more than {MAX_NODES})")));
            }
        }
        Ok(())
    }
}

/// Cabecera y nodos de un `.tessera`.
#[derive(Default)]
struct Parsed {
    v: Option<f64>,
    kind: bool,
    app: Option<String>,
    host: Option<String>,
    path: Option<String>,
    scanned_at: u64,
    engine: Option<Engine>,
    volume: Option<VolumeInfo>,
    raw: RawTree,
}

struct FileSeed<'a>(&'a mut Parsed);

impl<'de> DeserializeSeed<'de> for FileSeed<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for FileSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a TesseraFS saved scan")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let p = self.0;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                // La versión y el tipo se comprueban en cuanto llegan (antes que los nodos)
                "v" => {
                    let v = map.next_value::<Num>()?.0;
                    if v != f64::from(VERSION) {
                        return Err(de::Error::custom(format!("Unsupported version {v}")));
                    }
                    p.v = Some(v);
                }
                "kind" => {
                    if map.next_value::<String>()? != KIND {
                        return Err(de::Error::custom("Not a TesseraFS saved scan"));
                    }
                    p.kind = true;
                }
                // Lo opcional que no tiene la forma esperada se ignora (como en el motor Bun)
                "app" => p.app = text(map.next_value()?),
                "host" => p.host = text(map.next_value()?),
                "path" => p.path = map.next_value()?,
                "scannedAt" => p.scanned_at = map.next_value::<serde_json::Value>()?.as_f64().map_or(0, uint),
                "engine" => p.engine = Some(if map.next_value::<serde_json::Value>()? == "mft" { Engine::Mft } else { Engine::Walk }),
                // Un `volume` que no se entiende se queda sin volumen
                "volume" => p.volume = map.next_value::<Option<serde_json::Value>>()?.and_then(|v| serde_json::from_value(v).ok()),
                "nodes" => map.next_value_seed(NodesSeed(&mut p.raw))?,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(())
    }
}

/// Texto no vacío.
fn text(v: serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// Lee y valida el JSON de un `.tessera`.
fn parse(json: &[u8]) -> Result<Parsed, String> {
    let mut p = Parsed::default();
    let mut de = serde_json::Deserializer::from_slice(json);
    FileSeed(&mut p).deserialize(&mut de).and_then(|()| de.end()).map_err(|e| e.to_string())?;
    if !p.kind || p.v.is_none() {
        return Err("Not a TesseraFS saved scan".into());
    }
    if p.path.as_deref().is_none_or(str::is_empty) {
        return Err("Missing the scanned path".into());
    }
    if p.raw.is_empty() {
        return Err("The saved scan has no nodes".into());
    }
    Ok(p)
}

/// Abre un `.tessera` (el contenido del archivo) y devuelve su escaneo, «sin conexión»: `engine` y
/// `volume` los guardados, `elapsedMs` lo que tardó en abrirse, sin avisos ni `refresh`, con
/// `offline: {scannedAt, host, app}`. Errores: `scan.openFailed` con un texto breve en inglés (gzip o
/// JSON rotos, otra versión u otro tipo, nodos inconsistentes, más de [`MAX_BYTES`] o [`MAX_NODES`]).
pub fn open_scan(data: &[u8]) -> Result<Scan, EngineMessage> {
    let t0 = Instant::now();
    let fail = |e: String| msg::scan_open_failed(&e);
    let json = gunzip(data, MAX_BYTES).map_err(fail)?;
    let p = parse(&json).map_err(fail)?;
    drop(json);
    let path = p.path.unwrap_or_default();
    let mut raw = p.raw;
    raw.root = 0;
    let tree = build(raw, path.clone(), &[]).map_err(fail)?;
    let (files, dirs) = (tree.files(0) as u64, tree.dirs(0) as u64);
    let result = ScanResult {
        root_id: 0,
        root_path: path,
        engine: p.engine.unwrap_or(Engine::Walk),
        entries: files + dirs,
        files,
        dirs,
        bytes: tree.size(0),
        elapsed_ms: t0.elapsed().as_millis() as u64,
        volume: p.volume,
        warnings: Vec::new(),
        can_refresh: Some(false),
        offline: Some(SavedScanInfo { scanned_at: p.scanned_at, host: p.host, app: p.app }),
    };
    Ok(Scan { tree, result, scanned_at: p.scanned_at, usn: None, serial: next_serial() })
}

/// [`open_scan`] de un archivo (`scan.openFailed` si no se puede leer).
pub fn open_file(path: &std::path::Path) -> Result<Scan, EngineMessage> {
    let len = std::fs::metadata(path).map_err(|e| msg::scan_open_failed(&crate::sys::io_error_text(&e)))?.len();
    if len > MAX_BYTES {
        return Err(msg::scan_open_failed("The file is too large"));
    }
    let data = std::fs::read(path).map_err(|e| msg::scan_open_failed(&crate::sys::io_error_text(&e)))?;
    open_scan(&data)
}

/// La ruta es un `.tessera` que existe (para la línea de comandos: se abre en vez de escanear).
pub fn is_saved_scan(path: &str) -> bool {
    let p = std::path::Path::new(path.trim().trim_matches('"'));
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case(EXT)) && p.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gz(json: &str) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::fast());
        e.write_all(json.as_bytes()).unwrap();
        e.finish().unwrap()
    }

    fn open(json: &str) -> Result<Scan, String> {
        open_scan(&gz(json)).map_err(|e| {
            assert_eq!(e.code, "scan.openFailed");
            e.get("error").map(|p| p.to_string()).unwrap_or_default()
        })
    }

    const HEAD: &str = r#"{"v":1,"kind":"tesserafs-scan","path":"C:\\D","scannedAt":5,"engine":"mft","volume":null,"nodes":"#;

    #[test]
    fn labels_and_names() {
        assert_eq!(root_label("C:\\"), "C");
        assert_eq!(root_label("d:\\"), "D");
        assert_eq!(root_label("C:\\Users\\Ana"), "Ana");
        assert_eq!(root_label("\\\\srv\\share"), "share");
        assert_eq!(root_label("/"), "raiz");
        assert_eq!(root_label("/home/ana/"), "ana");
        assert_eq!(root_label("/srv/a:b*?\"<>|. "), "a_b______");
        assert_eq!(root_label("/srv/..."), "raiz");
        assert_eq!(root_label(&format!("/x/{}", "😀".repeat(60))).chars().count(), 50);
        let n = file_name("C:\\", 1_791_700_000);
        assert!(n.starts_with("C 2026-1") && n.ends_with(".tessera") && n.len() == "C 2026-10-11 1234.tessera".len(), "{n}");
        assert!(export::valid_name(&n));
        assert!(export::valid_name(&file_name(&format!("/x/{}", "a".repeat(300)), 0)));
    }

    #[test]
    fn wtf8_names() {
        assert!(valid_wtf8(b"abc") && valid_wtf8("ñ😀".as_bytes()));
        assert!(valid_wtf8(&[b'a', 0xED, 0xA0, 0x80, b'b']));
        assert!(!valid_wtf8(&[0xFF]) && !valid_wtf8(&[0xED, 0xA0]) && !valid_wtf8(&[0xC3]));
        let mut w = Vec::new();
        write_name(&mut w, &[b'a', b'"', 0xED, 0xA0, 0x80, b'\n']).unwrap();
        assert_eq!(String::from_utf8(w).unwrap(), r#""a\"\ud800\n""#);
    }

    #[test]
    fn reads_minimal_and_rejects_broken() {
        let s = open(&format!("{HEAD}[[-1,\"C:\\\\D\",1,0,0,0,0,7,1],[0,\"a.TXT\",0,5,8,0,0,9,2],[0,\"s\",1,99,99,9,9,3,0],[2,\"x\",0,7,8,0,0,1]]}}")).unwrap();
        let t = &s.tree;
        assert_eq!((t.root_path(), t.len(), t.size(0), t.alloc(0), t.files(0), t.dirs(0), t.mtime(0)), ("C:\\D", 4, 12, 16, 2, 1, 7));
        assert_eq!(s.result.engine, Engine::Mft);
        assert_eq!((s.scanned_at, s.result.can_refresh, s.offline().map(|o| o.scanned_at)), (5, Some(false), Some(5)));
        // La carpeta toma el tamaño de lo que contiene (7), no el guardado (99); flags opcionales
        let sub = (0..4).find(|&i| t.name(i) == "s").unwrap();
        assert_eq!((t.size(sub), t.files(sub), t.dirs(sub)), (7, 1, 0));
        let a = (0..4).find(|&i| t.name(i) == "a.TXT").unwrap();
        assert_eq!((t.ext(a), t.flags(a), t.mtime(a)), ("txt", flag::HIDDEN, 9));
        assert_eq!(s.check_online().unwrap_err().code, "scan.offline");
        // Lo opcional con otra forma se ignora; claves desconocidas y columnas de más, también
        let s = open(r#"{"nodes":[[-1,"x",1,0,0,0,0,0,0,"futuro"]],"v":1,"kind":"tesserafs-scan","app":5,"host":null,"path":"/srv","scannedAt":"ayer","engine":"fts","volume":{"path":1},"otra":[1]}"#).unwrap();
        assert_eq!((s.result.offline.clone().unwrap(), s.result.engine, s.result.volume.is_none()), (SavedScanInfo { scanned_at: 0, host: None, app: None }, Engine::Walk, true));
        assert_eq!((s.tree.root_path(), s.tree.len(), s.tree.flags(0)), ("/srv", 1, flag::DIR));
        let v = r#"{"path":"C:\\","label":"Sistema","fs":"NTFS","total":100,"free":40,"clusterSize":4096}"#;
        let s = open(&format!(r#"{{"v":1,"kind":"tesserafs-scan","app":"0.11.0","host":"NAS","path":"C:\\","scannedAt":7.9,"engine":"mft","volume":{v},"nodes":[[-1,"C:\\",1,0,0,0,0,0,0]]}}"#)).unwrap();
        assert_eq!(serde_json::to_string(&s.result.volume).unwrap(), v);
        assert_eq!(s.result.offline.unwrap(), SavedScanInfo { scanned_at: 7, host: Some("NAS".into()), app: Some("0.11.0".into()) });
        // Lo que no se puede abrir
        let cases: [(Vec<u8>, &str); 4] = [
            (b"not gzip".to_vec(), "Not a gzip file"),
            (gz("{").into_iter().take(10).collect(), "Invalid gzip data"),
            (gz("[1,2]"), "invalid type"),
            (gz("{\"v\":1"), "EOF"),
        ];
        for (data, why) in cases {
            let e = open_scan(&data).err().unwrap();
            assert_eq!(e.code, "scan.openFailed");
            assert!(e.message.contains(why), "{why}: {}", e.message);
        }
        let node = "[[-1,\"C:\\\\D\",1,0,0,0,0,0,0]]";
        for (json, why) in [
            (format!("{{\"v\":2,\"kind\":\"tesserafs-scan\",\"nodes\":{node}}}"), "Unsupported version 2"),
            (format!("{{\"v\":1,\"kind\":\"otro\",\"nodes\":{node}}}"), "Not a TesseraFS saved scan"),
            (format!("{{\"v\":1,\"path\":\"C:\\\\D\",\"scannedAt\":1,\"nodes\":{node}}}"), "Not a TesseraFS saved scan"),
            (format!("{{\"v\":1,\"kind\":\"tesserafs-scan\",\"nodes\":{node}}}"), "Missing the scanned path"),
            (format!("{HEAD}[]}}"), "no nodes"),
            (format!("{HEAD}[[0,\"x\",1,0,0,0,0,0,0]]}}"), "The first node must be the root"),
            (format!("{HEAD}[[-1,\"x\",0,0,0,0,0,0,0]]}}"), "The root must be a folder"),
            (format!("{HEAD}[[-1,\"x\",1,0,0,0,0,0,0],[1,\"y\",0,0,0,0,0,0,0]]}}"), "Invalid parent in node 1"),
            (format!("{HEAD}[[-1,\"x\",1,0,0,0,0,0,0],[0,\"y\",0,0,0,0,0,0,0],[1,\"z\",0,0,0,0,0,0,0]]}}"), "Invalid parent in node 2"),
            (format!("{HEAD}[[-1,\"x\",1,0,0,0,0,0,0],[0.5,\"y\",0,0,0,0,0,0,0]]}}"), "Invalid parent in node 1"),
            (format!("{HEAD}[[-1,\"x\",1,0,0,0,0,0,0],[7,\"y\",0,0,0,0,0,0,0]]}}"), "Invalid parent in node 1"),
            (format!("{HEAD}[[-1,\"x\",1,0,0,0,0,0,0],[0,\"y\",0,0,0]]}}"), "Incomplete node 1"),
            (format!("{HEAD}[[-1,\"x\",1,0,0,0,0,0,0],[0,5,0,0,0,0,0,0,0]]}}"), "invalid type"),
            (format!("{HEAD}{node}}} x"), "trailing characters"),
        ] {
            let e = open(&json).err().unwrap_or_else(|| panic!("se abrió: {json}"));
            assert!(e.contains(why), "{why}: {e}");
        }
        // Bomba gzip: lo que pasa del límite no llega a memoria (aquí con 1 MiB en vez de 1 GiB)
        let mut e = GzEncoder::new(Vec::new(), Compression::best());
        e.write_all(&vec![b' '; 3 << 20]).unwrap();
        let bomb = e.finish().unwrap();
        assert!(bomb.len() < 64 << 10);
        assert_eq!(gunzip(&bomb, 1 << 20).unwrap_err(), "The saved scan is too large (more than 1 MiB uncompressed)");
        assert_eq!(gunzip(&bomb, 4 << 20).unwrap().len(), 3 << 20);
        assert_eq!(gunzip(&[0x1f; 100], 50).unwrap_err(), "The file is too large");
    }

    #[test]
    fn lone_surrogates_round_trip() {
        // Nombre con un suplente suelto (como lo escribe JSON.stringify) y un par bien formado
        let s = open(&format!("{HEAD}[[-1,\"C:\\\\D\",1,0,0,0,0,0,0],[0,\"a\\ud800b\\ud83d\\ude00\",0,3,4,0,0,0,0]]}}")).unwrap();
        let t = &s.tree;
        assert_eq!(t.name_bytes(1), [b'a', 0xED, 0xA0, 0x80, b'b', 0xF0, 0x9F, 0x98, 0x80]);
        assert_eq!(t.name(1), "a\u{FFFD}b😀");
        let mut out = Vec::new();
        write_scan(&mut out, &s).unwrap();
        let mut json = String::new();
        MultiGzDecoder::new(&out[..]).read_to_string(&mut json).unwrap();
        assert!(json.contains(r#"[0,"a\ud800b😀",0,3,4,0,0,0,0]"#), "{json}");
        let back = open_scan(&out).unwrap();
        assert_eq!(back.tree.name_bytes(1), t.name_bytes(1));
        // Lo que no se podría abrir (más JSON del límite) no se guarda
        let e = write_limited(Vec::new(), &s, 100).unwrap_err();
        assert_eq!(e.to_string(), "the scan is too large to save (more than 1024 MiB of data)");
        assert!(write_limited(Vec::new(), &s, json.len() as u64).is_ok());
    }
}
