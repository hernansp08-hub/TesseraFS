//! Historial de escaneos y comparación con el escaneo cargado. El formato es el mismo en las dos
//! ediciones (docs/ARQUITECTURA.md): cada resumen son dos archivos en la carpeta del historial,
//!
//! - `<id>.snap.gz`: gzip de `{"v":1,"path":…,"scannedAt":…,"nodes":[[parent,name,isDir,size,alloc,files,dirs,mtime],…]}`
//!   con todas las carpetas y los archivos de 1 MiB o más, en preorden (`nodes[0]` es la raíz, con
//!   `parent` −1 y la ruta como nombre; cada nodo va después de su padre);
//! - `<id>.json`: el [`HistoryEntry`], que se escribe después y «confirma» el resumen.
//!
//! El id es la fecha UTC del guardado (`YYYYMMDDTHHMMSSZ`) + `-` + FNV-1a de 32 bits de la ruta (UTF-8;
//! en minúsculas si es de Windows, tal cual en Linux, que distingue mayúsculas), en hex; si ya existe,
//! se añade `-2`, `-3`…

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::de::IgnoredAny;
use serde::Deserialize;

use crate::msg;
use crate::names;
use crate::scan::Scan;
use crate::sys;
use crate::tree::{Tree, NONE};
use crate::types::{ChangeRow, CompareResult, EngineMessage, HistoryEntry, RemovedRow, SearchRow, Totals};

/// Archivos que entran en el resumen (las carpetas entran todas).
pub const MIN_FILE: u64 = 1 << 20;
/// Resúmenes que se conservan de cada ruta.
pub const KEEP: usize = 20;
/// Filas máximas de cada lista de la comparación.
pub const MAX_LIMIT: u32 = 1000;

const ENTRY: &str = ".json";
const SNAP: &str = ".snap.gz";

// ---------- Comparación activa ----------

const UNKNOWN: u64 = u64::MAX;
const FRESH: u64 = u64::MAX - 1;

/// Comparación activa: por cada nodo del árbol, su tamaño en el resumen, «nuevo» o «desconocido»
/// (un archivo de menos de 1 MiB que no está en el resumen). Vive en el [`Tree`].
#[derive(Default)]
pub struct Comparison {
    state: Vec<u64>,
}

impl Comparison {
    /// Tamaño en el escaneo anterior, si se conoce.
    pub fn prev(&self, id: u32) -> Option<u64> {
        self.state.get(id as usize).copied().filter(|&p| p < FRESH)
    }

    /// No existía en el escaneo anterior.
    pub fn is_fresh(&self, id: u32) -> bool {
        self.state.get(id as usize) == Some(&FRESH)
    }

    /// Crecimiento: `size` − prev; lo nuevo cuenta entero; lo desconocido, 0.
    pub fn delta(&self, id: u32, size: u64) -> i64 {
        match self.state.get(id as usize).copied() {
            Some(FRESH) => size as i64,
            Some(p) if p < FRESH => size as i64 - p as i64,
            _ => 0,
        }
    }
}

// ---------- Identificadores ----------

/// Clave de una ruta raíz para compararla: sin barras finales ("C:\" = "c:", "/home/ana/" =
/// "/home/ana") y, si es de Windows, en minúsculas ([`names::path_key`]).
fn root_key(path: &str) -> String {
    let mut k = names::path_key(path).into_owned();
    k.truncate(k.trim_end_matches(['\\', '/']).len());
    k
}

/// FNV-1a de 32 bits de la ruta (UTF-8): en minúsculas si es de Windows, tal cual si es de Linux.
pub fn path_hash(path: &str) -> u32 {
    names::path_key(path).bytes().fold(0x811c_9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193))
}

/// Días desde 1970-01-01 → (año, mes, día) (algoritmo de H. Hinnant).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `YYYYMMDDTHHMMSSZ` (UTC).
pub fn utc_stamp(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let s = secs % 86_400;
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", s / 3600, s / 60 % 60, s % 60)
}

/// Id del resumen de `path` guardado en `secs` (sin el sufijo de colisión).
pub fn entry_id(secs: u64, path: &str) -> String {
    format!("{}-{:08x}", utc_stamp(secs), path_hash(path))
}

/// Sólo `[A-Za-z0-9-]`: nunca sale de la carpeta del historial.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Orden de guardado según el id: (fecha-hash, sufijo -2, -3… como número; 1 sin sufijo).
fn save_key(id: &str) -> (&str, u32) {
    match id.match_indices('-').nth(1) {
        Some((p, _)) => match id[p + 1..].parse() {
            Ok(n) => (&id[..p], n),
            Err(_) => (id, 1),
        },
        None => (id, 1),
    }
}

/// Archivo del historial (`YYYYMMDDTHHMMSSZ-hhhhhhhh[-n]` + `.json` o `.snap.gz`): `Some(true)` si es el `.json`.
fn history_file(name: &str) -> Option<bool> {
    let (id, json) = match name.strip_suffix(ENTRY) {
        Some(id) => (id, true),
        None => (name.strip_suffix(SNAP)?, false),
    };
    let b = id.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let ok = b.len() >= 25
        && digits(0..8)
        && b[8] == b'T'
        && digits(9..15)
        && b[15] == b'Z'
        && b[16] == b'-'
        && b[17..25].iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
        && (b.len() == 25 || (b.len() > 26 && b[25] == b'-' && digits(26..b.len())));
    ok.then_some(json)
}

/// Más reciente primero: por `scannedAt` y, a igualdad, por el momento del guardado.
fn newest_first(a: &HistoryEntry, b: &HistoryEntry) -> Ordering {
    b.scanned_at.cmp(&a.scanned_at).then_with(|| save_key(&b.id).cmp(&save_key(&a.id)))
}

fn now() -> u64 {
    crate::query::now_secs() as u64
}

// ---------- Resumen en disco ----------

#[derive(Deserialize)]
struct SnapFile {
    v: u32,
    path: String,
    nodes: Vec<SnapNode>,
}

/// `[parent, name, isDir, size, alloc, files, dirs, mtime]`; los números se leen como f64 (admite decimales).
#[derive(Deserialize)]
struct SnapNode(f64, String, f64, f64, IgnoredAny, f64, f64, IgnoredAny);

fn num(x: f64) -> u64 {
    if x.is_finite() && x > 0.0 {
        x as u64
    } else {
        0
    }
}

impl SnapNode {
    fn parent(&self) -> usize {
        self.0 as usize
    }
    fn name(&self) -> &str {
        &self.1
    }
    fn is_dir(&self) -> bool {
        self.2 != 0.0
    }
    fn size(&self) -> u64 {
        num(self.3)
    }
    fn totals(&self) -> Totals {
        Totals { bytes: self.size(), files: num(self.5), dirs: num(self.6) }
    }
}

/// Escribe el resumen del árbol en `file` (gzip). Devuelve los nodos guardados.
fn write_snapshot(file: File, t: &Tree, scanned_at: u64) -> io::Result<u64> {
    let mut w = BufWriter::with_capacity(1 << 16, GzEncoder::new(file, Compression::fast()));
    w.write_all(b"{\"v\":1,\"path\":")?;
    serde_json::to_writer(&mut w, t.root_path())?;
    write!(w, ",\"scannedAt\":{scanned_at},\"nodes\":[")?;
    let mut n = 0u64;
    // Preorden: (id en el árbol, índice del padre en `nodes`)
    let mut stack: Vec<(u32, i64)> = vec![(0, -1)];
    while let Some((id, parent)) = stack.pop() {
        if n > 0 {
            w.write_all(b",")?;
        }
        write!(w, "[{parent},")?;
        serde_json::to_writer(&mut w, &*t.name(id))?;
        let dir = t.is_dir(id);
        write!(w, ",{},{},{},{},{},{}]", u8::from(dir), t.size(id), t.alloc(id), t.files(id), t.dirs(id), t.mtime(id))?;
        let me = n as i64;
        n += 1;
        if dir {
            let kids = t.kids(id);
            for i in (0..kids.len()).rev() {
                let k = kids.get(i);
                if t.is_dir(k) || t.size(k) >= MIN_FILE {
                    stack.push((k, me));
                }
            }
        }
    }
    w.write_all(b"]}")?;
    w.into_inner().map_err(|e| e.into_error())?.finish()?;
    Ok(n)
}

/// Lee y valida un `.snap.gz` (cada nodo después de su padre, que es una carpeta).
fn read_snapshot(file: File) -> Result<SnapFile, String> {
    let mut raw = Vec::new();
    MultiGzDecoder::new(BufReader::new(file)).read_to_end(&mut raw).map_err(|e| sys::io_error_text(&e))?;
    let snap: SnapFile = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if snap.v != 1 {
        return Err(format!("Unsupported snapshot version {}", snap.v));
    }
    let Some(root) = snap.nodes.first() else { return Err("Empty snapshot".into()) };
    if root.0 >= 0.0 || !root.is_dir() {
        return Err("Invalid snapshot root".into());
    }
    for (i, node) in snap.nodes.iter().enumerate().skip(1) {
        let p = node.0;
        if !(p >= 0.0 && p < i as f64 && p.fract() == 0.0 && snap.nodes[p as usize].is_dir()) {
            return Err(format!("Invalid parent in snapshot node {i}"));
        }
    }
    Ok(snap)
}

/// Ruta completa de un nodo del resumen (el nombre de la raíz es su ruta).
fn snap_path(nodes: &[SnapNode], mut i: usize) -> String {
    let mut chain = Vec::new();
    while i != 0 {
        chain.push(nodes[i].name());
        i = nodes[i].parent();
    }
    let mut s = nodes[0].name().to_string();
    let sep = names::sep_of(&s);
    for name in chain.into_iter().rev() {
        if !s.ends_with(sep) {
            s.push(sep);
        }
        s.push_str(name);
    }
    s
}

// ---------- Carpeta del historial ----------

/// La carpeta del historial y sus operaciones.
pub struct History {
    dir: PathBuf,
}

impl History {
    /// `TESSERA_HISTORY_DIR` si está definida; si no, `%LOCALAPPDATA%\TesseraFS\history` en Windows y
    /// `$XDG_DATA_HOME/TesseraFS/history` (o `~/.local/share/TesseraFS/history`) en Linux.
    pub fn open() -> Result<History, EngineMessage> {
        let dir = match std::env::var_os("TESSERA_HISTORY_DIR").filter(|d| !d.is_empty()) {
            Some(d) => PathBuf::from(d),
            None => sys::local_app_data()
                .ok_or_else(|| msg::internal("Local application data folder not found"))?
                .join("TesseraFS")
                .join("history"),
        };
        Ok(History { dir })
    }

    pub fn at(dir: impl Into<PathBuf>) -> History {
        History { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file(&self, id: &str, ext: &str) -> PathBuf {
        self.dir.join(format!("{id}{ext}"))
    }

    /// Guarda el escaneo (sin lo enviado a la papelera) y deja los [`KEEP`] más recientes de su ruta.
    pub fn save(&self, scan: &Scan) -> Result<HistoryEntry, EngineMessage> {
        let fail = |e: io::Error| msg::history_save_failed(&sys::io_error_text(&e));
        fs::create_dir_all(&self.dir).map_err(fail)?;
        let t = &scan.tree;
        let path = t.root_path().to_string();
        let (id, file) = self.create_snap(&entry_id(now(), &path)).map_err(fail)?;
        let snap = self.file(&id, SNAP);
        let written = write_snapshot(file, t, scan.scanned_at).and_then(|n| Ok((n, fs::metadata(&snap)?.len())));
        let (nodes, file_bytes) = written.map_err(|e| {
            let _ = fs::remove_file(&snap);
            fail(e)
        })?;
        let entry = HistoryEntry {
            id,
            path,
            scanned_at: scan.scanned_at,
            engine: scan.result.engine,
            bytes: t.size(0),
            files: t.files(0) as u64,
            dirs: t.dirs(0) as u64,
            nodes,
            file_bytes,
        };
        let json = self.file(&entry.id, ENTRY);
        if let Err(e) = serde_json::to_vec(&entry).map_err(io::Error::from).and_then(|b| fs::write(&json, b)) {
            let _ = fs::remove_file(&json);
            let _ = fs::remove_file(&snap);
            return Err(fail(e));
        }
        self.prune(&entry.path);
        Ok(entry)
    }

    /// Crea en exclusiva `<id>.snap.gz` con el primer id libre: `base`, `base-2`, `base-3`…
    fn create_snap(&self, base: &str) -> io::Result<(String, File)> {
        let mut n = 1u32;
        loop {
            let id = if n == 1 { base.to_string() } else { format!("{base}-{n}") };
            n += 1;
            if self.file(&id, ENTRY).exists() {
                continue;
            }
            match OpenOptions::new().write(true).create_new(true).open(self.file(&id, SNAP)) {
                Ok(f) => return Ok((id, f)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
    }

    /// Retención: de los resúmenes de `path` (en Windows, sin distinguir mayúsculas) deja los [`KEEP`]
    /// más recientes.
    fn prune(&self, path: &str) {
        let Ok(all) = self.list() else { return };
        let key = root_key(path);
        for e in all.iter().filter(|e| root_key(&e.path) == key).skip(KEEP) {
            let _ = self.delete(&e.id);
        }
    }

    /// Todos los resúmenes, el más reciente primero. Ignora los `.json` que no se pueden leer o
    /// no tienen su `.snap.gz`.
    pub fn list(&self) -> Result<Vec<HistoryEntry>, EngineMessage> {
        let rd = match fs::read_dir(&self.dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(msg::history_read_failed(&sys::io_error_text(&e))),
        };
        let mut v: Vec<HistoryEntry> = rd
            .flatten()
            .filter_map(|f| {
                let name = f.file_name().into_string().ok()?;
                let id = name.strip_suffix(ENTRY)?;
                if !valid_id(id) || !self.file(id, SNAP).is_file() {
                    return None;
                }
                let e: HistoryEntry = serde_json::from_slice(&fs::read(f.path()).ok()?).ok()?;
                (e.id == id).then_some(e)
            })
            .collect();
        v.sort_by(newest_first);
        Ok(v)
    }

    /// Borra un resumen (los dos archivos). True si existía.
    pub fn delete(&self, id: &str) -> Result<bool, EngineMessage> {
        if !valid_id(id) {
            return Err(msg::history_not_found(id));
        }
        let mut existed = false;
        for ext in [ENTRY, SNAP] {
            match fs::remove_file(self.file(id, ext)) {
                Ok(()) => existed = true,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(msg::history_save_failed(&sys::io_error_text(&e))),
            }
        }
        Ok(existed)
    }

    /// Borra todo el historial: los archivos con nombre de resumen (también los sueltos o dañados) y
    /// nada más de la carpeta. Devuelve cuántos resúmenes (`.json`) borró.
    pub fn clear(&self) -> Result<u64, EngineMessage> {
        let rd = match fs::read_dir(&self.dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(msg::history_read_failed(&sys::io_error_text(&e))),
        };
        let mut n = 0;
        for f in rd.flatten() {
            let Some(json) = f.file_name().to_str().and_then(history_file) else { continue };
            // Si está en uso, se queda
            if fs::remove_file(f.path()).is_ok() && json {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Compara el escaneo cargado con un resumen de la misma ruta y deja la comparación activa en
    /// el árbol (filas con `prev`/`fresh` y orden `delta`) hasta quitarla o cargar otro escaneo.
    /// `history.notFound` si no está; `history.readFailed` si está dañado; `history.otherRoot` si es de otra ruta.
    pub fn compare(&self, scan: &Scan, id: &str, limit: u32) -> Result<CompareResult, EngineMessage> {
        if !valid_id(id) || !self.file(id, ENTRY).is_file() || !self.file(id, SNAP).is_file() {
            return Err(msg::history_not_found(id));
        }
        let io_failed = |e: io::Error| msg::history_read_failed(&sys::io_error_text(&e));
        let json = fs::read(self.file(id, ENTRY)).map_err(io_failed)?;
        let entry: HistoryEntry = serde_json::from_slice(&json).map_err(|e| msg::history_read_failed(&e.to_string()))?;
        let t = &scan.tree;
        let root = root_key(t.root_path());
        if root_key(&entry.path) != root {
            return Err(msg::history_other_root(&entry.path));
        }
        let snap = read_snapshot(File::open(self.file(id, SNAP)).map_err(io_failed)?).map_err(|e| msg::history_read_failed(&e))?;
        if root_key(&snap.path) != root {
            return Err(msg::history_other_root(&snap.path));
        }
        let limit = limit.clamp(1, MAX_LIMIT) as usize;
        let nodes = &snap.nodes;
        let matched = match_nodes(t, nodes);
        let c = Arc::new(build_comparison(t, nodes, &matched));
        t.set_comparison(Some(c.clone()));
        let (grew, shrank) = changes(t, &c, limit);
        let gone: Vec<(u64, usize)> = (1..nodes.len())
            .filter(|&i| matched[i] == NONE && matched[nodes[i].parent()] != NONE)
            .map(|i| (nodes[i].size(), i))
            .collect();
        let removed = top_by(gone, limit, |i| snap_path(nodes, i))
            .into_iter()
            .map(|(size, i, path)| RemovedRow { path, is_dir: nodes[i].is_dir(), size })
            .collect();
        Ok(CompareResult {
            before: nodes[0].totals(),
            after: Totals { bytes: t.size(0), files: t.files(0) as u64, dirs: t.dirs(0) as u64 },
            entry,
            grew,
            shrank,
            removed,
        })
    }
}

// ---------- Comparación ----------

/// Clave de emparejamiento: tipo + nombre (en minúsculas con `fold`).
fn match_key(out: &mut String, dir: bool, name: &str, fold: bool) {
    out.clear();
    out.push(if dir { '/' } else { '|' });
    if fold {
        names::lower_into(out, name);
    } else {
        out.push_str(name);
    }
}

/// Empareja cada nodo del resumen con uno del árbol (o [`NONE`]): raíz con raíz y, bajando, cada hijo
/// de una carpeta emparejada con el hijo actual del mismo nombre (sin mayúsculas en Windows; exacto en
/// Linux, que las distingue) y tipo. El índice (nombre → nodo) se crea sólo para las carpetas
/// emparejadas que tienen hijos guardados, y de los hijos actuales sólo se miran los del tipo que falta
/// (casi nunca hay que mirar los archivos pequeños).
fn match_nodes(t: &Tree, nodes: &[SnapNode]) -> Vec<u32> {
    const END: u32 = u32::MAX;
    let n = nodes.len();
    let fold = !names::is_posix(t.root_path());
    // Hijos de cada nodo del resumen: primer hijo y siguiente hermano (en orden del resumen)
    let (mut first, mut next) = (vec![END; n], vec![END; n]);
    for i in (1..n).rev() {
        let p = nodes[i].parent();
        next[i] = first[p];
        first[p] = i as u32;
    }
    // Repetidos con la misma clave (carpetas que distinguen mayúsculas): se emparejan por orden
    let mut same = vec![END; n];
    let mut m = vec![NONE; n];
    m[0] = 0;
    let mut stack = vec![0usize];
    let mut index: HashMap<String, u32> = HashMap::new();
    let (mut key, mut ch) = (String::new(), Vec::new());
    while let Some(s) = stack.pop() {
        if first[s] == END {
            continue;
        }
        ch.clear();
        let mut c = first[s];
        while c != END {
            ch.push(c);
            c = next[c as usize];
        }
        index.clear();
        let (mut want_dirs, mut want_files) = (0usize, 0usize);
        for &c in ch.iter().rev() {
            let node = &nodes[c as usize];
            if node.is_dir() {
                want_dirs += 1;
            } else {
                want_files += 1;
            }
            match_key(&mut key, node.is_dir(), node.name(), fold);
            same[c as usize] = index.insert(key.clone(), c).unwrap_or(END);
        }
        let kids = t.kids(m[s]);
        for i in 0..kids.len() {
            if want_dirs == 0 && want_files == 0 {
                break;
            }
            let k = kids.get(i);
            let dir = t.is_dir(k);
            if if dir { want_dirs == 0 } else { want_files == 0 } {
                continue;
            }
            match_key(&mut key, dir, &t.name(k), fold);
            let Some(head) = index.get_mut(key.as_str()) else { continue };
            let c = *head as usize;
            if same[c] == END {
                index.remove(key.as_str());
            } else {
                *head = same[c];
            }
            m[c] = k;
            if dir {
                want_dirs -= 1;
                stack.push(c);
            } else {
                want_files -= 1;
            }
        }
    }
    m
}

/// prev de lo emparejado; «nuevo» lo no emparejado que es carpeta, archivo de 1 MiB o más o está
/// dentro de algo nuevo; el resto (archivos pequeños), desconocido.
fn build_comparison(t: &Tree, nodes: &[SnapNode], matched: &[u32]) -> Comparison {
    let mut state = vec![UNKNOWN; t.len()];
    for (i, &k) in matched.iter().enumerate() {
        if k != NONE {
            state[k as usize] = nodes[i].size();
        }
    }
    // Los ids van por niveles: el padre se decide antes que sus hijos
    for id in 1..t.len() {
        if state[id] == UNKNOWN {
            let parent_fresh = state[t.parent[id] as usize] == FRESH;
            if parent_fresh || t.is_dir(id as u32) || t.size(id as u32) >= MIN_FILE {
                state[id] = FRESH;
            }
        }
    }
    Comparison { state }
}

/// Lo que creció y lo que se redujo sin que un solo hijo explique el 75 % o más del cambio.
fn changes(t: &Tree, c: &Comparison, limit: usize) -> (Vec<ChangeRow>, Vec<ChangeRow>) {
    let delta = |id: u32| i128::from(c.delta(id, t.size(id)));
    let mut up: Vec<(i128, usize)> = Vec::new();
    let mut down = Vec::new();
    let mut stack = vec![0u32];
    while let Some(id) = stack.pop() {
        // El hijo que más crece y el que más se reduce (0 si no hay ninguno: no cambia la regla)
        let (mut hi, mut lo) = (0i128, 0i128);
        let kids = t.kids(id);
        for i in 0..kids.len() {
            let k = kids.get(i);
            let d = delta(k);
            hi = hi.max(d);
            lo = lo.min(d);
            stack.push(k);
        }
        if id == 0 {
            continue;
        }
        let d = delta(id);
        if d > 0 && 4 * hi < 3 * d {
            up.push((d, id as usize));
        } else if d < 0 && 4 * lo > 3 * d {
            down.push((-d, id as usize));
        }
    }
    let rows = |v: Vec<(i128, usize)>| -> Vec<ChangeRow> {
        top_by(v, limit, |i| t.path(i as u32))
            .into_iter()
            .map(|(_, i, path)| {
                let mut node = t.row(i as u32);
                let prev = node.prev.take();
                ChangeRow { row: SearchRow { node, path }, prev }
            })
            .collect()
    };
    (rows(up), rows(down))
}

/// Los `limit` primeros por `key` desc, desempate por ruta (orden de texto, como el motor Bun). Las
/// rutas se calculan sólo para los que pueden entrar (los que superan el corte y los empatados con él).
fn top_by<K: Ord + Copy>(mut v: Vec<(K, usize)>, limit: usize, path: impl Fn(usize) -> String) -> Vec<(K, usize, String)> {
    v.sort_unstable_by_key(|a| std::cmp::Reverse(a.0));
    if v.len() > limit {
        let cut = v[limit - 1].0;
        let end = v.partition_point(|x| x.0 >= cut);
        v.truncate(end);
    }
    let mut out: Vec<(K, usize, String)> = v.into_iter().map(|(k, i)| (k, i, path(i))).collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.2.cmp(&b.2)));
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(utc_stamp(0), "19700101T000000Z");
        assert_eq!(utc_stamp(951_782_400), "20000229T000000Z");
        assert_eq!(utc_stamp(1_791_654_312), "20261010T174512Z");
        // FNV-1a de 32 bits: vectores conocidos y la ruta en minúsculas
        assert_eq!(path_hash(""), 0x811c_9dc5);
        assert_eq!(path_hash("a"), 0xe40c_292c);
        assert_eq!(path_hash("foobar"), 0xbf9c_f968);
        assert_eq!(path_hash("C:\\Users"), path_hash("c:\\users"));
        assert_eq!(root_key("C:\\"), root_key("c:"));
        assert_eq!(root_key("C:\\Data\\"), "c:\\data");
        assert_eq!(entry_id(1_791_654_312, "C:\\"), format!("20261010T174512Z-{:08x}", path_hash("c:\\")));
        assert_eq!(entry_id(0, "C:\\").len(), 25);
        assert!(valid_id("20261010T174512Z-1a2b3c4d-2"));
        assert!(!valid_id("") && !valid_id("..\\x") && !valid_id("a.json") && !valid_id("a b"));
        // El sufijo -10 va después del -9 aunque como texto sea menor
        assert!(save_key("20261010T174512Z-1a2b3c4d-10") > save_key("20261010T174512Z-1a2b3c4d-9"));
        assert!(save_key("20261010T174512Z-1a2b3c4d-2") > save_key("20261010T174512Z-1a2b3c4d"));
        assert!(save_key("20261010T174513Z-1a2b3c4d") > save_key("20261010T174512Z-1a2b3c4d-5"));
        // Archivos que borra `clear`
        assert_eq!(history_file("20261010T174512Z-1a2b3c4d.json"), Some(true));
        assert_eq!(history_file("20261010T174512Z-1a2b3c4d-12.snap.gz"), Some(false));
        for bad in ["20261010T174512Z-1A2B3C4D.json", "20261010T174512Z-1a2b3c4d-.json", "20261010T174512Z-1a2b3c4d-x.json", "notas.json", "20261010T174512Z-1a2b3c4d.txt"] {
            assert_eq!(history_file(bad), None, "{bad}");
        }
    }

    fn sample_scan() -> Scan {
        use crate::build::{build, RawTree};
        use crate::types::{flag, Engine, ScanResult};
        let mut r = RawTree::with_capacity(8);
        let root = r.push(NONE, b"", 0, 0, 1, flag::DIR);
        r.push(root, b"small.txt", 100, 4096, 2, 0);
        r.push(root, b"big.bin", 2 << 20, 2 << 20, 3, 0);
        let sub = r.push(root, b"Sub", 0, 0, 4, flag::DIR);
        r.push(sub, "Ñandú 😀.bin".as_bytes(), 1 << 20, 1 << 20, 5, 0);
        r.push(sub, b"tiny", 5, 4096, 6, 0);
        r.push(root, b"empty", 0, 0, 7, flag::DIR);
        r.root = root;
        let tree = build(r, "C:\\Data".into(), &[]).unwrap();
        let result = ScanResult {
            root_id: 0,
            root_path: "C:\\Data".into(),
            engine: Engine::Walk,
            entries: 7,
            files: 4,
            dirs: 2,
            bytes: tree.size(0),
            elapsed_ms: 1,
            volume: None,
            warnings: vec![],
            can_refresh: None,
        };
        Scan { tree, result, scanned_at: 1_791_654_312, usn: None, serial: 0 }
    }

    /// Formato del resumen en disco: lo leen las dos ediciones.
    #[test]
    fn snapshot_layout() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tessera-snap-{}-{nanos}", std::process::id()));
        let h = History::at(&dir);
        let s = sample_scan();
        let e = h.save(&s).unwrap();
        // id: fecha UTC del guardado + "-" + FNV-1a de "c:\data" en hex
        assert_eq!(e.id.len(), 25);
        assert!(e.id.ends_with(&format!("-{:08x}", path_hash("c:\\data"))), "{}", e.id);
        let b = e.id.as_bytes();
        assert!(b[..8].iter().chain(&b[9..15]).all(u8::is_ascii_digit) && b[8] == b'T' && b[15] == b'Z' && b[16] == b'-', "{}", e.id);
        let mut raw = String::new();
        MultiGzDecoder::new(File::open(dir.join(format!("{}.snap.gz", e.id))).unwrap()).read_to_string(&mut raw).unwrap();
        assert_eq!(
            raw,
            concat!(
                r#"{"v":1,"path":"C:\\Data","scannedAt":1791654312,"nodes":["#,
                r#"[-1,"C:\\Data",1,3145833,3153920,4,2,1],"#,
                r#"[0,"big.bin",0,2097152,2097152,0,0,3],"#,
                r#"[0,"Sub",1,1048581,1052672,2,0,4],"#,
                r#"[2,"Ñandú 😀.bin",0,1048576,1048576,0,0,5],"#,
                r#"[0,"empty",1,0,0,0,0,7]]}"#
            )
        );
        let size = fs::metadata(dir.join(format!("{}.snap.gz", e.id))).unwrap().len();
        let j: serde_json::Value = serde_json::from_slice(&fs::read(dir.join(format!("{}.json", e.id))).unwrap()).unwrap();
        assert_eq!(
            j,
            serde_json::json!({
                "id": e.id, "path": "C:\\Data", "scannedAt": 1_791_654_312u64, "engine": "walk",
                "bytes": 3_145_833, "files": 4, "dirs": 2, "nodes": 5, "fileBytes": size,
            })
        );
        // Un segundo guardado en el mismo segundo lleva el sufijo -2 (o es de un segundo posterior)
        let e2 = h.save(&s).unwrap();
        assert_ne!(e2.id, e.id);
        assert_eq!(h.list().unwrap().iter().map(|x| x.id.clone()).collect::<Vec<_>>(), [e2.id.clone(), e.id.clone()]);

        // Comparar con el mismo escaneo: nada cambia; lo pequeño no guardado es desconocido
        let r = h.compare(&s, &e.id, 10).unwrap();
        assert!(r.grew.is_empty() && r.shrank.is_empty() && r.removed.is_empty());
        assert_eq!(r.before, r.after);
        assert_eq!(r.before, Totals { bytes: 3_145_833, files: 4, dirs: 2 });
        let t = &s.tree;
        let rows = crate::ops::children(t, 0, 0, 10, crate::types::SortKey::Delta, true).unwrap().rows;
        assert_eq!(rows.iter().map(|r| (r.name.as_str(), r.prev)).collect::<Vec<_>>(), [
            ("big.bin", Some(2 << 20)),
            ("empty", Some(0)),
            ("small.txt", None),
            ("Sub", Some(1_048_581)),
        ]);
        assert!(rows.iter().all(|r| r.fresh.is_none()));
        t.set_comparison(None);
        assert!(t.row(1).prev.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn matches_repeated_names_in_order() {
        use crate::build::{build, RawTree};
        use crate::types::flag;
        let mut r = RawTree::with_capacity(4);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        r.push(root, b"x", 0, 0, 0, flag::DIR);
        r.push(root, b"X", 0, 0, 0, flag::DIR);
        // Archivo con el mismo nombre que las carpetas (carpeta que distingue mayúsculas)
        r.push(root, b"x", 5 << 20, 0, 0, 0);
        r.root = root;
        let t = build(r, "C:\\D".into(), &[]).unwrap();
        let node = |p: f64, name: &str, dir: bool| SnapNode(p, name.into(), f64::from(u8::from(dir)), 0.0, IgnoredAny, 0.0, 0.0, IgnoredAny);
        let nodes = [node(-1.0, "C:\\D", true), node(0.0, "X", true), node(0.0, "x", true), node(0.0, "X", false), node(0.0, "y", true)];
        let m = match_nodes(&t, &nodes);
        assert_eq!(m[0], 0);
        assert!(m[1] != NONE && m[2] != NONE && m[1] != m[2], "{m:?}");
        assert!(t.is_dir(m[1]) && t.is_dir(m[2]) && !t.is_dir(m[3]));
        assert_eq!(m[4], NONE);
    }

    /// Rutas de Linux: distinguen mayúsculas (id, otra raíz y emparejamiento) y usan `/`.
    #[test]
    fn posix_paths() {
        use crate::build::{build, RawTree};
        use crate::types::flag;
        assert_ne!(path_hash("/home/Ana"), path_hash("/home/ana"));
        let fnv = |s: &str| s.bytes().fold(0x811c_9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193));
        assert_eq!(path_hash("/home/Ana"), fnv("/home/Ana"));
        assert_eq!(path_hash("C:\\Users"), fnv("c:\\users"));
        assert_eq!(entry_id(1_791_654_312, "/srv/Datos"), format!("20261010T174512Z-{:08x}", path_hash("/srv/Datos")));
        assert_eq!((root_key("/home/ana/"), root_key("/"), root_key("/Home")), ("/home/ana".to_string(), String::new(), "/Home".to_string()));
        let mut r = RawTree::with_capacity(4);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        r.push(root, b"x", 0, 0, 0, flag::DIR);
        r.push(root, b"X", 0, 0, 0, flag::DIR);
        r.root = root;
        let t = build(r, "/srv".into(), &[]).unwrap();
        let node = |p: f64, name: &str| SnapNode(p, name.into(), 1.0, 0.0, IgnoredAny, 0.0, 0.0, IgnoredAny);
        let nodes = [node(-1.0, "/srv"), node(0.0, "X"), node(0.0, "x"), node(1.0, "y")];
        let m = match_nodes(&t, &nodes);
        assert_eq!((t.name(m[1]), t.name(m[2]), m[3]), ("X".into(), "x".into(), NONE));
        assert_eq!(snap_path(&nodes, 3), "/srv/X/y");
    }

    #[test]
    fn delta_rules() {
        let c = Comparison { state: vec![10, FRESH, UNKNOWN, 50] };
        assert_eq!((c.prev(0), c.is_fresh(0), c.delta(0, 25)), (Some(10), false, 15));
        assert_eq!((c.prev(1), c.is_fresh(1), c.delta(1, 7)), (None, true, 7));
        assert_eq!((c.prev(2), c.is_fresh(2), c.delta(2, 7)), (None, false, 0));
        assert_eq!(c.delta(3, 20), -30);
        assert_eq!((c.prev(99), c.is_fresh(99), c.delta(99, 5)), (None, false, 0));
    }
}
