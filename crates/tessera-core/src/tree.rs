//! Almacén compacto en arreglos (SoA). Los ids son posiciones en orden por niveles (BFS):
//! la raíz es 0, cada padre precede a sus hijos y los hijos de una carpeta ocupan ids
//! contiguos `[first, first + count)` ordenados por tamaño desc (desempate por nombre).
//!
//! Coste: 50 B por nodo + nombres (WTF-8 en un único bloque).

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::{Arc, PoisonError, RwLock};

use crate::history::Comparison;
use crate::names;
use crate::types::{flag, NodeRow};

pub const NONE: u32 = u32::MAX;

#[derive(Default)]
pub struct Tree {
    pub(crate) parent: Vec<u32>,
    pub(crate) first: Vec<u32>,
    pub(crate) count: Vec<u32>,
    pub(crate) size: Vec<u64>,
    pub(crate) alloc: Vec<u64>,
    pub(crate) files: Vec<u32>,
    pub(crate) dirs: Vec<u32>,
    pub(crate) mtime: Vec<u32>,
    pub(crate) ext: Vec<u16>,
    pub(crate) flags: Vec<u16>,
    pub(crate) name_off: Vec<u32>,
    pub(crate) name_len: Vec<u16>,
    pub(crate) names: Vec<u8>,
    /// Extensiones internadas; la 0 es "".
    pub(crate) exts: Vec<String>,
    /// Ruta completa de la raíz ("C:\\" o "C:\\Windows").
    pub(crate) root_path: String,
    /// Nodos quitados (papelera) y carpetas cuyo orden de hijos hay que recalcular.
    pub(crate) removed: HashSet<u32>,
    pub(crate) dirty: HashSet<u32>,
    /// Comparación activa con un resumen del historial. Se cambia con el árbol bajo lectura
    /// (sin esperar a una búsqueda de duplicados); un escaneo nuevo trae un árbol sin ella.
    pub(crate) cmp: RwLock<Option<Arc<Comparison>>>,
}

/// Hijos directos de una carpeta, ya ordenados por tamaño desc.
pub enum Kids {
    Range(std::ops::Range<u32>),
    List(Vec<u32>),
}

impl Kids {
    #[inline]
    pub fn len(&self) -> usize {
        match self {
            Kids::Range(r) => r.len(),
            Kids::List(v) => v.len(),
        }
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    #[inline]
    pub fn get(&self, i: usize) -> u32 {
        match self {
            Kids::Range(r) => r.start + i as u32,
            Kids::List(v) => v[i],
        }
    }
    pub fn to_vec(&self) -> Vec<u32> {
        match self {
            Kids::Range(r) => r.clone().collect(),
            Kids::List(v) => v.clone(),
        }
    }
}

impl Tree {
    #[inline]
    pub fn len(&self) -> usize {
        self.parent.len()
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.parent.is_empty()
    }
    pub fn root_path(&self) -> &str {
        &self.root_path
    }
    #[inline]
    pub fn valid(&self, id: u32) -> bool {
        (id as usize) < self.len()
    }
    /// El nodo existe y no está dentro de algo enviado a la papelera.
    pub fn live(&self, id: u32) -> bool {
        if !self.valid(id) {
            return false;
        }
        if self.removed.is_empty() {
            return true;
        }
        let mut a = id;
        while a != NONE {
            if self.removed.contains(&a) {
                return false;
            }
            a = self.parent[a as usize];
        }
        true
    }
    #[inline]
    pub fn is_dir(&self, id: u32) -> bool {
        self.flags[id as usize] & flag::DIR != 0
    }
    #[inline]
    pub fn parent(&self, id: u32) -> Option<u32> {
        let p = self.parent[id as usize];
        (p != NONE).then_some(p)
    }
    #[inline]
    pub fn size(&self, id: u32) -> u64 {
        self.size[id as usize]
    }
    #[inline]
    pub fn alloc(&self, id: u32) -> u64 {
        self.alloc[id as usize]
    }
    #[inline]
    pub fn files(&self, id: u32) -> u32 {
        self.files[id as usize]
    }
    #[inline]
    pub fn dirs(&self, id: u32) -> u32 {
        self.dirs[id as usize]
    }
    #[inline]
    pub fn mtime(&self, id: u32) -> u32 {
        self.mtime[id as usize]
    }
    #[inline]
    pub fn flags(&self, id: u32) -> u16 {
        self.flags[id as usize]
    }
    #[inline]
    pub fn ext_id(&self, id: u32) -> u16 {
        self.ext[id as usize]
    }
    #[inline]
    pub fn ext(&self, id: u32) -> &str {
        &self.exts[self.ext[id as usize] as usize]
    }
    pub fn exts(&self) -> &[String] {
        &self.exts
    }
    /// Nombre en WTF-8. La raíz se llama como su ruta.
    #[inline]
    pub fn name_bytes(&self, id: u32) -> &[u8] {
        if id == 0 {
            return self.root_path.as_bytes();
        }
        let o = self.name_off[id as usize] as usize;
        &self.names[o..o + self.name_len[id as usize] as usize]
    }
    #[inline]
    pub fn name(&self, id: u32) -> Cow<'_, str> {
        names::lossy(self.name_bytes(id))
    }

    /// Hijos ordenados por tamaño desc, sin los quitados.
    #[inline]
    pub fn kids(&self, id: u32) -> Kids {
        let i = id as usize;
        if self.flags[i] & flag::DIR == 0 {
            return Kids::Range(0..0);
        }
        let r = self.first[i]..self.first[i] + self.count[i];
        if self.dirty.is_empty() || !self.dirty.contains(&id) {
            return Kids::Range(r);
        }
        let mut v: Vec<u32> = r.filter(|k| !self.removed.contains(k)).collect();
        v.sort_unstable_by(|&a, &b| self.cmp_size_desc(a, b));
        Kids::List(v)
    }

    #[inline]
    pub fn child_count(&self, id: u32) -> u32 {
        if self.dirty.contains(&id) {
            self.kids(id).len() as u32
        } else if self.is_dir(id) {
            self.count[id as usize]
        } else {
            0
        }
    }

    /// Orden canónico: tamaño desc, nombre sin mayúsculas asc, id.
    pub fn cmp_size_desc(&self, a: u32, b: u32) -> Ordering {
        self.size(b)
            .cmp(&self.size(a))
            .then_with(|| names::cmp_ci(self.name_bytes(a), self.name_bytes(b)))
            .then_with(|| a.cmp(&b))
    }

    /// Comparación activa, si la hay.
    pub fn comparison(&self) -> Option<Arc<Comparison>> {
        self.cmp.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Activa (o quita, con `None`) la comparación.
    pub fn set_comparison(&self, c: Option<Arc<Comparison>>) {
        *self.cmp.write().unwrap_or_else(PoisonError::into_inner) = c;
    }

    /// Fila del contrato; con una comparación activa lleva `prev`/`fresh`.
    pub fn row(&self, id: u32) -> NodeRow {
        let dir = self.is_dir(id);
        let (prev, fresh) = match self.comparison() {
            Some(c) => (c.prev(id), c.is_fresh(id).then_some(true)),
            None => (None, None),
        };
        NodeRow {
            id,
            parent_id: self.parent(id).map_or(-1, |p| p as i64),
            name: self.name(id).into_owned(),
            is_dir: dir,
            size: self.size(id),
            alloc: self.alloc(id),
            files: self.files(id),
            dirs: self.dirs(id),
            mtime: self.mtime(id),
            ext: if dir { String::new() } else { self.ext(id).to_string() },
            flags: self.flags(id),
            child_count: self.child_count(id),
            prev,
            fresh,
        }
    }

    /// Antepasados de `id` desde la raíz (excluida) hasta `id` (incluido).
    fn chain(&self, id: u32) -> Vec<u32> {
        let mut v = Vec::new();
        let mut a = id;
        while a != NONE && a != 0 {
            v.push(a);
            a = self.parent[a as usize];
        }
        v.reverse();
        v
    }

    /// Ruta completa (UTF-8, con U+FFFD si el nombre no es UTF-16 válido).
    pub fn path(&self, id: u32) -> String {
        let mut s = self.root_path.clone();
        for a in self.chain(id) {
            if !s.ends_with('\\') {
                s.push('\\');
            }
            s.push_str(&self.name(a));
        }
        s
    }

    /// Ruta exacta en UTF-16 (sin terminador), para la API de Windows.
    pub fn path_wide(&self, id: u32) -> Vec<u16> {
        let mut w: Vec<u16> = self.root_path.encode_utf16().collect();
        for a in self.chain(id) {
            if w.last() != Some(&(b'\\' as u16)) {
                w.push(b'\\' as u16);
            }
            names::push_wide(&mut w, self.name_bytes(a));
        }
        w
    }

    /// Quita un nodo (tras enviarlo a la papelera): resta sus totales de los antepasados
    /// y lo saca de la lista de hijos de su padre. Los ids no cambian.
    pub fn remove(&mut self, id: u32) -> Result<(), String> {
        if id == 0 || !self.live(id) {
            return Err("Invalid node".into());
        }
        let i = id as usize;
        let dir = self.is_dir(id);
        let (ds, da) = (self.size[i], self.alloc[i]);
        let df = self.files[i] + u32::from(!dir);
        let dd = self.dirs[i] + u32::from(dir);
        self.removed.insert(id);
        let mut a = self.parent[i];
        self.dirty.insert(a);
        while a != NONE {
            let j = a as usize;
            self.size[j] = self.size[j].saturating_sub(ds);
            self.alloc[j] = self.alloc[j].saturating_sub(da);
            self.files[j] = self.files[j].saturating_sub(df);
            self.dirs[j] = self.dirs[j].saturating_sub(dd);
            a = self.parent[j];
            if a != NONE {
                self.dirty.insert(a);
            }
        }
        Ok(())
    }

    /// Bytes del bloque de nombres.
    pub fn names_len(&self) -> usize {
        self.names.len()
    }

    /// Bytes de memoria del almacén (sin contar la holgura de los Vec).
    pub fn memory_bytes(&self) -> usize {
        self.len() * 50 + self.names.len() + self.exts.iter().map(|e| e.len() + 24).sum::<usize>()
    }
}
