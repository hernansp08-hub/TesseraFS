// Rutas según el sistema (Windows: «\», sin distinguir mayúsculas; Linux: «/», distinguiendo) y la demo de Linux.
import { afterEach, describe, expect, test } from 'bun:test';
import { GLOBAL_PARAMS } from '@tessera/i18n';
import { SYS, baseName, can, isUnder, joinPath, parentPath, pathKey, setSystem, trimSep, volTag } from '../src/platform';
import { DemoBackend } from '../src/backends/demo';

const WINDOWS = { ...SYS, actions: [...SYS.actions] };
const LINUX = { os: 'linux' as const, sep: '/' as const, actions: ['open', 'reveal', 'trash'] as const };
const vol = (path: string) => ({ path, label: '', fs: '', total: 0, free: 0, clusterSize: 4096 });
afterEach(() => setSystem(WINDOWS));

describe('rutas en Windows', () => {
  test('separador, raíz y mayúsculas', () => {
    setSystem(WINDOWS);
    expect(joinPath('C:\\', 'Users')).toBe('C:\\Users');
    expect(joinPath('C:\\Users', 'ana')).toBe('C:\\Users\\ana');
    expect(parentPath('C:\\Users\\ana')).toBe('C:\\Users');
    expect(parentPath('C:\\Users')).toBe('C:\\');
    expect(trimSep('C:\\Users\\')).toBe('C:\\Users');
    expect(trimSep('C:\\')).toBe('C:\\');
    expect(baseName('C:\\Users\\ana\\')).toBe('ana');
    expect(isUnder('C:\\USERS\\Ana\\x.txt', 'c:\\users\\ana')).toBe(true);
    expect(isUnder('C:\\Users\\anabel', 'C:\\Users\\ana')).toBe(false);
    expect(isUnder('D:\\x', 'D:\\')).toBe(true);
    expect(volTag(vol('C:\\'))).toBe('C:');
    expect(can('properties')).toBe(true);
    expect(GLOBAL_PARAMS.os).toBe('windows');
  });
});

describe('rutas en Linux', () => {
  test('separador, raíz y mayúsculas', () => {
    setSystem({ ...LINUX, actions: [...LINUX.actions] });
    expect(GLOBAL_PARAMS.os).toBe('linux');
    expect(joinPath('/', 'home')).toBe('/home');
    expect(joinPath('/home', 'ana')).toBe('/home/ana');
    expect(parentPath('/home/ana')).toBe('/home');
    expect(parentPath('/home')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(trimSep('/home/ana/')).toBe('/home/ana');
    expect(trimSep('/')).toBe('/');
    expect(baseName('/home/ana')).toBe('ana');
    expect(baseName('/')).toBe('/');
    expect(pathKey('/home/Ana')).not.toBe(pathKey('/home/ana')); // Linux distingue mayúsculas
    expect(isUnder('/home/ana/x', '/home/ana')).toBe(true);
    expect(isUnder('/home/anabel', '/home/ana')).toBe(false);
    expect(isUnder('/etc/x', '/')).toBe(true);
    expect(volTag(vol('/mnt/datos'))).toBe('/mnt/datos');
    expect(can('properties')).toBe(false);
    expect(can('freeUp')).toBe(false);
    expect(can('trash')).toBe(true);
  });
});

test('demo de Linux: rutas con «/», motor de recorrido y aviso de otros sistemas montados', async () => {
  const b = new DemoBackend('linux');
  expect((await b.system()).sep).toBe('/');
  expect((await b.volumes())[0].path).toBe('/');
  const res = await b.scan({ path: '/', engine: 'auto' }, () => { });
  expect(res.rootPath).toBe('/');
  expect(res.engine).toBe('walk');
  expect(res.warnings.map(w => w.code)).toContain('scan.otherMounts');
  const qcow = await b.search({ query: 'ext:qcow2', root: res.rootId, limit: 5 });
  expect(qcow.total).toBe(2);
  expect(qcow.rows[0].path).toBe('/home/usuario/.local/share/gnome-boxes/images/fedora-42.qcow2');
  expect((await b.action('properties', qcow.rows[0].id)).code).toBe('error.unsupportedPlatform');
  // El historial simulado también es de Linux
  const hist = await b.historyList();
  expect(hist.every(h => h.path === '/' && h.engine === 'walk')).toBe(true);
});

test('demo: enlaces rotos, carpetas vacías (files:) y caché declarada', async () => {
  const b = new DemoBackend();
  const res = await b.scan({ path: 'C:\\', engine: 'auto' }, () => { });
  const broken = await b.brokenLinks(res.rootId, 10);
  expect(broken.total).toBe(2);
  expect(broken.rows.map(r => r.name)).toEqual(['config-compartida.json', 'Juegos (disco viejo)']); // ordenados por ruta
  // Las uniones también son carpetas sin archivos: -attr:reparse las deja fuera de las vacías
  const empty = await b.search({ query: 'type:dir files:=0 -attr:reparse', root: res.rootId, limit: 50 });
  expect(empty.rows.map(r => r.name).sort()).toEqual(['Nueva carpeta', 'Nueva carpeta (2)', 'old']);
  const tags = await b.search({ query: 're:^CACHEDIR\\.TAG$', root: res.rootId, limit: 10 });
  expect(tags.rows.map(r => r.path)).toContain('C:\\Users\\usuario\\AppData\\Local\\restic\\e4b1c9a07d\\CACHEDIR.TAG');
});
