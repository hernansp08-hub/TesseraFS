// Historial, comparación y exportación sobre carpetas temporales: TESSERA_HISTORY_DIR y TESSERA_EXPORT_DIR apuntan
// a la carpeta de la prueba, así que nunca se toca el historial real ni las Descargas del usuario. Nunca se llama a
// revealExport con un archivo válido (abriría el Explorador).
import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HistoryEntry } from '../../protocol/src/index.ts';
import { TesseraEngine } from '../src/engine.ts';
import {
  COMPARE_MAX_LIMIT, HISTORY_KEEP, compareSnapshot, exportDir, exportedFile, fnv1a32, historyDir, historyId, parseSnapshot, pathHash,
} from '../src/history.ts';
import { EngineError, errorResponse } from '../src/messages.ts';
import { Store } from '../src/store.ts';
import { FOLDERID, knownFolder } from '../src/win32.ts';

const base = path.resolve(process.env.TESSERA_TEST_DIR ?? os.tmpdir(), `tessera-hist-${process.pid}`);
const R = path.join(base, 'Hist raíz');  // la que se compara (con un carácter no ASCII: el hash es de UTF-8)
const R2 = path.join(base, 'otra');
const HD = path.join(base, 'history');
const XD = path.join(base, 'export');
const MiB = 1 << 20;

// antes de cualquier llamada al motor (las carpetas se leen en cada llamada)
const savedEnv = { h: process.env.TESSERA_HISTORY_DIR, x: process.env.TESSERA_EXPORT_DIR };
process.env.TESSERA_HISTORY_DIR = HD;
process.env.TESSERA_EXPORT_DIR = XD;

afterAll(() => {
  restoreEnv();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* el sistema limpiará %TEMP% */ }
});
function restoreEnv() {
  if (savedEnv.h === undefined) delete process.env.TESSERA_HISTORY_DIR; else process.env.TESSERA_HISTORY_DIR = savedEnv.h;
  if (savedEnv.x === undefined) delete process.env.TESSERA_EXPORT_DIR; else process.env.TESSERA_EXPORT_DIR = savedEnv.x;
}

const put = (root: string, rel: string, size: number) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
};
const rel = (p: string, root = R) => p.slice(root.length + 1);

function caught(fn: () => unknown): EngineError {
  try { fn(); } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('expected an EngineError');
}

/** FNV-1a de referencia, independiente de la del motor (BigInt). */
function refHash(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s.toLowerCase())) { h = (h ^ b) >>> 0; h = Number((BigInt(h) * 0x01000193n) & 0xffffffffn); }
  return h.toString(16).padStart(8, '0');
}
const stamp = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';

// escenario: antes → 8 archivos, 6 carpetas; en el resumen entran las carpetas y los archivos ≥ 1 MiB
put(R, 'proj\\readme.txt', 100);
put(R, 'keep\\big.bin', 2 * MiB);
put(R, 'keep\\small.txt', 10240);
put(R, 'keep\\tiny.txt', 1024);
put(R, 'gone\\old.bin', 2 * MiB);
put(R, 'gone\\inner\\x.txt', 5000);
put(R, 'stable\\s.bin', 1.5 * MiB);
put(R, 'Case\\c.txt', 300);
put(R2, 'a.bin', 2 * MiB);
put(R2, 'sub\\b.txt', 10);
const BEFORE_BYTES = 100 + 2 * MiB + 10240 + 1024 + 2 * MiB + 5000 + 1.5 * MiB + 300;

const e = new TesseraEngine({ threads: 0 });
let saved: HistoryEntry;

test('id: FNV-1a de 32 bits de la ruta en minúsculas (UTF-8), 8 dígitos hex', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  expect(fnv1a32(enc('')).toString(16)).toBe('811c9dc5');
  expect(fnv1a32(enc('a')).toString(16)).toBe('e40c292c');
  expect(fnv1a32(enc('foobar')).toString(16)).toBe('bf9cf968');
  expect(pathHash('C:\\')).toBe('1cf80bec');
  expect(pathHash('c:\\')).toBe('1cf80bec');
  expect(pathHash('D:\\Datos')).toBe('b5adc818');
  expect(pathHash('C:\\Users\\JOSÉ')).toBe('5f3b3e78'); // é en minúsculas, 2 bytes UTF-8
  expect(pathHash(R)).toBe(refHash(R));
  expect(historyId('C:\\', new Date(Date.UTC(2026, 9, 10, 17, 45, 12, 999)))).toBe('20261010T174512Z-1cf80bec');
});

test('carpetas: variables de entorno y, sin ellas, %LOCALAPPDATA% y la carpeta conocida de Descargas (sin escribir)', () => {
  expect(historyDir()).toBe(HD);
  expect(exportDir()).toBe(XD);
  delete process.env.TESSERA_HISTORY_DIR; delete process.env.TESSERA_EXPORT_DIR;
  try {
    expect(historyDir()).toBe(path.join(process.env.LOCALAPPDATA!, 'TesseraFS', 'history'));
    const downloads = knownFolder(FOLDERID.Downloads);
    expect(downloads).toMatch(/^[A-Za-z]:\\/);
    expect(exportDir()).toBe(path.join(downloads!, 'TesseraFS'));
  } finally {
    process.env.TESSERA_HISTORY_DIR = HD; process.env.TESSERA_EXPORT_DIR = XD;
  }
});

test('historySave: errores sin escaneo, formato del .json y del .snap.gz', async () => {
  expect(caught(() => e.historySave()).msg).toEqual({ code: 'error.noScan', message: 'Nothing has been scanned yet' });
  expect(caught(() => e.compare('x', 10)).msg.code).toBe('error.noScan');
  expect(e.historyList()).toEqual([]); // la carpeta aún no existe

  const t0 = Date.now();
  const r = await e.scan({ path: R, engine: 'walk' });
  const t1 = Date.now();
  saved = e.historySave();
  const t2 = Date.now();

  expect(saved.id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  expect(saved.id.slice(17)).toBe(refHash(R));
  expect(saved.id.slice(0, 16) >= stamp(t1) && saved.id.slice(0, 16) <= stamp(t2)).toBe(true);
  expect(saved.scannedAt).toBeGreaterThanOrEqual(Math.floor(t0 / 1000));
  expect(saved.scannedAt).toBeLessThanOrEqual(Math.floor(t1 / 1000));
  const snapPath = path.join(HD, `${saved.id}.snap.gz`), jsonPath = path.join(HD, `${saved.id}.json`);
  expect(saved).toEqual({
    id: saved.id, path: R, scannedAt: saved.scannedAt, engine: 'walk', bytes: BEFORE_BYTES, files: 8, dirs: 6,
    nodes: 10, fileBytes: fs.statSync(snapPath).size,
  });
  expect(r.bytes).toBe(BEFORE_BYTES);

  // <id>.json: el HistoryEntry, con las claves en el orden del contrato
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  expect(Object.keys(j)).toEqual(['id', 'path', 'scannedAt', 'engine', 'bytes', 'files', 'dirs', 'nodes', 'fileBytes']);
  expect(j).toEqual(saved);

  // <id>.snap.gz: gzip de {"v":1,"path":…,"scannedAt":…,"nodes":[[parent,name,isDir,size,alloc,files,dirs,mtime],…]}
  const text = new TextDecoder().decode(Bun.gunzipSync(fs.readFileSync(snapPath)));
  expect(text.startsWith(`{"v":1,"path":${JSON.stringify(R)},"scannedAt":${saved.scannedAt},"nodes":[[-1,${JSON.stringify(R)},1,${BEFORE_BYTES},`)).toBe(true);
  const snap = JSON.parse(text);
  expect(Object.keys(snap)).toEqual(['v', 'path', 'scannedAt', 'nodes']);
  const root = e.nodeInfo(r.rootId);
  expect(snap.nodes[0]).toEqual([-1, R, 1, BEFORE_BYTES, root.alloc, 8, 6, root.mtime]);
  const full = (i: number): string => i === 0 ? '' : (snap.nodes[i][0] === 0 ? '' : full(snap.nodes[i][0]) + '\\') + snap.nodes[i][1];
  snap.nodes.forEach((n: unknown[], i: number) => {
    expect(n).toHaveLength(8);
    if (i) { expect(n[0] as number).toBeLessThan(i); expect(snap.nodes[n[0] as number][2]).toBe(1); }
    expect([0, 1]).toContain(n[2] as number);
    if (n[2] === 0) { expect(n[3] as number).toBeGreaterThanOrEqual(MiB); expect([n[5], n[6]]).toEqual([0, 0]); }
  });
  expect(snap.nodes.map((_: unknown, i: number) => full(i)).sort()).toEqual(
    ['', 'Case', 'gone', 'gone\\inner', 'gone\\old.bin', 'keep', 'keep\\big.bin', 'proj', 'stable', 'stable\\s.bin'].sort());
  const big = snap.nodes.find((n: unknown[]) => n[1] === 'big.bin');
  expect(big.slice(2, 4)).toEqual([0, 2 * MiB]);

  expect(e.historyList()).toEqual([saved]);
});

test('compare: before/after, grew, shrank, removed, prev/fresh en las filas, orden delta y compareClear', async () => {
  // cambios: carpeta nueva con 3 MiB, un archivo de 2 → 5 MiB, una carpeta borrada (con 2 MiB), un archivo pequeño
  // borrado, otro nuevo, uno que mengua, un cambio de mayúsculas y una carpeta nueva con varios archivos
  put(R, 'proj\\nuevo\\three.bin', 3 * MiB);
  fs.appendFileSync(path.join(R, 'keep', 'big.bin'), Buffer.alloc(3 * MiB));
  fs.rmSync(path.join(R, 'gone'), { recursive: true });
  fs.rmSync(path.join(R, 'keep', 'small.txt'));
  put(R, 'keep\\newsmall.txt', 500);
  fs.truncateSync(path.join(R, 'stable', 's.bin'), 512 * 1024);
  fs.renameSync(path.join(R, 'Case'), path.join(R, 'CASE'));
  put(R, 'multi\\m1.bin', MiB);
  put(R, 'multi\\m2.bin', MiB);
  put(R, 'multi\\m3.txt', 2000);
  const AFTER_BYTES = 100 + 3 * MiB + 5 * MiB + 1024 + 500 + 512 * 1024 + 300 + 2 * MiB + 2000;

  const r = await e.scan({ path: R, engine: 'walk' });
  const c = e.compare(saved.id, 100);
  expect(c.entry).toEqual(saved);
  expect(c.before).toEqual({ bytes: BEFORE_BYTES, files: 8, dirs: 6 });
  expect(c.after).toEqual({ bytes: AFTER_BYTES, files: 10, dirs: 6 });
  expect(r.bytes).toBe(AFTER_BYTES);

  // lo que explica el crecimiento: ni proj ni proj\nuevo (un solo hijo explica ≥ 75 %), ni keep (big.bin);
  // multi sí (ningún hijo llega al 75 %). Empate big.bin / three.bin → por ruta
  expect(c.grew.map(x => [rel(x.path), x.size, x.prev])).toEqual([
    ['keep\\big.bin', 5 * MiB, 2 * MiB],
    ['proj\\nuevo\\three.bin', 3 * MiB, null],
    ['multi', 2 * MiB + 2000, null],
    ['multi\\m1.bin', MiB, null],
    ['multi\\m2.bin', MiB, null],
    ['multi\\m3.txt', 2000, null],
  ]);
  expect(c.grew[0].fresh).toBeUndefined();
  expect(c.grew.slice(1).every(x => x.fresh === true)).toBe(true);
  expect(c.grew[2]).toMatchObject({ name: 'multi', isDir: true, files: 3, parentId: r.rootId });
  expect(c.shrank.map(x => [rel(x.path), x.size, x.prev])).toEqual([['stable\\s.bin', 512 * 1024, 1.5 * MiB]]);
  expect(c.removed).toEqual([{ path: path.join(R, 'gone'), isDir: true, size: 2 * MiB + 5000 }]);

  // límite acotado a 1..1000
  expect(e.compare(saved.id, 3).grew).toHaveLength(3);
  expect(e.compare(saved.id, 0).grew.map(x => rel(x.path))).toEqual(['keep\\big.bin']);
  expect(e.compare(saved.id, 1e9).grew).toHaveLength(6);
  expect(COMPARE_MAX_LIMIT).toBe(1000);

  // filas con prev/fresh mientras la comparación está activa
  const kids = (id: number, sort: 'delta' | 'name', desc: boolean) => e.children({ id, offset: 0, limit: 50, sort, desc }).rows;
  const top = kids(r.rootId, 'delta', true);
  expect(top.map(x => x.name)).toEqual(['proj', 'keep', 'multi', 'CASE', 'stable']);
  expect(kids(r.rootId, 'delta', false).map(x => x.name)).toEqual(['stable', 'CASE', 'multi', 'keep', 'proj']);
  const by = Object.fromEntries(top.map(x => [x.name, x]));
  expect(by.proj.prev).toBe(100);
  expect(by.keep.prev).toBe(2 * MiB + 10240 + 1024);
  expect(by.CASE.prev).toBe(300); // emparejado sin distinguir mayúsculas
  expect(by.stable.prev).toBe(1.5 * MiB);
  expect(by.multi.fresh).toBe(true);
  expect('prev' in by.multi).toBe(false);
  expect('fresh' in by.proj).toBe(false);
  const keep = kids(by.keep.id, 'name', false);
  expect(keep.map(x => [x.name, x.prev, x.fresh])).toEqual([
    ['big.bin', 2 * MiB, undefined],
    ['newsmall.txt', undefined, undefined], // archivo pequeño que no está en el resumen: desconocido
    ['tiny.txt', undefined, undefined],
  ]);
  expect(e.nodeInfo(by.multi.id).fresh).toBe(true);
  expect(e.nodeInfo(r.rootId).prev).toBe(BEFORE_BYTES);
  const found = e.search({ query: 'three', root: r.rootId, limit: 10 }).rows;
  expect(found.map(x => [x.name, x.fresh, x.path])).toEqual([['three.bin', true, path.join(R, 'proj', 'nuevo', 'three.bin')]]);
  const dups = await e.duplicates({ root: r.rootId, minSize: 1, limit: 10 });
  expect(dups.groups.map(g => g.files.map(f => [f.name, f.fresh]))).toEqual([[['m1.bin', true], ['m2.bin', true]]]);

  // lo que se quita del árbol (papelera; aquí sin la papelera) se refleja en los tamaños, prev no cambia
  const nuevo = kids(by.proj.id, 'name', false).find(x => x.name === 'nuevo')!;
  expect(e.store!.remove(nuevo.id)).toBe(true);
  expect(kids(r.rootId, 'delta', true).map(x => x.name)).toEqual(['keep', 'multi', 'CASE', 'proj', 'stable']);
  expect(e.nodeInfo(by.proj.id)).toMatchObject({ size: 100, prev: 100 });
  expect(e.compare(saved.id, 100).grew.map(x => rel(x.path))).toEqual(['keep\\big.bin', 'multi', 'multi\\m1.bin', 'multi\\m2.bin', 'multi\\m3.txt']);

  // compareClear: sin prev/fresh y 'delta' = por nombre
  e.compareClear();
  const plain = kids(r.rootId, 'delta', true);
  expect(plain.map(x => x.name)).toEqual(['CASE', 'keep', 'multi', 'proj', 'stable']);
  expect(plain.some(x => 'prev' in x || 'fresh' in x)).toBe(false);
  expect('prev' in e.nodeInfo(r.rootId)).toBe(false);

  // un escaneo nuevo la desactiva
  e.compare(saved.id, 10);
  expect(e.nodeInfo(r.rootId).prev).toBe(BEFORE_BYTES);
  const r2 = await e.scan({ path: R, engine: 'walk' });
  expect('prev' in e.nodeInfo(r2.rootId)).toBe(false);
  expect(e.children({ id: r2.rootId, offset: 0, limit: 50, sort: 'delta', desc: true }).rows.map(x => x.name))
    .toEqual(['CASE', 'keep', 'multi', 'proj', 'stable']);
});

test('compare: notFound, otherRoot, readFailed, ocupado, y un resumen escrito a mano (como el del motor Rust)', async () => {
  const notFound = (id: string) => caught(() => e.compare(id, 10)).msg;
  expect(notFound('20000101T000000Z-00000000')).toEqual({
    code: 'history.notFound', params: { id: '20000101T000000Z-00000000' }, message: 'Snapshot not found: 20000101T000000Z-00000000',
  });
  expect(notFound('..\\x').code).toBe('history.notFound');
  expect(notFound('a/b').code).toBe('history.notFound');
  expect(notFound('').code).toBe('history.notFound');
  expect(errorResponse(caught(() => e.compare('nope', 1))).status).toBe(404);

  // otra raíz → otherRoot (409); la comparación activa no cambia
  const e2 = new TesseraEngine({ threads: 0 });
  await e2.scan({ path: R2, engine: 'walk' });
  const other = caught(() => e2.compare(saved.id, 10));
  expect(other.msg).toEqual({ code: 'history.otherRoot', params: { path: R }, message: `That snapshot is of another folder (${R})` });
  expect(errorResponse(other).status).toBe(409);

  // resumen escrito a mano para R2 (raíz y nombres con otras mayúsculas; claves del .json en otro orden)
  const id = '20250101T000000Z-' + pathHash(R2);
  const nodes = [
    [-1, R2.toUpperCase(), 1, 7 * MiB, 7 * MiB, 2, 1, 0],
    [0, 'A.BIN', 0, MiB, MiB, 0, 0, 0],
    [0, 'SUB', 1, 4 * MiB, 4 * MiB, 1, 0, 0],
    [2, 'gone.bin', 0, 4 * MiB, 4 * MiB, 0, 0, 0],
  ];
  fs.writeFileSync(path.join(HD, `${id}.snap.gz`), Bun.gzipSync(Buffer.from(JSON.stringify({ v: 1, path: R2.toUpperCase(), scannedAt: 1735689600, nodes }))));
  const entry: HistoryEntry = { id, path: R2.toUpperCase(), scannedAt: 1735689600, engine: 'mft', bytes: 7 * MiB, files: 2, dirs: 1, nodes: 4, fileBytes: 1 };
  fs.writeFileSync(path.join(HD, `${id}.json`), JSON.stringify({ fileBytes: 1, nodes: 4, dirs: 1, files: 2, bytes: 7 * MiB, engine: 'mft', scannedAt: 1735689600, path: entry.path, id, extra: true }));
  expect(e2.historyList().map(x => x.id)).toEqual([saved.id, id]);
  expect(e2.historyList()[1]).toEqual(entry);
  const c = e2.compare(id, 10);
  expect(c.entry).toEqual(entry);
  expect(c.before).toEqual({ bytes: 7 * MiB, files: 2, dirs: 1 });
  expect(c.after).toEqual({ bytes: 2 * MiB + 10, files: 2, dirs: 1 });
  expect(c.grew.map(x => [rel(x.path, R2), x.prev])).toEqual([['a.bin', MiB]]);
  expect(c.shrank.map(x => [rel(x.path, R2), x.prev])).toEqual([['sub', 4 * MiB]]); // b.txt (desconocido) no explica nada
  expect(c.removed).toEqual([{ path: path.join(R2.toUpperCase(), 'SUB', 'gone.bin'), isDir: false, size: 4 * MiB }]); // ruta del resumen

  // resúmenes dañados → readFailed (500); la comparación anterior sigue activa
  const bad = '20250101T000001Z-' + pathHash(R2), badJson = path.join(HD, `${bad}.json`), badSnap = path.join(HD, `${bad}.snap.gz`);
  fs.writeFileSync(badJson, JSON.stringify({ ...entry, id: bad }));
  fs.writeFileSync(badSnap, 'esto no es gzip');
  const rf = caught(() => e2.compare(bad, 10));
  expect(rf.msg.code).toBe('history.readFailed');
  expect(errorResponse(rf).status).toBe(500);
  for (const snap of [{ v: 2, path: R2, scannedAt: 0, nodes }, { v: 1, path: R2, scannedAt: 0, nodes: [[0, R2, 1, 0, 0, 0, 0, 0]] },
    { v: 1, path: R2, scannedAt: 0, nodes: [nodes[0], [5, 'x', 0, 1, 1, 0, 0, 0]] }, { v: 1, path: R2, scannedAt: 0, nodes: [] }]) {
    fs.writeFileSync(badSnap, Bun.gzipSync(Buffer.from(JSON.stringify(snap))));
    expect(caught(() => e2.compare(bad, 10)).msg.code).toBe('history.readFailed');
  }
  fs.writeFileSync(badJson, '{"id":');
  expect(caught(() => e2.compare(bad, 10)).msg.code).toBe('history.readFailed');
  // resumen legible pero de otra ruta (en el .json): otherRoot con la ruta del .json
  fs.writeFileSync(badSnap, fs.readFileSync(path.join(HD, `${id}.snap.gz`)));
  fs.writeFileSync(badJson, JSON.stringify({ ...entry, id: bad, path: R }));
  expect(caught(() => e2.compare(bad, 10)).msg).toMatchObject({ code: 'history.otherRoot', params: { path: R } });
  expect(e2.nodeInfo(e2.result!.rootId).prev).toBe(7 * MiB);
  expect(e2.historyDelete(bad)).toBe(true);
  expect(e2.historyDelete(id)).toBe(true);

  // ocupado: durante un escaneo → scanBusy; durante una búsqueda de duplicados se puede guardar y comparar
  const scanning = e.scan({ path: R, engine: 'walk' });
  expect(caught(() => e.historySave()).msg.code).toBe('error.scanBusy');
  expect(caught(() => e.compare(saved.id, 10)).msg.code).toBe('error.scanBusy');
  expect(errorResponse(caught(() => e.historySave())).status).toBe(409);
  const r = await scanning;
  const dup = e.duplicates({ root: r.rootId, minSize: 1, limit: 10 });
  expect(e.dupRunning).toBe(true);
  const during = e.historySave();
  expect(e.compare(saved.id, 10).removed).toHaveLength(1);
  await dup;
  expect(e.historyDelete(during.id)).toBe(true);
  expect(e.historyList()).toEqual([saved]);

  // la ruta de la raíz se compara sin distinguir mayúsculas
  const e3 = new TesseraEngine({ threads: 0 });
  await e3.scan({ path: R.toUpperCase(), engine: 'walk' });
  expect(e3.compare(saved.id, 10).removed.map(x => x.path)).toEqual([path.join(R, 'gone')]);
});

test('compare: nombres repetidos sin distinguir mayúsculas → vale el primero del resumen y el primer hijo (como Rust)', () => {
  for (const extra of [0, 9]) { // búsqueda lineal (≤ 8 hijos) e índice por nombre
    const s = new Store(64);
    s.addRoot('C:\\T');
    const add = (name: string) => { const u = Uint16Array.from(name, ch => ch.charCodeAt(0)); return s.add(0, u, 0, u.length, true, 0, 0, 0, 0); };
    const A = add('A'), a = add('a');
    for (let i = 0; i < extra; i++) add(`d${i}`);
    s.finalize();
    const nodes = [[-1, 'C:\\T', 1, 30, 30, 0, 2 + extra, 0], [0, 'a', 1, 10, 10, 0, 0, 0], [0, 'A', 1, 20, 20, 0, 0, 0]];
    for (let i = 0; i < extra; i++) nodes.push([0, `D${i}`, 1, 0, 0, 0, 0, 0]);
    const snap = parseSnapshot(Bun.gzipSync(Buffer.from(JSON.stringify({ v: 1, path: 'C:\\T', scannedAt: 0, nodes }))));
    const entry: HistoryEntry = { id: 'x', path: 'C:\\T', scannedAt: 0, engine: 'walk', bytes: 30, files: 0, dirs: 2 + extra, nodes: nodes.length, fileBytes: 0 };
    const c = compareSnapshot(s, entry, snap, 10);
    expect([s.row(A).prev, s.row(A).fresh, s.row(a).prev, s.row(a).fresh]).toEqual([10, undefined, undefined, true]);
    expect(c.removed).toEqual([{ path: 'C:\\T\\A', isDir: true, size: 20 }]);
    expect(c.shrank.map(x => x.name)).toEqual(['A']);
  }
});

test('historial: retención de 20 por ruta, delete y clear (sin tocar otros archivos)', async () => {
  const e2 = new TesseraEngine({ threads: 0 });
  await e2.scan({ path: R2, engine: 'walk' });
  const other = e2.historySave();
  fs.writeFileSync(path.join(HD, 'notas.txt'), 'x');
  fs.writeFileSync(path.join(HD, 'otro.json'), '{}');
  fs.writeFileSync(path.join(HD, '20200101T000000Z-0badc0de.snap.gz'), 'huérfano'); // sin .json: no se lista

  const ids = [saved.id];
  for (let i = 0; i < HISTORY_KEEP; i++) ids.push(e.historySave().id); // 21 de R en total
  expect(new Set(ids).size).toBe(21);
  for (const id of ids) expect(id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}(-\d+)?$/);
  const mine = e.historyList().filter(x => x.path === R);
  expect(mine).toHaveLength(20);
  expect(mine.map(x => x.id)).toEqual(ids.slice(1).reverse()); // el más reciente primero
  expect(fs.existsSync(path.join(HD, `${ids[0]}.json`)) || fs.existsSync(path.join(HD, `${ids[0]}.snap.gz`))).toBe(false);
  expect(e.historyList().map(x => x.id)).toContain(other.id); // otra ruta: no cuenta
  expect(caught(() => e.compare(ids[0], 10)).msg.code).toBe('history.notFound');

  expect(e.historyDelete(ids[20])).toBe(true);
  expect(e.historyDelete(ids[20])).toBe(false);
  expect(caught(() => e.historyDelete('a/b')).msg).toMatchObject({ code: 'history.notFound', params: { id: 'a/b' } });
  expect(caught(() => e.historyDelete('..')).msg.code).toBe('history.notFound');
  expect(e.historyList()).toHaveLength(20);

  expect(e.historyClear()).toBe(20);
  expect(e.historyList()).toEqual([]);
  // sólo los pares de la lista (como el motor Rust): lo demás, incluido el .snap.gz huérfano, se queda
  expect(fs.readdirSync(HD).sort()).toEqual(['20200101T000000Z-0badc0de.snap.gz', 'notas.txt', 'otro.json']);
  expect(e.historyClear()).toBe(0);
});

test('historial: fallo al escribir → history.saveFailed (500)', () => {
  const file = path.join(base, 'un-archivo');
  fs.writeFileSync(file, 'x');
  process.env.TESSERA_HISTORY_DIR = path.join(file, 'history');
  try {
    const err = caught(() => e.historySave());
    expect(err.msg.code).toBe('history.saveFailed');
    expect(String(err.msg.params?.error)).not.toBe('');
    expect(errorResponse(err).status).toBe(500);
    expect(e.historyList()).toEqual([]);
  } finally { process.env.TESSERA_HISTORY_DIR = HD; }
});

test('exportFile: nombres no válidos, colisiones « (2)» y base64; revealExport sólo dentro de la carpeta', () => {
  const a = e.exportFile('informe.html', '<p>ñ</p>', false);
  expect(a).toEqual({ path: path.join(XD, 'informe.html') });
  expect(fs.readFileSync(a.path, 'utf8')).toBe('<p>ñ</p>');
  expect(e.exportFile('informe.html', 'b', false).path).toBe(path.join(XD, 'informe (2).html'));
  expect(e.exportFile('INFORME.html', 'c', false).path).toBe(path.join(XD, 'INFORME (3).html'));
  expect(e.exportFile('notas', 'x', false).path).toBe(path.join(XD, 'notas'));
  expect(e.exportFile('notas', 'y', false).path).toBe(path.join(XD, 'notas (2)'));
  expect(e.exportFile('.oculto', 'z', false).path).toBe(path.join(XD, '.oculto'));
  expect(e.exportFile('.oculto', 'z', false).path).toBe(path.join(XD, '.oculto (2)'));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254]);
  const png = e.exportFile('mapa.png', bytes.toString('base64'), true);
  expect(fs.readFileSync(png.path)).toEqual(bytes);
  const long = 'x'.repeat(196) + '.txt';
  expect(e.exportFile(long, 'ok', false).path).toBe(path.join(XD, long));

  for (const name of ['', '.', '..', 'a/b.txt', 'a\\b.txt', 'C:x.txt', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b', 'a\nb',
    'a\u007fb', 'a\u0085b', 'x'.repeat(201)]) {
    const err = caught(() => e.exportFile(name, 'x', false));
    expect(err.msg).toEqual({ code: 'export.invalidName', params: { name }, message: `Invalid file name: ${name}` });
    expect(errorResponse(err).status).toBe(400);
  }
  // base64 estricto (alfabeto estándar, relleno canónico; los espacios se ignoran) → si no, export.failed
  expect(fs.readFileSync(e.exportFile('abc.txt', 'QUJD\r\nREVG', true).path, 'utf8')).toBe('ABCDEF');
  for (const bad of ['QQ', 'QR==', '-_8=', 'QUJD!']) {
    const err = caught(() => e.exportFile('b.bin', bad, true));
    expect(err.msg).toEqual({ code: 'export.failed', params: { error: 'Invalid base64 data' }, message: "Couldn't save the file: Invalid base64 data" });
    expect(errorResponse(err).status).toBe(500);
  }
  expect(fs.readdirSync(XD)).toHaveLength(10);

  // fallo de E/S → export.failed (500)
  fs.writeFileSync(path.join(base, 'un-archivo'), 'x');
  process.env.TESSERA_EXPORT_DIR = path.join(base, 'un-archivo', 'export');
  try {
    const err = caught(() => e.exportFile('a.txt', 'x', false));
    expect(err.msg.code).toBe('export.failed');
    expect(errorResponse(err).status).toBe(500);
  } finally { process.env.TESSERA_EXPORT_DIR = XD; }

  // revealExport: todo lo que no sea un archivo existente dentro de la carpeta → export.notFound (404).
  // (Nunca con un archivo válido: abriría el Explorador.)
  fs.mkdirSync(path.join(XD, 'sub'), { recursive: true });
  fs.mkdirSync(XD + 'x', { recursive: true });
  fs.writeFileSync(path.join(XD + 'x', 'f.txt'), 'x');
  const outside = [
    path.join(R2, 'a.bin'), path.join(XD, 'no-existe.html'), `${XD}\\..\\otra\\a.bin`, path.join(XD + 'x', 'f.txt'),
    path.join(XD, 'sub'), XD, 'informe.html', '', `${XD}\\informe.html\0`,
  ];
  for (const p of outside) {
    const err = caught(() => e.revealExport(p));
    expect(err.msg).toMatchObject({ code: 'export.notFound', params: { path: p } });
    expect(errorResponse(err).status).toBe(404);
  }
  // la comprobación sin abrir nada: un archivo exportado vale; con `..` no, aunque acabe dentro
  expect(exportedFile(a.path)).toBe(a.path);
  expect(exportedFile(a.path.toUpperCase())).toBe(a.path.toUpperCase());
  expect(caught(() => exportedFile(`${XD}\\sub\\..\\informe.html`)).msg.code).toBe('export.notFound');
});
