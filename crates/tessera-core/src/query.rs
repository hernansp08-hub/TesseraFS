//! Lenguaje de búsqueda: réplica fiel de `packages/protocol/src/query.ts`.
//! Espacio = Y, `OR`/`|` = O, `-` = NO, comillas para espacios; claves ext, size/tam,
//! alloc/asig, age/edad, path/ruta, name/nombre, re, type/tipo, attr/atrib. Sin `type:` sólo archivos.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::{Regex, RegexBuilder};

use crate::msg;
use crate::types::{flag, EngineMessage};

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
    /// Bits de `flag` (attr:).
    pub flags: u16,
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
    /// Cualquiera de estos bits de `flag`.
    Attr(u16),
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
    /// Error de sintaxis con código `query.*` (ver docs/tecnica/i18n.md).
    pub error: Option<EngineMessage>,
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
        "attr" | "atrib" => "attr",
        _ => return None,
    })
}

/// Valores de attr: (con alias en español), ya en minúsculas y sin espacios.
fn attr_bit(v: &str) -> Option<u16> {
    Some(match v {
        "cloud" | "nube" => flag::CLOUD,
        "hidden" | "oculto" => flag::HIDDEN,
        "system" | "sistema" => flag::SYSTEM,
        "compressed" | "comprimido" => flag::COMPRESSED,
        "hardlink" | "enlace" => flag::HARDLINK,
        "sparse" | "disperso" => flag::SPARSE,
        "reparse" | "reanalisis" => flag::REPARSE,
        _ => return None,
    })
}

/// attr:a,b → máscara de bits; un valor desconocido da `query.invalidValue` con el valor entero.
fn attr_mask(v: &str) -> Result<u16, EngineMessage> {
    let mut mask = 0;
    for a in v.to_lowercase().split(',') {
        mask |= attr_bit(a.trim()).ok_or_else(|| msg::query_invalid_value(v))?;
    }
    Ok(mask)
}

fn re_static(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("internal regex"))
}

/// `query.invalidRegex` con el motivo breve: el texto de `regex::Error` ocupa varias líneas
/// («regex parse error: … error: unclosed group»).
fn regex_error(pattern: &str, e: regex::Error) -> EngineMessage {
    let full = e.to_string();
    let why = full
        .lines()
        .find_map(|l| l.trim().strip_prefix("error: "))
        .unwrap_or_else(|| full.lines().last().unwrap_or_default().trim())
        .to_string();
    msg::query_invalid_regex(&format!("/{pattern}/: {why}"))
}

fn wildcard(p: &str) -> Result<Regex, EngineMessage> {
    let mut pat = String::from("^");
    for c in p.chars() {
        match c {
            '*' => pat.push_str(".*"),
            '?' => pat.push('.'),
            _ => pat.push_str(&regex::escape(c.encode_utf8(&mut [0u8; 4]))),
        }
    }
    pat.push('$');
    RegexBuilder::new(&pat).case_insensitive(true).build().map_err(|e| regex_error(p, e))
}

fn num(s: &str, units: &[(&str, f64)]) -> Result<f64, EngineMessage> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = re_static(&RE, r"^([0-9]+(?:[.,][0-9]+)?)\s*([a-z]*)$");
    let t = s.trim().to_lowercase();
    let bad = || msg::query_invalid_value(s);
    let m = re.captures(&t).ok_or_else(bad)?;
    let unit = units.iter().find(|(u, _)| *u == &m[2]).ok_or_else(bad)?.1;
    let v: f64 = m[1].replacen(',', ".", 1).parse().map_err(|_| bad())?;
    Ok(v * unit)
}

fn compare(spec: &str, units: &[(&str, f64)]) -> Result<Cmp, EngineMessage> {
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

    fn try_compile(q: &str) -> Result<Query, EngineMessage> {
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
                        "re" => P::Re(RegexBuilder::new(&v).case_insensitive(true).build().map_err(|e| regex_error(&v, e))?),
                        "attr" => P::Attr(attr_mask(&v)?),
                        "type" => {
                            let dir = dir_re.is_match(&v);
                            let file = file_re.is_match(&v);
                            if !dir && !file {
                                return Err(msg::query_invalid_type(&v));
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
                        // Inalcanzable (key_of sólo da claves conocidas); igual que query.ts
                        _ => return Err(msg::query_unknown_key(&c[1])),
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
            P::Attr(mask) => t.flags & mask != 0,
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
        flags: u16,
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
            flags: if dir { flag::DIR } else { 0 },
        }
    }
    /// Como `t` con bits de `flag` añadidos.
    fn tf(name: &str, dir: bool, flags: u16) -> T {
        let mut x = t(name, 1.0, dir, None, None);
        x.flags |= flags;
        x
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
            flags: x.flags,
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
        // Errores con código (los mismos que query.ts)
        let err = |q: &str| Query::compile(q).error.unwrap();
        let e = err("age:>30");
        assert_eq!((e.code.as_str(), e.message.as_str()), ("query.invalidValue", "Invalid value: \"30\""));
        assert_eq!(e.get("value"), Some(&crate::types::Param::Str("30".into())));
        let e = err("tipo:raro");
        assert_eq!((e.code.as_str(), e.message.as_str()), ("query.invalidType", "Invalid type: \"raro\" (use dir or file)"));
        let e = err("re:(");
        assert_eq!(e.code, "query.invalidRegex");
        assert_eq!(e.message, "Invalid regular expression: /(/: unclosed group");
        assert!(!e.message.contains('\n'));
        let e = err("size:1..2..3");
        assert_eq!((e.code.as_str(), e.get("value")), ("query.invalidValue", Some(&crate::types::Param::Str("1..2..3".into()))));
    }

    #[test]
    fn attr_key() {
        let cloud = tf("a.docx", false, flag::CLOUD);
        let hidden = tf("b.ini", false, flag::HIDDEN | flag::SYSTEM);
        let plain = tf("c.txt", false, 0);
        let cdir = tf("OneDrive", true, flag::CLOUD);
        assert!(m("attr:cloud", &cloud) && !m("attr:cloud", &plain));
        // Alias, mayúsculas, espacios alrededor de cada valor (entre comillas) y O dentro de la clave
        assert!(m("atrib:NUBE", &cloud));
        assert!(m(r#"attr:"cloud, oculto""#, &hidden) && m(r#"attr:"cloud, oculto""#, &cloud));
        assert!(m("attr:sistema", &hidden) && !m("attr:sistema", &cloud));
        assert!(m("attr:compressed,enlace,disperso,reanalisis", &tf("x", false, flag::SPARSE)));
        for (v, f) in [("comprimido", flag::COMPRESSED), ("hardlink", flag::HARDLINK), ("sparse", flag::SPARSE), ("reparse", flag::REPARSE)] {
            assert!(m(&format!("attr:{v}"), &tf("x", false, f)), "{v}");
            assert!(!m(&format!("attr:{v}"), &plain), "{v}");
        }
        // Negación y Y con otras claves
        assert!(m("-attr:cloud", &plain) && !m("-attr:cloud", &cloud));
        assert!(m("ext:docx attr:cloud", &cloud) && !m("ext:txt attr:cloud", &cloud));
        // Carpetas: sólo con type:dir, como las demás claves; el bit DIR no cuenta
        assert!(!m("attr:cloud", &cdir));
        assert!(m("type:dir attr:cloud", &cdir));
        assert!(!m("type:dir attr:cloud", &tf("d", true, 0)));
        // Valor desconocido o vacío: query.invalidValue con el valor entero tras attr:
        let err = |q: &str| Query::compile(q).error.unwrap();
        let e = err("attr:cloud,Raro");
        assert_eq!((e.code.as_str(), e.message.as_str()), ("query.invalidValue", "Invalid value: \"cloud,Raro\""));
        assert_eq!(e.get("value"), Some(&crate::types::Param::Str("cloud,Raro".into())));
        assert_eq!(err("-atrib:dir").get("value"), Some(&crate::types::Param::Str("dir".into())));
        assert_eq!(err("attr:").get("value"), Some(&crate::types::Param::Str("".into())));
        assert_eq!(err("attr:cloud,").code, "query.invalidValue");
    }
}
