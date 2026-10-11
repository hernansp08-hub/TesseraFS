//! Consultas sobre el árbol: hijos paginados, búsqueda y tipos de archivo.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::msg;
use crate::names;
use crate::query::{now_secs, Query, Target};
use crate::tree::Tree;
use crate::types::{ChildrenResponse, EngineMessage, ExtStat, SearchResponse, SearchRow, SortKey};

pub fn children(t: &Tree, id: u32, offset: u32, limit: u32, sort: SortKey, desc: bool) -> Result<ChildrenResponse, EngineMessage> {
    if !t.live(id) {
        return Err(msg::invalid_node(id));
    }
    let kids = t.kids(id);
    let total = kids.len() as u32;
    let by_name = |a: u32, b: u32| names::cmp_ci(t.name_bytes(a), t.name_bytes(b)).then_with(|| a.cmp(&b));
    let ids: Vec<u32> = if sort == SortKey::Size && desc {
        // Ya están en ese orden (tamaño desc, nombre asc)
        let end = (offset as usize).saturating_add(limit as usize).min(kids.len());
        (offset as usize..end).map(|i| kids.get(i)).collect()
    } else {
        let mut v = kids.to_vec();
        // Sin comparación activa, delta = 0 en todos (queda el orden por nombre)
        let cmp = if sort == SortKey::Delta { t.comparison() } else { None };
        let delta = |id: u32| cmp.as_deref().map_or(0, |c| c.delta(id, t.size(id)));
        let key = |a: u32, b: u32| -> Ordering {
            match sort {
                SortKey::Size => t.size(a).cmp(&t.size(b)),
                SortKey::Alloc => t.alloc(a).cmp(&t.alloc(b)),
                SortKey::Files => t.files(a).cmp(&t.files(b)),
                SortKey::Mtime => t.mtime(a).cmp(&t.mtime(b)),
                SortKey::Delta => delta(a).cmp(&delta(b)),
                SortKey::Name => Ordering::Equal,
            }
        };
        v.sort_unstable_by(|&a, &b| {
            let k = if desc { key(b, a) } else { key(a, b) };
            match sort {
                SortKey::Name => {
                    let o = by_name(a, b);
                    if desc {
                        o.reverse()
                    } else {
                        o
                    }
                }
                _ => k.then_with(|| by_name(a, b)),
            }
        });
        v.into_iter().skip(offset as usize).take(limit as usize).collect()
    };
    Ok(ChildrenResponse { total, rows: ids.into_iter().map(|k| t.row(k)).collect() })
}

/// Recorre en preorden el subárbol de `root` (sin incluirlo) manteniendo, si hace falta,
/// la ruta completa en minúsculas en un único búfer.
fn walk_subtree(t: &Tree, root: u32, with_path: bool, mut f: impl FnMut(u32, &str)) {
    let mut path = String::new();
    if with_path {
        names::lower_into(&mut path, t.root_path());
        if root != 0 {
            path.clear();
            names::lower_into(&mut path, &t.path(root));
        }
    }
    let sep = t.sep();
    let mut stack: Vec<(u32, usize)> = Vec::new();
    let push_kids = |stack: &mut Vec<(u32, usize)>, id: u32, plen: usize| {
        let kids = t.kids(id);
        for i in (0..kids.len()).rev() {
            stack.push((kids.get(i), plen));
        }
    };
    push_kids(&mut stack, root, path.len());
    while let Some((id, plen)) = stack.pop() {
        if with_path {
            path.truncate(plen);
            if !path.ends_with(sep) {
                path.push(sep);
            }
            names::lower_into(&mut path, &t.name(id));
        }
        f(id, &path);
        if t.is_dir(id) {
            push_kids(&mut stack, id, path.len());
        }
    }
}

pub fn search(t: &Tree, query: &str, root: u32, limit: u32) -> SearchResponse {
    let q = Query::compile(query);
    if let Some(e) = q.error {
        return SearchResponse { error: Some(e), ..Default::default() };
    }
    if !t.live(root) {
        return SearchResponse { error: Some(msg::invalid_node(root)), ..Default::default() };
    }
    let now = now_secs();
    let mut hits: Vec<u32> = Vec::new();
    let mut total_bytes = 0u64;
    let mut lower = String::new();
    walk_subtree(t, root, q.needs_path, |id, path| {
        let dir = t.is_dir(id);
        if if dir { !q.wants_dirs } else { !q.wants_files } {
            return;
        }
        let name = t.name(id);
        if q.needs_name_lower {
            lower.clear();
            names::lower_into(&mut lower, &name);
        }
        let target = Target {
            name: &name,
            name_lower: &lower,
            ext: if dir { "" } else { t.ext(id) },
            is_dir: dir,
            size: t.size(id) as f64,
            alloc: t.alloc(id) as f64,
            mtime: t.mtime(id) as f64,
            flags: t.flags(id),
            path_lower: path,
        };
        if q.matches(&target, now) {
            hits.push(id);
            total_bytes += t.size(id);
        }
    });
    let total = hits.len() as u64;
    let k = (limit as usize).min(hits.len());
    let order = |a: &u32, b: &u32| t.cmp_size_desc(*a, *b);
    if k > 0 && k < hits.len() {
        hits.select_nth_unstable_by(k - 1, order);
    }
    hits.truncate(k);
    hits.sort_unstable_by(order);
    let rows = hits.into_iter().map(|id| SearchRow { node: t.row(id), path: t.path(id) }).collect();
    SearchResponse { total, total_bytes, rows, error: None }
}

pub fn ext_stats(t: &Tree, root: u32) -> Result<Vec<ExtStat>, EngineMessage> {
    if !t.live(root) {
        return Err(msg::invalid_node(root));
    }
    let mut acc: HashMap<u16, (u64, u64, u64)> = HashMap::new();
    let mut add = |id: u32| {
        if !t.is_dir(id) {
            let e = acc.entry(t.ext_id(id)).or_default();
            e.0 += t.size(id);
            e.1 += t.alloc(id);
            e.2 += 1;
        }
    };
    if t.is_dir(root) {
        walk_subtree(t, root, false, |id, _| add(id));
    } else {
        add(root);
    }
    let mut v: Vec<ExtStat> = acc
        .into_iter()
        .map(|(e, (size, alloc, count))| ExtStat { ext: t.exts()[e as usize].clone(), size, alloc, count })
        .collect();
    v.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.ext.cmp(&b.ext)));
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{build, RawTree};
    use crate::tree::NONE;
    use crate::types::flag;

    fn sample() -> Tree {
        let mut r = RawTree::with_capacity(8);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        r.push(root, b"b.TXT", 50, 4096, 10, 0);
        let a = r.push(root, b"node_modules", 0, 0, 20, flag::DIR);
        r.push(a, b"z.bin", 1, 4096, 30, 0);
        r.push(a, b"a1.bin", 100, 8192, 40, 0);
        r.push(a, b"Y.bin", 1, 4096, 30, 0);
        r.push(root, b"README", 7, 0, 50, flag::HIDDEN);
        r.root = root;
        build(r, "C:\\".into(), &[]).unwrap()
    }

    #[test]
    fn children_sorting() {
        let t = sample();
        let a = 1;
        assert_eq!(t.name(a), "node_modules");
        let names = |r: ChildrenResponse| r.rows.into_iter().map(|r| r.name).collect::<Vec<_>>();
        assert_eq!(names(children(&t, a, 0, 10, SortKey::Size, true).unwrap()), ["a1.bin", "Y.bin", "z.bin"]);
        assert_eq!(names(children(&t, a, 0, 10, SortKey::Size, false).unwrap()), ["Y.bin", "z.bin", "a1.bin"]);
        assert_eq!(names(children(&t, a, 0, 10, SortKey::Name, false).unwrap()), ["a1.bin", "Y.bin", "z.bin"]);
        assert_eq!(names(children(&t, a, 0, 10, SortKey::Name, true).unwrap()), ["z.bin", "Y.bin", "a1.bin"]);
        assert_eq!(names(children(&t, a, 1, 1, SortKey::Size, true).unwrap()), ["Y.bin"]);
        let r = children(&t, 0, 0, 10, SortKey::Files, true).unwrap();
        assert_eq!(r.total, 3);
        assert_eq!(r.rows[0].name, "node_modules");
    }

    /// Árbol de Linux: rutas con `/` (también en `path:`) y sin barra doble bajo `/`.
    #[test]
    fn posix_paths() {
        let raw = || {
            let mut r = RawTree::with_capacity(4);
            let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
            let a = r.push(root, b"node_modules", 0, 0, 0, flag::DIR);
            r.push(a, b"x.js", 5, 4096, 0, 0);
            r.root = root;
            r
        };
        let t = build(raw(), "/home/Ana".into(), &[]).unwrap();
        assert_eq!(t.sep(), '/');
        let s = search(&t, "path:ana/node_modules/", 0, 10);
        assert_eq!((s.total, s.rows[0].path.as_str()), (1, "/home/Ana/node_modules/x.js"));
        assert_eq!(search(&t, "path:node_modules\\", 0, 10).total, 0);
        let t = build(raw(), "/".into(), &[]).unwrap();
        assert_eq!((t.path(0).as_str(), t.path(1).as_str(), t.path(2).as_str()), ("/", "/node_modules", "/node_modules/x.js"));
        assert_eq!(search(&t, "path:/node_modules/x", 0, 10).total, 1);
    }

    #[test]
    fn search_semantics() {
        let t = sample();
        let r = search(&t, "", 0, 2);
        assert_eq!(r.total, 5);
        assert_eq!(r.total_bytes, 159);
        assert_eq!(r.rows.iter().map(|r| r.node.name.as_str()).collect::<Vec<_>>(), ["a1.bin", "b.TXT"]);
        assert_eq!(r.rows[0].path, "C:\\node_modules\\a1.bin");
        let r = search(&t, "path:node_modules", 0, 10);
        assert_eq!(r.total, 3);
        // attr: usa los bits de flag del nodo
        assert_eq!(search(&t, "attr:hidden", 0, 10).rows[0].node.name, "README");
        assert_eq!(search(&t, "-atrib:oculto", 0, 10).total, 4);
        let r = search(&t, "type:dir", 0, 10);
        assert_eq!(r.total, 1);
        assert_eq!(r.rows[0].path, "C:\\node_modules");
        let r = search(&t, "", 1, 10);
        assert_eq!(r.total, 3);
        let r = search(&t, "size:>abc", 0, 10);
        assert_eq!(r.error.unwrap().code, "query.invalidValue");
        assert_eq!(search(&t, "", 999, 10).error.unwrap().code, "error.invalidNode");
        assert_eq!(children(&t, 999, 0, 10, SortKey::Size, true).unwrap_err().code, "error.invalidNode");
        assert_eq!(ext_stats(&t, 999).unwrap_err().get("id"), Some(&crate::types::Param::Int(999)));
        let e = ext_stats(&t, 0).unwrap();
        assert_eq!(e[0], ExtStat { ext: "bin".into(), size: 102, alloc: 16384, count: 3 });
        assert_eq!(e.iter().find(|x| x.ext.is_empty()).unwrap().count, 1);
    }
}
