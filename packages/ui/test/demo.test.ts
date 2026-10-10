import { expect, test } from 'bun:test';
import { decodeSlice } from '@tessera/protocol';
import { DemoBackend } from '../src/backends/demo';

test('demo: cumple el contrato (slice, hijos, búsqueda, extensiones)', async () => {
  const b = new DemoBackend();
  const res = await b.scan({ path: 'C:\\', engine: 'auto' }, () => { });
  expect(res.entries).toBeGreaterThan(40000);
  const root = await b.nodeInfo(res.rootId);
  expect(root.parentId).toBe(-1);

  const { nodes } = decodeSlice(await b.slice(root.id, root.size / 2e6, 150000));
  expect(nodes[0].id).toBe(root.id);
  const kept = nodes[0].kids.reduce((s, k) => s + k.size, 0);
  expect(kept + nodes[0].restSize).toBeCloseTo(root.size, -3);

  const kids = await b.children({ id: root.id, offset: 0, limit: 5, sort: 'size', desc: true });
  expect(kids.rows[0].size).toBeGreaterThanOrEqual(kids.rows[1].size);

  const big = await b.search({ query: '', root: root.id, limit: 1 });
  expect(big.rows[0].name).toBe('VT.cok');
  expect(big.rows[0].path.startsWith('C:\\Program Files (x86)\\Steam')).toBe(true);

  const gguf = await b.search({ query: 'ext:gguf size:>1g', root: root.id, limit: 50 });
  expect(gguf.total).toBe(7);
  expect((await b.search({ query: 'size:>zz', root: root.id, limit: 1 })).error).toBeTruthy();

  const ext = await b.extStats(root.id);
  expect(ext[0].ext).toBe('cok');
});

test('demo: duplicados con sus tres pasadas, orden por espacio recuperable y cancelación', async () => {
  const b = new DemoBackend(), GB = 1024 ** 3;
  const res = await b.scan({ path: 'C:\\', engine: 'auto' }, () => { });
  const phases: string[] = [];
  const d = await b.duplicates({ root: res.rootId, minSize: 1024 * 1024, limit: 100 }, p => { if (phases.at(-1) !== p.phase) phases.push(p.phase); });
  expect(phases).toEqual(['size', 'prefix', 'full', 'done']);
  expect(d.groups[0].files.map(f => f.name)).toEqual(['Win11_24H2_Spanish_x64.iso', 'Win11_24H2_Spanish_x64.iso']);
  expect(d.groups.some(g => g.files.some(f => f.name === 'VSCodeUserSetup-x64-1.104.0 (1).exe'))).toBe(true);
  expect(d.groups.every(g => g.files.length >= 2)).toBe(true);
  expect(d.totalGroups).toBeGreaterThanOrEqual(11);
  expect(d.wasted).toBeGreaterThan(9.9 * GB);
  expect(d.skipped.hardlinks).toBeGreaterThan(0); // los enlaces duros de WinSxS quedan fuera
  const waste = d.groups.map(g => (g.files.length - 1) * g.size);
  expect(waste).toEqual([...waste].sort((x, y) => y - x));

  const p = b.duplicates({ root: res.rootId, minSize: 1024 * 1024, limit: 100 }, () => { });
  expect(await b.cancelDuplicates()).toBe(true);
  await expect(p).rejects.toMatchObject({ code: 'error.cancelled' });
}, 20000); // escaneo simulado (2,6 s) + búsqueda simulada (1,8 s)

test('demo: cancelar el escaneo lo rechaza con error.cancelled', async () => {
  const b = new DemoBackend();
  expect(await b.cancelScan()).toBe(false);
  const p = b.scan({ path: 'C:\\', engine: 'auto' }, () => { });
  expect(await b.cancelScan()).toBe(true);
  await expect(p).rejects.toMatchObject({ code: 'error.cancelled' });
  expect(await b.cancelScan()).toBe(false);
});
