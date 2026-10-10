// Liberar espacio de OneDrive (freeUp). Nunca toca archivos de la nube reales: la función pura, la selección de
// candidatos y el resultado se prueban sobre un árbol sintético con FLAG.CLOUD y un AttrIo en memoria; el camino
// real (bun:ffi) sólo sobre archivos temporales creados por la prueba (TESSERA_TEST_DIR o %TEMP%).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FLAG } from '../../protocol/src/index.ts';
import { FREE_UP_SETTABLE, freeUp, freeUpAttrs, freeUpCandidates, win32AttrIo, type AttrIo } from '../src/cloud.ts';
import { extendedPath } from '../src/dup.ts';
import { TesseraEngine } from '../src/engine.ts';
import { Store } from '../src/store.ts';
import { ATTR } from '../src/win32.ts';

// ---------- función pura ----------
test('freeUpAttrs: sin PINNED, con UNPINNED, sólo bits ajustables; OFFLINE o RECALL_ON_DATA_ACCESS → saltar', () => {
  expect(FREE_UP_SETTABLE).toBe(0x1 | 0x2 | 0x4 | 0x20 | 0x100 | 0x1000 | 0x2000 | 0x80000 | 0x100000);
  // descargado y «siempre en este dispositivo» (ARCHIVE | REPARSE | PINNED) → ARCHIVE | UNPINNED
  expect(freeUpAttrs(0x20 | 0x400 | 0x80000)).toBe(0x100020);
  // descargado sin fijar; o ya UNPINNED pero el proveedor aún no lo vació: se vuelve a marcar
  expect(freeUpAttrs(0x20 | 0x400)).toBe(0x100020);
  expect(freeUpAttrs(0x20 | 0x400 | 0x100000)).toBe(0x100020);
  // NORMAL (sólo tiene sentido solo) y los no ajustables se quedan fuera; los ajustables se conservan
  expect(freeUpAttrs(ATTR.NORMAL)).toBe(ATTR.UNPINNED);
  const keep = ATTR.READONLY | ATTR.HIDDEN | ATTR.SYSTEM | ATTR.ARCHIVE | ATTR.TEMPORARY | ATTR.NOT_CONTENT_INDEXED;
  const drop = ATTR.DIRECTORY | ATTR.SPARSE | ATTR.REPARSE | ATTR.COMPRESSED | ATTR.RECALL_ON_OPEN | 0x4000 /* ENCRYPTED */ | 0x10000 /* VIRTUAL */;
  expect(freeUpAttrs(keep | drop | ATTR.PINNED)).toBe(keep | ATTR.UNPINNED);
  // carpeta de OneDrive (DIRECTORY | REPARSE | PINNED) → sólo UNPINNED
  expect(freeUpAttrs(0x10 | 0x400 | 0x80000)).toBe(0x100000);
  // ya sólo en línea
  expect(freeUpAttrs(ATTR.ARCHIVE | ATTR.OFFLINE)).toBeNull();
  expect(freeUpAttrs(0x20 | 0x400 | 0x100000 | ATTR.RECALL_ON_DATA_ACCESS)).toBeNull();
  expect(freeUpAttrs(0x20 | 0x400 | 0x80000 | ATTR.RECALL_ON_DATA_ACCESS)).toBeNull();
  // sin signo aunque se pidieran todos los bits
  expect(freeUpAttrs(0xFFFFFFFF & ~(ATTR.OFFLINE | ATTR.RECALL_ON_DATA_ACCESS))).toBe((FREE_UP_SETTABLE & ~ATTR.PINNED & ~ATTR.OFFLINE) >>> 0);
});

// ---------- árbol sintético ----------
const u = (s: string) => Uint16Array.from(s, c => c.charCodeAt(0));
function add(st: Store, parent: number, name: string, dir: boolean, alloc = 0, flags = 0) {
  const x = u(name);
  return st.add(parent, x, 0, x.length, dir, alloc, alloc, 0, flags);
}

// C:\Users\me ─ OneDrive\ (nube) ─ video.mp4 (nube, 5000), online.pdf (nube, sólo en línea: 0),
//            │                   Docs\ (nube) ─ a.docx (nube, 300), local.tmp (100, no es de la nube)
//            │                   Empty\ (nube) ─ ghost.txt (nube, 0)
//            └ Local\ ─ x.bin (1000), odd.dat (nube, 50)
function sample() {
  const st = new Store(4);
  const root = st.addRoot('C:\\Users\\me');
  const od = add(st, root, 'OneDrive', true, 0, FLAG.CLOUD);
  const video = add(st, od, 'video.mp4', false, 5000, FLAG.CLOUD);
  const online = add(st, od, 'online.pdf', false, 0, FLAG.CLOUD);
  const docs = add(st, od, 'Docs', true, 0, FLAG.CLOUD);
  const docx = add(st, docs, 'a.docx', false, 300, FLAG.CLOUD);
  add(st, docs, 'local.tmp', false, 100);
  const empty = add(st, od, 'Empty', true, 0, FLAG.CLOUD);
  add(st, empty, 'ghost.txt', false, 0, FLAG.CLOUD);
  const local = add(st, root, 'Local', true);
  add(st, local, 'x.bin', false, 1000);
  const odd = add(st, local, 'odd.dat', false, 50, FLAG.CLOUD | FLAG.HIDDEN);
  st.finalize();
  return { st, root, od, video, online, docs, docx, empty, local, odd };
}

test('freeUpCandidates: archivos de la nube descargados y carpetas de la nube, bajo el nodo (incluido)', () => {
  const { st, root, od, video, online, docs, docx, empty, local, odd } = sample();
  const names = (ids: number[]) => ids.map(i => st.name(i)).sort();
  const c = freeUpCandidates(st, root);
  expect(names(c.files)).toEqual(['a.docx', 'odd.dat', 'video.mp4']);
  expect(names(c.dirs)).toEqual(['Docs', 'Empty', 'OneDrive']);
  expect(freeUpCandidates(st, od)).toEqual({ files: expect.arrayContaining([video, docx]), dirs: expect.arrayContaining([od, docs, empty]) });
  expect(freeUpCandidates(st, od).files).toHaveLength(2);
  expect(freeUpCandidates(st, docs)).toEqual({ files: [docx], dirs: [docs] });
  expect(freeUpCandidates(st, empty)).toEqual({ files: [], dirs: [empty] });
  expect(freeUpCandidates(st, local)).toEqual({ files: [odd], dirs: [] }); // la carpeta no es de la nube
  expect(freeUpCandidates(st, video)).toEqual({ files: [video], dirs: [] });
  expect(freeUpCandidates(st, online)).toEqual({ files: [], dirs: [] });
  // lo quitado del árbol ya no cuenta
  st.remove(docs);
  expect(names(freeUpCandidates(st, root).files)).toEqual(['odd.dat', 'video.mp4']);
  expect(names(freeUpCandidates(st, root).dirs)).toEqual(['Empty', 'OneDrive']);
});

/** AttrIo en memoria: atributos por ruta, errores opcionales y registro de lo escrito. */
function memIo(attrs: Record<string, number>, fail: { get?: string[]; set?: string[] } = {}) {
  const sets: [string, number][] = [];
  const io: AttrIo = {
    get: p => fail.get?.includes(p) ? 'Access is denied. (5)' : p in attrs ? attrs[p] : 'The system cannot find the file specified. (2)',
    set: (p, a) => { if (fail.set?.includes(p)) return `Set failed: ${p}`; sets.push([p, a]); attrs[p] = a; return null; },
  };
  return { io, sets, attrs };
}
const ME = 'C:\\Users\\me';
const PINNED_FILE = 0x20 | 0x400 | 0x80000, LOCAL_FILE = 0x20 | 0x400, CLOUD_DIR = 0x10 | 0x400;
function cloudAttrs(): Record<string, number> {
  return {
    [`${ME}\\OneDrive`]: CLOUD_DIR | 0x80000, [`${ME}\\OneDrive\\video.mp4`]: PINNED_FILE, [`${ME}\\OneDrive\\Docs`]: CLOUD_DIR,
    [`${ME}\\OneDrive\\Docs\\a.docx`]: LOCAL_FILE | ATTR.READONLY, [`${ME}\\OneDrive\\Empty`]: CLOUD_DIR,
    [`${ME}\\Local\\odd.dat`]: LOCAL_FILE | ATTR.HIDDEN | ATTR.RECALL_ON_DATA_ACCESS, // el proveedor ya lo está vaciando
  };
}

test('freeUp: cambia archivos y luego carpetas; count y bytes sólo de los archivos cambiados; el árbol no cambia', () => {
  const { st, root } = sample();
  const v = st.version, size = st.size(root), alloc = st.alloc(root);
  const m = memIo(cloudAttrs());
  const r = freeUp(st, root, m.io);
  expect(r).toEqual({ ok: true, code: 'action.freedUp', params: { count: 2, bytes: 5300 }, message: '2 files set to online-only; 5,300 bytes will be freed shortly' });
  expect(typeof r.params?.bytes).toBe('number');
  // los archivos primero (en cualquier orden), después las carpetas; odd.dat se salta (RECALL_ON_DATA_ACCESS)
  expect(m.sets.slice(0, 2).map(x => x[0]).sort()).toEqual([`${ME}\\OneDrive\\Docs\\a.docx`, `${ME}\\OneDrive\\video.mp4`]);
  expect(m.sets.slice(2).map(x => x[0]).sort()).toEqual([`${ME}\\OneDrive`, `${ME}\\OneDrive\\Docs`, `${ME}\\OneDrive\\Empty`]);
  expect(m.attrs[`${ME}\\OneDrive\\video.mp4`]).toBe(0x100020);
  expect(m.attrs[`${ME}\\OneDrive\\Docs\\a.docx`]).toBe(0x100021); // READONLY se conserva
  expect(m.attrs[`${ME}\\OneDrive`]).toBe(0x100000);
  expect(m.attrs[`${ME}\\Local\\odd.dat`]).toBe(LOCAL_FILE | ATTR.HIDDEN | ATTR.RECALL_ON_DATA_ACCESS);
  expect([st.version, st.size(root), st.alloc(root)]).toEqual([v, size, alloc]);
  // otra vez: lo que el proveedor aún no vació se vuelve a marcar (no hay forma de saber si ya empezó)
  expect(freeUp(st, root, m.io)).toMatchObject({ ok: true, code: 'action.freedUp', params: { count: 2, bytes: 5300 } });
});

test('freeUp: nada que liberar, fallos parciales y totales', () => {
  const { st, root, od, video, online, empty, local } = sample();
  // sin archivos descargados no se toca nada (ni las carpetas)
  for (const id of [online, empty]) {
    const m = memIo(cloudAttrs());
    expect(freeUp(st, id, m.io)).toEqual({ ok: false, code: 'action.nothingToFree', message: 'There are no downloaded cloud files here to free up' });
    expect(m.sets).toEqual([]);
  }
  // descargados según el escaneo, pero ya sólo en línea al ir a cambiarlos
  const off = memIo({ ...cloudAttrs(), [`${ME}\\OneDrive\\video.mp4`]: ATTR.ARCHIVE | ATTR.OFFLINE });
  expect(freeUp(st, video, off.io)).toMatchObject({ ok: false, code: 'action.nothingToFree' });
  expect(off.sets).toEqual([]);
  expect(freeUp(st, local, memIo(cloudAttrs()).io)).toMatchObject({ ok: false, code: 'action.nothingToFree' });
  // uno falla y otro no: cuenta sólo el que cambió
  const part = memIo(cloudAttrs(), { set: [`${ME}\\OneDrive\\video.mp4`] });
  expect(freeUp(st, od, part.io)).toMatchObject({ ok: true, code: 'action.freedUp', params: { count: 1, bytes: 300 } });
  // todos fallan: action.failed con el primer error del sistema (preorden por tamaño: video.mp4 va antes)
  const all = memIo(cloudAttrs(), { get: [`${ME}\\OneDrive\\video.mp4`], set: [`${ME}\\OneDrive\\Docs\\a.docx`] });
  expect(freeUp(st, od, all.io)).toEqual({
    ok: false, code: 'action.failed', params: { error: 'Access is denied. (5)' }, message: 'The operation failed: Access is denied. (5)',
  });
  const gone = memIo({});
  expect(freeUp(st, video, gone.io)).toMatchObject({ ok: false, code: 'action.failed', params: { error: 'The system cannot find the file specified. (2)' } });
  // los archivos no cambiaron pero una carpeta falló: también action.failed
  const dirFail = memIo({ ...cloudAttrs(), [`${ME}\\OneDrive\\video.mp4`]: ATTR.OFFLINE, [`${ME}\\OneDrive\\Docs\\a.docx`]: ATTR.OFFLINE }, { set: [`${ME}\\OneDrive`] });
  expect(freeUp(st, od, dirFail.io)).toMatchObject({ ok: false, code: 'action.failed', params: { error: `Set failed: ${ME}\\OneDrive` } });
});

// ---------- motor real sobre una carpeta temporal ----------
const base = path.join(process.env.TESSERA_TEST_DIR ?? os.tmpdir(), `tessera-cloud-${process.pid}`);
const R = path.join(base, 'Nube sintética');
const DOT = path.join(R, 'sub', 'punto final.'); // Win32 quitaría el punto: sólo se alcanza con \\?\

beforeAll(() => {
  fs.mkdirSync(path.join(R, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(R, 'a.bin'), Buffer.alloc(64 * 1024));
  fs.writeFileSync(path.join(R, 'sub', 'b.txt'), Buffer.alloc(8192));
  fs.writeFileSync(extendedPath(DOT), Buffer.alloc(8192)); // tamaño suficiente para no quedar residente en la MFT
});

afterAll(() => {
  try { fs.rmSync(extendedPath(base), { recursive: true, force: true }); } catch { /* el sistema limpiará %TEMP% */ }
});

test('engine: freeUp sobre un árbol sin archivos de la nube → action.nothingToFree, sin tocar nada', async () => {
  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: R, engine: 'walk' });
  const files = [path.join(R, 'a.bin'), path.join(R, 'sub', 'b.txt'), DOT];
  const before = files.map(f => win32AttrIo.get(f));
  expect(before.every(a => typeof a === 'number')).toBe(true);
  const nothing = { ok: false, code: 'action.nothingToFree', message: 'There are no downloaded cloud files here to free up' };
  expect(e.action('freeUp', r.rootId)).toEqual(nothing);
  const a = e.search({ query: 'name:a.bin', root: r.rootId, limit: 1 }).rows[0];
  expect(e.action('freeUp', a.id)).toEqual(nothing);
  expect(files.map(f => win32AttrIo.get(f))).toEqual(before);
  expect(e.nodeInfo(r.rootId).size).toBe(r.bytes);
  expect(e.search({ query: 'attr:cloud', root: r.rootId, limit: 10 }).total).toBe(0);
  // el binding de lectura: un error del sistema en texto
  expect(win32AttrIo.get(path.join(R, 'no-existe'))).toEqual(expect.stringMatching(/\(2\)$/));
});

test('engine: freeUp de punta a punta sobre archivos temporales marcados como de la nube (ruta exacta \\\\?\\)', async () => {
  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: R, engine: 'walk' });
  const s = e.store!;
  const sub = e.search({ query: 'type:dir name:sub', root: r.rootId, limit: 1 }).rows[0];
  const dot = e.search({ query: 'name:"punto final."', root: r.rootId, limit: 1 }).rows[0];
  expect(dot.path).toBe(DOT);
  expect(dot.alloc).toBeGreaterThan(0);
  // sólo en el árbol: la carpeta y el archivo con punto final pasan por ser de OneDrive
  s.fl[sub.id] |= FLAG.CLOUD; s.fl[dot.id] |= FLAG.CLOUD;
  const { path: _, ...dotRow } = { ...dot, flags: dot.flags | FLAG.CLOUD };
  const rootRow = e.nodeInfo(r.rootId);
  const res = e.action('freeUp', r.rootId);
  if (r.volume?.fs.toUpperCase() !== 'NTFS') { expect(res.code).toMatch(/^action\.(freedUp|failed)$/); return; }
  expect(res).toMatchObject({ ok: true, code: 'action.freedUp', params: { count: 1, bytes: dot.alloc } });
  const after = win32AttrIo.get(DOT) as number;
  expect(after & (ATTR.UNPINNED | ATTR.PINNED)).toBe(ATTR.UNPINNED);
  expect((win32AttrIo.get(path.join(R, 'sub')) as number) & ATTR.UNPINNED).toBe(ATTR.UNPINNED);
  expect((win32AttrIo.get(path.join(R, 'a.bin')) as number) & ATTR.UNPINNED).toBe(0); // no era de la nube
  // el árbol no se toca (el proveedor vaciaría los archivos más tarde; la interfaz vuelve a escanear)
  expect(e.nodeInfo(dot.id)).toEqual(dotRow);
  expect(e.nodeInfo(r.rootId)).toEqual(rootRow);
  // ya no existe en disco: action.failed con el texto del sistema
  fs.rmSync(extendedPath(DOT));
  expect(e.action('freeUp', dot.id)).toMatchObject({ ok: false, code: 'action.failed', params: { error: expect.stringMatching(/\(2\)$/) } });
});
