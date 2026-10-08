import { expect, test } from 'bun:test';
import { FLAG, decodeSlice, encodeSlice } from '../../protocol/src/index.ts';
import { NONE, Store } from '../src/store.ts';

const u = (s: string) => Uint16Array.from(s, c => c.charCodeAt(0));
const NOW = Math.floor(Date.now() / 1000);
function add(st: Store, parent: number, name: string, dir: boolean, size = 0, mtime = NOW, flags = 0) {
  const x = u(name);
  return st.add(parent, x, 0, x.length, dir, size, size, mtime, flags);
}

// C:\ ─ Windows\ ─ a.dll (100) , B.DLL (300), notes.TXT (5)
//      └ Users\ ─ big.iso (1000), .gitignore (1), sub\ ─ deep.dll (50)
function sample() {
  const st = new Store(4, true); // capacidad mínima: obliga a crecer
  const root = st.addRoot('C:\\');
  const win = add(st, root, 'Windows', true);
  const users = add(st, root, 'Users', true);
  add(st, win, 'a.dll', false, 100);
  add(st, win, 'B.DLL', false, 300);
  add(st, win, 'notes.TXT', false, 5, 1_000);
  add(st, users, 'big.iso', false, 1000);
  add(st, users, '.gitignore', false, 1);
  const sub = add(st, users, 'sub', true);
  add(st, sub, 'deep.dll', false, 50);
  st.finalize();
  return { st, root, win, users, sub };
}

test('store: agregación, extensiones y rutas', () => {
  const { st, root, win, users, sub } = sample();
  expect(st.n).toBe(10);
  expect(st.size(root)).toBe(1456);
  expect(st.files(root)).toBe(6);
  expect(st.dirs(root)).toBe(3);
  expect(st.size(win)).toBe(405);
  expect(st.files(users)).toBe(3);
  expect(st.dirs(users)).toBe(1);
  expect(st.ext(4)).toBe('dll'); // B.DLL en minúsculas
  expect(st.ext(7)).toBe('');    // .gitignore no tiene extensión
  expect(st.ext(win)).toBe('');
  expect(st.par[root]).toBe(NONE);
  expect(st.path(root)).toBe('C:\\');
  expect(st.path(sub)).toBe('C:\\Users\\sub');
  expect(st.path(9)).toBe('C:\\Users\\sub\\deep.dll');
  expect(Array.from(st.children(root))).toEqual([users, win]); // tamaño desc
  expect(st.row(root).parentId).toBe(-1);
  expect(st.row(win).childCount).toBe(3);
  expect(st.row(win).flags & FLAG.DIR).toBe(FLAG.DIR);
});

test('store: hijos ordenados y paginados, empate por nombre', () => {
  const st = new Store();
  const root = st.addRoot('D:\\data');
  for (const [n, s] of [['b', 10], ['A', 10], ['c', 20], ['d', 5]] as const) add(st, root, n, false, s, s * 10);
  st.finalize();
  const names = (sort: Parameters<Store['childRows']>[3], desc: boolean, off = 0, lim = 10) => st.childRows(root, off, lim, sort, desc).rows.map(r => r.name);
  expect(names('size', true)).toEqual(['c', 'A', 'b', 'd']);
  expect(names('size', false)).toEqual(['d', 'A', 'b', 'c']);
  expect(names('name', false)).toEqual(['A', 'b', 'c', 'd']);
  expect(names('name', true)).toEqual(['d', 'c', 'b', 'A']);
  expect(names('mtime', true)).toEqual(['c', 'A', 'b', 'd']);
  expect(names('size', true, 1, 2)).toEqual(['A', 'b']);
  expect(st.childRows(root, 0, 2, 'size', true).total).toBe(4);
  expect(st.path(1)).toBe('D:\\data\\b');
});

test('store: el slice se decodifica con decodeSlice', () => {
  const { st, root } = sample();
  const { nodes, minBytes } = decodeSlice(encodeSlice(st, root, 50, 100));
  expect(minBytes).toBe(50);
  expect(nodes[0].name).toBe('C:\\');
  expect(nodes[0].size).toBe(1456);
  expect(nodes.map(n => n.name)).toEqual(['C:\\', 'Users', 'big.iso', 'sub', 'deep.dll', 'Windows', 'B.DLL', 'a.dll']);
  const users = nodes[1];
  expect(users.restCount).toBe(1); // .gitignore (1 byte) podado
  expect(users.restSize).toBe(1);
  expect(users.childCount).toBe(3);
  expect(nodes[2].ext).toBe('iso');
  expect(nodes[2].parent).toBe(users);
  expect(nodes[5].files).toBe(3);
});

test('store: búsqueda ordenada por tamaño, consulta vacía y raíz', () => {
  const { st, root, users } = sample();
  const all = st.search('', root, 3);
  expect(all.total).toBe(6);
  expect(all.totalBytes).toBe(1456);
  expect(all.rows.map(r => r.name)).toEqual(['big.iso', 'B.DLL', 'a.dll']);
  expect(all.rows[0].path).toBe('C:\\Users\\big.iso');
  const dll = st.search('ext:dll size:>60', root, 10);
  expect(dll.rows.map(r => r.name)).toEqual(['B.DLL', 'a.dll']);
  expect(st.search('ext:dll', users, 10).rows.map(r => r.path)).toEqual(['C:\\Users\\sub\\deep.dll']);
  expect(st.search('type:dir', root, 10).rows.map(r => r.name)).toEqual(['Users', 'Windows', 'sub']);
  expect(st.search('path:users\\sub', root, 10).total).toBe(1);
  expect(st.search('age:>1y', root, 10).rows.map(r => r.name)).toEqual(['notes.TXT']);
  expect(st.search('size:>zz', root, 10).error).toBeTruthy();
});

test('store: estadísticas por extensión', () => {
  const { st, root } = sample();
  const ex = st.extStats(root);
  expect(ex[0]).toEqual({ ext: 'iso', size: 1000, alloc: 1000, count: 1 });
  expect(ex.find(e => e.ext === 'dll')).toEqual({ ext: 'dll', size: 450, alloc: 450, count: 3 });
  expect(ex.find(e => e.ext === '')!.count).toBe(1);
});

test('store: quitar un nodo corrige ancestros y orden', () => {
  const { st, root, win, users, sub } = sample();
  // quitar big.iso deja Users (51) por debajo de Windows (405)
  expect(st.remove(6)).toBe(true);
  expect(st.size(users)).toBe(51);
  expect(st.files(users)).toBe(2);
  expect(st.size(root)).toBe(456);
  expect(st.files(root)).toBe(5);
  expect(Array.from(st.children(root))).toEqual([win, users]);
  expect(st.search('', root, 10).total).toBe(5);
  expect(st.extStats(root).find(e => e.ext === 'iso')).toBeUndefined();
  // quitar una carpeta entera
  expect(st.remove(sub)).toBe(true);
  expect(st.dirs(root)).toBe(2);
  expect(st.files(root)).toBe(4);
  expect(st.size(root)).toBe(406);
  expect(st.childRows(users, 0, 10, 'size', true).total).toBe(1);
  expect(st.remove(sub)).toBe(false); // ya no está
  expect(st.remove(root)).toBe(false);
  const { nodes } = decodeSlice(encodeSlice(st, root, 0, 100));
  expect(nodes.map(n => n.name)).toEqual(['C:\\', 'Windows', 'B.DLL', 'a.dll', 'notes.TXT', 'Users', '.gitignore']);
});

test('store: enlaces duros por clave de archivo', () => {
  const st = new Store(16, true);
  const root = st.addRoot('C:\\');
  const a = add(st, root, 'a', true), b = add(st, root, 'b', true);
  const f1 = add(st, a, 'x.dll', false, 100), f2 = add(st, b, 'x.dll', false, 100), f3 = add(st, b, 'y.dll', false, 7);
  st.key![f1] = 42; st.key![f2] = 42; st.key![f3] = 43;
  expect(st.dedupHardlinks()).toBe(1);
  st.finalize();
  expect(st.size(root)).toBe(107);
  expect(st.size(f2)).toBe(0);
  expect(st.flags(f2) & FLAG.HARDLINK).toBe(FLAG.HARDLINK);
  expect(st.flags(f1) & FLAG.HARDLINK).toBe(0);
  expect(st.files(root)).toBe(3); // el nombre sigue apareciendo
});
