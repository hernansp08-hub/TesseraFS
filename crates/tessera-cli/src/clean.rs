//! Las reglas de «Liberar espacio» de la app, para `cleanup_candidates` de `tessera-cli mcp`. Los datos son los
//! mismos que usa la interfaz (packages/protocol/src/clean-rules.json, con el formato que explica
//! packages/protocol/src/clean.ts) y [`candidates`] hace lo que la pestaña (`loadClean` en packages/ui/src/app.ts):
//! ejecuta la consulta de cada regla sobre el escaneo, la afina por nombre, ruta y atributos, confirma los hijos
//! (`needs`), aplica el tamaño mínimo, agrupa y ordena. Sólo lee. Los textos son los del catálogo inglés de la app.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::LazyLock;

use regex::{Captures, Regex, RegexBuilder};
use serde::Deserialize;
use serde_json::{Map, Value};
use tessera_core::types::flag;
use tessera_core::{links, msg, names, ops, Scan, SearchRow, Tree};

use crate::mcp::contains;

/// Las reglas, las mismas que lee la interfaz.
const RULES_JSON: &str = include_str!("../../../packages/protocol/src/clean-rules.json");
/// El catálogo inglés de la app: título, «por qué» y «cómo» de cada regla.
const EN_JSON: &str = include_str!("../../../packages/i18n/locales/en.json");

// ---------- Formato de clean-rules.json ----------

#[derive(Deserialize)]
struct FileSpec {
    windows: SetSpec,
    linux: SetSpec,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SetSpec {
    ignore_case: bool,
    sep: String,
    vars: HashMap<String, String>,
    rules: Vec<RuleSpec>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PatternSpec {
    Text(String),
    Opts { re: String, i: bool },
}

/// Condiciones de `ok` y de una variante (sólo las variantes llevan `label`, `cmd` y `title`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CondSpec {
    name: Option<PatternSpec>,
    path: Option<PatternSpec>,
    not_path: Option<PatternSpec>,
    ext: Option<PatternSpec>,
    flag: Option<String>,
    label: Option<String>,
    cmd: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum HowSpec {
    Own(bool),
    Rule(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuleSpec {
    id: String,
    q: String,
    risk: Risk,
    ok: Option<CondSpec>,
    variants: Option<Vec<CondSpec>>,
    #[serde(default)]
    needs: Vec<String>,
    #[serde(default)]
    title_params: BTreeMap<String, String>,
    cmd: Option<String>,
    cmd_min_alloc: Option<f64>,
    how: Option<HowSpec>,
    #[serde(default)]
    use_alloc: bool,
    action: Option<String>,
    #[serde(default)]
    parent: bool,
    list: Option<List>,
    #[serde(default)]
    group: bool,
    min: Option<String>,
    #[serde(rename = "$comment")]
    _comment: Option<String>,
}

// ---------- Reglas ----------

/// En este orden se presentan: lo seguro primero.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Ok,
    Warn,
    Bad,
}

impl Risk {
    pub const ALL: [Risk; 3] = [Risk::Ok, Risk::Warn, Risk::Bad];

    pub fn key(self) -> &'static str {
        match self {
            Risk::Ok => "ok",
            Risk::Warn => "warn",
            Risk::Bad => "bad",
        }
    }
}

/// Tarjeta de resumen: los de la consulta o los enlaces rotos.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum List {
    Query,
    Links,
}

#[derive(Default)]
struct Cond {
    name: Option<Regex>,
    path: Option<Regex>,
    not_path: Option<Regex>,
    ext: Option<Regex>,
    flag: u16,
}

impl Cond {
    fn test(&self, t: &Target) -> bool {
        self.name.as_ref().is_none_or(|r| r.is_match(t.name))
            && self.path.as_ref().is_none_or(|r| r.is_match(t.path))
            && self.not_path.as_ref().is_none_or(|r| !r.is_match(t.path))
            && self.ext.as_ref().is_none_or(|r| r.is_match(t.ext))
            && t.flags & self.flag == self.flag
    }
}

struct Variant {
    cond: Cond,
    label: Option<String>,
    cmd: Option<String>,
    title: Option<String>,
}

pub struct Rule {
    pub id: String,
    /// Consulta del lenguaje de búsqueda que trae los candidatos.
    pub q: String,
    pub risk: Risk,
    ok: Option<Cond>,
    variants: Option<Vec<Variant>>,
    needs: Vec<String>,
    title_params: Vec<(String, String)>,
    cmd: Option<String>,
    cmd_min_alloc: Option<f64>,
    /// Regla cuyo texto «cómo» se muestra.
    pub how: Option<String>,
    /// El tamaño que cuenta es el que ocupa en disco (OneDrive descargado).
    pub use_alloc: bool,
    pub action: Option<String>,
    parent: bool,
    pub list: Option<List>,
    group: bool,
    min: Option<u64>,
}

/// Lo que una regla mira de un elemento.
pub struct Target<'a> {
    pub name: &'a str,
    pub path: &'a str,
    pub ext: &'a str,
    pub size: u64,
    pub alloc: u64,
    pub flags: u16,
}

impl<'a> Target<'a> {
    fn of(r: &'a SearchRow) -> Target<'a> {
        let n = &r.node;
        Target { name: &n.name, path: &r.path, ext: &n.ext, size: n.size, alloc: n.alloc, flags: n.flags }
    }
}

impl Rule {
    fn variant(&self, t: &Target) -> Option<&Variant> {
        self.variants.as_ref()?.iter().find(|v| v.cond.test(t))
    }

    /// ¿Es candidato? Como `ok` en la interfaz: con variantes tiene que encajar en una. Sin condiciones, todo lo
    /// que trae la consulta.
    pub fn accepts(&self, t: &Target) -> bool {
        self.ok.as_ref().is_none_or(|c| c.test(t)) && (self.variants.is_none() || self.variant(t).is_some())
    }

    /// Clave del título en el catálogo y sus parámetros.
    pub fn title(&self, t: &Target) -> (String, Vec<(String, String)>) {
        let v = self.variant(t);
        let key = v.and_then(|v| v.title.clone()).unwrap_or_else(|| format!("clean.{}.title", self.id));
        let label = v.and_then(|v| v.label.as_deref());
        (key, self.title_params.iter().map(|(k, tpl)| (k.clone(), fill(tpl, t, label))).collect())
    }

    /// La orden que se puede copiar, si la hay para este elemento.
    pub fn cmd(&self, t: &Target) -> Option<String> {
        let v = self.variant(t);
        let tpl = v.and_then(|v| v.cmd.as_deref()).or(self.cmd.as_deref())?;
        // Comprimir sólo lo que aún no está comprimido
        if self.cmd_min_alloc.is_some_and(|r| (t.alloc as f64) < t.size as f64 * r) {
            return None;
        }
        Some(fill(tpl, t, v.and_then(|v| v.label.as_deref())))
    }

    fn counted(&self, r: &SearchRow) -> u64 {
        if self.use_alloc {
            r.node.alloc
        } else {
            r.node.size
        }
    }
}

static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{([A-Za-z]\w*)\}").expect("regex"));
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{(\w+)\}").expect("regex"));
const TOKENS: [&str; 4] = ["label", "name", "path", "lastTwo"];

/// Plantilla de título u orden: {label} (la variante, o el nombre), {name}, {path} y {lastTwo}.
fn fill(tpl: &str, t: &Target, label: Option<&str>) -> String {
    TOKEN
        .replace_all(tpl, |c: &Captures| match &c[1] {
            "label" => label.unwrap_or(t.name).to_string(),
            "name" => t.name.to_string(),
            "path" => t.path.to_string(),
            "lastTwo" => last_two(t.path),
            _ => c[0].to_string(),
        })
        .into_owned()
}

/// «restic › e4b1c9a07d»: la carpeta con su padre, porque muchas cachés se llaman con un código.
fn last_two(p: &str) -> String {
    let parts: Vec<&str> = p.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    parts[parts.len().saturating_sub(2)..].join(" › ")
}

pub struct Rules {
    pub windows: Vec<Rule>,
    pub linux: Vec<Rule>,
}

static RULES: LazyLock<Result<Rules, String>> = LazyLock::new(|| load(RULES_JSON));

/// Las reglas de Linux (rutas POSIX) o de Windows. Un error en los datos lo detectan las pruebas.
pub fn rules(posix: bool) -> Result<&'static [Rule], String> {
    let r = RULES.as_ref().map_err(Clone::clone)?;
    Ok(if posix { &r.linux } else { &r.windows })
}

fn load(json: &str) -> Result<Rules, String> {
    let f: FileSpec = serde_json::from_str(json).map_err(|e| format!("clean-rules.json: {e}"))?;
    Ok(Rules { windows: compile_set(&f.windows)?, linux: compile_set(&f.linux)? })
}

fn compile_set(set: &SetSpec) -> Result<Vec<Rule>, String> {
    set.rules.iter().map(|r| compile(r, set).map_err(|e| format!("clean-rules.json, {}: {e}", r.id))).collect()
}

/// `{var}` del sistema: entre (?:…) en una expresión regular, tal cual en una consulta.
fn expand(s: &str, vars: &HashMap<String, String>, regex: bool) -> Result<String, String> {
    if let Some(c) = VAR.captures_iter(s).find(|c| !vars.contains_key(&c[1])) {
        return Err(format!("unknown variable {}", &c[0]));
    }
    Ok(VAR
        .replace_all(s, |c: &Captures| {
            let v = &vars[&c[1]];
            if regex {
                format!("(?:{v})")
            } else {
                v.clone()
            }
        })
        .into_owned())
}

/// En las reglas de Windows, `/` es el separador `\`.
fn pattern(p: &PatternSpec, set: &SetSpec) -> Result<Regex, String> {
    let (re, i) = match p {
        PatternSpec::Text(s) => (s.as_str(), set.ignore_case),
        PatternSpec::Opts { re, i } => (re.as_str(), *i),
    };
    let mut src = expand(re, &set.vars, true)?;
    if set.sep == "\\" {
        src = src.replace('/', r"\\");
    }
    RegexBuilder::new(&src).case_insensitive(i).build().map_err(|e| e.to_string())
}

fn flag_of(name: &str) -> Option<u16> {
    Some(match name {
        "DIR" => flag::DIR,
        "HIDDEN" => flag::HIDDEN,
        "SYSTEM" => flag::SYSTEM,
        "HARDLINK" => flag::HARDLINK,
        "COMPRESSED" => flag::COMPRESSED,
        "REPARSE" => flag::REPARSE,
        "CLOUD" => flag::CLOUD,
        "SPARSE" => flag::SPARSE,
        _ => return None,
    })
}

fn cond(c: &CondSpec, set: &SetSpec) -> Result<Cond, String> {
    let re = |p: &Option<PatternSpec>| p.as_ref().map(|p| pattern(p, set)).transpose();
    let flag = match c.flag.as_deref() {
        None => 0,
        Some(f) => flag_of(f).ok_or_else(|| format!("unknown flag {f}"))?,
    };
    Ok(Cond { name: re(&c.name)?, path: re(&c.path)?, not_path: re(&c.not_path)?, ext: re(&c.ext)?, flag })
}

/// "50m" → bytes, con las unidades de la búsqueda (base 1024).
fn parse_size(s: &str) -> Result<u64, String> {
    let low = s.trim().to_ascii_lowercase();
    let (num, exp) = match low.char_indices().last() {
        Some((i, c)) if "kmgt".contains(c) => (&low[..i], "kmgt".find(c).unwrap_or(0) as i32 + 1),
        _ => (low.as_str(), 0),
    };
    let n: f64 = num
        .parse()
        .ok()
        .filter(|_| !num.is_empty() && num.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .ok_or_else(|| format!("invalid size \"{s}\""))?;
    Ok((n * 1024f64.powi(exp)) as u64)
}

fn compile(r: &RuleSpec, set: &SetSpec) -> Result<Rule, String> {
    let ok = match &r.ok {
        Some(c) if c.label.is_some() || c.cmd.is_some() || c.title.is_some() => return Err("label, cmd and title belong in variants".into()),
        Some(c) => Some(cond(c, set)?),
        None => None,
    };
    let variants = match &r.variants {
        Some(vs) => Some(
            vs.iter()
                .map(|v| Ok(Variant { cond: cond(v, set)?, label: v.label.clone(), cmd: v.cmd.clone(), title: v.title.clone() }))
                .collect::<Result<Vec<_>, String>>()?,
        ),
        None => None,
    };
    let templates = r.title_params.values().chain(&r.cmd).chain(r.variants.iter().flatten().filter_map(|v| v.cmd.as_ref()));
    for tpl in templates {
        if let Some(c) = TOKEN.captures_iter(tpl).find(|c| !TOKENS.contains(&&c[1])) {
            return Err(format!("{} is not {{label}}, {{name}}, {{path}} or {{lastTwo}}", &c[0]));
        }
    }
    if r.action.as_deref().is_some_and(|a| a != "freeUp") {
        return Err(format!("unknown action {:?}", r.action));
    }
    let how = match &r.how {
        None | Some(HowSpec::Own(false)) => None,
        Some(HowSpec::Own(true)) => Some(r.id.clone()),
        Some(HowSpec::Rule(id)) => Some(id.clone()),
    };
    Ok(Rule {
        id: r.id.clone(),
        q: expand(&r.q, &set.vars, false)?,
        risk: r.risk,
        ok,
        variants,
        needs: r.needs.clone(),
        title_params: r.title_params.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        cmd: r.cmd.clone(),
        cmd_min_alloc: r.cmd_min_alloc,
        how,
        use_alloc: r.use_alloc,
        action: r.action.clone(),
        parent: r.parent,
        list: r.list,
        group: r.group,
        min: r.min.as_deref().map(parse_size).transpose()?,
    })
}

// ---------- Candidatos ----------

/// Un candidato, como una tarjeta de la pestaña.
pub struct Card {
    pub rule: &'static Rule,
    pub path: String,
    pub is_dir: bool,
    /// Lo que cuenta: el espacio en disco con `use_alloc`, la suma de los archivos agrupados, el total de la lista.
    pub size: u64,
    /// Clave del título y sus parámetros.
    pub title: (String, Vec<(String, String)>),
    pub cmd: Option<String>,
    /// Agrupada por carpeta: sus archivos, los más grandes primero.
    pub files: Vec<SearchRow>,
    /// Tarjeta de resumen: cuántos hay y algunos.
    pub total: Option<u64>,
    pub sample: Vec<String>,
}

/// Lo que la pestaña «Liberar espacio» propondría dentro de `root`: lo seguro primero y, dentro de cada riesgo,
/// lo más grande. `progress` recibe la regla, cuántas van y cuántas hay.
pub fn candidates(s: &Scan, root: u32, progress: &dyn Fn(&str, usize, usize), cancel: &AtomicBool) -> Result<Vec<Card>, String> {
    let t = &s.tree;
    let rules = rules(names::is_posix(t.root_path()))?;
    let mut cards: Vec<Card> = Vec::new();
    // Rutas que ya tienen tarjeta: la caché declarada no se repite ni se anida
    let mut seen: Vec<String> = Vec::new();
    for (i, rule) in rules.iter().enumerate() {
        if cancel.load(Relaxed) {
            let m = msg::cancelled();
            return Err(format!("{} [{}]", m.message, m.code));
        }
        progress(&rule.id, i, rules.len());
        if let Some(list) = rule.list {
            let res = match list {
                // Un escaneo abierto desde un .tessera no puede mirar el disco
                List::Links if s.check_online().is_err() => continue,
                List::Links => links::broken_links(t, root, 500),
                List::Query => ops::search(t, &rule.q, root, 500),
            };
            let Some(first) = res.rows.first().filter(|_| res.error.is_none() && res.total > 0) else { continue };
            cards.push(Card {
                rule,
                path: t.path(root),
                is_dir: true,
                size: res.total_bytes,
                title: rule.title(&Target::of(first)),
                cmd: None,
                files: Vec::new(),
                total: Some(res.total),
                sample: res.rows.iter().take(6).map(|r| r.path.clone()).collect(),
            });
            continue;
        }
        let res = ops::search(t, &rule.q, root, 200);
        if res.error.is_some() {
            continue;
        }
        if rule.parent {
            // La consulta encuentra la marca (CACHEDIR.TAG); el candidato es la carpeta que la contiene
            for r in res.rows.iter().take(60) {
                let Some(dir) = t.parent(r.node.id).filter(|&d| d != root) else { continue };
                let (row, path) = (t.row(dir), t.path(dir));
                let tg = Target { name: &row.name, path: &path, ext: &row.ext, size: row.size, alloc: row.alloc, flags: row.flags };
                if !rule.accepts(&tg) || rule.min.is_some_and(|m| row.size < m) || seen.iter().any(|s| contains(s, &path) || contains(&path, s)) {
                    continue;
                }
                let title = rule.title(&tg);
                seen.push(path.clone());
                cards.push(Card { rule, path, is_dir: true, size: row.size, title, cmd: None, files: Vec::new(), total: None, sample: Vec::new() });
            }
            continue;
        }
        let mut rows: Vec<&SearchRow> =
            res.rows.iter().filter(|r| rule.accepts(&Target::of(r)) && rule.min.is_none_or(|m| rule.group || rule.counted(r) >= m)).collect();
        if !rule.needs.is_empty() {
            rows = rows.into_iter().take(40).filter(|r| has_child(t, r.node.id, &rule.needs)).collect();
        }
        if rule.group {
            // Una tarjeta por carpeta, en el orden en que aparecen (los archivos más grandes primero)
            let mut by: Vec<(u32, Vec<&SearchRow>)> = Vec::new();
            for r in rows {
                let Some(p) = t.parent(r.node.id) else { continue };
                match by.iter_mut().find(|(k, _)| *k == p) {
                    Some((_, v)) => v.push(r),
                    None => by.push((p, vec![r])),
                }
            }
            for (p, list) in by {
                let size: u64 = list.iter().map(|r| r.node.size).sum();
                if rule.min.is_some_and(|m| size < m) {
                    continue;
                }
                let first = Target::of(list[0]);
                let (title, cmd, path) = (rule.title(&first), rule.cmd(&first), t.path(p));
                seen.push(path.clone());
                cards.push(Card {
                    rule,
                    path,
                    is_dir: true,
                    size,
                    title,
                    cmd,
                    files: list.into_iter().cloned().collect(),
                    total: None,
                    sample: Vec::new(),
                });
            }
        } else {
            for r in rows {
                let tg = Target::of(r);
                seen.push(r.path.clone());
                let card = Card {
                    rule,
                    path: r.path.clone(),
                    is_dir: r.node.is_dir,
                    size: rule.counted(r),
                    title: rule.title(&tg),
                    cmd: rule.cmd(&tg),
                    files: Vec::new(),
                    total: None,
                    sample: Vec::new(),
                };
                cards.push(card);
            }
        }
    }
    cards.sort_by(|a, b| a.rule.risk.cmp(&b.rule.risk).then(b.size.cmp(&a.size)));
    Ok(cards)
}

/// ¿Tiene un hijo con alguno de estos nombres (en minúsculas)?
fn has_child(t: &Tree, id: u32, names: &[String]) -> bool {
    let kids = t.kids(id);
    (0..kids.len()).any(|i| {
        let n = t.name(kids.get(i)).to_lowercase();
        names.contains(&n)
    })
}

// ---------- Textos ----------

static EN: LazyLock<Map<String, Value>> = LazyLock::new(|| serde_json::from_str(EN_JSON).unwrap_or_default());

/// Texto inglés de la app con sus parámetros; `os` (windows o linux) elige lo que cambia según el sistema.
pub fn text(key: &str, params: &[(String, String)], os: &str) -> Option<String> {
    let m = EN.get(key)?.as_str()?;
    let arg = |name: &str| if name == "os" { Some(os.to_string()) } else { params.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()) };
    Some(icu(m, &arg))
}

/// Lo que usan estos textos de ICU MessageFormat: `{arg}` y `{arg, select, clave {…} other {…}}` (con otro tipo,
/// como plural, la rama `other`).
fn icu(m: &str, arg: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = m;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let Some(end) = closing(rest, i) else {
            out.push_str(&rest[i..]);
            return out;
        };
        out.push_str(&argument(&rest[i + 1..end], arg));
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Posición de la `}` que cierra la `{` de `s[open]`.
fn closing(s: &str, open: usize) -> Option<usize> {
    let mut depth = 0;
    for (i, c) in s[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i);
                }
            }
            _ => {}
        }
    }
    None
}

fn argument(inner: &str, arg: &dyn Fn(&str) -> Option<String>) -> String {
    let mut parts = inner.splitn(3, ',');
    let value = arg(parts.next().unwrap_or("").trim());
    let (Some(_kind), Some(options)) = (parts.next(), parts.next()) else {
        return value.unwrap_or_else(|| format!("{{{inner}}}"));
    };
    let mut branches = Vec::new();
    let mut rest = options;
    while let Some(i) = rest.find('{') {
        let Some(end) = closing(rest, i) else { break };
        branches.push((rest[..i].trim(), &rest[i + 1..end]));
        rest = &rest[end + 1..];
    }
    let pick = branches.iter().find(|(k, _)| Some(*k) == value.as_deref()).or_else(|| branches.iter().find(|(k, _)| *k == "other"));
    pick.map(|(_, m)| icu(m, arg)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::query::Query;

    fn target<'a>(path: &'a str, ext: &'a str) -> Target<'a> {
        let name = &path[path.rfind(['\\', '/']).map_or(0, |i| i + 1)..];
        Target { name, path, ext, size: 0, alloc: 0, flags: 0 }
    }
    fn rule(posix: bool, id: &str) -> &'static Rule {
        rules(posix).unwrap().iter().find(|r| r.id == id).unwrap_or_else(|| panic!("{id}"))
    }
    fn win(id: &str, path: &str) -> bool {
        rule(false, id).accepts(&target(path, ""))
    }
    fn linux(id: &str, path: &str) -> bool {
        rule(true, id).accepts(&target(path, ""))
    }
    /// El parámetro `name` del título.
    fn named(r: &Rule, t: &Target) -> String {
        r.title(t).1.into_iter().find(|(k, _)| k == "name").map(|(_, v)| v).unwrap_or_default()
    }
    fn p(name: &str) -> Vec<(String, String)> {
        vec![("name".to_string(), name.to_string())]
    }

    #[test]
    fn rules_load_and_queries_compile() {
        for posix in [false, true] {
            let rs = rules(posix).unwrap();
            assert!(rs.len() > 20);
            let ids: std::collections::HashSet<&str> = rs.iter().map(|r| r.id.as_str()).collect();
            assert_eq!(ids.len(), rs.len(), "ids únicos");
            assert_eq!(rs.last().unwrap().id, "cacheTag", "la caché declarada, al final");
            for r in rs {
                assert!(Query::compile(&r.q).error.is_none(), "{}: {}", r.id, r.q);
            }
            assert!(rule(posix, "emptyFiles").q.ends_with("-attr:reparse"));
        }
    }

    #[test]
    fn every_rule_has_its_texts() {
        for (posix, os) in [(false, "windows"), (true, "linux")] {
            for r in rules(posix).unwrap() {
                let keys: Vec<String> = match &r.variants {
                    Some(vs) => vs.iter().map(|v| v.title.clone().unwrap_or(format!("clean.{}.title", r.id))).collect(),
                    None => vec![format!("clean.{}.title", r.id)],
                };
                let keys = keys.into_iter().chain([format!("clean.{}.why", r.id)]).chain(r.how.iter().map(|h| format!("clean.{h}.how")));
                for k in keys {
                    let s = text(&k, &p("X"), os).unwrap_or_else(|| panic!("{k}"));
                    assert!(!s.contains(['{', '}']) && !s.is_empty(), "{k}: {s}");
                }
            }
        }
        assert_eq!(text("clean.packageCaches.title", &p("npm"), "windows").unwrap(), "npm package cache");
        let why = |os| text("clean.brokenLinks.why", &[], os).unwrap();
        assert!(why("windows").starts_with("Symbolic links and junctions whose") && why("windows").contains("Recycle Bin"));
        assert!(why("linux").starts_with("Symbolic links whose") && why("linux").contains("to the Trash"));
        assert!(text("clean.shaderCache.why", &[], "windows").unwrap().ends_with("games closed; the DirectX one is also under Temporary files."));
        assert!(text("clean.shaderCache.why", &[], "linux").unwrap().ends_with("games closed."));
    }

    /// Los mismos casos que packages/ui/test/clean.test.ts: las expresiones dan lo mismo en Rust.
    #[test]
    fn windows_rules_match_like_the_app() {
        for (path, name, cmd) in [
            (r"C:\Users\ana\AppData\Local\npm-cache", "npm", Some("npm cache clean --force")),
            (r"C:\Users\ana\AppData\Local\pnpm\store", "pnpm", Some("pnpm store prune")),
            (r"C:\Users\ana\AppData\Local\Yarn\Cache", "Yarn", Some("yarn cache clean")),
            (r"C:\Users\ana\.bun\install\cache", "Bun", Some("bun pm cache rm")),
            (r"C:\Users\ana\.nuget\packages", "NuGet", Some("dotnet nuget locals all --clear")),
            (r"C:\Users\ana\AppData\Local\go-build", "Go", Some("go clean -cache")),
        ] {
            let (r, t) = (rule(false, "packageCaches"), target(path, ""));
            assert!(r.accepts(&t), "{path}");
            assert_eq!(r.title(&t), ("clean.packageCaches.title".to_string(), p(name)));
            assert_eq!(r.cmd(&t).as_deref(), cmd);
        }
        let chrome = target(r"C:\Users\ana\AppData\Local\Google\Chrome\User Data\Default\Cache", "");
        assert_eq!(named(rule(false, "browserCache"), &chrome), "Chrome");
        assert!(rule(false, "browserCache").cmd(&chrome).is_none());
        assert!(win("browserCache", r"C:\Users\ana\AppData\Local\Mozilla\Firefox\Profiles\x1.default-release\cache2"));
        assert!(!win("browserCache", r"C:\Users\ana\AppData\Local\Google\Chrome\User Data\Default\Cache\Cache_Data"));
        assert!(!win("packageCaches", r"C:\proyectos\web\packages"));
        assert!(win("nodeModules", r"C:\proyectos\web\node_modules"));
        assert!(!win("nodeModules", r"C:\proyectos\web\node_modules\x\node_modules"), "anidada");
        assert!(!win("nodeModules", r"C:\Users\ana\AppData\Roaming\npm\node_modules"), "de un programa instalado");
        assert!(!win("nodeModules", r"C:\proyectos\web\Node_Modules"), "el nombre, con mayúsculas exactas");
        assert!(win("rustTarget", r"C:\proyectos\lamina\TARGET") && !win("rustTarget", r"C:\Program Files\NVIDIA\target"));
        assert!(win("recycleBin", r"C:\$Recycle.Bin") && win("temp", r"c:\windows\temp") && !win("temp", r"C:\Juegos\Temp"));
        assert!(win("deliveryOptimization", r"C:\Windows\SoftwareDistribution\DeliveryOptimization"));
        let sys = rule(false, "systemFile");
        assert_eq!(sys.title(&target(r"C:\hiberfil.sys", "sys")).0, "clean.hiberfil.title");
        assert_eq!(sys.title(&target(r"C:\pagefile.sys", "sys")).0, "clean.pagefile.title");
        assert!(!win("systemFile", r"D:\copias\pagefile.sys"));
        // Juegos: comprimirlos sólo si aún no lo están
        let game = rule(false, "game");
        let p = r"D:\SteamLibrary\steamapps\common\Hades II";
        let t = Target { size: 8_000_000_000, alloc: 8_000_000_000, ..target(p, "") };
        assert_eq!(game.cmd(&t).unwrap(), format!(r#"compact /c /s /i /q /exe:lzx "{p}\*""#));
        assert!(game.cmd(&Target { alloc: 5_000_000_000, ..t }).is_none());
        assert_eq!(named(game, &target(p, "")), "Hades II");
        // OneDrive: sólo con la marca de la nube
        let od = rule(false, "oneDrive");
        assert!(od.use_alloc && od.action.as_deref() == Some("freeUp"));
        assert!(od.accepts(&Target { flags: flag::DIR | flag::CLOUD, ..target(r"C:\Users\ana\OneDrive - Contoso", "") }));
        assert!(!od.accepts(&Target { flags: flag::DIR, ..target(r"C:\Users\ana\OneDrive", "") }));
        let tag = rule(false, "cacheTag");
        assert!(!win("cacheTag", r"C:\Windows\Temp\x") && win("cacheTag", r"C:\Users\ana\AppData\Local\restic\e4b1"));
        assert_eq!(named(tag, &target(r"C:\Users\ana\AppData\Local\restic\e4b1", "")), "restic › e4b1");
        assert!(rule(false, "aiModels").accepts(&target(r"C:\m\qwen.gguf", "gguf")));
        assert_eq!(rule(false, "temp").how.as_deref(), Some("temp"));
        assert_eq!(rule(false, "deliveryOptimization").how.as_deref(), Some("temp"));
    }

    #[test]
    fn linux_rules_match_like_the_app() {
        assert!(linux("nodeModules", "/home/ana/web/node_modules"));
        assert!(!linux("nodeModules", "/usr/lib/node_modules") && !linux("nodeModules", "/home/ana/.local/share/containers/storage/x/node_modules"));
        assert!(!linux("nodeModules", "/home/ana/web/node_modules/x/node_modules"));
        assert!(linux("userCache", "/root/.cache") && !linux("userCache", "/home/ana/proyecto/.cache"));
        assert!(linux("packageCaches", "/home/ana/.local/share/pnpm/store") && linux("packageCaches", "/srv/x/.pnpm-store"));
        assert!(!linux("packageCaches", "/home/ana/.cache/pip"));
        let (sp, apt) = (rule(true, "systemPackages"), target("/var/cache/apt/archives", ""));
        assert_eq!((sp.cmd(&apt).unwrap(), named(sp, &apt)), ("sudo apt clean".to_string(), "APT".to_string()));
        let c = rule(true, "containers");
        assert_eq!(c.cmd(&target("/home/ana/.local/share/containers", "")).unwrap(), "podman system prune -a");
        assert_eq!(named(c, &target("/var/lib/docker", "")), "Docker");
        assert!(rule(true, "game").cmd(&target("/home/ana/.local/share/Steam/steamapps/common/Hades II", "")).is_none());
        // ~/.cache y lo de dentro ya lo cubre su propia tarjeta
        assert!(linux("cacheTag", "/home/ana/proyecto/.mypy_cache"));
        assert!(!linux("cacheTag", "/home/ana/.cache/restic") && !linux("cacheTag", "/home/ana/.cache"));
        assert!(rule(true, "vmImages").accepts(&target("/home/ana/vm/f.QCOW2", "QCOW2")));
        assert!(linux("swapLinux", "/swap.img") && !linux("swapLinux", "/x/swapfile"));
    }

    #[test]
    fn data_errors_are_reported() {
        let bad = |rule: &str| {
            let json = format!(
                r#"{{ "windows": {{ "ignoreCase": true, "sep": "\\", "vars": {{}}, "rules": [{rule}] }}, "linux": {{ "ignoreCase": false, "sep": "/", "vars": {{}}, "rules": [] }} }}"#
            );
            load(&json).err().unwrap_or_default()
        };
        assert!(bad(r#"{ "id": "x", "q": "", "risk": "ok", "ok": { "path": "{nada}" } }"#).contains("unknown variable {nada}"));
        assert!(bad(r#"{ "id": "x", "q": "", "risk": "ok", "cmd": "rm {ruta}" }"#).contains("{ruta}"));
        assert!(bad(r#"{ "id": "x", "q": "", "risk": "ok", "min": "50 megas" }"#).contains("invalid size"));
        assert!(bad(r#"{ "id": "x", "q": "", "risk": "ok", "minimo": "50m" }"#).contains("unknown field"));
        assert!(bad(r#"{ "id": "x", "q": "", "risk": "ok", "ok": { "path": "(?=a)" } }"#).contains("x:"));
        assert_eq!(parse_size("50m"), Ok(50 << 20));
        assert_eq!(parse_size("1g"), Ok(1 << 30));
        assert_eq!(parse_size("10"), Ok(10));
        assert_eq!(last_two(r"C:\a\b\c"), "b › c");
    }
}
