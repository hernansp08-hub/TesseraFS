import { FLAG, type EngineMessage } from "./types";

// Lenguaje de búsqueda de TesseraFS. Ver docs/ARQUITECTURA.md (el motor Rust replica estas reglas).

export interface QueryTarget {
  name: string;
  ext: string;     // minúsculas, sin punto
  isDir: boolean;
  size: number;
  alloc: number;
  mtime: number;   // segundos Unix
  flags?: number;  // bits de FLAG (attr:); sin ellos, 0
  path(): string;  // ruta completa; se llama sólo si hace falta
}

export interface CompiledQuery {
  match(t: QueryTarget): boolean;
  /** true si alguna condición pide carpetas (type:dir); si no, sólo se buscan archivos */
  wantsDirs: boolean;
  wantsFiles: boolean;
  /** Error de sintaxis con código traducible (query.*), ver docs/tecnica/i18n.md */
  error?: EngineMessage;
}

/** Error de sintaxis del filtro: viaja como EngineMessage hasta la interfaz. */
class QueryError extends Error {
  constructor(public msg: EngineMessage) { super(msg.message); }
}
function fail(code: string, message: string, params: Record<string, string>): never { throw new QueryError({ code, params, message }); }

const UNIT: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
const AGE: Record<string, number> = { d: 86400, w: 7 * 86400, mo: 30 * 86400, y: 365 * 86400 };
const KEYS: Record<string, string> = {
  ext: 'ext', size: 'size', tam: 'size', alloc: 'alloc', asig: 'alloc', age: 'age', edad: 'age',
  path: 'path', ruta: 'path', name: 'name', nombre: 'name', re: 're', type: 'type', tipo: 'type', attr: 'attr', atrib: 'attr',
};
/** Valores de attr: (con alias en español); varios separados por comas = cualquiera de ellos. */
const ATTRS: Record<string, number> = {
  cloud: FLAG.CLOUD, nube: FLAG.CLOUD, hidden: FLAG.HIDDEN, oculto: FLAG.HIDDEN, system: FLAG.SYSTEM, sistema: FLAG.SYSTEM,
  compressed: FLAG.COMPRESSED, comprimido: FLAG.COMPRESSED, hardlink: FLAG.HARDLINK, enlace: FLAG.HARDLINK,
  sparse: FLAG.SPARSE, disperso: FLAG.SPARSE, reparse: FLAG.REPARSE, reanalisis: FLAG.REPARSE,
};

type Pred = (t: QueryTarget, now: number) => boolean;
/** Busca sólo claves propias: «constructor» o «__proto__» no son claves, unidades ni atributos. */
const own = <T>(o: Record<string, T>, k: string): T | undefined => Object.hasOwn(o, k) ? o[k] : undefined;

function wildcard(p: string): RegExp {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}
function num(s: string, units: Record<string, number>): number {
  const m = s.trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*([a-z]*)$/);
  if (!m || own(units, m[2]) === undefined) fail("query.invalidValue", `Invalid value: "${s}"`, { value: s });
  return parseFloat(m[1].replace(',', '.')) * units[m[2]];
}
function compare(spec: string, units: Record<string, number>): (v: number) => boolean {
  const range = spec.split('..');
  if (range.length === 2) { const a = num(range[0], units), b = num(range[1], units); return v => v >= a && v <= b; }
  const m = spec.match(/^(>=|<=|>|<|=)?(.*)$/)!;
  const op = m[1] || '>=', x = num(m[2], units);
  return op === '>' ? v => v > x : op === '<' ? v => v < x : op === '>=' ? v => v >= x : op === '<=' ? v => v <= x : v => Math.abs(v - x) < 1;
}

function tokenize(q: string): string[] {
  // Admite comillas sueltas ("Cities Skylines") y tras una clave (name:"System Volume Information")
  const out: string[] = []; const re = /-?[^\s"]*"[^"]*"[^\s"]*|\S+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[0].replace(/"/g, ''));
  return out;
}

export function compileQuery(q: string): CompiledQuery {
  let wantsDirs = false, wantsFiles = false, typeSeen = false;
  try {
    const groups: Pred[][] = [[]];
    for (const raw of tokenize(q)) {
      if (raw === 'OR' || raw === '|') { groups.push([]); continue; }
      let tok = raw, neg = false;
      if (tok.length > 1 && tok[0] === '-') { neg = true; tok = tok.slice(1); }
      let p: Pred;
      const kv = tok.match(/^([a-záéíóú]+):(.*)$/i);
      const key = kv ? own(KEYS, kv[1].toLowerCase()) : undefined;
      if (kv && key) {
        const v = kv[2];
        switch (key) {
          case 'ext': {
            const set = new Set(v.toLowerCase().split(',').map(s => s.replace(/^\./, '')).map(s => s === 'none' ? '' : s));
            p = t => !t.isDir && set.has(t.ext); break;
          }
          case 'size': { const c = compare(v, UNIT); p = t => c(t.size); break; }
          case 'alloc': { const c = compare(v, UNIT); p = t => c(t.alloc); break; }
          case 'age': { const c = compare(v, AGE); p = (t, now) => c(now - t.mtime); break; }
          case 'path': { const s = v.toLowerCase(); p = t => t.path().toLowerCase().includes(s); break; }
          case 'name': { const r = /[*?]/.test(v) ? wildcard(v) : null, s = v.toLowerCase(); p = t => r ? r.test(t.name) : t.name.toLowerCase().includes(s); break; }
          case 're': { const r = new RegExp(v, 'i'); p = t => r.test(t.name); break; }
          case 'attr': {
            let mask = 0;
            for (const a of v.toLowerCase().split(',')) {
              const bit = own(ATTRS, a.trim());
              if (!bit) fail("query.invalidValue", `Invalid value: "${v}"`, { value: v });
              mask |= bit;
            }
            p = t => ((t.flags ?? 0) & mask) !== 0; break;
          }
          case 'type': {
            const dir = /^(dir|carpeta|folder)$/i.test(v), file = /^(file|archivo)$/i.test(v);
            if (!dir && !file) fail("query.invalidType", `Invalid type: "${v}" (use dir or file)`, { value: v });
            typeSeen = true; if (dir && !neg) wantsDirs = true; if (file && !neg) wantsFiles = true;
            p = t => dir ? t.isDir : !t.isDir; break;
          }
          default: fail("query.unknownKey", `Unknown key: "${kv[1]}"`, { key: kv[1] });
        }
      } else if (/[*?]/.test(tok)) { const r = wildcard(tok); p = t => r.test(t.name); }
      else { const s = tok.toLowerCase(); p = t => t.name.toLowerCase().includes(s); }
      groups[groups.length - 1].push(neg ? (t, now) => !p(t, now) : p);
    }
    const gs = groups.filter(g => g.length);
    if (!typeSeen) wantsFiles = true;
    if (typeSeen && !wantsDirs && !wantsFiles) { wantsDirs = true; wantsFiles = true; }
    return {
      wantsDirs, wantsFiles,
      match(t) {
        if (t.isDir ? !wantsDirs : !wantsFiles) return false;
        const now = Date.now() / 1000;
        return gs.length === 0 || gs.some(g => g.every(p => p(t, now)));
      },
    };
  } catch (e) {
    // El motor JS ya empieza su texto por «Invalid regular expression:»; el parámetro lleva sólo el motivo
    const why = String((e as Error).message).replace(/^Invalid regular expression:\s*/i, '');
    const error: EngineMessage = e instanceof QueryError ? e.msg
      : { code: "query.invalidRegex", params: { error: why }, message: `Invalid regular expression: ${why}` };
    return { wantsDirs: false, wantsFiles: false, match: () => false, error };
  }
}
