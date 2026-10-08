// Recorrido real sobre una carpeta temporal creada por la prueba (TESSERA_TEST_DIR o %TEMP%).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FLAG, decodeSlice } from '../../protocol/src/index.ts';
import { TesseraEngine, normalizePath } from '../src/engine.ts';
import { walkScan } from '../src/walk.ts';

const base = path.join(process.env.TESSERA_TEST_DIR ?? os.tmpdir(), `tessera-walk-${process.pid}`);
const R = path.join(base, 'Raíz con espacios');

beforeAll(() => {
  fs.mkdirSync(path.join(R, 'sub', 'deeper'), { recursive: true });
  fs.mkdirSync(path.join(R, 'empty'));
  fs.writeFileSync(path.join(R, 'a.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(R, 'b.txt'), Buffer.alloc(10));
  fs.writeFileSync(path.join(R, 'sub', 'c.dll'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(R, 'sub', 'd.DLL'), Buffer.alloc(300));
  fs.writeFileSync(path.join(R, 'sub', 'deeper', 'e.dat'), Buffer.alloc(1));
  fs.writeFileSync(path.join(R, 'hl1.bin'), Buffer.alloc(2000));
  fs.linkSync(path.join(R, 'hl1.bin'), path.join(R, 'sub', 'hl2.bin'));
  fs.symlinkSync(path.join(R, 'sub'), path.join(R, 'jx'), 'junction');
  fs.writeFileSync(path.join(R, 'h.txt'), 'abc');
  spawnSync('attrib', ['+h', path.join(R, 'h.txt')]);
});

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* el sistema limpiará %TEMP% */ }
});

function summary(s: Awaited<ReturnType<typeof walkScan>>['store']) {
  const out: Record<string, [number, number]> = {};
  for (let i = 1; i < s.n; i++) out[s.path(i).slice(R.length + 1)] = [s.sz[i], s.fl[i]];
  return out;
}

test('walk: un hilo y workers dan lo mismo; enlaces duros, junctions y ocultos', async () => {
  const runs = [];
  for (const threads of [0, 2]) {
    const w = await walkScan(R, { threads, trackKeys: true });
    expect(w.errors).toEqual([]);
    w.store.dedupHardlinks();
    w.store.finalize();
    runs.push(w.store);
  }
  const [a, b] = runs;
  expect(summary(a)).toEqual(summary(b));
  const s = a, root = s.rootId;
  expect(s.files(root)).toBe(8);
  expect(s.dirs(root)).toBe(4);
  expect(s.size(root)).toBe(1000 + 10 + 5000 + 300 + 1 + 2000 + 3);
  const byName = new Map<string, number>();
  for (let i = 1; i < s.n; i++) byName.set(s.path(i).slice(R.length + 1), i);
  const jx = byName.get('jx')!;
  expect(s.flags(jx) & (FLAG.REPARSE | FLAG.DIR)).toBe(FLAG.REPARSE | FLAG.DIR);
  expect(s.children(jx).length).toBe(0); // no se sigue
  expect(s.flags(byName.get('h.txt')!) & FLAG.HIDDEN).toBe(FLAG.HIDDEN);
  const h1 = byName.get('hl1.bin')!, h2 = byName.get('sub\\hl2.bin')!;
  expect([s.size(h1), s.size(h2)].sort()).toEqual([0, 2000]);
  expect((s.flags(h1) | s.flags(h2)) & FLAG.HARDLINK).toBe(FLAG.HARDLINK);
  expect(s.ext(byName.get('sub\\d.DLL')!)).toBe('dll');
  expect(s.mtime(byName.get('a.bin')!)).toBeGreaterThan(Date.now() / 1000 - 3600);
});

test('engine: escaneo, slice, hijos, búsqueda, extensiones y nodos', async () => {
  const e = new TesseraEngine({ threads: 2 });
  const phases = new Set<string>();
  const r = await e.scan({ path: R.replace(/\\/g, '/') + '/', engine: 'auto' }, p => phases.add(p.phase));
  expect(r.rootPath).toBe(R);
  expect(r.engine).toBe('walk');
  expect(r.files).toBe(8);
  expect(r.dirs).toBe(4);
  expect(r.entries).toBe(12);
  expect(r.bytes).toBe(8314);
  expect(r.volume?.fs).toBeTruthy();
  expect([...phases]).toEqual(['starting', 'walk', 'aggregate', 'done']);

  const { nodes } = decodeSlice(e.slice(r.rootId, 0, 1000));
  expect(nodes.length).toBe(13);
  expect(nodes[0].size).toBe(8314);
  expect(nodes[1].name).toBe('sub');

  const kids = e.children({ id: r.rootId, offset: 0, limit: 3, sort: 'name', desc: false });
  expect(kids.total).toBe(7);
  expect(kids.rows.map(k => k.name)).toEqual(['a.bin', 'b.txt', 'empty']);

  const s = e.search({ query: 'ext:dll', root: r.rootId, limit: 10 });
  expect(s.rows.map(x => x.name)).toEqual(['c.dll', 'd.DLL']);
  expect(s.rows[0].path).toBe(path.join(R, 'sub', 'c.dll'));
  expect(e.search({ query: '', root: r.rootId, limit: 1 }).rows[0].name).toBe('c.dll');
  expect(e.search({ query: 'type:dir name:"empty"', root: r.rootId, limit: 5 }).total).toBe(1);

  const ex = e.extStats(r.rootId);
  expect(ex[0].ext).toBe('dll');
  expect(ex[0].count).toBe(2);

  const sub = nodes[1].id;
  expect(e.nodePath(sub)).toBe(path.join(R, 'sub'));
  expect(e.nodeInfo(sub).isDir).toBe(true);
  expect(e.nodeInfo(r.rootId).parentId).toBe(-1);
  expect(() => e.nodeInfo(99999)).toThrow();
});

test('engine: papelera (sólo con TESSERA_TEST_TRASH=1)', async () => {
  if (process.env.TESSERA_TEST_TRASH !== '1') return;
  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: R, engine: 'walk' });
  const id = e.search({ query: 'name:b.txt', root: r.rootId, limit: 1 }).rows[0].id;
  const res = e.action('trash', id);
  expect(res).toEqual({ ok: true, message: 'Movido a la papelera' });
  expect(fs.existsSync(path.join(R, 'b.txt'))).toBe(false);
  expect(e.nodeInfo(r.rootId).size).toBe(8314 - 10);
  expect(e.children({ id: r.rootId, offset: 0, limit: 50, sort: 'size', desc: true }).rows.some(x => x.name === 'b.txt')).toBe(false);
  const fail = e.action('trash', id); // ya no existe en disco
  expect(fail.ok).toBe(false);
});

test('normalizePath', () => {
  expect(normalizePath('c:')).toBe('C:\\');
  expect(normalizePath('c:/')).toBe('C:\\');
  expect(normalizePath('c:/Windows/System32/')).toBe('C:\\Windows\\System32');
  expect(normalizePath('\\\\srv\\share\\x\\')).toBe('\\\\srv\\share\\x');
  expect(() => normalizePath('relativo')).toThrow();
});
