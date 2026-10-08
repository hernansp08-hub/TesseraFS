// Parser MFT sobre registros FILE sintéticos (no hace falta administrador ni leer el disco).
import { expect, test } from 'bun:test';
import { FLAG, decodeSlice, encodeSlice } from '../../protocol/src/index.ts';
import { MFT_ROOT, MftState, applyFixups, buildStore, dataRunsOfRecord, decodeRunlist, parseChunk, parseVolumeData, resolveMftPath } from '../src/mft.ts';

const RS = 1024;
const FT = (unix: number) => BigInt(Math.round((unix + 11644473600) * 1e7));

interface Name { parent: number; name: string; ns?: number }
interface Spec {
  rec: number; dir?: boolean; inUse?: boolean; base?: number;
  names?: Name[]; mtime?: number; attrs?: number;
  resident?: number;                       // $DATA residente de N bytes
  data?: { size: number; alloc: number; total?: number; flags?: number; startVcn?: number; runs?: number[] };
  named?: { name: string; alloc: number; total?: number; flags?: number }[];
  tag?: number; noSI?: boolean; badFixup?: boolean;
}

function record(s: Spec): Uint8Array {
  const b = new Uint8Array(RS), dv = new DataView(b.buffer);
  b.set([0x46, 0x49, 0x4C, 0x45]);
  dv.setUint16(4, 0x30, true); dv.setUint16(6, 3, true);
  dv.setUint16(0x10, 1, true);
  dv.setUint16(0x14, 0x38, true);
  dv.setUint16(0x16, (s.inUse === false ? 0 : 1) | (s.dir ? 2 : 0), true);
  dv.setUint32(0x1C, RS, true);
  dv.setBigUint64(0x20, BigInt(s.base ?? 0), true);
  dv.setUint32(0x2C, s.rec, true);
  let a = 0x38;
  const resident = (type: number, value: Uint8Array) => {
    const len = (0x18 + value.length + 7) & ~7;
    dv.setUint32(a, type, true); dv.setUint32(a + 4, len, true); b[a + 8] = 0;
    dv.setUint32(a + 16, value.length, true); dv.setUint16(a + 20, 0x18, true);
    b.set(value, a + 0x18); a += len;
  };
  const nonResident = (name: string, size: number, alloc: number, total: number | undefined, flags: number, startVcn: number, runs: number[]) => {
    const hdr = total !== undefined ? 0x48 : 0x40;
    const nameBytes = name.length * 2, runOff = (hdr + nameBytes + 7) & ~7;
    const len = (runOff + runs.length + 1 + 7) & ~7;
    dv.setUint32(a, 0x80, true); dv.setUint32(a + 4, len, true); b[a + 8] = 1; b[a + 9] = name.length;
    dv.setUint16(a + 10, hdr, true); dv.setUint16(a + 12, flags, true);
    dv.setBigUint64(a + 16, BigInt(startVcn), true); dv.setBigUint64(a + 24, BigInt(startVcn + 10), true);
    dv.setUint16(a + 32, runOff, true);
    dv.setBigUint64(a + 40, BigInt(alloc), true); dv.setBigUint64(a + 48, BigInt(size), true); dv.setBigUint64(a + 56, BigInt(size), true);
    if (total !== undefined) dv.setBigUint64(a + 64, BigInt(total), true);
    for (let i = 0; i < name.length; i++) dv.setUint16(a + hdr + i * 2, name.charCodeAt(i), true);
    b.set(runs, a + runOff);
    a += len;
  };
  if (!s.noSI) {
    const si = new Uint8Array(0x48), sv = new DataView(si.buffer);
    sv.setBigUint64(8, FT(s.mtime ?? 1_700_000_000), true);
    sv.setUint32(32, s.attrs ?? 0x20, true);
    resident(0x10, si);
  }
  for (const n of s.names ?? []) {
    const v = new Uint8Array(66 + n.name.length * 2), fv = new DataView(v.buffer);
    fv.setUint32(0, n.parent, true); fv.setUint16(6, 1, true);
    fv.setBigUint64(40, 999n, true); fv.setBigUint64(48, 999n, true); // tamaños obsoletos: no deben usarse
    v[64] = n.name.length; v[65] = n.ns ?? 1;
    for (let i = 0; i < n.name.length; i++) fv.setUint16(66 + i * 2, n.name.charCodeAt(i), true);
    resident(0x30, v);
  }
  if (s.resident !== undefined) {
    resident(0x80, new Uint8Array(s.resident));
  }
  if (s.data) nonResident('', s.data.size, s.data.alloc, s.data.total, s.data.flags ?? 0, s.data.startVcn ?? 0, s.data.runs ?? [0x11, 0x0A, 0x20]);
  for (const n of s.named ?? []) nonResident(n.name, 0, n.alloc, n.total, n.flags ?? 0, 0, [0x11, 0x01, 0x30]);
  if (s.tag !== undefined) {
    const v = new Uint8Array(8); new DataView(v.buffer).setUint32(0, s.tag, true);
    resident(0xC0, v);
  }
  dv.setUint32(a, 0xFFFFFFFF, true);
  dv.setUint32(0x18, a + 8, true);
  // fixups: el USN sustituye los dos últimos bytes de cada sector de 512 B
  const usn = 0x1234 + (s.rec & 0xFF);
  dv.setUint16(0x30, usn, true);
  for (let k = 1; k <= 2; k++) {
    const end = k * 512 - 2;
    dv.setUint16(0x30 + k * 2, dv.getUint16(end, true), true);
    dv.setUint16(end, s.badFixup && k === 2 ? usn ^ 0xFFFF : usn, true);
  }
  return b;
}

function volume(specs: Spec[], count = 64) {
  const buf = new Uint8Array(count * RS);
  for (const s of specs) buf.set(record(s), s.rec * RS);
  return buf;
}

const HIDDEN = 0x2, SYSTEM = 0x4, COMPRESSED = 0x800, SPARSE = 0x200, REPARSE = 0x400;

const SPECS: Spec[] = [
  { rec: 0, names: [{ parent: 5, name: '$MFT' }], attrs: HIDDEN | SYSTEM, data: { size: 64 * 1024, alloc: 64 * 1024 } },
  { rec: 5, dir: true, names: [{ parent: 5, name: '.' }], attrs: HIDDEN | SYSTEM },
  { rec: 8, names: [{ parent: 5, name: '$BadClus' }], resident: 0, named: [{ name: '$Bad', alloc: 1e12 }] }, // no debe sumar
  { rec: 30, dir: true, names: [{ parent: 5, name: 'Users' }] },
  { rec: 31, names: [{ parent: 30, name: 'a.txt' }, { parent: 30, name: 'A~1.TXT', ns: 2 }], resident: 100 },
  // big.bin: sus tamaños están en un registro de extensión que aparece ANTES que el base
  { rec: 25, base: 32, noSI: true, data: { size: 10 * 1048576, alloc: 10 * 1048576 } },
  { rec: 32, names: [{ parent: 30, name: 'big.bin', ns: 3 }] },
  // enlace duro: dos nombres en carpetas distintas (uno POSIX)
  { rec: 33, names: [{ parent: 30, name: 'h1.dll' }, { parent: 34, name: 'h1copy.dll', ns: 0 }], data: { size: 5000, alloc: 8192 } },
  { rec: 34, dir: true, names: [{ parent: 30, name: 'Sub' }], attrs: HIDDEN },
  { rec: 35, names: [{ parent: 30, name: 'c.log' }], attrs: COMPRESSED, data: { size: 100000, alloc: 131072, total: 32768, flags: 0x0001 } },
  { rec: 36, inUse: false, names: [{ parent: 30, name: 'deleted.tmp' }], resident: 10 },
  { rec: 37, badFixup: true, names: [{ parent: 30, name: 'broken.bin' }], resident: 10 },
  { rec: 38, dir: true, names: [{ parent: 5, name: 'Link' }], attrs: REPARSE, tag: 0xA0000003 },
  // WOF: $DATA sin nombre disperso; los datos reales en WofCompressedData
  { rec: 39, names: [{ parent: 34, name: 'wof.exe' }], attrs: SPARSE | REPARSE, tag: 0x80000017,
    data: { size: 4096, alloc: 4096, total: 0, flags: 0x8000 }, named: [{ name: 'WofCompressedData', alloc: 2048 }] },
  { rec: 40, names: [{ parent: 36, name: 'orphan.txt' }], resident: 1 }, // su padre está borrado
  // segunda instancia de $DATA (LowestVCN != 0): sus tamaños no deben pisar los buenos
  { rec: 41, names: [{ parent: 34, name: 'frag.vhd' }], data: { size: 777, alloc: 4096 } },
  { rec: 42, base: 41, noSI: true, data: { size: 1, alloc: 1, startVcn: 10 } },
  { rec: 43, names: [{ parent: 38, name: 'inside-link.txt' }], resident: 3 },
];

function parsed() {
  const buf = volume(SPECS);
  const st = new MftState(64);
  parseChunk(buf, 64, RS, 0, st);
  return st;
}

test('mft: fixups y registros rotos', () => {
  const r = record({ rec: 1, names: [{ parent: 5, name: 'x' }], resident: 1 });
  const dv = new DataView(r.buffer);
  expect(dv.getUint16(510, true)).toBe(0x1234 + 1);
  expect(applyFixups(r, dv, 0, RS)).toBe(true);
  expect(dv.getUint16(510, true)).not.toBe(0x1234 + 1);
  const bad = record({ rec: 2, badFixup: true });
  expect(applyFixups(bad, new DataView(bad.buffer), 0, RS)).toBe(false);
  const st = parsed();
  expect(st.bad).toBe(1);
});

test('mft: árbol, tamaños, enlaces duros, extensión, comprimidos y WOF', () => {
  const st = parsed();
  const { store, orphans, hardlinks } = buildStore(st, MFT_ROOT, 'C:\\');
  store.finalize();
  const byPath = new Map<string, number>();
  for (let i = 0; i < store.n; i++) byPath.set(store.path(i), i);
  const id = (p: string) => { const v = byPath.get(p); if (v === undefined) throw new Error('falta ' + p); return v; };

  expect([...byPath.keys()].sort()).toEqual([
    'C:\\', 'C:\\$BadClus', 'C:\\$MFT', 'C:\\Link', 'C:\\Link\\inside-link.txt', 'C:\\Users', 'C:\\Users\\Sub', 'C:\\Users\\Sub\\frag.vhd',
    'C:\\Users\\Sub\\h1copy.dll', 'C:\\Users\\Sub\\wof.exe', 'C:\\Users\\a.txt', 'C:\\Users\\big.bin', 'C:\\Users\\c.log', 'C:\\Users\\h1.dll',
  ].sort());
  expect(orphans).toBe(1);   // orphan.txt
  expect(hardlinks).toBe(1); // h1copy.dll

  expect(store.size(id('C:\\Users\\a.txt'))).toBe(100);
  expect(store.alloc(id('C:\\Users\\a.txt'))).toBe(0); // residente
  expect(store.size(id('C:\\Users\\big.bin'))).toBe(10 * 1048576);
  expect(store.size(id('C:\\Users\\h1.dll'))).toBe(5000);
  expect(store.flags(id('C:\\Users\\h1.dll')) & FLAG.HARDLINK).toBe(0);
  expect(store.size(id('C:\\Users\\Sub\\h1copy.dll'))).toBe(0);
  expect(store.flags(id('C:\\Users\\Sub\\h1copy.dll')) & FLAG.HARDLINK).toBe(FLAG.HARDLINK);
  expect(store.alloc(id('C:\\Users\\c.log'))).toBe(32768);
  expect(store.flags(id('C:\\Users\\c.log')) & FLAG.COMPRESSED).toBe(FLAG.COMPRESSED);
  const wof = id('C:\\Users\\Sub\\wof.exe');
  expect(store.size(wof)).toBe(4096);
  expect(store.alloc(wof)).toBe(2048);
  expect(store.flags(wof) & (FLAG.COMPRESSED | FLAG.SPARSE)).toBe(FLAG.COMPRESSED | FLAG.SPARSE);
  expect(store.flags(wof) & FLAG.REPARSE).toBe(0); // WOF no es un enlace
  expect(store.size(id('C:\\Users\\Sub\\frag.vhd'))).toBe(777);
  expect(store.flags(id('C:\\Link')) & FLAG.REPARSE).toBe(FLAG.REPARSE);
  expect(store.flags(id('C:\\Users\\Sub')) & FLAG.HIDDEN).toBe(FLAG.HIDDEN);
  expect(store.alloc(id('C:\\$BadClus'))).toBe(0);
  expect(store.ext(id('C:\\Users\\big.bin'))).toBe('bin');
  expect(store.mtime(id('C:\\Users\\a.txt'))).toBe(1_700_000_000);

  const files = 10 * 1048576 + 100 + 5000 + 100000 + 4096 + 777 + 3 + 65536;
  expect(store.size(store.rootId)).toBe(files);
  expect(store.files(store.rootId)).toBe(10);
  expect(store.dirs(store.rootId)).toBe(3);
  expect(store.size(id('C:\\Users'))).toBe(10 * 1048576 + 100 + 5000 + 100000 + 4096 + 777);

  // el padre siempre antes que el hijo (requisito de finalize)
  for (let i = 1; i < store.n; i++) expect(store.par[i]).toBeLessThan(i);
  const { nodes } = decodeSlice(encodeSlice(store, store.rootId, 0, 1000));
  expect(nodes.length).toBe(store.n);
  expect(nodes[1].name).toBe('Users');
});

test('mft: subcarpeta como raíz', () => {
  const st = parsed();
  const rec = resolveMftPath(st, ['users', 'SUB']);
  expect(rec).toBe(34);
  expect(resolveMftPath(st, ['Users', 'nope'])).toBe(-1);
  expect(resolveMftPath(st, ['Users', 'a.txt'])).toBe(-1); // no es carpeta
  const { store } = buildStore(st, rec, 'C:\\Users\\Sub');
  store.finalize();
  expect(store.path(store.rootId)).toBe('C:\\Users\\Sub');
  expect(store.n).toBe(4);
  // dentro de la subcarpeta, h1copy.dll es el primer nombre visto del enlace duro: conserva el tamaño
  expect(store.size(store.rootId)).toBe(5000 + 4096 + 777);
});

test('mft: lista de runs y geometría', () => {
  // 16 clústeres en LCN 256; 32 en LCN 224 (desplazamiento -32); 5 dispersos
  const runs = decodeRunlist(new Uint8Array([0x21, 0x10, 0x00, 0x01, 0x11, 0x20, 0xE0, 0x01, 0x05, 0x00]), 0, 10);
  expect(runs).toEqual([{ vcn: 0, lcn: 256, clusters: 16 }, { vcn: 16, lcn: 224, clusters: 32 }, { vcn: 48, lcn: -1, clusters: 5 }]);
  const r0 = record({ rec: 0, names: [{ parent: 5, name: '$MFT' }], data: { size: 48 * 4096, alloc: 48 * 4096, runs: [0x21, 0x10, 0x00, 0x01, 0x11, 0x20, 0xE0] } });
  expect(applyFixups(r0, new DataView(r0.buffer), 0, RS)).toBe(true);
  const d = dataRunsOfRecord(r0, 0, RS)!;
  expect(d.runs.map(r => r.lcn)).toEqual([256, 224]);
  expect(d.allocated).toBe(48 * 4096);
  const vd = new Uint8Array(96), v = new DataView(vd.buffer);
  v.setUint32(40, 512, true); v.setUint32(44, 4096, true); v.setUint32(48, 1024, true);
  v.setBigUint64(56, 1536n * 1048576n, true); v.setBigUint64(64, 786432n, true);
  expect(parseVolumeData(vd)).toEqual({ bytesPerSector: 512, bytesPerCluster: 4096, recordSize: 1024, mftValid: 1536 * 1048576, mftStartLcn: 786432 });
});

test('mft: rendimiento del parser (registros sintéticos)', () => {
  const N = 300_000;
  const tmpl = [0, 1, 2, 3].map(i => record({ rec: 100 + i, names: [{ parent: 5, name: `document_${i}_IMG_20240101.dat` }, { parent: 5, name: 'DOCUME~1.DAT', ns: 2 }], data: { size: 12345 + i, alloc: 16384 } }));
  const buf = new Uint8Array(N * RS);
  for (let r = 0; r < N; r++) {
    buf.set(tmpl[r & 3], r * RS);
    const dv = new DataView(buf.buffer, r * RS);
    // padre = carpeta raíz; los registros son archivos
    dv.setUint32(0x2C, r, true);
  }
  const st = new MftState(N + 16);
  const t = performance.now();
  parseChunk(buf, N, RS, 16, st);
  const parseMs = performance.now() - t;
  const t2 = performance.now();
  st.rf[5] = 3;
  const { store } = buildStore(st, MFT_ROOT, 'C:\\');
  store.finalize();
  const buildMs = performance.now() - t2;
  console.log(`MFT sintética: ${N} registros parseados en ${parseMs.toFixed(0)} ms (${(N / parseMs / 1000).toFixed(2)} M rec/s); árbol+agregado ${buildMs.toFixed(0)} ms`);
  expect(st.parsed).toBe(N);
  expect(store.n).toBe(N + 1);
  expect(store.size(store.rootId)).toBe(N * 12345 + (N / 4) * (0 + 1 + 2 + 3));
});
