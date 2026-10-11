// Carpeta pedida al abrir la edición portable (SystemInfo.launchPath): `TesseraFS.cmd "C:\carpeta"` (o `"C:\"` para
// una unidad). Mismas reglas que el motor Rust (crates/tessera-core/src/launch.rs).
import { statSync } from 'node:fs';
import { win32 as winPath } from 'node:path';
import { normalizePath } from './engine.ts';

/**
 * Quita las comillas sueltas de un argumento: `"C:\"` llega como `C:"` (la barra invertida escapa la comilla) y
 * `"C:\dir\" --x` como un único `C:\dir" --x`; se queda lo que hay antes de la primera comilla (las rutas de Windows
 * no pueden llevarlas).
 */
export function stripQuotes(arg: string): string {
  const s = arg.trim().replace(/^"+/, '');
  const i = s.indexOf('"');
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

/**
 * El primer argumento posicional (no empieza por `-`), normalizado como la ruta de un escaneo (normalizePath: `C:` →
 * `C:\`, sin barra final salvo en la raíz); una ruta relativa, respecto a `cwd`. No mira el disco; null si no hay.
 */
export function launchArg(args: readonly string[], cwd = process.cwd()): string | null {
  const a = args.find(x => !x.trimStart().startsWith('-'));
  if (a === undefined) return null;
  let s = stripQuotes(a).replace(/\//g, '\\');
  if (!s) return null;
  if (!/^[a-zA-Z]:(\\|$)/.test(s) && !s.startsWith('\\\\')) s = winPath.resolve(cwd, s);
  try { return normalizePath(s); } catch { return null; }
}

/** launchArg si existe y es una carpeta (o una unidad; siguiendo enlaces); si no, null y se ignora. */
export function launchPath(args: readonly string[], cwd = process.cwd()): string | null {
  const p = launchArg(args, cwd);
  if (!p) return null;
  try { return statSync(p, { throwIfNoEntry: false })?.isDirectory() ? p : null; } catch { return null; }
}

/**
 * Un argumento entre comillas para la línea de órdenes de Windows (reglas de CommandLineToArgvW): las barras
 * invertidas antes de una comilla o del final se duplican, así `C:\` llega entero.
 */
export function quoteArg(s: string): string {
  let out = '"', slashes = 0;
  for (const c of s) {
    if (c === '\\') { slashes++; continue; }
    out += c === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + c;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}
