// Escaneo guardado (.tessera), estado «sin conexión» y evolución en el historial, sobre carpetas temporales:
// TESSERA_HISTORY_DIR y TESSERA_EXPORT_DIR apuntan a la carpeta de la prueba, así que nunca se toca el historial real
// ni las Descargas del usuario. Las acciones sólo se piden con un escaneo abierto desde archivo (scan.offline) y con
// un id que no existe: nunca abren el Explorador ni mandan nada a la papelera.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FLAG, SLICE_HEADER, SLICE_RECORD, type ActionKind, type NodeRow } from '../../protocol/src/index.ts';
import { TesseraEngine } from '../src/engine.ts';
import { pathHash } from '../src/history.ts';
import { EngineError, errorResponse } from '../src/messages.ts';
import { APP_VERSION, TESSERA_MAX_FILE, decodeTessera, savedScanLabel, savedScanName, tesseraJson } from '../src/saved.ts';
import { Store } from '../src/store.ts';
import { ATTR, kernel32, wstr } from '../src/win32.ts';

const base = path.resolve(process.env.TESSERA_TEST_DIR ?? os.tmpdir(), `tessera-saved-${process.pid}`);
const R = path.join(base, 'Guardado ñ');
const HD = path.join(base, 'history');
const XD = path.join(base, 'export');
const MiB = 1 << 20;

const savedEnv = { h: process.env.TESSERA_HISTORY_DIR, x: process.env.TESSERA_EXPORT_DIR };
process.env.TESSERA_HISTORY_DIR = HD;
process.env.TESSERA_EXPORT_DIR = XD;

const put = (rel: string, size: number) => {
  const p = path.join(R, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
  return p;
};

beforeAll(() => {
  put('docs\\a.txt', 100);
  put('docs\\b.TXT', 2000);
  put('docs\\deep\\x.tar.gz', 3000);
  put('docs\\deep\\y.bin', 10);
  put('big.bin', 2 * MiB);
  put('Ünï\\ç.dat', 50);
  put('same1.bin', 500); // empate de tamaño: el orden entre hermanos se conserva
  put('same2.bin', 500);
  put('noext', 77);
  kernel32().SetFileAttributesW(wstr(put('oculto.txt', 10)), ATTR.HIDDEN);
  fs.mkdirSync(path.join(R, 'vacía'), { recursive: true });
});

afterAll(() => {
  if (savedEnv.h === undefined) delete process.env.TESSERA_HISTORY_DIR; else process.env.TESSERA_HISTORY_DIR = savedEnv.h;
  if (savedEnv.x === undefined) delete process.env.TESSERA_EXPORT_DIR; else process.env.TESSERA_EXPORT_DIR = savedEnv.x;
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* el sistema limpiará %TEMP% */ }
});

function caught(fn: () => unknown): EngineError {
  try { fn(); } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('expected an EngineError');
}
async function rejected(p: Promise<unknown>): Promise<EngineError> {
  try { await p; } catch (e) { if (e instanceof EngineError) return e; throw e; }
  throw new Error('expected an EngineError');
}
const gz = (text: string) => Bun.gzipSync(Buffer.from(text, 'utf8'));
const unzip = (p: string) => new TextDecoder().decode(Bun.gunzipSync(fs.readFileSync(p)));
const pad = (x: number, n = 2) => String(x).padStart(n, '0');
const stamp = (t: number) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`; };
const HOST = process.env.COMPUTERNAME || os.hostname();
const kids = (e: TesseraEngine, id: number): NodeRow[] => e.children({ id, offset: 0, limit: 1000, sort: 'size', desc: true }).rows;
const byPath = (e: TesseraEngine, rel: string) => {
  let id = e.result!.rootId;
  for (const part of rel ? rel.split('\\') : []) id = kids(e, id).find(r => r.name === part)!.id;
  return id;
};

/** Todo lo que se ve del árbol en preorden (por las listas de hijos), sin los ids. */
function dump(e: TesseraEngine) {
  const s = e.store!, out: unknown[] = [];
  s.forEach(s.rootId, id => { const { id: _id, parentId: _p, ...row } = e.nodeInfo(id); out.push([e.nodePath(id), row]); });
  return out;
}
/** El slice con los ids a cero (un escaneo abierto estrena ids; todo lo demás tiene que coincidir byte a byte). */
function noIds(slice: Uint8Array): Uint8Array {
  const b = slice.slice(), dv = new DataView(b.buffer);
  const count = dv.getUint32(8, true), recStart = SLICE_HEADER + Math.ceil(dv.getUint32(20, true) / 8) * 8;
  for (let i = 0; i < count; i++) dv.setUint32(recStart + i * SLICE_RECORD, 0, true);
  return b;
}

const e = new TesseraEngine({ threads: 0 });
let first: string; // el .tessera guardado del escaneo de R
let liveCount = 0;

test('saveScan: formato exacto (claves, preorden, 9 columnas, sólo banderas públicas) y nombre del archivo', async () => {
  expect(caught(() => e.saveScan()).msg).toEqual({ code: 'error.noScan', message: 'Nothing has been scanned yet' });
  const r = await e.scan({ path: R, engine: 'walk' });
  const s = e.store!;
  // lo enviado a la papelera (aquí, quitado del árbol sin papelera) no se guarda, ni ningún bit interno
  expect(s.remove(byPath(e, 'docs\\deep'))).toBe(true);
  const noext = byPath(e, 'noext');
  s.fl[noext] |= 0x4000;
  s.forEach(s.rootId, () => liveCount++);

  const saved = e.saveScan();
  first = saved.path;
  expect(path.dirname(saved.path)).toBe(XD);
  expect(path.basename(saved.path)).toBe(`Guardado ñ ${stamp(e.scannedAt)}.tessera`);
  expect(e.saveScan().path).toBe(path.join(XD, `Guardado ñ ${stamp(e.scannedAt)} (2).tessera`));

  const text = unzip(saved.path);
  const vol = JSON.stringify(r.volume);
  expect(r.volume).not.toBeNull();
  expect(Object.keys(r.volume!)).toEqual(['path', 'label', 'fs', 'total', 'free', 'clusterSize']);
  expect(text.startsWith(`{"v":1,"kind":"tesserafs-scan","app":${JSON.stringify(APP_VERSION)},"host":${JSON.stringify(HOST)},`
    + `"path":${JSON.stringify(R)},"scannedAt":${e.scannedAt},"engine":"walk","volume":${vol},"nodes":[[-1,${JSON.stringify(R)},1,`)).toBe(true);
  const j = JSON.parse(text);
  expect(Object.keys(j)).toEqual(['v', 'kind', 'app', 'host', 'path', 'scannedAt', 'engine', 'volume', 'nodes']);
  expect(APP_VERSION).toBe(JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8')).version);

  // preorden por las listas de hijos del árbol, con todos los nodos (también los archivos pequeños)
  const order: number[] = [];
  s.forEach(s.rootId, id => order.push(id));
  expect(j.nodes).toHaveLength(liveCount);
  const at = new Map(order.map((id, i) => [id, i]));
  j.nodes.forEach((n: unknown[], i: number) => {
    const id = order[i];
    expect(n).toHaveLength(9);
    expect(n).toEqual([
      i ? at.get(s.par[id]) : -1, i ? s.name(id) : R, s.isDir(id) ? 1 : 0, s.sz[id], s.al[id], s.nf[id], s.nd[id], s.mt[id], s.fl[id] & 0xFF,
    ]);
    expect((n[8] as number) & ~0xFF).toBe(0);
    expect(((n[8] as number) & FLAG.DIR) !== 0).toBe(n[2] === 1);
  });
  const names = j.nodes.map((n: unknown[]) => n[1]);
  expect(names).not.toContain('deep');
  expect(names).not.toContain('x.tar.gz');
  expect(j.nodes[names.indexOf('oculto.txt')][8] & FLAG.HIDDEN).toBe(FLAG.HIDDEN);
  expect(j.nodes[names.indexOf('noext')][8]).toBe(0);
  expect(names.indexOf('same1.bin')).toBeLessThan(names.indexOf('same2.bin'));
  expect(j.nodes[0].slice(3, 7)).toEqual([s.sz[0], s.al[0], s.nf[0], s.nd[0]]);
  expect(j.nodes[0][3]).toBe(r.bytes - 3010); // sin docs\deep
});

test('openScan: mismo árbol, slice idéntico (salvo los ids nuevos), y volver a guardarlo da el mismo archivo', () => {
  const e2 = new TesseraEngine({ threads: 0 });
  const data = fs.readFileSync(first);
  const r = e2.openScan(data);
  const s = e.store!;
  expect(Object.keys(r)).toEqual(['rootId', 'rootPath', 'engine', 'entries', 'files', 'dirs', 'bytes', 'elapsedMs', 'volume', 'warnings', 'canRefresh', 'offline']);
  expect(r).toEqual({
    rootId: 0, rootPath: R, engine: 'walk', entries: liveCount - 1, files: s.nf[0], dirs: s.nd[0], bytes: s.sz[0], elapsedMs: r.elapsedMs,
    volume: e.result!.volume, warnings: [], canRefresh: false, offline: { scannedAt: e.scannedAt, host: HOST, app: APP_VERSION },
  });
  expect(Object.keys(r.offline!)).toEqual(['scannedAt', 'host', 'app']);
  expect(e2.offline).toEqual(r.offline!);
  expect(e2.scannedAt).toBe(e.scannedAt);

  expect(dump(e2)).toEqual(dump(e));
  for (const [min, max] of [[0, 500000], [1000, 500000], [0, 4]]) {
    expect(noIds(e2.slice(0, min, max))).toEqual(noIds(e.slice(e.result!.rootId, min, max)));
  }
  const q = (x: TesseraEngine, query: string) => x.search({ query, root: x.result!.rootId, limit: 100 }).rows.map(({ id: _i, parentId: _p, ...row }) => row);
  for (const query of ['*.txt', 'attr:hidden', 'type:dir', 'size:>1kb']) expect(q(e2, query)).toEqual(q(e, query));
  expect(e2.extStats(0)).toEqual(e.extStats(e.result!.rootId));
  expect(e2.nodePath(byPath(e2, 'Ünï\\ç.dat'))).toBe(path.join(R, 'Ünï', 'ç.dat'));
  expect(e2.nodeInfo(byPath(e2, 'Ünï\\ç.dat'))).toMatchObject({ name: 'ç.dat', ext: 'dat', size: 50, isDir: false });
  expect(e2.nodeInfo(byPath(e2, 'noext')).ext).toBe('');

  // volver a guardarlo conserva scannedAt, host y app: el JSON es idéntico; abrirlo de nuevo da el mismo slice (ids incluidos)
  const again = e2.saveScan();
  expect(path.basename(again.path)).toBe(`Guardado ñ ${stamp(e.scannedAt)} (3).tessera`);
  expect(unzip(again.path)).toBe(unzip(first));
  const e3 = new TesseraEngine({ threads: 0 });
  e3.openScan(new Uint8Array(fs.readFileSync(again.path)).buffer); // también un ArrayBuffer
  expect(e3.slice(0, 0, 500000)).toEqual(e2.slice(0, 0, 500000));
});

test('sin conexión: lo que toca el disco o el historial → scan.offline (409); lo demás funciona; un escaneo nuevo lo quita', async () => {
  const e2 = new TesseraEngine({ threads: 0 });
  e2.openScan(fs.readFileSync(first));
  const docs = byPath(e2, 'docs');
  const offline = (err: EngineError) => {
    expect(err.msg).toEqual({ code: 'scan.offline', message: "This scan was opened from a file: actions on the disk aren't available" });
    expect(errorResponse(err).status).toBe(409);
  };
  // (un id que no existe: si la comprobación faltara, saldría error.invalidNode sin tocar nada)
  for (const kind of ['open', 'reveal', 'properties', 'trash', 'freeUp', 'zap'] as ActionKind[]) offline(caught(() => e2.action(kind, 999999)));
  offline(await rejected(e2.rescan(docs)));
  offline(await rejected(e2.refresh()));
  offline(await rejected(e2.duplicates({ root: 0, minSize: 1, limit: 10 })));
  offline(await rejected(e2.brokenLinks(0, 10)));
  offline(caught(() => e2.historySave()));
  offline(caught(() => e2.compare('20250101T000000Z-00000000', 10)));
  offline(caught(() => e2.historyTrend(docs)));
  expect(e2.dupRunning).toBe(false);
  expect(fs.existsSync(HD)).toBe(false); // nada se guardó en el historial

  // lo demás, igual que con un escaneo
  expect(e2.slice(0, 0, 10).byteLength).toBeGreaterThan(0);
  expect(kids(e2, docs).map(x => x.name)).toEqual(['b.TXT', 'a.txt']);
  expect(e2.search({ query: 'b.txt', root: 0, limit: 5 }).total).toBe(1);
  expect(e2.extStats(docs).map(x => x.ext)).toEqual(['txt']);
  expect(e2.nodePath(docs)).toBe(path.join(R, 'docs'));
  expect(e2.nodeInfo(docs).files).toBe(2);
  expect(e2.historyList()).toEqual([]);
  expect(e2.exportFile('notas.txt', 'x', false).path).toBe(path.join(XD, 'notas.txt'));
  e2.compareClear();
  expect(fs.existsSync(e2.saveScan().path)).toBe(true);
  expect(caught(() => e2.historyTrend(999999)).msg.code).toBe('scan.offline');

  // un escaneo normal quita el estado «sin conexión»
  const r = await e2.scan({ path: R, engine: 'walk' });
  expect('offline' in r).toBe(false);
  expect(e2.offline).toBeNull();
  const h = e2.historySave();
  expect(e2.historyTrend(r.rootId)).toEqual([]); // el único resumen es el del escaneo actual
  expect(e2.historyDelete(h.id)).toBe(true);
  // y uno que no llega a empezar (ruta no válida) no lo toca: el árbol abierto sigue ahí, sin conexión
  e2.openScan(fs.readFileSync(first));
  expect((await rejected(e2.scan({ path: 'relativa', engine: 'walk' }))).msg.code).toBe('error.invalidPath');
  expect(e2.offline).not.toBeNull();
  expect(e2.result!.offline).toBeDefined();
  offline(caught(() => e2.historySave()));
});

// Archivo fijo, escrito a mano con el formato exacto (como lo escribiría el motor Rust), en forma canónica: al
// volver a guardarlo sale idéntico byte a byte. (Lo que no es ASCII y los escapes \uXXXX entran por sustitución: el
// transpilador de Bun reescribe el texto de String.raw: un emoji pasa a «\u{1f389}» y «a», a «a».)
const ETE = 'été', PARTY = '\u{1F389}', U = '\\u';
const FIXTURE = String.raw`{"v":1,"kind":"tesserafs-scan","app":"0.11.0","host":"NAS-01","path":"D:\\Datos","scannedAt":1791700000,"engine":"mft","volume":{"path":"D:\\","label":"Datos","fs":"NTFS","total":1000000000000,"free":250000000000,"clusterSize":4096},"nodes":[[-1,"D:\\Datos",1,6300,12288,5,2,1791600000,1],[0,"Fotos",1,5100,8192,3,1,1791500000,3],[1,"viaje.JPG",0,3000,4096,0,0,1791400000,16],[1,"2024",1,2000,0,1,0,1791300000,1],[3,"${ETE}.tar.gz",0,2000,0,0,0,1791200000,64],[1,"${PARTY}.png",0,100,4096,0,0,1791250000,0],[0,"notas",0,1200,4096,0,0,1791100000,2],[0,"tab\tx",0,0,0,0,0,0,0]]}`;
// El mismo árbol con otra forma válida: claves en otro orden, espacios, escapes, isDir booleano, una columna de más
// y una de menos (sin flags), banderas con DIR de más o de menos y bits altos, totales de carpeta que no cuadran (se
// recalculan), otro nombre en la raíz (vale `path`), `host` nulo, sin `app` y una clave desconocida
const VARIANT = String.raw`
{ "nodes" : [
    [-1, "ignorado", true, 1, 2, 3, 4, 1791600000, 0],
    [0, "Fotos", 1, 99999, 1, 77, 88, 1791500000, 2, "columna futura", {"x": [1, null]}],
    [1, "viaje.JPG", false, 3000, 4096, 0, 0, 1791400000, 17],
    [1, "2024", 2, 2000.0, 0, null, "x", 1791300000, 32769],
    [3, "${U}00e9t${U}00E9.tar.gz", 0, 2e3, 0, 0, 0, 1791200000, 64],
    [1, "${U}d83c${U}df89.png", 0, 100.7, 4096, 0, 0, 1791250000, 0],
    [0, "not${U}0061s", 0, 1200, 4096, 0, 0, 1791100000, 2],
    [0, "tab${U}0009x", 0, -5, 0, 0, 0, -1]
  ],
  "extra": {"a": [1, 2.5e3, {"b": null}], "c": false, "d": "\/"},
  "engine": "mft",
  "volume": {"clusterSize": 4096, "free": 250000000000, "total": 1000000000000, "fs": "NTFS", "label": "Datos", "path": "D:\\"},
  "scannedAt": 1791700000.0, "path": "D:\\Datos", "host": null, "kind": "tesserafs-scan", "v": 1
}
`;
const FIX_VOLUME = { path: 'D:\\', label: 'Datos', fs: 'NTFS', total: 1e12, free: 2.5e11, clusterSize: 4096 };

test('openScan: un .tessera fijo escrito a mano (formato exacto) y la misma información en otra forma válida', () => {
  const e2 = new TesseraEngine({ threads: 0 });
  const r = e2.openScan(gz(FIXTURE));
  expect(r).toEqual({
    rootId: 0, rootPath: 'D:\\Datos', engine: 'mft', entries: 7, files: 5, dirs: 2, bytes: 6300, elapsedMs: r.elapsedMs, volume: FIX_VOLUME,
    warnings: [], canRefresh: false, offline: { scannedAt: 1791700000, host: 'NAS-01', app: '0.11.0' },
  });
  expect(e2.nodeInfo(0)).toEqual({
    id: 0, parentId: -1, name: 'D:\\Datos', isDir: true, size: 6300, alloc: 12288, files: 5, dirs: 2, mtime: 1791600000, ext: '', flags: 1, childCount: 3,
  });
  const rows = (id: number) => kids(e2, id).map(x => [x.id, x.name, x.isDir, x.size, x.alloc, x.files, x.dirs, x.mtime, x.ext, x.flags, x.childCount]);
  expect(rows(0)).toEqual([
    [1, 'Fotos', true, 5100, 8192, 3, 1, 1791500000, '', FLAG.DIR | FLAG.HIDDEN, 3],
    [6, 'notas', false, 1200, 4096, 0, 0, 1791100000, '', FLAG.HIDDEN, 0],
    [7, 'tab\tx', false, 0, 0, 0, 0, 0, '', 0, 0],
  ]);
  expect(rows(1)).toEqual([
    [2, 'viaje.JPG', false, 3000, 4096, 0, 0, 1791400000, 'jpg', FLAG.COMPRESSED, 0],
    [3, '2024', true, 2000, 0, 1, 0, 1791300000, '', FLAG.DIR, 1],
    [5, '🎉.png', false, 100, 4096, 0, 0, 1791250000, 'png', 0, 0],
  ]);
  expect(rows(3)).toEqual([[4, 'été.tar.gz', false, 2000, 0, 0, 0, 1791200000, 'gz', FLAG.CLOUD, 0]]);
  expect(e2.nodePath(4)).toBe('D:\\Datos\\Fotos\\2024\\été.tar.gz');
  expect(e2.search({ query: 'attr:cloud', root: 0, limit: 10 }).rows.map(x => x.path)).toEqual(['D:\\Datos\\Fotos\\2024\\été.tar.gz']);
  expect(e2.extStats(0).map(x => [x.ext, x.size, x.count])).toEqual([['jpg', 3000, 1], ['gz', 2000, 1], ['', 1200, 2], ['png', 100, 1]]);

  // volver a guardarlo: el mismo JSON, byte a byte (conserva scannedAt, host y app); nombre con la fecha local del escaneo
  const saved = e2.saveScan();
  expect(path.basename(saved.path)).toBe(`Datos ${stamp(1791700000)}.tessera`);
  expect(unzip(saved.path)).toBe(FIXTURE);

  // la variante da el mismo árbol (mismos ids y slice); sin host ni app en `offline`
  const e3 = new TesseraEngine({ threads: 0 });
  const r3 = e3.openScan(gz(VARIANT));
  expect(r3).toEqual({ ...r, elapsedMs: r3.elapsedMs, offline: { scannedAt: 1791700000 } });
  expect(Object.keys(r3.volume!)).toEqual(['path', 'label', 'fs', 'total', 'free', 'clusterSize']);
  expect(dump(e3)).toEqual(dump(e2));
  expect(e3.slice(0, 0, 1000)).toEqual(e2.slice(0, 0, 1000));
  // al guardarla, igual que la fija pero sin `app` ni `host` (no los tenía)
  expect(unzip(e3.saveScan().path)).toBe(FIXTURE.replace('"app":"0.11.0","host":"NAS-01",', ''));

  // el archivo mínimo de las pruebas del motor Rust (saved.rs › reads_minimal_and_rejects_broken) da lo mismo aquí
  const e5 = new TesseraEngine({ threads: 0 });
  const minimal = String.raw`{"v":1,"kind":"tesserafs-scan","path":"C:\\D","scannedAt":5,"engine":"mft","volume":null,"nodes":[[-1,"C:\\D",1,0,0,0,0,7,1],[0,"a.TXT",0,5,8,0,0,9,2],[0,"s",1,99,99,9,9,3,0],[2,"x",0,7,8,0,0,1]]}`;
  expect(e5.openScan(gz(minimal))).toMatchObject({ rootPath: 'C:\\D', engine: 'mft', entries: 3, files: 2, dirs: 1, bytes: 12, offline: { scannedAt: 5 } });
  expect(e5.nodeInfo(0)).toMatchObject({ size: 12, alloc: 16, files: 2, dirs: 1, mtime: 7 });
  expect(kids(e5, 0).map(x => [x.name, x.size, x.files, x.dirs, x.ext, x.flags, x.mtime])).toEqual([
    ['s', 7, 1, 0, '', FLAG.DIR, 3], ['a.TXT', 5, 0, 0, 'txt', FLAG.HIDDEN, 9],
  ]);

  // suplentes sueltos: como escape (lo que escribe JSON.stringify) o en WTF-8 (bytes ED A0 80); se conservan y se
  // vuelven a escribir como \ud800 (igual que el motor Rust, saved.rs › lone_surrogates_round_trip)
  const head = String.raw`{"v":1,"kind":"tesserafs-scan","path":"C:\\D","scannedAt":5,"engine":"mft","volume":null,"nodes":[[-1,"C:\\D",1,0,0,0,0,0,0],[0,"a`;
  const tail = String.raw`b${U}d83d${U}de00",0,3,4,0,0,0,0]]}`;
  for (const data of [gz(head + U + 'd800' + tail), Bun.gzipSync(Buffer.concat([Buffer.from(head), Buffer.from([0xED, 0xA0, 0x80]), Buffer.from(tail)]))]) {
    const e6 = new TesseraEngine({ threads: 0 });
    e6.openScan(data);
    expect(e6.nodeInfo(1).name).toBe('a\ud800b\u{1F600}');
    expect(unzip(e6.saveScan().path)).toBe(String.raw`{"v":1,"kind":"tesserafs-scan","path":"C:\\D","scannedAt":5,"engine":"mft","volume":null,"nodes":[[-1,"C:\\D",1,3,4,1,0,0,1],[0,"a${U}d800b${'\u{1F600}'}",0,3,4,0,0,0,0]]}`);
  }

  // una raíz de Linux (escaneo guardado por el motor Rust): rutas con «/», nombre «raiz»
  const linux = String.raw`{"v":1,"kind":"tesserafs-scan","app":"0.11.0","host":"nas","path":"/","scannedAt":1791700000,"engine":"walk","volume":null,"nodes":[[-1,"/",1,10,10,1,1,0,1],[0,"srv",1,10,10,1,0,0,1],[1,"a\\b.txt",0,10,10,0,0,0,0]]}`;
  const e4 = new TesseraEngine({ threads: 0 });
  expect(e4.openScan(gz(linux))).toMatchObject({ rootPath: '/', engine: 'walk', volume: null, entries: 2 });
  expect(e4.nodePath(2)).toBe('/srv/a\\b.txt');
  expect(path.basename(e4.saveScan().path)).toBe(`raiz ${stamp(1791700000)}.tessera`);
  expect(unzip(path.join(XD, `raiz ${stamp(1791700000)}.tessera`))).toBe(linux);
});

test('openScan: archivos dañados, ajenos o de otra versión → scan.openFailed (400) sin tocar el escaneo cargado', async () => {
  const e2 = new TesseraEngine({ threads: 0 });
  e2.openScan(gz(FIXTURE));
  const before = dump(e2);
  const nodes = (list: string) => FIXTURE.replace(/"nodes":\[.*\]\}$/, `"nodes":[${list}]}`);
  const ROOT = String.raw`[-1,"D:\\Datos",1,10,10,1,1,0,1]`;
  const cases: [Uint8Array, string][] = [
    [Buffer.from('hola'), 'not a gzip file'],
    [new Uint8Array(0), 'not a gzip file'],
    [gz(FIXTURE).subarray(0, 40), 'invalid gzip data'],
    [Buffer.concat([gz(FIXTURE), Buffer.from('basura')]), 'invalid gzip data'],
    [gz('hello'), 'not a TesseraFS saved scan'],
    [gz('[1,2,3]'), 'not a TesseraFS saved scan'],
    [gz('{}'), 'not a TesseraFS saved scan'],
    [gz(FIXTURE.replace('"v":1', '"v":2')), 'unsupported format version 2 (this TesseraFS reads version 1)'],
    [gz(FIXTURE.replace('"v":1', '"v":"1"')), 'not a TesseraFS saved scan'],
    [gz(FIXTURE.replace('"kind":"tesserafs-scan"', '"kind":"tesserafs-snapshot"')), 'not a TesseraFS saved scan'],
    [gz(FIXTURE.replace('"kind":"tesserafs-scan",', '')), 'not a TesseraFS saved scan'],
    [gz(JSON.stringify({ v: 1, path: 'D:\\', scannedAt: 0, nodes: [[-1, 'D:\\', 1, 0, 0, 0, 0, 0]] })), 'not a TesseraFS saved scan'], // un resumen del historial
    [gz(FIXTURE.slice(0, 500)), 'at byte'],
    [gz(FIXTURE + ' x'), 'unexpected data after the end'],
    [gz(FIXTURE.replace('"path":"D:\\\\Datos",', '')), 'missing the scanned path'],
    [gz(FIXTURE.replace('"path":"D:\\\\Datos",', '"path":"",')), 'missing the scanned path'],
    [gz(nodes('')), 'the scan has no nodes'],
    [gz(nodes(String.raw`[0,"D:\\Datos",1,10,10,1,1,0,1]`)), 'invalid node 0: the first node must be the root (parent -1)'],
    [gz(nodes(String.raw`[-1,"D:\\Datos",0,10,10,1,1,0,1]`)), 'invalid node 0: the root must be a folder'],
    [gz(nodes(`${ROOT},[2,"a",1,0,0,0,0,0,1],[0,"b",1,0,0,0,0,0,1]`)), 'invalid node 1: its parent must come before it'],
    [gz(nodes(`${ROOT},[1,"a",1,0,0,0,0,0,1]`)), 'invalid node 1: its parent must come before it'],
    [gz(nodes(`${ROOT},[-1,"a",1,0,0,0,0,0,1]`)), 'invalid node 1: its parent must come before it'],
    [gz(nodes(`${ROOT},[0.5,"a",1,0,0,0,0,0,1]`)), 'invalid node 1: its parent must come before it'],
    [gz(nodes(`${ROOT},[0,"f",0,0,0,0,0,0,0],[1,"g",0,0,0,0,0,0,0]`)), 'invalid node 2: its parent is not a folder'],
    [gz(nodes(`${ROOT},[0,"a",0,"big",0,0,0,0,0]`)), 'invalid JSON at byte'],
    [gz(nodes(`${ROOT},[0,5,0,0,0,0,0,0,0]`)), "expected '\"'"],
    [gz(nodes(`${ROOT},[0,"a",0,0,0,0,0]`)), "expected ','"],
    [gz(nodes(`${ROOT},[0,"a\u0001",0,0,0,0,0,0,0]`)), 'control character in string'],
    [gz(nodes(`${ROOT},[0,"a\\x",0,0,0,0,0,0,0]`)), 'invalid escape'],
    [gz(nodes(`${ROOT},[0,"a${U}12",0,0,0,0,0,0,0]`)), 'invalid escape'],
    [gz(nodes(`${ROOT},[0,"a`)), 'unterminated string'],
    [gz(FIXTURE.replace('"nodes":[', '"nodes":[],"nodes":[')), 'duplicate "nodes"'],
    [gz(FIXTURE.replace('"engine":"mft"', '"engine":' + '['.repeat(40) + ']'.repeat(40))), 'too deeply nested'],
  ];
  for (const [data, error] of cases) {
    const err = caught(() => e2.openScan(data));
    expect([err.msg.code, String(err.msg.params?.error)]).toEqual(['scan.openFailed', expect.stringContaining(error)]);
    expect(err.msg.message).toBe(`Couldn't open the saved scan: ${err.msg.params?.error}`);
    expect(errorResponse(err).status).toBe(400);
  }
  expect(dump(e2)).toEqual(before); // el escaneo cargado sigue ahí
  expect(e2.result!.rootPath).toBe('D:\\Datos');

  // límites: tamaño del archivo, JSON descomprimido y nodos
  const fix = gz(FIXTURE);
  const limit = (limits: Parameters<typeof decodeTessera>[1]) => caught(() => decodeTessera(fix, limits)).msg.params?.error;
  expect(limit({ maxFile: 10 })).toBe('the file is too large (more than 10 bytes)');
  expect(limit({ maxJson: 100 })).toBe('too much data (more than 100 bytes uncompressed)');
  expect(limit({ maxNodes: 7 })).toBe('too many nodes (more than 7)');
  expect(decodeTessera(fix, { maxNodes: 8 }).store.n).toBe(8);
  expect(TESSERA_MAX_FILE).toBe(2 ** 30);

  // cerrojos: no mientras hay un escaneo o una búsqueda de duplicados
  const e3 = new TesseraEngine({ threads: 0 });
  const scanning = e3.scan({ path: R, engine: 'walk' });
  expect(caught(() => e3.openScan(fix)).msg.code).toBe('error.scanBusy');
  const r = await scanning;
  const dup = e3.duplicates({ root: r.rootId, minSize: 1, limit: 10 });
  expect(caught(() => e3.openScan(fix)).msg.code).toBe('error.dupBusy');
  await dup;
  expect(e3.openScan(fix).rootPath).toBe('D:\\Datos');
});

test('tesseraJson: los nombres se escriben exactamente como JSON.stringify (escapes, UTF-8, suplentes sueltos)', () => {
  const names = [
    'a"b\\c/d', Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + '\x7f', 'ñandú ÀÉ', '中文 ✓ \u2028\u2029',
    '\u{1F600}\u{10FFFF}x', 'lo\ud800ne', 'x\udc00y', 'fin\ud83d', '\ude00ini', '\ud83d\ud83d\ude00',
  ];
  const s = new Store(64);
  s.addRoot('C:\\Raíz "rara"');
  for (const [i, name] of names.entries()) {
    const units = new Uint16Array(name.length); // por unidades UTF-16 (iterar la cadena iría por caracteres)
    for (let k = 0; k < name.length; k++) units[k] = name.charCodeAt(k);
    // tamaños grandes (la raíz suma más de 2^53: se escribe como lo haría String) y todas las banderas salvo DIR
    s.add(0, units, 0, units.length, false, i * 2 ** 40 + 1, 2 ** 53 - 1 - i, 4294967295, 0xFE);
  }
  s.finalize();
  const text = new TextDecoder().decode(tesseraJson(s, { scannedAt: 0, engine: 'walk', volume: null }));
  const order: number[] = [];
  s.forEach(0, id => order.push(id));
  const expected = '{"v":1,"kind":"tesserafs-scan","path":' + JSON.stringify('C:\\Raíz "rara"') + ',"scannedAt":0,"engine":"walk","volume":null,"nodes":['
    + order.map((id, i) => '[' + [i ? 0 : -1, JSON.stringify(i ? s.name(id) : s.rootPath), i ? 0 : 1, s.sz[id], s.al[id], s.nf[id], s.nd[id], s.mt[id], s.fl[id] & 0xFF].join(',') + ']').join(',')
    + ']}';
  expect(text).toBe(expected);
  expect(JSON.parse(text).nodes.slice(1).map((n: unknown[]) => n[1]).sort()).toEqual([...names].sort());
});

test('savedScanName: letra de la unidad, último componente, «raiz», sin reservados ni punto final, 100 unidades (como Rust)', () => {
  const t = 1791700000, d = stamp(t);
  expect(d).toMatch(/^\d{4}-\d\d-\d\d \d{4}$/);
  // los mismos casos que saved.rs › labels_and_names
  for (const [root, label] of [
    ['C:\\', 'C'], ['d:\\', 'D'], ['C:\\Users\\Ana', 'Ana'], ['\\\\srv\\share', 'share'], ['/', 'raiz'], ['/home/ana/', 'ana'],
    ['/srv/a:b*?"<>|. ', 'a_b______'], ['/srv/...', 'raiz'], ['C:\\Users\\José', 'José'], ['/srv/a\u0001b\u007f', 'a_b_'],
  ]) {
    expect(savedScanLabel(root)).toBe(label);
    expect(savedScanName(root, t)).toBe(`${label} ${d}.tessera`);
  }
  expect([...savedScanLabel('/x/' + '\u{1F600}'.repeat(60))]).toHaveLength(50);
  expect(savedScanLabel('D:\\' + 'x'.repeat(99) + '\u{1F389}')).toBe('x'.repeat(99)); // el par suplente no se parte
  expect(savedScanName('D:\\' + 'x'.repeat(300), t)).toBe('x'.repeat(100) + ` ${d}.tessera`);
  // lo que aun así no vale como nombre (un control C1) → «raiz», como el motor Rust
  expect(savedScanName('/srv/a\u0085b', t)).toBe(`raiz ${d}.tessera`);
});

test('historyTrend: resúmenes de la misma raíz (sin mayúsculas), del más antiguo al más reciente, sin el actual', async () => {
  const e2 = new TesseraEngine({ threads: 0 });
  expect(caught(() => e2.historyTrend(0)).msg.code).toBe('error.noScan');
  const r = await e2.scan({ path: R, engine: 'walk' });
  const docs = byPath(e2, 'docs'), b = byPath(e2, 'docs\\b.TXT'), big = byPath(e2, 'big.bin'), vacia = byPath(e2, 'vacía');
  const invalid = caught(() => e2.historyTrend(999999));
  expect(invalid.msg).toMatchObject({ code: 'error.invalidNode', params: { id: 999999 } });
  expect(errorResponse(invalid).status).toBe(404);

  fs.mkdirSync(HD, { recursive: true });
  const write = (id: string, p: string, scannedAt: number, nodes: unknown[], snapPath = p, snap?: Uint8Array) => {
    fs.writeFileSync(path.join(HD, `${id}.snap.gz`), snap ?? Bun.gzipSync(Buffer.from(JSON.stringify({ v: 1, path: snapPath, scannedAt, nodes }))));
    fs.writeFileSync(path.join(HD, `${id}.json`), JSON.stringify({ id, path: p, scannedAt, engine: 'walk', bytes: 0, files: 0, dirs: 0, nodes: nodes.length, fileBytes: 1 }));
  };
  const h = pathHash(R);
  const S1 = `20250101T000000Z-${h}`, S2 = `20250201T000000Z-${h}`, S3 = `20250301T000000Z-${h}`;
  // el más antiguo: raíz en mayúsculas, docs con otras mayúsculas, b.TXT dentro (y un «b.txt» repetido después)
  write(S1, R.toUpperCase(), 1735689600, [
    [-1, R.toUpperCase(), 1, 100, 100, 2, 2, 0], [0, 'DOCS', 1, 50, 50, 1, 1, 0], [1, 'sub', 1, 5, 5, 0, 0, 0],
    [1, 'B.txt', 0, 20, 20, 0, 0, 0], [1, 'b.txt', 0, 99, 99, 0, 0, 0], [0, 'big.bin', 0, MiB, MiB, 0, 0, 0],
  ]);
  // sin docs; big.bin es una carpeta con el mismo nombre (cuenta el nombre, como en la regla de la evolución)
  write(S2, R, 1738368000, [[-1, R, 1, 200, 200, 0, 1, 0], [0, 'BIG.BIN', 1, 7, 7, 0, 0, 0]]);
  // dañado: no da punto
  write(S3, R, 1740787200, [], R, Buffer.from('no es gzip'));
  // otra raíz, y un .json de esta raíz con el .snap.gz de otra: no cuentan
  write(`20250401T000000Z-${pathHash(R + 'x')}`, R + 'x', 1743465600, [[-1, R + 'x', 1, 1, 1, 0, 0, 0]]);
  write(`20250501T000000Z-${h}`, R, 1746057600, [[-1, R + 'x', 1, 1, 1, 0, 0, 0]], R + 'x');
  // el actual (mismo scannedAt que el escaneo cargado): no cuenta
  const current = e2.historySave();
  expect(current.scannedAt).toBe(e2.scannedAt);

  const trend = (id: number) => e2.historyTrend(id).map(p => [p.id, p.scannedAt, p.size]);
  expect(Object.keys(e2.historyTrend(r.rootId)[0])).toEqual(['id', 'scannedAt', 'size']);
  expect(trend(r.rootId)).toEqual([[S1, 1735689600, 100], [S2, 1738368000, 200]]);
  expect(trend(docs)).toEqual([[S1, 1735689600, 50], [S2, 1738368000, null]]);
  expect(trend(b)).toEqual([[S1, 1735689600, 20], [S2, 1738368000, null]]); // el primero en preorden
  expect(trend(big)).toEqual([[S1, 1735689600, MiB], [S2, 1738368000, 7]]);
  expect(trend(vacia)).toEqual([[S1, 1735689600, null], [S2, 1738368000, null]]);
  expect(trend(byPath(e2, 'docs\\a.txt'))).toEqual([[S1, 1735689600, null], [S2, 1738368000, null]]);

  // la misma raíz escrita con otras mayúsculas también los encuentra; un resumen borrado desaparece
  const e3 = new TesseraEngine({ threads: 0 });
  const r3 = await e3.scan({ path: R.toUpperCase(), engine: 'walk' });
  // (el de e2 cuenta para e3 salvo que los dos escaneos terminaran en el mismo segundo)
  expect(e3.historyTrend(r3.rootId).map(p => p.id)).toEqual([S1, S2, ...(e3.scannedAt !== current.scannedAt ? [current.id] : [])]);
  expect(e2.historyDelete(S1)).toBe(true);
  expect(trend(docs)).toEqual([[S2, 1738368000, null]]);
});
