// Recorrido real sobre una carpeta temporal creada por la prueba (TESSERA_TEST_DIR o %TEMP%).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FLAG, decodeSlice } from '../../protocol/src/index.ts';
import { TesseraEngine, normalizePath } from '../src/engine.ts';
import { EngineError, errorResponse, isEngineMessage } from '../src/messages.ts';
import { walkScan } from '../src/walk.ts';
import { isElevated } from '../src/win32.ts';

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
    expect([w.denied, w.failed, w.deniedSample.length, w.failedSample.length]).toEqual([0, 0, 0, 0]);
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
  expect(r.warnings).toEqual([]);

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
  // attr: con las banderas leídas del disco
  expect(e.search({ query: 'attr:hidden', root: r.rootId, limit: 5 }).rows.map(x => x.name)).toEqual(['h.txt']);
  expect(e.search({ query: 'attr:hardlink', root: r.rootId, limit: 5 }).total).toBe(1);
  expect(e.search({ query: 'type:dir attr:reparse', root: r.rootId, limit: 5 }).rows.map(x => x.name)).toEqual(['jx']);
  expect(e.search({ query: 'attr:hidden,cloud -name:h.txt', root: r.rootId, limit: 5 }).total).toBe(0);

  const ex = e.extStats(r.rootId);
  expect(ex[0].ext).toBe('dll');
  expect(ex[0].count).toBe(2);

  const sub = nodes[1].id;
  expect(e.nodePath(sub)).toBe(path.join(R, 'sub'));
  expect(e.nodeInfo(sub).isDir).toBe(true);
  expect(e.nodeInfo(r.rootId).parentId).toBe(-1);
  expect(() => e.nodeInfo(99999)).toThrow(EngineError);
  const err = thrown(() => e.nodeInfo(99999));
  expect(err.msg).toEqual({ code: 'error.invalidNode', params: { id: 99999 }, message: 'Unknown node id: 99999' });

  // acciones que no tocan el disco
  expect(e.action('trash', r.rootId)).toEqual({ ok: false, code: 'action.trashRoot', message: 'The scanned folder itself cannot be sent to the Recycle Bin' });
  expect(e.action('bogus' as never, r.rootId)).toMatchObject({ ok: false, code: 'action.unknown', params: { kind: 'bogus' } });
});

function thrown(fn: () => unknown): EngineError {
  try { fn(); } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('expected an EngineError');
}
async function rejected(p: Promise<unknown>): Promise<EngineError> {
  try { await p; } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('expected an EngineError');
}

test('engine: MFT pedida sin administrador → aviso scan.mftNeedsAdmin y recorrido', async () => {
  const e = new TesseraEngine({ threads: 0 });
  (e as { elevated: boolean }).elevated = false; // simula una sesión sin administrador
  const r = await e.scan({ path: R, engine: 'mft' });
  expect(r.engine).toBe('walk');
  expect(r.files).toBe(8);
  expect(r.warnings).toEqual([{ code: 'scan.mftNeedsAdmin', message: expect.any(String) }]);
  expect(r.warnings.every(isEngineMessage)).toBe(true);
});

test('engine: si la lectura de la MFT falla → aviso scan.mftFailed con el detalle técnico en inglés', async () => {
  if (isElevated()) return; // con administrador la MFT se leería de verdad
  const e = new TesseraEngine({ threads: 0 });
  (e as { elevated: boolean }).elevated = true; // finge administrador: abrir el volumen fallará
  const r = await e.scan({ path: R, engine: 'mft' });
  expect(r.engine).toBe('walk');
  if (r.volume?.fs.toUpperCase() !== 'NTFS') {
    expect(r.warnings[0]).toMatchObject({ code: 'scan.mftUnsupportedFs', params: { fs: r.volume?.fs || '?' } });
    return;
  }
  expect(r.warnings).toHaveLength(1);
  const w = r.warnings[0];
  expect(w.code).toBe('scan.mftFailed');
  expect(String(w.params?.error)).toStartWith('cannot open volume ');
  expect(w.message).toStartWith('The MFT could not be read (cannot open volume ');
});

test('engine: errores con código (ruta no válida, no es carpeta, no existe, sin escaneo, ocupado)', async () => {
  const e = new TesseraEngine({ threads: 0 });
  expect(thrown(() => e.nodeInfo(0)).msg).toEqual({ code: 'error.noScan', message: 'Nothing has been scanned yet' });
  expect((await rejected(e.scan({ path: 'relativo', engine: 'walk' }))).msg)
    .toEqual({ code: 'error.invalidPath', params: { path: 'relativo' }, message: 'Invalid path (it must be absolute): relativo' });
  const file = path.join(R, 'a.bin');
  expect((await rejected(e.scan({ path: file, engine: 'walk' }))).msg).toMatchObject({ code: 'error.notFolder', params: { path: file } });
  const missing = path.join(R, 'no-existe');
  const m = (await rejected(e.scan({ path: missing, engine: 'walk' }))).msg;
  expect(m).toMatchObject({ code: 'error.cannotOpen', params: { path: missing } });
  expect(typeof m.params?.error).toBe('string');

  const first = e.scan({ path: R, engine: 'walk' });
  expect((await rejected(e.scan({ path: R, engine: 'walk' }))).msg.code).toBe('error.scanBusy');
  const ok = await first;

  // Una ruta que no sirve se rechaza sin soltar el árbol anterior
  expect((await rejected(e.scan({ path: missing, engine: 'walk' }))).msg.code).toBe('error.cannotOpen');
  expect((await rejected(e.scan({ path: file, engine: 'walk' }))).msg.code).toBe('error.notFolder');
  expect(e.nodeInfo(ok.rootId).size).toBe(ok.bytes);
});

test('engine: cancelar → error.cancelled, y se puede volver a escanear', async () => {
  const e = new TesseraEngine({ threads: 0 });
  expect(e.cancel()).toBe(false); // sin escaneo en curso
  const p = e.scan({ path: R, engine: 'walk' });
  expect(e.cancel()).toBe(true);
  expect((await rejected(p)).msg).toEqual({ code: 'error.cancelled', message: 'Scan cancelled' });
  expect(e.scanning).toBe(false);
  expect((await e.scan({ path: R, engine: 'walk' })).entries).toBeGreaterThan(0);
});

test('http: un error del motor viaja como EngineMessage JSON con su estado', async () => {
  const e = new TesseraEngine({ threads: 0 });
  await e.scan({ path: R, engine: 'walk' });
  let res: Response;
  try { e.nodeInfo(999999999); throw new Error('unreachable'); } catch (err) { res = errorResponse(err); }
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toStartWith('application/json');
  const body: unknown = await res.json();
  expect(isEngineMessage(body)).toBe(true);
  expect(body).toEqual({ code: 'error.invalidNode', params: { id: 999999999 }, message: 'Unknown node id: 999999999' });
});

test('engine: papelera (sólo con TESSERA_TEST_TRASH=1)', async () => {
  if (process.env.TESSERA_TEST_TRASH !== '1') return;
  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: R, engine: 'walk' });
  const id = e.search({ query: 'name:b.txt', root: r.rootId, limit: 1 }).rows[0].id;
  const res = e.action('trash', id);
  expect(res).toEqual({ ok: true, code: 'action.trashed', message: 'Moved to the Recycle Bin' });
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
  expect(() => normalizePath('relativo')).toThrow(EngineError);
  expect(thrown(() => normalizePath('relativo')).code).toBe('error.invalidPath');
});
