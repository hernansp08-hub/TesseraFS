// Motor sin administrador: recorre carpetas con NtQueryDirectoryFile (tamaño, asignado, atributos,
// etiqueta de reparse e id de archivo en una sola llamada). No abre el contenido de ningún archivo,
// no sigue enlaces (junctions/symlinks) y no aborta por accesos denegados.
import { ptr } from 'bun:ffi';
import { Store, flagsFromAttrs } from './store.ts';
import { ATTR, Mem, STATUS, filetimeToUnix, isNameSurrogate, kernel32, ntStatusText, ntdll, wstr } from './win32.ts';

/** Lote de entradas producido por un recorrido parcial (en un worker o en el hilo principal). */
export interface WalkBatch {
  count: number;
  /** >= 0: índice local del padre en este lote; < 0: id global = -p - 1 */
  parent: Int32Array;
  size: Float64Array; alloc: Float64Array;
  attrs: Uint32Array; tag: Uint32Array; mtime: Uint32Array;
  fileKey: Float64Array;
  nameOff: Uint32Array; nameLen: Uint16Array;
  names: Uint16Array; namesLen: number;
  /** Carpetas pendientes (no listadas): referencia (como `parent`) y ruta */
  pendRefs: number[]; pendPaths: string[];
  errors: string[];
  denied: number;
  dirsListed: number;
  bytes: number;
}

export interface WalkTask { refs: number[]; paths: string[] }

// Clases de información de NtQueryDirectoryFile, de la más completa a la más básica
const FileIdExtdDirectoryInformation = 60; // + etiqueta de reparse + id de 128 bits
const FileIdFullDirectoryInformation = 38; // + id de 64 bits (EaSize = etiqueta si es reparse)
const FileFullDirectoryInformation = 2;
const NAME_AT: Record<number, number> = { 60: 88, 38: 80, 2: 68 };

/** Ruta Win32 → ruta NT para NtOpenFile. */
export function ntPath(p: string): string {
  if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\')) return '\\??\\' + p.slice(4);
  if (p.startsWith('\\\\')) return '\\??\\UNC\\' + p.slice(2);
  return '\\??\\' + p;
}
export const joinPath = (dir: string, name: string) => dir.endsWith('\\') ? dir + name : dir + '\\' + name;

function newBatch(cap: number, namesCap: number): WalkBatch {
  return {
    count: 0, parent: new Int32Array(cap), size: new Float64Array(cap), alloc: new Float64Array(cap),
    attrs: new Uint32Array(cap), tag: new Uint32Array(cap), mtime: new Uint32Array(cap), fileKey: new Float64Array(cap),
    nameOff: new Uint32Array(cap), nameLen: new Uint16Array(cap), names: new Uint16Array(namesCap), namesLen: 0,
    pendRefs: [], pendPaths: [], errors: [], denied: 0, dirsListed: 0, bytes: 0,
  };
}
function growBatch(b: WalkBatch, cap: number) {
  const g = <A extends Int32Array | Float64Array | Uint32Array | Uint16Array>(a: A): A => {
    const n = new (a.constructor as new (n: number) => A)(cap); n.set(a as never); return n;
  };
  b.parent = g(b.parent); b.size = g(b.size); b.alloc = g(b.alloc); b.attrs = g(b.attrs); b.tag = g(b.tag);
  b.mtime = g(b.mtime); b.fileKey = g(b.fileKey); b.nameOff = g(b.nameOff); b.nameLen = g(b.nameLen);
}

/** Buffers transferibles de un lote (para postMessage). */
export function batchTransfer(b: WalkBatch): ArrayBuffer[] {
  return [b.parent, b.size, b.alloc, b.attrs, b.tag, b.mtime, b.fileKey, b.nameOff, b.nameLen, b.names].map(a => a.buffer as ArrayBuffer);
}

export class DirReader {
  private buf: Mem;
  private u16: Uint16Array;
  private pathBuf = new Uint16Array(32800);
  private pathPtr = ptr(this.pathBuf);
  private us = new Mem(16);       // UNICODE_STRING
  private oa = new Mem(48);       // OBJECT_ATTRIBUTES
  private iosb = new Mem(16);     // IO_STATUS_BLOCK
  private h = new BigUint64Array(1);
  private hPtr = ptr(this.h);
  infoClass = FileIdExtdDirectoryInformation;

  constructor(bufBytes = 256 * 1024) {
    this.buf = new Mem(bufBytes);
    this.u16 = new Uint16Array(this.buf.u8.buffer);
    this.oa.dv.setUint32(0, 48, true);
    this.oa.setPtr(16, this.us.p);
    this.oa.dv.setUint32(24, 0x40, true); // OBJ_CASE_INSENSITIVE
    this.us.setPtr(8, this.pathPtr);
  }

  private open(path: string): number {
    const nt = ntPath(path), n = Math.min(nt.length, 32760);
    for (let i = 0; i < n; i++) this.pathBuf[i] = nt.charCodeAt(i);
    this.us.dv.setUint16(0, n * 2, true); this.us.dv.setUint16(2, n * 2, true);
    // FILE_LIST_DIRECTORY | SYNCHRONIZE ; FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT
    return ntdll().NtOpenFile(this.hPtr, 0x1 | 0x100000, this.oa.p, this.iosb.p, 0x7, 0x1 | 0x20 | 0x4000) >>> 0;
  }

  /**
   * Lista `path` y añade sus entradas al lote con padre `ref`.
   * Devuelve las subcarpetas a recorrer como pares [índice local, ruta] en `outDirs`.
   */
  list(path: string, ref: number, b: WalkBatch, outDirs: (number | string)[]): void {
    const st = this.open(path);
    if (st !== 0) {
      if (st === STATUS.ACCESS_DENIED) { b.denied++; b.errors.push(`Acceso denegado: ${path}`); }
      else b.errors.push(`${path}: ${ntStatusText(st)}`);
      return;
    }
    const nt = ntdll(), h = this.h[0];
    try {
      b.dirsListed++;
      let restart = 1;
      for (; ;) {
        const cls = this.infoClass;
        const s = nt.NtQueryDirectoryFile(h, 0n, null, null, this.iosb.p, this.buf.p, this.buf.u8.length, cls, 0, null, restart) >>> 0;
        if (s === STATUS.NO_MORE_FILES) break;
        if (s !== 0) {
          if (restart && (s === STATUS.INVALID_INFO_CLASS || s === STATUS.NOT_SUPPORTED || s === STATUS.INVALID_PARAMETER) && cls !== FileFullDirectoryInformation) {
            this.infoClass = cls === FileIdExtdDirectoryInformation ? FileIdFullDirectoryInformation : FileFullDirectoryInformation;
            continue; // reintenta con una clase más básica
          }
          if (s === STATUS.ACCESS_DENIED) { b.denied++; b.errors.push(`Acceso denegado: ${path}`); }
          else b.errors.push(`${path}: ${ntStatusText(s)}`);
          break;
        }
        restart = 0;
        this.parse(cls, path, ref, b, outDirs);
      }
    } finally {
      nt.NtClose(h);
    }
  }

  private parse(cls: number, path: string, ref: number, b: WalkBatch, outDirs: (number | string)[]) {
    const dv = this.buf.dv, u16 = this.u16, nameAt = NAME_AT[cls];
    let o = 0;
    for (; ;) {
      const next = dv.getUint32(o, true);
      const nb = dv.getUint32(o + 60, true), nOff = (o + nameAt) >> 1, nLen = nb >> 1;
      const isDot = u16[nOff] === 46 && (nLen === 1 || (nLen === 2 && u16[nOff + 1] === 46));
      if (!isDot) {
        if (b.count >= b.parent.length) growBatch(b, b.parent.length * 2);
        if (b.namesLen + nLen > b.names.length) { const nn = new Uint16Array(Math.max(b.names.length * 2, b.namesLen + nLen)); nn.set(b.names); b.names = nn; }
        const i = b.count++;
        const attrs = dv.getUint32(o + 56, true);
        const tag = cls === FileIdExtdDirectoryInformation ? dv.getUint32(o + 68, true) : (attrs & ATTR.REPARSE ? dv.getUint32(o + 64, true) : 0);
        const size = dv.getUint32(o + 40, true) + dv.getUint32(o + 44, true) * 4294967296;
        b.parent[i] = ref; b.attrs[i] = attrs; b.tag[i] = tag;
        b.size[i] = size; b.alloc[i] = dv.getUint32(o + 48, true) + dv.getUint32(o + 52, true) * 4294967296;
        b.mtime[i] = filetimeToUnix(dv.getUint32(o + 24, true), dv.getUint32(o + 28, true));
        b.fileKey[i] = cls === FileFullDirectoryInformation ? 0 : dv.getUint32(o + 72, true) + dv.getUint16(o + 76, true) * 4294967296;
        b.nameOff[i] = b.namesLen; b.nameLen[i] = nLen;
        b.names.set(u16.subarray(nOff, nOff + nLen), b.namesLen); b.namesLen += nLen;
        if (attrs & ATTR.DIRECTORY) {
          if (!((attrs & ATTR.REPARSE) && isNameSurrogate(tag))) {
            const name = String.fromCharCode.apply(null, u16.subarray(nOff, nOff + nLen) as unknown as number[]);
            outDirs.push(i, path.endsWith('\\') ? path + name : path + '\\' + name);
          }
        } else b.bytes += size;
      }
      if (!next) break;
      o += next;
    }
  }

  /**
   * Recorre en profundidad desde las carpetas de la tarea hasta agotar el presupuesto de tiempo.
   * Lo que quede sin listar vuelve como pendiente para repartirlo.
   */
  run(task: WalkTask, budgetMs: number, compact = true): WalkBatch {
    // el lote de trabajo se reutiliza; al final se copia a la medida exacta para transferirlo
    const b = this.work ??= newBatch(8192, 8192 * 24);
    b.count = 0; b.namesLen = 0; b.pendRefs = []; b.pendPaths = []; b.errors = []; b.denied = 0; b.dirsListed = 0; b.bytes = 0;
    const stack: (number | string)[] = [];
    for (let i = task.refs.length - 1; i >= 0; i--) stack.push(task.refs[i], task.paths[i]);
    const t0 = performance.now(), found: (number | string)[] = [];
    while (stack.length) {
      const path = stack.pop() as string, ref = stack.pop() as number;
      found.length = 0;
      this.list(path, ref, b, found);
      for (let k = found.length - 2; k >= 0; k -= 2) stack.push(found[k], found[k + 1]);
      if (performance.now() - t0 > budgetMs) break;
    }
    for (let k = 0; k < stack.length; k += 2) { b.pendRefs.push(stack[k] as number); b.pendPaths.push(stack[k + 1] as string); }
    if (!compact) return b;
    const n = b.count;
    return {
      ...b, parent: b.parent.slice(0, n), size: b.size.slice(0, n), alloc: b.alloc.slice(0, n), attrs: b.attrs.slice(0, n),
      tag: b.tag.slice(0, n), mtime: b.mtime.slice(0, n), fileKey: b.fileKey.slice(0, n), nameOff: b.nameOff.slice(0, n),
      nameLen: b.nameLen.slice(0, n), names: b.names.slice(0, b.namesLen),
    };
  }
  private work: WalkBatch | null = null;
}

// ---------------------------------------------------------------------------------------------
// Orquestación: reparte carpetas entre workers persistentes (nunca se terminan: terminate()
// colgaba el proceso en Windows) o, con threads = 0, recorre en el hilo principal cediendo el turno.

export interface WalkProgress { entries: number; bytes: number; dirs: number; detail: string }
export interface WalkOptions {
  threads: number;
  workerUrl?: string | URL;
  trackKeys?: boolean;
  onProgress?: (p: WalkProgress) => void;
  isCancelled?: () => boolean;
}
export interface WalkOutcome { store: Store; errors: string[]; denied: number; dirsListed: number; threads: number }

/** Copia un lote al almacén. Devuelve el mapa índice local → id global. */
export function mergeBatch(store: Store, b: WalkBatch): Uint32Array {
  const n = b.count;
  store.ensure(n); store.ensureNames(b.namesLen);
  const base = store.namesLen;
  store.names.set(b.names.subarray(0, b.namesLen), base); store.namesLen += b.namesLen;
  const l2g = new Uint32Array(n), key = store.key, names = store.names;
  for (let i = 0; i < n; i++) {
    const p = b.parent[i], gp = p >= 0 ? l2g[p] : -p - 1;
    const id = store.n++, attrs = b.attrs[i], dir = (attrs & ATTR.DIRECTORY) !== 0;
    const off = base + b.nameOff[i], len = b.nameLen[i];
    store.par[id] = gp;
    store.sz[id] = dir ? 0 : b.size[i]; store.al[id] = dir ? 0 : b.alloc[i];
    store.mt[id] = b.mtime[i];
    store.fl[id] = flagsFromAttrs(attrs, b.tag[i], dir);
    store.ex[id] = dir ? 0xFFFF : store.extOf(names, off, len);
    store.nOff[id] = off; store.nLen[id] = len;
    if (key) key[id] = dir ? 0 : b.fileKey[i];
    l2g[i] = id;
  }
  return l2g;
}

export const WALK_WORKER_FLAG = '--tessera-walk-worker';
const pools = new Map<string, { workers: Worker[]; ready: Promise<void> }>();
let defaultWorkerUrl: string | URL | null = null;
/** El bundle portable usa su propio archivo como worker. */
export function setWalkWorkerUrl(u: string | URL) { defaultWorkerUrl = u; }

function getPool(n: number, url: string | URL) {
  const k = String(url);
  let pool = pools.get(k);
  if (!pool) { pool = { workers: [], ready: Promise.resolve() }; pools.set(k, pool); }
  const fresh: Promise<void>[] = [];
  while (pool.workers.length < n) {
    const w = new Worker(url, { argv: [WALK_WORKER_FLAG], smol: true } as WorkerOptions);
    (w as unknown as { unref(): void }).unref(); // no retiene el proceso (los tipos DOM no lo declaran)
    fresh.push(new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('el worker no arrancó')), 15000);
      const once = (e: MessageEvent) => {
        if ((e.data as { type?: string })?.type === 'ready') { clearTimeout(t); w.removeEventListener('message', once); res(); }
      };
      w.addEventListener('message', once);
      w.addEventListener('error', () => { clearTimeout(t); rej(new Error('el worker falló al arrancar')); });
    }));
    pool.workers.push(w);
  }
  pool.ready = Promise.all([pool.ready, ...fresh]).then(() => { });
  return pool;
}

function rootInfo(path: string): { attrs: number; mtime: number } | null {
  const d = new Uint8Array(36);
  if (!kernel32().GetFileAttributesExW(wstr(path), 0, d)) return null;
  const dv = new DataView(d.buffer);
  return { attrs: dv.getUint32(0, true), mtime: filetimeToUnix(dv.getUint32(20, true), dv.getUint32(24, true)) };
}

export async function walkScan(rootPath: string, opts: WalkOptions): Promise<WalkOutcome> {
  const ri = rootInfo(rootPath);
  if (!ri) throw new Error(`No se puede abrir: ${rootPath}`);
  if (!(ri.attrs & ATTR.DIRECTORY)) throw new Error(`No es una carpeta: ${rootPath}`);
  const store = new Store(1 << 16, !!opts.trackKeys);
  const rootId = store.addRoot(rootPath, ri.mtime, flagsFromAttrs(ri.attrs, 0, true));
  const qRefs: number[] = [-rootId - 1], qPaths: string[] = [rootPath];
  const errors: string[] = [];
  let denied = 0, dirsListed = 0, bytes = 0, infoClass = 0, lastPath = rootPath, lastTick = 0;
  const tick = (force = false) => {
    const now = performance.now();
    if (!opts.onProgress || (!force && now - lastTick < 100)) return;
    lastTick = now;
    opts.onProgress({ entries: store.n, bytes, dirs: dirsListed, detail: lastPath });
  };
  const absorb = (b: WalkBatch) => {
    const l2g = mergeBatch(store, b);
    for (let k = 0; k < b.pendRefs.length; k++) {
      const r = b.pendRefs[k];
      qRefs.push(r >= 0 ? -l2g[r] - 1 : r); qPaths.push(b.pendPaths[k]);
    }
    for (const e of b.errors) if (errors.length < 5000) errors.push(e);
    denied += b.denied; dirsListed += b.dirsListed; bytes += b.bytes;
    if (b.pendPaths.length) lastPath = b.pendPaths[b.pendPaths.length - 1];
    tick();
  };
  const take = (max: number) => {
    const k = Math.max(1, Math.min(max, qRefs.length));
    return { refs: qRefs.splice(qRefs.length - k, k), paths: qPaths.splice(qPaths.length - k, k) };
  };

  let threads = Math.max(0, opts.threads | 0);
  let pool: ReturnType<typeof getPool> | null = null;
  if (threads > 0) {
    try {
      pool = getPool(threads, opts.workerUrl ?? defaultWorkerUrl ?? new URL('./' + 'walkworker.ts', import.meta.url));
      await pool.ready;
    } catch (e) {
      errors.push(`Workers no disponibles (${(e as Error).message}); se recorre en un solo hilo`);
      threads = 0; pool = null;
    }
  }

  if (pool && threads > 0) {
    const workers = pool.workers.slice(0, threads), all = pool.workers;
    await new Promise<void>((resolve, reject) => {
      const idle = [...workers];
      const busy = new Map<Worker, WalkTask>();
      let seq = 0, done = false;
      const finish = (err?: Error) => {
        if (done) return; done = true;
        for (const w of workers) { w.onmessage = null; w.onerror = null; }
        if (err) reject(err); else resolve();
      };
      const dispatch = () => {
        if (opts.isCancelled?.()) { qRefs.length = 0; qPaths.length = 0; }
        while (idle.length && qRefs.length) {
          const w = idle.pop()!;
          const t = take(Math.ceil(qRefs.length / (workers.length * 2)));
          busy.set(w, t);
          w.postMessage({ type: 'task', id: ++seq, refs: t.refs, paths: t.paths, budgetMs: 40, infoClass });
        }
        if (!busy.size && !qRefs.length) finish();
      };
      for (const w of workers) {
        w.onmessage = (e: MessageEvent) => {
          const m = e.data as { type: string; batch?: WalkBatch; error?: string; infoClass?: number };
          if (m.type === 'result' && m.batch) { infoClass = m.infoClass ?? infoClass; absorb(m.batch); }
          else if (m.type === 'fail') errors.push(`Fallo en el recorrido: ${m.error}`);
          else return;
          busy.delete(w); idle.push(w);
          dispatch();
        };
        w.onerror = (ev: ErrorEvent) => {
          // worker caído: sus carpetas vuelven a la cola y siguen los demás
          const t = busy.get(w);
          busy.delete(w);
          workers.splice(workers.indexOf(w), 1);
          const pi = all.indexOf(w); if (pi >= 0) all.splice(pi, 1);
          if (t) for (let k = 0; k < t.refs.length; k++) { qRefs.push(t.refs[k]); qPaths.push(t.paths[k]); }
          errors.push(`Un worker de recorrido falló: ${ev.message}`);
          if (!workers.length) finish(new Error('todos los workers fallaron; se sigue en un solo hilo'));
          else dispatch();
        };
      }
      dispatch();
    }).catch((e: Error) => { errors.push(e.message); threads = 0; });
  }

  if (qRefs.length && !opts.isCancelled?.()) {
    // hilo principal: tramos de ~30 ms cediendo el turno para que el servidor siga respondiendo
    const reader = new DirReader(256 * 1024);
    while (qRefs.length && !opts.isCancelled?.()) {
      absorb(reader.run(take(64), 30, false));
      await new Promise(r => setImmediate(r));
    }
  }
  if (opts.isCancelled?.()) throw new Error('Escaneo cancelado');
  tick(true);
  return { store, errors, denied, dirsListed, threads };
}
