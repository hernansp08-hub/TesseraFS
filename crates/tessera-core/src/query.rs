//! Lenguaje de búsqueda: réplica fiel de `packages/protocol/src/query.ts`.
//! Espacio = Y, `OR`/`|` = O, `-` = NO, comillas para espacios; claves ext, size/tam,
//! alloc/asig, age/edad, path/ruta, name/nombre, re, type/tipo. Sin `type:` sólo archivos.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::{Regex, RegexBuilder};

/// Lo que la búsqueda necesita de cada nodo. `name_lower` y `path_lower` sólo se rellenan
/// si la consulta lo pide (`needs_name_lower`, `needs_path`).
pub struct Target<'a> {
    pub name: &'a str,
    pub name_lower: &'a str,
    pub ext: &'a str,
    pub is_dir: bool,
    pub size: f64,
    pub alloc: f64,
    pub mtime: f64,
    pub path_lower: &'a str,
}

#[derive(Debug, Clone, Copy)]
enum Cmp {
    Range(f64, f64),
    Gt(f64),
    Lt(f64),
    Ge(f64),
    Le(f64),
    Eq(f64),
}

impl Cmp {
    #[inline]
    fn test(self, v: f64) -> bool {
        match self {
            Cmp::Range(a, b) => v >= a && v <= b,
            Cmp::Gt(x) => v > x,
            Cmp::Lt(x) => v < x,
            Cmp::Ge(x) => v >= x,
            Cmp::Le(x) => v <= x,
            Cmp::Eq(x) => (v - x).abs() < 1.0,
        }
    }
}

enum P {
    Ext(HashSet<String>),
    Size(Cmp),
    Alloc(Cmp),
    Age(Cmp),
    Path(String),
    NameWild(Regex),
    NameSub(String),
    Re(Regex),
    Type { dir: bool },
}

struct Pred {
    neg: bool,
    p: P,
}

pub struct Query {
    groups: Vec<Vec<Pred>>,
    pub wants_dirs: bool,
    pub wants_files: bool,
    pub needs_path: bool,
    pub needs_name_lower: bool,
    pub error: Option<String>,
}

const UNIT: &[(&str, f64)] = &[
    ("", 1.0),
    ("b", 1.0),
    ("k", 1024.0),
    ("m", 1048576.0),
    ("g", 1073741824.0),
    ("t", 1099511627776.0),
];
const AGE: &[(&str, f64)] = &[("d", 86400.0), ("w", 7.0 * 86400.0), ("mo", 30.0 * 86400.0), ("y", 365.0 * 86400.0)];

fn key_of(k: &str) -> Option<&'static str> {
    Some(match k {
        "ext" => "ext",
        "size" | "tam" => "size",
        "alloc" | "asig" => "alloc",
        "age" | "edad" => "age",
        "path" | "ruta" => "path",
        "name" | "nombre" => "name",
        "re" => "re",
        "type" | "tipo" => "type",
        _ => return None,
    })
}

fn re_static(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("regex interna"))
}

fn wildcard(p: &str) -> Result<Regex, String> {
    let mut pat = String::from("^");
    for c in p.chars() {
        match c {
            '*' => pat.push_str(".*"),
            '?' => pat.push('.'),
            _ => pat.push_str(&regex::escape(c.encode_utf8(&mut [0u8; 4]))),
        }
    }
    pat.push('$');
    RegexBuilder::new(&pat).case_insensitive(true).build().map_err(|e| e.to_string())
}

fn num(s: &str, units: &[(&str, f64)]) -> Result<f64, String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = re_static(&RE, r"^([0-9]+(?:[.,][0-9]+)?)\s*([a-z]*)$");
    let t = s.trim().to_lowercase();
    let bad = || format!("Valor no válido: «{s}»");
    let m = re.captures(&t).ok_or_else(bad)?;
    let unit = units.iter().find(|(u, _)| *u == &m[2]).ok_or_else(bad)?.1;
    let v: f64 = m[1].replacen(',', ".", 1).parse().map_err(|_| bad())?;
    Ok(v * unit)
}

fn compare(spec: &str, units: &[(&str, f64)]) -> Result<Cmp, String> {
    let range: Vec<&str> = spec.split("..").collect();
    if range.len() == 2 {
        return Ok(Cmp::Range(num(range[0], units)?, num(range[1], units)?));
    }
    let (op, rest) = [">=", "<=", ">", "<", "="]
        .iter()
        .find_map(|op| spec.strip_prefix(op).map(|r| (*op, r)))
        .unwrap_or((">=", spec));
    let x = num(rest, units)?;
    Ok(match op {
        ">" => Cmp::Gt(x),
        "<" => Cmp::Lt(x),
        ">=" => Cmp::Ge(x),
        "<=" => Cmp::Le(x),
        _ => Cmp::Eq(x),
    })
}

/// Comillas sueltas ("Cities Skylines") y tras una clave (name:"System Volume Information").
pub fn tokenize(q: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = re_static(&RE, r#"-?[^\s"]*"[^"]*"[^\s"]*|\S+"#);
    re.find_iter(q).map(|m| m.as_str().replace('"', "")).collect()
}

impl Query {
    pub fn compile(q: &str) -> Query {
        match Self::try_compile(q) {
            Ok(q) => q,
            Err(e) => Query {
                groups: Vec::new(),
                wants_dirs: false,
                wants_files: false,
                needs_path: false,
                needs_name_lower: false,
                error: Some(e),
            },
        }
    }

    fn try_compile(q: &str) -> Result<Query, String> {
        static KV: OnceLock<Regex> = OnceLock::new();
        static DIR: OnceLock<Regex> = OnceLock::new();
        static FILE: OnceLock<Regex> = OnceLock::new();
        let kv_re = re_static(&KV, r"(?i)^([a-záéíóú]+):(.*)$");
        let dir_re = re_static(&DIR, r"(?i)^(dir|carpeta|folder)$");
        let file_re = re_static(&FILE, r"(?i)^(file|archivo)$");
        let (mut wants_dirs, mut wants_files, mut type_seen) = (false, false, false);
        let (mut needs_path, mut needs_name_lower) = (false, false);
        let mut groups: Vec<Vec<Pred>> = vec![Vec::new()];
        for raw in tokenize(q) {
            if raw == "OR" || raw == "|" {
                groups.push(Vec::new());
                continue;
            }
            let (tok, neg) = match raw.strip_prefix('-') {
                Some(rest) if raw.len() > 1 => (rest.to_string(), true),
                _ => (raw.clone(), false),
            };
            let kv = kv_re.captures(&tok);
            let key = kv.as_ref().and_then(|c| key_of(&c[1].to_lowercase()));
            let p = match (kv, key) {
                (Some(c), Some(key)) => {
                    let v = c[2].to_string();
                    match key {
                        "ext" => P::Ext(
                            v.to_lowercase()
                                .split(',')
                                .map(|s| s.strip_prefix('.').unwrap_or(s))
                                .map(|s| if s == "none" { String::new() } else { s.to_string() })
                                .collect(),
                        ),
                        "size" => P::Size(compare(&v, UNIT)?),
                        "alloc" => P::Alloc(compare(&v, UNIT)?),
                        "age" => P::Age(compare(&v, AGE)?),
                        "path" => {
                            needs_path = true;
                            P::Path(v.to_lowercase())
                        }
                        "name" => {
                            if v.contains(['*', '?']) {
                                P::NameWild(wildcard(&v)?)
                            } else {
                                needs_name_lower = true;
                                P::NameSub(v.to_lowercase())
                            }
                        }
                        "re" => P::Re(
                            RegexBuilder::new(&v)
                                .case_insensitive(true)
                                .build()
                                .map_err(|_| format!("Expresión regular no válida: «{v}»"))?,
                        ),
                        _ => {
                            let dir = dir_re.is_match(&v);
                            let file = file_re.is_match(&v);
                            if !dir && !file {
                                return Err(format!("Tipo no válido: «{v}» (usa dir o file)"));
                            }
                            type_seen = true;
                            if dir && !neg {
                                wants_dirs = true;
                            }
                            if file && !neg {
                                wants_files = true;
                            }
                            P::Type { dir }
                        }
                    }
                }
                _ if tok.contains(['*', '?']) => P::NameWild(wildcard(&tok)?),
                _ => {
                    needs_name_lower = true;
                    P::NameSub(tok.to_lowercase())
                }
            };
            groups.last_mut().unwrap().push(Pred { neg, p });
        }
        groups.retain(|g| !g.is_empty());
        if !type_seen {
            wants_files = true;
        }
        if type_seen && !wants_dirs && !wants_files {
            wants_dirs = true;
            wants_files = true;
        }
        Ok(Query { groups, wants_dirs, wants_files, needs_path, needs_name_lower, error: None })
    }

    /// `now`: segundos Unix (como `Date.now() / 1000`).
    pub fn matches(&self, t: &Target, now: f64) -> bool {
        if self.error.is_some() {
            return false;
        }
        if if t.is_dir { !self.wants_dirs } else { !self.wants_files } {
            return false;
        }
        self.groups.is_empty() || self.groups.iter().any(|g| g.iter().all(|p| p.test(t, now)))
    }
}

impl Pred {
    #[inline]
    fn test(&self, t: &Target, now: f64) -> bool {
        let r = match &self.p {
            P::Ext(set) => !t.is_dir && set.contains(t.ext),
            P::Size(c) => c.test(t.size),
            P::Alloc(c) => c.test(t.alloc),
            P::Age(c) => c.test(now - t.mtime),
            P::Path(s) => t.path_lower.contains(s.as_str()),
            P::NameWild(r) | P::Re(r) => r.is_match(t.name),
            P::NameSub(s) => t.name_lower.contains(s.as_str()),
            P::Type { dir } => {
                if *dir {
                    t.is_dir
                } else {
                    !t.is_dir
                }
            }
        };
        r != self.neg
    }
}

pub fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct T {
        name: String,
        lower: String,
        ext: String,
        dir: bool,
        size: f64,
        mtime: f64,
        path: String,
    }
    fn t(name: &str, size: f64, dir: bool, mtime: Option<f64>, path: Option<&str>) -> T {
        let ext = if name.contains('.') { name.rsplit('.').next().unwrap().to_lowercase() } else { String::new() };
        T {
            name: name.into(),
            lower: name.to_lowercase(),
            ext,
            dir,
            size,
            mtime: mtime.unwrap_or_else(now_secs),
            path: path.map(|p| p.to_string()).unwrap_or(format!("C:\\x\\{name}")).to_lowercase(),
        }
    }
    fn m(q: &str, x: &T) -> bool {
        let target = Target {
            name: &x.name,
            name_lower: &x.lower,
            ext: &x.ext,
            is_dir: x.dir,
            size: x.size,
            alloc: x.size,
            mtime: x.mtime,
            path_lower: &x.path,
        };
        Query::compile(q).matches(&target, now_secs())
    }

    #[test]
    fn same_cases_as_protocol_test() {
        assert!(m("ext:gguf", &t("a.gguf", 5.0, false, None, None)));
        assert!(!m("ext:gguf size:>1g", &t("a.gguf", 5.0, false, None, None)));
        assert!(m("size:1k..2k", &t("a.bin", 1500.0, false, None, None)));
        assert!(!m("-ext:dll size:>1m", &t("a.dll", 5.0 * 1048576.0, false, None, None)));
        assert!(m("ext:rlib OR ext:pdb", &t("x.pdb", 1.0, false, None, None)));
        assert!(!m("node_modules", &t("node_modules", 1.0, true, None, None)));
        assert!(m("type:dir node_modules", &t("node_modules", 1.0, true, None, None)));
        assert!(m("path:steamapps", &t("VT.cok", 1.0, false, None, Some("C:\\Steam\\steamapps\\VT.cok"))));
        assert!(m("VT*", &t("VT.cok", 1.0, false, None, None)));
        assert!(m("age:>1y", &t("old.txt", 1.0, false, Some(now_secs() - 400.0 * 86400.0), None)));
        assert!(Query::compile("size:>abc").error.is_some());
    }

    #[test]
    fn extra_rules() {
        // Comillas tras una clave
        assert_eq!(tokenize(r#"type:dir name:"System Volume Information""#), ["type:dir", "name:System Volume Information"]);
        assert_eq!(tokenize(r#""Cities Skylines" -"a b""#), ["Cities Skylines", "-a b"]);
        let svi = t("System Volume Information", 0.0, true, None, None);
        assert!(m(r#"type:dir name:"System Volume Information""#, &svi));
        // Alias en español y unidades
        assert!(m("tam:>=1,5k tipo:archivo", &t("a.bin", 1536.0, false, None, None)));
        assert!(m("ext:none", &t("README", 1.0, false, None, None)));
        assert!(m("ext:.TXT", &t("a.txt", 1.0, false, None, None)));
        assert!(m("re:^vt[._]", &t("VT.cok", 1.0, false, None, None)));
        assert!(m("name:vt", &t("aVTb", 1.0, false, None, None)));
        assert!(m("size:=100", &t("a", 100.5, false, None, None)));
        assert!(m("-type:dir", &t("a", 1.0, false, None, None)));
        assert!(!m("-type:dir", &t("d", 1.0, true, None, None)));
        // Consulta vacía: todos los archivos, ninguna carpeta
        assert!(m("", &t("a", 1.0, false, None, None)));
        assert!(!m("", &t("d", 1.0, true, None, None)));
        // `|` como O y clave desconocida tratada como texto
        assert!(m("foo | bar", &t("xbarx", 1.0, false, None, None)));
        assert!(m("foo:bar", &t("x foo:bar", 1.0, false, None, None)));
        // Errores
        assert!(Query::compile("age:>30").error.is_some());
        assert!(Query::compile("tipo:raro").error.is_some());
        assert!(Query::compile("re:(").error.is_some());
        assert!(Query::compile("size:1..2..3").error.is_some());
    }
}
