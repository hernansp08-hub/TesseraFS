// Calidad de los catálogos: mismas claves, ICU válido, mismos argumentos y etiquetas que el inglés.
import { describe, expect, test } from 'bun:test';
import { IntlMessageFormat } from 'intl-messageformat';
import { BASE, CATALOGS, I18n, LOCALES, PSEUDO, negotiate, pseudo } from '../src/index';

const en = CATALOGS[BASE];
const KEYS = Object.keys(en);
const TRANSLATIONS = Object.keys(CATALOGS).filter(l => l !== BASE);
const PSEUDO_CATALOG = Object.fromEntries(KEYS.map(k => [k, pseudo(en[k])]));
const ALL: [string, Record<string, string>][] = [...Object.entries(CATALOGS), [PSEUDO, PSEUDO_CATALOG]];

// Tipos de nodo del AST de @formatjs/icu-messageformat-parser.
const ARGUMENT = 1, SELECT = 5, PLURAL = 6;
interface Node { type: number; value?: unknown; options?: Record<string, { value: Node[] }> }

function ast(msg: string, locale: string): Node[] {
  return new IntlMessageFormat(msg, locale === PSEUDO ? 'en' : locale, undefined, { ignoreTag: true }).getAst() as unknown as Node[];
}
/** Argumentos con su tipo («count:plural»), incluidos los de dentro de plurales y selects. */
function args(nodes: Node[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.type >= ARGUMENT && n.type <= PLURAL && typeof n.value === 'string') out.add(`${n.value}:${n.type}`);
    if (n.options) for (const o of Object.values(n.options)) args(o.value, out);
  }
  return out;
}
function branches(nodes: Node[], out: Node[] = []): Node[] {
  for (const n of nodes) if (n.options) { out.push(n); for (const o of Object.values(n.options)) branches(o.value, out); }
  return out;
}
const tags = (msg: string) => (msg.match(/<\/?[a-z]+>/g) ?? []).sort();

describe('catálogos', () => {
  test('cada idioma de LOCALES tiene catálogo y viceversa', () => {
    expect(LOCALES.map(l => l.code).sort()).toEqual(Object.keys(CATALOGS).sort());
  });

  test.each(TRANSLATIONS)('%s tiene exactamente las claves del inglés', locale => {
    const keys = Object.keys(CATALOGS[locale]);
    expect(KEYS.filter(k => !keys.includes(k))).toEqual([]);
    expect(keys.filter(k => !(k in en))).toEqual([]);
  });

  test.each(ALL)('%s: todos los mensajes son ICU válido y no están vacíos', (locale, cat) => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(cat)) {
      try { if (!v.trim()) throw new Error('vacío'); ast(v, locale); } catch (e) { bad.push(`${k}: ${(e as Error).message}`); }
    }
    expect(bad).toEqual([]);
  });

  test.each(ALL)('%s: mismos argumentos que el inglés', (locale, cat) => {
    // `os` es global (GLOBAL_PARAMS): cada idioma lo usa sólo si su texto cambia según el sistema
    const own = (s: Set<string>) => [...s].filter(a => !a.startsWith('os:')).sort();
    const bad = KEYS.filter(k => {
      const a = own(args(ast(en[k], 'en'))), b = own(args(ast(cat[k], locale)));
      return a.join() !== b.join();
    });
    expect(bad).toEqual([]);
  });

  test.each(ALL)('%s: todo plural y select tiene rama other', (locale, cat) => {
    const bad = KEYS.filter(k => branches(ast(cat[k], locale)).some(n => !n.options?.other));
    expect(bad).toEqual([]);
  });

  test.each(ALL)('%s: sólo etiquetas permitidas y las mismas que el inglés', (locale, cat) => {
    const bad = KEYS.filter(k => {
      const t = tags(cat[k]);
      return t.some(x => !/^<\/?(b|code|kbd|br)>$/.test(x)) || t.join() !== tags(en[k]).join();
    });
    expect(bad).toEqual([]);
  });

  test.each(ALL)('%s: sin apóstrofos ASCII (en ICU escapan llaves); usar ’', (_locale, cat) => {
    expect(KEYS.filter(k => cat[k].includes("'"))).toEqual([]);
  });

  test('las notas para traductores (_context.json) son de claves que existen', async () => {
    const ctx: Record<string, string> = (await import('../locales/_context.json')).default;
    expect(Object.keys(ctx).filter(k => k !== '_' && !(k in en))).toEqual([]);
  });

  test('francés: espacio fino antes de : ; ? ! y dentro de « »', () => {
    const fr = CATALOGS.fr;
    const bad = KEYS.filter(k => /[^\u00a0\u202f\s][:;?!](\s|$)|« | »/.test(fr[k].replace(/<code>.*?<\/code>|<[^>]+>|\{[^{}]*\}/g, '')));
    expect(bad).toEqual([]);
  });
});

describe('formato', () => {
  test.each([...Object.keys(CATALOGS), PSEUDO])('%s formatea todos los mensajes con argumentos de ejemplo', locale => {
    const i18n = new I18n(locale);
    // Un valor numérico para cada argumento del mensaje: sirve para plurales, números y textos, y en un select cae en «other»
    for (const k of KEYS) {
      const sample = Object.fromEntries([...args(ast(en[k], 'en'))].map(a => [a.split(':')[0], 2]));
      expect(typeof i18n.t(k, sample)).toBe('string');
    }
  });

  test('plurales por idioma', () => {
    expect(new I18n('en').t('tip.files', { count: 1 })).toBe('1 file');
    expect(new I18n('en').t('tip.files', { count: 1234 })).toBe('1,234 files');
    expect(new I18n('es').t('tip.files', { count: 2 })).toBe('2 archivos');
    expect(new I18n('fr').t('tip.files', { count: 0 })).toBe('0 fichier');
    expect(new I18n('de').t('tip.files', { count: 1 })).toBe('1 Datei');
  });

  test('tamaños, números, porcentajes y fechas', () => {
    // Intl separa número y unidad con espacios duros; se normalizan para comparar.
    const sp = (s: string) => s.replace(/[  ]/g, ' ');
    const en = new I18n('en'), es = new I18n('es'), de = new I18n('de'), fr = new I18n('fr');
    const GB = 1.5 * 1024 ** 3;
    expect([en, es, de, fr].map(i => sp(i.bytes(GB)))).toEqual(['1.5 GB', '1,5 GB', '1,5 GB', '1,5 Go']);
    expect([en, es, de, fr].map(i => sp(i.bytes(512)))).toEqual(['512 B', '512 B', '512 B', '512 o']);
    expect(sp(en.bytes(0))).toBe('0 B');
    // Los formatos que se guardan para el aviso del escaneo programado: los mismos que `bytes`
    expect([en, fr].map(i => i.sizePatterns().map(sp))).toEqual([
      ['{int} kB', '{int}.{frac} MB', '{int}.{frac} GB', '{int}.{frac} TB'],
      ['{int} ko', '{int},{frac} Mo', '{int},{frac} Go', '{int},{frac} To'],
    ]);
    const fill = (p: string, n: string) => { const [a, b = ''] = n.split('.'); return p.replace('{int}', a).replace('{frac}', b); };
    for (const i of [en, es, de, fr]) expect(sp(fill(i.sizePatterns()[2], '1.5'))).toBe(sp(i.bytes(GB)));
    expect([en, es, de, fr].map(i => sp(i.number(1234)))).toEqual(['1,234', '1.234', '1.234', '1 234']);
    expect([en, es].map(i => sp(i.percent(0.125)))).toEqual(['12.5%', '12,5 %']);
    expect([en, de].map(i => i.date(1700000000))).toEqual(['11/14/2023', '14.11.2023']);
    expect(en.date(0)).toBe('—');
    expect(en.relative(Date.now() / 1000 - 3 * 86400)).toBe('3 days ago');
    expect(es.relative(Date.now() / 1000 - 3 * 86400)).toBe('hace 3 días');
  });

  test('html escapa los argumentos y conserva sólo las etiquetas del mensaje', () => {
    const out = new I18n('en').html('files.invalidFilter', { error: '<img src=x onerror=alert(1)>' });
    expect(out).toContain('<b>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  test('si falta una clave usa el inglés y avisa; si no existe devuelve la clave', () => {
    const i18n = new I18n('es'); const missing: string[] = [];
    i18n.onMissing = k => missing.push(k);
    expect(i18n.t('no.existe')).toBe('no.existe');
    expect(missing).toEqual(['no.existe']);
  });
});

describe('negociación', () => {
  test.each([
    [['es-MX', 'en'], 'es'], [['pt-PT'], 'pt-BR'], [['pt-br'], 'pt-BR'], [['fr-CA'], 'fr'], [['de-AT'], 'de'],
    [['ja-JP', 'de'], 'de'], [['ja-JP'], 'en'], [[], 'en'],
  ] as [string[], string][])('%p → %s', (req, want) => expect(negotiate(req)).toBe(want));

  test('el pseudoidioma conserva argumentos y marca el texto', () => {
    const p = pseudo('{count, plural, one {# file} other {# files}} in <b>{name}</b>');
    expect(p).toStartWith('[');
    expect(p).toContain('{count, plural, one {# ƒíļé} other {# ƒíļéš}}');
    expect(p).toContain('<b>{name}</b>');
  });
});
