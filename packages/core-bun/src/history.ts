// Historial de escaneos (resúmenes en disco), comparación con el escaneo cargado y exportación de archivos.
// El formato de los resúmenes lo comparten las dos ediciones: ver docs/ARQUITECTURA.md («Historial»).
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { win32 as winPath } from 'node:path';
import { FLAG, type ChangeRow, type CompareResult, type Engine, type ExportResult, type HistoryEntry, type RemovedRow } from '../../protocol/src/index.ts';
import { engineError, errorText } from './messages.ts';
import { CMP_FRESH, CMP_MATCHED, NONE, type Store } from './store.ts';
import { FOLDERID, knownFolder } from './win32.ts';

export const HISTORY_KEEP = 20;           // resúmenes que se conservan de cada ruta
export const SNAP_MIN_FILE = 1 << 20;     // archivos que entran en el resumen (y umbral de «nuevo»)
export const COMPARE_MAX_LIMIT = 1000;
export const COMPARE_DEFAULT_LIMIT = 100; // si `limit` no es un número
export const EXPORT_MAX_NAME = 200;

const join = winPath.join;

// ---------- carpetas ----------
/** %LOCALAPPDATA%\TesseraFS\history, o TESSERA_HISTORY_DIR (pruebas). */
export function historyDir(): string {
  const env = process.env.TESSERA_HISTORY_DIR;
  if (env) return winPath.resolve(env);
  const local = process.env.LOCALAPPDATA || knownFolder(FOLDERID.LocalAppData) || join(homedir(), 'AppData', 'Local');
  return join(local, 'TesseraFS', 'history');
}

/** Descargas del usuario (carpeta conocida, no %USERPROFILE%\Downloads) + \TesseraFS, o TESSERA_EXPORT_DIR (pruebas). */
export function exportDir(): string {
  const env = process.env.TESSERA_EXPORT_DIR;
  if (env) return winPath.resolve(env);
  return join(knownFolder(FOLDERID.Downloads) || join(homedir(), 'Downloads'), 'TesseraFS');
}

// ---------- ids ----------
/** FNV-1a de 32 bits. */
export function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

/** Hash de la ruta para el id: FNV-1a de 32 bits de la ruta en minúsculas (UTF-8), 8 dígitos hex en minúsculas. */
export function pathHash(path: string): string {
  return fnv1a32(Buffer.from(path.toLowerCase(), 'utf8')).toString(16).padStart(8, '0');
}

/** `YYYYMMDDTHHMMSSZ-hhhhhhhh`: momento del guardado (UTC) + hash de la ruta. */
export function historyId(path: string, at: Date = new Date()): string {
  return at.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z-' + pathHash(path);
}

/** Ids que se aceptan al borrar o comparar (nunca rutas). */
const VALID_ID = /^[A-Za-z0-9-]+$/;

/** Momento del guardado según el id, como en el motor Rust: fecha, sufijo -2, -3… (1 si no hay) y el id entero. */
function compareIds(a: string, b: string): number {
  const key = (id: string): [string, number] => {
    const i = id.indexOf('-'), j = i < 0 ? -1 : id.indexOf('-', i + 1);
    const rest = j < 0 ? '' : id.slice(j + 1);
    return [i < 0 ? id : id.slice(0, i), /^\d{1,9}$/.test(rest) ? Number(rest) : 1];
  };
  const [x, i] = key(a), [y, j] = key(b);
  return x < y ? -1 : x > y ? 1 : i - j || (a < b ? -1 : a > b ? 1 : 0);
}
/** El más reciente primero (scannedAt; a igualdad, el guardado después). */
const newestFirst = (a: HistoryEntry, b: HistoryEntry) => b.scannedAt - a.scannedAt || compareIds(b.id, a.id);

const files = (dir: string, id: string) => ({ json: join(dir, `${id}.json`), snap: join(dir, `${id}.snap.gz`) });
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const errno = (e: unknown) => (e as { code?: unknown } | null)?.code;
/** Borra un archivo; true si existía. */
function unlink(p: string): boolean {
  try { fs.unlinkSync(p); return true; } catch (e) {
    if (errno(e) === 'ENOENT') return false;
    throw e;
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Suplentes sueltas → U+FFFD (lo que hace String.prototype.toWellFormed, ES2024). */
const wellFormed = (x: string) => /[\ud800-\udfff]/.test(x) ? x.replace(LONE_SURROGATE, '\uFFFD') : x;

/**
 * Nombres de todo el árbol decodificados de una vez (varias veces más rápido que Store.name nodo a nodo). Las
 * suplentes sueltas pasan a U+FFFD (misma longitud: los desplazamientos siguen valiendo), como en el motor Rust;
 * así el JSON del resumen siempre es UTF-8 válido.
 */
function nameReader(s: Store): (id: number) => string {
  const all = new TextDecoder('utf-16le').decode(s.names.subarray(0, s.namesLen));
  const off = s.nOff, len = s.nLen;
  return id => all.substring(off[id], off[id] + len[id]);
}

// ---------- resúmenes ----------
/** Nodo del resumen: [parent, name, isDir (0|1), size, alloc, files, dirs, mtime]. */
export type SnapNode = [number, string, 0 | 1, number, number, number, number, number];
export interface Snapshot { v: 1; path: string; scannedAt: number; nodes: SnapNode[] }

/**
 * Resumen del árbol cargado: preorden desde la raíz con todas las carpetas y los archivos de 1 MiB o más.
 * `nodes[0]` es la raíz (parent −1, name = ruta completa); cada nodo va después de su padre.
 * Lo enviado a la papelera ya no cuelga del árbol y no entra.
 */
export function buildSnapshot(s: Store, scannedAt: number): Snapshot {
  const root = s.rootId, at = new Int32Array(s.n), nodes: SnapNode[] = [], name = nameReader(s);
  const rootPath = wellFormed(s.rootPath);
  s.forEach(root, id => {
    const dir = s.isDir(id);
    if (!dir && s.sz[id] < SNAP_MIN_FILE) return;
    at[id] = nodes.length;
    nodes.push([
      id === root ? -1 : at[s.par[id]], id === root ? rootPath : name(id), dir ? 1 : 0,
      s.sz[id], s.al[id], s.nf[id], s.nd[id], s.mt[id],
    ]);
  });
  return { v: 1, path: rootPath, scannedAt, nodes };
}

/** Lee y valida un HistoryEntry (null si no lo es); devuelve sólo los campos del contrato, en su orden. */
function parseEntry(text: string): HistoryEntry | null {
  let e: Record<string, unknown>;
  try { e = JSON.parse(text); } catch { return null; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const n = (k: string) => typeof e[k] === 'number' && Number.isFinite(e[k] as number);
  if (typeof e.id !== 'string' || typeof e.path !== 'string' || (e.engine !== 'mft' && e.engine !== 'walk')) return null;
  if (!['scannedAt', 'bytes', 'files', 'dirs', 'nodes', 'fileBytes'].every(n)) return null;
  return {
    id: e.id as string, path: e.path as string, scannedAt: e.scannedAt as number, engine: e.engine as Engine, bytes: e.bytes as number,
    files: e.files as number, dirs: e.dirs as number, nodes: e.nodes as number, fileBytes: e.fileBytes as number,
  };
}

/** Todo el historial (sólo los resúmenes con su .snap.gz), el más reciente primero. */
export function listHistory(dir = historyDir()): HistoryEntry[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const have = new Set(names.map(x => x.toLowerCase()));
  const out: HistoryEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!VALID_ID.test(id) || !have.has(`${id}.snap.gz`.toLowerCase())) continue;
    let text: string;
    try { text = fs.readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    const e = parseEntry(text);
    if (e && e.id === id) out.push(e);
  }
  return out.sort(newestFirst);
}

/**
 * Guarda el árbol cargado: primero `<id>.snap.gz` y después `<id>.json` (el que confirma el resumen).
 * Después conserva sólo los HISTORY_KEEP más recientes de la misma ruta (sin distinguir mayúsculas).
 */
export function saveHistory(s: Store, engine: Engine, scannedAt: number, dir = historyDir(), now: Date = new Date()): HistoryEntry {
  const root = s.rootId;
  let entry: HistoryEntry | null = null, written: string[] = [];
  try {
    const snap = buildSnapshot(s, scannedAt);
    const gz = Bun.gzipSync(Buffer.from(JSON.stringify(snap), 'utf8'));
    fs.mkdirSync(dir, { recursive: true });
    const base = historyId(s.rootPath, now);
    for (let k = 1; ; k++) {
      const id = k === 1 ? base : `${base}-${k}`, f = files(dir, id);
      if (fs.existsSync(f.json)) continue;
      try { fs.writeFileSync(f.snap, gz, { flag: 'wx' }); } catch (e) {
        if (errno(e) === 'EEXIST') continue; // otro guardado en el mismo segundo
        throw e;
      }
      written = [f.snap];
      entry = {
        id, path: wellFormed(s.rootPath), scannedAt, engine, bytes: s.sz[root], files: s.nf[root], dirs: s.nd[root],
        nodes: snap.nodes.length, fileBytes: gz.byteLength,
      };
      fs.writeFileSync(f.json, JSON.stringify(entry), { flag: 'wx' });
      written = [];
      break;
    }
  } catch (e) {
    for (const p of written) try { fs.unlinkSync(p); } catch { /* da igual */ }
    throw engineError('history.saveFailed', { error: errorText(e) });
  }
  // retención: un fallo al borrar lo antiguo no estropea el guardado
  try {
    const key = s.rootPath.toLowerCase();
    const same = listHistory(dir).filter(e => e.path.toLowerCase() === key);
    for (const old of same.slice(HISTORY_KEEP)) {
      if (old.id === entry!.id) continue; // (sólo si el reloj retrocedió)
      const f = files(dir, old.id);
      try { unlink(f.json); unlink(f.snap); } catch { /* se reintentará en el próximo guardado */ }
    }
  } catch { /* idem */ }
  return entry!;
}

/** Borra un resumen (sus dos archivos). True si existía. Un id con caracteres fuera de [A-Za-z0-9-] → history.notFound. */
export function deleteHistory(id: unknown, dir = historyDir()): boolean {
  if (typeof id !== 'string' || !VALID_ID.test(id)) throw engineError('history.notFound', { id: String(id ?? '') });
  const f = files(dir, id);
  try {
    const a = unlink(f.json), b = unlink(f.snap);
    return a || b;
  } catch (e) { throw engineError('history.saveFailed', { error: errorText(e) }); }
}

/** Borra todos los resúmenes de la lista (sus dos archivos; nada más de la carpeta). Devuelve cuántos borró. */
export function clearHistory(dir = historyDir()): number {
  let count = 0;
  for (const e of listHistory(dir)) if (deleteHistory(e.id, dir)) count++;
  return count;
}

/** Resumen leído y validado, en columnas. */
export interface LoadedSnapshot {
  path: string;
  scannedAt: number;
  n: number;
  parent: Int32Array;
  isDir: Uint8Array;
  size: Float64Array;
  names: string[];
  rootFiles: number;
  rootDirs: number;
}

/** Descomprime y valida un .snap.gz (lanza Error con el motivo). */
export function parseSnapshot(gz: Uint8Array): LoadedSnapshot {
  const snap = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz))) as Record<string, unknown>;
  if (!snap || typeof snap !== 'object' || snap.v !== 1) throw new Error('unsupported snapshot version');
  const nodes = snap.nodes;
  if (typeof snap.path !== 'string' || !Array.isArray(nodes) || !nodes.length) throw new Error('invalid snapshot');
  const n = nodes.length, parent = new Int32Array(n), isDir = new Uint8Array(n), size = new Float64Array(n), names: string[] = new Array(n);
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  for (let i = 0; i < n; i++) {
    const r = nodes[i] as unknown[];
    if (!Array.isArray(r) || r.length < 8 || typeof r[1] !== 'string' || !num(r[3])) throw new Error(`invalid snapshot node ${i}`);
    const p = r[0] as number;
    if (i === 0 ? p !== -1 : !(Number.isInteger(p) && p >= 0 && p < i && isDir[p])) throw new Error(`invalid snapshot node ${i}`);
    parent[i] = p; names[i] = r[1] as string; isDir[i] = r[2] === 1 || r[2] === true ? 1 : 0; size[i] = r[3] as number;
  }
  const root = nodes[0] as unknown[];
  if (!isDir[0] || !num(root[5]) || !num(root[6])) throw new Error('invalid snapshot root');
  return {
    path: snap.path as string, scannedAt: num(snap.scannedAt) ? snap.scannedAt as number : 0, n, parent, isDir, size, names,
    rootFiles: root[5] as number, rootDirs: root[6] as number,
  };
}

/** Comprueba la raíz (sin distinguir mayúsculas). */
function sameRoot(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }

/**
 * Compara el árbol cargado con el resumen `id` y deja la comparación activa en el almacén.
 * Errores: history.notFound, history.readFailed, history.otherRoot.
 */
export function compareHistory(s: Store, id: unknown, limit: number, dir = historyDir()): CompareResult {
  if (typeof id !== 'string' || !VALID_ID.test(id)) throw engineError('history.notFound', { id: String(id ?? '') });
  const f = files(dir, id);
  if (!isFile(f.json) || !isFile(f.snap)) throw engineError('history.notFound', { id });
  const readFailed = (e: unknown) => engineError('history.readFailed', { error: errorText(e) });
  let entry: HistoryEntry | null, snap: LoadedSnapshot;
  try { entry = parseEntry(fs.readFileSync(f.json, 'utf8')); } catch (e) { throw readFailed(e); }
  if (!entry) throw readFailed('invalid summary');
  try { snap = parseSnapshot(fs.readFileSync(f.snap)); } catch (e) { throw readFailed(e); }
  // (mismo orden de comprobaciones que el motor Rust: primero se leen los dos archivos)
  if (!sameRoot(entry.path, s.rootPath) || !sameRoot(snap.path, s.rootPath)) throw engineError('history.otherRoot', { path: entry.path });
  return compareSnapshot(s, entry, snap, limit);
}

/** Empareja el resumen con el árbol, activa la comparación en `s` y calcula lo que creció, menguó o desapareció. */
export function compareSnapshot(s: Store, entry: HistoryEntry, snap: LoadedSnapshot, limit: number): CompareResult {
  const lim = Number.isFinite(limit) ? Math.max(1, Math.min(COMPARE_MAX_LIMIT, Math.floor(limit))) : COMPARE_DEFAULT_LIMIT;
  const m = snap.n, sp = snap.parent, sd = snap.isDir, ss = snap.size, sn = snap.names;
  const root = s.rootId, n = s.n, par = s.par, sz = s.sz, fl = s.fl, ks = s.kidStart, kc = s.kidCount, kids = s.kids;

  // hijos de cada nodo del resumen (CSR; en orden del resumen)
  const start = new Uint32Array(m + 1);
  for (let j = 1; j < m; j++) start[sp[j] + 1]++;
  for (let j = 0; j < m; j++) start[j + 1] += start[j];
  const skids = new Uint32Array(Math.max(0, m - 1)), fill = start.slice(0, m);
  for (let j = 1; j < m; j++) skids[fill[sp[j]]++] = j;

  // emparejamiento: raíz con raíz; después, en orden del resumen, cada nodo con el hijo de la carpeta actual
  // emparejada con su padre que tenga el mismo nombre en minúsculas y el mismo tipo. El índice por nombre se crea
  // sólo para las carpetas emparejadas que tienen hijos en el resumen (y sólo con esos hijos).
  const match = new Int32Array(m).fill(-1), name = nameReader(s);
  const low: string[] = new Array(m); // nombre del resumen en minúsculas
  // índice por nombre (carpetas y archivos aparte). Nombres repetidos (carpetas que distinguen mayúsculas):
  // cuenta sólo el primero del resumen y el primer hijo actual que lo encuentre, como en el motor Rust
  const dirs = new Map<string, number>(), filesByName = new Map<string, number>();
  match[0] = root;
  for (let i = 0; i < m; i++) {
    const P = match[i], a = start[i], b = start[i + 1];
    if (P < 0 || !sd[i] || a === b) continue;
    let wantDirs = 0, wantFiles = 0;
    for (let k = a; k < b; k++) {
      const j = skids[k];
      low[j] = wellFormed(sn[j]).toLowerCase();
      if (sd[j]) wantDirs++; else wantFiles++;
    }
    const small = b - a <= 8; // pocos hijos: búsqueda lineal, sin índice
    if (!small) {
      dirs.clear(); filesByName.clear();
      for (let k = b - 1; k >= a; k--) { const j = skids[k]; (sd[j] ? dirs : filesByName).set(low[j], j); } // vale el primero
    }
    for (let k = ks[P], end = ks[P] + kc[P]; k < end && (wantDirs || wantFiles); k++) {
      const c = kids[k], dir = (fl[c] & FLAG.DIR) !== 0;
      if (dir ? !wantDirs : !wantFiles) continue;
      const key = name(c).toLowerCase(), isd = dir ? 1 : 0;
      let j = -1;
      if (small) {
        for (let q = a; q < b; q++) { const x = skids[q]; if (sd[x] === isd && low[x] === key) { j = x; break; } }
      } else {
        j = (dir ? dirs : filesByName).get(key) ?? -1;
      }
      if (j < 0 || match[j] >= 0) continue;
      match[j] = c;
      if (dir) wantDirs--; else wantFiles--;
    }
  }

  // estado por nodo actual: emparejado (prev) · nuevo (carpeta, archivo ≥ 1 MiB o padre nuevo) · desconocido
  const prev = new Float64Array(n), st = new Uint8Array(n);
  for (let j = 0; j < m; j++) { const c = match[j]; if (c >= 0) { st[c] = CMP_MATCHED; prev[c] = ss[j]; } }
  for (let id = 0; id < n; id++) { // el padre siempre tiene un id menor
    if (st[id]) continue;
    const p = par[id];
    if (p === NONE) continue;
    if ((fl[id] & FLAG.DIR) || sz[id] >= SNAP_MIN_FILE || (st[p] & CMP_FRESH)) st[id] = CMP_FRESH;
  }
  s.setCompare({ prev, st });

  // grew/shrank: delta ≠ 0 sin que un solo hijo explique el 75 % o más (los archivos siempre cuentan)
  const d = new Float64Array(n), hi = new Float64Array(n).fill(-Infinity), lo = new Float64Array(n).fill(Infinity);
  s.forEach(root, id => {
    const x = d[id] = s.delta(id);
    if (id === root) return;
    const p = par[id];
    if (x > hi[p]) hi[p] = x;
    if (x < lo[p]) lo[p] = x;
  });
  const grewIds: number[] = [], shrankIds: number[] = [];
  s.forEach(root, id => {
    if (id === root) return;
    const x = d[id];
    if (x > 0) { if (!(hi[id] * 4 >= x * 3)) grewIds.push(id); }
    else if (x < 0) { if (!(lo[id] * 4 <= x * 3)) shrankIds.push(id); }
  });
  const change = (id: number): ChangeRow => ({ ...s.row(id), path: s.path(id), prev: st[id] & CMP_MATCHED ? prev[id] : null });
  const path = (id: number) => s.path(id);
  const grew = top(grewIds, id => d[id], lim, path).map(change);
  const shrank = top(shrankIds, id => -d[id], lim, path).map(change);

  // removed: lo más alto de lo que ya no está (sin emparejar, con el padre emparejado), por tamaño
  const remIds: number[] = [];
  for (let j = 1; j < m; j++) if (match[j] < 0 && match[sp[j]] >= 0) remIds.push(j);
  const snapPath = (j: number) => {
    const parts: string[] = [];
    for (let k = j; k > 0; k = sp[k]) parts.push(sn[k]);
    const r = sn[0];
    return parts.length ? r + (r.endsWith('\\') ? '' : '\\') + parts.reverse().join('\\') : r;
  };
  const removed: RemovedRow[] = top(remIds, j => ss[j], lim, snapPath).map(j => ({ path: snapPath(j), isDir: sd[j] === 1, size: ss[j] }));

  return {
    entry,
    before: { bytes: ss[0], files: snap.rootFiles, dirs: snap.rootDirs },
    after: { bytes: sz[root], files: s.nf[root], dirs: s.nd[root] },
    grew, shrank, removed,
  };
}

/**
 * Los `limit` mayores según `key`; a igualdad, por ruta sin distinguir mayúsculas (y después tal cual). Sólo se
 * calculan las rutas de los que pueden entrar (los que superan el corte y los empatados con él).
 */
function top(ids: number[], key: (i: number) => number, limit: number, pathOf: (i: number) => string): number[] {
  let list = ids;
  if (list.length > limit) {
    const keys = Float64Array.from(list, key).sort(); // ascendente
    const cut = keys[keys.length - limit];
    list = list.filter(i => key(i) >= cut);
  }
  const p = new Map<number, [string, string]>();
  for (const i of list) { const x = pathOf(i); p.set(i, [x.toLowerCase(), x]); }
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  list.sort((a, b) => {
    const x = key(b) - key(a);
    if (x) return x;
    const pa = p.get(a)!, pb = p.get(b)!;
    return cmp(pa[0], pb[0]) || cmp(pa[1], pb[1]);
  });
  return list.slice(0, limit);
}

// ---------- exportación ----------
// rutas, comodines y caracteres de control (categoría Cc de Unicode, como char::is_control en Rust)
const BAD_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f-\x9f]/;

/** Nombre válido para exportar: no vacío, ≤ 200 unidades UTF-16, sin rutas ni caracteres prohibidos, ni `.` ni `..`. */
export function validExportName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= EXPORT_MAX_NAME && !BAD_CHARS.test(name)
    && name !== '.' && name !== '..';
}

/** Base64 estricto (alfabeto estándar, relleno canónico; se ignoran los espacios), como el motor Rust. */
function decodeBase64(text: string): Buffer {
  const clean = text.replace(/[\t\n\f\r ]/g, '');
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.toString('base64') !== clean) throw new Error('Invalid base64 data');
  return bytes;
}

/**
 * Guarda un archivo en la carpeta de exportación; si el nombre existe, añade « (2)», « (3)»… antes de la
 * extensión. `data` es texto (UTF-8) o, con `base64`, bytes en base64.
 */
export function exportFile(name: unknown, data: unknown, base64: boolean, dir = exportDir()): ExportResult {
  if (!validExportName(name)) throw engineError('export.invalidName', { name: String(name ?? '') });
  const text = typeof data === 'string' ? data : String(data ?? '');
  let bytes: Buffer;
  try { bytes = base64 ? decodeBase64(text) : Buffer.from(text, 'utf8'); } catch (e) { throw engineError('export.failed', { error: errorText(e) }); }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let created: string | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 1; k < 100000; k++) {
      const file = join(dir, k === 1 ? name : `${stem} (${k})${ext}`);
      try {
        const fd = fs.openSync(file, 'wx');
        created = file;
        try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
        created = null;
        return { path: file };
      } catch (e) {
        if (!created && errno(e) === 'EEXIST') continue;
        throw e;
      }
    }
    throw new Error('too many files with that name');
  } catch (e) {
    if (created) try { fs.unlinkSync(created); } catch { /* da igual */ }
    throw engineError('export.failed', { error: errorText(e) });
  }
}

/**
 * Ruta de un archivo exportado lista para mostrar: absoluta, sin `..`, dentro de la carpeta de exportación (sin
 * distinguir mayúsculas, con separador) y existente como archivo. Si no, export.notFound.
 */
export function exportedFile(path: unknown, dir = exportDir()): string {
  const notFound = () => engineError('export.notFound', { path: String(path ?? '') });
  if (typeof path !== 'string' || !path.trim() || !winPath.isAbsolute(path) || path.includes('\0')) throw notFound();
  if (path.split(/[\\/]/).includes('..')) throw notFound();
  const full = winPath.resolve(path), base = winPath.resolve(dir);
  const prefix = (base.endsWith('\\') ? base : base + '\\').toLowerCase();
  if (!full.toLowerCase().startsWith(prefix) || full.length <= prefix.length) throw notFound();
  if (!isFile(full)) throw notFound();
  return full;
}
