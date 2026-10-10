// @tessera/i18n: catálogos, negociación de idioma, mensajes ICU y formatos Intl. Ver docs/tecnica/i18n.md.
import { IntlMessageFormat } from 'intl-messageformat';
import en from '../locales/en.json';
import es from '../locales/es.json';
import ptBR from '../locales/pt-BR.json';
import fr from '../locales/fr.json';
import de from '../locales/de.json';

export type MessageKey = keyof typeof en;
export type Params = Record<string, string | number | Date>;
type Catalog = Record<string, string>;

export interface LocaleInfo { code: string; name: string; dir: 'ltr' | 'rtl' }
export const BASE = 'en';
/** Idioma de pruebas: el inglés transformado (acentos, corchetes y relleno). */
export const PSEUDO = 'en-XA';
/** Nombres siempre en su propio idioma. */
export const LOCALES: LocaleInfo[] = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'pt-BR', name: 'Português (Brasil)', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', dir: 'ltr' },
];
export const CATALOGS: Record<string, Catalog> = { en, es, 'pt-BR': ptBR, fr, de };

/**
 * BCP 47 en orden de preferencia: para cada idioma pedido, coincidencia exacta y después por idioma base
 * (es-MX → es, pt-PT → pt-BR). Si ninguno coincide, inglés.
 */
export function negotiate(requested: readonly string[], available: readonly string[] = Object.keys(CATALOGS)): string {
  const low = (s: string) => s.toLowerCase(), base = (s: string) => low(s).split('-')[0];
  for (const r of requested) {
    const m = available.find(a => low(a) === low(r)) ?? available.find(a => base(a) === base(r));
    if (m) return m;
  }
  return BASE;
}

// ---------- Pseudolocalización ----------
const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š',
  t: 'ŧ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž', A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ',
  L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ŧ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};
/**
 * Transforma sólo el texto literal de un mensaje ICU: a profundidad de llaves par (0 = texto, 2 = cuerpo de un plural…).
 * Respeta nombres de argumentos, palabras clave, `#` y etiquetas `<b>`.
 */
export function pseudo(msg: string): string {
  let out = '', depth = 0, letters = 0;
  for (let i = 0; i < msg.length; i++) {
    const ch = msg[i];
    if (ch === '{') { depth++; out += ch; continue; }
    if (ch === '}') { depth--; out += ch; continue; }
    if (ch === '<') { const j = msg.indexOf('>', i); if (j > i) { out += msg.slice(i, j + 1); i = j; continue; } }
    if (depth % 2 === 0 && ch !== '#') { const a = ACCENTS[ch]; if (a) letters++; out += a ?? ch; } else out += ch;
  }
  return `[${out}${' ·'.repeat(Math.max(1, Math.ceil(letters * 0.3 / 2)))}]`;
}

// ---------- Texto con formato seguro ----------
const ALLOWED = /<(\/?)(b|code|kbd|br)>/g;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export class I18n {
  readonly locale: string;
  readonly dir: 'ltr' | 'rtl';
  /** Locale para Intl (el pseudoidioma formatea como inglés). */
  readonly intl: string;
  private readonly messages: Catalog;
  private readonly cache = new Map<string, IntlMessageFormat>();
  private readonly fmt: {
    int: Intl.NumberFormat; pct: Intl.NumberFormat; date: Intl.DateTimeFormat; rel: Intl.RelativeTimeFormat;
    unit: Map<string, Intl.NumberFormat>;
  };
  onMissing: (key: string, locale: string) => void = () => { };

  constructor(locale: string) {
    this.locale = locale === PSEUDO ? PSEUDO : (CATALOGS[locale] ? locale : BASE);
    this.intl = this.locale === PSEUDO ? 'en' : this.locale;
    this.dir = LOCALES.find(l => l.code === this.locale)?.dir ?? 'ltr';
    this.messages = this.locale === PSEUDO
      ? Object.fromEntries(Object.entries(CATALOGS[BASE]).map(([k, v]) => [k, pseudo(v)]))
      : CATALOGS[this.locale];
    let int: Intl.NumberFormat;
    try { int = new Intl.NumberFormat(this.intl, { useGrouping: 'always' } as Intl.NumberFormatOptions); int.format(1234); }
    catch { int = new Intl.NumberFormat(this.intl); }
    this.fmt = {
      int,
      pct: new Intl.NumberFormat(this.intl, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      date: new Intl.DateTimeFormat(this.intl, { year: 'numeric', month: '2-digit', day: '2-digit' }),
      rel: new Intl.RelativeTimeFormat(this.intl, { numeric: 'auto' }),
      unit: new Map(),
    };
  }

  has(key: string): boolean { return key in this.messages || key in CATALOGS[BASE]; }

  /** Texto plano. Si falta en el idioma, usa el inglés; si tampoco existe, devuelve la clave. */
  t(key: MessageKey | string, params?: Params): string {
    let src = this.messages[key];
    if (src == null) { this.onMissing(key, this.locale); src = CATALOGS[BASE][key]; }
    if (src == null) return key;
    let mf = this.cache.get(key);
    if (!mf) { mf = new IntlMessageFormat(src, this.intl, undefined, { ignoreTag: true }); this.cache.set(key, mf); }
    return String(mf.format(params as never));
  }

  /** HTML seguro: escapa todo salvo <b>, <code>, <kbd> y <br> del propio mensaje. */
  html(key: MessageKey | string, params?: Params): string {
    const marks: string[] = [];
    const protectedText = this.t(key, params).replace(ALLOWED, m => { marks.push(m); return `\u0000${marks.length - 1}\u0000`; });
    return escapeHtml(protectedText).replace(/\u0000(\d+)\u0000/g, (_, i) => marks[+i]);
  }

  // ---------- Formatos ----------
  number(n: number): string { return this.fmt.int.format(n); }
  percent(x: number, digits = 1): string {
    const v = isFinite(x) ? x : 0;
    if (digits === 1) return this.fmt.pct.format(v);
    return new Intl.NumberFormat(this.intl, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  }
  date(unixSeconds: number): string { return unixSeconds ? this.fmt.date.format(new Date(unixSeconds * 1000)) : '—'; }

  private unit(unit: string, digits: number, display: 'short' | 'narrow' = 'short'): Intl.NumberFormat {
    const k = unit + digits + display; let f = this.fmt.unit.get(k);
    if (!f) { f = new Intl.NumberFormat(this.intl, { style: 'unit', unit, unitDisplay: display, minimumFractionDigits: digits, maximumFractionDigits: digits }); this.fmt.unit.set(k, f); }
    return f;
  }
  /** Bytes con el símbolo corto (B, o) y siempre separado del número, como GB o Mo. */
  private plainBytes(n: number): string {
    const parts = this.unit('byte', 0, 'narrow').formatToParts(n);
    let out = '';
    parts.forEach((p, i) => {
      out += p.value;
      const next = parts[i + 1];
      if (next && p.type !== 'literal' && next.type !== 'literal' && (p.type === 'unit') !== (next.type === 'unit')) out += '\u00a0';
    });
    return out;
  }
  /** Tamaño en base 1024 con el símbolo de cada idioma (GB, Go…). */
  bytes(b: number): string {
    const K = 1024, M = K * K, G = M * K, T = G * K;
    if (b >= T) return this.unit('terabyte', 1).format(b / T);
    if (b >= G) return this.unit('gigabyte', 1).format(b / G);
    if (b >= M) return this.unit('megabyte', 1).format(b / M);
    if (b >= K) return this.unit('kilobyte', 0).format(Math.round(b / K));
    return this.plainBytes(Math.round(b));
  }
  seconds(ms: number): string { return this.unit('second', 1).format(ms / 1000); }
  /** «hace 4 días», «4 days ago», «il y a 4 jours». */
  relative(unixSeconds: number, now = Date.now() / 1000): string {
    const d = (now - unixSeconds) / 86400;
    if (d < 1) return this.fmt.rel.format(0, 'day');
    if (d < 31) return this.fmt.rel.format(-Math.round(d), 'day');
    if (d < 365) return this.fmt.rel.format(-Math.round(d / 30), 'month');
    return this.fmt.rel.format(-Math.max(1, Math.round(d / 365)), 'year');
  }
}
