//! Construcción del árbol final a partir de las entradas en bruto de un motor:
//! enlace de hijos (CSR), agregación ascendente en una pasada, orden de hijos por tamaño
//! desc y renumeración por niveles para que los hijos queden contiguos.

use std::collections::HashMap;

use rayon::prelude::*;

use crate::names;
use crate::tree::{Tree, NONE};
use crate::types::flag;

/// Entradas tal como las produce un motor: padre en bruto, tamaños propios (las carpetas
/// en 0) y nombres en un único bloque WTF-8.
#[derive(Default)]
pub struct RawTree {
    pub parent: Vec<u32>,
    pub size: Vec<u64>,
    pub alloc: Vec<u64>,
    pub mtime: Vec<u32>,
    pub flags: Vec<u16>,
    pub name_off: Vec<u32>,
    pub name_len: Vec<u16>,
    pub names: Vec<u8>,
    pub root: u32,
}

impl RawTree {
    pub fn with_capacity(n: usize) -> Self {
        RawTree {
            parent: Vec::with_capacity(n),
            size: Vec::with_capacity(n),
            alloc: Vec::with_capacity(n),
            mtime: Vec::with_capacity(n),
            flags: Vec::with_capacity(n),
            name_off: Vec::with_capacity(n),
            name_len: Vec::with_capacity(n),
            names: Vec::with_capacity(n * 16),
            root: 0,
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.parent.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.parent.is_empty()
    }

    /// Añade una entrada con nombre WTF-8.
    pub fn push(&mut self, parent: u32, name: &[u8], size: u64, alloc: u64, mtime: u32, flags: u16) -> u32 {
        let id = self.parent.len() as u32;
        self.parent.push(parent);
        self.size.push(size);
        self.alloc.push(alloc);
        self.mtime.push(mtime);
        self.flags.push(flags);
        self.name_off.push(self.names.len() as u32);
        self.name_len.push(name.len().min(u16::MAX as usize) as u16);
        self.names.extend_from_slice(&name[..name.len().min(u16::MAX as usize)]);
        id
    }

    #[inline]
    fn name(&self, v: u32) -> &[u8] {
        let o = self.name_off[v as usize] as usize;
        &self.names[o..o + self.name_len[v as usize] as usize]
    }

    #[inline]
    fn is_dir(&self, v: u32) -> bool {
        self.flags[v as usize] & flag::DIR != 0
    }
}

/// Construye el árbol. `sub` permite tomar como raíz una subcarpeta (componentes de ruta
/// bajo `raw.root`), p. ej. cuando el lector MFT recorre todo el volumen.
pub fn build(mut raw: RawTree, root_path: String, sub: &[String]) -> Result<Tree, String> {
    let n = raw.len();
    if n == 0 || raw.root as usize >= n {
        return Err("Empty scan".into());
    }
    if n >= NONE as usize {
        return Err("Too many entries".into());
    }
    let root0 = raw.root;
    // 1) Hijos en formato CSR
    let mut start = vec![0u32; n + 1];
    for v in 0..n {
        let p = raw.parent[v];
        if p != NONE && (p as usize) < n && v as u32 != root0 {
            start[p as usize + 1] += 1;
        }
    }
    for i in 0..n {
        start[i + 1] += start[i];
    }
    let mut kids = vec![0u32; start[n] as usize];
    {
        let mut fill: Vec<u32> = start[..n].to_vec();
        for v in 0..n {
            let p = raw.parent[v];
            if p != NONE && (p as usize) < n && v as u32 != root0 {
                kids[fill[p as usize] as usize] = v as u32;
                fill[p as usize] += 1;
            }
        }
    }
    let kids_of = |v: u32| -> std::ops::Range<usize> { start[v as usize] as usize..start[v as usize + 1] as usize };

    // 2) Raíz (o subcarpeta pedida)
    let mut root = root0;
    for comp in sub {
        let want = comp.to_lowercase();
        let found = kids[kids_of(root)]
            .iter()
            .copied()
            .find(|&k| raw.is_dir(k) && names::lossy(raw.name(k)).to_lowercase() == want);
        root = found.ok_or_else(|| format!("Folder not found in the volume index: {comp}"))?;
    }

    // 3) Orden por niveles desde la raíz (sólo lo alcanzable)
    let mut order: Vec<u32> = Vec::with_capacity(n);
    order.push(root);
    let mut i = 0;
    while i < order.len() {
        let v = order[i];
        i += 1;
        if raw.is_dir(v) {
            order.extend_from_slice(&kids[kids_of(v)]);
        }
    }

    // 4) Agregación ascendente: recorrido inverso del orden por niveles
    let mut files = vec![0u32; n];
    let mut dirs = vec![0u32; n];
    for &v in &order {
        if raw.is_dir(v) {
            raw.size[v as usize] = 0;
            raw.alloc[v as usize] = 0;
        }
    }
    for &v in order.iter().rev() {
        if v == root {
            continue;
        }
        let (vi, p) = (v as usize, raw.parent[v as usize] as usize);
        raw.size[p] += raw.size[vi];
        raw.alloc[p] += raw.alloc[vi];
        if raw.flags[vi] & flag::DIR != 0 {
            dirs[p] += dirs[vi] + 1;
            files[p] += files[vi];
        } else {
            files[p] += 1;
        }
    }

    // 5) Hijos por tamaño desc (desempate por nombre), en paralelo por tramos del CSR
    {
        let raw_ref = &raw;
        let cmp = |a: &u32, b: &u32| {
            raw_ref.size[*b as usize]
                .cmp(&raw_ref.size[*a as usize])
                .then_with(|| names::cmp_ci(raw_ref.name(*a), raw_ref.name(*b)))
                .then_with(|| a.cmp(b))
        };
        let target = (kids.len() / (rayon::current_num_threads().max(1) * 16)).max(8192);
        let mut parts: Vec<(usize, usize, &mut [u32])> = Vec::new();
        let mut rest: &mut [u32] = &mut kids;
        let mut node = 0usize;
        while node < n {
            let mut end = node + 1;
            while end < n && ((start[end + 1] - start[node]) as usize) < target {
                end += 1;
            }
            let len = (start[end] - start[node]) as usize;
            let (a, b) = std::mem::take(&mut rest).split_at_mut(len);
            parts.push((node, end, a));
            rest = b;
            node = end;
        }
        parts.into_par_iter().for_each(|(s, e, seg)| {
            let off = start[s] as usize;
            for v in s..e {
                let r = start[v] as usize - off..start[v + 1] as usize - off;
                if r.len() > 1 {
                    seg[r].sort_unstable_by(cmp);
                }
            }
        });
    }

    // 6) Renumeración por niveles: hijos contiguos y ya ordenados
    let m = order.len();
    drop(order);
    let mut raw_of: Vec<u32> = Vec::with_capacity(m);
    let mut parent_new: Vec<u32> = Vec::with_capacity(m);
    let mut first = vec![0u32; m];
    let mut count = vec![0u32; m];
    raw_of.push(root);
    parent_new.push(NONE);
    let mut i = 0;
    while i < raw_of.len() {
        let v = raw_of[i];
        first[i] = raw_of.len() as u32;
        if raw.is_dir(v) {
            let r = kids_of(v);
            count[i] = r.len() as u32;
            raw_of.extend_from_slice(&kids[r.clone()]);
            parent_new.extend(std::iter::repeat_n(i as u32, r.len()));
        }
        i += 1;
    }
    drop(kids);
    drop(start);

    let g64 = |src: &Vec<u64>| -> Vec<u64> { raw_of.par_iter().map(|&v| src[v as usize]).collect() };
    let g32 = |src: &Vec<u32>| -> Vec<u32> { raw_of.par_iter().map(|&v| src[v as usize]).collect() };
    let g16 = |src: &Vec<u16>| -> Vec<u16> { raw_of.par_iter().map(|&v| src[v as usize]).collect() };
    let size = g64(&raw.size);
    let alloc = g64(&raw.alloc);
    let files = g32(&files);
    let dirs = g32(&dirs);
    let mtime = g32(&raw.mtime);
    let flags = g16(&raw.flags);
    let name_off = g32(&raw.name_off);
    let name_len = g16(&raw.name_len);
    drop(raw_of);

    // 7) Extensiones internadas (0 = "")
    let mut exts: Vec<String> = vec![String::new()];
    let mut map: HashMap<String, u16> = HashMap::new();
    map.insert(String::new(), 0);
    let mut ext = vec![0u16; m];
    for j in 0..m {
        if flags[j] & flag::DIR != 0 {
            continue;
        }
        let o = name_off[j] as usize;
        let e = names::ext_of(&raw.names[o..o + name_len[j] as usize]);
        ext[j] = match map.get(e.as_ref()) {
            Some(&id) => id,
            None if exts.len() < 0xFFFF => {
                let id = exts.len() as u16;
                exts.push(e.to_string());
                map.insert(e.into_owned(), id);
                id
            }
            None => 0,
        };
    }

    let mut flags = flags;
    flags[0] |= flag::DIR;
    Ok(Tree {
        parent: parent_new,
        first,
        count,
        size,
        alloc,
        files,
        dirs,
        mtime,
        ext,
        flags,
        name_off,
        name_len,
        names: std::mem::take(&mut raw.names),
        exts,
        root_path,
        removed: Default::default(),
        dirty: Default::default(),
        cmp: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// raíz -> a(dir) -> a1.bin 100, a2.bin 1 ; b.txt 50 ; vacía(dir)
    pub(crate) fn sample() -> Tree {
        let mut r = RawTree::with_capacity(8);
        let root = r.push(NONE, b"", 0, 0, 0, flag::DIR);
        let b = r.push(root, b"b.TXT", 50, 4096, 10, 0);
        let a = r.push(root, b"a", 0, 0, 20, flag::DIR);
        r.push(a, b"a2.bin", 1, 4096, 30, flag::HIDDEN);
        r.push(a, b"a1.bin", 100, 4096, 40, 0);
        r.push(root, b"vacia", 0, 0, 50, flag::DIR);
        let _ = b;
        r.root = root;
        build(r, "C:\\".into(), &[]).unwrap()
    }

    #[test]
    fn builds_sorted_contiguous() {
        let t = sample();
        assert_eq!(t.len(), 6);
        assert_eq!(t.size(0), 151);
        assert_eq!(t.alloc(0), 3 * 4096);
        assert_eq!(t.files(0), 3);
        assert_eq!(t.dirs(0), 2);
        let k = t.kids(0).to_vec();
        assert_eq!(k, vec![1, 2, 3]);
        assert_eq!(t.name(1), "a");
        assert_eq!(t.name(2), "b.TXT");
        assert_eq!(t.ext(2), "txt");
        assert_eq!(t.name(3), "vacia");
        let ka = t.kids(1).to_vec();
        assert_eq!(ka.iter().map(|&k| t.name(k).into_owned()).collect::<Vec<_>>(), ["a1.bin", "a2.bin"]);
        assert_eq!(t.path(ka[0]), "C:\\a\\a1.bin");
        assert_eq!(t.path(0), "C:\\");
        assert_eq!(t.parent(ka[1]), Some(1));
    }

    #[test]
    fn remove_updates_ancestors() {
        let mut t = sample();
        let a1 = t.kids(1).get(0);
        t.remove(a1).unwrap();
        assert_eq!(t.size(1), 1);
        assert_eq!(t.size(0), 51);
        assert_eq!(t.files(0), 2);
        assert_eq!(t.child_count(1), 1);
        // b.txt (50) pasa delante de a (1)
        let k = t.kids(0).to_vec();
        assert_eq!(t.name(k[0]), "b.TXT");
        assert!(!t.live(a1));
        assert!(t.remove(a1).is_err());
    }

    #[test]
    fn reroot_subfolder() {
        let mut r = RawTree::with_capacity(4);
        let root = r.push(NONE, b".", 0, 0, 0, flag::DIR);
        let w = r.push(root, b"Windows", 0, 0, 0, flag::DIR);
        r.push(w, b"x.dll", 7, 8, 0, 0);
        r.push(root, b"y", 9, 9, 0, 0);
        r.root = root;
        let t = build(r, "C:\\Windows".into(), &["windows".into()]).unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t.size(0), 7);
        assert_eq!(t.path(1), "C:\\Windows\\x.dll");
    }
}
