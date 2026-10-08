//! tessera-cli: escanea una ruta e imprime el resumen, los archivos más grandes y,
//! opcionalmente, un slice binario o un volcado JSON para pruebas cruzadas.

use std::io::Write;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use tessera_core::{ops, slice, EngineChoice, ScanOptions, ScanPhase, ScanProgress, Tree};

const USO: &str = "Uso:
  tessera-cli scan <ruta> [opciones]

Opciones:
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
  --compare                Escanea con MFT y con recorrido y compara la raíz y sus hijos
  --flags                  Estadísticas de flags (enlaces duros, comprimidos, nube…)
  --children               Lista los hijos de la raíz con sus totales
  --progress               Muestra el progreso
  --repeat N               Repite el escaneo N veces (medición)";

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

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
    let mut show_progress = false;
    let mut show_children = false;
    let mut show_flags = false;
    let mut compare = false;
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
            "--repeat" => repeat = num(next(i)).max(1.0) as usize,
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
                eprintln!("Error: {e}");
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
        println!("Proceso:   {} en uso · pico {} · commit pico {}", human(ws), human(peak), human(commit));
    }
    for w in &res.warnings {
        println!("Aviso:     {w}");
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
        let r = ops::children(t, 0, 0, u32::MAX, tessera_core::SortKey::Size, true).unwrap();
        println!("
Hijos de la raíz ({}):", r.total);
        for row in &r.rows {
            println!("  {:>12} {:>10} arch {:>9} carp  {}{}", human(row.size), sep(row.files as u64), sep(row.dirs as u64), row.name, if row.is_dir { "\\" } else { "" });
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
Búsqueda «{q}»: error: {e}");
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
                    println!("    aviso: {}", w.lines().next().unwrap_or(""));
                }
                cols.push((format!("{:?}", s.result.engine), s.tree, s.result.elapsed_ms));
            }
            Err(err) => println!("{e:?}: error: {err}"),
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
