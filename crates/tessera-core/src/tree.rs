//! Almacén compacto en arreglos (SoA). Los ids son posiciones en orden por niveles (BFS):
//! la raíz es 0, cada padre precede a sus hijos y los hijos de una carpeta ocupan ids
//! contiguos `[first, first + count)` ordenados por tamaño desc (desempate por nombre).
//! Al volver a escanear una carpeta ([`Tree::graft`]) su contenido nuevo se añade al final, también
//! por niveles: el orden global deja de ser BFS, pero cada padre sigue precediendo a sus hijos.
//!
//! Coste: 50 B por nodo + nombres (WTF-8 en un único bloque).

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock, PoisonError, RwLock};

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
    /// FRN de NTFS de las carpetas, (id, FRN) en orden de id; vacío si el escaneo no lo guardó
    /// (sólo hace falta para actualizar con el diario USN).
    pub(crate) frn: Vec<(u32, u64)>,
    /// FRN → id de las carpetas vivas: se crea al primer uso y se descarta al injertar.
    pub(crate) frn_map: OnceLock<HashMap<u64, u32>>,
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

    /// Sustituye el contenido de la carpeta `id` por `sub`, la misma carpeta escaneada aparte (con su
    /// raíz en el 0). Lo que colgaba de ella queda muerto, como tras la papelera, y lo nuevo se añade
    /// al final con ids nuevos, por niveles (cada padre sigue precediendo a sus hijos). La carpeta
    /// conserva su id y toma los totales de `sub`; sus antepasados cambian por diferencia y recalculan
    /// el orden de hijos. `flags`: los de la carpeta según el sistema, si se conocen. Quita la
    /// comparación activa y el mapa de FRN.
    pub fn graft(&mut self, id: u32, sub: Tree, flags: Option<u16>) -> Result<(), String> {
        if id == 0 || !self.live(id) || !self.is_dir(id) {
            return Err("Invalid node".into());
        }
        let (base, n) = (self.len(), sub.len());
        if n == 0 {
            return Err("Empty scan".into());
        }
        if base + n >= NONE as usize {
            return Err("Too many entries".into());
        }
        let names_base = self.names.len();
        if names_base + sub.names.len() > u32::MAX as usize {
            return Err("Too many names for the name store".into());
        }
        let i = id as usize;
        // 1) Lo de antes queda muerto
        self.removed.extend(self.first[i]..self.first[i] + self.count[i]);
        self.dirty.remove(&id);
        // 2) Extensiones de `sub` → las del árbol (0 = "" si la tabla está llena, como al construir)
        let mut index: HashMap<String, u16> = self.exts.iter().enumerate().map(|(j, e)| (e.clone(), j as u16)).collect();
        let exts = &mut self.exts;
        let remap: Vec<u16> = sub
            .exts
            .iter()
            .map(|e| match index.get(e) {
                Some(&j) => j,
                None if exts.len() < 0xFFFF => {
                    let j = exts.len() as u16;
                    exts.push(e.clone());
                    index.insert(e.clone(), j);
                    j
                }
                None => 0,
            })
            .collect();
        // 3) Nodos nuevos: el nodo s de `sub` pasa a ser base + s − 1 (su raíz es la carpeta)
        let b = base as u32;
        let at = |s: u32| if s == 0 { id } else { b + s - 1 };
        self.parent.extend(sub.parent[1..].iter().map(|&p| at(p)));
        self.first.extend(sub.first[1..].iter().map(|&f| b + f - 1));
        self.count.extend_from_slice(&sub.count[1..]);
        self.size.extend_from_slice(&sub.size[1..]);
        self.alloc.extend_from_slice(&sub.alloc[1..]);
        self.files.extend_from_slice(&sub.files[1..]);
        self.dirs.extend_from_slice(&sub.dirs[1..]);
        self.mtime.extend_from_slice(&sub.mtime[1..]);
        self.ext.extend(sub.ext[1..].iter().map(|&e| remap[e as usize]));
        self.flags.extend_from_slice(&sub.flags[1..]);
        self.name_off.extend(sub.name_off[1..].iter().map(|&o| names_base as u32 + o));
        self.name_len.extend_from_slice(&sub.name_len[1..]);
        self.names.extend_from_slice(&sub.names);
        // 4) La carpeta, con los totales de `sub`; los antepasados, por diferencia
        let ds = sub.size[0] as i128 - self.size[i] as i128;
        let da = sub.alloc[0] as i128 - self.alloc[i] as i128;
        let df = sub.files[0] as i64 - self.files[i] as i64;
        let dd = sub.dirs[0] as i64 - self.dirs[i] as i64;
        self.first[i] = b + sub.first[0] - 1;
        self.count[i] = sub.count[0];
        self.size[i] = sub.size[0];
        self.alloc[i] = sub.alloc[0];
        self.files[i] = sub.files[0];
        self.dirs[i] = sub.dirs[0];
        if sub.mtime[0] != 0 {
            self.mtime[i] = sub.mtime[0];
        }
        if let Some(f) = flags {
            self.flags[i] = f | flag::DIR;
        }
        let shift64 = |v: u64, d: i128| (v as i128 + d).clamp(0, u64::MAX as i128) as u64;
        let shift32 = |v: u32, d: i64| (v as i64 + d).clamp(0, u32::MAX as i64) as u32;
        let mut a = self.parent[i];
        while a != NONE {
            let j = a as usize;
            self.size[j] = shift64(self.size[j], ds);
            self.alloc[j] = shift64(self.alloc[j], da);
            self.files[j] = shift32(self.files[j], df);
            self.dirs[j] = shift32(self.dirs[j], dd);
            // Con otro tamaño cambia el orden entre hermanos en cada nivel
            if ds != 0 {
                self.dirty.insert(a);
            }
            a = self.parent[j];
        }
        // 5) FRN de lo nuevo (y el de la carpeta, por si se borró y se volvió a crear)
        if !self.frn.is_empty() {
            for &(s, f) in &sub.frn {
                if s != 0 {
                    self.frn.push((at(s), f));
                } else {
                    match self.frn.binary_search_by_key(&id, |e| e.0) {
                        Ok(k) => self.frn[k].1 = f,
                        Err(k) => self.frn.insert(k, (id, f)),
                    }
                }
            }
        }
        self.frn_map = OnceLock::new();
        // 6) La comparación activa ya no describe este árbol
        *self.cmp.get_mut().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }

    // ---------- FRN (diario USN) ----------

    /// El escaneo guardó el FRN de las carpetas.
    pub fn has_frn(&self) -> bool {
        !self.frn.is_empty()
    }

    /// FRN guardado de una carpeta.
    pub fn frn_of(&self, id: u32) -> Option<u64> {
        self.frn.binary_search_by_key(&id, |e| e.0).ok().map(|k| self.frn[k].1)
    }

    /// Carpeta viva con ese FRN. El mapa se crea al primer uso.
    pub fn dir_by_frn(&self, frn: u64) -> Option<u32> {
        self.frn_map
            .get_or_init(|| {
                let dead = self.dead_mask();
                self.frn.iter().filter(|e| !dead.get(e.0 as usize).copied().unwrap_or(true)).map(|&(id, f)| (f, id)).collect()
            })
            .get(&frn)
            .copied()
    }

    /// Olvida los FRN (el escaneo no puede usar el diario USN).
    pub fn drop_frn(&mut self) {
        self.frn = Vec::new();
        self.frn_map = OnceLock::new();
    }

    /// `true` en lo que no está vivo, en una pasada (cada padre precede a sus hijos).
    fn dead_mask(&self) -> Vec<bool> {
        let mut dead = vec![false; self.len()];
        if !self.removed.is_empty() {
            for id in 0..self.len() {
                let p = self.parent[id];
                dead[id] = self.removed.contains(&(id as u32)) || (p != NONE && dead[p as usize]);
            }
        }
        dead
    }

    /// Bytes del bloque de nombres.
    pub fn names_len(&self) -> usize {
        self.names.len()
    }

    /// Bytes de memoria del almacén (sin contar la holgura de los Vec).
    pub fn memory_bytes(&self) -> usize {
        self.len() * 50 + self.names.len() + self.exts.iter().map(|e| e.len() + 24).sum::<usize>() + self.frn.len() * 16
    }
}
