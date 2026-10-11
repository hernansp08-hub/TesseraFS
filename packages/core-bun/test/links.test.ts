// Enlaces rotos (brokenLinks) y carpeta pedida al abrir (launchPath) sobre carpetas temporales creadas por la prueba
// (TESSERA_TEST_DIR o %TEMP%): uniones a una carpeta temporal que luego se borra y, si se puede, enlaces simbólicos.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FLAG } from '../../protocol/src/index.ts';
import { TesseraEngine } from '../src/engine.ts';
import { launchArg, launchPath, quoteArg, stripQuotes } from '../src/launch.ts';
import { LINK_MAX_CHECKS, REPARSE_TAG_LX_SYMLINK, brokenLinks, checksTag, findData, isBrokenError, isBrokenLink } from '../src/links.ts';
import { EngineError } from '../src/messages.ts';
import { Store } from '../src/store.ts';

const base = path.join(process.env.TESSERA_TEST_DIR ?? os.tmpdir(), `tessera-links-${process.pid}`);
const R = path.join(base, 'Raíz');
let sym = false;

beforeAll(() => {
  fs.mkdirSync(path.join(R, 'destino'), { recursive: true });
  fs.mkdirSync(path.join(R, 'borrado'));
  fs.mkdirSync(path.join(R, 'sub'));
  fs.writeFileSync(path.join(R, 'destino', 'x.txt'), Buffer.alloc(10));
  fs.symlinkSync(path.join(R, 'destino'), path.join(R, 'bueno'), 'junction');
  fs.symlinkSync(path.join(R, 'borrado'), path.join(R, 'sub', 'roto'), 'junction');
  fs.symlinkSync(path.join(R, 'borrado'), path.join(R, 'Otro roto'), 'junction');
  // el destino desaparece: las dos uniones quedan rotas (sólo dentro de la carpeta temporal)
  fs.rmdirSync(path.join(R, 'borrado'));
  // enlaces simbólicos: con administrador o el modo de desarrollador
  try {
    fs.symlinkSync(path.join(R, 'no-existe.txt'), path.join(R, 'sim-roto'), 'file');
    fs.symlinkSync(path.join(R, 'destino', 'x.txt'), path.join(R, 'sim-bueno'), 'file');
    fs.symlinkSync(path.join(R, 'bucle-b'), path.join(R, 'bucle-a'), 'file');
    fs.symlinkSync(path.join(R, 'bucle-a'), path.join(R, 'bucle-b'), 'file');
    sym = true;
  } catch { /* sin permiso: sólo uniones */ }
});

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* el sistema limpiará %TEMP% */ }
});

test('checksTag: sólo enlaces simbólicos y uniones; isBrokenError', () => {
  expect(checksTag(0xA000000C)).toBe(true);
  expect(checksTag(0xA0000003)).toBe(true);
  for (const t of [REPARSE_TAG_LX_SYMLINK, 0x9000001A, 0x9000601A, 0x80000017, 0x80000013, 0x8000001B, 0xA000001F, 0xA0000027, 0]) expect(checksTag(t)).toBe(false);
  expect([2, 3, 1921].every(isBrokenError)).toBe(true);
  expect([0, 5, 21, 53, 1920].some(isBrokenError)).toBe(false);
});

test('isBrokenLink: lee la etiqueta en el momento y sigue el enlace', () => {
  const roto = path.join(R, 'sub', 'roto');
  const fd = findData(roto)!;
  expect(fd.tag >>> 0).toBe(0xA0000003);
  expect(isBrokenLink(roto)).toBe(true);
  expect(isBrokenLink(path.join(R, 'bueno'))).toBe(false);
  expect(isBrokenLink(path.join(R, 'destino'))).toBe(false); // carpeta normal
  expect(isBrokenLink(path.join(R, 'no-existe'))).toBe(false); // ya no está: no se sabe
  expect(isBrokenLink('C:\\')).toBe(false);
  if (sym) {
    expect(isBrokenLink(path.join(R, 'sim-roto'))).toBe(true);
    expect(isBrokenLink(path.join(R, 'sim-bueno'))).toBe(false);
    expect(isBrokenLink(path.join(R, 'bucle-a'))).toBe(true);
  }
});

test('engine: brokenLinks ordenado por ruta, con total, bytes y límite; no cambia el árbol', async () => {
  const e = new TesseraEngine({ threads: 0 });
  expect(await e.brokenLinks(0, 10).catch((x: EngineError) => x.code)).toBe('error.noScan');
  const r = await e.scan({ path: R, engine: 'walk' });
  const before = JSON.stringify(e.children({ id: r.rootId, offset: 0, limit: 100, sort: 'name', desc: false }));
  const rel = (rows: { path: string }[]) => rows.map(x => x.path.slice(R.length + 1));
  const all = await e.brokenLinks(r.rootId, 10);
  const want = sym ? ['bucle-a', 'bucle-b', 'Otro roto', 'sim-roto', 'sub\\roto'] : ['Otro roto', 'sub\\roto'];
  expect(rel(all.rows)).toEqual(want);
  expect(all.total).toBe(want.length);
  expect(all.totalBytes).toBe(all.rows.reduce((s, x) => s + x.size, 0));
  expect(all.rows.every(x => (x.flags & FLAG.REPARSE) !== 0 && typeof x.id === 'number')).toBe(true);
  const one = await e.brokenLinks(r.rootId, 1);
  expect([one.total, rel(one.rows)]).toEqual([want.length, [want[0]]]);
  const sub = e.search({ query: 'type:dir name:sub', root: r.rootId, limit: 1 }).rows[0].id;
  expect(rel((await e.brokenLinks(sub, 10)).rows)).toEqual(['sub\\roto']);
  const roto = all.rows.find(x => x.name === 'roto')!.id;
  expect((await e.brokenLinks(roto, 10)).total).toBe(1); // el propio nodo si es un enlace
  expect(await e.brokenLinks(99999, 10).catch((x: EngineError) => x.msg)).toEqual({ code: 'error.invalidNode', params: { id: 99999 }, message: 'Unknown node id: 99999' });
  // se mira en el momento: el destino vuelve a existir y ya no están rotas
  fs.mkdirSync(path.join(R, 'borrado'));
  try {
    expect(rel((await e.brokenLinks(r.rootId, 10)).rows)).toEqual(sym ? ['bucle-a', 'bucle-b', 'sim-roto'] : []);
  } finally { fs.rmdirSync(path.join(R, 'borrado')); }
  expect(JSON.stringify(e.children({ id: r.rootId, offset: 0, limit: 100, sort: 'name', desc: false }))).toBe(before);
  expect(fs.lstatSync(path.join(R, 'sub', 'roto')).isSymbolicLink()).toBe(true);
});

test('brokenLinks: candidatos con REPARSE (incluida la raíz), sin los muertos, y otro escaneo a mitad', async () => {
  const u = (s: string) => Uint16Array.from(s, c => c.charCodeAt(0));
  const st = new Store();
  const root = st.addRoot('C:\\x');
  const add = (p: number, name: string, dir: boolean, size: number, flags: number) => { const x = u(name); return st.add(p, x, 0, x.length, dir, size, size, 0, flags); };
  const b = add(root, 'b', true, 0, 0);
  add(b, 'Zeta', false, 10, FLAG.REPARSE);
  add(b, 'alfa', false, 20, FLAG.REPARSE);
  add(root, 'a b', true, 0, FLAG.REPARSE);
  add(root, 'c.txt', false, 5, 0);
  const d = add(root, 'd', false, 3, FLAG.REPARSE);
  st.finalize();
  const seen: string[] = [];
  const broken = (p: string) => { seen.push(p); return true; };
  const r = await brokenLinks(st, root, 10, { isBroken: broken, yieldEvery: 1 });
  expect(seen.length).toBe(4); // c.txt y las carpetas normales no se miran
  expect(r.rows.map(x => x.path)).toEqual(['C:\\x\\a b', 'C:\\x\\b\\alfa', 'C:\\x\\b\\Zeta', 'C:\\x\\d']);
  expect([r.total, r.totalBytes]).toEqual([4, 33]);
  expect((await brokenLinks(st, root, 2, { isBroken: broken })).rows.length).toBe(2);
  expect((await brokenLinks(st, d, 10, { isBroken: broken })).total).toBe(1);
  // lo que va a la papelera mientras tanto ya no sale
  const r2 = await brokenLinks(st, root, 10, { isBroken: p => { if (p.endsWith('alfa')) st.remove(b); return true; }, yieldEvery: 1 });
  expect(r2.rows.map(x => x.name)).toEqual(['a b', 'd']);
  // otro escaneo a mitad: verify lanza su error
  let n = 0;
  const stale = brokenLinks(st, root, 10, { isBroken: () => true, yieldEvery: 1, verify: () => { if (++n > 1) throw new EngineError({ code: 'error.invalidNode', message: 'x' }); } });
  expect(await stale.catch((x: EngineError) => x.code)).toBe('error.invalidNode');
  expect(LINK_MAX_CHECKS).toBe(200_000);
});

test('launchArg: primer argumento posicional, comillas sueltas, C: y barra final', () => {
  expect(stripQuotes('C:"')).toBe('C:');
  expect(stripQuotes(' "C:\\Program Files\\" --debug')).toBe('C:\\Program Files\\');
  expect(stripQuotes('C:\\Program Files" --debug')).toBe('C:\\Program Files');
  expect(launchArg(['C:"'])).toBe('C:\\'); // "C:\" llega así
  expect(launchArg(['c:'])).toBe('C:\\');
  expect(launchArg(['d:\\'])).toBe('D:\\');
  expect(launchArg(['C:\\carpeta\\'])).toBe('C:\\carpeta');
  expect(launchArg(['C:\\Program Files" --debug'])).toBe('C:\\Program Files');
  expect(launchArg(['--debug', '--threads=2', 'c:/Users/Ana/'])).toBe('C:\\Users\\Ana');
  expect(launchArg(['\\\\srv\\share\\x\\'])).toBe('\\\\srv\\share\\x');
  expect(launchArg(['.', 'otra'], 'D:\\datos')).toBe('D:\\datos');
  expect(launchArg(['sub\\..\\x'], 'D:\\datos')).toBe('D:\\datos\\x');
  for (const a of [[], ['--no-window'], [''], ['  '], ['"']]) expect(launchArg(a)).toBeNull();
});

test('launchPath: sólo carpetas que existen; quoteArg', () => {
  expect(launchPath([R + '\\'])).toBe(R);
  expect(launchPath(['C:"'])).toBe('C:\\');
  expect(launchPath([path.join(R, 'destino', 'x.txt')])).toBeNull(); // un archivo no
  expect(launchPath([path.join(R, 'no-existe')])).toBeNull();
  expect(launchPath([path.join(R, 'sub', 'roto')])).toBeNull(); // unión rota: no se puede abrir
  expect(launchPath([path.join(R, 'bueno')])).toBe(path.join(R, 'bueno'));
  expect(quoteArg('C:\\')).toBe('"C:\\\\"');
  expect(quoteArg('C:\\Program Files')).toBe('"C:\\Program Files"');
  expect(quoteArg('a\\"b')).toBe('"a\\\\\\"b"');
  expect(quoteArg('')).toBe('""');
});
