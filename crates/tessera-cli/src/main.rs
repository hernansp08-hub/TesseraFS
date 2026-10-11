//! tessera-cli: escanea una ruta e imprime el resumen; lista los archivos y carpetas más grandes
//! (tabla, CSV o JSON); comprueba el espacio libre de un volumen sin escanear; gestiona el
//! historial y, para pruebas cruzadas, escribe un slice binario o un volcado JSON.

mod cmds;

use std::io::Write;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use tessera_core::{ops, slice, ChangeRow, DupProgress, EngineChoice, History, ScanOptions, ScanPhase, ScanProgress, SortKey, Tree};

const USO: &str = "tessera-cli: línea de comandos de TesseraFS (analizador de espacio en disco)

Uso:
  tessera-cli scan <ruta> [opciones de scan]        Escanea e imprime el resumen
  tessera-cli top <ruta> [opciones de top]          Los archivos y carpetas más grandes (tabla, CSV o JSON)
  tessera-cli check <ruta> --min-free <umbral>      Comprueba el espacio libre del volumen, sin escanear
  tessera-cli history [list | delete <id> | clear]  Historial (JSON; respeta TESSERA_HISTORY_DIR)
  tessera-cli --help                                Esta ayuda (también `help` o `<orden> --help`)

top <ruta>  (escanea y muestra lo más grande):
  --files N                Los N archivos más grandes, a cualquier profundidad
  --folders N              Las N carpetas más grandes a la profundidad --depth
                           (sin --files ni --folders: 10 de cada; con uno solo, sólo ese)
  --depth D                Profundidad de las carpetas: 1 = hijas directas de la raíz (1)
  --format table|csv|json  Formato (table)
                             csv: UTF-8 sin BOM, separado por comas, con cabecera
                               kind,path,name,size,alloc,files,dirs,mtime (kind = file | folder),
                               tamaños en bytes y fechas ISO 8601 en UTC
                             json: {\"root\", \"scannedAt\", \"files\": [...], \"folders\": [...]}, filas
                               como SearchRow del contrato (fechas en segundos Unix)
  --out FICHERO            Escribe en ese archivo en vez de en la salida estándar
  --engine auto|walk|mft   Motor (auto)
  Los avisos del escaneo van a la salida de errores.

check <ruta>  (no escanea: sólo mira el volumen que contiene la ruta):
  --min-free UMBRAL        Espacio libre mínimo: porcentaje del volumen (\"10%\") o tamaño (\"500MB\",
                           \"20GB\", \"1.5TB\"; K/KB/KiB = 1024 bytes, como el Explorador; sin unidad, bytes)
  Imprime una línea de estado (OK o BAJO). Código de salida: 0 si queda al menos ese espacio,
  2 si queda menos y 1 si hay un error o los argumentos no son válidos (para tareas programadas).

Opciones de scan:
  --engine auto|walk|mft   Motor (por defecto auto)
  --top N                  Archivos más grandes a mostrar (10)
  --threads N              Hilos del recorrido (núcleos lógicos)
  --buf KiB                Búfer por hilo del recorrido (1024)
  --slice-out f.bin        Escribe el slice de la raíz
  --min-bytes X            Umbral del slice (0)
  --max-nodes N            Nodos del slice (20000)
  --search \"consulta\"      Ejecuta una búsqueda sobre la raíz (repetible)
  --limit N                Filas de la búsqueda (50)
  --search-out f.json      Escribe la respuesta de búsqueda en JSON
  --json-out f.json        Vuelca el árbol completo en JSON (sólo para carpetas pequeñas)
  --dups BYTES             Busca duplicados de al menos BYTES (lee los archivos; --limit grupos)
  --dups-out f.json        Escribe el DupResult en JSON
  --compare                Escanea con MFT y con recorrido y compara la raíz y sus hijos
  --history-compare ID     Compara con un resumen del historial (--limit filas por lista)
  --compare-out f.json     Escribe el CompareResult en JSON
  --history-save           Guarda el escaneo en el historial (después de comparar) e imprime el HistoryEntry
  --flags                  Estadísticas de flags (enlaces duros, comprimidos, nube…)
  --children               Lista los hijos de la raíz con sus totales (con --history-compare, por delta)
  --progress               Muestra el progreso
  --repeat N               Repite el escaneo N veces (medición)

Códigos de salida de scan, top e history: 0 bien, 1 error, 2 uso incorrecto.
";

fn human(b: u64) -> String {
    let units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{b} B")
    } else {
        format!("{v:.2} {}", units[i])
    }
}

fn sep(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    out
}

fn dump_json(t: &Tree) -> serde_json::Value {
    let nodes: Vec<serde_json::Value> = (0..t.len() as u32)
        .map(|id| {
            serde_json::json!({
                "id": id, "name": t.name(id), "ext": if t.is_dir(id) { "" } else { t.ext(id) },
                "isDir": t.is_dir(id), "size": t.size(id), "alloc": t.alloc(id), "files": t.files(id),
                "dirs": t.dirs(id), "mtime": t.mtime(id), "flags": t.flags(id),
                "parent": t.parent(id).map_or(-1, |p| p as i64),
                "kids": t.kids(id).to_vec(),
            })
        })
        .collect();
    serde_json::json!({ "rootPath": t.root_path(), "nodes": nodes })
}

fn fail(e: tessera_core::EngineMessage) -> ! {
    eprintln!("Error: [{}] {}", e.code, e.message);
    std::process::exit(1)
}

/// `tessera-cli history [list | delete <id> | clear]`
fn history_cmd(args: &[String]) {
    let h = History::open().unwrap_or_else(|e| fail(e));
    match (args.first().map(String::as_str), args.get(1)) {
        (None | Some("list"), None) => println!("{}", serde_json::to_string_pretty(&h.list().unwrap_or_else(|e| fail(e))).unwrap()),
        (Some("delete"), Some(id)) => println!("{}", h.delete(id).unwrap_or_else(|e| fail(e))),
        (Some("clear"), None) => println!("{}", h.clear().unwrap_or_else(|e| fail(e))),
        _ => {
            eprintln!("{USO}");
            std::process::exit(2);
        }
    }
}

/// Marca final de una carpeta en el estilo de su ruta: `\` (Windows) o `/` (Linux); nada en un archivo.
pub(crate) fn dir_mark(is_dir: bool, path: &str) -> &'static str {
    match (is_dir, tessera_core::names::sep_of(path)) {
        (false, _) => "",
        (true, '/') => "/",
        _ => "\\",
    }
}

fn signed(d: i64) -> String {
    format!("{}{}", if d < 0 { "-" } else { "+" }, human(d.unsigned_abs()))
}

fn change_line(c: &ChangeRow) -> String {
    let n = &c.row.node;
    let d = n.size as i64 - c.prev.unwrap_or(0) as i64;
    let what = match c.prev {
        Some(p) => format!("antes {}", human(p)),
        None => "nuevo".into(),
    };
    format!("  {:>12}  {}{}  ({what}, ahora {})", signed(d), c.row.path, dir_mark(n.is_dir, &c.row.path), human(n.size))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(args.first().map(String::as_str), Some("help" | "ayuda")) || args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{USO}");
        return;
    }
    match args.first().map(String::as_str) {
        Some("history") => return history_cmd(&args[1..]),
        Some("top") => std::process::exit(cmds::top_cmd(&args[1..])),
        Some("check") => std::process::exit(cmds::check_cmd(&args[1..])),
        _ => {}
    }
    if args.first().map(String::as_str) != Some("scan") || args.len() < 2 {
        eprintln!("{USO}");
        std::process::exit(2);
    }
    let path = args[1].clone();
    let mut engine = EngineChoice::Auto;
    let (mut top, mut limit, mut max_nodes, mut repeat) = (10usize, 50u32, 20_000u32, 1usize);
    let mut min_bytes = 0f64;
    let mut opts = ScanOptions::default();
    let (mut slice_out, mut json_out, mut search_out) = (None, None, None);
    let mut search_q: Vec<String> = Vec::new();
    let (mut dups_min, mut dups_out) = (None, None);
    let mut show_progress = false;
    let mut show_children = false;
    let mut show_flags = false;
    let mut compare = false;
    let (mut history_save, mut history_compare, mut compare_out) = (false, None, None);
    let mut i = 2;
    while i < args.len() {
        let next = |i: usize| -> String {
            args.get(i + 1).cloned().unwrap_or_else(|| {
                eprintln!("Falta el valor de {}", args[i]);
                std::process::exit(2)
            })
        };
        let num = |s: String| -> f64 {
            s.parse::<f64>().unwrap_or_else(|_| {
                eprintln!("Número no válido: {s}");
                std::process::exit(2)
            })
        };
        match args[i].as_str() {
            "--engine" => engine = next(i).parse().unwrap_or_else(|e: String| {
                eprintln!("{e}");
                std::process::exit(2)
            }),
            "--top" => top = num(next(i)) as usize,
            "--threads" => opts.threads = num(next(i)) as usize,
            "--buf" => opts.buf_size = num(next(i)) as usize * 1024,
            "--slice-out" => slice_out = Some(next(i)),
            "--min-bytes" => min_bytes = num(next(i)),
            "--max-nodes" => max_nodes = num(next(i)) as u32,
            "--search" => search_q.push(next(i)),
            "--limit" => limit = num(next(i)) as u32,
            "--search-out" => search_out = Some(next(i)),
            "--json-out" => json_out = Some(next(i)),
            "--dups" => dups_min = Some(num(next(i)).max(0.0) as u64),
            "--dups-out" => dups_out = Some(next(i)),
            "--repeat" => repeat = num(next(i)).max(1.0) as usize,
            "--history-compare" => history_compare = Some(next(i)),
            "--compare-out" => compare_out = Some(next(i)),
            "--history-save" => {
                history_save = true;
                i += 1;
                continue;
            }
            "--compare" => {
                compare = true;
                i += 1;
                continue;
            }
            "--flags" => {
                show_flags = true;
                i += 1;
                continue;
            }
            "--children" => {
                show_children = true;
                i += 1;
                continue;
            }
            "--progress" => {
                show_progress = true;
                i += 1;
                continue;
            }
            other => {
                eprintln!("Opción desconocida: {other}\n\n{USO}");
                std::process::exit(2);
            }
        }
        i += 2;
    }

    let cancel = AtomicBool::new(false);
    let cb = |p: ScanProgress| {
        if show_progress && p.phase != ScanPhase::Done {
            eprintln!(
                "  [{:>6} ms] {:?}: {} entradas, {}{}",
                p.elapsed_ms,
                p.phase,
                sep(p.entries),
                human(p.bytes),
                p.detail.map(|d| format!(" · {d}")).unwrap_or_default()
            );
        }
    };
    if compare {
        compare_engines(&path, &opts, &cancel);
        return;
    }
    let mut scan = None;
    for r in 0..repeat {
        let t0 = Instant::now();
        let s = match tessera_core::scan(&path, engine, &opts, &cb, &cancel) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Error: [{}] {}", e.code, e.message);
                std::process::exit(1);
            }
        };
        if repeat > 1 {
            println!("pasada {}: {:.2} s, {} entradas", r + 1, t0.elapsed().as_secs_f64(), sep(s.result.entries));
        }
        scan = Some(s);
    }
    let scan = scan.unwrap();
    let (t, res) = (&scan.tree, &scan.result);
    println!("Ruta:      {}", res.root_path);
    println!("Motor:     {:?}", res.engine);
    if let Some(v) = &res.volume {
        println!("Volumen:   {} «{}» {} · {} libres de {} · clúster {} B", v.path, v.label, v.fs, human(v.free), human(v.total), v.cluster_size);
    }
    println!("Entradas:  {}", sep(res.entries));
    println!("Archivos:  {}", sep(res.files));
    println!("Carpetas:  {}", sep(res.dirs));
    println!("Tamaño:    {} ({} bytes)", human(res.bytes), sep(res.bytes));
    println!("Asignado:  {} ({} bytes)", human(t.alloc(0)), sep(t.alloc(0)));
    println!("Tiempo:    {:.3} s", res.elapsed_ms as f64 / 1000.0);
    println!("Memoria:   ≈{} en el árbol ({} nodos, {} B de nombres, {} extensiones)", human(t.memory_bytes() as u64), sep(t.len() as u64), sep(t.names_len() as u64), t.exts().len());
    if let Some((ws, peak, commit)) = tessera_core::sys::process_memory() {
        // En Linux el tercer valor es el pico de memoria virtual (VmPeak), no hay «commit»
        let third = if cfg!(windows) { "commit pico" } else { "virtual pico" };
        println!("Proceso:   {} en uso · pico {} · {third} {}", human(ws), human(peak), human(commit));
    }
    for w in &res.warnings {
        println!("Aviso:     [{}] {}", w.code, w.message);
    }
    if history_compare.is_some() || history_save {
        let h = History::open().unwrap_or_else(|e| fail(e));
        if let Some(id) = &history_compare {
            let t0 = Instant::now();
            let r = h.compare(&scan, id, limit).unwrap_or_else(|e| fail(e));
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            let (b, a) = (r.before, r.after);
            println!("\nComparación con {} ({}, {} nodos guardados, {ms:.1} ms):", r.entry.id, r.entry.path, sep(r.entry.nodes));
            println!("  Antes:   {} · {} archivos · {} carpetas", human(b.bytes), sep(b.files), sep(b.dirs));
            println!("  Ahora:   {} · {} archivos · {} carpetas ({})", human(a.bytes), sep(a.files), sep(a.dirs), signed(a.bytes as i64 - b.bytes as i64));
            println!("  Creció ({}):", r.grew.len());
            for c in r.grew.iter().take(top.max(5)) {
                println!("{}", change_line(c));
            }
            println!("  Se redujo ({}):", r.shrank.len());
            for c in r.shrank.iter().take(top.max(5)) {
                println!("{}", change_line(c));
            }
            println!("  Ya no está ({}):", r.removed.len());
            for x in r.removed.iter().take(top.max(5)) {
                println!("  {:>12}  {}{}", human(x.size), x.path, dir_mark(x.is_dir, &x.path));
            }
            if let Some(f) = &compare_out {
                std::fs::write(f, serde_json::to_vec(&r).unwrap()).expect("escribir comparación");
            }
        }
        if history_save {
            let t0 = Instant::now();
            let e = h.save(&scan).unwrap_or_else(|e| fail(e));
            eprintln!("Historial: {} · {} nodos · {} · {:.1} ms", h.dir().join(format!("{}.snap.gz", e.id)).display(), sep(e.nodes), human(e.file_bytes), t0.elapsed().as_secs_f64() * 1000.0);
            println!("{}", serde_json::to_string_pretty(&e).unwrap());
        }
    }
    if show_flags {
        use tessera_core::types::flag;
        let names = [(flag::HIDDEN, "oculto"), (flag::SYSTEM, "sistema"), (flag::HARDLINK, "enlace duro"), (flag::COMPRESSED, "comprimido"), (flag::REPARSE, "reparse"), (flag::CLOUD, "nube"), (flag::SPARSE, "disperso")];
        println!("
Flags (archivos y carpetas):");
        for (f, n) in names {
            let (mut c, mut sz, mut al) = (0u64, 0u64, 0u64);
            for id in 1..t.len() as u32 {
                if t.flags(id) & f != 0 && !t.is_dir(id) {
                    c += 1;
                    sz += t.size(id);
                    al += t.alloc(id);
                }
            }
            let d = (1..t.len() as u32).filter(|&id| t.flags(id) & f != 0 && t.is_dir(id)).count();
            println!("  {n:<12} {:>9} archivos ({} tamaño, {} asignado) · {d} carpetas", sep(c), human(sz), human(al));
        }
        let mask = flag::HARDLINK | flag::CLOUD | flag::SPARSE;
        let (mut c, mut sz) = (0u64, 0u64);
        for id in 1..t.len() as u32 {
            if !t.is_dir(id) && t.alloc(id) == 0 && t.size(id) > 4096 && t.flags(id) & mask == 0 {
                c += 1;
                sz += t.size(id);
                if c <= 5 {
                    println!("  asignado 0 sin explicación: {} ({}, flags {})", t.path(id), human(t.size(id)), t.flags(id));
                }
            }
        }
        println!("  asignado 0 (>4 KiB, sin enlace/nube/disperso): {} archivos, {}", sep(c), human(sz));
    }
    if show_children {
        let compared = t.comparison().is_some();
        let r = ops::children(t, 0, 0, u32::MAX, if compared { SortKey::Delta } else { SortKey::Size }, true).unwrap();
        println!("
Hijos de la raíz ({}):", r.total);
        for row in &r.rows {
            let change = match (row.prev, row.fresh) {
                (Some(p), _) => format!(" ({}, antes {})", signed(row.size as i64 - p as i64), human(p)),
                (None, Some(true)) => " (nuevo)".into(),
                _ if compared => " (desconocido)".into(),
                _ => String::new(),
            };
            println!("  {:>12} {:>10} arch {:>9} carp  {}{}{change}", human(row.size), sep(row.files as u64), sep(row.dirs as u64), row.name, dir_mark(row.is_dir, t.root_path()));
        }
    }
    if top > 0 {
        let r = ops::search(t, "", 0, top as u32);
        println!("\nLos {} archivos más grandes:", r.rows.len());
        for row in &r.rows {
            println!("  {:>12}  {}", human(row.node.size), row.path);
        }
    }
    let mut all = Vec::new();
    for q in &search_q {
        let t0 = Instant::now();
        let r = ops::search(t, q, 0, limit);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        if let Some(e) = &r.error {
            println!("
Búsqueda «{q}»: error: [{}] {}", e.code, e.message);
        } else {
            println!("
Búsqueda «{q}»: {} resultados, {} ({ms:.1} ms)", sep(r.total), human(r.total_bytes));
            for row in r.rows.iter().take(top.max(5)) {
                println!("  {:>12}  {}", human(row.node.size), row.path);
            }
        }
        all.push(serde_json::json!({ "query": q, "response": r }));
    }
    if let Some(f) = &search_out {
        std::fs::write(f, serde_json::to_vec(&all).unwrap()).expect("escribir búsqueda");
    }
    if let Some(min) = dups_min {
        let dcb = |p: DupProgress| {
            if show_progress {
                eprintln!("  [{:>6} ms] {:?}: {}/{} archivos, {}/{}", p.elapsed_ms, p.phase, sep(p.files), sep(p.total_files), human(p.bytes), human(p.total_bytes));
            }
        };
        match tessera_core::duplicates(t, 0, min, limit, &dcb, &cancel) {
            Ok(r) => {
                println!(
                    "\nDuplicados (≥ {}): {} grupos, {} recuperables · {} candidatos · {} leídos · {} enlaces duros y {} en la nube fuera · {:.2} s",
                    human(min),
                    sep(r.total_groups),
                    human(r.wasted),
                    sep(r.candidates),
                    human(r.read_bytes),
                    sep(r.skipped.hardlinks),
                    sep(r.skipped.cloud),
                    r.elapsed_ms as f64 / 1000.0
                );
                for w in &r.warnings {
                    println!("  Aviso: [{}] {}", w.code, w.message);
                }
                for g in r.groups.iter().take(top.max(5)) {
                    println!("  {} × {:>10}  {}  {}", g.files.len(), human(g.size), &g.hash[..12], g.files[0].path);
                }
                if let Some(f) = &dups_out {
                    std::fs::write(f, serde_json::to_vec(&r).unwrap()).expect("escribir duplicados");
                }
            }
            Err(e) => println!("\nDuplicados: error: [{}] {}", e.code, e.message),
        }
    }
    if let Some(f) = &slice_out {
        let t0 = Instant::now();
        let b = slice::encode_slice(t, 0, min_bytes, max_nodes);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        std::fs::write(f, &b).expect("escribir slice");
        let (nodes, _) = slice::decode_slice(&b).expect("slice válido");
        println!("\nSlice:     {f} · {} nodos · {} · {ms:.1} ms", nodes.len(), human(b.len() as u64));
    }
    if let Some(f) = &json_out {
        let mut w = std::io::BufWriter::new(std::fs::File::create(f).expect("crear JSON"));
        serde_json::to_writer(&mut w, &dump_json(t)).expect("escribir JSON");
        w.flush().unwrap();
        println!("JSON:      {f}");
    }
}

/// Compara los dos motores sobre la misma ruta (útil en una consola elevada).
fn compare_engines(path: &str, opts: &ScanOptions, cancel: &AtomicBool) {
    use std::collections::BTreeMap;
    let none = |_: ScanProgress| {};
    let mut cols: Vec<(String, Tree, u64)> = Vec::new();
    for e in [EngineChoice::Mft, EngineChoice::Walk] {
        match tessera_core::scan(path, e, opts, &none, cancel) {
            Ok(s) => {
                println!(
                    "{:?} → {:?}: {} archivos, {} carpetas, {} tamaño, {} asignado, {:.2} s",
                    e,
                    s.result.engine,
                    sep(s.result.files),
                    sep(s.result.dirs),
                    human(s.result.bytes),
                    human(s.tree.alloc(0)),
                    s.result.elapsed_ms as f64 / 1000.0
                );
                for w in &s.result.warnings {
                    println!("    aviso: [{}] {}", w.code, w.message.lines().next().unwrap_or(""));
                }
                cols.push((format!("{:?}", s.result.engine), s.tree, s.result.elapsed_ms));
            }
            Err(err) => println!("{e:?}: error: [{}] {}", err.code, err.message),
        }
    }
    if cols.len() < 2 {
        return;
    }
    let mut rows: BTreeMap<String, [(u64, u64, u64); 2]> = BTreeMap::new();
    for (c, (_, t, _)) in cols.iter().enumerate() {
        let k = t.kids(0);
        for i in 0..k.len() {
            let id = k.get(i);
            rows.entry(t.name(id).to_lowercase()).or_default()[c] = (t.size(id), t.alloc(id), t.files(id) as u64 + t.dirs(id) as u64);
        }
    }
    println!("
{:<40} {:>12} {:>12} {:>12} {:>12} {:>10} {:>10}", "hijo de la raíz", "tam. 1", "tam. 2", "asig. 1", "asig. 2", "entr. 1", "entr. 2");
    let mut v: Vec<_> = rows.into_iter().collect();
    v.sort_by_key(|(_, r)| std::cmp::Reverse(r[0].0.max(r[1].0)));
    for (n, r) in v {
        let mark = if r[0] != r[1] { "≠" } else { " " };
        println!(
            "{mark}{:<39} {:>12} {:>12} {:>12} {:>12} {:>10} {:>10}",
            n.chars().take(39).collect::<String>(),
            human(r[0].0),
            human(r[1].0),
            human(r[0].1),
            human(r[1].1),
            sep(r[0].2),
            sep(r[1].2)
        );
    }
    println!("(1 = {}, 2 = {})", cols[0].0, cols[1].0);
}
