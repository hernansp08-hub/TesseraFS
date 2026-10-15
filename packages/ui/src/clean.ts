// «Liberar espacio» y «¿Qué es esto?»: reglas explicadas que se ejecutan como filtros, y carpetas conocidas.
// Sin dependencias de la interfaz para poder probarlas (test/clean.test.ts). Los textos van en el catálogo:
//   regla:   clean.<id>.title · clean.<id>.why · clean.<how>.how (si `how`)
//   conocida: known.<id>
// Las reglas son datos que comparte con tessera-cli mcp (packages/protocol/src/clean-rules.json); KNOWN, no.
import { CLEAN_RULES, FLAG, type CleanMatch, type CleanPattern, type CleanRuleSet, type CleanRuleSpec, type Os } from '@tessera/protocol';

export type Risk = 'ok' | 'warn' | 'bad';
/** Lo que una regla necesita de un elemento (una fila de búsqueda cumple esta forma). */
export interface Target { name: string; path: string; isDir: boolean; ext: string; size?: number; alloc?: number; flags?: number }
export type Key = [key: string, params?: Record<string, string>];

export interface Rule {
  id: string;
  /** Consulta del lenguaje de búsqueda que trae los candidatos; `ok` los afina por ruta. */
  q: string;
  risk: Risk;
  ok?: (t: Target) => boolean;
  /** Nombres de hijos que confirman el candidato (p. ej. CACHEDIR.TAG en un target de Rust). */
  needs?: string[];
  /** Título que depende del elemento (el juego, el navegador…); si no, clean.<id>.title. */
  title?: (t: Target) => Key;
  cmd?: string | ((t: Target) => string | undefined);
  /** Id de la regla cuyo texto «cómo» se muestra (true = el suyo). */
  how?: true | string;
  /** El tamaño que cuenta es el que ocupa en disco (alloc), no el lógico: p. ej. OneDrive descargado. */
  useAlloc?: boolean;
  /** Acción propia de la tarjeta en lugar de marcar para borrar. */
  action?: 'freeUp';
  /** La consulta encuentra una marca (p. ej. CACHEDIR.TAG) y el candidato es la carpeta que la contiene. */
  parent?: true;
  /**
   * Tarjeta de resumen, no de un elemento: cuántos hay y algunos ejemplos. `query`: los de la consulta, con «Ver
   * todos» en Archivos; `links`: los enlaces rotos (Backend.brokenLinks), con «Marcar todos».
   */
  list?: 'query' | 'links';
  /** Agrupa los archivos por carpeta en una sola tarjeta. */
  group?: boolean;
  /** Tamaño mínimo para proponerlo. */
  min?: number;
}

// ---------- Reglas: de los datos a funciones ----------
// Las reglas son datos (packages/protocol/src/clean-rules.json, los mismos que lee tessera-cli mcp); el formato
// se explica en packages/protocol/src/clean.ts. Un error en los datos falla al cargar, y lo detectan las pruebas.
const fail = (msg: string): never => { throw new Error(`clean-rules.json: ${msg}`); };
/** "50m" → bytes, con las unidades de la búsqueda (base 1024). */
function bytes(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([kmgt]?)$/i.exec(s.trim()) ?? fail(`tamaño no válido «${s}»`);
  return Number(m[1]) * 1024 ** (m[2] ? 'kmgt'.indexOf(m[2].toLowerCase()) + 1 : 0);
}
/** `{var}` del sistema: entre (?:…) en una expresión regular, tal cual en una consulta. */
const expand = (s: string, set: CleanRuleSet, regex: boolean) =>
  s.replace(/\{([A-Za-z]\w*)\}/g, (m, k: string) => {
    const v = Object.hasOwn(set.vars, k) ? set.vars[k] : fail(`variable desconocida ${m}`);
    return regex ? `(?:${v})` : v;
  });
/** En Windows, `/` es el separador `\`. */
function regex(p: CleanPattern, set: CleanRuleSet): RegExp {
  const { re, i } = typeof p === 'string' ? { re: p, i: set.ignoreCase } : p;
  const src = expand(re, set, true);
  return new RegExp(set.sep === '\\' ? src.replaceAll('/', '\\\\') : src, i ? 'i' : '');
}
type Test = (t: Target) => boolean;
function matcher(m: CleanMatch, set: CleanRuleSet): Test {
  const tests: Test[] = [];
  const on = (p: CleanPattern | undefined, f: (re: RegExp, t: Target) => boolean) => {
    if (p != null) { const re = regex(p, set); tests.push(t => f(re, t)); }
  };
  on(m.name, (re, t) => re.test(t.name));
  on(m.path, (re, t) => re.test(t.path));
  on(m.notPath, (re, t) => !re.test(t.path));
  on(m.ext, (re, t) => re.test(t.ext));
  if (m.flag) { const f = FLAG[m.flag] ?? fail(`atributo desconocido ${m.flag}`); tests.push(t => !!((t.flags ?? 0) & f)); }
  return t => tests.every(f => f(t));
}
/** «restic › e4b1c9a07d»: la carpeta con su padre, porque muchas cachés se llaman con un código. */
const lastTwo = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join(' › ');
type Fill = (t: Target, label?: string) => string;
const TOKENS: Record<string, Fill> = { label: (t, label) => label ?? t.name, name: t => t.name, path: t => t.path, lastTwo: t => lastTwo(t.path) };
function template(tpl: string): Fill {
  for (const [m, k] of tpl.matchAll(/\{(\w+)\}/g)) if (!Object.hasOwn(TOKENS, k)) fail(`${m} no es {label}, {name}, {path} ni {lastTwo}`);
  return (t, label) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => TOKENS[k](t, label));
}
/** Ocupa en disco al menos esa fracción de su tamaño, es decir, sin comprimir (sin datos, se supone que sí). */
const fills = (t: Target, ratio: number) => t.size == null || t.alloc == null || t.alloc >= t.size * ratio;

function compile(s: CleanRuleSpec, set: CleanRuleSet): Rule {
  const ok = s.ok && matcher(s.ok, set);
  const variants = s.variants?.map(v => ({ test: matcher(v, set), label: v.label, cmd: v.cmd != null ? template(v.cmd) : undefined, title: v.title }));
  const variantOf = (t: Target) => variants?.find(v => v.test(t));
  const r: Rule = { id: s.id, q: expand(s.q, set, false), risk: s.risk };
  if (ok || variants) r.ok = t => (!ok || ok(t)) && (!variants || !!variantOf(t));
  if (s.needs) r.needs = s.needs;
  const params = s.titleParams && Object.entries(s.titleParams).map(([k, v]) => [k, template(v)] as const);
  if (params || variants?.some(v => v.title)) r.title = t => {
    const v = variantOf(t), key = v?.title ?? `clean.${s.id}.title`;
    return params ? [key, Object.fromEntries(params.map(([k, f]) => [k, f(t, v?.label)]))] : [key];
  };
  // Una orden fija se queda en texto; la que depende del elemento, en función
  const cmd = s.cmd != null ? template(s.cmd) : undefined;
  if (s.cmd != null && !variants?.some(v => v.cmd) && s.cmdMinAlloc == null && !/\{\w+\}/.test(s.cmd)) r.cmd = s.cmd;
  else if (cmd || variants?.some(v => v.cmd)) r.cmd = t => {
    const v = variantOf(t), f = v?.cmd ?? cmd;
    return f && (s.cmdMinAlloc == null || fills(t, s.cmdMinAlloc)) ? f(t, v?.label) : undefined;
  };
  if (s.how) r.how = s.how;
  if (s.useAlloc) r.useAlloc = true;
  if (s.action) r.action = s.action;
  if (s.parent) r.parent = true;
  if (s.list) r.list = s.list;
  if (s.group) r.group = true;
  if (s.min) r.min = bytes(s.min);
  return r;
}
const compileSet = (set: CleanRuleSet) => set.rules.map(s => compile(s, set));

export const RULES: Rule[] = compileSet(CLEAN_RULES.windows);

/** Carpetas que conviene explicar aunque no sean candidatas a limpieza (texto: known.<id>). */
export const KNOWN: [id: string, re: RegExp][] = [
  ['windows', /^[A-Z]:\\Windows$/i],
  ['system32', /^[A-Z]:\\Windows\\(System32|SysWOW64)$/i],
  ['prefetch', /^[A-Z]:\\Windows\\Prefetch$/i],
  ['windowsApps', /^[A-Z]:\\Program Files\\WindowsApps$/i],
  ['programFiles', /^[A-Z]:\\Program Files( \(x86\))?$/i],
  ['programData', /^[A-Z]:\\ProgramData$/i],
  ['recovery', /^[A-Z]:\\Recovery$/i],
  ['users', /^[A-Z]:\\Users$/i],
  ['appData', /^[A-Z]:\\Users\\[^\\]+\\AppData$/i],
  ['storePackages', /\\AppData\\Local\\Packages$/i],
  ['oneDrive', /^[A-Z]:\\Users\\[^\\]+\\OneDrive( - [^\\]+)?$/i],
  ['downloads', /^[A-Z]:\\Users\\[^\\]+\\Downloads$/i],
  ['steamapps', /\\steamapps$/i],
];

// ---------- Linux ----------
// Carpeta personal: /home/<usuario> o /root (la misma variable que usan las reglas)
const HOME = CLEAN_RULES.linux.vars.home;
const home = (rest: string) => new RegExp(HOME + rest);

export const LINUX_RULES: Rule[] = compileSet(CLEAN_RULES.linux);

/** Carpetas de Linux que conviene explicar (texto: known.<id>). */
export const LINUX_KNOWN: [id: string, re: RegExp][] = [
  ['usr', /^\/usr$/],
  ['kernelModules', /^\/(usr\/)?lib\/modules$/],
  ['var', /^\/var$/],
  ['varLog', /^\/var\/log$/],
  ['varCache', /^\/var\/cache$/],
  ['varLib', /^\/var\/lib$/],
  ['opt', /^\/opt$/],
  ['boot', /^\/boot$/],
  ['tmp', /^\/(var\/)?tmp$/],
  ['snapDir', /^\/snap$/],
  ['home', /^\/home$/],
  ['localShare', home('/\\.local/share$')],
  ['dotConfig', home('/\\.config$')],
  ['ollama', /^\/usr\/share\/ollama$|\/\.ollama\/models$/],
  ['downloads', home('/(Downloads|Descargas|Téléchargements)$')],
  ['steamapps', /\/steamapps$/],
];

/** Reglas del sistema donde corre el motor. */
export const rulesFor = (os: Os) => os === 'windows' ? RULES : LINUX_RULES;
/** Carpeta conocida en ese sistema. */
export const knownIdFor = (path: string, os: Os) => (os === 'windows' ? KNOWN : LINUX_KNOWN).find(([, re]) => re.test(path))?.[0];

/** Carpeta o archivo que la regla busca: con «type:dir» y «type:file» a la vez, ambos. */
export function ruleKind(r: Rule): 'dir' | 'file' | 'any' {
  const d = /\btype:dir\b/.test(r.q), f = /\btype:file\b/.test(r.q);
  return d && f ? 'any' : d ? 'dir' : 'file';
}
/** ¿La regla describe este elemento? (sin `needs`, que requiere preguntar al motor por sus hijos) */
export function ruleMatches(r: Rule, t: Target): boolean {
  if (!r.ok) return false;
  const k = ruleKind(r);
  if ((k === 'dir' && !t.isDir) || (k === 'file' && t.isDir)) return false;
  return r.ok(t);
}
export const cmdOf = (r: Rule, t: Target) => typeof r.cmd === 'function' ? r.cmd(t) : r.cmd;
export const titleOf = (r: Rule, t: Target): Key => r.title ? r.title(t) : [`clean.${r.id}.title`];
export const howKey = (r: Rule) => r.how ? `clean.${r.how === true ? r.id : r.how}.how` : '';
export const knownId = (path: string) => KNOWN.find(([, re]) => re.test(path))?.[0];
