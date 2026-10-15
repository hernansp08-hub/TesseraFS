//! `tessera-cli mcp`: servidor MCP (Model Context Protocol) por la entrada y la salida estándar, para que
//! un asistente de IA (Claude, Copilot, Cursor…) pregunte qué ocupa el disco. JSON-RPC 2.0, un mensaje por
//! línea; los registros van a la salida de errores.
//!
//! Sólo lee: escanea, busca, compara con el historial, busca duplicados y propone qué limpiar con las reglas de
//! la app ([`crate::clean`]), pero nunca borra, mueve ni envía nada (`save_snapshot` sólo escribe un resumen en
//! el historial de la app, como cada escaneo de la app). Los
//! escaneos quedan en memoria (los [`MAX_SCANS`] usados más recientemente) y las preguntas siguientes no
//! vuelven a escanear. Un hilo aparte lee la entrada para poder cancelar un escaneo o una búsqueda de
//! duplicados largos (`notifications/cancelled`).

use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tessera_core::types::flag;
use tessera_core::{links, names, ops, saved, sys, DupProgress, EngineChoice, EngineMessage, History, NodeRow, Scan, ScanOptions, ScanProgress, SortKey, Totals, Tree, VolumeInfo};

use crate::clean::{self, Card, Risk};
use crate::cmds::{self, find_node, iso, largest_files, largest_folders, Threshold};
use crate::{human, sep, signed};

/// Versiones del protocolo que entiende, la más reciente primero. Sólo usa herramientas, iguales en todas.
const VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// Escaneos en memoria como mucho: cada uno guarda su árbol completo.
const MAX_SCANS: usize = 4;
/// Intervalo mínimo entre avisos de progreso.
const PROGRESS_EVERY: Duration = Duration::from_secs(1);

// Errores de JSON-RPC
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

const INSTRUCTIONS: &str = "TesseraFS analyzes disk usage on this computer (Windows or Linux). \
Typical flow: list_volumes, then scan a drive or folder (a whole NTFS drive takes seconds; scans stay in memory, so later calls are instant), \
then largest, list_folder, search and file_types to explain what uses the space. compare_snapshot and size_trend answer \"what grew?\" \
from the snapshots in the TesseraFS history. Every result says when its scan was taken; call scan with refresh: true for current data. \
All tools are read-only: nothing is deleted, moved or sent anywhere. When suggesting what to free, start with cleanup_candidates \
(the rules of the app's Free up space tab, with risk, why and how), explain what each item is, \
prefer the program's own cleanup command (cargo clean, npm cache clean --force, docker system prune, Disk Cleanup…) over deleting folders, \
and let the user delete things themselves (the TesseraFS app sends them to the Recycle Bin).";

const NO_SCAN: &str = "No scan in memory yet: pass `path` (a folder or drive), or call `scan` first (list_volumes shows the drives).";

const PATH_HELP: &str = "Absolute path of a folder or file (e.g. C:\\Users\\ana\\Downloads or /home/ana). \
Defaults to the root of the most recently used scan. If no scan in memory contains it, the folder is scanned first.";

const QUERY_HELP: &str = "TesseraFS filter. Space = AND, `OR` or `|` = OR, `-x` = NOT, quotes for text with spaces. \
Plain text matches names (substring, case-insensitive); `*` and `?` are wildcards over the whole name. \
Keys: ext:mp4,mkv (ext:none) · size:>1g, size:100m..2g (b k m g t, base 1024) · alloc:>500m (space on disk) · \
age:<7d, age:>1y (d w mo y; time since last modification) · path:Downloads (text in the full path) · name:*.bak · \
re:^IMG_\\d{4} (regex on the name) · type:dir or type:file (default: files only) · files:>10k (files inside a folder; files:=0 = empty) · \
attr:cloud,hidden,system,compressed,hardlink,sparse,reparse. \
Examples: `ext:gguf,safetensors size:>1g` · `type:dir name:node_modules` · `path:Downloads ext:msi,exe,iso,zip age:>6mo` · \
`type:dir files:=0 -attr:reparse` · `age:>2y size:>500m`. Empty = the largest files.";

// ---------- Entrada y salida ----------

/// Lo que comparten el hilo que lee la entrada y el que atiende: la salida (también para los avisos de
/// progreso, que llegan desde los hilos del escaneo), la petición en curso y su cancelación.
pub struct Io {
    out: Mutex<std::io::Stdout>,
    current: Mutex<Option<Value>>,
    cancel: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Io {
    pub fn new() -> Io {
        Io { out: Mutex::new(std::io::stdout()), current: Mutex::new(None), cancel: AtomicBool::new(false) }
    }

    fn send(&self, v: &Value) {
        let mut o = lock(&self.out);
        // Sin salida no hay cliente: el bucle termina cuando se cierra la entrada
        let _ = writeln!(o, "{v}").and_then(|()| o.flush());
    }
}

/// Atiende a un cliente por la entrada y la salida estándar hasta que cierra la entrada. Código de salida 0.
pub fn run() -> i32 {
    let io = Arc::new(Io::new());
    let (tx, rx) = mpsc::channel();
    let reader = io.clone();
    std::thread::spawn(move || read_input(&tx, &reader));
    eprintln!("tessera-cli mcp {}: servidor MCP en la entrada y la salida estándar (sólo lectura)", env!("CARGO_PKG_VERSION"));
    let mut server = Server::new(None);
    for msg in rx {
        if let Some(r) = server.dispatch(msg, &io) {
            io.send(&r);
        }
    }
    0
}

/// Lee la entrada línea a línea. `notifications/cancelled` se atiende aquí, en el acto (el otro hilo puede
/// estar escaneando); lo demás pasa al otro hilo. Una línea que no es JSON recibe un error de análisis.
fn read_input(tx: &mpsc::Sender<Value>, io: &Io) {
    let mut stdin = std::io::stdin().lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        match stdin.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&line);
        if text.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(text.trim()) {
            Ok(v) => v,
            Err(e) => {
                io.send(&error(Value::Null, PARSE_ERROR, &format!("Parse error: {e}")));
                continue;
            }
        };
        if msg.get("method").and_then(Value::as_str) == Some("notifications/cancelled") {
            let id = msg.pointer("/params/requestId");
            if id.is_some() && lock(&io.current).as_ref() == id {
                io.cancel.store(true, Relaxed);
            }
            continue;
        }
        if tx.send(msg).is_err() {
            break;
        }
    }
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Lo que una herramienta necesita de su petición: el aviso de progreso (si el cliente lo pidió) y la cancelación.
struct Ctx<'a> {
    io: &'a Io,
    token: Option<Value>,
    /// Último aviso y cuántos van (el progreso tiene que crecer siempre).
    last: Mutex<(Instant, u64)>,
}

impl Ctx<'_> {
    fn cancel(&self) -> &AtomicBool {
        &self.io.cancel
    }

    /// `notifications/progress`, el primero en el acto y luego como mucho uno por [`PROGRESS_EVERY`].
    fn progress(&self, message: String) {
        let Some(token) = &self.token else { return };
        let mut last = lock(&self.last);
        if last.1 > 0 && last.0.elapsed() < PROGRESS_EVERY {
            return;
        }
        *last = (Instant::now(), last.1 + 1);
        self.io.send(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/progress",
            "params": { "progressToken": token, "progress": last.1, "message": message }
        }));
    }
}

// ---------- Servidor ----------

/// Un escaneo en memoria y, si se abrió desde un `.tessera`, ese archivo.
struct Loaded {
    scan: Scan,
    file: Option<String>,
}

pub struct Server {
    /// El usado más recientemente al final.
    scans: Vec<Loaded>,
    /// Carpeta del historial (pruebas); `None` = la de la app ([`History::open`]).
    history: Option<PathBuf>,
}

type Args = Map<String, Value>;

impl Server {
    pub fn new(history: Option<PathBuf>) -> Server {
        Server { scans: Vec::new(), history }
    }

    /// Respuesta a un mensaje o a un lote, si lleva: las notificaciones y las respuestas del cliente no.
    pub fn dispatch(&mut self, msg: Value, io: &Io) -> Option<Value> {
        match msg {
            Value::Array(batch) if !batch.is_empty() => {
                let v: Vec<Value> = batch.into_iter().filter_map(|m| self.message(m, io)).collect();
                (!v.is_empty()).then_some(Value::Array(v))
            }
            m => self.message(m, io),
        }
    }

    fn message(&mut self, m: Value, io: &Io) -> Option<Value> {
        let id = m.get("id").cloned();
        let Some(method) = m.get("method").and_then(Value::as_str) else {
            // Una respuesta del cliente (este servidor no le pide nada) no se contesta
            let reply = m.get("result").is_none() && m.get("error").is_none();
            return Some(error(id.filter(|_| reply)?, INVALID_REQUEST, "Invalid request: no method"));
        };
        // Notificaciones (initialized…): sin respuesta. La cancelación ya la atendió quien lee la entrada.
        let id = id?;
        let params = m.get("params").cloned().unwrap_or(Value::Null);
        io.cancel.store(false, Relaxed);
        *lock(&io.current) = Some(id.clone());
        let r = self.request(method, &params, io);
        *lock(&io.current) = None;
        if io.cancel.load(Relaxed) {
            // Cancelada: el cliente ya no espera respuesta
            return None;
        }
        Some(match r {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => error(id, code, &message),
        })
    }

    fn request(&mut self, method: &str, params: &Value, io: &Io) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str);
                let version = VERSIONS.iter().find(|v| Some(**v) == asked).unwrap_or(&VERSIONS[0]);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "tesserafs", "title": "TesseraFS", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).ok_or((INVALID_PARAMS, "Missing tool name".to_string()))?;
                if !tools().as_array().is_some_and(|t| t.iter().any(|t| t["name"] == name)) {
                    return Err((INVALID_PARAMS, format!("Unknown tool: {name}")));
                }
                let args = match params.get("arguments") {
                    None | Some(Value::Null) => Args::new(),
                    Some(Value::Object(a)) => a.clone(),
                    Some(_) => return Err((INVALID_PARAMS, "`arguments` must be an object".into())),
                };
                let token = params.pointer("/_meta/progressToken").cloned();
                let ctx = Ctx { io, token, last: Mutex::new((Instant::now(), 0)) };
                let r = catch_unwind(AssertUnwindSafe(|| self.call(name, &args, &ctx)))
                    .unwrap_or_else(|_| Err("Internal error in TesseraFS (see the server log)".into()));
                Ok(match r {
                    Ok(v) => json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }] }),
                    Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                })
            }
            // Algunos clientes los piden aunque no se anuncien
            "resources/list" => Ok(json!({ "resources": [] })),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
            "prompts/list" => Ok(json!({ "prompts": [] })),
            _ => Err((METHOD_NOT_FOUND, format!("Method not found: {method}"))),
        }
    }

    /// Ejecuta una herramienta. Los errores van al modelo como texto (`isError`), para que pueda corregirse.
    fn call(&mut self, name: &str, a: &Args, ctx: &Ctx) -> Result<Value, String> {
        match name {
            "list_volumes" => Ok(list_volumes()),
            "scan" => self.scan_tool(a, ctx),
            "largest" => {
                let (files, folders) = (count(a, "files", 20, 500)?, count(a, "folders", 10, 500)?);
                let depth = count(a, "depth", 1, 64)?.max(1);
                let (s, id) = self.at(a, ctx)?;
                let t = &s.tree;
                Ok(json!({
                    "path": t.path(id),
                    "scan": scan_label(s),
                    "size": human(t.size(id)),
                    "largestFiles": search_rows(&largest_files(t, id, files as usize)),
                    "largestFolders": search_rows(&largest_folders(t, id, depth, folders as usize)),
                    "folderDepth": depth
                }))
            }
            "list_folder" => {
                let (key, desc) = match opt_str(a, "sort")?.unwrap_or("size") {
                    "size" => (SortKey::Size, true),
                    "name" => (SortKey::Name, false),
                    "modified" => (SortKey::Mtime, true),
                    "files" => (SortKey::Files, true),
                    "onDisk" => (SortKey::Alloc, true),
                    "change" => (SortKey::Delta, true),
                    other => return Err(format!("Unknown sort \"{other}\": use size, name, modified, files, onDisk or change")),
                };
                let (limit, offset) = (count(a, "limit", 50, 1000)?, count(a, "offset", 0, u32::MAX)?);
                let (s, id) = self.at(a, ctx)?;
                let t = &s.tree;
                if key == SortKey::Delta && t.comparison().is_none() {
                    return Err("sort \"change\" needs a comparison: call compare_snapshot first".into());
                }
                if !t.is_dir(id) {
                    return Ok(json!({ "item": node_row(t, id), "scan": scan_label(s), "note": "This is a file, not a folder." }));
                }
                let r = ops::children(t, id, offset, limit, key, desc).map_err(engine_error)?;
                Ok(json!({
                    "folder": node_row(t, id),
                    "scan": scan_label(s),
                    "total": r.total,
                    "offset": offset,
                    "items": r.rows.iter().map(|n| row(n, t.path(n.id))).collect::<Vec<_>>()
                }))
            }
            "search" => {
                let q = opt_str(a, "query")?.unwrap_or("").to_string();
                let limit = count(a, "limit", 50, 2000)?;
                let (s, id) = self.at(a, ctx)?;
                let t = &s.tree;
                let r = ops::search(t, &q, id, limit);
                if let Some(e) = r.error {
                    return Err(format!("Invalid query: {} [{}]", e.message, e.code));
                }
                Ok(json!({
                    "scope": t.path(id),
                    "scan": scan_label(s),
                    "query": q,
                    "matches": r.total,
                    "totalSize": human(r.total_bytes),
                    "totalBytes": r.total_bytes,
                    "shown": r.rows.len(),
                    "results": search_rows(&r.rows)
                }))
            }
            "file_types" => {
                let limit = count(a, "limit", 25, 1000)?;
                let (s, id) = self.at(a, ctx)?;
                let t = &s.tree;
                let v = ops::ext_stats(t, id).map_err(engine_error)?;
                let total = t.size(id).max(1) as f64;
                Ok(json!({
                    "path": t.path(id),
                    "scan": scan_label(s),
                    "size": human(t.size(id)),
                    "typeCount": v.len(),
                    "types": v.iter().take(limit as usize).map(|e| json!({
                        "ext": if e.ext.is_empty() { "(none)" } else { e.ext.as_str() },
                        "size": human(e.size),
                        "bytes": e.size,
                        "files": e.count,
                        "percent": (e.size as f64 * 1000.0 / total).round() / 10.0
                    })).collect::<Vec<_>>()
                }))
            }
            "cleanup_candidates" => self.cleanup_tool(a, ctx),
            "find_duplicates" => self.duplicates_tool(a, ctx),
            "broken_links" => {
                let limit = count(a, "limit", 50, 1000)?;
                let (s, id) = self.at(a, ctx)?;
                s.check_online().map_err(engine_error)?;
                let r = links::broken_links(&s.tree, id, limit);
                if let Some(e) = r.error {
                    return Err(engine_error(e));
                }
                Ok(json!({ "scope": s.tree.path(id), "scan": scan_label(s), "count": r.total, "results": search_rows(&r.rows) }))
            }
            "history" => {
                let h = self.history()?;
                let only = opt_str(a, "path")?.map(|p| tessera_core::scan::normalize_path(p).unwrap_or_else(|_| p.to_string()));
                let list = h.list().map_err(engine_error)?;
                let list: Vec<Value> = list
                    .iter()
                    .filter(|e| only.as_deref().is_none_or(|p| same_root(&e.path, p)))
                    .map(|e| {
                        json!({
                            "id": e.id,
                            "path": e.path,
                            "scannedAt": iso(e.scanned_at),
                            "size": human(e.bytes),
                            "bytes": e.bytes,
                            "files": e.files,
                            "folders": e.dirs
                        })
                    })
                    .collect();
                Ok(json!({ "folder": h.dir(), "count": list.len(), "snapshots": list }))
            }
            "compare_snapshot" => self.compare_tool(a, ctx),
            "size_trend" => {
                let h = self.history()?;
                let (s, id) = self.at(a, ctx)?;
                let t = &s.tree;
                let points = h.node_trend(s, id).map_err(engine_error)?;
                let mut v: Vec<Value> = points
                    .iter()
                    .map(|p| json!({ "scannedAt": iso(p.scanned_at), "snapshot": p.id, "size": p.size.map(human), "bytes": p.size }))
                    .collect();
                v.push(json!({ "scannedAt": iso(s.scanned_at), "snapshot": "current scan", "size": human(t.size(id)), "bytes": t.size(id) }));
                Ok(json!({
                    "path": t.path(id),
                    "points": v,
                    "note": "Oldest first. size null = it did not exist then (snapshots also skip files under 1 MiB)."
                }))
            }
            "save_snapshot" => {
                let h = self.history()?;
                let (s, _) = self.at(a, ctx)?;
                let e = h.save(s).map_err(engine_error)?;
                Ok(json!({
                    "saved": { "id": e.id, "path": e.path, "scannedAt": iso(e.scanned_at), "size": human(e.bytes) },
                    "folder": h.dir(),
                    "note": format!("Compare later with compare_snapshot. The history keeps the {} most recent snapshots of each folder.", tessera_core::history::KEEP)
                }))
            }
            _ => Err(format!("Unknown tool: {name}")),
        }
    }

    fn history(&self) -> Result<History, String> {
        match &self.history {
            Some(d) => Ok(History::at(d.clone())),
            None => History::open().map_err(engine_error),
        }
    }

    /// Escaneo y nodo del argumento `path` (ver [`Self::locate`]).
    fn at(&mut self, a: &Args, ctx: &Ctx) -> Result<(&Scan, u32), String> {
        let (i, id) = self.locate(opt_str(a, "path")?, ctx)?;
        Ok((&self.scans[i].scan, id))
    }

    /// Índice del escaneo en memoria y nodo de `path`: el escaneo más concreto que la contiene (en empate, el
    /// usado más recientemente); si ninguno, escanea `path` (o abre el `.tessera`). Sin `path`, la raíz del
    /// último escaneo usado.
    fn locate(&mut self, path: Option<&str>, ctx: &Ctx) -> Result<(usize, u32), String> {
        let Some(p) = path else {
            return self.scans.len().checked_sub(1).map(|i| (i, 0)).ok_or_else(|| NO_SCAN.to_string());
        };
        if saved::is_saved_scan(p) {
            return Ok((self.open_saved(p)?, 0));
        }
        let raw = p.trim().trim_matches('"');
        let norm = tessera_core::scan::normalize_path(raw).ok();
        // Un `.tessera` guarda las rutas del equipo donde se escaneó: se buscan tal cual
        let best = self
            .scans
            .iter()
            .enumerate()
            .filter_map(|(i, l)| {
                let want = if l.file.is_some() { raw } else { norm.as_deref()? };
                let root = l.scan.tree.root_path();
                contains(root, want).then(|| (root.len(), i, want.to_string()))
            })
            .max_by_key(|&(len, i, _)| (len, i));
        if let Some((_, i, want)) = best {
            let i = self.touch(i);
            let s = &self.scans[i].scan;
            let id = find_node(&s.tree, &want).ok_or_else(|| {
                format!(
                    "{want} is not in the scan of {} ({}): it may be newer than the scan, or unreadable. Call `scan` with this path and refresh: true.",
                    s.tree.root_path(),
                    iso(s.scanned_at)
                )
            })?;
            return Ok((i, id));
        }
        let norm = norm.ok_or_else(|| format!("Invalid path: {p}"))?;
        let s = scan_path(&norm, EngineChoice::Auto, ctx)?;
        Ok((self.add(Loaded { scan: s, file: None }), 0))
    }

    /// Índice del `.tessera` `p`, abierto ahora o antes.
    fn open_saved(&mut self, p: &str) -> Result<usize, String> {
        let file = p.trim().trim_matches('"').to_string();
        if let Some(i) = self.scans.iter().position(|l| l.file.as_deref() == Some(file.as_str())) {
            return Ok(self.touch(i));
        }
        let scan = cmds::open_saved(&file).map_err(engine_error)?;
        Ok(self.add(Loaded { scan, file: Some(file) }))
    }

    /// Pasa el escaneo `i` al final (el usado más recientemente) y devuelve su índice nuevo.
    fn touch(&mut self, i: usize) -> usize {
        let l = self.scans.remove(i);
        self.scans.push(l);
        self.scans.len() - 1
    }

    /// Guarda un escaneo: sustituye a los de su misma raíz o de dentro (éste es más reciente) y olvida el
    /// usado hace más tiempo si pasan de [`MAX_SCANS`]. Devuelve su índice.
    fn add(&mut self, l: Loaded) -> usize {
        let root = l.scan.tree.root_path().to_string();
        match &l.file {
            None => self.scans.retain(|o| o.file.is_some() || !contains(&root, o.scan.tree.root_path())),
            Some(f) => self.scans.retain(|o| o.file.as_ref() != Some(f)),
        }
        self.scans.push(l);
        if self.scans.len() > MAX_SCANS {
            self.scans.remove(0);
        }
        self.scans.len() - 1
    }

    /// `scan`: escanea, o responde desde la memoria si ya está escaneado (con `refresh`, lo pone al día: el
    /// diario USN para la raíz de un escaneo que lo admite y volver a escanear la carpeta si está dentro).
    fn scan_tool(&mut self, a: &Args, ctx: &Ctx) -> Result<Value, String> {
        let path = opt_str(a, "path")?.ok_or("`path` is required: the drive or folder to scan, or a .tessera file")?;
        let refresh = bool_arg(a, "refresh")?;
        let engine: EngineChoice = match opt_str(a, "engine")? {
            None => EngineChoice::Auto,
            Some(e) => e.parse()?,
        };
        if saved::is_saved_scan(path) {
            let i = self.open_saved(path)?;
            return Ok(summary(&self.scans[i].scan, 0, None));
        }
        let norm = tessera_core::scan::normalize_path(path).map_err(engine_error)?;
        let hit = self
            .scans
            .iter()
            .enumerate()
            .filter(|(_, l)| l.file.is_none() && contains(l.scan.tree.root_path(), &norm))
            .max_by_key(|&(i, l)| (l.scan.tree.root_path().len(), i))
            .map(|(i, _)| i);
        if let Some(i) = hit {
            let i = self.touch(i);
            let scan = &mut self.scans[i].scan;
            if let Some(id) = find_node(&scan.tree, &norm) {
                let opts = ScanOptions::default();
                let cb = |p: ScanProgress| ctx.progress(scan_message(&norm, &p));
                if !refresh {
                    let note = (id != 0).then(|| format!("From the scan of {} in memory; refresh: true scans it again.", scan.tree.root_path()));
                    return Ok(summary(scan, id, note.or_else(|| Some("From memory; refresh: true scans it again.".into()))));
                }
                if id == 0 && scan.result.can_refresh == Some(true) {
                    match tessera_core::refresh(scan, &opts, &cb, ctx.cancel()) {
                        Ok(r) => {
                            let note = format!("Updated from the NTFS change journal: {} folders rescanned in {} ms.", r.folders, r.elapsed_ms);
                            return Ok(summary(scan, 0, Some(note)));
                        }
                        Err(e) if e.code == "error.cancelled" => return Err(engine_error(e)),
                        Err(e) => eprintln!("refresh: [{}] {}; se escanea de nuevo", e.code, e.message),
                    }
                } else if id != 0 {
                    let dir = if scan.tree.is_dir(id) { id } else { scan.tree.parent(id).unwrap_or(0) };
                    let r = tessera_core::rescan(scan, dir, &opts, &cb, ctx.cancel()).map_err(engine_error)?;
                    let note = format!("Rescanned inside the scan of {}: was {}, now {}.", scan.tree.root_path(), human(r.before), human(r.row.size));
                    return Ok(summary(scan, dir, Some(note)));
                }
            }
        }
        let s = scan_path(&norm, engine, ctx)?;
        let i = self.add(Loaded { scan: s, file: None });
        Ok(summary(&self.scans[i].scan, 0, None))
    }

    fn duplicates_tool(&mut self, a: &Args, ctx: &Ctx) -> Result<Value, String> {
        let min = match a.get("minSize") {
            None | Some(Value::Null) => 1 << 20,
            Some(Value::Number(n)) => n.as_f64().filter(|v| *v >= 0.0).ok_or("`minSize` must be a size such as \"10MB\" or a byte count")? as u64,
            Some(Value::String(s)) => match cmds::parse_threshold(s)? {
                Threshold::Bytes(b) => b,
                Threshold::Percent(_) => return Err("`minSize` must be a size such as \"10MB\", not a percentage".into()),
            },
            Some(_) => return Err("`minSize` must be a size such as \"10MB\" or a byte count".into()),
        };
        let limit = count(a, "limit", 20, 500)?;
        let (s, id) = self.at(a, ctx)?;
        s.check_online().map_err(engine_error)?;
        let t = &s.tree;
        let cb = |p: DupProgress| {
            let phase = serde_json::to_value(p.phase).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            ctx.progress(format!("Duplicates ({phase}): {}/{} files, {}/{}", sep(p.files), sep(p.total_files), human(p.bytes), human(p.total_bytes)));
        };
        let r = tessera_core::duplicates(t, id, min, limit, &cb, ctx.cancel()).map_err(engine_error)?;
        Ok(json!({
            "scope": t.path(id),
            "scan": scan_label(s),
            "minSize": human(min),
            "groupCount": r.total_groups,
            "reclaimable": human(r.wasted),
            "reclaimableBytes": r.wasted,
            "groups": r.groups.iter().map(|g| json!({
                "size": human(g.size),
                "copies": g.files.len(),
                "wasted": human(g.size * (g.files.len() as u64 - 1)),
                "files": g.files.iter().map(|f| {
                    let mut o = json!({ "path": f.path });
                    if f.node.mtime > 0 {
                        o["modified"] = iso(f.node.mtime as u64).into();
                    }
                    o
                }).collect::<Vec<_>>()
            })).collect::<Vec<_>>(),
            "filesCompared": r.candidates,
            "bytesRead": human(r.read_bytes),
            "skipped": { "hardlinks": r.skipped.hardlinks, "cloudOnly": r.skipped.cloud },
            "elapsedMs": r.elapsed_ms,
            "warnings": r.warnings.iter().map(|w| w.message.as_str()).collect::<Vec<_>>(),
            "note": "Identical content (BLAKE3 of the whole file). Hard links and cloud-only files are not compared."
        }))
    }

    /// `cleanup_candidates`: las reglas de «Liberar espacio» sobre el escaneo en memoria ([`clean::candidates`]).
    fn cleanup_tool(&mut self, a: &Args, ctx: &Ctx) -> Result<Value, String> {
        let only = risks(a)?;
        let limit = count(a, "limit", 50, 500)? as usize;
        let (s, id) = self.at(a, ctx)?;
        let t = &s.tree;
        let os = if names::is_posix(t.root_path()) { "linux" } else { "windows" };
        let progress = |rule: &str, i: usize, n: usize| ctx.progress(format!("Cleanup rules {}/{n}: {rule}", i + 1));
        let cards = clean::candidates(s, id, &progress, ctx.cancel())?;
        let by_risk: Map<String, Value> = Risk::ALL
            .into_iter()
            .map(|r| {
                let of = cards.iter().filter(|c| c.rule.risk == r);
                let bytes: u64 = of.clone().map(|c| c.size).sum();
                (r.key().to_string(), json!({ "label": risk_label(r), "candidates": of.count(), "size": human(bytes), "bytes": bytes }))
            })
            .collect();
        let shown: Vec<&Card> = cards.iter().filter(|c| only.as_ref().is_none_or(|o| o.contains(&c.rule.risk))).collect();
        let scope = t.path(id);
        Ok(json!({
            "scope": scope,
            "scan": scan_label(s),
            "rules": os,
            "byRisk": by_risk,
            "matches": shown.len(),
            "candidates": shown.iter().take(limit).map(|c| cleanup_card(c, &scope, os)).collect::<Vec<_>>(),
            "note": format!(
                "The rules of the Free up space tab in the TesseraFS app; nothing was deleted. Explain each candidate with its why, \
                 prefer its command or how over deleting the folder, and never suggest deleting a risk \"bad\" item by hand. \
                 The user can also mark candidates in the app and send them to the {}.",
                if os == "windows" { "Recycle Bin" } else { "Trash" }
            )
        }))
    }

    fn compare_tool(&mut self, a: &Args, ctx: &Ctx) -> Result<Value, String> {
        let limit = count(a, "limit", 20, tessera_core::history::MAX_LIMIT)?;
        let h = self.history()?;
        let snapshot = opt_str(a, "snapshotId")?.map(str::to_string);
        let (s, _) = self.at(a, ctx)?;
        s.check_online().map_err(engine_error)?;
        let t = &s.tree;
        let id = match snapshot {
            Some(id) => id,
            None => h
                .list()
                .map_err(engine_error)?
                .into_iter()
                .find(|e| e.scanned_at != s.scanned_at && same_root(&e.path, t.root_path()))
                .map(|e| e.id)
                .ok_or_else(|| {
                    format!(
                        "There is no snapshot of {} to compare with. Save one now with save_snapshot and compare in a later session \
                         (the TesseraFS app and its scheduled scan also save them).",
                        t.root_path()
                    )
                })?,
        };
        let r = h.compare(s, &id, limit).map_err(engine_error)?;
        let changes = |v: &[tessera_core::ChangeRow]| -> Vec<Value> {
            v.iter()
                .map(|c| {
                    let mut n = c.row.node.clone();
                    (n.prev, n.fresh) = (c.prev, c.prev.is_none().then_some(true));
                    row(&n, c.row.path.clone())
                })
                .collect()
        };
        Ok(json!({
            "root": t.root_path(),
            "snapshot": { "id": r.entry.id, "scannedAt": iso(r.entry.scanned_at) },
            "now": iso(s.scanned_at),
            "before": totals(&r.before),
            "after": totals(&r.after),
            "change": signed(r.after.bytes as i64 - r.before.bytes as i64),
            "grew": changes(&r.grew),
            "shrank": changes(&r.shrank),
            "removed": r.removed.iter().map(|x| json!({ "path": x.path, "type": kind(x.is_dir), "size": human(x.size) })).collect::<Vec<_>>(),
            "note": "The comparison stays active: list_folder with sort \"change\" shows what changed inside any folder."
        }))
    }
}

// ---------- Herramientas ----------

fn tool(name: &str, title: &str, description: &str, properties: Value, required: &[&str], read_only: bool) -> Value {
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": schema,
        "annotations": { "title": title, "readOnlyHint": read_only, "destructiveHint": false, "idempotentHint": read_only, "openWorldHint": false }
    })
}

fn tools() -> Value {
    let path = json!({ "type": "string", "description": PATH_HELP });
    let int = |d: &str| json!({ "type": "integer", "minimum": 0, "description": d });
    json!([
        tool(
            "list_volumes",
            "Drives and free space",
            "List the drives (Windows) or mounted file systems (Linux) with size and free space, without scanning. \
             Also says whether TesseraFS runs as administrator (whole NTFS drives then scan in seconds through the MFT).",
            json!({}),
            &[],
            true
        ),
        tool(
            "scan",
            "Scan a drive or folder",
            "Scan a drive or folder (or open a .tessera saved scan) and keep it in memory for the other tools. Returns the totals, \
             the largest items inside and, for a drive, its free space. If a scan in memory already contains the path, answers from \
             it at once; refresh: true updates it (NTFS change journal for a whole drive, or rescans just that folder).",
            json!({
                "path": { "type": "string", "description": "Drive or folder to scan (C:\\, D:\\Projects, /home/ana) or a .tessera file" },
                "refresh": { "type": "boolean", "description": "Update the data even if it is already in memory (default false)" },
                "engine": { "type": "string", "enum": ["auto", "walk", "mft"], "description": "auto (default): MFT for a whole NTFS drive when running as administrator, otherwise a folder walk" }
            }),
            &["path"],
            true
        ),
        tool(
            "largest",
            "Largest files and folders",
            "The largest files (at any depth) and the largest folders (at a given depth) under a folder.",
            json!({
                "path": path,
                "files": int("How many files (default 20, max 500)"),
                "folders": int("How many folders (default 10, max 500)"),
                "depth": int("Folder depth: 1 = direct subfolders (default), 2 = their subfolders…")
            }),
            &[],
            true
        ),
        tool(
            "list_folder",
            "List a folder",
            "The items directly inside a folder with their total size, file count and date, largest first by default. \
             Use it to drill down step by step.",
            json!({
                "path": path,
                "sort": { "type": "string", "enum": ["size", "name", "modified", "files", "onDisk", "change"], "description": "Order (default size). change = growth since the snapshot of compare_snapshot" },
                "limit": int("Items (default 50, max 1000)"),
                "offset": int("Items to skip, for paging (default 0)")
            }),
            &[],
            true
        ),
        tool(
            "search",
            "Search with filters",
            "Find files or folders under a path with the TesseraFS filter language (size, age, extension, path, attributes…). \
             Returns the matches largest first, plus the count and total size of all matches.",
            json!({
                "query": { "type": "string", "description": QUERY_HELP },
                "path": path,
                "limit": int("Rows (default 50, max 2000); the count and total size always cover all matches")
            }),
            &[],
            true
        ),
        tool(
            "file_types",
            "Space by file type",
            "Space used by each file extension under a folder, largest first.",
            json!({ "path": path, "limit": int("Extensions (default 25)") }),
            &[],
            true
        ),
        tool(
            "cleanup_candidates",
            "What can be cleaned up",
            "What the Free up space tab of the TesseraFS app would propose inside a folder, with the same rules: build output and \
             dependencies (target, node_modules, .venv), package, browser and shader caches, temporary files, crash dumps, update \
             leftovers, the Recycle Bin or Trash, local AI models, virtual disks, games, installers in Downloads, folders that declare \
             themselves a cache (CACHEDIR.TAG), empty folders and files, broken links… Each candidate has its risk (ok = regenerates \
             itself or is temporary; warn = the user's own data: they decide; bad = managed by the system: never delete it by hand), \
             size, why, how and the program's own cleanup command when there is one. Safest first, then largest. Read-only.",
            json!({
                "path": path,
                "risk": { "type": "string", "description": "Only these risks, comma-separated: ok, warn, bad (default: all)" },
                "limit": int("Candidates (default 50, max 500); byRisk always covers all of them")
            }),
            &[],
            true
        ),
        tool(
            "find_duplicates",
            "Find duplicate files",
            "Find files with identical content under a folder (same size, then BLAKE3 of the content). Reads the candidate files, \
             so a large folder can take minutes; raise minSize to go faster.",
            json!({
                "path": path,
                "minSize": { "type": ["string", "integer"], "description": "Smallest file size to compare: \"10MB\", \"1GB\" or bytes (default 1MB)" },
                "limit": int("Groups to return, most space wasted first (default 20, max 500)")
            }),
            &[],
            true
        ),
        tool(
            "broken_links",
            "Broken links",
            "Symbolic links, junctions and mount points under a folder whose target no longer exists.",
            json!({ "path": path, "limit": int("Rows (default 50)") }),
            &[],
            true
        ),
        tool(
            "history",
            "Saved snapshots",
            "The scan snapshots in the TesseraFS history (saved by the app, its scheduled scan or save_snapshot), newest first.",
            json!({ "path": { "type": "string", "description": "Only the snapshots of this scanned root (optional)" } }),
            &[],
            true
        ),
        tool(
            "compare_snapshot",
            "What changed",
            "Compare the scan in memory with a saved snapshot of the same root: what grew, shrank or disappeared since then.",
            json!({
                "path": path,
                "snapshotId": { "type": "string", "description": "Snapshot id from history (default: the most recent one of this root)" },
                "limit": int("Rows per list (default 20)")
            }),
            &[],
            true
        ),
        tool(
            "size_trend",
            "Size over time",
            "Size of a file or folder in every saved snapshot of its root, oldest first, plus the current scan.",
            json!({ "path": path }),
            &[],
            true
        ),
        tool(
            "save_snapshot",
            "Save a snapshot",
            "Save a summary of the scan containing path to the TesseraFS history, to compare against it later (compare_snapshot, \
             size_trend or the app's Changes tab). Writes only to the history folder; like the app, it keeps the most recent \
             snapshots of each root and removes older ones.",
            json!({ "path": path }),
            &[],
            false
        ),
    ])
}

// ---------- Argumentos ----------

fn opt_str<'a>(a: &'a Args, k: &str) -> Result<Option<&'a str>, String> {
    match a.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(format!("`{k}` must be a string")),
    }
}

/// Entero no negativo (también en texto: algunos modelos lo mandan así), como mucho `max`.
fn count(a: &Args, k: &str, default: u32, max: u32) -> Result<u32, String> {
    let Some(v) = a.get(k).filter(|v| !v.is_null()) else { return Ok(default) };
    let n = v
        .as_u64()
        .or_else(|| v.as_f64().filter(|f| *f >= 0.0 && f.fract() == 0.0).map(|f| f as u64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .ok_or_else(|| format!("`{k}` must be a non-negative integer"))?;
    Ok(n.min(max as u64) as u32)
}

/// `risk`: «ok», «warn,bad» o una lista; `None` = todos.
fn risks(a: &Args) -> Result<Option<Vec<Risk>>, String> {
    const BAD: &str = "`risk` must be ok, warn or bad, or several of them separated by commas";
    let words: Vec<String> = match a.get("risk") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => s.split(',').map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty()).collect(),
        Some(Value::Array(v)) => v.iter().map(|w| w.as_str().map(|w| w.trim().to_lowercase()).ok_or(BAD)).collect::<Result<_, _>>()?,
        Some(_) => return Err(BAD.into()),
    };
    if words.is_empty() {
        return Ok(None);
    }
    let pick = |w: &String| Risk::ALL.into_iter().find(|r| r.key() == w).ok_or_else(|| format!("Unknown risk \"{w}\": use ok, warn or bad"));
    words.iter().map(pick).collect::<Result<Vec<_>, _>>().map(Some)
}

fn bool_arg(a: &Args, k: &str) -> Result<bool, String> {
    match a.get(k) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::String(s)) if s == "true" || s == "false" => Ok(s == "true"),
        Some(_) => Err(format!("`{k}` must be true or false")),
    }
}

// ---------- Rutas ----------

/// `path` es `root` o está dentro: en Windows sin distinguir mayúsculas y con `\` o `/`.
pub(crate) fn contains(root: &str, path: &str) -> bool {
    let posix = names::is_posix(root);
    let key = |s: &str| if posix { s.to_string() } else { s.replace('/', "\\").to_lowercase() };
    let sep = if posix { '/' } else { '\\' };
    let (r, p) = (key(root), key(path));
    let r = r.trim_end_matches(sep);
    p == r || p.strip_prefix(r).is_some_and(|rest| rest.starts_with(sep))
}

fn same_root(a: &str, b: &str) -> bool {
    contains(a, b) && contains(b, a)
}

// ---------- Resultados ----------

fn engine_error(e: EngineMessage) -> String {
    format!("{} [{}]", e.message, e.code)
}

fn scan_path(path: &str, engine: EngineChoice, ctx: &Ctx) -> Result<Scan, String> {
    let cb = |p: ScanProgress| ctx.progress(scan_message(path, &p));
    tessera_core::scan(path, engine, &ScanOptions::default(), &cb, ctx.cancel()).map_err(engine_error)
}

fn scan_message(path: &str, p: &ScanProgress) -> String {
    let phase = serde_json::to_value(p.phase).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    format!("Scanning {path} ({phase}): {} items, {}", sep(p.entries), human(p.bytes))
}

/// «C:\ scanned 2026-10-15T08:00:00Z», y de dónde viene si se abrió desde un `.tessera`.
fn scan_label(s: &Scan) -> String {
    let mut l = format!("{} scanned {}", s.result.root_path, iso(s.scanned_at));
    if let Some(o) = &s.result.offline {
        l.push_str(&format!(" (saved scan from {}: read-only, no disk access)", o.host.as_deref().unwrap_or("another computer")));
    }
    l
}

fn kind(is_dir: bool) -> &'static str {
    if is_dir {
        "folder"
    } else {
        "file"
    }
}

/// Atributos que importan al explicar el espacio.
fn attributes(flags: u16) -> Vec<&'static str> {
    [
        (flag::CLOUD, "cloud"),
        (flag::COMPRESSED, "compressed"),
        (flag::SPARSE, "sparse"),
        (flag::HARDLINK, "hardlink"),
        (flag::REPARSE, "link"),
        (flag::HIDDEN, "hidden"),
        (flag::SYSTEM, "system"),
    ]
    .into_iter()
    .filter(|&(f, _)| flags & f != 0)
    .map(|(_, n)| n)
    .collect()
}

/// Una fila: tamaño legible y en bytes, espacio en disco si difiere mucho (comprimido, en la nube, muchos
/// archivos pequeños), contenido de las carpetas, fecha, atributos y, con una comparación activa, el cambio.
fn row(n: &NodeRow, path: String) -> Value {
    let mut o = Map::new();
    o.insert("path".into(), path.into());
    o.insert("type".into(), kind(n.is_dir).into());
    o.insert("size".into(), human(n.size).into());
    o.insert("bytes".into(), n.size.into());
    if n.alloc.abs_diff(n.size) > (n.size / 10).max(1 << 20) {
        o.insert("onDisk".into(), human(n.alloc).into());
    }
    if n.is_dir {
        o.insert("files".into(), n.files.into());
        o.insert("folders".into(), n.dirs.into());
    }
    if n.mtime > 0 {
        o.insert("modified".into(), iso(n.mtime as u64).into());
    }
    let attrs = attributes(n.flags);
    if !attrs.is_empty() {
        o.insert("attributes".into(), attrs.into());
    }
    match (n.prev, n.fresh) {
        (Some(p), _) => {
            o.insert("before".into(), human(p).into());
            o.insert("change".into(), signed(n.size as i64 - p as i64).into());
        }
        (None, Some(true)) => {
            o.insert("new".into(), true.into());
        }
        _ => {}
    }
    Value::Object(o)
}

fn node_row(t: &Tree, id: u32) -> Value {
    row(&t.row(id), t.path(id))
}

fn search_rows(rows: &[tessera_core::SearchRow]) -> Vec<Value> {
    rows.iter().map(|r| row(&r.node, r.path.clone())).collect()
}

fn totals(t: &Totals) -> Value {
    json!({ "size": human(t.bytes), "bytes": t.bytes, "files": t.files, "folders": t.dirs })
}

fn volume(v: &VolumeInfo) -> Value {
    let pct = if v.total > 0 { (v.free as f64 * 1000.0 / v.total as f64).round() / 10.0 } else { 0.0 };
    json!({
        "path": v.path,
        "label": v.label,
        "fileSystem": v.fs,
        "size": human(v.total),
        "free": human(v.free),
        "freeBytes": v.free,
        "freePercent": pct
    })
}

fn list_volumes() -> Value {
    json!({
        "volumes": sys::volumes().iter().map(volume).collect::<Vec<_>>(),
        "administrator": sys::elevation().elevated
    })
}

/// Lo que devuelve `scan`: totales del nodo, lo más grande dentro y, en la raíz, el volumen y los avisos.
fn summary(s: &Scan, id: u32, note: Option<String>) -> Value {
    let (t, r) = (&s.tree, &s.result);
    let mut o = json!({
        "path": t.path(id),
        "scan": scan_label(s),
        "size": human(t.size(id)),
        "bytes": t.size(id),
        "onDisk": human(t.alloc(id)),
        "files": t.files(id),
        "folders": t.dirs(id)
    });
    if id == 0 {
        o["engine"] = json!(r.engine);
        o["elapsedMs"] = r.elapsed_ms.into();
        if let Some(v) = &r.volume {
            o["volume"] = volume(v);
        }
        if !r.warnings.is_empty() {
            o["warnings"] = r.warnings.iter().map(|w| w.message.as_str()).collect::<Vec<_>>().into();
        }
    }
    if let Ok(c) = ops::children(t, id, 0, 15, SortKey::Size, true) {
        o["largestItems"] = c.rows.iter().map(|n| row(n, t.path(n.id))).collect::<Vec<_>>().into();
    }
    if let Some(n) = note {
        o["note"] = n.into();
    }
    o
}

/// «Safe», «Review», «Don’t delete by hand»: como en la app.
fn risk_label(r: Risk) -> String {
    clean::text(&format!("clean.risk.{}", r.key()), &[], "windows").unwrap_or_else(|| r.key().into())
}

/// Un candidato de `cleanup_candidates` con los textos ingleses de la app: título, riesgo, tamaño, por qué, cómo
/// y la orden. Una tarjeta de resumen (vacíos, enlaces rotos) dice cuántos hay, algunos y cómo verlos todos.
fn cleanup_card(c: &Card, scope: &str, os: &str) -> Value {
    let r = c.rule;
    let text = |key: String| clean::text(&key, &[], os);
    let mut o = Map::new();
    o.insert("title".into(), clean::text(&c.title.0, &c.title.1, os).unwrap_or_else(|| r.id.clone()).into());
    o.insert("risk".into(), r.risk.key().into());
    o.insert("riskLabel".into(), risk_label(r.risk).into());
    match c.total {
        Some(n) => {
            o.insert("items".into(), n.into());
            o.insert("size".into(), human(c.size).into());
            o.insert("examples".into(), c.sample.clone().into());
            let all = match r.list {
                Some(clean::List::Links) => json!({ "tool": "broken_links", "arguments": { "path": scope } }),
                _ => json!({ "tool": "search", "arguments": { "query": r.q, "path": scope, "limit": n.min(2000) } }),
            };
            o.insert("listAll".into(), all);
        }
        None => {
            o.insert("path".into(), c.path.clone().into());
            o.insert("type".into(), kind(c.is_dir).into());
            o.insert("size".into(), human(c.size).into());
            o.insert("bytes".into(), c.size.into());
            if r.use_alloc {
                o.insert("sizeIs".into(), "space on disk: what freeing it recovers".into());
            }
        }
    }
    if !c.files.is_empty() {
        o.insert("fileCount".into(), c.files.len().into());
        let files: Vec<Value> = c.files.iter().take(10).map(|f| json!({ "path": f.path, "size": human(f.node.size) })).collect();
        o.insert("files".into(), files.into());
    }
    if let Some(why) = text(format!("clean.{}.why", r.id)) {
        o.insert("why".into(), why.into());
    }
    if let Some(how) = r.how.as_ref().and_then(|h| text(format!("clean.{h}.how"))) {
        o.insert("how".into(), how.into());
    }
    if let Some(cmd) = &c.cmd {
        o.insert("command".into(), cmd.clone().into());
    }
    // OneDrive: la app tiene su propio botón, que deja los archivos sólo en la nube sin borrar nada
    if let Some(button) = r.action.as_deref().filter(|a| *a == "freeUp").and_then(|_| text("clean.freeUp".into())) {
        o.insert("appButton".into(), button.into());
    }
    o.insert("rule".into(), r.id.clone().into());
    Value::Object(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// datos/ → grande.bin 3 MiB, copia/grande.bin 3 MiB (duplicado), sub/x.txt, notas.md
    fn sample(tag: &str) -> Dir {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tessera-mcp-{tag}-{}-{nanos}", std::process::id()));
        let d = dir.join("datos");
        std::fs::create_dir_all(d.join("copia")).unwrap();
        std::fs::create_dir_all(d.join("sub")).unwrap();
        let big = vec![7u8; 3 << 20];
        std::fs::write(d.join("grande.bin"), &big).unwrap();
        std::fs::write(d.join("copia").join("grande.bin"), &big).unwrap();
        std::fs::write(d.join("sub").join("x.txt"), b"hola").unwrap();
        std::fs::write(d.join("notas.md"), b"# notas").unwrap();
        Dir(dir)
    }

    fn rpc(s: &mut Server, io: &Io, id: u64, method: &str, params: Value) -> Value {
        s.dispatch(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }), io).expect("respuesta")
    }

    /// (texto JSON de la herramienta ya analizado, isError)
    fn call(s: &mut Server, io: &Io, name: &str, args: Value) -> (Value, bool) {
        let r = rpc(s, io, 9, "tools/call", json!({ "name": name, "arguments": args }));
        let text = r["result"]["content"][0]["text"].as_str().unwrap_or_else(|| panic!("{r}")).to_string();
        let err = r["result"]["isError"] == true;
        (serde_json::from_str(&text).unwrap_or(Value::String(text)), err)
    }

    #[test]
    fn protocol() {
        let (mut s, io) = (Server::new(None), Io::new());
        let r = rpc(&mut s, &io, 1, "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }));
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "tesserafs");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        // Una versión desconocida recibe la más reciente
        let r = rpc(&mut s, &io, 2, "initialize", json!({ "protocolVersion": "1999-01-01" }));
        assert_eq!(r["result"]["protocolVersion"], VERSIONS[0]);
        assert!(s.dispatch(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), &io).is_none());
        assert_eq!(rpc(&mut s, &io, 3, "ping", json!({}))["result"], json!({}));
        let tools = rpc(&mut s, &io, 4, "tools/list", json!({}))["result"]["tools"].clone();
        let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 13);
        assert!(names.contains(&"cleanup_candidates"));
        for t in tools.as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object", "{t}");
            assert!(t["description"].as_str().unwrap().len() > 20);
            let ro = t["annotations"]["readOnlyHint"] == true;
            assert_eq!(ro, t["name"] != "save_snapshot");
        }
        let r = rpc(&mut s, &io, 5, "nada/raro", json!({}));
        assert_eq!(r["error"]["code"], METHOD_NOT_FOUND);
        let r = rpc(&mut s, &io, 6, "tools/call", json!({ "name": "borrar_todo" }));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        // Lote: sólo responden las peticiones
        let r = s.dispatch(json!([{ "jsonrpc": "2.0", "id": 7, "method": "ping" }, { "jsonrpc": "2.0", "method": "notifications/initialized" }]), &io).unwrap();
        assert_eq!(r.as_array().unwrap().len(), 1);
        // Las respuestas del cliente no se contestan
        assert!(s.dispatch(json!({ "jsonrpc": "2.0", "id": 8, "result": {} }), &io).is_none());
        // Sin escaneo y sin ruta: error de herramienta, no de protocolo
        let (v, err) = call(&mut s, &io, "largest", json!({}));
        assert!(err && v.as_str().unwrap().starts_with("No scan in memory"), "{v}");
    }

    #[test]
    fn tools_on_a_folder() {
        let dir = sample("tools");
        let (mut s, io) = (Server::new(Some(dir.0.join("history"))), Io::new());
        let root = dir.0.join("datos").to_string_lossy().into_owned();
        let (v, err) = call(&mut s, &io, "scan", json!({ "path": root }));
        assert!(!err, "{v}");
        assert_eq!((v["files"].as_u64(), v["folders"].as_u64()), (Some(4), Some(2)));
        assert_eq!(v["bytes"].as_u64(), Some((6 << 20) + 11));
        assert_eq!(v["largestItems"][0]["type"], "folder");
        // Desde la memoria
        let (v, _) = call(&mut s, &io, "scan", json!({ "path": root }));
        assert!(v["note"].as_str().unwrap().starts_with("From memory"), "{v}");
        let (v, _) = call(&mut s, &io, "largest", json!({ "files": 2, "folders": 5 }));
        assert_eq!(v["largestFiles"].as_array().unwrap().len(), 2);
        assert_eq!(v["largestFiles"][0]["size"], "3.00 MiB");
        assert_eq!(v["largestFolders"].as_array().unwrap().len(), 2);
        // Una carpeta de dentro, con barras de cualquier tipo
        let sub = format!("{root}/sub");
        let (v, err) = call(&mut s, &io, "list_folder", json!({ "path": sub }));
        assert!(!err, "{v}");
        assert_eq!(v["total"], 1);
        assert!(v["items"][0]["path"].as_str().unwrap().ends_with("x.txt"));
        let (v, _) = call(&mut s, &io, "list_folder", json!({ "sort": "name", "limit": "2" }));
        assert_eq!(v["total"], 4);
        assert_eq!(v["items"].as_array().unwrap().len(), 2);
        let (v, err) = call(&mut s, &io, "list_folder", json!({ "sort": "change" }));
        assert!(err && v.as_str().unwrap().contains("compare_snapshot"));
        // Búsqueda
        let (v, _) = call(&mut s, &io, "search", json!({ "query": "ext:bin size:>1m" }));
        assert_eq!((v["matches"].as_u64(), v["totalBytes"].as_u64()), (Some(2), Some(6 << 20)));
        let (v, _) = call(&mut s, &io, "search", json!({ "query": "type:dir", "path": sub }));
        assert_eq!(v["matches"], 0);
        let (v, err) = call(&mut s, &io, "search", json!({ "query": "size:>abc" }));
        assert!(err && v.as_str().unwrap().starts_with("Invalid query"), "{v}");
        let (v, _) = call(&mut s, &io, "file_types", json!({}));
        assert_eq!(v["types"][0]["ext"], "bin");
        assert_eq!(v["typeCount"], 3);
        // Duplicados
        let (v, err) = call(&mut s, &io, "find_duplicates", json!({ "minSize": "1MB" }));
        assert!(!err, "{v}");
        assert_eq!((v["groupCount"].as_u64(), v["reclaimableBytes"].as_u64()), (Some(1), Some(3 << 20)));
        assert_eq!(v["groups"][0]["files"].as_array().unwrap().len(), 2);
        let (v, err) = call(&mut s, &io, "find_duplicates", json!({ "minSize": "10%" }));
        assert!(err, "{v}");
        // Lo que no está en el escaneo
        let (v, err) = call(&mut s, &io, "list_folder", json!({ "path": format!("{root}/no-existe") }));
        assert!(err && v.as_str().unwrap().contains("refresh: true"), "{v}");
        // Un archivo creado después: refresh vuelve a escanear su carpeta dentro del escaneo
        std::fs::write(dir.0.join("datos").join("sub").join("nuevo.txt"), vec![1u8; 1000]).unwrap();
        let (v, err) = call(&mut s, &io, "scan", json!({ "path": sub, "refresh": true }));
        assert!(!err && v["note"].as_str().unwrap().starts_with("Rescanned"), "{v}");
        let (v, _) = call(&mut s, &io, "list_folder", json!({ "path": sub }));
        assert_eq!(v["total"], 2);
        assert_eq!(s.scans.len(), 1, "sigue siendo el mismo escaneo");
    }

    #[test]
    fn history_compare_and_trend() {
        let dir = sample("history");
        let (mut s, io) = (Server::new(Some(dir.0.join("history"))), Io::new());
        let root = dir.0.join("datos").to_string_lossy().into_owned();
        call(&mut s, &io, "scan", json!({ "path": root }));
        let (v, err) = call(&mut s, &io, "compare_snapshot", json!({}));
        assert!(err && v.as_str().unwrap().starts_with("There is no snapshot"), "{v}");
        let (v, err) = call(&mut s, &io, "save_snapshot", json!({}));
        assert!(!err, "{v}");
        let (v, _) = call(&mut s, &io, "history", json!({ "path": root }));
        assert_eq!(v["count"], 1);
        // Otro escaneo (más tarde) con un archivo nuevo
        std::fs::write(dir.0.join("datos").join("sub").join("nuevo.bin"), vec![2u8; 2 << 20]).unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        let (v, err) = call(&mut s, &io, "scan", json!({ "path": root, "refresh": true }));
        assert!(!err, "{v}");
        let (v, err) = call(&mut s, &io, "compare_snapshot", json!({}));
        assert!(!err, "{v}");
        assert_eq!(v["change"], "+2.00 MiB");
        // Lo que explica el cambio: el archivo nuevo, no su carpeta
        assert!(v["grew"][0]["path"].as_str().unwrap().ends_with("nuevo.bin") && v["grew"][0]["new"] == true, "{v}");
        let (v, _) = call(&mut s, &io, "list_folder", json!({ "sort": "change", "limit": 1 }));
        assert_eq!(v["items"][0]["change"], "+2.00 MiB", "{v}");
        let (v, err) = call(&mut s, &io, "size_trend", json!({ "path": format!("{root}/sub") }));
        assert!(!err, "{v}");
        let points = v["points"].as_array().unwrap();
        assert_eq!(points.len(), 2, "{v}");
        assert_eq!(points[1]["bytes"].as_u64(), Some((2 << 20) + 4));
        let (_, err) = call(&mut s, &io, "history", json!({ "path": dir.0.join("otra").to_string_lossy() }));
        assert!(!err);
    }

    /// Carpeta junto al ejecutable de las pruebas (en target/) y no en el temporal del sistema: en Windows está
    /// dentro de AppData, que las reglas de limpieza tratan como programas instalados.
    fn scratch(tag: &str) -> Dir {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let exe = std::env::current_exe().unwrap();
        let dir = exe.parent().and_then(|d| d.parent()).unwrap().join("mcp-tests").join(format!("{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Dir(dir)
    }

    /// Un archivo de `mib` MiB sin escribirlos.
    fn big(p: &std::path::Path, mib: u64) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::File::create(p).unwrap().set_len(mib << 20).unwrap();
    }

    #[test]
    fn cleanup_candidates_like_the_app() {
        let dir = scratch("clean");
        let p = dir.0.join("proj");
        let tag = "Signature: 8a477f597d28d172789f06886806bc55\n";
        big(&p.join("web/node_modules/pkg/index.js"), 21);
        big(&p.join("web/node_modules/x/node_modules/big.bin"), 21); // anidada: ya cuenta en la de fuera
        big(&p.join("api/.venv/lib.bin"), 21);
        std::fs::create_dir_all(p.join("small/node_modules")).unwrap();
        std::fs::write(p.join("small/node_modules/a.js"), b"x").unwrap(); // menos del mínimo
        big(&p.join("lamina/target/debug/app.rlib"), 51);
        std::fs::write(p.join("lamina/target/CACHEDIR.TAG"), tag).unwrap();
        big(&p.join("otro/target/out.bin"), 51); // sin CACHEDIR.TAG ni .rustc_info.json: no es de Cargo
        big(&p.join("restic/e4b1/pack.bin"), 60);
        std::fs::write(p.join("restic/e4b1/CACHEDIR.TAG"), tag).unwrap();
        std::fs::create_dir_all(p.join("vacia")).unwrap();
        std::fs::create_dir_all(p.join("notas")).unwrap();
        std::fs::write(p.join("notas/vacio.txt"), b"").unwrap();

        let (mut s, io) = (Server::new(Some(dir.0.join("history"))), Io::new());
        let root = p.to_string_lossy().into_owned();
        let (v, err) = call(&mut s, &io, "cleanup_candidates", json!({ "path": root }));
        assert!(!err, "{v}");
        let c = v["candidates"].as_array().unwrap();
        // Lo seguro primero y, dentro, lo más grande. La caché declarada de target/ ya tiene tarjeta: no se repite
        let rules: Vec<&str> = c.iter().map(|c| c["rule"].as_str().unwrap()).collect();
        assert_eq!(rules, ["cacheTag", "rustTarget", "nodeModules", "venv", "emptyFolders", "emptyFiles"], "{v}");
        let path = |i: usize| c[i]["path"].as_str().unwrap().replace('\\', "/");
        assert!(path(0).ends_with("proj/restic/e4b1") && path(1).ends_with("proj/lamina/target"), "{v}");
        assert!(path(2).ends_with("proj/web/node_modules"), "{v}");
        assert_eq!(c[0]["title"], "Declared cache: restic › e4b1");
        assert_eq!((&c[1]["title"], &c[1]["command"]), (&json!("Rust build output"), &json!("cargo clean")));
        let nm = &c[2];
        assert_eq!((nm["risk"].as_str(), nm["riskLabel"].as_str(), nm["type"].as_str()), (Some("ok"), Some("Safe"), Some("folder")));
        assert_eq!((nm["title"].as_str(), nm["command"].as_str()), (Some("Node dependencies"), Some("bun install")));
        assert_eq!(nm["why"], "They’re reinstalled from the project’s package.json and lockfile.");
        assert_eq!(nm["bytes"].as_u64(), Some(42 << 20));
        assert_eq!(c[3]["command"], "uv sync");
        // Tarjetas de resumen: cuántos hay, algunos y con qué verlos todos
        let empty = &c[4];
        assert_eq!((empty["risk"].as_str(), empty["items"].as_u64()), (Some("warn"), Some(1)), "{v}");
        assert!(empty["examples"][0].as_str().unwrap().ends_with("vacia"));
        assert_eq!(empty["listAll"]["tool"], "search");
        assert!(empty["listAll"]["arguments"]["query"].as_str().unwrap().starts_with("type:dir files:=0 "));
        assert!(c[5]["examples"][0].as_str().unwrap().ends_with("vacio.txt"));
        assert!(!v.to_string().contains("otro") && !v.to_string().contains("small"), "{v}");
        assert_eq!((v["byRisk"]["ok"]["candidates"].as_u64(), v["byRisk"]["warn"]["candidates"].as_u64()), (Some(4), Some(2)));
        assert_eq!(v["byRisk"]["bad"]["label"], "Don’t delete by hand");
        assert_eq!(v["rules"], if cfg!(windows) { "windows" } else { "linux" });

        // Filtro por riesgo y límite; byRisk sigue contando todo
        let (v, _) = call(&mut s, &io, "cleanup_candidates", json!({ "risk": "warn" }));
        assert_eq!(v["matches"], 2);
        assert!(v["candidates"].as_array().unwrap().iter().all(|c| c["risk"] == "warn"));
        assert_eq!(v["byRisk"]["ok"]["candidates"], 4);
        let (v, _) = call(&mut s, &io, "cleanup_candidates", json!({ "risk": "OK, bad", "limit": 1 }));
        assert_eq!((v["matches"].as_u64(), v["candidates"].as_array().unwrap().len()), (Some(4), 1));
        let (v, _) = call(&mut s, &io, "cleanup_candidates", json!({ "risk": ["warn"] }));
        assert_eq!(v["matches"], 2);
        let (v, err) = call(&mut s, &io, "cleanup_candidates", json!({ "risk": "peligroso" }));
        assert!(err && v.as_str().unwrap().contains("Unknown risk"), "{v}");
        let (_, err) = call(&mut s, &io, "cleanup_candidates", json!({ "risk": 3 }));
        assert!(err);

        // Dentro de una carpeta: sólo lo que hay dentro, nunca la propia carpeta
        let (v, _) = call(&mut s, &io, "cleanup_candidates", json!({ "path": format!("{root}/web") }));
        let rules: Vec<&str> = v["candidates"].as_array().unwrap().iter().map(|c| c["rule"].as_str().unwrap()).collect();
        assert_eq!(rules, ["nodeModules"], "{v}");
        let (v, _) = call(&mut s, &io, "cleanup_candidates", json!({ "path": format!("{root}/web/node_modules") }));
        assert_eq!(v["matches"], 0, "{v}");
        // Sólo lee
        assert!(p.join("web/node_modules/pkg/index.js").exists() && p.join("vacia").exists());
    }

    #[test]
    fn cache_and_paths() {
        assert!(contains("C:\\", "c:\\Users") && contains("C:\\Users", "c:/users/ana") && contains("C:\\Users", "C:\\USERS"));
        assert!(!contains("C:\\Users", "C:\\Users2") && !contains("C:\\Users", "D:\\Users"));
        assert!(contains("/", "/home") && contains("/srv", "/srv/a") && !contains("/srv", "/srvx") && !contains("/srv", "/SRV"));
        assert!(same_root("C:\\Users", "c:\\users") && !same_root("C:\\", "C:\\Users"));
        let a = sample("cache-a");
        let b = sample("cache-b");
        let (mut s, io) = (Server::new(None), Io::new());
        let ra = a.0.join("datos").to_string_lossy().into_owned();
        let rb = b.0.join("datos").to_string_lossy().into_owned();
        call(&mut s, &io, "scan", json!({ "path": format!("{ra}/sub") }));
        call(&mut s, &io, "scan", json!({ "path": rb }));
        // El escaneo de la carpeta de fuera sustituye al de dentro
        call(&mut s, &io, "scan", json!({ "path": ra }));
        assert_eq!(s.scans.len(), 2);
        // Sin ruta: el usado más recientemente
        let (v, _) = call(&mut s, &io, "largest", json!({ "files": 1, "folders": 0 }));
        assert!(v["path"].as_str().unwrap().starts_with(ra.as_str()), "{v}");
        call(&mut s, &io, "largest", json!({ "path": rb }));
        let (v, _) = call(&mut s, &io, "largest", json!({}));
        assert!(v["path"].as_str().unwrap().starts_with(rb.as_str()), "{v}");
        let (v, err) = call(&mut s, &io, "scan", json!({}));
        assert!(err && v.as_str().unwrap().contains("required"));
        let (v, err) = call(&mut s, &io, "scan", json!({ "path": rb, "engine": "rápido" }));
        assert!(err && v.as_str().unwrap().contains("Unknown engine"));
    }
}
