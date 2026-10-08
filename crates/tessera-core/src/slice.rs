//! Formato binario "slice" v1 (ver docs/ARQUITECTURA.md). Réplica byte a byte de
//! `encodeSlice` en `packages/protocol/src/slice.ts`.

use std::collections::HashMap;

use crate::names;
use crate::tree::Tree;
use crate::types::flag;

pub const SLICE_MAGIC: u32 = 0x314C_5354; // "TSL1"
pub const SLICE_VERSION: u32 = 1;
pub const SLICE_HEADER: usize = 32;
pub const SLICE_RECORD: usize = 64;
pub const NO_EXT: u16 = 0xFFFF;

pub fn encode_slice(t: &Tree, root: u32, min_bytes: f64, max_nodes: u32) -> Vec<u8> {
    let max_nodes = max_nodes as usize;
    // 1) Selección por niveles: el presupuesto se gasta primero en lo que más se ve
    let mut picked: HashMap<u32, Vec<u32>> = HashMap::new();
    picked.insert(root, Vec::new());
    let mut count = 1usize;
    let mut level = vec![root];
    while !level.is_empty() && count < max_nodes {
        let mut next = Vec::new();
        for &id in &level {
            if !t.is_dir(id) {
                continue;
            }
            let kids = t.kids(id);
            let mut keep = Vec::new();
            let mut i = 0;
            while i < kids.len() && count < max_nodes {
                let k = kids.get(i);
                if (t.size(k) as f64) < min_bytes {
                    break; // ordenados desc: el resto también es menor
                }
                keep.push(k);
                picked.insert(k, Vec::new());
                next.push(k);
                count += 1;
                i += 1;
            }
            picked.insert(id, keep);
        }
        level = next;
    }

    // 2) Preorden, tablas de extensiones y nombres
    let mut ext_idx: HashMap<u16, u16> = HashMap::new();
    let mut ext_list: Vec<Vec<u8>> = Vec::new();
    let mut order: Vec<(u32, i32, u32)> = Vec::with_capacity(count);
    let mut stack: Vec<(u32, i32, u32)> = vec![(root, -1, 0)];
    while let Some((id, p, d)) = stack.pop() {
        let me = order.len() as i32;
        order.push((id, p, d));
        if !t.is_dir(id) {
            let e = t.ext_id(id);
            if let std::collections::hash_map::Entry::Vacant(v) = ext_idx.entry(e) {
                v.insert(ext_list.len() as u16);
                let b = t.ext(id).as_bytes();
                ext_list.push(b[..b.len().min(255)].to_vec());
            }
        }
        let keep = &picked[&id];
        for &k in keep.iter().rev() {
            stack.push((k, me, d + 1));
        }
    }
    let name_bufs: Vec<std::borrow::Cow<str>> = order.iter().map(|&(id, _, _)| names::lossy(t.name_bytes(id))).collect();
    let ext_bytes: usize = ext_list.iter().map(|b| 1 + b.len()).sum();
    let names_bytes: usize = name_bufs.iter().map(|b| b.len()).sum();
    let rec_start = SLICE_HEADER + ext_bytes.div_ceil(8) * 8;
    let total = rec_start + order.len() * SLICE_RECORD + names_bytes;
    let mut out = vec![0u8; total];
    let w32 = |o: &mut [u8], at: usize, v: u32| o[at..at + 4].copy_from_slice(&v.to_le_bytes());
    let w16 = |o: &mut [u8], at: usize, v: u16| o[at..at + 2].copy_from_slice(&v.to_le_bytes());
    let wf = |o: &mut [u8], at: usize, v: f64| o[at..at + 8].copy_from_slice(&v.to_le_bytes());
    w32(&mut out, 0, SLICE_MAGIC);
    w32(&mut out, 4, SLICE_VERSION);
    w32(&mut out, 8, order.len() as u32);
    w32(&mut out, 12, ext_list.len() as u32);
    w32(&mut out, 16, names_bytes as u32);
    w32(&mut out, 20, ext_bytes as u32);
    wf(&mut out, 24, min_bytes);
    let mut o = SLICE_HEADER;
    for b in &ext_list {
        out[o] = b.len() as u8;
        o += 1;
        out[o..o + b.len()].copy_from_slice(b);
        o += b.len();
    }
    let names_start = rec_start + order.len() * SLICE_RECORD;
    let mut name_off = 0usize;
    for (i, &(id, p, d)) in order.iter().enumerate() {
        let r = rec_start + i * SLICE_RECORD;
        let dir = t.is_dir(id);
        let (mut rest_size, mut rest_count, mut child_count) = (0u64, 0u32, 0u32);
        if dir {
            let kids_len = t.kids(id).len() as u32;
            let keep = &picked[&id];
            child_count = kids_len;
            let kept: u64 = keep.iter().map(|&k| t.size(k)).sum();
            rest_size = t.size(id).saturating_sub(kept);
            rest_count = kids_len - keep.len() as u32;
        }
        w32(&mut out, r, id);
        w32(&mut out, r + 4, p as u32);
        wf(&mut out, r + 8, t.size(id) as f64);
        wf(&mut out, r + 16, t.alloc(id) as f64);
        wf(&mut out, r + 24, rest_size as f64);
        w32(&mut out, r + 32, rest_count);
        w32(&mut out, r + 36, t.files(id));
        w32(&mut out, r + 40, t.dirs(id));
        w32(&mut out, r + 44, t.mtime(id));
        w16(&mut out, r + 48, if dir { NO_EXT } else { ext_idx[&t.ext_id(id)] });
        w16(&mut out, r + 50, t.flags(id) | if dir { flag::DIR } else { 0 });
        w32(&mut out, r + 52, name_off as u32);
        let nb = name_bufs[i].as_bytes();
        w16(&mut out, r + 56, nb.len() as u16);
        w16(&mut out, r + 58, d.min(0xFFFF) as u16);
        w32(&mut out, r + 60, child_count);
        out[names_start + name_off..names_start + name_off + nb.len()].copy_from_slice(nb);
        name_off += nb.len();
    }
    out
}

/// Nodo decodificado (para pruebas y la CLI).
#[derive(Debug, Clone)]
pub struct SliceNode {
    pub id: u32,
    pub parent: i32,
    pub name: String,
    pub is_dir: bool,
    pub size: f64,
    pub alloc: f64,
    pub rest_size: f64,
    pub rest_count: u32,
    pub files: u32,
    pub dirs: u32,
    pub mtime: u32,
    pub ext: String,
    pub flags: u16,
    pub depth: u16,
    pub child_count: u32,
}

pub fn decode_slice(b: &[u8]) -> Result<(Vec<SliceNode>, f64), String> {
    let r32 = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let r16 = |o: usize| u16::from_le_bytes(b[o..o + 2].try_into().unwrap());
    let rf = |o: usize| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    if b.len() < SLICE_HEADER || r32(0) != SLICE_MAGIC {
        return Err("Slice inválido: firma incorrecta".into());
    }
    if r32(4) != SLICE_VERSION {
        return Err("Slice inválido: versión no soportada".into());
    }
    let (count, ext_count, ext_bytes) = (r32(8) as usize, r32(12) as usize, r32(20) as usize);
    let min_bytes = rf(24);
    let mut exts = Vec::with_capacity(ext_count);
    let mut o = SLICE_HEADER;
    for _ in 0..ext_count {
        let len = b[o] as usize;
        o += 1;
        exts.push(String::from_utf8_lossy(&b[o..o + len]).into_owned());
        o += len;
    }
    let rec_start = SLICE_HEADER + ext_bytes.div_ceil(8) * 8;
    let names_start = rec_start + count * SLICE_RECORD;
    let mut nodes = Vec::with_capacity(count);
    for i in 0..count {
        let r = rec_start + i * SLICE_RECORD;
        let flags = r16(r + 50);
        let ext_i = r16(r + 48);
        let (n_off, n_len) = (r32(r + 52) as usize, r16(r + 56) as usize);
        nodes.push(SliceNode {
            id: r32(r),
            parent: r32(r + 4) as i32,
            name: String::from_utf8_lossy(&b[names_start + n_off..names_start + n_off + n_len]).into_owned(),
            is_dir: flags & 1 != 0,
            size: rf(r + 8),
            alloc: rf(r + 16),
            rest_size: rf(r + 24),
            rest_count: r32(r + 32),
            files: r32(r + 36),
            dirs: r32(r + 40),
            mtime: r32(r + 44),
            ext: if ext_i == NO_EXT { String::new() } else { exts[ext_i as usize].clone() },
            flags,
            depth: r16(r + 58),
            child_count: r32(r + 60),
        });
    }
    Ok((nodes, min_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{build, RawTree};
    use crate::tree::NONE;

    #[test]
    fn roundtrip_with_pruning() {
        // Mismo caso que packages/protocol/test: raíz -> a(dir){a1.bin 100, a2.bin 1}, b.txt 50
        let mut r = RawTree::with_capacity(5);
        let root = r.push(NONE, b"", 0, 0, 1, flag::DIR);
        let a = r.push(root, b"a", 0, 0, 1, flag::DIR);
        r.push(root, b"b.txt", 50, 50, 1, 0);
        r.push(a, b"a1.bin", 100, 100, 1, 0);
        r.push(a, b"a2.bin", 1, 1, 1, 0);
        let t = build(r, "C:".into(), &[]).unwrap();
        let bytes = encode_slice(&t, 0, 10.0, 100);
        let (out, min) = decode_slice(&bytes).unwrap();
        assert_eq!(min, 10.0);
        assert_eq!(out.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["C:", "a", "a1.bin", "b.txt"]);
        assert_eq!(out[1].rest_size, 1.0);
        assert_eq!(out[1].rest_count, 1);
        assert!(out[1].is_dir);
        assert_eq!(out[2].ext, "bin");
        assert_eq!(out[2].parent, 1);
        assert_eq!(out[0].child_count, 2);
        assert_eq!(out[2].depth, 2);
        // Presupuesto: sólo la raíz y el primer nivel
        let (few, _) = decode_slice(&encode_slice(&t, 0, 0.0, 3)).unwrap();
        assert_eq!(few.len(), 3);
        assert_eq!(few[0].rest_count, 0);
        assert_eq!(few[1].rest_count, 2);
    }
}
