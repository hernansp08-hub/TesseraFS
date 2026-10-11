// Enlaces rotos (Backend.brokenLinks): enlaces simbólicos, uniones (junctions) y carpetas montadas bajo una carpeta
// del árbol cuyo destino ya no existe. Mismas reglas que el motor Rust (crates/tessera-core/src/links.rs):
//  - candidatos: nodos vivos bajo `root` (incluido) con FLAG.REPARSE;
//  - la etiqueta se vuelve a leer de la carpeta que los contiene (FindFirstFileExW → dwReserved0, sin abrir el
//    enlace) y sólo cuentan los enlaces simbólicos y las uniones o puntos de montaje (checksTag);
//  - roto = abrirlo siguiendo el enlace (CreateFileW con FILE_FLAG_BACKUP_SEMANTICS y acceso 0) falla con
//    ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND o ERROR_CANT_RESOLVE_FILENAME (bucle); cualquier otro error (acceso
//    denegado, red caída…) no permite saberlo y no se informa.
// No cambia ni el árbol ni el disco.
import { FLAG, type SearchResponse, type SearchRow } from '../../protocol/src/index.ts';
import { extendedPath } from './dup.ts';
import type { Store } from './store.ts';
import { ATTR, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_ALL, INVALID_HANDLE, OPEN_EXISTING, kernel32, lastError, wstr } from './win32.ts';

/** Comprobaciones como mucho por petición: con más candidatos se miran los primeros y se avisa en el registro. */
export const LINK_MAX_CHECKS = 200_000;
export const REPARSE_TAG_MOUNT_POINT = 0xA0000003, REPARSE_TAG_SYMLINK = 0xA000000C;
/** Enlace simbólico de WSL: Windows no lo sigue, así que no se comprueba. */
export const REPARSE_TAG_LX_SYMLINK = 0xA000001D;

/**
 * Etiquetas que se comprueban: las que sustituyen un nombre (bit 29) y Windows resuelve como enlace, es decir, enlaces
 * simbólicos y uniones o puntos de montaje. Fuera quedan las demás: enlaces de WSL, las de contenedores, la nube,
 * WOF, deduplicación y alias de aplicaciones (APPEXECLINK).
 */
export function checksTag(tag: number): boolean {
  const t = tag >>> 0;
  return (t & 0x20000000) !== 0 && (t === REPARSE_TAG_SYMLINK || t === REPARSE_TAG_MOUNT_POINT);
}

const ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3, ERROR_CANT_RESOLVE_FILENAME = 1921;
/** Error al seguir el enlace que dice que el destino no existe (o que es un bucle). */
export const isBrokenError = (code: number) => code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND || code === ERROR_CANT_RESOLVE_FILENAME;

/** WIN32_FIND_DATAW: atributos en 0 y, si es un punto de reanálisis, la etiqueta en dwReserved0 (36). */
const FIND_DATA_SIZE = 592;

/** Atributos y etiqueta de reparse según la carpeta que lo contiene (no abre el enlace); null si no está. */
export function findData(path: string): { attrs: number; tag: number } | null {
  const k = kernel32(), fd = new Uint8Array(FIND_DATA_SIZE);
  const h = k.FindFirstFileExW(wstr(extendedPath(path)), 1 /* FindExInfoBasic */, fd, 0 /* FindExSearchNameMatch */, null, 0);
  if (h === INVALID_HANDLE) return null;
  k.FindClose(h);
  const dv = new DataView(fd.buffer);
  return { attrs: dv.getUint32(0, true), tag: dv.getUint32(36, true) };
}

/** ¿Es `path` un enlace (según checksTag) cuyo destino ya no existe? Se mira ahora en el disco. */
export function isBrokenLink(path: string): boolean {
  const fd = findData(path);
  if (!fd || !(fd.attrs & ATTR.REPARSE) || !checksTag(fd.tag)) return false;
  const k = kernel32();
  const h = k.CreateFileW(wstr(extendedPath(path)), 0, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, 0n);
  if (h !== INVALID_HANDLE) { k.CloseHandle(h); return false; }
  return isBrokenError(lastError());
}

/** Clave de orden por ruta: sin distinguir mayúsculas y por componentes (el separador va antes que cualquier carácter). */
const pathKey = (p: string) => p.toLowerCase().replaceAll('\\', '\0');

export interface BrokenLinksOptions {
  /** Registro de diagnóstico (en inglés). */
  log?: (line: string) => void;
  /** Lanza un EngineError si el árbol ya no es el mismo (otro escaneo); se llama tras cada pausa. */
  verify?: () => void;
  /** Comprobación de cada ruta (pruebas); por defecto, isBrokenLink. */
  isBroken?: (path: string) => boolean;
  /** Cada cuántas comprobaciones se cede el hilo para que el servidor siga respondiendo. */
  yieldEvery?: number;
}

/**
 * Enlaces rotos bajo `root`: `total` = todos, `totalBytes` = suma de `size`, `rows` = los `limit` primeros por ruta
 * (filas SearchRow). Lo que se envía a la papelera o se vuelve a escanear mientras tanto ya no sale.
 */
export async function brokenLinks(s: Store, root: number, limit: number, opts: BrokenLinksOptions = {}): Promise<SearchResponse> {
  const isBroken = opts.isBroken ?? isBrokenLink, every = Math.max(1, opts.yieldEvery ?? 128);
  const cands: number[] = [];
  let seen = 0;
  s.forEach(root, id => {
    if (!(s.fl[id] & FLAG.REPARSE)) return;
    seen++;
    if (cands.length < LINK_MAX_CHECKS) cands.push(id);
  });
  if (seen > LINK_MAX_CHECKS) opts.log?.(`brokenLinks: ${seen} links under ${s.path(root)}; only the first ${LINK_MAX_CHECKS} were checked`);
  const broken: number[] = [];
  for (let i = 0; i < cands.length; i++) {
    if (i && i % every === 0) { await new Promise(r => setImmediate(r)); opts.verify?.(); }
    const id = cands[i];
    if (s.has(id) && isBroken(s.path(id))) broken.push(id);
  }
  opts.verify?.();
  const hits = broken.filter(id => s.has(id)).map(id => { const path = s.path(id); return { id, path, key: pathKey(path) }; });
  hits.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : a.id - b.id);
  let totalBytes = 0;
  for (const h of hits) totalBytes += s.sz[h.id];
  const k = Math.max(0, Math.min(limit | 0, 100000));
  const rows: SearchRow[] = hits.slice(0, k).map(h => ({ ...s.row(h.id), path: h.path }));
  return { total: hits.length, totalBytes, rows };
}
