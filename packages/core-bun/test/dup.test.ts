// Duplicados sobre una carpeta temporal creada por la prueba (TESSERA_TEST_DIR o %TEMP%); nunca toca otros archivos.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DupProgress, DupRequest } from '../../protocol/src/index.ts';
import { DUP_PREFIX, extendedPath } from '../src/dup.ts';
import { TesseraEngine } from '../src/engine.ts';
import { EngineError, errorResponse } from '../src/messages.ts';

const base = path.resolve(process.env.TESSERA_TEST_DIR ?? os.tmpdir(), `tessera-dup-${process.pid}`);
const R = path.join(base, 'Dup raíz');
const E = path.join(base, 'errores');
const BIG = 200 * 1024, SMALL = 10 * 1024, TAIL = 150 * 1024;

/** Bytes pseudoaleatorios deterministas (el prefijo y la cola de cada contenido son distintos). */
function content(n: number, seed: number): Buffer {
  const b = Buffer.allocUnsafe(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; b[i] = x >>> 24; }
  return b;
}
const sha = (b: Buffer) => new Bun.CryptoHasher('sha256').update(b).digest('hex');
const big = content(BIG, 1), small = content(SMALL, 3), tail1 = content(TAIL, 4), tail2 = Buffer.from(tail1);
tail2[TAIL - 1] ^= 0xFF; // mismos primeros 64 KiB, cola distinta
const put = (rel: string, data: Buffer, root = R) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(extendedPath(p), data);
};

beforeAll(() => {
  put('a\\big1.bin', big);
  put('B\\big2.bin', big);
  put('c\\d\\big3.bin', big);
  put('unique.bin', content(BIG, 2)); // mismo tamaño que big: sale en la pasada de 64 KiB
  fs.linkSync(path.join(R, 'unique.bin'), path.join(R, 'a', 'unique-link.bin')); // un nombre se marca HARDLINK
  put('small1.txt', small);
  put('a\\small2.txt', small);
  put('c\\odd. ', small); // punto y espacio finales: sólo se abre con la ruta del almacén tal cual
  put('tail1.dat', tail1);
  put('B\\tail2.dat', tail2);
  put('empty1.txt', Buffer.alloc(0));
  put('a\\empty2.txt', Buffer.alloc(0));

  put('e1.bin', content(5000, 7), E); put('e2.bin', content(5000, 7), E); put('e3.bin', content(5000, 7), E);
  put('f1.bin', content(100 * 1024, 8), E); put('f2.bin', content(100 * 1024, 8), E);
  put('g1.bin', content(7000, 9), E); put('g2.bin', content(7000, 9), E);
});

afterAll(() => {
  try { fs.rmSync(extendedPath(base), { recursive: true, force: true }); } catch { /* el sistema limpiará %TEMP% */ }
});

async function rejected(p: Promise<unknown>): Promise<EngineError> {
  try { await p; } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('expected an EngineError');
}
async function scanned(root = R) {
  const e = new TesseraEngine({ threads: 0 });
  const r = await e.scan({ path: root, engine: 'walk' });
  return { e, r, req: (o: Partial<DupRequest> = {}): DupRequest => ({ root: r.rootId, minSize: 1, limit: 100, ...o }) };
}
const rel = (p: string) => p.slice(R.length + 1);

test('duplicates: grupos, espacio recuperable, candidatos, orden y progreso', async () => {
  const { e, req } = await scanned();
  const prog: DupProgress[] = [];
  const d = await e.duplicates(req(), p => prog.push(p));

  expect(d.totalGroups).toBe(2);
  expect(d.groups.map(g => [g.size, g.files.map(f => rel(f.path))])).toEqual([
    [BIG, ['a\\big1.bin', 'B\\big2.bin', 'c\\d\\big3.bin']], // por ruta sin distinguir mayúsculas
    [SMALL, ['a\\small2.txt', 'c\\odd. ', 'small1.txt']],
  ]);
  expect(d.groups.map(g => g.hash)).toEqual([sha(big), sha(small)]);
  expect(d.wasted).toBe(2 * BIG + 2 * SMALL);
  expect(d.candidates).toBe(4 + 3 + 2); // big ×3 + unique · small ×3 · tail ×2 (vacíos y el enlace duro, fuera)
  expect(d.skipped).toEqual({ hardlinks: 1, cloud: 0 });
  const prefixBytes = 4 * DUP_PREFIX + 3 * SMALL + 2 * DUP_PREFIX, fullBytes = 3 * BIG + 2 * TAIL;
  expect(d.readBytes).toBe(prefixBytes + fullBytes);
  expect(d.warnings).toEqual([]);
  expect(d.elapsedMs).toBeGreaterThanOrEqual(0);

  const row = d.groups[0].files[0];
  expect(row).toMatchObject({ name: 'big1.bin', isDir: false, size: BIG, ext: 'bin', path: path.join(R, 'a', 'big1.bin') });
  expect(e.nodePath(row.id)).toBe(row.path);

  expect([...new Set(prog.map(p => p.phase))]).toEqual(['size', 'prefix', 'full', 'done']);
  expect(prog[0]).toMatchObject({ phase: 'size', files: 9, totalFiles: 9, bytes: 0, totalBytes: 0 });
  expect(prog.find(p => p.phase === 'prefix')).toMatchObject({ totalFiles: 9, totalBytes: prefixBytes });
  expect(prog.find(p => p.phase === 'full')).toMatchObject({ totalFiles: 5, totalBytes: fullBytes });
  expect(prog.at(-1)).toMatchObject({ phase: 'done', bytes: d.readBytes });
  for (const p of prog) expect(p.files).toBeLessThanOrEqual(p.totalFiles);
});

test('duplicates: tamaño mínimo, límite y subcarpeta', async () => {
  const { e, r, req } = await scanned();
  const min = await e.duplicates(req({ minSize: 100 * 1024 }));
  expect(min.groups.map(g => g.size)).toEqual([BIG]);
  expect(min.candidates).toBe(4 + 2);
  expect(min.readBytes).toBe(6 * DUP_PREFIX + 3 * BIG + 2 * TAIL);

  const one = await e.duplicates(req({ limit: 1 }));
  expect(one.groups.map(g => g.size)).toEqual([BIG]);
  expect([one.totalGroups, one.wasted]).toEqual([2, 2 * BIG + 2 * SMALL]);
  expect((await e.duplicates(req({ limit: 0 }))).groups).toHaveLength(1); // se acota a 1..5000
  expect((await e.duplicates(req({ limit: 1e9 }))).groups).toHaveLength(2);

  const sub = e.children({ id: r.rootId, offset: 0, limit: 50, sort: 'name', desc: false }).rows.find(x => x.name === 'B')!;
  const phases: string[] = [];
  const d = await e.duplicates(req({ root: sub.id }), p => phases.push(p.phase));
  expect([d.totalGroups, d.candidates, d.readBytes, d.groups.length]).toEqual([0, 0, 0, 0]);
  expect([...new Set(phases)]).toEqual(['size', 'prefix', 'full', 'done']);
});

test('duplicates: archivos que ya no se pueden leer o cambiaron quedan fuera con dup.readErrors', async () => {
  const { e, req } = await scanned(E);
  fs.rmSync(path.join(E, 'e1.bin'));                     // ya no existe
  fs.appendFileSync(path.join(E, 'e2.bin'), 'x');        // creció (pasada de 64 KiB)
  fs.appendFileSync(path.join(E, 'f2.bin'), 'x');        // creció (pasada completa)
  const d = await e.duplicates(req());
  expect(d.groups.map(g => g.files.map(f => path.basename(f.path)))).toEqual([['g1.bin', 'g2.bin']]);
  expect(d.candidates).toBe(7);
  expect(d.warnings).toEqual([{ code: 'dup.readErrors', params: { count: 3 }, message: "3 files couldn't be read and were left out" }]);
});

test('duplicates: cancelar al empezar o a mitad → error.cancelled, y se puede repetir', async () => {
  const { e, req } = await scanned();
  expect(e.cancelDuplicates()).toBe(false); // ninguna en curso
  const p = e.duplicates(req());
  expect(e.cancelDuplicates()).toBe(true);
  expect((await rejected(p)).msg).toEqual({ code: 'error.cancelled', message: 'Scan cancelled' });
  expect(e.dupRunning).toBe(false);
  expect(e.cancelDuplicates()).toBe(false);

  for (const at of ['prefix', 'full']) {
    const err = await rejected(e.duplicates(req(), x => { if (x.phase === at) e.cancelDuplicates(); }));
    expect(err.code).toBe('error.cancelled');
    expect(errorResponse(err).status).toBe(409);
  }
  expect((await e.duplicates(req())).totalGroups).toBe(2);
});

test('duplicates: reglas de ocupado y errores de entrada', async () => {
  const fresh = new TesseraEngine({ threads: 0 });
  expect((await rejected(fresh.duplicates({ root: 0, minSize: 1, limit: 10 }))).msg)
    .toEqual({ code: 'error.noScan', message: 'Nothing has been scanned yet' });

  const { e, req } = await scanned();
  const bad = await rejected(e.duplicates(req({ root: 999999 })));
  expect(bad.msg).toMatchObject({ code: 'error.invalidNode', params: { id: 999999 } });
  expect(errorResponse(bad).status).toBe(404);

  const running = e.duplicates(req());
  expect(e.dupRunning).toBe(true);
  const busy = await rejected(e.duplicates(req()));
  expect(busy.msg).toEqual({ code: 'error.dupBusy', message: 'A duplicate search is already in progress' });
  expect(errorResponse(busy).status).toBe(409);
  expect((await rejected(e.scan({ path: R, engine: 'walk' }))).msg.code).toBe('error.dupBusy');
  expect((await running).totalGroups).toBe(2);

  const scanning = e.scan({ path: R, engine: 'walk' });
  expect((await rejected(e.duplicates(req()))).msg.code).toBe('error.scanBusy');
  await scanning;
  expect((await e.duplicates(req())).totalGroups).toBe(2);
});
