// Escaneo guardado (.tessera): el árbol cargado COMPLETO en un archivo, para abrirlo después en otro equipo o en otro
// momento. Formato común a las dos ediciones (docs/ARQUITECTURA.md › Escaneo guardado), versión 1: gzip de
//   {"v":1,"kind":"tesserafs-scan","app":…,"host":…,"path":…,"scannedAt":…,"engine":…,"volume":{…}|null,
//    "nodes":[[parent,name,isDir,size,alloc,files,dirs,mtime,flags],…]}
// con las claves en ese orden (`app` y `host`, sólo si se saben). Los nodos van en preorden: nodes[0] es la raíz
// (parent −1, name = la ruta raíz), cada nodo después de su padre y los hijos de una carpeta en el orden del árbol
// (tamaño desc). `flags` lleva sólo las banderas públicas (el byte bajo de FLAG), nunca bits internos como DEAD; `ext`
// no se guarda: se deriva del nombre como al escanear. Un nombre con suplentes sueltos (posible en Windows) se escribe
// como `\udXXX` (lo que hace JSON.stringify, igual que el motor Rust) y se lee tal cual.
// Al abrir, como el motor Rust: las carpetas toman los totales de lo que contienen (como al escanear; sus columnas
// size/alloc/files/dirs no se usan), la raíz se llama como `path`, `flags` puede faltar y lo que sobre se ignora.
import { hostname } from 'node:os';
import * as zlib from 'node:zlib';
import { FLAG, type Engine, type ExportResult, type VolumeInfo } from '../../protocol/src/index.ts';
import { version as APP_VERSION } from '../package.json';
import { exportDir, validExportName, wellFormed, writeExport } from './history.ts';
import { EngineError, engineError, errorText } from './messages.ts';
import { NONE, Store } from './store.ts';

export { APP_VERSION };
export const TESSERA_VERSION = 1;
export const TESSERA_KIND = 'tesserafs-scan';
export const TESSERA_EXT = '.tessera';
/** Archivo (cuerpo de POST /api/scan/open), JSON descomprimido y nodos: límites para no agotar la memoria. */
export const TESSERA_MAX_FILE = 2 ** 30;
export const TESSERA_MAX_JSON = 2 ** 30;
export const TESSERA_MAX_NODES = 50_000_000;

/** Cabecera de un escaneo guardado (todo lo que no es el árbol). */
export interface TesseraMeta {
  /** Versión de TesseraFS que lo guardó. */
  app?: string;
  /** Nombre del equipo donde se escaneó. */
  host?: string;
  scannedAt: number;
  engine: Engine;
  volume: VolumeInfo | null;
}

/** Escaneo guardado ya leído: el árbol (cerrado, con sus listas de hijos) y la cabecera. */
export interface TesseraFile extends TesseraMeta {
  path: string;
  store: Store;
}

/** Nombre del equipo, como el motor Rust en Windows: %COMPUTERNAME% (o el de os.hostname()). */
export function hostName(): string | undefined {
  return process.env.COMPUTERNAME || hostname() || undefined;
}

// ---------- escritura ----------
const RESERVED = '\\/:*?"<>|';
const pad = (x: number, n = 2) => String(x).padStart(n, '0');

/**
 * Lo que da nombre al archivo (como root_label del motor Rust): la letra en una unidad de Windows («C»), el último
 * componente en una carpeta («Datos», «share» en \\srv\share), «raiz» en «/»; los caracteres reservados y de
 * control pasan a «_», sin punto ni espacio final y como mucho 100 unidades UTF-16 (sin partir un carácter).
 */
export function savedScanLabel(rootPath: string): string {
  const p = wellFormed(rootPath).replace(/[\\/]+$/, '');
  const base = /^[A-Za-z]:$/.test(p) ? p[0].toUpperCase() : p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
  let out = '', units = 0;
  for (const ch of base) {
    units += ch.length;
    if (units > 100) break;
    out += ch < ' ' || ch === '\x7f' || RESERVED.includes(ch) ? '_' : ch;
  }
  return out.replace(/[. ]+$/, '') || 'raiz';
}

/**
 * `<raíz> <AAAA-MM-DD HHMM>.tessera` con la fecha local del escaneo (savedScanLabel). Si aun así no es un nombre
 * válido para exportar (p. ej. con caracteres de control C1), «raiz <fecha>.tessera», como el motor Rust.
 */
export function savedScanName(rootPath: string, scannedAt: number): string {
  const d = new Date(scannedAt * 1000);
  const tail = ` ${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${TESSERA_EXT}`;
  const name = savedScanLabel(rootPath) + tail;
  return validExportName(name) ? name : 'raiz' + tail;
}

const tooLargeToSave = () => engineError('export.failed', { error: `the scan is too large to save (more than ${TESSERA_MAX_JSON} bytes of data)` });

/** Nivel de gzip: con 3, unas 2,4 veces más rápido que el 6 por defecto y apenas un 5 % más grande. */
export const TESSERA_GZIP_LEVEL = 3;
const HEX = '0123456789abcdef';
const enc = new TextEncoder();

/**
 * JSON en bytes UTF-8, escrito directamente en un búfer que crece (sin una cadena por nodo: unas 3 veces más rápido
 * que componer el texto). Los escapes son los de JSON.stringify y serde_json: \" \\ \b \t \n \f \r, el resto de
 * controles como \u00xx y los suplentes sueltos como \udxxx (hexadecimal en minúsculas).
 */
class JsonBytes {
  buf: Uint8Array;
  o = 0;
  constructor(cap: number) { this.buf = new Uint8Array(Math.max(4096, Math.min(cap, TESSERA_MAX_JSON + (1 << 20)))); }

  /** Sitio para `k` bytes más. */
  need(k: number) {
    if (this.o + k <= this.buf.length) return;
    if (this.o > TESSERA_MAX_JSON) throw tooLargeToSave();
    const b = new Uint8Array(Math.max(this.o + k, Math.floor(this.buf.length * 1.5)));
    b.set(this.buf.subarray(0, this.o));
    this.buf = b;
  }

  /** Texto ya en JSON (cabecera): tal cual, en UTF-8. */
  text(t: string) {
    this.need(t.length * 3);
    this.o += enc.encodeInto(t, this.buf.subarray(this.o)).written;
  }

  byte(c: number) { this.buf[this.o++] = c; }

  /** Entero ≥ 0 sin pasar por cadenas (lo demás, con String: no ocurre con lo que guarda un Store). */
  num(x: number) {
    const b = this.buf;
    if (!(x >= 0 && Number.isSafeInteger(x))) { const t = String(x); for (let i = 0; i < t.length; i++) b[this.o++] = t.charCodeAt(i); return; }
    if (x === 0) { b[this.o++] = 48; return; }
    let a = this.o, v = x;
    if (v < 2147483648) while (v > 0) { const q = (v / 10) | 0; b[this.o++] = 48 + (v - q * 10); v = q; }
    else while (v > 0) { const q = Math.floor(v / 10); b[this.o++] = 48 + (v - q * 10); v = q; } // (sin pasar de 2^53)
    for (let z = this.o - 1; a < z; a++, z--) { const c = b[a]; b[a] = b[z]; b[z] = c; }
  }

  /** Cadena JSON de las unidades UTF-16 [off, off+len) de `u`. */
  str(u: ArrayLike<number>, off: number, len: number) {
    this.need(len * 6 + 2);
    const b = this.buf, end = off + len;
    let o = this.o;
    b[o++] = 34;
    for (let i = off; i < end; i++) {
      const c = u[i];
      if (c < 0x80) {
        if (c >= 0x20) { if (c === 34 || c === 92) b[o++] = 92; b[o++] = c; }
        else if (c === 8) { b[o++] = 92; b[o++] = 98; }
        else if (c === 9) { b[o++] = 92; b[o++] = 116; }
        else if (c === 10) { b[o++] = 92; b[o++] = 110; }
        else if (c === 12) { b[o++] = 92; b[o++] = 102; }
        else if (c === 13) { b[o++] = 92; b[o++] = 114; }
        else { b[o++] = 92; b[o++] = 117; b[o++] = 48; b[o++] = 48; b[o++] = HEX.charCodeAt(c >> 4); b[o++] = HEX.charCodeAt(c & 15); }
      } else if (c < 0x800) {
        b[o++] = 0xC0 | (c >> 6); b[o++] = 0x80 | (c & 0x3F);
      } else if (c >= 0xD800 && c <= 0xDFFF) {
        const d = i + 1 < end ? u[i + 1] : 0;
        if (c <= 0xDBFF && d >= 0xDC00 && d <= 0xDFFF) {
          const cp = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
          b[o++] = 0xF0 | (cp >> 18); b[o++] = 0x80 | ((cp >> 12) & 0x3F); b[o++] = 0x80 | ((cp >> 6) & 0x3F); b[o++] = 0x80 | (cp & 0x3F);
          i++;
        } else { // suplente suelto
          b[o++] = 92; b[o++] = 117;
          for (let s = 12; s >= 0; s -= 4) b[o++] = HEX.charCodeAt((c >> s) & 15);
        }
      } else {
        b[o++] = 0xE0 | (c >> 12); b[o++] = 0x80 | ((c >> 6) & 0x3F); b[o++] = 0x80 | (c & 0x3F);
      }
    }
    b[o++] = 34;
    this.o = o;
  }
}

/** VolumeInfo con las claves del contrato en su orden (y sólo esas). */
function volumeJson(v: VolumeInfo | null): string {
  if (!v) return 'null';
  return JSON.stringify({ path: wellFormed(v.path), label: wellFormed(v.label), fs: wellFormed(v.fs), total: v.total, free: v.free, clusterSize: v.clusterSize });
}

/** El JSON (sin comprimir, UTF-8) del árbol cargado: lo que va dentro del gzip. */
export function tesseraJson(s: Store, meta: TesseraMeta): Uint8Array {
  const root = s.rootId, sz = s.sz, al = s.al, nf = s.nf, nd = s.nd, mt = s.mt, fl = s.fl, par = s.par;
  const names = s.names, nOff = s.nOff, nLen = s.nLen;
  const out = new JsonBytes(s.n * 48 + s.namesLen * 2 + 4096);
  let head = `{"v":${TESSERA_VERSION},"kind":"${TESSERA_KIND}"`;
  if (meta.app) head += `,"app":${JSON.stringify(wellFormed(meta.app))}`;
  if (meta.host) head += `,"host":${JSON.stringify(wellFormed(meta.host))}`;
  head += `,"path":${JSON.stringify(wellFormed(s.rootPath))},"scannedAt":${Math.floor(meta.scannedAt)},"engine":${JSON.stringify(meta.engine)},`
    + `"volume":${volumeJson(meta.volume)},"nodes":[[-1,${JSON.stringify(wellFormed(s.rootPath))}`;
  out.text(head);
  // índice de cada id en el archivo (preorden); lo enviado a la papelera o muerto en un rescan ya no cuelga del árbol
  const at = new Int32Array(s.n);
  let k = 0;
  s.forEach(root, id => {
    at[id] = k;
    if (id !== root) {
      out.need(16);
      out.byte(44); out.byte(91); out.num(at[par[id]]); out.byte(44);
      out.str(names, nOff[id], nLen[id]);
    }
    out.need(120); // 7 números (≤ 16 cifras) y separadores
    out.byte(44); out.byte(fl[id] & FLAG.DIR ? 49 : 48);
    out.byte(44); out.num(sz[id]); out.byte(44); out.num(al[id]); out.byte(44); out.num(nf[id]); out.byte(44); out.num(nd[id]);
    out.byte(44); out.num(mt[id]); out.byte(44); out.num(fl[id] & 0xFF); out.byte(93);
    k++;
  });
  out.text(']}');
  if (out.o > TESSERA_MAX_JSON) throw tooLargeToSave();
  return out.buf.subarray(0, out.o);
}

/** El archivo .tessera (gzip del JSON) del árbol cargado. */
export function encodeTessera(s: Store, meta: TesseraMeta): Uint8Array {
  return Bun.gzipSync(tesseraJson(s, meta), { level: TESSERA_GZIP_LEVEL });
}

/**
 * Guarda el árbol cargado en la carpeta de exportación como `<raíz> <fecha>.tessera` (si existe, « (2)»…).
 * Errores: export.failed.
 */
export function saveScanFile(s: Store, meta: TesseraMeta, dir = exportDir()): ExportResult {
  let gz: Uint8Array;
  try { gz = encodeTessera(s, meta); } catch (e) {
    throw e instanceof EngineError ? e : engineError('export.failed', { error: errorText(e) });
  }
  return writeExport(savedScanName(s.rootPath, meta.scannedAt), gz, dir);
}

// ---------- lectura ----------
export interface TesseraLimits { maxFile?: number; maxJson?: number; maxNodes?: number }

/**
 * Lee un .tessera: descomprime con límite y analiza el JSON byte a byte, escribiendo los nodos directamente en las
 * columnas de un Store (sin un arreglo de JS por nodo). Cualquier problema → scan.openFailed {error} (en inglés).
 */
export function decodeTessera(data: Uint8Array, limits: TesseraLimits = {}): TesseraFile {
  try {
    const maxFile = limits.maxFile ?? TESSERA_MAX_FILE;
    if (data.byteLength > maxFile) throw new Error(`the file is too large (more than ${maxFile} bytes)`);
    const json = gunzip(data, limits.maxJson ?? TESSERA_MAX_JSON);
    return new TesseraParser(json, limits.maxNodes ?? TESSERA_MAX_NODES).file();
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw engineError('scan.openFailed', { error: errorText(e) });
  }
}

function gunzip(data: Uint8Array, max: number): Uint8Array {
  if (data.byteLength < 18 || data[0] !== 0x1f || data[1] !== 0x8b) throw new Error('not a gzip file');
  try {
    const out = zlib.gunzipSync(data, { maxOutputLength: max });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength); // (un Uint8Array a secas se lee más rápido que un Buffer)
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`too much data (more than ${max} bytes uncompressed)`);
    throw new Error(`invalid gzip data (${errorText(e)})`);
  }
}

const NOT_OURS = 'not a TesseraFS saved scan';
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Entero ≥ 0 (lo negativo, 0; los decimales se truncan), como `uint` en el motor Rust. */
const uint = (x: number) => x > 0 ? Math.floor(x) : 0;
const u32 = (x: number) => Math.min(uint(x), 0xFFFFFFFF);

/** Analizador de JSON sobre bytes UTF-8, para la forma exacta del formato (y cualquier orden de claves). */
class TesseraParser {
  private i = 0;
  private readonly n: number;
  private scratch = new Uint16Array(256);

  constructor(private readonly b: Uint8Array, private readonly maxNodes: number) { this.n = b.length; }

  private fail(what: string): never { throw new Error(`${what} at byte ${this.i}`); }

  /** Salta espacios; devuelve el siguiente byte (−1 al final). */
  private ws(): number {
    const b = this.b, n = this.n;
    let i = this.i;
    while (i < n) { const c = b[i]; if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break; i++; }
    this.i = i;
    return i < n ? b[i] : -1;
  }

  private eat(c: number) {
    if (this.ws() !== c) this.fail(`expected '${String.fromCharCode(c)}'`);
    this.i++;
  }

  private lit(word: string) {
    for (let k = 0; k < word.length; k++) if (this.b[this.i + k] !== word.charCodeAt(k)) this.fail('invalid JSON');
    this.i += word.length;
  }

  /** Número JSON (tras ws). Enteros de hasta 15 cifras sin pasar por cadenas. */
  private number(): number {
    const b = this.b, n = this.n, s = this.i;
    let j = s;
    if (b[j] === 0x2d) j++;
    const d0 = j;
    while (j < n && b[j] >= 0x30 && b[j] <= 0x39) j++;
    if (j === d0) this.fail('invalid JSON');
    let simple = j - d0 <= 15;
    if (j < n && (b[j] === 0x2e || b[j] === 0x65 || b[j] === 0x45)) {
      simple = false;
      while (j < n) { const c = b[j]; if ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x65 || c === 0x45 || c === 0x2b || c === 0x2d) j++; else break; }
    }
    this.i = j;
    if (simple) {
      let v = 0;
      for (let k = d0; k < j; k++) v = v * 10 + (b[k] - 0x30);
      return d0 > s ? -v : v;
    }
    const v = Number(String.fromCharCode.apply(null, b.subarray(s, j) as unknown as number[]));
    if (!Number.isFinite(v)) this.fail('invalid number');
    return v;
  }

  private num(): number { this.ws(); return this.number(); }

  /** Con this.i tras la comilla inicial: posición de la comilla final. */
  private stringEnd(): number {
    const b = this.b, n = this.n;
    for (let j = this.i; j < n;) {
      const c = b[j];
      if (c === 0x22) return j;
      j += c === 0x5c ? 2 : 1;
    }
    this.fail('unterminated string');
  }

  /**
   * Decodifica la cadena [this.i, end) a unidades UTF-16 en `t` desde `at` (caben: nunca hay más unidades que bytes)
   * y deja this.i tras la comilla final. Devuelve cuántas unidades escribió. Admite WTF-8 (suplentes sueltos, como
   * los guarda el motor Rust); lo demás que no es UTF-8 válido → U+FFFD.
   */
  private units(t: Uint16Array, at: number, end: number): number {
    const b = this.b;
    let o = at, j = this.i;
    const cont = (x: number) => (x & 0xC0) === 0x80;
    while (j < end) {
      const c = b[j];
      if (c < 0x80) {
        if (c === 0x5c) {
          const e = b[j + 1];
          switch (e) {
            case 0x22: case 0x5c: case 0x2f: t[o++] = e; j += 2; break;
            case 0x62: t[o++] = 8; j += 2; break;
            case 0x66: t[o++] = 12; j += 2; break;
            case 0x6e: t[o++] = 10; j += 2; break;
            case 0x72: t[o++] = 13; j += 2; break;
            case 0x74: t[o++] = 9; j += 2; break;
            case 0x75: {
              let v = 0;
              for (let k = j + 2; k < j + 6; k++) {
                const h = b[k];
                const d = h >= 0x30 && h <= 0x39 ? h - 0x30 : h >= 0x61 && h <= 0x66 ? h - 0x57 : h >= 0x41 && h <= 0x46 ? h - 0x37 : -1;
                if (d < 0 || k >= end) { this.i = j; this.fail('invalid escape'); }
                v = v * 16 + d;
              }
              t[o++] = v; j += 6; break;
            }
            default: this.i = j; this.fail('invalid escape');
          }
        } else if (c < 0x20) {
          this.i = j; this.fail('control character in string');
        } else { t[o++] = c; j++; }
      } else if (c >= 0xC2 && c <= 0xDF && j + 1 < end && cont(b[j + 1])) {
        t[o++] = ((c & 0x1F) << 6) | (b[j + 1] & 0x3F); j += 2;
      } else if (c >= 0xE0 && c <= 0xEF && j + 2 < end && cont(b[j + 1]) && cont(b[j + 2])) {
        const cp = ((c & 0x0F) << 12) | ((b[j + 1] & 0x3F) << 6) | (b[j + 2] & 0x3F);
        t[o++] = cp >= 0x800 ? cp : 0xFFFD; j += 3;
      } else if (c >= 0xF0 && c <= 0xF4 && j + 3 < end && cont(b[j + 1]) && cont(b[j + 2]) && cont(b[j + 3])) {
        const cp = ((c & 0x07) << 18) | ((b[j + 1] & 0x3F) << 12) | ((b[j + 2] & 0x3F) << 6) | (b[j + 3] & 0x3F);
        if (cp >= 0x10000 && cp <= 0x10FFFF) { t[o++] = 0xD800 + ((cp - 0x10000) >> 10); t[o++] = 0xDC00 + ((cp - 0x10000) & 0x3FF); }
        else t[o++] = 0xFFFD;
        j += 4;
      } else { t[o++] = 0xFFFD; j++; }
    }
    this.i = end + 1;
    return o - at;
  }

  /** Cadena JSON (con this.i en la comilla inicial, tras ws), con los suplentes sueltos tal cual. */
  private string(): string {
    this.i++;
    const end = this.stringEnd();
    if (this.scratch.length < end - this.i) this.scratch = new Uint16Array(end - this.i);
    const t = this.scratch, len = this.units(t, 0, end);
    let s = '';
    for (let k = 0; k < len; k += 8192) s += String.fromCharCode.apply(null, t.subarray(k, Math.min(len, k + 8192)) as unknown as number[]);
    return s;
  }

  /** Cualquier valor JSON (cabecera, volumen y columnas de versiones futuras). */
  private value(depth: number): unknown {
    const c = this.ws();
    if (c === 0x22) return this.string();
    if (c === 0x7b || c === 0x5b) {
      if (depth >= 32) this.fail('too deeply nested');
      this.i++;
      const obj = c === 0x7b, close = obj ? 0x7d : 0x5d;
      const o: Record<string, unknown> = Object.create(null), a: unknown[] = [];
      if (this.ws() === close) { this.i++; return obj ? o : a; }
      for (; ;) {
        if (obj) {
          if (this.ws() !== 0x22) this.fail('expected a key');
          const k = this.string();
          this.eat(0x3a);
          o[k] = this.value(depth + 1);
        } else a.push(this.value(depth + 1));
        const d = this.ws();
        if (d === 0x2c) { this.i++; continue; }
        if (d === close) { this.i++; return obj ? o : a; }
        this.fail('invalid JSON');
      }
    }
    if (c === 0x74) { this.lit('true'); return true; }
    if (c === 0x66) { this.lit('false'); return false; }
    if (c === 0x6e) { this.lit('null'); return null; }
    if (c < 0) this.fail('unexpected end of data');
    return this.number();
  }

  /** El objeto entero. La cabecera puede ir en cualquier orden; `nodes` va directo al almacén. */
  file(): TesseraFile {
    const head = new Map<string, unknown>();
    const st = new Store(1);
    const len = this.n;
    st.ensure(Math.min(this.maxNodes, Math.ceil(len / 64)), true);
    st.ensureNames(Math.ceil(len / 6), true);
    let nodes = false;
    try {
      this.eat(0x7b);
      if (this.ws() === 0x7d) this.i++;
      else for (; ;) {
        if (this.ws() !== 0x22) this.fail('expected a key');
        const k = this.string();
        this.eat(0x3a);
        if (k === 'nodes') {
          if (nodes) this.fail('duplicate "nodes"');
          nodes = true;
          checkHead(head, false); // (v y kind van antes: un archivo ajeno o más nuevo no llega a leerse entero)
          this.nodes(st);
        } else head.set(k, this.value(0));
        const d = this.ws();
        this.i++;
        if (d === 0x2c) continue;
        if (d === 0x7d) break;
        this.i--;
        this.fail("expected ',' or '}'");
      }
      if (this.ws() !== -1) this.fail('unexpected data after the end');
    } catch (e) {
      checkHead(head, true); // un JSON que no es nuestro: mejor decirlo así que «byte N»
      throw e;
    }
    checkHead(head, true);
    const path = head.get('path');
    if (!isText(path)) throw new Error('missing the scanned path');
    if (path.length > 0xFFFF) throw new Error('the scanned path is too long');
    if (!st.n) throw new Error('the scan has no nodes');
    // la raíz se llama como su ruta (lo guardado en nodes[0] no se usa)
    st.ensureNames(path.length);
    for (let k = 0; k < path.length; k++) st.names[st.namesLen + k] = path.charCodeAt(k);
    st.nOff[0] = st.namesLen; st.nLen[0] = path.length; st.namesLen += path.length;
    st.rootPath = path;
    st.sep = path.startsWith('/') ? '/' : '\\';
    st.finalize(); // totales de las carpetas, listas de hijos (tamaño desc) y memoria justa
    const scannedAt = head.get('scannedAt'), app = head.get('app'), host = head.get('host');
    return {
      path, store: st, scannedAt: isNum(scannedAt) ? uint(scannedAt) : 0, engine: head.get('engine') === 'mft' ? 'mft' : 'walk',
      volume: readVolume(head.get('volume')), ...(isText(host) ? { host } : {}), ...(isText(app) ? { app } : {}),
    };
  }

  private nodes(st: Store) {
    this.eat(0x5b);
    if (this.ws() === 0x5d) { this.i++; return; }
    for (; ;) {
      this.node(st);
      const d = this.ws();
      this.i++;
      if (d === 0x2c) continue;
      if (d === 0x5d) return;
      this.i--;
      this.fail("expected ',' or ']'");
    }
  }

  /**
   * [parent, name, isDir, size, alloc, files, dirs, mtime, flags] → columnas del almacén (id = posición). Las
   * carpetas empiezan en 0 (finalize les suma lo que contienen) y files/dirs no se leen; `flags` puede faltar.
   */
  private node(st: Store) {
    const id = st.n;
    if (id >= this.maxNodes) throw new Error(`too many nodes (more than ${this.maxNodes})`);
    const bad = (what: string): never => { throw new Error(`invalid node ${id}: ${what}`); };
    this.eat(0x5b);
    const p = this.num();
    if (id === 0 ? p >= 0 : !(Number.isInteger(p) && p >= 0 && p < id)) bad(id === 0 ? 'the first node must be the root (parent -1)' : 'its parent must come before it');
    if (id > 0 && !(st.fl[p] & FLAG.DIR)) bad('its parent is not a folder');
    this.eat(0x2c);
    // el nombre, directamente en el búfer de nombres (unidades UTF-16, como al escanear)
    this.eat(0x22);
    const end = this.stringEnd();
    st.ensureNames(end - this.i);
    const off = st.namesLen, len = this.units(st.names, off, end);
    if (len > 0xFFFF) bad('name too long');
    this.eat(0x2c);
    let dir: boolean;
    const c = this.ws();
    if (c === 0x74) { this.lit('true'); dir = true; } else if (c === 0x66) { this.lit('false'); dir = false; } else dir = this.number() !== 0;
    if (id === 0 && !dir) bad('the root must be a folder');
    this.eat(0x2c); const size = this.num();
    this.eat(0x2c); const alloc = this.num();
    this.eat(0x2c); this.value(0); // files
    this.eat(0x2c); this.value(0); // dirs
    this.eat(0x2c); const mtime = this.num();
    let flags = 0;
    if (this.ws() === 0x2c) { this.i++; flags = uint(this.num()) % 256; }
    while (this.ws() === 0x2c) { this.i++; this.value(0); } // columnas de una versión futura: se ignoran
    this.eat(0x5d);
    st.ensure(1);
    st.n++;
    st.par[id] = id === 0 ? NONE : p;
    st.sz[id] = dir ? 0 : uint(size); st.al[id] = dir ? 0 : uint(alloc); st.mt[id] = u32(mtime);
    // sólo las banderas públicas; DIR, según la columna isDir
    st.fl[id] = (flags & ~FLAG.DIR) | (dir ? FLAG.DIR : 0);
    st.ex[id] = dir ? 0xFFFF : st.extOf(st.names, off, len);
    if (id === 0) { st.nOff[0] = 0; st.nLen[0] = 0; return; } // (su nombre será `path`: ver file())
    st.nOff[id] = off; st.nLen[id] = len; st.namesLen += len;
  }
}

/** v y kind: lo que no es un escaneo guardado (o es de una versión posterior) se rechaza con un texto claro. */
function checkHead(head: Map<string, unknown>, final: boolean) {
  if (head.has('kind') && head.get('kind') !== TESSERA_KIND) throw new Error(NOT_OURS);
  if (head.has('v')) {
    const v = head.get('v');
    if (v !== TESSERA_VERSION) throw new Error(isNum(v) && v > TESSERA_VERSION ? `unsupported format version ${v} (this TesseraFS reads version ${TESSERA_VERSION})` : NOT_OURS);
  }
  if (final && (!head.has('kind') || !head.has('v'))) throw new Error(NOT_OURS);
}

/** El volumen guardado (con las claves del contrato) o null si falta o no tiene la forma esperada. */
function readVolume(v: unknown): VolumeInfo | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.label !== 'string' || typeof o.fs !== 'string') return null;
  if (!isNum(o.total) || !isNum(o.free) || !isNum(o.clusterSize)) return null;
  return { path: o.path, label: o.label, fs: o.fs, total: o.total, free: o.free, clusterSize: o.clusterSize };
}
