// Sistema donde corre el motor y las rutas que dependen de él: separador, mayúsculas y forma de la raíz.
// Hasta que el motor responde se supone Windows (la portable y la demo lo son).
import type { ActionKind, SystemInfo, VolumeInfo } from '@tessera/protocol';
import { GLOBAL_PARAMS } from '@tessera/i18n';

export const SYS: SystemInfo = { os: 'windows', sep: '\\', actions: ['open', 'reveal', 'properties', 'trash', 'freeUp'] };

/** Fija el sistema y el parámetro `os` de los textos (`{os, select, windows {…} other {…}}`). */
export function setSystem(s: SystemInfo) {
  Object.assign(SYS, s);
  GLOBAL_PARAMS.os = s.os;
}
/** La acción existe en este sistema (en Linux no hay Propiedades ni «Liberar espacio» de OneDrive). */
export const can = (a: ActionKind) => SYS.actions.includes(a);
const win = () => SYS.sep === '\\';

/** Sin separador final, salvo en una raíz («C:\», «/»). */
export function trimSep(p: string): string {
  const s = SYS.sep;
  let e = p.length; while (e > 1 && p[e - 1] === s) e--;
  const t = p.slice(0, e);
  return win() && /^[A-Za-z]:$/.test(t) ? t + s : t;
}
export const joinPath = (base: string, name: string) => base.endsWith(SYS.sep) ? base + name : base + SYS.sep + name;
/** Carpeta que contiene la ruta («C:\» y «/» son su propia carpeta). */
export function parentPath(p: string): string {
  const t = trimSep(p), i = t.lastIndexOf(SYS.sep);
  if (win()) return i > 2 ? t.slice(0, i) : t.slice(0, 3);
  return i > 0 ? t.slice(0, i) : '/';
}
/** Último componente; la raíz se devuelve tal cual. */
export const baseName = (p: string) => { const t = trimSep(p); return t.slice(t.lastIndexOf(SYS.sep) + 1) || t; };
/** Para comparar rutas: en Windows sin distinguir mayúsculas; en Linux tal cual. */
export const pathKey = (p: string) => { const t = trimSep(p); return win() ? t.toLowerCase() : t; };
/** `p` es `dir` o está dentro de ella. */
export function isUnder(p: string, dir: string): boolean {
  const a = pathKey(p), b = pathKey(dir);
  return a === b || a.startsWith(b.endsWith(SYS.sep) ? b : b + SYS.sep);
}
/** Ruta de ejemplo para el campo «Analizar una carpeta». */
export const folderHint = () => win() ? 'C:\\Users\\…' : '/home/…';
/** Lo que identifica una unidad en poco espacio: «C:» en Windows; el punto de montaje en Linux («/», «/home»). */
export const volTag = (v: VolumeInfo) => win() ? v.path.slice(0, 2) : trimSep(v.path);
/** La unidad del sistema: C: en Windows, «/» en Linux. */
export const isSystemVolume = (v: VolumeInfo) => win() ? /^C:/i.test(v.path) : v.path === '/';
