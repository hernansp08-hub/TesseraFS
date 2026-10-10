// Motor NTFS para sesiones con administrador: lee la MFT del volumen en bloques grandes y alineados,
// aplica los fixups, toma $STANDARD_INFORMATION, $FILE_NAME (sin el espacio DOS), $DATA sin nombre
// (y la asignación de los flujos con nombre) y $REPARSE_POINT; fusiona los registros de extensión con
// su registro base y cuenta una sola vez los enlaces duros. Implementado a partir de la documentación
// pública del formato (MS-FSCC, NTFS_VOLUME_DATA_BUFFER y la descripción de libyal/Linux-NTFS).
import { FLAG, type EngineMessage } from '../../protocol/src/index.ts';
import { engineError, msg } from './messages.ts';
import { Store, flagsFromAttrs } from './store.ts';
import {
  FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_NO_BUFFERING, FILE_SHARE_ALL, GENERIC_READ, INVALID_HANDLE, OPEN_EXISTING,
  alignedAlloc, filetimeToUnix, kernel32, lastError, winErrorText, wstr,
} from './win32.ts';

const FILE_MAGIC = 0x454C4946; // "FILE"
const AT_STANDARD_INFORMATION = 0x10, AT_FILE_NAME = 0x30, AT_DATA = 0x80, AT_REPARSE_POINT = 0xC0, AT_END = 0xFFFFFFFF;
const ATTR_FLAG_COMPRESSED = 0x0001, ATTR_FLAG_SPARSE = 0x8000;
export const MFT_ROOT = 5;
const FIRST_USER_RECORD = 16;

// banderas internas por registro
const R_INUSE = 1, R_DIR = 2;

const u64 = (dv: DataView, o: number) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
const ref48 = (dv: DataView, o: number) => dv.getUint32(o, true) + dv.getUint16(o + 4, true) * 4294967296;

/** Resultado del parseo, indexado por número de registro. */
export class MftState {
  readonly n: number;
  rf: Uint8Array; attrs: Uint32Array; mtime: Uint32Array; tag: Uint32Array;
  size: Float64Array; alloc: Float64Array; extra: Float64Array;
  // enlaces (cada $FILE_NAME no DOS): registro, padre, nombre
  lRec: Uint32Array; lPar: Uint32Array; lOff: Uint32Array; lLen: Uint8Array; nl = 0;
  names: Uint16Array; namesLen = 0;
  bad = 0; parsed = 0;

  constructor(records: number) {
    const n = this.n = records;
    this.rf = new Uint8Array(n); this.attrs = new Uint32Array(n); this.mtime = new Uint32Array(n); this.tag = new Uint32Array(n);
    this.size = new Float64Array(n); this.alloc = new Float64Array(n); this.extra = new Float64Array(n);
    const lc = Math.max(1024, Math.ceil(n * 1.1));
    this.lRec = new Uint32Array(lc); this.lPar = new Uint32Array(lc); this.lOff = new Uint32Array(lc); this.lLen = new Uint8Array(lc);
    this.names = new Uint16Array(Math.max(4096, n * 16));
  }

  addLink(rec: number, parent: number, src: Uint16Array, off: number, len: number) {
    if (this.nl >= this.lRec.length) {
      const c = this.lRec.length * 2;
      const g = <A extends Uint32Array | Uint8Array>(a: A) => { const b = new (a.constructor as new (n: number) => A)(c); b.set(a as never); return b; };
      this.lRec = g(this.lRec); this.lPar = g(this.lPar); this.lOff = g(this.lOff); this.lLen = g(this.lLen);
    }
    if (this.namesLen + len > this.names.length) {
      const b = new Uint16Array(Math.max(this.names.length * 2, this.namesLen + len)); b.set(this.names); this.names = b;
    }
    const i = this.nl++;
    this.lRec[i] = rec; this.lPar[i] = parent; this.lOff[i] = this.namesLen; this.lLen[i] = len;
    this.names.set(src.subarray(off, off + len), this.namesLen); this.namesLen += len;
  }
}

/** Aplica los fixups (update sequence array) in situ. false si el registro está roto. */
export function applyFixups(u8: Uint8Array, dv: DataView, off: number, recSize: number): boolean {
  const usaOff = dv.getUint16(off + 4, true), usaCnt = dv.getUint16(off + 6, true);
  if (usaCnt < 2 || usaOff + usaCnt * 2 > recSize) return false;
  const stride = recSize / (usaCnt - 1);
  if (stride < 256 || stride !== Math.floor(stride)) return false;
  const usn = dv.getUint16(off + usaOff, true);
  for (let s = 1; s < usaCnt; s++) {
    const end = off + s * stride - 2;
    if (dv.getUint16(end, true) !== usn) return false;
    dv.setUint16(end, dv.getUint16(off + usaOff + s * 2, true), true);
  }
  return true;
}

/** Parsea un registro FILE en `off`. `recNo` es su número (posición en la MFT). */
export function parseRecord(u8: Uint8Array, dv: DataView, u16: Uint16Array, off: number, recSize: number, recNo: number, st: MftState): void {
  if (dv.getUint32(off, true) !== FILE_MAGIC) return; // vacío o nunca usado
  if (!applyFixups(u8, dv, off, recSize)) { st.bad++; return; }
  const flags = dv.getUint16(off + 0x16, true);
  if (!(flags & 1)) return; // libre (borrado)
  st.parsed++;
  const base = ref48(dv, off + 0x20);
  const target = base !== 0 ? base : recNo;
  if (target >= st.n) return;
  if (base === 0) st.rf[target] |= R_INUSE | ((flags & 2) ? R_DIR : 0);
  const used = Math.min(dv.getUint32(off + 0x18, true), recSize);
  let a = off + dv.getUint16(off + 0x14, true);
  const end = off + used;
  while (a + 16 <= end) {
    const type = dv.getUint32(a, true);
    if (type === AT_END) break;
    const len = dv.getUint32(a + 4, true);
    if (len < 16 || a + len > end) break;
    const nonRes = u8[a + 8], nameLen = u8[a + 9];
    if (type === AT_STANDARD_INFORMATION && !nonRes) {
      const v = a + dv.getUint16(a + 20, true);
      st.mtime[target] = filetimeToUnix(dv.getUint32(v + 8, true), dv.getUint32(v + 12, true));
      st.attrs[target] = dv.getUint32(v + 32, true);
    } else if (type === AT_FILE_NAME && !nonRes) {
      const v = a + dv.getUint16(a + 20, true);
      const ns = u8[v + 65], nl = u8[v + 64];
      if (ns !== 2 && nl > 0 && ((v + 66) & 1) === 0) st.addLink(target, ref48(dv, v), u16, (v + 66) >> 1, nl);
      else if (ns !== 2 && nl > 0) { // nombre desalineado (no debería ocurrir): copia lenta
        const tmp = new Uint16Array(nl);
        for (let i = 0; i < nl; i++) tmp[i] = dv.getUint16(v + 66 + i * 2, true);
        st.addLink(target, ref48(dv, v), tmp, 0, nl);
      }
    } else if (type === AT_DATA) {
      const aflags = dv.getUint16(a + 12, true);
      if (!nonRes) {
        if (nameLen === 0) { st.size[target] = dv.getUint32(a + 16, true); st.alloc[target] = 0; }
      } else if (u64(dv, a + 16) === 0) { // sólo la instancia con LowestVCN = 0 trae tamaños válidos
        const runOff = dv.getUint16(a + 32, true);
        const packed = (aflags & (ATTR_FLAG_COMPRESSED | ATTR_FLAG_SPARSE)) !== 0 && runOff >= 0x48;
        const alloc = packed ? u64(dv, a + 64) : u64(dv, a + 40);
        if (nameLen === 0) { st.size[target] = u64(dv, a + 48); st.alloc[target] = alloc; }
        else if (target >= FIRST_USER_RECORD) st.extra[target] += alloc; // flujos con nombre (p. ej. WofCompressedData)
      }
    } else if (type === AT_REPARSE_POINT && !nonRes) {
      st.tag[target] = dv.getUint32(a + dv.getUint16(a + 20, true), true);
    }
    a += len;
  }
}

/** Parsea `count` registros contiguos desde `firstRec`. */
export function parseChunk(u8: Uint8Array, count: number, recSize: number, firstRec: number, st: MftState) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
  for (let k = 0; k < count; k++) {
    const rec = firstRec + k;
    if (rec >= st.n) break;
    parseRecord(u8, dv, u16, k * recSize, recSize, rec, st);
  }
}

export interface Run { vcn: number; lcn: number; clusters: number } // lcn -1 = disperso

/** Decodifica una lista de runs (mapping pairs) de un atributo no residente. */
export function decodeRunlist(u8: Uint8Array, off: number, end: number, startVcn = 0): Run[] {
  const runs: Run[] = [];
  let vcn = startVcn, lcn = 0n, o = off;
  while (o < end) {
    const h = u8[o++];
    if (h === 0) break;
    const ls = h & 0xF, os = h >> 4;
    if (!ls || o + ls + os > end) break;
    let len = 0n;
    for (let i = 0; i < ls; i++) len |= BigInt(u8[o + i]) << BigInt(8 * i);
    o += ls;
    if (os === 0) { runs.push({ vcn, lcn: -1, clusters: Number(len) }); vcn += Number(len); continue; }
    let d = 0n;
    for (let i = 0; i < os; i++) d |= BigInt(u8[o + i]) << BigInt(8 * i);
    if (u8[o + os - 1] & 0x80) d -= 1n << BigInt(8 * os);
    o += os;
    lcn += d;
    runs.push({ vcn, lcn: Number(lcn), clusters: Number(len) });
    vcn += Number(len);
  }
  return runs;
}

/** Runs del $DATA sin nombre de un registro ya corregido (registro 0 = la propia $MFT). */
export function dataRunsOfRecord(u8: Uint8Array, off: number, recSize: number): { runs: Run[]; lastVcn: number; allocated: number } | null {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let a = off + dv.getUint16(off + 0x14, true);
  const end = off + Math.min(dv.getUint32(off + 0x18, true), recSize);
  while (a + 16 <= end) {
    const type = dv.getUint32(a, true);
    if (type === AT_END) break;
    const len = dv.getUint32(a + 4, true);
    if (len < 16 || a + len > end) break;
    if (type === AT_DATA && u8[a + 8] === 1 && u8[a + 9] === 0) {
      const start = u64(dv, a + 16);
      return { runs: decodeRunlist(u8, a + dv.getUint16(a + 32, true), a + len, start), lastVcn: u64(dv, a + 24), allocated: u64(dv, a + 40) };
    }
    a += len;
  }
  return null;
}

/** Busca un camino (componentes) desde la raíz del volumen. -1 si no existe. */
export function resolveMftPath(st: MftState, parts: string[]): number {
  let cur = MFT_ROOT;
  for (const p of parts) {
    const want = p.toLowerCase();
    let found = -1;
    for (let i = 0; i < st.nl; i++) {
      if (st.lPar[i] !== cur || st.lRec[i] === cur || !(st.rf[st.lRec[i]] & R_INUSE)) continue;
      const nm = String.fromCharCode.apply(null, st.names.subarray(st.lOff[i], st.lOff[i] + st.lLen[i]) as unknown as number[]);
      if (nm.toLowerCase() === want) { found = st.lRec[i]; break; }
    }
    if (found < 0 || !(st.rf[found] & R_DIR)) return -1;
    cur = found;
  }
  return cur;
}

/**
 * Construye el almacén recorriendo por niveles desde `rootRec`: el padre siempre queda antes que
 * sus hijos. El primer nombre de un archivo con enlaces duros conserva el tamaño; el resto se marca
 * HARDLINK con tamaño 0. Devuelve también cuántos registros quedaron huérfanos.
 */
export function buildStore(st: MftState, rootRec: number, rootPath: string): { store: Store; orphans: number; hardlinks: number } {
  const n = st.n, nl = st.nl;
  const cnt = new Uint32Array(n + 1);
  for (let i = 0; i < nl; i++) { const p = st.lPar[i]; if (p < n) cnt[p]++; }
  const start = new Uint32Array(n + 1);
  for (let i = 0, s = 0; i < n; i++) { start[i] = s; s += cnt[i]; start[n] = s; }
  const kids = new Uint32Array(start[n]), fill = new Uint32Array(n);
  for (let i = 0; i < nl; i++) { const p = st.lPar[i]; if (p < n) kids[start[p] + fill[p]++] = i; }

  const store = new Store(Math.max(1024, nl + 1));
  const rootFlags = flagsFromAttrs(st.attrs[rootRec], st.tag[rootRec], true);
  store.addRoot(rootPath, st.mtime[rootRec], rootFlags);
  const visited = new Uint8Array(n), counted = new Uint8Array(n);
  visited[rootRec] = 1;
  let hardlinks = 0, placed = 0;
  let q = [rootRec, 0], next: number[] = [];
  while (q.length) {
    for (let qi = 0; qi < q.length; qi += 2) {
      const rec = q[qi], gid = q[qi + 1];
      for (let k = start[rec], e = start[rec] + cnt[rec]; k < e; k++) {
        const li = kids[k], c = st.lRec[li];
        if (c === rec || c >= n || !(st.rf[c] & R_INUSE)) continue;
        const dir = (st.rf[c] & R_DIR) !== 0;
        let flags = flagsFromAttrs(st.attrs[c], st.tag[c], dir);
        if (dir) {
          if (visited[c]) continue;
          visited[c] = 1;
          const id = store.add(gid, st.names, st.lOff[li], st.lLen[li], true, 0, 0, st.mtime[c], flags);
          next.push(c, id);
        } else {
          let size = st.size[c], alloc = st.alloc[c] + st.extra[c];
          if (counted[c]) { size = 0; alloc = 0; flags |= FLAG.HARDLINK; hardlinks++; } else counted[c] = 1;
          store.add(gid, st.names, st.lOff[li], st.lLen[li], false, size, alloc, st.mtime[c], flags);
        }
        placed++;
      }
    }
    q = next; next = [];
  }
  // huérfanos: registros en uso con nombre que no cuelgan de la raíz (sólo informativo)
  let orphans = 0;
  if (rootRec === MFT_ROOT) {
    for (let i = 0; i < nl; i++) {
      const r = st.lRec[i];
      if (r !== MFT_ROOT && (st.rf[r] & R_INUSE) && !(st.rf[r] & R_DIR ? visited[r] : counted[r])) { orphans++; if (st.rf[r] & R_DIR) visited[r] = 1; else counted[r] = 1; }
    }
  }
  void placed;
  return { store, orphans, hardlinks };
}

// ---------------------------------------------------------------------------------------------
// Lectura del volumen (necesita administrador). No se puede probar sin elevar.

const FSCTL_GET_NTFS_VOLUME_DATA = 0x00090064;
const FSCTL_GET_RETRIEVAL_POINTERS = 0x00090073;

export interface NtfsGeometry { bytesPerSector: number; bytesPerCluster: number; recordSize: number; mftValid: number; mftStartLcn: number }

export function parseVolumeData(u8: Uint8Array): NtfsGeometry {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    bytesPerSector: dv.getUint32(40, true), bytesPerCluster: dv.getUint32(44, true), recordSize: dv.getUint32(48, true),
    mftValid: u64(dv, 56), mftStartLcn: u64(dv, 64),
  };
}

/** Extents de $MFT con FSCTL_GET_RETRIEVAL_POINTERS (cubre una MFT muy fragmentada). */
function extentsViaFsctl(letter: string): Run[] | null {
  const k = kernel32();
  const h = k.CreateFileW(wstr(`\\\\.\\${letter}:\\$MFT`), 0x80 /* FILE_READ_ATTRIBUTES */, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, 0n);
  if (h === INVALID_HANDLE) return null;
  try {
    const runs: Run[] = [];
    const inb = new BigInt64Array(1), out = new Uint8Array(64 * 1024), ret = new Uint32Array(1);
    const dv = new DataView(out.buffer);
    for (let guard = 0; guard < 10000; guard++) {
      const ok = k.DeviceIoControl(h, FSCTL_GET_RETRIEVAL_POINTERS, inb, 8, out, out.length, ret, null);
      const err = ok ? 0 : lastError();
      if (!ok && err !== 234 /* ERROR_MORE_DATA */) return runs.length ? runs : null;
      const count = dv.getUint32(0, true);
      let vcn = u64(dv, 8);
      for (let i = 0; i < count; i++) {
        const nextVcn = u64(dv, 16 + i * 16), lcnLo = dv.getUint32(24 + i * 16, true), lcnHi = dv.getInt32(28 + i * 16, true);
        const lcn = lcnHi === -1 && lcnLo === 0xFFFFFFFF ? -1 : lcnHi * 4294967296 + lcnLo;
        runs.push({ vcn, lcn, clusters: nextVcn - vcn });
        vcn = nextVcn;
      }
      if (ok) return runs;
      inb[0] = BigInt(vcn);
    }
    return runs;
  } finally {
    k.CloseHandle(h);
  }
}

/** `detail` sólo lleva rutas (p. ej. `C:\$MFT`); el texto de cada fase lo pone la interfaz. */
export interface MftProgress { phase: 'mft-read' | 'link'; entries: number; bytes: number; detail?: string; fraction?: number }

/**
 * Lee y parsea la MFT del volumen de `rootPath`. Si falla (p. ej. sin administrador) lanza un Error
 * con texto técnico en inglés, que el motor convierte en el aviso `scan.mftFailed`.
 */
export async function mftScan(rootPath: string, onProgress?: (p: MftProgress) => void, isCancelled?: () => boolean):
  Promise<{ store: Store; warnings: EngineMessage[]; records: number }> {
  const letter = rootPath[0].toUpperCase();
  const k = kernel32();
  const warnings: EngineMessage[] = [];
  const h = k.CreateFileW(wstr(`\\\\.\\${letter}:`), GENERIC_READ, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_NO_BUFFERING, 0n);
  if (h === INVALID_HANDLE) throw new Error(`cannot open volume ${letter}: (${winErrorText(lastError())})`);
  let st: MftState;
  let geo: NtfsGeometry;
  try {
    const vd = new Uint8Array(512), ret = new Uint32Array(1);
    if (!k.DeviceIoControl(h, FSCTL_GET_NTFS_VOLUME_DATA, null, 0, vd, vd.length, ret, null)) {
      throw new Error(`volume ${letter}: is not NTFS (${winErrorText(lastError())})`);
    }
    geo = parseVolumeData(vd);
    const { bytesPerCluster: cl, recordSize: rs, bytesPerSector: sec } = geo;
    if (!rs || !cl || rs % 256) throw new Error('invalid NTFS geometry');
    const CH = Math.max(4 << 20, cl, rs) - (Math.max(4 << 20, cl, rs) % Math.max(cl, rs));
    const buf = alignedAlloc(CH);
    try {
      const read = (diskOff: number, bytes: number): number => {
        const n = Math.ceil(bytes / sec) * sec;
        if (!k.SetFilePointerEx(h, BigInt(diskOff), null, 0)) throw new Error(`SetFilePointerEx: ${winErrorText(lastError())}`);
        const got = new Uint32Array(1);
        if (!k.ReadFile(h, buf.p, n, got, null)) throw new Error(`ReadFile: ${winErrorText(lastError())}`);
        return got[0];
      };
      // extents de la MFT: FSCTL o, si falla, la lista de runs del registro 0
      let runs = extentsViaFsctl(letter);
      if (!runs || !runs.length) {
        read(geo.mftStartLcn * cl, Math.max(rs, cl));
        const r0 = new Uint8Array(buf.u8.subarray(0, rs));
        if (!applyFixups(r0, new DataView(r0.buffer), 0, rs)) throw new Error('MFT record 0 is damaged');
        const d = dataRunsOfRecord(r0, 0, rs);
        if (!d) throw new Error('no $DATA attribute in MFT record 0');
        runs = d.runs;
        if ((d.lastVcn + 1) * cl < d.allocated) warnings.push(msg('scan.mftFragmented'));
      }
      const total = Math.floor(geo.mftValid / rs);
      st = new MftState(total);
      let done = 0, lastYield = performance.now(), lastTick = 0;
      for (const run of runs) {
        if (run.lcn < 0) continue;
        let fileOff = run.vcn * cl, diskOff = run.lcn * cl;
        let remaining = Math.min(run.clusters * cl, geo.mftValid - fileOff);
        while (remaining > 0) {
          if (isCancelled?.()) throw engineError('error.cancelled');
          const n = Math.min(CH, remaining);
          const got = read(diskOff, n);
          const recs = Math.floor(Math.min(got, n) / rs);
          parseChunk(buf.u8, recs, rs, Math.floor(fileOff / rs), st);
          done += n; fileOff += n; diskOff += n; remaining -= n;
          const now = performance.now();
          if (onProgress && now - lastTick > 100) { lastTick = now; onProgress({ phase: 'mft-read', entries: st.parsed, bytes: done, detail: `${letter}:\\$MFT`, fraction: done / geo.mftValid }); }
          if (now - lastYield > 30) { await new Promise(r => setImmediate(r)); lastYield = performance.now(); }
        }
      }
    } finally {
      buf.free();
    }
  } finally {
    k.CloseHandle(h);
  }
  if (st.bad) warnings.push(msg('scan.mftBadRecords', { count: st.bad }));
  onProgress?.({ phase: 'link', entries: st.parsed, bytes: geo.mftValid, fraction: 1 });
  await new Promise(r => setImmediate(r));
  const parts = rootPath.replace(/^[A-Za-z]:\\?/, '').split('\\').filter(Boolean);
  const rootRec = parts.length ? resolveMftPath(st, parts) : MFT_ROOT;
  if (rootRec < 0) throw new Error(`${rootPath} not found in the MFT`);
  const { store, orphans, hardlinks } = buildStore(st, rootRec, rootPath);
  if (orphans) warnings.push(msg('scan.mftOrphans', { count: orphans }));
  void hardlinks;
  return { store, warnings, records: st.parsed };
}
