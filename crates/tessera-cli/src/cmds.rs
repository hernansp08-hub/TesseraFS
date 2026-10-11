//! Órdenes `top` (lo más grande, en tabla, CSV o JSON) y `check` (espacio libre del volumen, sin
//! escanear). El análisis de argumentos va aparte para probarlo. Las dos abren un `.tessera` (escaneo
//! guardado) en vez de escanear o mirar el disco.

use std::borrow::Cow;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use tessera_core::{msg, names, ops, saved, sys, Engine, EngineChoice, EngineMessage, Scan, ScanOptions, SearchRow, Tree, VolumeInfo};

use crate::{human, sep};

const USO_TOP: &str = "Uso: tessera-cli top <ruta|archivo.tessera> [--files N] [--folders N] [--depth D] [--format table|csv|json] [--out FICHERO] [--engine auto|walk|mft]";
const USO_CHECK: &str = "Uso: tessera-cli check <ruta|archivo.tessera> --min-free <N%|N[KB|MB|GB|TB]>";

// ---------- Escaneo guardado ----------

/// Abre un `.tessera` (la ruta, sin comillas alrededor).
pub fn open_saved(path: &str) -> Result<Scan, EngineMessage> {
    saved::open_file(Path::new(path.trim().trim_matches('"')))
}

/// Escanea `path` o, si es un `.tessera`, lo abre.
fn load(path: &str, engine: EngineChoice) -> Result<Scan, EngineMessage> {
    if saved::is_saved_scan(path) {
        return open_saved(path);
    }
    tessera_core::scan(path, engine, &ScanOptions::default(), &|_| {}, &AtomicBool::new(false))
}

/// Nodo vivo de `t` en `path`: absoluta (bajo la raíz) o relativa a la raíz; en Windows sin distinguir
/// mayúsculas y con `\` o `/`, en Linux tal cual y con `/`.
pub fn find_node(t: &Tree, path: &str) -> Option<u32> {
    let fold = !names::is_posix(t.root_path());
    let key = |s: &str| if fold { s.to_lowercase() } else { s.to_string() };
    let seps: &[char] = if fold { &['\\', '/'] } else { &['/'] };
    let root = key(t.root_path().trim_end_matches(seps));
    let k = key(path.trim());
    let rel = match k.strip_prefix(&root) {
        Some(rest) if rest.is_empty() || rest.starts_with(seps) => rest,
        _ => &k,
    };
    let mut id = 0u32;
    for want in rel.split(seps).filter(|c| !c.is_empty() && *c != ".") {
        let kids = t.kids(id);
        id = (0..kids.len()).map(|i| kids.get(i)).find(|&k| key(&t.name(k)) == want)?;
    }
    Some(id)
}

// ---------- Argumentos ----------

/// Posicionales y opciones (clave, valor), en orden.
type Split = (Vec<String>, Vec<(String, String)>);

/// Deshace el `"C:\"` de cmd.exe y del Programador de tareas: para Windows, `\"` es una comilla
/// literal y el resto de la línea llega pegado (`C:" --min-free 10%`). Una ruta nunca lleva comillas.
/// En Linux la shell ya separa los argumentos (y un nombre puede llevar comillas): llegan tal cual.
fn unquote(args: &[String]) -> Vec<String> {
    if !cfg!(windows) {
        return args.to_vec();
    }
    let mut out = Vec::new();
    for a in args {
        match a.split_once('"') {
            Some((head, rest)) => {
                out.push(format!("{head}\\"));
                out.extend(rest.split_whitespace().map(|t| t.replace('"', "")).filter(|t| !t.is_empty()));
            }
            None => out.push(a.clone()),
        }
    }
    out
}

/// Separa los posicionales de las opciones `--clave valor` / `--clave=valor` (sólo las de `known`).
fn split_args(args: &[String], known: &[&str]) -> Result<Split, String> {
    let args = &unquote(args)[..];
    let (mut pos, mut opts) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        let Some(name) = a.strip_prefix("--") else {
            pos.push(a.clone());
            continue;
        };
        let (key, inline) = match name.split_once('=') {
            Some((k, v)) => (k, Some(v.to_string())),
            None => (name, None),
        };
        if !known.contains(&key) {
            return Err(format!("Opción desconocida: --{key}"));
        }
        let value = match inline {
            Some(v) => v,
            None => {
                let v = args.get(i).ok_or_else(|| format!("Falta el valor de --{key}"))?;
                i += 1;
                v.clone()
            }
        };
        opts.push((key.to_string(), value));
    }
    Ok((pos, opts))
}

fn one_path(pos: &[String]) -> Result<String, String> {
    match pos {
        [p] => Ok(p.clone()),
        [] => Err("Falta la ruta".into()),
        [_, extra, ..] => Err(format!("Sobra un argumento: {extra}")),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Table,
    Csv,
    Json,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TopArgs {
    pub path: String,
    pub files: usize,
    pub folders: usize,
    pub depth: u32,
    pub format: Format,
    pub out: Option<String>,
    pub engine: EngineChoice,
}

/// `top <ruta> [--files N] [--folders N] [--depth D] [--format F] [--out FICHERO] [--engine E]`. Sin
/// `--files` ni `--folders`, 10 de cada; con uno solo, sólo ese.
pub fn parse_top(args: &[String]) -> Result<TopArgs, String> {
    let (pos, opts) = split_args(args, &["files", "folders", "depth", "format", "out", "engine"])?;
    let mut a = TopArgs { path: one_path(&pos)?, files: 10, folders: 10, depth: 1, format: Format::Table, out: None, engine: EngineChoice::Auto };
    let count = |k: &str, v: &str| v.parse::<usize>().map_err(|_| format!("Número no válido para --{k}: \"{v}\""));
    let (mut files, mut folders) = (None, None);
    for (k, v) in opts {
        match k.as_str() {
            "files" => files = Some(count(&k, &v)?),
            "folders" => folders = Some(count(&k, &v)?),
            "depth" => a.depth = v.parse().ok().filter(|&d| d >= 1).ok_or_else(|| format!("Profundidad no válida: \"{v}\" (1 o más)"))?,
            "format" => {
                a.format = match v.as_str() {
                    "table" => Format::Table,
                    "csv" => Format::Csv,
                    "json" => Format::Json,
                    _ => return Err(format!("Formato desconocido: \"{v}\" (table, csv o json)")),
                }
            }
            "out" => a.out = Some(v),
            _ => a.engine = v.parse().map_err(|_| format!("Motor desconocido: \"{v}\" (auto, walk o mft)"))?,
        }
    }
    if files.is_some() || folders.is_some() {
        (a.files, a.folders) = (files.unwrap_or(0), folders.unwrap_or(0));
    }
    Ok(a)
}

/// Espacio libre mínimo: porcentaje del volumen o bytes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Threshold {
    Percent(f64),
    Bytes(u64),
}

impl Threshold {
    /// Bytes que tienen que quedar libres en un volumen de `total` bytes.
    pub fn bytes(self, total: u64) -> u64 {
        match self {
            Threshold::Percent(p) => (total as f64 * p / 100.0).ceil() as u64,
            Threshold::Bytes(b) => b,
        }
    }

    fn describe(self, total: u64) -> String {
        match self {
            Threshold::Percent(p) => format!("{p} % ({})", human(self.bytes(total))),
            Threshold::Bytes(b) => human(b),
        }
    }
}

/// Número no negativo con punto o coma decimal.
fn decimal(s: &str) -> Option<f64> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
        return None;
    }
    s.replace(',', ".").parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `10%`, `12.5 %`, `500MB`, `20 GB`, `1,5TiB`, `4096` (bytes). K/KB/KiB… = 1024 (como el Explorador).
pub fn parse_threshold(s: &str) -> Result<Threshold, String> {
    let t = s.trim();
    let bad = || format!("Umbral no válido: \"{s}\" (p. ej. 10%, 500MB o 20GB)");
    if let Some(p) = t.strip_suffix('%') {
        let v = decimal(p.trim()).ok_or_else(bad)?;
        if v > 100.0 {
            return Err(format!("Porcentaje mayor que 100: \"{s}\""));
        }
        return Ok(Threshold::Percent(v));
    }
    let at = t.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(t.len());
    let v = decimal(t[..at].trim()).ok_or_else(bad)?;
    let mult: u64 = match t[at..].to_ascii_uppercase().as_str() {
        "" | "B" => 1,
        "K" | "KB" | "KIB" => 1 << 10,
        "M" | "MB" | "MIB" => 1 << 20,
        "G" | "GB" | "GIB" => 1 << 30,
        "T" | "TB" | "TIB" => 1 << 40,
        _ => return Err(bad()),
    };
    let b = v * mult as f64;
    if b >= u64::MAX as f64 {
        return Err(format!("Umbral demasiado grande: \"{s}\""));
    }
    Ok(Threshold::Bytes(b.round() as u64))
}

#[derive(Clone, Debug, PartialEq)]
pub struct CheckArgs {
    pub path: String,
    pub min_free: Threshold,
}

/// `check <ruta> --min-free <umbral>`.
pub fn parse_check(args: &[String]) -> Result<CheckArgs, String> {
    let (pos, opts) = split_args(args, &["min-free"])?;
    let path = one_path(&pos)?;
    let v = opts.last().map(|(_, v)| v.as_str()).ok_or("Falta --min-free")?;
    Ok(CheckArgs { path, min_free: parse_threshold(v)? })
}

// ---------- check ----------

/// (hay espacio suficiente, línea de estado). Sin escanear: sólo el volumen que contiene la ruta. Con un
/// `.tessera`, el volumen guardado (cuando se escaneó) y su fecha al final de la línea.
pub fn check(a: &CheckArgs) -> Result<(bool, String), EngineMessage> {
    if saved::is_saved_scan(&a.path) {
        let s = open_saved(&a.path)?;
        let v = s.result.volume.as_ref().ok_or_else(|| msg::scan_open_failed("The saved scan has no volume information"))?;
        let (ok, line) = verdict(v, a.min_free);
        return Ok((ok, format!("{line} · escaneado {}", iso(s.scanned_at))));
    }
    let path = tessera_core::scan::normalize_path(&a.path)?;
    std::fs::metadata(&path).map_err(|e| msg::cannot_open(&path, &sys::io_error_text(&e)))?;
    let root = sys::volume_root_of(&path).unwrap_or_else(|| path.clone());
    let v = sys::volume_info(&root).ok_or_else(|| msg::cannot_open(&root, &sys::last_error_text()))?;
    Ok(verdict(&v, a.min_free))
}

/// (queda al menos `min_free`, línea de estado) de un volumen.
fn verdict(v: &VolumeInfo, min_free: Threshold) -> (bool, String) {
    let need = min_free.bytes(v.total);
    let ok = v.free >= need;
    let pct = if v.total > 0 { v.free as f64 * 100.0 / v.total as f64 } else { 0.0 };
    let line = format!(
        "{} · {} · {} libres de {} ({pct:.1} %) · mínimo {}",
        if ok { "OK" } else { "BAJO" },
        v.path,
        human(v.free),
        human(v.total),
        min_free.describe(v.total)
    );
    (ok, line)
}

/// Código de salida: 0 si hay espacio suficiente, 2 si no, 1 si hay un error.
pub fn check_cmd(args: &[String]) -> i32 {
    let a = match parse_check(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Error: {e}\n{USO_CHECK}");
            return 1;
        }
    };
    match check(&a) {
        Ok((ok, line)) => {
            println!("{line}");
            if ok {
                0
            } else {
                2
            }
        }
        Err(e) => {
            eprintln!("Error: [{}] {}", e.code, e.message);
            1
        }
    }
}

// ---------- top ----------

/// Lo que imprime `top`.
pub struct Top {
    pub root: String,
    pub scanned_at: u64,
    pub engine: Engine,
    pub elapsed_ms: u64,
    pub depth: u32,
    pub size: u64,
    pub total_files: u32,
    pub total_dirs: u32,
    pub files: Vec<SearchRow>,
    pub folders: Vec<SearchRow>,
}

/// Los `n` archivos más grandes, a cualquier profundidad (tamaño desc, nombre).
pub fn largest_files(t: &Tree, n: usize) -> Vec<SearchRow> {
    if n == 0 {
        return Vec::new();
    }
    ops::search(t, "", 0, n.min(u32::MAX as usize) as u32).rows
}

/// Las `n` carpetas más grandes a profundidad `depth` (1 = hijas directas de la raíz).
pub fn largest_folders(t: &Tree, depth: u32, n: usize) -> Vec<SearchRow> {
    if n == 0 {
        return Vec::new();
    }
    let mut level = vec![0u32];
    for _ in 0..depth {
        level = level.iter().flat_map(|&id| t.kids(id).to_vec()).filter(|&k| t.is_dir(k)).collect();
    }
    if n < level.len() {
        level.select_nth_unstable_by(n - 1, |&a, &b| t.cmp_size_desc(a, b));
        level.truncate(n);
    }
    level.sort_unstable_by(|&a, &b| t.cmp_size_desc(a, b));
    level.into_iter().map(|id| SearchRow { node: t.row(id), path: t.path(id) }).collect()
}

/// `YYYY-MM-DDTHH:MM:SSZ` (vacío si no hay fecha).
pub fn iso(secs: u64) -> String {
    if secs == 0 {
        return String::new();
    }
    let s = tessera_core::history::utc_stamp(secs); // YYYYMMDDTHHMMSSZ
    format!("{}-{}-{}T{}:{}:{}Z", &s[0..4], &s[4..6], &s[6..8], &s[9..11], &s[11..13], &s[13..15])
}

fn cell(s: &str) -> Cow<'_, str> {
    if s.contains([',', '"', '\r', '\n']) {
        Cow::Owned(format!("\"{}\"", s.replace('"', "\"\"")))
    } else {
        Cow::Borrowed(s)
    }
}

/// CSV: UTF-8 sin BOM, comas, cabecera, tamaños en bytes y fechas ISO; líneas CRLF.
pub fn render_csv(top: &Top) -> String {
    let mut out = String::from("kind,path,name,size,alloc,files,dirs,mtime\r\n");
    for (kind, rows) in [("file", &top.files), ("folder", &top.folders)] {
        for r in rows {
            let n = &r.node;
            out.push_str(&format!(
                "{kind},{},{},{},{},{},{},{}\r\n",
                cell(&r.path),
                cell(&n.name),
                n.size,
                n.alloc,
                n.files,
                n.dirs,
                iso(n.mtime as u64)
            ));
        }
    }
    out
}

/// JSON: `{root, scannedAt, files, folders}` con filas como `SearchRow` (campos en el orden del contrato).
pub fn render_json(top: &Top) -> String {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Out<'a> {
        root: &'a str,
        scanned_at: u64,
        files: &'a [SearchRow],
        folders: &'a [SearchRow],
    }
    let v = Out { root: &top.root, scanned_at: top.scanned_at, files: &top.files, folders: &top.folders };
    let mut s = serde_json::to_string_pretty(&v).unwrap_or_default();
    s.push('\n');
    s
}

pub fn render_table(top: &Top) -> String {
    let engine = match top.engine {
        Engine::Mft => "MFT",
        Engine::Walk => "recorrido",
    };
    let mut out = format!(
        "Raíz:       {} · {} · {} archivos · {} carpetas\nEscaneado:  {} ({engine}, {:.2} s)\n",
        top.root,
        human(top.size),
        sep(top.total_files as u64),
        sep(top.total_dirs as u64),
        iso(top.scanned_at),
        top.elapsed_ms as f64 / 1000.0
    );
    if !top.files.is_empty() {
        out.push_str(&format!("\nLos {} archivos más grandes:\n", top.files.len()));
        for (i, r) in top.files.iter().enumerate() {
            out.push_str(&format!("  {:>3}  {:>12}  {}\n", i + 1, human(r.node.size), r.path));
        }
    }
    if !top.folders.is_empty() {
        out.push_str(&format!("\nLas {} carpetas más grandes (profundidad {}):\n", top.folders.len(), top.depth));
        for (i, r) in top.folders.iter().enumerate() {
            let n = &r.node;
            out.push_str(&format!(
                "  {:>3}  {:>12}  {:>10} arch  {:>8} carp  {}{}\n",
                i + 1,
                human(n.size),
                sep(n.files as u64),
                sep(n.dirs as u64),
                r.path,
                crate::dir_mark(true, &r.path)
            ));
        }
    }
    out
}

/// Escanea (o abre el `.tessera`) y escribe lo más grande. Código de salida: 0 bien, 1 error, 2 uso incorrecto.
pub fn top_cmd(args: &[String]) -> i32 {
    let a = match parse_top(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Error: {e}\n{USO_TOP}");
            return 2;
        }
    };
    let s = match load(&a.path, a.engine) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Error: [{}] {}", e.code, e.message);
            return 1;
        }
    };
    for w in &s.result.warnings {
        eprintln!("Aviso: [{}] {}", w.code, w.message.lines().next().unwrap_or(""));
    }
    let t = &s.tree;
    let top = Top {
        root: s.result.root_path.clone(),
        scanned_at: s.scanned_at,
        engine: s.result.engine,
        elapsed_ms: s.result.elapsed_ms,
        depth: a.depth,
        size: t.size(0),
        total_files: t.files(0),
        total_dirs: t.dirs(0),
        files: largest_files(t, a.files),
        folders: largest_folders(t, a.depth, a.folders),
    };
    let text = match a.format {
        Format::Table => render_table(&top),
        Format::Csv => render_csv(&top),
        Format::Json => render_json(&top),
    };
    match &a.out {
        Some(f) => {
            if let Err(e) = std::fs::write(f, text) {
                eprintln!("Error: no se pudo escribir {f}: {}", sys::io_error_text(&e));
                return 1;
            }
            eprintln!("Escrito: {f}");
        }
        None => {
            let mut o = std::io::stdout().lock();
            if o.write_all(text.as_bytes()).and_then(|_| o.flush()).is_err() {
                return 1;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::build::{build, RawTree};
    use tessera_core::tree::NONE;
    use tessera_core::types::flag;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn top_arguments() {
        let a = parse_top(&args(&["C:\\x"])).unwrap();
        assert_eq!(a, TopArgs { path: "C:\\x".into(), files: 10, folders: 10, depth: 1, format: Format::Table, out: None, engine: EngineChoice::Auto });
        let a = parse_top(&args(&["--files", "5", "D:\\", "--format=csv", "--out", "o.csv", "--engine", "walk", "--depth", "2"])).unwrap();
        assert_eq!((a.path.as_str(), a.files, a.folders, a.depth, a.format), ("D:\\", 5, 0, 2, Format::Csv));
        assert_eq!((a.out.as_deref(), a.engine), (Some("o.csv"), EngineChoice::Walk));
        let a = parse_top(&args(&["x", "--folders", "3", "--format", "json"])).unwrap();
        assert_eq!((a.files, a.folders, a.format), (0, 3, Format::Json));
        let a = parse_top(&args(&["x", "--files", "0", "--folders", "0"])).unwrap();
        assert_eq!((a.files, a.folders), (0, 0));
        for (bad, why) in [
            (&["--files", "3"][..], "Falta la ruta"),
            (&["a", "b"], "Sobra un argumento: b"),
            (&["a", "--files"], "Falta el valor de --files"),
            (&["a", "--files", "-1"], "Número no válido"),
            (&["a", "--depth", "0"], "Profundidad no válida"),
            (&["a", "--format", "xml"], "Formato desconocido"),
            (&["a", "--engine", "fast"], "Motor desconocido"),
            (&["a", "--top", "3"], "Opción desconocida: --top"),
        ] {
            let e = parse_top(&args(bad)).unwrap_err();
            assert!(e.starts_with(why), "{bad:?}: {e}");
        }
    }

    #[test]
    fn thresholds() {
        use Threshold::*;
        assert_eq!(parse_threshold("10%").unwrap(), Percent(10.0));
        assert_eq!(parse_threshold(" 12,5 % ").unwrap(), Percent(12.5));
        assert_eq!(parse_threshold("0%").unwrap(), Percent(0.0));
        assert_eq!(parse_threshold("100%").unwrap(), Percent(100.0));
        assert_eq!(parse_threshold("4096").unwrap(), Bytes(4096));
        assert_eq!(parse_threshold("10B").unwrap(), Bytes(10));
        assert_eq!(parse_threshold("2KB").unwrap(), Bytes(2048));
        assert_eq!(parse_threshold("500MB").unwrap(), Bytes(500 << 20));
        assert_eq!(parse_threshold("500 mb").unwrap(), Bytes(500 << 20));
        assert_eq!(parse_threshold("20GB").unwrap(), Bytes(20 << 30));
        assert_eq!(parse_threshold("20GiB").unwrap(), Bytes(20 << 30));
        assert_eq!(parse_threshold("1.5TB").unwrap(), Bytes(3 << 39));
        assert_eq!(parse_threshold("1,5t").unwrap(), Bytes(3 << 39));
        for bad in ["", "%", "abc", "-5%", "101%", "10PB", "10 G B", "1e3", "GB", "1.2.3MB", "99999999999999TB"] {
            assert!(parse_threshold(bad).is_err(), "{bad}");
        }
        assert_eq!(Percent(10.0).bytes(1000), 100);
        assert_eq!(Percent(12.5).bytes(1001), 126, "se redondea hacia arriba");
        assert_eq!(Bytes(7).bytes(1), 7);
    }

    #[test]
    fn check_arguments_and_volume() {
        let a = parse_check(&args(&["C:\\", "--min-free", "10%"])).unwrap();
        assert_eq!(a, CheckArgs { path: "C:\\".into(), min_free: Threshold::Percent(10.0) });
        assert_eq!(parse_check(&args(&["C:\\", "--min-free=2GB"])).unwrap().min_free, Threshold::Bytes(2 << 30));
        assert_eq!(parse_check(&args(&["C:\\"])).unwrap_err(), "Falta --min-free");
        assert!(parse_check(&args(&["--min-free", "1%"])).unwrap_err().starts_with("Falta la ruta"));
        assert!(parse_check(&args(&["C:\\", "--min-free", "mucho"])).unwrap_err().starts_with("Umbral no válido"));
        if cfg!(windows) {
            // `"C:\" --min-free 10%` desde cmd.exe llega como un solo argumento
            let a = parse_check(&args(&["C:\" --min-free 10%"])).unwrap();
            assert_eq!((a.path.as_str(), a.min_free), ("C:\\", Threshold::Percent(10.0)));
            let a = parse_top(&args(&["D:\\Datos\" --files 3 --format \"csv\""])).unwrap();
            assert_eq!((a.path.as_str(), a.files, a.format), ("D:\\Datos\\", 3, Format::Csv));
        } else {
            // En Linux las comillas son parte del nombre
            let a = parse_top(&args(&["/srv/\"raro\"", "--files", "3"])).unwrap();
            assert_eq!((a.path.as_str(), a.files), ("/srv/\"raro\"", 3));
        }
        // Con el volumen real de la carpeta temporal (sin escanear)
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        let (ok, line) = check(&CheckArgs { path: tmp.clone(), min_free: Threshold::Percent(0.0) }).unwrap();
        assert!(ok && line.starts_with("OK · "), "{line}");
        let (ok, line) = check(&CheckArgs { path: tmp.clone(), min_free: Threshold::Bytes(u64::MAX / 2) }).unwrap();
        assert!(!ok && line.starts_with("BAJO · "), "{line}");
        let e = check(&CheckArgs { path: format!("{tmp}\\no-existe-{}", std::process::id()), min_free: Threshold::Percent(1.0) }).unwrap_err();
        assert_eq!(e.code, "error.cannotOpen");
        assert_eq!(check_cmd(&args(&[&tmp, "--min-free", "0%"])), 0);
        assert_eq!(check_cmd(&args(&[&tmp, "--min-free", "16000000TB"])), 2);
        assert_eq!(check_cmd(&args(&[&tmp])), 1);
    }

    /// `top` y `check` sobre un `.tessera`: lo abren en vez de escanear (check con el volumen guardado).
    #[test]
    fn saved_scan_files() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tessera-cli-saved-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(dir.join("datos/sub")).unwrap();
        std::fs::write(dir.join("datos/sub/grande.bin"), vec![1u8; 5000]).unwrap();
        std::fs::write(dir.join("datos/x.txt"), b"hola").unwrap();
        let s = tessera_core::scan(&dir.join("datos").to_string_lossy(), EngineChoice::Walk, &ScanOptions::default(), &|_| {}, &AtomicBool::new(false)).unwrap();
        let file = dir.join("copia.TESSERA");
        saved::write_scan(std::fs::File::create(&file).unwrap(), &s).unwrap();
        let f = file.to_string_lossy().into_owned();
        assert!(saved::is_saved_scan(&f) && saved::is_saved_scan(&format!("\"{f}\"")));
        let o = load(&f, EngineChoice::Mft).unwrap();
        assert_eq!((o.tree.len(), o.result.root_path.as_str(), o.scanned_at), (s.tree.len(), s.result.root_path.as_str(), s.scanned_at));
        assert!(o.result.offline.is_some());
        // check: el volumen guardado
        let (ok, line) = check(&CheckArgs { path: f.clone(), min_free: Threshold::Percent(0.0) }).unwrap();
        assert!(ok && line.starts_with("OK · ") && line.ends_with(&format!("· escaneado {}", iso(s.scanned_at))), "{line}");
        assert_eq!(check_cmd(&args(&[&f, "--min-free", "16000000TB"])), 2);
        // top --format json desde el .tessera
        let out = dir.join("top.json");
        assert_eq!(top_cmd(&args(&[&f, "--files", "1", "--format", "json", "--out", &out.to_string_lossy()])), 0);
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!((v["root"].as_str(), v["files"][0]["name"].as_str()), (Some(s.result.root_path.as_str()), Some("grande.bin")));
        // Uno dañado: scan.openFailed (código de salida 1)
        let bad = dir.join("roto.tessera");
        std::fs::write(&bad, b"nada").unwrap();
        assert_eq!(load(&bad.to_string_lossy(), EngineChoice::Auto).err().unwrap().code, "scan.openFailed");
        assert_eq!(top_cmd(&args(&[&bad.to_string_lossy()])), 1);
        assert_eq!(check_cmd(&args(&[&bad.to_string_lossy(), "--min-free", "1%"])), 1);
        // find_node: absoluta o relativa
        let t = &o.tree;
        let root = t.root_path().to_string();
        let g = find_node(t, &format!("{root}{}sub{}grande.bin", std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR)).unwrap();
        assert_eq!(t.name(g), "grande.bin");
        assert_eq!(find_node(t, "sub/grande.bin"), Some(g));
        assert_eq!((find_node(t, &root), find_node(t, ""), find_node(t, "no/está")), (Some(0), Some(0), None));
        if cfg!(windows) {
            assert_eq!(find_node(t, &format!("{}\\SUB\\Grande.BIN", root.to_uppercase())), Some(g));
        } else {
            assert_eq!(find_node(t, "SUB/grande.bin"), None);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// raíz → a(dir) → a1.bin 100 · sub(dir) → «x, \"y\".txt» 300 ; b(dir) → b.bin 50 ; c.txt 70
    fn sample() -> Tree {
        let mut r = RawTree::with_capacity(8);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        let a = r.push(root, b"a", 0, 0, 1_791_654_312, flag::DIR);
        r.push(a, b"a1.bin", 100, 4096, 0, 0);
        let sub = r.push(a, b"sub", 0, 0, 0, flag::DIR);
        r.push(sub, "x, \"y\".txt".as_bytes(), 300, 4096, 1_791_654_312, 0);
        let b = r.push(root, b"b", 0, 0, 0, flag::DIR);
        r.push(b, b"b.bin", 50, 4096, 0, 0);
        r.push(root, b"c.txt", 70, 4096, 0, 0);
        r.root = root;
        build(r, "C:\\r".into(), &[]).unwrap()
    }

    fn top_of(t: &Tree, files: usize, depth: u32, folders: usize) -> Top {
        Top {
            root: t.root_path().into(),
            scanned_at: 1_791_654_312,
            engine: Engine::Walk,
            elapsed_ms: 5,
            depth,
            size: t.size(0),
            total_files: t.files(0),
            total_dirs: t.dirs(0),
            files: largest_files(t, files),
            folders: largest_folders(t, depth, folders),
        }
    }

    #[test]
    fn largest_and_rendering() {
        let t = sample();
        let paths = |v: &[SearchRow]| v.iter().map(|r| r.path.clone()).collect::<Vec<_>>();
        assert_eq!(paths(&largest_files(&t, 2)), ["C:\\r\\a\\sub\\x, \"y\".txt", "C:\\r\\a\\a1.bin"]);
        assert_eq!(paths(&largest_folders(&t, 1, 10)), ["C:\\r\\a", "C:\\r\\b"]);
        assert_eq!(paths(&largest_folders(&t, 1, 1)), ["C:\\r\\a"]);
        assert_eq!(paths(&largest_folders(&t, 2, 10)), ["C:\\r\\a\\sub"]);
        assert!(largest_folders(&t, 3, 10).is_empty());
        assert!(largest_files(&t, 0).is_empty());
        let top = top_of(&t, 1, 1, 2);
        let csv = render_csv(&top);
        assert_eq!(
            csv,
            "kind,path,name,size,alloc,files,dirs,mtime\r\n\
             file,\"C:\\r\\a\\sub\\x, \"\"y\"\".txt\",\"x, \"\"y\"\".txt\",300,4096,0,0,2026-10-10T17:45:12Z\r\n\
             folder,C:\\r\\a,a,400,8192,2,1,2026-10-10T17:45:12Z\r\n\
             folder,C:\\r\\b,b,50,4096,1,0,\r\n"
        );
        assert!(!csv.starts_with('\u{feff}'));
        let v: serde_json::Value = serde_json::from_str(&render_json(&top)).unwrap();
        assert_eq!(v["root"], "C:\\r");
        assert_eq!(v["scannedAt"], 1_791_654_312u64);
        assert_eq!(v.as_object().unwrap().len(), 4);
        assert_eq!(v["files"][0]["path"], "C:\\r\\a\\sub\\x, \"y\".txt");
        assert_eq!(v["files"][0]["size"], 300);
        assert_eq!(v["folders"][1]["name"], "b");
        assert_eq!(v["folders"][0]["isDir"], true);
        assert_eq!(v["folders"][0]["childCount"], 2);
        let table = render_table(&top);
        assert!(table.contains("Los 1 archivos más grandes:") && table.contains("Las 2 carpetas más grandes (profundidad 1):"), "{table}");
        assert!(table.contains("C:\\r\\a\\\n"));
        // Árbol de Linux: rutas y marca de carpeta con `/`
        let mut r = RawTree::with_capacity(3);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        let a = r.push(root, b"a", 0, 0, 0, flag::DIR);
        r.push(a, b"f.bin", 9, 4096, 0, 0);
        r.root = root;
        let t = build(r, "/srv".into(), &[]).unwrap();
        let top = top_of(&t, 1, 1, 1);
        assert_eq!((top.files[0].path.as_str(), top.folders[0].path.as_str()), ("/srv/a/f.bin", "/srv/a"));
        assert!(render_table(&top).contains("/srv/a/\n"));
        assert!(render_csv(&top).contains("\r\nfolder,/srv/a,a,9,4096,1,0,\r\n"));
        assert_eq!((crate::dir_mark(true, "/srv"), crate::dir_mark(true, "C:\\"), crate::dir_mark(false, "/srv")), ("/", "\\", ""));
        assert_eq!(iso(0), "");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
    }
}
