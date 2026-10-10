import { expect, test } from 'bun:test';
import { compileQuery, encodeSlice, decodeSlice, type SliceSource } from '../src';

const T = (name: string, size: number, extra: Partial<{ isDir: boolean; mtime: number; path: string }> = {}) => ({
  name, ext: name.includes('.') ? name.split('.').pop()!.toLowerCase() : '', isDir: !!extra.isDir, size, alloc: size,
  mtime: extra.mtime ?? Date.now() / 1000, path: () => extra.path ?? 'C:\\x\\' + name,
});

test('query: ext, size, negation, OR, type', () => {
  expect(compileQuery('ext:gguf').match(T('a.gguf', 5))).toBe(true);
  expect(compileQuery('ext:gguf size:>1g').match(T('a.gguf', 5))).toBe(false);
  expect(compileQuery('size:1k..2k').match(T('a.bin', 1500))).toBe(true);
  expect(compileQuery('-ext:dll size:>1m').match(T('a.dll', 5 * 2 ** 20))).toBe(false);
  expect(compileQuery('ext:rlib OR ext:pdb').match(T('x.pdb', 1))).toBe(true);
  expect(compileQuery('node_modules').match(T('node_modules', 1, { isDir: true }))).toBe(false);
  expect(compileQuery('type:dir node_modules').match(T('node_modules', 1, { isDir: true }))).toBe(true);
  expect(compileQuery('path:steamapps').match(T('VT.cok', 1, { path: 'C:\\Steam\\steamapps\\VT.cok' }))).toBe(true);
  expect(compileQuery('VT*').match(T('VT.cok', 1))).toBe(true);
  expect(compileQuery('age:>1y').match(T('old.txt', 1, { mtime: Date.now() / 1000 - 400 * 86400 }))).toBe(true);
  expect(compileQuery('size:>abc').error).toBeTruthy();
});

test('slice: roundtrip with pruning', () => {
  // raíz(0) -> a(1, dir) -> a1.bin(3) 100, a2.bin(4) 1 ; b.txt(2) 50
  const nodes = [
    { name: 'C:', dir: true, size: 151, kids: [1, 2] }, { name: 'a', dir: true, size: 101, kids: [3, 4] },
    { name: 'b.txt', dir: false, size: 50, kids: [] }, { name: 'a1.bin', dir: false, size: 100, kids: [] },
    { name: 'a2.bin', dir: false, size: 1, kids: [] },
  ];
  const src: SliceSource = {
    isDir: i => nodes[i].dir, name: i => nodes[i].name, ext: i => nodes[i].dir ? '' : nodes[i].name.split('.').pop()!,
    size: i => nodes[i].size, alloc: i => nodes[i].size, files: () => 0, dirs: () => 0, mtime: () => 1, flags: () => 0,
    children: i => nodes[i].kids,
  };
  const { nodes: out } = decodeSlice(encodeSlice(src, 0, 10, 100));
  expect(out.map(n => n.name)).toEqual(['C:', 'a', 'a1.bin', 'b.txt']);
  expect(out[1].restSize).toBe(1);
  expect(out[1].restCount).toBe(1);
  expect(out[1].isDir).toBe(true);
  expect(out[2].ext).toBe('bin');
  expect(out[2].parent!.name).toBe('a');
});

test('query: only real keys, units and attributes (same as Rust)', () => {
  expect(compileQuery('attr:constructor').error?.code).toBe('query.invalidValue');
  expect(compileQuery('attr:__proto__').error?.code).toBe('query.invalidValue');
  expect(compileQuery('size:>1constructor').error?.code).toBe('query.invalidValue');
  expect(compileQuery('constructor:x').error).toBeUndefined(); // no es una clave: texto normal
  expect(compileQuery('constructor:x').match(T('constructor:x.txt', 1))).toBe(true);
});

test('query: quoted values after a key', () => {
  expect(compileQuery('type:dir name:"System Volume Information"').match(T('System Volume Information', 1, { isDir: true }))).toBe(true);
  expect(compileQuery('"Cities Skylines"').match(T('Cities Skylines II', 1))).toBe(true);
});
