// Liberar espacio de OneDrive (u otro proveedor de archivos en la nube) sin borrar nada: los archivos descargados
// pasan a «sólo en línea» (attrib +U -P, lo que hace «Liberar espacio» del Explorador) y el proveedor los vacía
// después, en segundo plano; siguen en la nube y vuelven a bajar al abrirlos. El árbol no se toca: la interfaz
// vuelve a escanear la carpeta pasados unos segundos.
import { FLAG, type ActionResult } from '../../protocol/src/index.ts';
import { extendedPath } from './dup.ts';
import { msg } from './messages.ts';
import { DEAD, type Store } from './store.ts';
import { ATTR, INVALID_FILE_ATTRIBUTES, kernel32, lastError, winErrorText, wstr } from './win32.ts';

/** Atributos que SetFileAttributesW acepta y que se conservan; los demás (carpeta, reparse, comprimido…) no se pasan. */
export const FREE_UP_SETTABLE = ATTR.READONLY | ATTR.HIDDEN | ATTR.SYSTEM | ATTR.ARCHIVE | ATTR.TEMPORARY | ATTR.OFFLINE
  | ATTR.NOT_CONTENT_INDEXED | ATTR.PINNED | ATTR.UNPINNED;

/**
 * Atributos que dejan un elemento «sólo en línea»: los ajustables, sin PINNED y con UNPINNED.
 * null si ya lo está (OFFLINE o RECALL_ON_DATA_ACCESS): se salta.
 */
export function freeUpAttrs(attrs: number): number | null {
  if (attrs & (ATTR.OFFLINE | ATTR.RECALL_ON_DATA_ACCESS)) return null;
  return ((attrs & FREE_UP_SETTABLE & ~ATTR.PINNED) | ATTR.UNPINNED) >>> 0;
}

/**
 * Candidatos de `id` y sus descendientes vivos con FLAG.CLOUD: archivos descargados (alloc > 0) y carpetas (se
 * marcan para que lo nuevo que llegue quede también «sólo en línea», pero no cuentan). Orden: preorden.
 */
export function freeUpCandidates(s: Store, id: number): { files: number[]; dirs: number[] } {
  const files: number[] = [], dirs: number[] = [];
  s.forEach(id, x => {
    const f = s.fl[x];
    if ((f & DEAD) || !(f & FLAG.CLOUD)) return;
    if (f & FLAG.DIR) dirs.push(x);
    else if (s.al[x] > 0) files.push(x);
  });
  return { files, dirs };
}

/** Lectura y escritura de atributos; las pruebas la sustituyen (nunca tocan archivos de la nube reales). */
export interface AttrIo {
  /** Atributos del elemento o, si falla, el texto del error del sistema. */
  get(path: string): number | string;
  /** null si fue bien; si no, el texto del error del sistema. */
  set(path: string, attrs: number): string | null;
}

/** Con la ruta exacta (\\?\): rutas largas y nombres que Win32 retocaría (punto o espacio final). */
export const win32AttrIo: AttrIo = {
  get(path) {
    const a = kernel32().GetFileAttributesW(wstr(extendedPath(path)));
    return a === INVALID_FILE_ATTRIBUTES ? winErrorText(lastError()) : a;
  },
  set(path, attrs) {
    return kernel32().SetFileAttributesW(wstr(extendedPath(path)), attrs) ? null : winErrorText(lastError());
  },
};

/** true si pasó a «sólo en línea», false si ya lo estaba, o el texto del error. */
function makeOnlineOnly(io: AttrIo, path: string): boolean | string {
  const a = io.get(path);
  if (typeof a === 'string') return a;
  const next = freeUpAttrs(a);
  return next === null ? false : io.set(path, next) ?? true;
}

/**
 * action('freeUp', id) sobre un archivo o una carpeta (la raíz también). Primero los archivos y después las carpetas:
 * así marcar una carpeta no hace que el proveedor se adelante y el recuento sale exacto. Sin archivos descargados no
 * se toca nada. Resultado: action.freedUp {count, bytes} (bytes = alloc de los archivos cambiados, lo que se
 * liberará), action.nothingToFree o, si todo falló, action.failed con el primer error.
 */
export function freeUp(s: Store, id: number, io: AttrIo = win32AttrIo): ActionResult {
  const { files, dirs } = freeUpCandidates(s, id);
  if (!files.length) return { ok: false, ...msg('action.nothingToFree') };
  let count = 0, bytes = 0, error = '';
  for (const f of files) {
    const r = makeOnlineOnly(io, s.path(f));
    if (r === true) { count++; bytes += s.al[f]; } else if (r && !error) error = r;
  }
  for (const d of dirs) {
    const r = makeOnlineOnly(io, s.path(d));
    if (typeof r === 'string' && !error) error = r;
  }
  if (count) return { ok: true, ...msg('action.freedUp', { count, bytes }) };
  if (error) return { ok: false, ...msg('action.failed', { error }) };
  return { ok: false, ...msg('action.nothingToFree') }; // los descargados ya no lo estaban
}
