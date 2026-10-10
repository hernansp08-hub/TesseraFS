// Archivos duplicados sobre el árbol escaneado, en tres pasadas: tamaño (sin leer nada), primeros 64 KiB y
// contenido completo. Da los mismos grupos que el motor Rust (allí BLAKE3; aquí SHA-256: sólo cambia el hash).
// Las lecturas son asíncronas y por trozos, así que el servidor sigue atendiendo el progreso y la cancelación.
import { open } from 'node:fs/promises';
import { FLAG, type DupGroup, type DupPhase, type DupProgress, type DupResult, type EngineMessage, type SearchRow } from '../../protocol/src/index.ts';
import { EngineError, engineError, msg } from './messages.ts';
import type { Store } from './store.ts';

export const DUP_PREFIX = 64 * 1024;  // bytes que lee la segunda pasada
export const DUP_CHUNK = 1 << 20;     // trozo de la tercera pasada (y paso de la cancelación)
export const DUP_MAX_LIMIT = 5000;
export const DUP_DEFAULT_LIMIT = 1000;
export const DUP_HASH = 'sha256';     // 256 bits; con SHA-NI va más rápido que blake2b256 en Bun
const HEAD_JOBS = 16, FULL_JOBS = 2;  // archivos en vuelo: lecturas cortas / largas
const TICK_MS = 100;

export interface DupOptions {
  minSize?: number;
  limit?: number;
  onProgress?: (p: DupProgress) => void;
  isCancelled?: () => boolean;
}

type Bufs = [Buffer, Buffer];
/** Grupos de una pasada: clave = hash binario (32 caracteres latin1) + tamaño; valor = id suelto o ids. */
type Buckets = Map<string, number | number[]>;
interface Group { size: number; hash: string; ids: number[] }

/** Ruta extendida (\\?\): rutas largas y nombres que Win32 retocaría (punto o espacio final). */
export function extendedPath(p: string): string {
  if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\')) return p;
  if (p.startsWith('\\\\')) return '\\\\?\\UNC\\' + p.slice(2);
  return '\\\\?\\' + p;
}

/** El archivo ya no mide lo que dice el escaneo: se descarta como ilegible. */
class ChangedFile extends Error { }

const yieldNow = () => new Promise<void>(r => setImmediate(r));

/**
 * Marca los índices de `sizes[0..m)` cuyo tamaño se repite. Tabla hash abierta sobre arreglos tipados:
 * con millones de archivos, Map u ordenar con comparador bloquean el servidor varios segundos.
 */
function repeatedSizes(sizes: Float64Array, m: number): Uint8Array {
  let bits = 4;
  while ((1 << bits) < m * 2) bits++;
  const cap = 1 << bits, mask = cap - 1, shift = 32 - bits;
  const keys = new Float64Array(cap), count = new Uint8Array(cap), slot = new Uint32Array(m);
  for (let i = 0; i < m; i++) {
    const s = sizes[i]; // ≥ 1: 0 marca hueco libre
    let h = Math.imul((s >>> 0) ^ ((s / 4294967296) >>> 0), 0x9E3779B1) >>> shift;
    while (keys[h] !== 0 && keys[h] !== s) h = (h + 1) & mask;
    keys[h] = s;
    if (count[h] < 2) count[h]++;
    slot[i] = h;
  }
  const rep = new Uint8Array(m);
  for (let i = 0; i < m; i++) rep[i] = count[slot[i]] >> 1;
  return rep;
}

export async function findDuplicates(store: Store, root: number, opts: DupOptions = {}): Promise<DupResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const minSize = Math.max(1, Number.isFinite(opts.minSize) ? opts.minSize! : 0);
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(DUP_MAX_LIMIT, Math.floor(opts.limit!))) : DUP_DEFAULT_LIMIT;
  const onProgress = opts.onProgress ?? (() => { });
  const isCancelled = opts.isCancelled ?? (() => false);
  const checkCancel = () => { if (isCancelled()) throw engineError('error.cancelled'); };
  const sz = store.sz, fl = store.fl;

  // progreso de la pasada en curso, como mucho cada TICK_MS
  let phase: DupPhase = 'size', files = 0, totalFiles = 0, bytes = 0, totalBytes = 0, last = 0, readBytes = 0;
  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - last < TICK_MS) return;
    last = now;
    onProgress({ phase, files, totalFiles, bytes, totalBytes, elapsedMs: ms() });
  };
  const startPass = (p: DupPhase, n: number, total: number) => {
    phase = p; files = 0; totalFiles = n; bytes = 0; totalBytes = total;
    report(true);
  };

  // 1) tamaño: candidatos sin leer nada. Los enlaces duros ya llegan con tamaño 0 (dedupHardlinks / MFT),
  // así que se cuentan antes del filtro de tamaño; los de la nube, sólo si habrían sido candidatos.
  // Se recorre por las listas de hijos (no por ids) para no contar lo ya enviado a la papelera.
  let hardlinks = 0, cloud = 0, m = 0;
  let ids = new Uint32Array(4096), sizes = new Float64Array(4096);
  const ks = store.kidStart, kc = store.kidCount, kids = store.kids;
  const stack: number[] = [root];
  while (stack.length) {
    const id = stack.pop()!, f = fl[id];
    if (f & FLAG.DIR) {
      if (id === root || !(f & FLAG.REPARSE)) for (let k = ks[id] + kc[id] - 1; k >= ks[id]; k--) stack.push(kids[k]);
      continue;
    }
    if (id === root || (f & FLAG.REPARSE)) continue;
    if (f & FLAG.HARDLINK) { hardlinks++; continue; }
    const s = sz[id];
    if (s < minSize) continue;
    if (f & FLAG.CLOUD) { cloud++; continue; } // leerlo lo descargaría
    if (m === ids.length) {
      const i2 = new Uint32Array(m * 2), s2 = new Float64Array(m * 2);
      i2.set(ids); s2.set(sizes); ids = i2; sizes = s2;
    }
    ids[m] = id; sizes[m++] = s;
  }
  await yieldNow();
  checkCancel();
  const rep = repeatedSizes(sizes, m);
  let n = 0;
  for (let i = 0; i < m; i++) if (rep[i]) n++;
  // en orden de id (el del escaneo): lecturas más próximas en el disco
  const cand = new Uint32Array(n);
  for (let i = 0, j = 0; i < m; i++) if (rep[i]) cand[j++] = ids[i];
  cand.sort();
  ids = new Uint32Array(0); sizes = new Float64Array(0);
  phase = 'size'; files = totalFiles = n;
  report(true);
  await yieldNow();
  checkCancel();

  const failed = new Set<number>();
  /** Lee `list` con `jobs` archivos en vuelo y los agrupa por (tamaño, hash). Un fallo de lectura descarta el archivo. */
  async function pass(list: Uint32Array, jobs: number, bufSize: number, hashOne: (id: number, path: string, bufs: Bufs) => Promise<Buffer>) {
    const buckets: Buckets = new Map();
    let next = 0, stop = null as EngineError | null;
    const worker = async () => {
      const bufs: Bufs = [Buffer.allocUnsafe(bufSize), Buffer.allocUnsafe(bufSize)];
      while (!stop && next < list.length) {
        if (isCancelled()) { stop = engineError('error.cancelled'); break; }
        const id = list[next++];
        let digest: Buffer | null = null;
        try { digest = await hashOne(id, extendedPath(store.path(id)), bufs); } catch (e) {
          if (e instanceof EngineError) { stop ??= e; break; }
          failed.add(id);
        }
        files++;
        if (digest) {
          const k = digest.toString('latin1') + sz[id];
          const g = buckets.get(k);
          if (g === undefined) buckets.set(k, id);
          else if (typeof g === 'number') buckets.set(k, [g, id]);
          else g.push(id);
        }
        report();
      }
    };
    // los trabajadores no lanzan: así se cierran todos los archivos antes de devolver o propagar la cancelación
    await Promise.all(Array.from({ length: Math.min(jobs, list.length) }, worker));
    if (stop) throw stop;
    return buckets;
  }
  const groupsOf = function* (b: Buckets): Generator<Group> {
    for (const [k, g] of b) {
      if (typeof g === 'number') continue;
      yield { size: sz[g[0]], hash: Buffer.from(k.slice(0, 32), 'latin1').toString('hex'), ids: g };
    }
  };

  // 2) primeros 64 KiB (los archivos de hasta 64 KiB se leen enteros y quedan resueltos aquí)
  const hashHead = async (id: number, path: string, [buf]: Bufs) => {
    const size = sz[id], head = Math.min(size, DUP_PREFIX);
    const want = size <= DUP_PREFIX ? size + 1 : DUP_PREFIX; // +1: detecta si el archivo creció
    const fh = await open(path, 'r');
    try {
      let got = 0;
      while (got < head) { // casi siempre basta una lectura
        const { bytesRead } = await fh.read(buf, got, want - got, got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      bytes += got; readBytes += got;
      if (got !== head) throw new ChangedFile();
      return new Bun.CryptoHasher(DUP_HASH).update(buf.subarray(0, got)).digest();
    } finally { await fh.close().catch(() => { }); }
  };

  // 3) contenido completo, hasta el final del archivo; se lee el trozo siguiente mientras se calcula el hash
  const hashFull = async (id: number, path: string, bufs: Bufs) => {
    const size = sz[id], h = new Bun.CryptoHasher(DUP_HASH);
    const fh = await open(path, 'r');
    let pending: Promise<{ bytesRead: number }> | null = null;
    try {
      let pos = 0, cur = 0;
      pending = fh.read(bufs[0], 0, DUP_CHUNK, 0);
      for (; ;) {
        const { bytesRead } = await pending;
        if (!bytesRead) break;
        const chunk = bufs[cur];
        pos += bytesRead; bytes += bytesRead; readBytes += bytesRead;
        if (pos > size) throw new ChangedFile();
        checkCancel();
        cur ^= 1;
        pending = fh.read(bufs[cur], 0, DUP_CHUNK, pos);
        h.update(chunk.subarray(0, bytesRead));
        report();
      }
      if (pos !== size) throw new ChangedFile();
      return h.digest();
    } finally {
      if (pending) await pending.catch(() => null); // no cerrar con una lectura en vuelo
      await fh.close().catch(() => { });
    }
  };

  let headTotal = 0;
  for (const id of cand) headTotal += Math.min(sz[id], DUP_PREFIX);
  startPass('prefix', n, headTotal);
  const heads = await pass(cand, HEAD_JOBS, DUP_PREFIX + 1, hashHead);

  const final: Group[] = [], bigIds: number[] = [];
  let fullTotal = 0;
  for (const g of groupsOf(heads)) {
    if (g.size <= DUP_PREFIX) final.push(g);
    else for (const id of g.ids) { bigIds.push(id); fullTotal += g.size; }
  }
  heads.clear();
  const big = Uint32Array.from(bigIds).sort();
  startPass('full', big.length, fullTotal);
  for (const g of groupsOf(await pass(big, FULL_JOBS, DUP_CHUNK, hashFull))) final.push(g);
  checkCancel();

  // resultado: más espacio recuperable primero; dentro de cada grupo, por ruta sin distinguir mayúsculas
  const wastedOf = (g: Group) => (g.ids.length - 1) * g.size;
  final.sort((a, b) => wastedOf(b) - wastedOf(a) || b.size - a.size || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  let wasted = 0;
  for (const g of final) wasted += wastedOf(g);
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const rows = (list: number[]): SearchRow[] => list
    .map(id => { const path = store.path(id); return { row: { ...store.row(id), path }, key: path.toLowerCase() }; })
    .sort((a, b) => cmp(a.key, b.key) || cmp(a.row.path, b.row.path))
    .map(x => x.row);
  const groups: DupGroup[] = final.slice(0, limit).map(g => ({ size: g.size, hash: g.hash, files: rows(g.ids) }));
  const warnings: EngineMessage[] = failed.size ? [msg('dup.readErrors', { count: failed.size })] : [];

  phase = 'done'; files = totalFiles = n; bytes = totalBytes = readBytes;
  report(true);
  return {
    groups, totalGroups: final.length, wasted, candidates: n, readBytes,
    skipped: { hardlinks, cloud }, elapsedMs: ms(), warnings,
  };
}
