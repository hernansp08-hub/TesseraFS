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

test('demo: cancelar el escaneo lo rechaza con error.cancelled', async () => {
  const b = new DemoBackend();
  expect(await b.cancelScan()).toBe(false);
  const p = b.scan({ path: 'C:\\', engine: 'auto' }, () => { });
  expect(await b.cancelScan()).toBe(true);
  await expect(p).rejects.toMatchObject({ code: 'error.cancelled' });
  expect(await b.cancelScan()).toBe(false);
});
