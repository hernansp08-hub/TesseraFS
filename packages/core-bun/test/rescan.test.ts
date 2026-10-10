// Volver a escanear una carpeta (rescan) sobre carpetas temporales creadas por la prueba (TESSERA_TEST_DIR o %TEMP%).
// El historial (para activar una comparación) va también a la carpeta de la prueba.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FLAG, decodeSlice, type NodeRow, type ScanProgress } from '../../protocol/src/index.ts';
import { TesseraEngine } from '../src/engine.ts';
import { EngineError, errorResponse } from '../src/messages.ts';

const base = path.resolve(process.env.TESSERA_TEST_DIR ?? os.tmpdir(), `tessera-rescan-${process.pid}`);
const R = path.join(base, 'Rescan raíz');
const R2 = path.join(base, 'otra');
const S = path.join(R, 'A', 'S'); // la carpeta que se vuelve a escanear
const MiB = 1 << 20;

const savedEnv = process.env.TESSERA_HISTORY_DIR;
process.env.TESSERA_HISTORY_DIR = path.join(base, 'history');

const put = (p: string, size: number) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size)); };

beforeAll(() => {
  put(path.join(R, 'top.bin'), 1000);
  put(path.join(R, 'A', 'a1.txt'), 100);
  put(path.join(S, 's1.dat'), 5000);
  put(path.join(S, 'gone.dat'), 3000);
  put(path.join(S, 'keep.log'), 700);
  put(path.join(S, 'inner', 'i1.bin'), 200);
  put(path.join(R, 'B', 'b1.bin'), MiB); // B empieza siendo mayor que A
  // para cancelar y para las reglas de ocupado: muchas carpetas pequeñas, y una junction
  for (let i = 0; i < 300; i++) put(path.join(R2, 'big', `d${i}`, 'f.bin'), 10 + i);
  fs.symlinkSync(path.join(R2, 'big'), path.join(R2, 'jx'), 'junction');
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.TESSERA_HISTORY_DIR; else process.env.TESSERA_HISTORY_DIR = savedEnv;
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* el sistema limpiará %TEMP% */ }
});

async function rejected(p: Promise<unknown>): Promise<EngineError> {
  try { await p; } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('expected an EngineError');
}
function thrown(fn: () => unknown): EngineError {
  try { fn(); } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('expected an EngineError');
}
const kids = (e: TesseraEngine, id: number): NodeRow[] => e.children({ id, offset: 0, limit: 1000, sort: 'size', desc: true }).rows;
const child = (e: TesseraEngine, id: number, name: string) => kids(e, id).find(r => r.name === name)!;

/** Todo lo que se ve del árbol (desde la raíz, por las listas de hijos), para comparar antes y después. */
function dump(e: TesseraEngine) {
  const s = e.store!, out: unknown[] = [];
  s.forEach(s.rootId, id => out.push([id, s.path(id), s.sz[id], s.al[id], s.nf[id], s.nd[id], s.mt[id], s.fl[id], Array.from(s.children(id))]));
  return { n: s.n, out };
}

test('rescan: injerta la carpeta con su id, corrige antepasados y todas las consultas ven el árbol nuevo', async () => {
  const e = new TesseraEngine({ threads: 2 }); // con workers, como un escaneo
  const r = await e.scan({ path: R, engine: 'walk' });
  const root = r.rootId;
  const A = child(e, root, 'A'), B = child(e, root, 'B'), top = child(e, root, 'top.bin');
  const a1 = child(e, A.id, 'a1.txt'), s = child(e, A.id, 'S');
  const old = kids(e, s.id), oldInner = old.find(x => x.name === 'inner')!;
  const oldI1 = child(e, oldInner.id, 'i1.bin');
  expect(kids(e, root).map(x => x.name)).toEqual(['B', 'A', 'top.bin']);
  expect(s.size).toBe(8900);
  const before = { root: e.nodeInfo(root), A, n: e.store!.n };

  // comparación activa (con un resumen del propio escaneo)
  const saved = e.historySave();
  e.compare(saved.id, 10);
  expect(e.nodeInfo(root).prev).toBe(r.bytes);

  // cambios dentro de S: +2 MiB, −gone.dat, una subcarpeta nueva con una extensión nueva, un duplicado y un enlace duro
  put(path.join(S, 'new2m.bin'), 2 * MiB);
  fs.rmSync(path.join(S, 'gone.dat'));
  put(path.join(S, 'sub2', 'deep.qqq'), 50);
  put(path.join(S, 'sub2', 'twin.bin'), 200); // mismo contenido que inner\i1.bin
  fs.linkSync(path.join(S, 's1.dat'), path.join(S, 'sub2', 's1-link.dat'));

  const events: ScanProgress[] = [];
  const res = await e.rescan(s.id, p => events.push(p));
  const newSize = 5000 + 700 + 200 + 2 * MiB + 50 + 200; // el enlace duro cuenta 0
  const diff = newSize - 8900;
  expect(res.row).toMatchObject({ id: s.id, parentId: A.id, name: 'S', isDir: true, size: newSize, files: 7, dirs: 2, childCount: 5 });
  expect(res.before).toBe(8900);
  expect(res.entries).toBe(9);
  expect(res.warnings).toEqual([]);
  expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(e.scanning).toBe(false);
  // progreso: recorrido con la ruta y, al final, done
  expect(events[0]).toMatchObject({ phase: 'walk', entries: 0, detail: S });
  expect(events.slice(0, -1).every(p => p.phase === 'walk')).toBe(true);
  expect(events.at(-1)).toMatchObject({ phase: 'done', entries: 9, bytes: newSize });

  // antepasados y raíz por diferencia (tamaño, archivos, carpetas); el orden entre hermanos se corrige
  expect(e.nodeInfo(A.id)).toMatchObject({ id: A.id, size: A.size + diff, files: A.files + 3, dirs: A.dirs + 1 });
  expect(e.nodeInfo(root)).toMatchObject({ size: before.root.size + diff, files: before.root.files + 3, dirs: before.root.dirs + 1 });
  expect(e.result).toMatchObject({ bytes: before.root.size + diff, files: before.root.files + 3, dirs: before.root.dirs + 1, entries: r.entries + 4 });
  expect(kids(e, root).map(x => x.name)).toEqual(['A', 'B', 'top.bin']);
  // lo de fuera conserva id, valores y ruta
  for (const x of [B, top, a1]) expect(e.nodeInfo(x.id)).toEqual(x);
  expect(e.nodePath(B.id)).toBe(path.join(R, 'B'));
  expect(e.nodePath(s.id)).toBe(S);

  // lo de dentro estrena ids; los antiguos ya no valen
  const now = kids(e, s.id);
  expect(now.map(x => x.name)).toEqual(['new2m.bin', 's1.dat', 'keep.log', 'sub2', 'inner']);
  expect(now.every(x => x.id >= before.n && x.parentId === s.id)).toBe(true);
  for (const x of [...old, oldI1]) {
    const err = thrown(() => e.nodeInfo(x.id));
    expect(err.msg).toMatchObject({ code: 'error.invalidNode', params: { id: x.id } });
    expect(errorResponse(err).status).toBe(404);
  }
  expect(thrown(() => e.children({ id: oldInner.id, offset: 0, limit: 10, sort: 'size', desc: true })).code).toBe('error.invalidNode');
  expect((await rejected(e.rescan(oldInner.id))).msg).toMatchObject({ code: 'error.invalidNode', params: { id: oldInner.id } });

  // enlaces duros dentro de lo vuelto a escanear: como en un escaneo (una copia a 0 con HARDLINK)
  const sub2 = now.find(x => x.name === 'sub2')!;
  const link = child(e, sub2.id, 's1-link.dat'), s1 = child(e, s.id, 's1.dat');
  expect([s1.size, link.size].sort()).toEqual([0, 5000]);
  expect(((s1.flags | link.flags) & FLAG.HARDLINK) !== 0).toBe(true);

  // search, nodePath, extStats, slice y duplicados
  const found = e.search({ query: 'name:new2m.bin', root, limit: 10 }).rows;
  expect(found.map(x => [x.id, x.path])).toEqual([[now[0].id, path.join(S, 'new2m.bin')]]);
  expect(e.search({ query: 'name:gone.dat', root, limit: 10 }).total).toBe(0);
  expect(e.search({ query: '', root, limit: 0 }).total).toBe(before.root.files + 3); // sólo archivos
  expect(e.search({ query: 'type:dir', root, limit: 0 }).total).toBe(before.root.dirs + 1);
  expect(e.nodePath(child(e, sub2.id, 'deep.qqq').id)).toBe(path.join(S, 'sub2', 'deep.qqq'));
  const ext = e.extStats(root);
  expect(ext.find(x => x.ext === 'qqq')).toEqual({ ext: 'qqq', size: 50, alloc: expect.any(Number), count: 1 });
  expect(ext.find(x => x.ext === 'dat')).toMatchObject({ size: 5000, count: 2 });
  expect(ext.find(x => x.ext === 'bin')).toMatchObject({ size: 1000 + MiB + 2 * MiB + 200 + 200, count: 5 });
  expect(e.extStats(s.id).reduce((t, x) => t + x.size, 0)).toBe(newSize);
  const { nodes } = decodeSlice(e.slice(root, 0, 1000));
  expect(nodes[0].size).toBe(before.root.size + diff);
  expect(nodes.map(x => x.name)).toContain('new2m.bin');
  expect(nodes.map(x => x.name)).not.toContain('gone.dat');
  const dups = await e.duplicates({ root, minSize: 1, limit: 10 });
  expect(dups.groups.map(g => g.files.map(f => f.path))).toEqual([[path.join(S, 'inner', 'i1.bin'), path.join(S, 'sub2', 'twin.bin')]]);
  expect(dups.skipped.hardlinks).toBe(1);

  // la comparación se quitó; se puede volver a activar sobre el árbol nuevo
  expect(e.store!.cmp).toBeNull();
  expect('prev' in e.nodeInfo(root)).toBe(false);
  expect(kids(e, s.id).some(x => 'prev' in x || 'fresh' in x)).toBe(false);
  const c = e.compare(saved.id, 10);
  expect(c.after.bytes).toBe(before.root.size + diff);
  expect(c.grew.map(x => x.path)).toContain(path.join(S, 'new2m.bin'));
  expect(c.removed).toEqual([]); // gone.dat (< 1 MiB) no estaba en el resumen
  expect(e.nodeInfo(s.id).prev).toBe(8900);

  // volver a escanear sin cambios deja los mismos valores (con ids nuevos dentro) y vuelve a quitar la comparación
  const again = await e.rescan(s.id);
  expect(again.row).toEqual({ ...res.row, mtime: again.row.mtime });
  expect(again.before).toBe(newSize);
  expect(e.store!.cmp).toBeNull();
  expect(kids(e, s.id).map(x => x.name)).toEqual(['new2m.bin', 's1.dat', 'keep.log', 'sub2', 'inner']);
  expect(thrown(() => e.nodeInfo(now[0].id)).code).toBe('error.invalidNode');
  expect(e.nodeInfo(root).size).toBe(before.root.size + diff);
  // el resumen del árbol injertado no lleva lo muerto
  expect(e.historySave().bytes).toBe(before.root.size + diff);
});

test('rescan: errores (sin escaneo, id, raíz, archivo, papelera) y refresh no disponible', async () => {
  const fresh = new TesseraEngine({ threads: 0 });
  expect((await rejected(fresh.rescan(1))).msg).toEqual({ code: 'error.noScan', message: 'Nothing has been scanned yet' });
  const un = await rejected(fresh.refresh(() => { }));
  expect(un.msg).toEqual({ code: 'refresh.unavailable', message: 'Quick update needs the desktop edition with administrator rights on a local NTFS drive' });
  expect(errorResponse(un).status).toBe(409);

  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: R, engine: 'walk' });
  expect(r.canRefresh).toBeFalsy();
  expect((await rejected(e.refresh(() => { }))).code).toBe('refresh.unavailable');
  const bad = await rejected(e.rescan(999999));
  expect(bad.msg).toMatchObject({ code: 'error.invalidNode', params: { id: 999999 } });
  const rootErr = await rejected(e.rescan(r.rootId));
  expect(rootErr.msg).toEqual({ code: 'rescan.root', message: "The scan root can't be rescanned on its own: scan it again" });
  expect(errorResponse(rootErr).status).toBe(400);
  const top = child(e, r.rootId, 'top.bin');
  const nf = await rejected(e.rescan(top.id));
  expect(nf.msg).toMatchObject({ code: 'error.notFolder', params: { path: path.join(R, 'top.bin') } });
  expect(errorResponse(nf).status).toBe(400);
  // quitada del árbol (papelera; aquí sin la papelera): su id y los de dentro dejan de valer
  const B = child(e, r.rootId, 'B'), b1 = child(e, B.id, 'b1.bin');
  expect(e.store!.remove(B.id)).toBe(true);
  expect((await rejected(e.rescan(B.id))).code).toBe('error.invalidNode');
  expect(thrown(() => e.nodeInfo(b1.id)).code).toBe('error.invalidNode');
  expect(e.scanning).toBe(false);
});

test('rescan: reglas de ocupado (escaneo, rescan, duplicados) y las consultas siguen durante el rescan', async () => {
  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: R2, engine: 'walk' });
  const big = child(e, r.rootId, 'big');

  const running = e.rescan(big.id);
  expect(e.scanning).toBe(true);
  expect((await rejected(e.rescan(big.id))).msg).toEqual({ code: 'error.scanBusy', message: 'A scan is already in progress' });
  expect((await rejected(e.scan({ path: R2, engine: 'walk' }))).code).toBe('error.scanBusy');
  expect((await rejected(e.duplicates({ root: r.rootId, minSize: 1, limit: 10 }))).code).toBe('error.scanBusy');
  expect(thrown(() => e.historySave()).code).toBe('error.scanBusy');
  expect(kids(e, r.rootId).map(x => x.name)).toEqual(['big', 'jx']); // el árbol anterior sigue sirviendo
  expect((await running).row.id).toBe(big.id);

  const dup = e.duplicates({ root: r.rootId, minSize: 1, limit: 10 });
  expect((await rejected(e.rescan(big.id))).msg).toEqual({ code: 'error.dupBusy', message: 'A duplicate search is already in progress' });
  await dup;

  const scanning = e.scan({ path: R2, engine: 'walk' });
  expect((await rejected(e.rescan(big.id))).code).toBe('error.scanBusy');
  await scanning;
});

test('rescan: cancelar al empezar o a mitad → error.cancelled y el árbol queda igual', async () => {
  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: R2, engine: 'walk' });
  const big = child(e, r.rootId, 'big');
  put(path.join(R2, 'big', 'extra.bin'), 12345); // un cambio que no debe aparecer
  const was = dump(e);

  const p = e.rescan(big.id);
  expect(e.cancel()).toBe(true);
  expect((await rejected(p)).msg).toEqual({ code: 'error.cancelled', message: 'Scan cancelled' });
  expect(e.scanning).toBe(false);
  expect(dump(e)).toEqual(was);

  const events: ScanProgress[] = [];
  const err = await rejected(e.rescan(big.id, x => { events.push(x); if (x.phase === 'walk' && x.entries > 0) e.cancel(); }));
  expect(err.code).toBe('error.cancelled');
  expect(events.some(x => x.phase === 'walk' && x.entries > 0)).toBe(true);
  expect(events.at(-1)!.phase).toBe('error');
  expect(dump(e)).toEqual(was);
  expect(e.cancel()).toBe(false);

  // y después sí
  const ok = await e.rescan(big.id);
  expect(ok.row.size).toBe(big.size + 12345);
  expect(ok.entries).toBe(601);
});

test('rescan: una junction no se sigue (queda vacía, como en el escaneo)', async () => {
  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: R2, engine: 'walk' });
  const jx = child(e, r.rootId, 'jx');
  expect(jx.flags & FLAG.REPARSE).toBe(FLAG.REPARSE);
  const res = await e.rescan(jx.id);
  expect(res.entries).toBe(0);
  expect(res.row).toMatchObject({ id: jx.id, size: 0, files: 0, dirs: 0, childCount: 0 });
  expect(res.row.flags & FLAG.REPARSE).toBe(FLAG.REPARSE);
  expect(e.nodeInfo(r.rootId).size).toBe(r.bytes);
});
