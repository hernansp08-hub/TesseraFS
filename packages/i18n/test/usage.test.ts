// Cruza el código con los catálogos: toda clave usada existe y toda clave del catálogo se usa en algún sitio.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { BASE, CATALOGS } from '../src/index';

const ROOT = join(import.meta.dir, '../../..');
const en = CATALOGS[BASE];
const KEYS = Object.keys(en);
const NAMESPACES = new Set(KEYS.map(k => k.split('.')[0]));

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== 'dist' && f !== 'target') files(p, ext, out); }
    else if (ext.test(f)) out.push(p);
  }
  return out;
}
const read = (p: string) => readFileSync(p, 'utf8');

// Los `code: '…'` de la demo son códigos de motor, no claves: se comprueban aparte
const UI = [...files(join(ROOT, 'packages/ui/src'), /\.ts$/), join(ROOT, 'packages/ui/index.html')].map(read).join('\n').replace(/code: '[^']*'/g, '');
// README.txt de los zips: lo compone packages/i18n/src/readme.ts, que usan los dos empaquetadores
const PACKAGING = ['packages/i18n/src/readme.ts', 'scripts/package.ts', 'apps/portable/pack.ts'].map(f => join(ROOT, f)).filter(existsSync).map(read).join('\n');
// Literales con forma de clave («tab.files», "map.color.ext») de un espacio de nombres conocido
const LITERAL = /['"`]([a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+)['"`]/g;
const used = (src: string) => new Set([...src.matchAll(LITERAL)].map(m => m[1]).filter(k => NAMESPACES.has(k.split('.')[0])));

// Códigos que emiten los motores (y la demo y el lenguaje de búsqueda)
const bunCodes = (await import('../../core-bun/src/messages.ts')).MESSAGE_CODES as string[];
const rustSrc = files(join(ROOT, 'crates'), /\.rs$/).concat(files(join(ROOT, 'apps/desktop/src-tauri/src'), /\.rs$/)).map(read).join('\n');
const rustCodes = [...rustSrc.matchAll(/EngineMessage::new\(\s*"([a-zA-Z]+\.[a-zA-Z]+)"/g)].map(m => m[1]);
const queryCodes = [...read(join(ROOT, 'packages/protocol/src/query.ts')).matchAll(/['"](query\.[a-zA-Z]+)['"]/g)].map(m => m[1]);
const demoSrc = read(join(ROOT, 'packages/ui/src/backends/demo.ts'));
const demoCodes = [...demoSrc.matchAll(/code: '([a-z]+\.[a-zA-Z]+)'/g)].map(m => m[1])
  .concat([...(demoSrc.match(/const msg: Record<string, string> = \{([\s\S]*?)\n\s*\};/)?.[1] ?? '').matchAll(/^\s*(\w+):/gm)].map(x => 'demo.' + x[1]));

describe('uso de las claves', () => {
  test('toda clave que usa la interfaz existe en el catálogo', () => {
    expect([...used(UI)].filter(k => !(k in en))).toEqual([]);
  });

  test('toda clave que usan los empaquetadores existe', () => {
    expect([...used(PACKAGING)].filter(k => !(k in en))).toEqual([]);
  });

  test('cada regla de «Liberar espacio» tiene su explicación', () => {
    const ids = [...read(join(ROOT, 'packages/ui/src/clean.ts')).matchAll(/\{ id: '(\w+)', q:/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(20);
    expect(ids.filter(id => !(`clean.${id}.why` in en))).toEqual([]);
  });

  test('cada carpeta conocida tiene su explicación known.<id>, y no sobra ninguna', () => {
    const src = read(join(ROOT, 'packages/ui/src/clean.ts'));
    const ids = [...src.slice(src.indexOf('export const KNOWN')).matchAll(/^\s*\['(\w+)', \//gm)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter(id => !(`known.${id}` in en))).toEqual([]);
    expect(KEYS.filter(k => k.startsWith('known.') && k !== 'known.heading' && !ids.includes(k.slice(6)))).toEqual([]);
  });

  test.each([['Bun', bunCodes], ['Rust', rustCodes], ['búsqueda', queryCodes], ['demo', demoCodes]] as [string, string[]][])(
    'cada código del motor %s tiene traducción engine.<code>', (_name, codes) => {
      expect(codes.length).toBeGreaterThan(0);
      expect([...new Set(codes)].filter(c => !(`engine.${c}` in en))).toEqual([]);
    });

  test('no hay claves sin usar', () => {
    const refs = new Set([...used(UI), ...used(PACKAGING)]);
    const codes = new Set([...bunCodes, ...rustCodes, ...queryCodes, ...demoCodes].map(c => 'engine.' + c));
    // Prefijos que se componen en tiempo de ejecución
    const dynamic = [/^cat\./, /^age\.\d$/, /^phase\./, /^clean\.(risk|sum)\./, /^clean\.\w+\.(title|why|how)$/, /^known\.\w+$/];
    const unused = KEYS.filter(k => !refs.has(k) && !codes.has(k) && !dynamic.some(r => r.test(k)));
    expect(unused).toEqual([]);
  });
});
