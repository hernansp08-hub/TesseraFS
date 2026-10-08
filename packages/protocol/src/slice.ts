// Formato binario "slice" v1: subárbol podado para dibujar el mapa. Ver docs/ARQUITECTURA.md.

export const SLICE_MAGIC = 0x314C5354; // "TSL1"
export const SLICE_VERSION = 1;
export const SLICE_HEADER = 32;
export const SLICE_RECORD = 64;
export const NO_EXT = 0xFFFF;

/** Acceso de sólo lectura al árbol completo de un motor. `children` debe venir ordenado por tamaño desc. */
export interface SliceSource {
  isDir(id: number): boolean;
  name(id: number): string;
  ext(id: number): string;
  size(id: number): number;
  alloc(id: number): number;
  files(id: number): number;
  dirs(id: number): number;
  mtime(id: number): number;
  flags(id: number): number;
  children(id: number): ArrayLike<number>;
}

const enc = new TextEncoder();

export function encodeSlice(src: SliceSource, root: number, minBytes: number, maxNodes: number): Uint8Array {
  // 1) Selección por niveles: así el presupuesto se gasta primero en lo que más se ve
  const picked = new Map<number, number[]>(); // id -> hijos incluidos
  picked.set(root, []);
  let count = 1;
  let level = [root];
  while (level.length && count < maxNodes) {
    const next: number[] = [];
    for (const id of level) {
      if (!src.isDir(id)) continue;
      const kids = src.children(id), keep = picked.get(id)!;
      for (let i = 0; i < kids.length && count < maxNodes; i++) {
        const k = kids[i];
        if (src.size(k) < minBytes) break; // ordenados desc: el resto también es menor
        keep.push(k); picked.set(k, []); next.push(k); count++;
      }
    }
    level = next;
  }
  // 2) Tablas de extensiones y nombres
  const extIdx = new Map<string, number>(), extList: string[] = [];
  const order: number[] = [], parentIdx: number[] = [], depth: number[] = [];
  const stack: [number, number, number][] = [[root, -1, 0]];
  while (stack.length) {
    const [id, p, d] = stack.pop()!;
    const me = order.length; order.push(id); parentIdx.push(p); depth.push(d);
    if (!src.isDir(id)) { const e = src.ext(id); if (!extIdx.has(e)) { extIdx.set(e, extList.length); extList.push(e); } }
    const keep = picked.get(id)!;
    for (let i = keep.length - 1; i >= 0; i--) stack.push([keep[i], me, d + 1]);
  }
  const names = order.map(id => enc.encode(src.name(id)));
  const extBytesArr = extList.map(e => enc.encode(e).subarray(0, 255));
  const extBytes = extBytesArr.reduce((s, b) => s + 1 + b.length, 0);
  const namesBytes = names.reduce((s, b) => s + b.length, 0);
  const recStart = SLICE_HEADER + Math.ceil(extBytes / 8) * 8;
  const total = recStart + order.length * SLICE_RECORD + namesBytes;
  const buf = new ArrayBuffer(total), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint32(0, SLICE_MAGIC, true); dv.setUint32(4, SLICE_VERSION, true);
  dv.setUint32(8, order.length, true); dv.setUint32(12, extList.length, true);
  dv.setUint32(16, namesBytes, true); dv.setUint32(20, extBytes, true);
  dv.setFloat64(24, minBytes, true);
  let o = SLICE_HEADER;
  for (const b of extBytesArr) { u8[o++] = b.length; u8.set(b, o); o += b.length; }
  let nameOff = 0;
  const namesStart = recStart + order.length * SLICE_RECORD;
  for (let i = 0; i < order.length; i++) {
    const id = order[i], r = recStart + i * SLICE_RECORD, dir = src.isDir(id);
    let restSize = 0, restCount = 0, childCount = 0;
    if (dir) {
      const kids = src.children(id), keep = picked.get(id)!;
      childCount = kids.length;
      let kept = 0; for (const k of keep) kept += src.size(k);
      restSize = Math.max(0, src.size(id) - kept); restCount = kids.length - keep.length;
    }
    dv.setUint32(r, id, true); dv.setInt32(r + 4, parentIdx[i], true);
    dv.setFloat64(r + 8, src.size(id), true); dv.setFloat64(r + 16, src.alloc(id), true);
    dv.setFloat64(r + 24, restSize, true); dv.setUint32(r + 32, restCount, true);
    dv.setUint32(r + 36, src.files(id), true); dv.setUint32(r + 40, src.dirs(id), true);
    dv.setUint32(r + 44, src.mtime(id) >>> 0, true);
    dv.setUint16(r + 48, dir ? NO_EXT : extIdx.get(src.ext(id))!, true);
    dv.setUint16(r + 50, (src.flags(id) | (dir ? 1 : 0)) & 0xFFFF, true);
    dv.setUint32(r + 52, nameOff, true); dv.setUint16(r + 56, names[i].length, true);
    dv.setUint16(r + 58, Math.min(depth[i], 0xFFFF), true); dv.setUint32(r + 60, childCount, true);
    u8.set(names[i], namesStart + nameOff); nameOff += names[i].length;
  }
  return u8;
}

export interface SliceNode {
  id: number;
  parent: SliceNode | null;
  name: string;
  isDir: boolean;
  size: number;
  alloc: number;
  restSize: number;
  restCount: number;
  files: number;
  dirs: number;
  mtime: number;
  ext: string;
  flags: number;
  depth: number;
  childCount: number;
  kids: SliceNode[];
}

const dec = new TextDecoder();

export function decodeSlice(input: ArrayBuffer | Uint8Array): { nodes: SliceNode[]; minBytes: number } {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== SLICE_MAGIC) throw new Error('Slice inválido: firma incorrecta');
  if (dv.getUint32(4, true) !== SLICE_VERSION) throw new Error('Slice inválido: versión no soportada');
  const count = dv.getUint32(8, true), extCount = dv.getUint32(12, true), extBytes = dv.getUint32(20, true);
  const minBytes = dv.getFloat64(24, true);
  const exts: string[] = [];
  let o = SLICE_HEADER;
  for (let i = 0; i < extCount; i++) { const len = u8[o++]; exts.push(dec.decode(u8.subarray(o, o + len))); o += len; }
  const recStart = SLICE_HEADER + Math.ceil(extBytes / 8) * 8, namesStart = recStart + count * SLICE_RECORD;
  const nodes: SliceNode[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const r = recStart + i * SLICE_RECORD, p = dv.getInt32(r + 4, true), flags = dv.getUint16(r + 50, true);
    const extI = dv.getUint16(r + 48, true), nOff = dv.getUint32(r + 52, true), nLen = dv.getUint16(r + 56, true);
    const n: SliceNode = {
      id: dv.getUint32(r, true), parent: p >= 0 ? nodes[p] : null,
      name: dec.decode(u8.subarray(namesStart + nOff, namesStart + nOff + nLen)),
      isDir: (flags & 1) !== 0, size: dv.getFloat64(r + 8, true), alloc: dv.getFloat64(r + 16, true),
      restSize: dv.getFloat64(r + 24, true), restCount: dv.getUint32(r + 32, true),
      files: dv.getUint32(r + 36, true), dirs: dv.getUint32(r + 40, true), mtime: dv.getUint32(r + 44, true),
      ext: extI === NO_EXT ? '' : exts[extI], flags, depth: dv.getUint16(r + 58, true),
      childCount: dv.getUint32(r + 60, true), kids: [],
    };
    nodes[i] = n;
    if (n.parent) n.parent.kids.push(n);
  }
  return { nodes, minBytes };
}
